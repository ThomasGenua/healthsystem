/**
 * Admin and ingest HTTP API. No framework: node:http with a small router.
 *
 * Every request passes one authentication gate before any route runs (see
 * auth/gate.ts). Scopes: /api/* needs `admin`, GET /fhir/* needs `read`,
 * writes need `write`, and /patient/* needs the OAuth-only `patient` scope
 * plus a live subject-to-chart grant. The UI shell, the patient HTML shell
 * at GET /me (static chrome, no PHI), /api/health and /fhir/metadata are open.
 *
 * GET  /api/health                       liveness, counters and alertable signals
 * GET  /metrics                          Prometheus exposition (public, no patient data)
 * GET  /api/channels                     list channels with runtime state
 * POST /api/channels                     create or replace a channel
 * GET  /api/channels/:id                 channel configuration
 * DELETE /api/channels/:id               stop and remove a channel
 * GET  /api/channels/export              the configuration as a versioned document
 * POST /api/channels/import              a plan, then an action; a dry run writes nothing
 * GET  /api/messages?channel_id&status   browse messages
 * GET  /api/messages/:id                 message with steps and deliveries
 * GET  /api/deliveries?channel_id&state  browse deliveries (state=dead is the DLQ)
 * POST /api/deliveries/:id/replay        requeue a dead, delivered or discarded delivery
 * POST /api/deliveries/:id/discard       discard a dead delivery, releasing ordered flow
 * GET  /api/chain/verify?channel_id      verify the channel hash chain
 * POST /api/backup                       take a verified snapshot; replicate off-machine when configured
 * GET  /api/retention                    retention policy and what it would touch
 * POST /api/retention/run                apply the policy now
 * GET  /api/audit?patient=&principal=&failures=  access trail (admin only)
 * GET  /api/audit/verify                 verify the audit hash chain
 * GET  /api/audit/review?patient=         access review with flags (admin only)
 * POST /api/audit/review/dismiss          close a flag, with a reason
 * GET  /fhir/AuditEvent                  the same trail as R4 AuditEvent (admin only)
 * GET  /api/keys                         list API keys (never the keys themselves)
 * POST /api/keys                         issue a key; the response is the only time it is shown
 * DELETE /api/keys/:id                   revoke a key
 * POST /ingest/:path                     ingest into an http-source channel
 * POST /fhir/:resourceType               ingest into matching fhir-source channels
 *
 * FHIR facade (R4 read side of the fhirstore destination):
 * GET  /fhir/metadata                    CapabilityStatement
 * GET  /fhir/:Type?identifier=&_count=   search by identifier token
 * GET  /fhir/:Type/:id                   read one resource
 *
 * Terminology:  GET /api/terminology/{lookup,expand,translate,stats},
 *   GET /fhir/CodeSystem/$lookup, /fhir/ValueSet/$expand, /fhir/ConceptMap/$translate
 * Conformance:  GET /api/conformance/packs, POST /api/conformance/validate,
 *   GET /api/conformance/capability?pack=
 * Subscriptions: GET|POST /fhir/Subscription, GET|DELETE /fhir/Subscription/:id
 * Admin UI:     GET / (single-file, no build step)
 * Patient shell: GET /me (EN/FR chrome; not a certified portal)
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { encryptionAtRest } from "../core/atrest.ts";
import { createServer as createSecureServer } from "node:https";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Engine } from "../core/engine.ts";
import { DEFAULT_TENANT } from "../db.ts";
import { checkCapability, toOperationOutcome, validateResource } from "../conformance/validator.ts";
import { applyMapping } from "../transform/mapper.ts";
import { takeBackup } from "../core/backup.ts";
import { remoteAgeSec, type RemoteBackup } from "../core/remote.ts";
import { CHART_TYPES, WORKLIST_TYPES } from "../workspace/summary.ts";
import { VISIT_TYPES } from "../workspace/visit.ts";
import type { EncounterClass } from "../clinical/encounters.ts";
import { DIRECTORY_KINDS, type PartyKind } from "../directory/store.ts";
import { mapStoreError, refuse } from "../core/refusal.ts";
import type { MigrationRecordType, SourceRecord } from "../migrate/run.ts";
import type { AuthorityRow, PatientPermission } from "../patient/access.ts";
import { AuthGate } from "../auth/gate.ts";
import { RateLimiter, type RateLimitPolicy } from "./ratelimit.ts";
import { VERSION } from "../version.ts";
import type { AuditAction, AuditEntry } from "../audit/store.ts";
import type { Finding } from "../meds/safety.ts";
import type { ReadingStation } from "../core/station.ts";
import type { TlsConfig } from "./tls.ts";
import type { ChannelConfig, MappingDoc, MessageRow } from "../types.ts";
import type { ChannelDocument } from "../core/channel-versions.ts";
import { validateChannel } from "../core/engine.ts";
import { Refusal } from "../core/refusal.ts";

let UI_HTML: string | null = null;
function uiHtml(): string {
  if (UI_HTML === null) {
    try {
      UI_HTML = readFileSync(new URL("./ui.html", import.meta.url), "utf8");
    } catch {
      UI_HTML = "<h1>Portage</h1><p>ui.html not found</p>";
    }
  }
  return UI_HTML;
}

let PATIENT_HTML: string | null = null;
function patientHtml(): string {
  if (PATIENT_HTML === null) {
    try {
      PATIENT_HTML = readFileSync(new URL("./patient.html", import.meta.url), "utf8");
    } catch {
      PATIENT_HTML = "<h1>Portage</h1><p>patient.html not found</p>";
    }
  }
  return PATIENT_HTML;
}

const MAX_BODY = 25 * 1024 * 1024;

export interface ApiHandle {
  server: Server;
  port: number;
  tls: boolean;
  limiter: RateLimiter;
  close(): Promise<void>;
}

export interface ApiOptions {
  /**
   * Authentication gate. Omitting it leaves the API open, which is why
   * server.ts — the real entry point — always builds one. Callers embedding
   * startApi directly are opting out on purpose.
   */
  auth?: AuthGate;
  tls?: TlsConfig;
  /** Request rate limits. Defaults apply unless disabled explicitly. */
  rateLimit?: RateLimitPolicy;
  /**
   * Off-machine snapshot destination. Unset means local-only backups, which
   * health reports as a posture rather than an incident.
   */
  remote?: RemoteBackup;
  /**
   * Run this node as a reading station over a cached snapshot.
   *
   * Present means the engine underneath is a restore rather than the live
   * record, and three things change: every chart is assembled `asOf` the fill
   * and wears its age, every clinical write is refused with words saying what
   * to do instead, and reads land on the station's own chain rather than on a
   * copy of the primary's. Absent is the ordinary case — the primary.
   */
  station?: ReadingStation;
}

export function startApi(engine: Engine, port: number, host = "0.0.0.0", options: ApiOptions = {}): Promise<ApiHandle> {
  const gate = options.auth ?? new AuthGate();
  // Per listener rather than per process: two engines in one test run must not
  // share a budget, and an operator running two listeners means them to be
  // independent.
  const limiter = new RateLimiter(options.rateLimit);
  const remote = options.remote;
  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    void route(engine, req, res, gate, limiter, remote, options.station).catch((err) => {
      send(res, 500, { error: err instanceof Error ? err.message : "internal error" });
    });
  };
  const server = options.tls ? createSecureServer(options.tls.serverOptions, handler) : createServer(handler);

  // The other half of autonomous expiry: the gate purges on the first request
  // past the budget, and this sweep purges the station nobody asks — a copy
  // of the record must not sit in a building nobody is watching just because
  // nobody opened a chart. expire() checks the budget itself, so calling it
  // early is a no-op rather than a hazard.
  const stationSweep = options.station
    ? setInterval(() => {
        try {
          options.station?.expire();
        } catch {
          // A sweep that throws must not take the server down; the gate's
          // per-request purge is still in place, and the next sweep retries.
        }
      }, 3_600_000)
    : undefined;
  stationSweep?.unref();

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, host, () => {
      const addr = server.address();
      const actual = typeof addr === "object" && addr ? addr.port : port;
      resolve({
        server,
        port: actual,
        tls: Boolean(options.tls),
        limiter,
        close: () => {
          if (stationSweep) clearInterval(stationSweep);
          return new Promise<void>((r) => server.close(() => r()));
        },
      });
    });
  });
}

async function route(
  engine: Engine,
  req: IncomingMessage,
  res: ServerResponse,
  gate: AuthGate,
  limiter: RateLimiter,
  remote?: RemoteBackup,
  station?: ReadingStation
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = req.method ?? "GET";

  // One gate, ahead of every route. The router below is a flat if-chain with
  // no middleware layer, so this is the only place a check cannot be
  // forgotten when a route is added.
  const auth = await gate.check(method, path, req.headers);

  // Every store this request touches comes from the caller's tenant, resolved
  // from the credential and never from anything on the request itself — a
  // caller who could name their tenant would be naming their own
  // authorisation. `db`, `fhir`, `subs` and `keys` below are the tenant-bound
  // ones; the engine-wide originals are deliberately not in scope in a route.
  const principalTenant = auth.ok ? auth.principal.tenantId : (auth.principal?.tenantId ?? DEFAULT_TENANT);
  const tenant = engine.forTenant(principalTenant);
  const { db, fhir, subs, keys } = tenant;

  /** Records an access against the audit trail. */
  const audit = (entry: Omit<AuditEntry, "principalId" | "principalKind" | "method" | "path">): void => {
    // On a station the trail is the station's own, from its own genesis. The
    // primary's chain sits inside the cache as a copy, and appending to that
    // copy would leave two divergent trails claiming the same history —
    // strictly worse than having no offline trail, because both would verify.
    const sink = station ?? tenant.audit;
    sink.record({
      principalId: auth.ok ? auth.principal.id : (auth.principal?.id ?? "unauthenticated"),
      principalKind: auth.ok ? auth.principal.kind : (auth.principal?.kind ?? "unknown"),
      method,
      path,
      sourceIp: req.socket.remoteAddress ?? undefined,
      // Why, not just who. A trail that cannot separate treatment from
      // curiosity cannot answer the question a privacy office actually asks.
      ...(auth.ok && auth.principal.purposeOfUse ? { purposeOfUse: auth.principal.purposeOfUse } : {}),
      // Which organization, not just which credential. A privacy review asks
      // "did anyone at that clinic look at this record", and until this was
      // recorded the trail could not answer it.
      ...(auth.ok && auth.principal.organizationId ? { organizationId: auth.principal.organizationId } : {}),
      // And which person. "Did anybody with no reason to look at this chart
      // look at it" is the question an access review turns on, and it needs a
      // name rather than a credential id to be answerable at all.
      ...(auth.ok && auth.principal.practitionerId ? { practitionerId: auth.principal.practitionerId } : {}),
      ...entry,
    });
  };

  // Rate limiting sits between authentication and everything else, including
  // the refusal audit below. A caller over the limit is turned away without
  // writing a row, which is what stops a flood of refused requests from
  // growing the audit trail without bound.
  const sourceIp = req.socket.remoteAddress ?? "unknown";
  // Count against a principal only when a real credential was presented.
  // Requests on public routes, and every request when authentication is
  // switched off, resolve to one synthetic anonymous principal — keying on
  // that would put unrelated callers in a single shared bucket and hand them
  // the credentialed rate. Those are counted per source address instead.
  const credentialed = auth.ok && auth.principal.kind !== "anonymous";
  const limit = limiter.check(credentialed ? `principal:${auth.principal.id}` : `ip:${sourceIp}`, credentialed);
  if (!limit.allowed) {
    // One row per episode, on the request that crosses the threshold, so the
    // trail records that a flood happened without being the flood.
    if (limit.firstRefusal) {
      tenant.audit.record({
        action: verbToAction(method),
        outcome: 8,
        principalId: auth.ok ? auth.principal.id : "unauthenticated",
        principalKind: auth.ok ? auth.principal.kind : "unknown",
        method,
        path,
        sourceIp,
        detail: "rate limit exceeded",
      });
    }
    res.setHeader("retry-after", String(limit.retryAfterSec));
    return send(res, 429, { error: "rate limit exceeded", retryAfterSec: limit.retryAfterSec });
  }

  if (!auth.ok) {
    // A refused attempt is exactly what an audit trail exists to surface, so
    // it is recorded before the response goes out. Only for paths that reach
    // patient data — a 401 on a dashboard poll is noise.
    if (touchesPatientData(path)) {
      audit({ action: verbToAction(method), outcome: auth.status === 401 ? 4 : 8, detail: auth.error });
    }
    if (auth.status === 401) res.setHeader("www-authenticate", gate.challenge);
    return send(res, auth.status, { error: auth.error });
  }

  if (method === "GET" && (path === "/" || path === "/ui")) {
    const html = uiHtml();
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": Buffer.byteLength(html) });
    res.end(html);
    return;
  }

  // Static chrome, no PHI. Chart access is /patient/* plus OAuth. Unauthenticated
  // GETs must not be audited as a reach for a patient record.
  if (method === "GET" && path === "/me") {
    const html = patientHtml();
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": Buffer.byteLength(html) });
    res.end(html);
    return;
  }

  if (method === "GET" && path === "/api/health") {
    const signals = db.healthSignals();
    const stalledAfter = num(url.searchParams.get("stalled_after_sec")) ?? 3600;
    // A stalled channel is one holding work that has sat longer than the
    // threshold. Reported rather than merely counted, because "which feed"
    // is the first thing an operator needs and the counters cannot say.
    const stalled = signals.stalledChannels.filter((c) => c.oldestQueuedAgeSec >= stalledAfter);
    const remoteStatus = remote?.status() ?? {
      configured: false,
      ok: false,
      detail:
        "no PORTAGE_BACKUP_REMOTE; a snapshot that never leaves this machine does not survive the failures that need a restore",
    };
    return send(res, 200, {
      ok: true,
      // Degraded rather than unhealthy: the engine is working correctly by
      // holding a backlog through an outage. It is the operator's judgement
      // whether a backlog this old means something is wrong.
      // A silent feed counts too. It is the one failure that produces no
      // backlog and no dead letters, so without it here a stopped interface
      // reports a clean bill of health for as long as it stays stopped.
      // A configured remote whose last replica failed counts too: local
      // snapshots still exist, but the copy that survives the machine does
      // not, and that is an incident rather than a posture.
      degraded:
        stalled.length > 0 ||
        signals.deadLetters > 0 ||
        signals.silentChannels.length > 0 ||
        Boolean(remote?.isDegraded()),
      stats: db.stats(),
      signals: { ...signals, stalledChannels: stalled, stalledAfterSec: stalledAfter },
      // Not part of `degraded`: an unencrypted volume is a posture rather than
      // an incident, and flipping a health check to degraded forever would
      // train an operator to ignore the field that also reports a stopped
      // feed. Reported so a monitor can alert on it as its own thing.
      atRest: encryptionAtRest(engine.dataDir),
      // Same shape: unconfigured is a posture (reported, not degraded);
      // configured-and-failed is an incident and already folded into
      // `degraded` above.
      remoteBackup: remoteStatus,
    });
  }

  if (method === "GET" && path === "/metrics") {
    // Prometheus text exposition. Public alongside /api/health, and carrying
    // no patient data: counters, ages and channel ids only.
    const signals = db.healthSignals();
    const stats = db.stats() as {
      channels: number;
      messages: Record<string, number>;
      deliveries: Record<string, number>;
      fhir: Record<string, number>;
    };
    const lines: string[] = [];
    const metric = (name: string, help: string, type: string, samples: Array<[string, number]>): void => {
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
      for (const [labels, value] of samples) lines.push(`${name}${labels} ${value}`);
    };

    metric("portage_channels", "Configured channels.", "gauge", [["", stats.channels]]);
    metric(
      "portage_messages_total",
      "Messages ingested, by status.",
      "counter",
      Object.entries(stats.messages).map(([k, v]) => [`{status="${k}"}`, v] as [string, number])
    );
    metric(
      "portage_deliveries",
      "Deliveries by state.",
      "gauge",
      Object.entries(stats.deliveries).map(([k, v]) => [`{state="${k}"}`, v] as [string, number])
    );
    metric(
      "portage_fhir_resources",
      "Resources in the FHIR facade, by type.",
      "gauge",
      Object.entries(stats.fhir).map(([k, v]) => [`{resource_type="${k}"}`, v] as [string, number])
    );
    metric("portage_dead_letters", "Deliveries in the dead-letter queue.", "gauge", [["", signals.deadLetters]]);
    metric("portage_oldest_queued_age_seconds", "Age of the oldest undelivered message.", "gauge", [
      ["", signals.oldestQueuedAgeSec ?? 0],
    ]);
    metric(
      "portage_channel_oldest_queued_age_seconds",
      "Age of the oldest undelivered message, per channel.",
      "gauge",
      signals.stalledChannels.map(
        (c) => [`{channel="${c.channelId.replace(/"/g, "")}"}`, c.oldestQueuedAgeSec] as [string, number]
      )
    );

    // Age since each channel last received anything. A gauge rather than a
    // counter: the question is "how long has it been quiet", and an alert is a
    // threshold on it. Only channels that declared a cadence appear, so this
    // never invents an expectation an operator did not set.
    metric(
      "portage_channel_last_message_age_seconds",
      "Seconds since a channel last received a message.",
      "gauge",
      engine
        .listChannels()
        .map((c) => [c.id, db.lastMessageAgeSec(c.id)] as const)
        .filter((e): e is readonly [string, number] => e[1] !== null)
        .map(([id, age]) => [`{channel="${id.replace(/"/g, "")}"}`, age] as [string, number])
    );
    metric(
      "portage_channel_silent",
      "1 when a channel has gone longer than its declared cadence without a message.",
      "gauge",
      signals.silentChannels.map((c) => [`{channel="${c.channelId.replace(/"/g, "")}"}`, 1] as [string, number])
    );

    // Chain lengths, deliberately as counters.
    //
    // A hash chain kept in the same database as the data it attests to cannot
    // prove anything against someone who can write to that database — they can
    // re-link it. What they cannot reach is a scrape that already happened.
    // Exported as counters, a chain that loses rows reads as a counter reset
    // in whatever is scraping this, which is off-box and outside the engine's
    // control, and every monitoring system alerts on that for free.
    // Counted rather than verified. A scrape runs every few seconds forever,
    // and walking every chain each time would cost more as the log grew —
    // worst exactly where the log is largest. The length is the signal; the
    // walk belongs on /api/chain/verify, where an operator asks for it.
    metric("portage_audit_events_total", "Entries on the access audit chain.", "counter", [
      ["", tenant.audit.count()],
    ]);
    metric(
      "portage_chain_length",
      "Messages on each channel's hash chain.",
      "counter",
      engine
        .listChannels()
        .map((c) => [`{channel="${c.id.replace(/"/g, "")}"}`, db.countMessages(c.id)] as [string, number])
    );

    const remoteStatus = remote?.status() ?? {
      configured: false,
      ok: false,
      detail: "no PORTAGE_BACKUP_REMOTE",
    };
    metric("portage_backup_remote_configured", "1 when an off-machine backup destination is configured.", "gauge", [
      ["", remoteStatus.configured ? 1 : 0],
    ]);
    metric(
      "portage_backup_remote_ok",
      "1 when the last off-machine replica was verified. 0 if unconfigured, never attempted, or last attempt failed.",
      "gauge",
      [["", remoteStatus.ok ? 1 : 0]]
    );
    metric(
      "portage_backup_remote_age_seconds",
      "Seconds since the last verified off-machine replica. -1 if none.",
      "gauge",
      [["", remoteAgeSec(remoteStatus)]]
    );

    const body = lines.join("\n") + "\n";
    res.writeHead(200, { "content-type": "text/plain; version=0.0.4", "content-length": Buffer.byteLength(body) });
    res.end(body);
    return;
  }

  // ---- the directory ------------------------------------------------------
  //
  // Not clinical data and not under /api/clinical/, so these do not go through
  // phi(): a directory says who works here, not anything about a patient.
  // /api/ requires admin by default, which is the right posture for a registry
  // that decides whose name a referral can be addressed to.
  if (path.startsWith("/api/directory")) {
    const kind = (url.searchParams.get("kind") ?? "practitioner") as PartyKind;
    if (!DIRECTORY_KINDS.includes(kind)) {
      return send(res, 400, { error: `unknown kind ${kind}; expected one of ${DIRECTORY_KINDS.join(", ")}` });
    }
    if (path === "/api/directory" && method === "GET") {
      return send(res, 200, {
        kind,
        entries: tenant.directory.list(kind, {
          includeRetired: url.searchParams.get("retired") === "true",
          limit: num(url.searchParams.get("limit")),
        }),
      });
    }
    if (path === "/api/directory/resolve" && method === "GET") {
      const id = url.searchParams.get("id");
      if (!id) return send(res, 400, { error: "id required" });
      // A reference the directory does not hold answers 200 with known:false
      // rather than 404. "This is what the row says and I cannot find it" is
      // the useful answer for a diary rendering a slot written years ago; a
      // 404 would make the caller guess whether the id or the lookup was
      // wrong.
      return send(res, 200, tenant.directory.resolve(kind, id));
    }
    if (path === "/api/directory/roles" && method === "GET") {
      const practitioner = url.searchParams.get("practitioner");
      if (!practitioner) return send(res, 400, { error: "practitioner required" });
      return send(res, 200, {
        roles: tenant.directory.rolesFor(practitioner, {
          includeRetired: url.searchParams.get("retired") === "true",
        }),
        organizations: tenant.directory.organizationsFor(practitioner),
      });
    }
    if (path === "/api/directory" && method === "POST") {
      const body = JSON.parse(await readBody(req)) as Record<string, string | undefined>;
      try {
        if (kind === "practitioner") {
          return send(res, 201, tenant.directory.addPractitioner({ family: body.family ?? "", given: body.given, prefix: body.prefix }));
        }
        if (kind === "organization") {
          return send(res, 201, tenant.directory.addOrganization({ name: body.name ?? "", kind: body.orgKind, partOf: body.partOf }));
        }
        if (kind === "location") {
          return send(res, 201, tenant.directory.addLocation({ name: body.name ?? "", organizationId: body.organizationId, community: body.community, address: body.address }));
        }
        return send(res, 201, tenant.directory.addService({ name: body.name ?? "", organizationId: body.organizationId, locationId: body.locationId, category: body.category }));
      } catch (err) {
        return send(res, 400, { error: (err as Error).message });
      }
    }
    if (path === "/api/directory/role" && method === "POST") {
      const body = JSON.parse(await readBody(req)) as Record<string, string | undefined>;
      try {
        return send(res, 201, tenant.directory.assignRole({
          practitionerId: body.practitioner ?? "",
          role: body.role ?? "",
          organizationId: body.organizationId,
          locationId: body.locationId,
          serviceId: body.serviceId,
          specialty: body.specialty,
        }));
      } catch (err) {
        return send(res, 400, { error: (err as Error).message });
      }
    }
    if (path === "/api/directory/retire" && method === "POST") {
      const body = JSON.parse(await readBody(req)) as { id?: string; at?: string };
      if (!body.id) return send(res, 400, { error: "id required" });
      try {
        // Retire, never delete: the referral sent to this clinic in 2024 still
        // has to resolve afterwards.
        tenant.directory.retire(kind, body.id, body.at);
        return send(res, 200, tenant.directory.resolve(kind, body.id));
      } catch (err) {
        return send(res, 400, { error: (err as Error).message });
      }
    }
  }

  /**
   * The patient/proxy boundary.
   *
   * The gate has already required the OAuth-only `patient` scope. That is not
   * enough: a token names a person, not a chart. Every route below calls
   * patientPhi(), which binds the token subject to the requested patient
   * through a live, unrevoked, unexpired authority grant and checks the
   * grant's explicit permission.
   *
   * This is deliberately not the clinician Workspace. It includes internal
   * tasks and unacknowledged results. Patient results come only through
   * PatientAccess.resultsFor(), where a bounded hold is visible but its value
   * is not.
   */
  if (path === "/patient" || path.startsWith("/patient/")) {
    // AuthGate normally enforces this with the patient scope. Keep the check
    // here as well because an embedding can deliberately construct an
    // authentication-disabled gate; that may open an integration demo, but it
    // must never turn the synthetic `anonymous` principal into a patient.
    if (auth.principal.kind !== "oauth") {
      audit({
        action: verbToAction(method),
        outcome: 4,
        resourceType: "Patient",
        detail: "patient boundary requires an OAuth identity",
      });
      return send(res, 403, { error: "patient access requires an OAuth identity" });
    }
    const subject = auth.principal.id;
    const access = tenant.patientAccess;

    const authorityView = (row: AuthorityRow) => ({
      id: row.id,
      patientId: row.patient_id,
      relationship: row.relationship,
      permissions: access.permissionsFor(row),
      purpose: row.purpose ?? row.reason,
      expiresAt: row.expires_at,
      grantedAt: row.granted_at,
    });

    const patientPhi = <T>(
      patientId: string,
      permission: PatientPermission,
      resourceType: string,
      action: string,
      produce: (authority: AuthorityRow) => T,
      status = 200
    ): void => {
      const authority = access.may(subject, patientId);
      if (!authority || !access.allows(authority, permission)) {
        tenant.db.transaction(() => {
          access.logAccess({
            patientId,
            subjectId: subject,
            relationship: authority?.relationship ?? "none",
            action,
            outcome: "refused",
            resource: resourceType,
            detail: authority ? `grant does not include ${permission}` : "no live authority",
          });
          audit({
            action: verbToAction(method),
            outcome: 4,
            resourceType,
            patient: patientId,
            detail: authority ? `patient grant lacks ${permission}` : "no live patient authority",
          });
        });
        return send(res, 403, { error: "not authorized for this patient resource" });
      }

      let value: T;
      try {
        // Writes and both trails commit together. A message reply that
        // persisted while its access-log insert failed would be a patient
        // action with no accountable actor — a worse outcome than refusing
        // the request and letting it be retried.
        value = tenant.db.transaction(() => {
          const produced = produce(authority);
          access.logAccess({
            patientId,
            subjectId: subject,
            relationship: authority.relationship,
            action,
            outcome: "allowed",
            resource: resourceType,
          });
          audit({ action: verbToAction(method), outcome: 0, resourceType, patient: patientId });
          return produced;
        });
      } catch (err) {
        const mapped = mapStoreError(err);
        if (mapped.outcome === 8) console.error(`patient ${resourceType}: ${mapped.detail}`);
        tenant.db.transaction(() => {
          access.logAccess({
            patientId,
            subjectId: subject,
            relationship: authority.relationship,
            action,
            outcome: "refused",
            resource: resourceType,
            detail: mapped.detail,
          });
          audit({
            action: verbToAction(method),
            outcome: mapped.outcome,
            resourceType,
            patient: patientId,
            detail: mapped.detail,
          });
        });
        return send(res, mapped.status, { error: mapped.error });
      }
      return send(res, status, value);
    };

    if ((path === "/patient" || path === "/patient/authorities") && method === "GET") {
      const live = access.forSubject(subject);
      const rows = tenant.db.transaction(() => {
        for (const row of live) {
          access.logAccess({
            patientId: row.patient_id,
            subjectId: subject,
            relationship: row.relationship,
            action: "list-authorities",
            outcome: "allowed",
            resource: "Consent",
          });
          audit({ action: "R", outcome: 0, resourceType: "Consent", patient: row.patient_id });
        }
        if (live.length === 0) audit({ action: "R", outcome: 0, resourceType: "Consent", count: 0 });
        return live.map(authorityView);
      });
      return send(res, 200, { authorities: rows });
    }

    if (path === "/patient/summary" && method === "GET") {
      const patientId = url.searchParams.get("patient");
      if (!patientId) return send(res, 400, { error: "patient required" });
      // Deliberately blind to chart links. A patient's or proxy's authority is
      // granted per chart, and a link is a clinician's assertion about
      // identity — letting it widen a proxy's grant would hand a delegate
      // records nobody delegated. The clinician chart assembles across links;
      // this surface serves exactly the chart the grant names.
      return patientPhi(patientId, "summary", "Composition", "view-summary", () => ({
        patient: tenant.clinical.patientIndex.get(patientId) ?? null,
        allergies: {
          status: tenant.meds.allergyStatus(patientId),
          items: tenant.meds.allergies(patientId),
        },
        medications: {
          taking: tenant.meds.current(patientId),
          prescribed: tenant.meds.current(patientId, { asPrescribed: true }),
        },
        immunizations: {
          status: tenant.immunizations.historyStatus(patientId),
          items: tenant.immunizations.forPatient(patientId),
        },
        latestVitals: tenant.vitals.latest(patientId),
        careTeam: tenant.careTeam.forPatient(patientId),
        coverage: tenant.coverage.current(patientId) ?? null,
      }));
    }

    if (path === "/patient/results" && method === "GET") {
      const patientId = url.searchParams.get("patient");
      if (!patientId) return send(res, 400, { error: "patient required" });
      return patientPhi(patientId, "results", "DiagnosticReport", "view-results", () => access.resultsFor(patientId));
    }

    if (path === "/patient/appointments" && method === "GET") {
      const patientId = url.searchParams.get("patient");
      if (!patientId) return send(res, 400, { error: "patient required" });
      return patientPhi(patientId, "appointments", "Appointment", "view-appointments", () =>
        tenant.schedule.appointmentsForPatient(patientId, {
          includeCancelled: url.searchParams.get("cancelled") === "true",
        })
      );
    }

    if (path === "/patient/threads" && method === "GET") {
      const patientId = url.searchParams.get("patient");
      if (!patientId) return send(res, 400, { error: "patient required" });
      return patientPhi(patientId, "messages", "Communication", "view-messages", () =>
        tenant.messaging.forPatient(patientId, { includeClosed: url.searchParams.get("closed") === "true" })
      );
    }

    if (path === "/patient/thread" && method === "GET") {
      const id = url.searchParams.get("id");
      if (!id) return send(res, 400, { error: "id required" });
      const thread = tenant.messaging.get(id);
      if (!thread) return send(res, 404, { error: `no message thread ${id}` });
      return patientPhi(thread.patient_id, "messages", "Communication", "view-message-thread", () => ({
        thread,
        messages: tenant.messaging.messages(id),
      }));
    }

    if (path === "/patient/thread-open" && method === "POST") {
      const body = JSON.parse(await readBody(req)) as {
        patient?: string;
        subject?: string;
        body?: string;
        priority?: "routine" | "urgent" | "stat";
      };
      if (!body.patient || !body.subject || !body.body) {
        return send(res, 400, { error: "patient, subject and body required" });
      }
      return patientPhi(
        body.patient,
        "messages",
        "Communication",
        "open-message-thread",
        (authority) =>
          tenant.messaging.open({
            patientId: body.patient!,
            subject: body.subject!,
            body: body.body!,
            authorKind: authority.relationship === "self" ? "patient" : "proxy",
            by: { actorId: subject, actorKind: "oauth" },
            ...(body.priority ? { priority: body.priority } : {}),
          }),
        201
      );
    }

    if (path === "/patient/thread-reply" && method === "POST") {
      const body = JSON.parse(await readBody(req)) as { id?: string; body?: string };
      if (!body.id || !body.body) return send(res, 400, { error: "id and body required" });
      const thread = tenant.messaging.get(body.id);
      if (!thread) return send(res, 404, { error: `no message thread ${body.id}` });
      return patientPhi(thread.patient_id, "messages", "Communication", "reply-to-message", (authority) =>
        tenant.messaging.reply(body.id!, {
          body: body.body!,
          authorKind: authority.relationship === "self" ? "patient" : "proxy",
          by: { actorId: subject, actorKind: "oauth" },
        })
      );
    }

    if (path === "/patient/access-log" && method === "GET") {
      const patientId = url.searchParams.get("patient");
      if (!patientId) return send(res, 400, { error: "patient required" });
      return patientPhi(patientId, "access-log", "AuditEvent", "view-access-log", () =>
        access.accessLog(patientId, num(url.searchParams.get("limit")) ?? 100)
      );
    }

    if (path === "/patient/delegates" && method === "GET") {
      const patientId = url.searchParams.get("patient");
      if (!patientId) return send(res, 400, { error: "patient required" });
      return patientPhi(patientId, "delegates", "Consent", "view-delegates", (authority) => {
        if (authority.relationship !== "self") throw new Error("only the patient may review delegated access");
        return access.whoCanSee(patientId).map(authorityView);
      });
    }

    if (path === "/patient/delegate-revoke" && method === "POST") {
      const body = JSON.parse(await readBody(req)) as { patient?: string; authority?: string; reason?: string };
      if (!body.patient || !body.authority || !body.reason) {
        return send(res, 400, { error: "patient, authority and reason required" });
      }
      return patientPhi(body.patient, "delegates", "Consent", "revoke-delegate", (self) => {
        if (self.relationship !== "self") throw new Error("only the patient may revoke delegated access");
        const delegated = access.authority(body.authority!);
        if (!delegated || delegated.patient_id !== body.patient || delegated.relationship === "self") {
          throw new Error("that is not a delegated authority for this patient");
        }
        return authorityView(
          access.revoke(body.authority!, {
            actorId: subject,
            actorKind: "oauth",
            reason: body.reason!,
          })
        );
      });
    }

    if (path === "/patient/requests" && method === "GET") {
      const patientId = url.searchParams.get("patient");
      if (!patientId) return send(res, 400, { error: "patient required" });
      return patientPhi(patientId, "requests", "Task", "view-patient-requests", () => access.requestsFor(patientId));
    }

    if (path === "/patient/request" && method === "POST") {
      const body = JSON.parse(await readBody(req)) as {
        patient?: string;
        kind?: "access" | "correction";
        target?: string;
        detail?: string;
      };
      if (!body.patient || !body.kind || !body.detail) {
        return send(res, 400, { error: "patient, kind and detail required" });
      }
      return patientPhi(
        body.patient,
        "requests",
        "Task",
        "submit-patient-request",
        (authority) =>
          access.submitRequest({
            patientId: body.patient!,
            kind: body.kind!,
            detail: body.detail!,
            ...(body.target ? { target: body.target } : {}),
            by: { subjectId: subject, relationship: authority.relationship },
          }),
        201
      );
    }

    return send(res, 404, { error: "not found" });
  }

  if (path === "/api/channels" && method === "GET") {
    return send(res, 200, engine.listChannels());
  }
  if (path === "/api/channels" && method === "POST") {
    const body = await readBody(req);
    const config = JSON.parse(body) as ChannelConfig;
    // Who made the change comes from the credential; why comes from the
    // x-change-note header, so the body stays exactly the channel document
    // that source control holds. A change with no note is recorded as such
    // rather than refused — but the version always says who and when.
    const note = typeof req.headers["x-change-note"] === "string" ? req.headers["x-change-note"] : undefined;
    await engine.addChannel(config, {
      by: auth.ok ? auth.principal.id : "unauthenticated",
      ...(note ? { note } : {}),
    });
    const v = engine.channelVersions.history(config.id)[0];
    audit({
      action: "U",
      resourceType: "Channel",
      resourceId: config.id,
      detail: `configured as version ${v?.version ?? "?"}${note ? `: ${note}` : ""}`,
    });
    return send(res, 201, { ok: true, id: config.id, version: v?.version });
  }

  // Exact paths first: "export" and "import" would otherwise match the
  // one-segment channel-id pattern below and read as channels named that.
  if (path === "/api/channels/export" && method === "GET") {
    // The whole configuration in the form source control holds and an
    // operator edits — which makes a config change reviewable as a pull
    // request instead of as JSON edited in a database.
    return send(res, 200, { channels: engine.channelVersions.exportAll() });
  }
  if (path === "/api/channels/import" && method === "POST") {
    const body = JSON.parse(await readBody(req)) as {
      channels?: ChannelDocument[];
      apply?: boolean;
      note?: string;
    };
    if (!Array.isArray(body.channels)) return send(res, 400, { error: "channels required" });
    // Validated before anything is planned, let alone written. Validation
    // inside the restart used to run after the ledger and live rows were
    // already updated, which is the worst possible moment to learn a document
    // is malformed: the database applied, the runtime half restarted.
    for (const doc of body.channels) {
      // The document id and the blob's id must agree: the row is stored under
      // the document's, the runtime registers under the blob's, and letting
      // them differ splits one channel into two half-identities — an orphaned
      // runtime, a wrong running flag, and messages stamped against a row
      // that does not exist.
      const blobId = (doc?.config as { id?: unknown } | undefined)?.id;
      if (blobId !== doc?.id) {
        return send(res, 400, {
          error: `channel ${doc?.id ?? "(no id)"}: document id and config.id disagree (${String(doc?.id)} vs ${String(blobId)})`,
        });
      }
      try {
        validateChannel(doc.config as unknown as ChannelConfig);
      } catch (err) {
        return send(res, 400, {
          error: `channel ${doc?.id ?? "(no id)"}: ${err instanceof Error ? err.message : "invalid config"}`,
        });
      }
    }
    // A plan unless apply is said outright. The plan is the review: what
    // would be created, what would change and exactly how, what the document
    // does not mention — and a dry run writes nothing at all.
    if (!body.apply) {
      return send(res, 200, { applied: false, ...engine.channelVersions.plan(body.channels) });
    }
    const plan = engine.channelVersions.apply(body.channels, {
      actorId: auth.ok ? auth.principal.id : "unauthenticated",
      note: body.note ?? "(no note given)",
    });
    // The live engine follows the ledger: anything the import changed is
    // restarted to match the stored row. Not through addChannel — that
    // re-derives enabled and name from the config blob and records a second
    // version doing it, so an import that disabled a channel would have been
    // switched back on by its own restart.
    for (const entry of plan.entries) {
      if (entry.action === "unchanged") continue;
      await engine.refreshChannel(entry.channelId);
    }
    audit({
      action: "U",
      resourceType: "Channel",
      count: plan.entries.filter((e) => e.action !== "unchanged").length,
      detail: `import applied${body.note ? `: ${body.note}` : ""}`,
    });
    return send(res, 200, { applied: true, ...plan });
  }

  let m = /^\/api\/channels\/([a-z0-9-]+)\/versions$/.exec(path);
  if (m && method === "GET") {
    return send(res, 200, engine.channelVersions.history(m[1]));
  }
  m = /^\/api\/channels\/([a-z0-9-]+)\/versions\/(\d+)$/.exec(path);
  if (m && method === "GET") {
    const v = engine.channelVersions.get(m[1], Number(m[2]));
    return v ? send(res, 200, v) : send(res, 404, { error: "not found" });
  }
  m = /^\/api\/channels\/([a-z0-9-]+)\/diff$/.exec(path);
  if (m && method === "GET") {
    const from = Number(url.searchParams.get("from"));
    const to = Number(url.searchParams.get("to"));
    if (!Number.isInteger(from) || !Number.isInteger(to)) {
      return send(res, 400, { error: "from and to versions required" });
    }
    try {
      return send(res, 200, { channelId: m[1], from, to, diff: engine.channelVersions.diff(m[1], from, to) });
    } catch (err) {
      // A missing version is the operator's 404, not a server fault.
      if (err instanceof Refusal) return send(res, err.status, { error: err.message });
      throw err;
    }
  }
  m = /^\/api\/channels\/([a-z0-9-]+)\/rollback$/.exec(path);
  if (m && method === "POST") {
    const body = JSON.parse(await readBody(req)) as { to?: number; note?: string };
    if (!Number.isInteger(body.to)) return send(res, 400, { error: "to version required" });
    let config: ChannelConfig;
    try {
      config = await engine.rollbackChannel(m[1], body.to!, {
        by: auth.ok ? auth.principal.id : "unauthenticated",
        ...(body.note ? { note: body.note } : {}),
      });
    } catch (err) {
      // "No such version", "that is the deletion marker", "already at that
      // shape" — refusals with the status they chose, not 500s wearing them.
      if (err instanceof Refusal) return send(res, err.status, { error: err.message });
      throw err;
    }
    audit({
      action: "U",
      resourceType: "Channel",
      resourceId: m[1],
      detail: `rolled back to version ${body.to}${body.note ? `: ${body.note}` : ""}`,
    });
    return send(res, 200, { ok: true, id: m[1], config });
  }

  m = /^\/api\/channels\/([a-z0-9-]+)$/.exec(path);
  if (m) {
    if (method === "GET") {
      const cfg = engine.getChannelConfig(m[1]);
      return cfg ? send(res, 200, cfg) : send(res, 404, { error: "not found" });
    }
    if (method === "DELETE") {
      const note = typeof req.headers["x-change-note"] === "string" ? req.headers["x-change-note"] : undefined;
      await engine.removeChannel(m[1], {
        by: auth.ok ? auth.principal.id : "unauthenticated",
        ...(note ? { note } : {}),
      });
      audit({ action: "D", resourceType: "Channel", resourceId: m[1], detail: note ?? "(no note given)" });
      return send(res, 200, { ok: true });
    }
  }

  if (path === "/api/messages" && method === "GET") {
    const rows = db.listMessages({
      channelId: url.searchParams.get("channel_id") ?? undefined,
      status: url.searchParams.get("status") ?? undefined,
      limit: num(url.searchParams.get("limit")),
    });
    // A raw ER7 message identifies a patient as surely as anything in the
    // facade, so browsing the message log is a disclosure.
    audit({ action: "R", resourceType: "Message", count: rows.length });
    return send(res, 200, rows.map(redactMessage));
  }

  m = /^\/api\/messages\/([0-9a-f-]+)$/.exec(path);
  if (m && method === "GET") {
    const msg = db.getMessage(m[1]);
    if (!msg) return send(res, 404, { error: "not found" });
    audit({ action: "R", resourceType: "Message", resourceId: msg.id, count: 1 });
    return send(res, 200, {
      ...msg,
      steps: db.getSteps(m[1]),
      deliveries: db.deliveriesForMessage(m[1]),
    });
  }

  if (path === "/api/deliveries" && method === "GET") {
    const rows = db.listDeliveries({
      channelId: url.searchParams.get("channel_id") ?? undefined,
      state: url.searchParams.get("state") ?? undefined,
      limit: num(url.searchParams.get("limit")),
    });
    return send(res, 200, rows);
  }

  m = /^\/api\/deliveries\/([0-9a-f-]+)\/(replay|discard)$/.exec(path);
  if (m && method === "POST") {
    // Replay says why it refused — "cannot replay in current state" is not
    // actionable when the real reason is that retention took the payload.
    if (m[2] === "replay") {
      const r = db.replayDelivery(m[1]);
      return r.ok ? send(res, 200, { ok: true }) : send(res, 409, { error: r.reason });
    }
    const ok = db.discardDelivery(m[1]);
    return send(res, ok ? 200 : 409, ok ? { ok: true } : { error: "cannot discard in current state" });
  }

  if (path === "/api/chain/verify" && method === "GET") {
    const channelId = url.searchParams.get("channel_id");
    if (!channelId) return send(res, 400, { error: "channel_id required" });
    return send(res, 200, db.verifyChain(channelId));
  }

  if (path === "/api/mappings" && method === "GET") {
    return send(res, 200, [...engine.mappings.values()]);
  }
  if (path === "/api/mappings/preview" && method === "POST") {
    // Runs a mapping against a sample without touching a channel, the queue or
    // the store, so the editor can preview freely with no side effects.
    const body = JSON.parse(await readBody(req)) as { mapping?: MappingDoc | string; sample?: string };
    const doc = typeof body.mapping === "string" ? engine.mappings.get(body.mapping) : body.mapping;
    if (!doc) return send(res, 400, { error: "mapping document or a registered mapping id is required" });
    if (typeof body.sample !== "string" || !body.sample) return send(res, 400, { error: "sample required" });
    try {
      return send(res, 200, { ok: true, output: applyMapping(doc, body.sample, engine.mapperContext()) });
    } catch (err) {
      let error = err instanceof Error ? err.message : "mapping failed";
      // Omitting `input: "hl7"` makes the mapper try to JSON.parse an ER7
      // message, and the resulting parse error explains nothing. Name the
      // actual mistake instead.
      if (doc.input !== "hl7" && /^MSH\|/.test(body.sample.trimStart())) {
        error = `the sample looks like HL7 v2 but the mapping does not set "input": "hl7" (${error})`;
      }
      return send(res, 200, { ok: false, error });
    }
  }

  if (path === "/api/fixtures" && method === "GET") {
    return send(res, 200, listFixtures());
  }

  if (path === "/api/history" && method === "GET") {
    const bucket = url.searchParams.get("bucket") === "day" ? "day" : "hour";
    return send(res, 200, {
      bucket,
      ...db.history(num(url.searchParams.get("hours")) ?? 24, bucket),
    });
  }

  if (path === "/api/backup" && method === "POST") {
    const dir = process.env.PORTAGE_BACKUP_DIR ?? join(process.cwd(), "backups");
    const keep = Number(process.env.PORTAGE_BACKUP_KEEP ?? "7");
    try {
      const result = await takeBackup(db, { dir, keep: Number.isInteger(keep) && keep > 0 ? keep : undefined });
      if (!remote?.configured) {
        audit({
          action: "E",
          resourceType: "Backup",
          detail: `snapshot ${result.path} (${result.bytes} bytes, ${result.verified.messages} messages verified; local only)`,
        });
        return send(res, 200, { ...result, remote: remote?.status() ?? { configured: false, ok: false } });
      }
      try {
        const replica = await remote.replicate(result.path);
        audit({
          action: "E",
          resourceType: "Backup",
          detail:
            `snapshot ${result.path} (${result.bytes} bytes, ${result.verified.messages} messages verified); ` +
            `replicated to ${replica.location} as ${replica.name} (${replica.bytes} bytes, read back and verified)`,
        });
        return send(res, 200, { ...result, remote: replica });
      } catch (err) {
        // The local snapshot is good. The copy that survives the machine is
        // not. 500 because the operator asked for a backup and the half that
        // makes it one for a dead disk failed; the path is still in the body.
        const message = err instanceof Error ? err.message : "remote replication failed";
        audit({
          action: "E",
          resourceType: "Backup",
          outcome: 8,
          detail: `snapshot ${result.path} written locally; replication failed: ${message}`,
        });
        return send(res, 500, { error: message, path: result.path, local: result, remote: remote.status() });
      }
    } catch (err) {
      // A snapshot that failed verification is worse than none, because it
      // would be trusted. Report it as a failure and record it.
      const message = err instanceof Error ? err.message : "backup failed";
      audit({ action: "E", resourceType: "Backup", outcome: 8, detail: message });
      return send(res, 500, { error: message });
    }
  }

  if (path === "/api/retention" && method === "GET") {
    return send(res, 200, engine.retention.describe());
  }
  if (path === "/api/retention/run" && method === "POST") {
    const result = engine.retention.run();
    audit({
      action: "E",
      resourceType: "Retention",
      detail: `manual sweep: ${result.redactedMessages} redacted, ${result.purgedMessages} purged`,
    });
    return send(res, 200, result);
  }

  if (path === "/api/audit" && method === "GET") {
    const rows = tenant.audit.list({
      principal: url.searchParams.get("principal") ?? undefined,
      patient: url.searchParams.get("patient") ?? undefined,
      resourceType: url.searchParams.get("resource_type") ?? undefined,
      since: url.searchParams.get("since") ?? undefined,
      failuresOnly: url.searchParams.get("failures") === "true",
      limit: num(url.searchParams.get("limit")),
    });
    return send(res, 200, rows);
  }
  if (path === "/api/audit/verify" && method === "GET") {
    return send(res, 200, tenant.audit.verifyChain());
  }
  if (path === "/api/audit/review" && method === "GET") {
    // The questions a privacy office actually asks. `/api/audit` answers "what
    // rows are there"; this answers "who looked at this patient, did they have
    // any reason to, and what should I look at first".
    //
    // Reading it is itself an access to something about a patient, so it is
    // audited like any other — a review surface that read charts' access logs
    // without leaving a trace would be the one privileged back door in a
    // system whose whole argument is that there are none.
    const patient = url.searchParams.get("patient");
    if (!patient) return send(res, 400, { error: "patient required" });
    const report = tenant.review.forPatient(patient, {
      relationshipWindowDays: num(url.searchParams.get("window_days")),
      limit: num(url.searchParams.get("limit")),
    });
    tenant.audit.record({
      action: "R",
      outcome: 0,
      resourceType: "AuditEvent",
      patient,
      count: report.accesses.length,
      principalId: auth.ok ? auth.principal.id : "unauthenticated",
      principalKind: auth.ok ? auth.principal.kind : "unknown",
      method,
      path,
      detail: "access review",
      ...(auth.ok && auth.principal.organizationId ? { organizationId: auth.principal.organizationId } : {}),
      ...(auth.ok && auth.principal.practitionerId ? { practitionerId: auth.principal.practitionerId } : {}),
    });
    return send(res, 200, report);
  }
  if (path === "/api/audit/review/dismiss" && method === "POST") {
    // Closing a flag, with a reason that is itself kept. A review whose
    // judgements vanish re-raises the same flag next month with nothing to say
    // it was already answered, and the answer is usually the only place the
    // context lives.
    const body = JSON.parse(await readBody(req)) as { auditId?: string; flag?: string; reason?: string };
    if (!body.auditId || !body.flag || !body.reason) {
      return send(res, 400, { error: "auditId, flag and reason required" });
    }
    try {
      tenant.review.dismiss({
        auditId: body.auditId,
        flag: body.flag as Parameters<typeof tenant.review.dismiss>[0]["flag"],
        reason: body.reason,
        by: auth.ok ? auth.principal.id : "unauthenticated",
      });
      tenant.audit.record({
        action: "U",
        outcome: 0,
        resourceType: "AuditEvent",
        resourceId: body.auditId,
        principalId: auth.ok ? auth.principal.id : "unauthenticated",
        principalKind: auth.ok ? auth.principal.kind : "unknown",
        method,
        path,
        detail: `dismissed ${body.flag}: ${body.reason}`,
      });
      return send(res, 200, { ok: true });
    } catch (err) {
      return send(res, 400, { error: err instanceof Error ? err.message : "cannot dismiss" });
    }
  }
  if (path === "/fhir/AuditEvent" && method === "GET") {
    const rows = tenant.audit.list({
      patient: url.searchParams.get("patient") ?? undefined,
      since: url.searchParams.get("date") ?? undefined,
      limit: num(url.searchParams.get("_count")),
    });
    return send(res, 200, {
      resourceType: "Bundle",
      type: "searchset",
      total: rows.length,
      entry: rows.map((r) => ({
        fullUrl: `${baseUrl(req)}/fhir/AuditEvent/${r.id}`,
        resource: tenant.audit.toAuditEvent(r, baseUrl(req)),
      })),
    });
  }

  // ---- the clinical platform -------------------------------------------
  //
  // Every route below reads or writes patient data, so every one of them
  // audits. That is enforced structurally rather than remembered: the paths
  // are listed in CLINICAL_ROUTES, touchesPatientData() reads that list, and
  // test/clinical-api.test.ts drives each entry and fails the build if a
  // request leaves no audit row. A route added here without a trail is a route
  // the test refuses.
  //
  // `phi()` is the shape that makes it hard to get wrong: it audits first and
  // sends second, so an exception between the two cannot produce a read that
  // happened without a record of it happening.
  if (path.startsWith("/api/clinical/")) {
    const patient = url.searchParams.get("patient") ?? undefined;

    // A station answers for a cache, and the rules come before any route on
    // it. Everything here fails closed, and every refusal says what to do
    // instead of a chart.
    const stationState = station?.state();
    if (stationState) {
      if (!stationState.serving) {
        // Expiry is autonomous, and this is half of how: the first request
        // to arrive past the budget destroys the cache rather than leaving a
        // copy of the record on disk for an operator to remember. (The other
        // half is the hourly sweep in startApi, for the station nobody asks.)
        if (stationState.reason === "expired") station?.expire();
        // Past the budget the directives in the cache are too old to be
        // trusted about who may see what, so the honest answer is nothing —
        // never a chart with an unknown lockbox over it.
        audit({
          action: verbToAction(method),
          outcome: 4,
          resourceType: "Composition",
          ...(patient ? { patient } : {}),
          detail: `station not serving (${stationState.reason})`,
        });
        return send(res, 503, {
          error: stationState.detail,
          station: stationState.reason,
          remedy: "reach the primary over the link, or fill this station from a fresh snapshot",
        });
      }
      // Every station response says what it is serving from, so a consumer
      // that never opens the assembled chart still cannot mistake outage
      // data for current data without ignoring the response saying so.
      res.setHeader("x-portage-station-as-of", stationState.asOf);
      res.setHeader("x-portage-station-age-hours", String(stationState.ageHours));

      // Break-glass works offline — §6 of the design, and the reason a
      // blanket write refusal would be wrong: a withheld chart mid-emergency
      // with no way through is exactly the failure H-25 exists to refuse.
      // The declaration lands in the cache, where the same consent code the
      // primary runs honours it for the rest of the outage; a copy lands in
      // the station's own database, which survives the purge, so the primary
      // learns of it — and the patient's notice is queued — at
      // reconciliation.
      if (method === "POST" && path === "/api/clinical/break-glass") {
        const body = JSON.parse(await readBody(req)) as { patient?: string; reason?: string };
        if (!body.patient || !body.reason) return send(res, 400, { error: "patient and reason required" });
        const who = auth.ok ? auth.principal.id : "unauthenticated";
        const kind = auth.ok ? auth.principal.kind : "unknown";
        try {
          const declared = tenant.consent.breakGlass({
            patientId: body.patient,
            by: { actorId: who, actorKind: kind },
            reason: body.reason,
            ...(auth.ok && auth.principal.purposeOfUse ? { purposeOfUse: auth.principal.purposeOfUse } : {}),
          });
          station?.recordBreakGlass({ patient: body.patient, reason: body.reason, actorId: who, actorKind: kind });
          audit({
            action: "E",
            outcome: 0,
            resourceType: "Consent",
            patient: body.patient,
            detail: `break-glass declared during outage: ${body.reason}`,
          });
          return send(res, 201, {
            ...declared,
            station: stationState.stationId,
            note: "declared against the cache; the primary learns of it, and the patient's notice is queued, at reconciliation",
          });
        } catch (err) {
          const mapped = mapStoreError(err);
          audit({
            action: "E",
            outcome: mapped.outcome,
            resourceType: "Consent",
            patient: body.patient,
            detail: mapped.detail,
          });
          return send(res, mapped.status, { error: mapped.error });
        }
      }

      // Read-only means no clinical *writes* — not no POSTs. The safety
      // check and the registry queries are reads that arrive as POST because
      // their input is structured, and refusing them would take the allergy
      // check away for exactly the outage it matters most in.
      const READS_AS_POST = ["/api/clinical/safety-check", "/api/clinical/gaps", "/api/clinical/measure"];
      if (method !== "GET" && !READS_AS_POST.includes(path)) {
        audit({
          action: verbToAction(method),
          outcome: 4,
          resourceType: "Composition",
          ...(patient ? { patient } : {}),
          detail: "refused: a reading station does not accept clinical writes",
        });
        return send(res, 405, {
          error:
            "this is a reading station serving a cached chart; it does not accept clinical writes, " +
            "because a second writable copy of the record is a conflict nobody can resolve safely afterwards",
          remedy:
            "write on paper or into the feed queue as during any outage — the queue holds and drains when the link returns",
          servingAsOf: stationState.asOf,
        });
      }
    }

    /**
     * Whether a patient directive stands between this caller and this record.
     *
     * Consulted by `phi` for every route that names a patient, so a lockbox
     * cannot be ignored by a route that forgot to ask. A refusal is audited
     * like any other access — a directive that stopped somebody is exactly
     * what a privacy office wants to see — and it says that a directive
     * exists without saying what it says.
     */
    const subjectId = auth.ok ? auth.principal.id : "unauthenticated";

    // `organizationId` is what makes a `withhold-from-organization` directive
    // mean anything. It was matched against a field nothing ever passed, so
    // every such directive evaluated the same way for every caller; passing it
    // is the whole of the fix. A credential that carries none is still stopped,
    // because a caller that cannot say it is outside the withheld organization
    // has not shown that it is.
    const restrictions = (forPatient: string) =>
      tenant.consent.restrictionsFor({
        subjectId,
        patientId: forPatient,
        ...(auth.ok && auth.principal.organizationId ? { organizationId: auth.principal.organizationId } : {}),
      });

    /**
     * Whether a directive stops this caller reading this much of this record.
     *
     * `covers` is what the route may return. A route serving one entry type
     * asks about that type and is refused only if the patient locked it; the
     * chart asks about all of them and is refused only by a directive that
     * withholds the record as a whole, because it can drop the locked sections
     * and say so instead.
     */
    const withheld = (forPatient: string, covers: readonly string[]): { id: string } | undefined => {
      const r = restrictions(forPatient);
      if (r.underBreakGlass) return undefined;
      if (r.blocking) return { id: r.blocking.id };
      // A route that can serve part of its answer is not stopped by a
      // directive on one part; `phi` hands it the withheld set instead.
      if (covers.length > 1) return undefined;
      const d = covers.length === 1 ? r.withheldTypes.get(covers[0]) : undefined;
      return d ? { id: d.id } : undefined;
    };

    /**
     * Filters a list of rows by directive, and says how many it dropped.
     *
     * A single-patient route refuses outright, because the caller asked about
     * one person and needs to know a lockbox is why they cannot see. A list
     * cannot do that — refusing the whole worklist because one patient on it
     * has a directive would take a clinician's day away — so withheld rows are
     * omitted.
     *
     * But not silently. A short list that looks complete is the failure this
     * system refuses everywhere else, and here it is worse than usual: a
     * result withheld from the clinician responsible for reading it is a
     * result now owed to nobody, which is the exact silence the orders module
     * exists to prevent. The count is reported so somebody can act on it; who
     * they are is not, which is what the directive asked for.
     */
    const filterByDirective = <T extends { patient_id: string }>(
      covers: readonly string[],
      rows: T[]
    ): { rows: T[]; withheldCount: number } => {
      const kept: T[] = [];
      const blocked = new Set<string>();
      for (const row of rows) {
        if (withheld(row.patient_id, covers)) blocked.add(row.patient_id);
        else kept.push(row);
      }
      return { rows: kept, withheldCount: rows.length - kept.length };
    };

    /**
     * Audits the access, then sends. In that order, deliberately.
     *
     * `covers` is every entry type the response may contain, and defaults to
     * the resource type the route declares — which is the right answer for the
     * routes that serve one kind of thing. The chart and the worklist pass
     * their own lists, because they assemble several, and receive the withheld
     * set so they can drop those sections rather than refuse outright.
     */
    const phiFor = <T,>(
      subject: string | undefined,
      resourceType: string,
      produce: (withheldTypes: ReadonlySet<string>) => T,
      count?: (v: T) => number,
      covers: readonly string[] = [resourceType]
    ): void => {
      const patient = subject;
      let withheldTypes: ReadonlySet<string> = new Set();
      if (patient) {
        const block = withheld(patient, covers);
        if (!block) {
          const r = restrictions(patient);
          withheldTypes = new Set([...r.withheldTypes.keys()].filter((t) => covers.includes(t)));
        }
        if (block) {
          audit({
            action: verbToAction(method),
            outcome: 4,
            resourceType,
            patient,
            detail: `withheld by patient directive ${block.id}`,
          });
          return send(res, 403, {
            error: "this record is withheld by a patient directive",
            // Named so a caller can declare an emergency against it, which is
            // the whole reason a lockbox is survivable in a clinical setting.
            breakGlass: "POST /api/clinical/break-glass",
          });
        }
      }
      let value: T;
      try {
        value = produce(withheldTypes);
      } catch (err) {
        const mapped = mapStoreError(err);
        if (mapped.outcome === 8) console.error(`phi ${resourceType}: ${mapped.detail}`);
        audit({ action: verbToAction(method), outcome: mapped.outcome, resourceType, patient, detail: mapped.detail });
        return send(res, mapped.status, { error: mapped.error });
      }
      audit({
        action: verbToAction(method),
        outcome: 0,
        resourceType,
        patient,
        ...(count ? { count: count(value) } : {}),
        // A partly withheld read is not an ordinary one, and the trail is
        // where a privacy office finds out the directive did something. Only
        // the types, never the content: which sections were locked is the
        // narrowest thing that makes the row useful.
        ...(withheldTypes.size ? { detail: `withheld by patient directive: ${[...withheldTypes].sort().join(", ")}` } : {}),
      });
      return send(res, 200, value);
    };

    /**
     * The ordinary case: the patient this route is about is the one named in
     * the query string.
     *
     * A route that learns whose record it is serving from the data rather than
     * from the caller — an encounter, say, which knows its own patient — uses
     * `phiFor` directly. That distinction matters: letting a caller omit
     * `patient` and have the directive check skipped would be a way past every
     * lockbox in the system.
     */
    const phi = <T,>(
      resourceType: string,
      produce: (withheldTypes: ReadonlySet<string>) => T,
      count?: (v: T) => number,
      covers: readonly string[] = [resourceType]
    ): void => phiFor(patient, resourceType, produce, count, covers);

    /**
     * Privacy-office reads and writes. Audits, then sends, like `phi` — but
     * does not apply patient lockboxes. A directive that hid the office from
     * the record it is charged with reviewing would be a lock with no key.
     * Still tenant-scoped; the trail says the directive was not applied.
     */
    const phiOffice = <T,>(
      resourceType: string,
      produce: () => T,
      count?: (v: T) => number,
      subject?: string
    ): void => {
      let value: T;
      try {
        value = produce();
      } catch (err) {
        const mapped = mapStoreError(err);
        if (mapped.outcome === 8) console.error(`phiOffice ${resourceType}: ${mapped.detail}`);
        audit({
          action: verbToAction(method),
          outcome: mapped.outcome,
          resourceType,
          patient: subject,
          detail: mapped.detail,
        });
        return send(res, mapped.status, { error: mapped.error });
      }
      audit({
        action: verbToAction(method),
        outcome: 0,
        resourceType,
        patient: subject,
        ...(count ? { count: count(value) } : {}),
        detail: "privacy office; patient directive not applied",
      });
      return send(res, 200, value);
    };

    const officeActor = () => ({
      actorId: auth.ok ? auth.principal.id : "unauthenticated",
      actorKind: auth.ok ? auth.principal.kind : "unknown",
    });

    if (path === "/api/clinical/chart" && method === "GET") {
      if (!patient) return send(res, 400, { error: "patient required" });
      // The chart is not one entry type, which is why it passes CHART_TYPES
      // and takes the withheld set rather than being refused outright. A
      // patient who locked their counselling notes gets a chart without that
      // panel — and the panel says a directive is why, because a summary is
      // read as complete and a silently short one is the failure this whole
      // module exists to refuse.
      const members = tenant.links.membersOf(patient);
      if (members.length === 1) {
        return phi(
          "Composition",
          (withheldTypes) =>
            tenant.workspace.chart(patient, {
              limit: num(url.searchParams.get("limit")),
              withheldTypes,
              // On a station this is what puts the age on every panel. It is
              // the snapshot's own stamp, so the chart dates itself from when
              // the data was true rather than from when the copy landed.
              ...(stationState?.serving ? { asOf: stationState.asOf } : {}),
            }),
          undefined,
          CHART_TYPES
        );
      }
      // A linked chart serves several patients' rows in one response, so the
      // directive check and the audit trail both have to speak about every
      // member, not the id in the query string. Fail closed member by member:
      // one member's whole-record directive withholds the assembled view —
      // there is no honest chart for "this person" that omits a chart the
      // person locked — and a break-glass override lifts only the member it
      // was declared for. The withheld entry types are the union, so a
      // section locked on any member is locked on the assembled chart.
      const withheldTypes = new Set<string>();
      for (const member of members) {
        const r = restrictions(member);
        if (r.underBreakGlass) continue;
        if (r.blocking) {
          // The refusal lands on both stories: the member whose directive
          // spoke, with the directive id — and the chart the caller was
          // opening, because an access review of the queried chart that
          // cannot see the refused attempt is missing a page. The response
          // names the withheld member, because break-glass is declared per
          // member: overriding the queried id would lift nothing, and the
          // membership itself is already served to this caller by
          // /api/clinical/links.
          audit({
            action: "R",
            outcome: 4,
            resourceType: "Composition",
            patient: member,
            detail: `linked chart withheld by patient directive ${r.blocking.id}`,
          });
          if (member !== patient) {
            audit({
              action: "R",
              outcome: 4,
              resourceType: "Composition",
              patient,
              detail: "chart refused: a linked member's record is withheld by a patient directive",
            });
          }
          return send(res, 403, {
            error: "a linked chart is withheld by a patient directive",
            withheldMember: member,
            breakGlass: "POST /api/clinical/break-glass",
          });
        }
        for (const t of r.withheldTypes.keys()) if (CHART_TYPES.includes(t)) withheldTypes.add(t);
      }
      let assembled: ReturnType<typeof tenant.workspace.chart>;
      try {
        assembled = tenant.workspace.chart(patient, {
          limit: num(url.searchParams.get("limit")),
          withheldTypes,
          linkedMembers: members.filter((m) => m !== patient),
          ...(stationState?.serving ? { asOf: stationState.asOf } : {}),
        });
      } catch (err) {
        const mapped = mapStoreError(err);
        audit({ action: "R", outcome: mapped.outcome, resourceType: "Composition", patient, detail: mapped.detail });
        return send(res, mapped.status, { error: mapped.error });
      }
      // One row per member, because each member's record was disclosed and
      // each member's access review must see this read. A single row naming
      // only the queried id would hide the linked members' disclosure from
      // exactly the report built to find it. A partly withheld assembly is
      // recorded the way phi() records it — types only, never content — or
      // the trail would say the directive did nothing here.
      const withheldNote = withheldTypes.size
        ? `; withheld by patient directive: ${[...withheldTypes].sort().join(", ")}`
        : "";
      for (const member of members) {
        audit({
          action: "R",
          outcome: 0,
          resourceType: "Composition",
          patient: member,
          detail:
            (member === patient
              ? `chart assembled across ${members.length} linked charts`
              : `served as a linked member of ${patient}'s chart`) + withheldNote,
        });
      }
      return send(res, 200, assembled);
    }
    if (path === "/api/clinical/links" && method === "GET") {
      if (!patient) return send(res, 400, { error: "patient required" });
      // A link is a statement about the patient's identity, so reading it is
      // reading something about them: through the directive check and onto
      // the trail like any other read.
      return phi("Patient", () => ({
        members: tenant.links.membersOf(patient),
        links: tenant.links.linksFor(patient),
        history: tenant.links.historyFor(patient),
      }));
    }
    if (path === "/api/clinical/link" && method === "POST") {
      // Asserting that two charts are one person is a clinical decision about
      // both of them. Both directive checks run — a caller withheld from
      // either chart may not join it to another — and both patients get the
      // event on their trail.
      const body = JSON.parse(await readBody(req)) as { a?: string; b?: string; evidence?: string };
      if (!body.a || !body.b || !body.evidence) return send(res, 400, { error: "a, b and evidence required" });
      for (const id of [body.a, body.b]) {
        const block = withheld(id, ["Patient"]);
        if (block) {
          audit({ action: "C", outcome: 4, resourceType: "Patient", patient: id, detail: `link refused: withheld by patient directive ${block.id}` });
          return send(res, 403, { error: "this record is withheld by a patient directive", breakGlass: "POST /api/clinical/break-glass" });
        }
      }
      const who = auth.ok ? auth.principal.id : "unauthenticated";
      try {
        const link = tenant.links.link(body.a, body.b, {
          actorId: who,
          actorKind: auth.ok ? auth.principal.kind : "unknown",
          evidence: body.evidence,
        });
        for (const id of [body.a, body.b]) {
          audit({ action: "C", outcome: 0, resourceType: "Patient", patient: id, detail: `linked to ${id === body.a ? body.b : body.a}: ${body.evidence}` });
        }
        return send(res, 201, link);
      } catch (err) {
        const mapped = mapStoreError(err);
        // The attempt named both charts, so the refusal lands on both trails.
        for (const id of [body.a, body.b]) {
          audit({ action: "C", outcome: mapped.outcome, resourceType: "Patient", patient: id, detail: mapped.detail });
        }
        return send(res, mapped.status, { error: mapped.error });
      }
    }
    if (path === "/api/clinical/unlink" && method === "POST") {
      const body = JSON.parse(await readBody(req)) as { link?: string; reason?: string };
      if (!body.link || !body.reason) return send(res, 400, { error: "link and reason required" });
      // Withdrawing the assertion is a clinical decision about both charts,
      // exactly as making it was. The link route refuses a caller either
      // patient's directive excludes; severing has to refuse the same
      // caller, or the identity graph is writable from outside the lockbox
      // in one direction — a caller blocked from B could quietly drop B out
      // of every assembled chart and every safety-check union that B's
      // allergies would have reached.
      for (const id of tenant.links.patientsOf(body.link)) {
        const block = withheld(id, ["Patient"]);
        if (block) {
          audit({ action: "U", outcome: 4, resourceType: "Patient", patient: id, detail: `unlink refused: withheld by patient directive ${block.id}` });
          return send(res, 403, { error: "this record is withheld by a patient directive", breakGlass: "POST /api/clinical/break-glass" });
        }
      }
      const who = auth.ok ? auth.principal.id : "unauthenticated";
      try {
        const event = tenant.links.unlink(body.link, {
          actorId: who,
          actorKind: auth.ok ? auth.principal.kind : "unknown",
          reason: body.reason,
        });
        for (const id of [event.patient_a, event.patient_b]) {
          audit({ action: "U", outcome: 0, resourceType: "Patient", patient: id, detail: `unlinked from ${id === event.patient_a ? event.patient_b : event.patient_a}: ${body.reason}` });
        }
        return send(res, 200, event);
      } catch (err) {
        const mapped = mapStoreError(err);
        // A refused attempt to sever a link is part of both charts' stories —
        // an access review that shows the withdrawal but not the refused try
        // before it is missing a page. Only an id that never named a link has
        // nobody to write it on, and that row stands without a patient.
        const parties = tenant.links.patientsOf(body.link);
        if (parties.length === 0) {
          audit({ action: "U", outcome: mapped.outcome, resourceType: "Patient", detail: mapped.detail });
        } else {
          for (const id of parties) {
            audit({ action: "U", outcome: mapped.outcome, resourceType: "Patient", patient: id, detail: mapped.detail });
          }
        }
        return send(res, mapped.status, { error: mapped.error });
      }
    }
    if (path === "/api/clinical/encounters" && method === "GET") {
      if (!patient) return send(res, 400, { error: "patient required" });
      // The list of visits is not clinical content — a reason for attending is
      // — so it goes through phi() like anything else that names a patient.
      // "Who came to the clinic and why" is exactly what a lockbox is for.
      return phi(
        "Encounter",
        () =>
          tenant.encounters.forPatient(patient, {
            includeCancelled: url.searchParams.get("cancelled") === "true",
            limit: num(url.searchParams.get("limit")),
          }),
        (r) => r.length
      );
    }
    if (path === "/api/clinical/encounter" && method === "GET") {
      const id = url.searchParams.get("id");
      if (!id) return send(res, 400, { error: "id required" });
      // The patient is read from the encounter rather than from the query
      // string, so the directive check cannot be dodged by omitting `patient`
      // — the caller does not get to nominate whose consent is consulted.
      const e = tenant.encounters.get(id);
      if (!e) return send(res, 404, { error: `no encounter ${id}` });
      return phiFor(
        e.patient_id,
        "Encounter",
        (withheldTypes) => tenant.visits.summarise(id, { limit: num(url.searchParams.get("limit")), withheldTypes }),
        undefined,
        VISIT_TYPES
      );
    }
    if (path === "/api/clinical/encounters-open" && method === "GET") {
      // Spans patients, like the worklist, so no single directive can refuse
      // it. It returns visits rather than clinical content: what is on it is
      // that a visit is still open, which is an administrative fact.
      return phi(
        "Encounter",
        () =>
          tenant.encounters.stillOpen({
            olderThanHours: num(url.searchParams.get("olderThanHours")),
          }),
        (r) => r.length
      );
    }
    if (path === "/api/clinical/worklist" && method === "GET") {
      const clinician = url.searchParams.get("clinician");
      if (!clinician) return send(res, 400, { error: "clinician required" });
      // A worklist spans patients rather than naming one, so a directive on
      // any single patient cannot refuse it — `filterByDirective` inside the
      // stores is what withholds rows there. It declares its types anyway, so
      // that a route added to it later inherits the right answer.
      return phi(
        "Task",
        () => tenant.workspace.worklist(clinician, { limit: num(url.searchParams.get("limit")) }),
        undefined,
        WORKLIST_TYPES
      );
    }
    if (path === "/api/clinical/patients" && method === "GET") {
      // A search is an access even when it returns nothing: "who did you look
      // for" is a question a privacy review asks, and a fruitless search for a
      // celebrity's name is exactly the one it asks about.
      return phi(
        "Patient",
        () =>
          filterByDirective(
            ["Patient"],
            tenant.clinical.patientIndex
              .search({
                identifier: url.searchParams.get("identifier") ?? undefined,
                family: url.searchParams.get("family") ?? undefined,
                given: url.searchParams.get("given") ?? undefined,
                birthDate: url.searchParams.get("birthdate") ?? undefined,
                limit: num(url.searchParams.get("limit")),
              })
              // The index speaks patientId; the filter speaks patient_id.
              .map((p) => ({ ...p, patient_id: p.patientId }))
          ),
        (r) => r.rows.length
      );
    }
    if (path === "/api/clinical/medications" && method === "GET") {
      if (!patient) return send(res, 400, { error: "patient required" });
      return phi(
        "MedicationStatement",
        () => tenant.meds.current(patient, { asPrescribed: url.searchParams.get("as_prescribed") === "true" }),
        (rows) => rows.length
      );
    }
    if (path === "/api/clinical/allergies" && method === "GET") {
      if (!patient) return send(res, 400, { error: "patient required" });
      return phi("AllergyIntolerance", () => ({
        // Three-valued, carried beside the list rather than left to be
        // inferred from its length. An empty list is not an answer.
        status: tenant.meds.allergyStatus(patient),
        allergies: tenant.meds.allergies(patient),
      }));
    }
    if (path === "/api/clinical/results" && method === "GET") {
      return phi(
        "Observation",
        () => {
          const all = tenant.orders.unacknowledged({
            responsibleId: url.searchParams.get("responsible") ?? undefined,
            overdueAsOf: url.searchParams.get("overdue_as_of") ?? undefined,
          });
          return filterByDirective(["Observation"], patient ? all.filter((r) => r.patient_id === patient) : all);
        },
        (r) => r.rows.length
      );
    }
    if (path === "/api/clinical/orders" && method === "GET") {
      if (!patient) return send(res, 400, { error: "patient required" });
      return phi("ServiceRequest", () => tenant.orders.forPatient(patient), (rows) => rows.length);
    }
    if (path === "/api/clinical/referrals" && method === "GET") {
      return phi(
        "ServiceRequest",
        () => filterByDirective(["ServiceRequest"], patient ? tenant.referrals.forPatient(patient) : tenant.referrals.stalled()),
        (r) => r.rows.length
      );
    }
    if (path === "/api/clinical/tasks" && method === "GET") {
      const owner = url.searchParams.get("owner");
      return phi(
        "Task",
        () => {
          const all = owner ? tenant.tasks.inbox(owner) : patient ? tenant.tasks.forPatient(patient) : tenant.tasks.unassigned();
          // A task with no patient on it is not about anybody, so no directive
          // can withhold it; those pass through untouched.
          const withPatient = all.filter((t): t is typeof t & { patient_id: string } => t.patient_id !== null);
          const filtered = filterByDirective(["Task"], withPatient);
          return { rows: [...all.filter((t) => t.patient_id === null), ...filtered.rows], withheldCount: filtered.withheldCount };
        },
        (r) => r.rows.length
      );
    }
    if (path === "/api/clinical/notes" && method === "GET") {
      if (!patient) return send(res, 400, { error: "patient required" });
      return phi(
        "DocumentReference",
        () => tenant.notes.forPatient(patient, { encounterId: url.searchParams.get("encounter") ?? undefined }),
        (rows) => rows.length
      );
    }
    if (path === "/api/clinical/immunizations" && method === "GET") {
      if (!patient) return send(res, 400, { error: "patient required" });
      return phi("Immunization", () => ({
        status: tenant.immunizations.historyStatus(patient),
        immunizations: tenant.immunizations.forPatient(patient),
      }));
    }
    if (path === "/api/clinical/vitals" && method === "GET") {
      if (!patient) return send(res, 400, { error: "patient required" });
      return phi("Observation", () => ({
        status: tenant.vitals.historyStatus(patient),
        latest: tenant.vitals.latest(patient),
        vitals: tenant.vitals.forPatient(patient, {
          ...(url.searchParams.get("encounter") ? { encounterId: url.searchParams.get("encounter")! } : {}),
        }),
      }));
    }
    if (path === "/api/clinical/care-team" && method === "GET") {
      if (!patient) return send(res, 400, { error: "patient required" });
      return phi("CareTeam", () => ({
        primary: tenant.careTeam.primary(patient) ?? null,
        members: tenant.careTeam.forPatient(patient, { includeRetired: url.searchParams.get("retired") === "true" }),
      }));
    }
    if (path === "/api/clinical/coverage" && method === "GET") {
      if (!patient) return send(res, 400, { error: "patient required" });
      return phi("Coverage", () => ({
        current: tenant.coverage.current(patient) ?? null,
        history: tenant.coverage.history(patient),
      }));
    }
    if (path === "/api/clinical/threads" && method === "GET") {
      if (!patient) return send(res, 400, { error: "patient required" });
      return phi(
        "Communication",
        () => tenant.messaging.forPatient(patient, { includeClosed: url.searchParams.get("closed") === "true" }),
        (rows) => rows.length
      );
    }
    if (path === "/api/clinical/thread" && method === "GET") {
      const id = url.searchParams.get("id");
      if (!id) return send(res, 400, { error: "id required" });
      const thread = tenant.messaging.get(id);
      if (!thread) return send(res, 404, { error: `no message thread ${id}` });
      return phiFor(thread.patient_id, "Communication", () => ({
        thread,
        messages: tenant.messaging.messages(id),
        history: tenant.messaging.history(id),
      }));
    }
    if (path === "/api/clinical/messages-awaiting" && method === "GET") {
      const clinician = url.searchParams.get("clinician");
      return phi(
        "Communication",
        () => {
          const rows = clinician ? tenant.messaging.inbox(clinician) : tenant.messaging.unassigned();
          return filterByDirective(["Communication"], rows);
        },
        (r) => r.rows.length
      );
    }
    if (path === "/api/clinical/appointments" && method === "GET") {
      if (!patient) return send(res, 400, { error: "patient required" });
      return phi("Appointment", () => tenant.schedule.forPatient(patient), (rows) => rows.length);
    }
    if (path === "/api/clinical/missed" && method === "GET") {
      // Missed appointments that mattered and that nobody has picked up. A
      // read of patient data like any other, and audited as one.
      return phi("Appointment", () => filterByDirective(["Appointment"], tenant.schedule.unresolvedNonAttendance()), (r) => r.rows.length);
    }
    if (path === "/api/clinical/acknowledge" && method === "POST") {
      // The one write the clinician surface needs, and the reason it is a
      // write rather than a flag: acknowledging a result is a clinical act,
      // and `orders.acknowledge()` refuses one without saying what was done
      // about it. A queue that empties on a click teaches a ward that the
      // queue is the work, and the result is what is actually owed.
      //
      // It also refuses a superseded result, so a corrected potassium cannot
      // be signed off by somebody looking at the value it replaced. That
      // refusal reaches the caller as a 400 with the reason in it, which is
      // what the UI shows.
      const body = JSON.parse(await readBody(req)) as { result?: string; action?: string };
      if (!body.result || !body.action) return send(res, 400, { error: "result and action required" });
      const who = auth.ok ? auth.principal.id : "unauthenticated";
      const row = tenant.orders.result(body.result);
      if (!row) return send(res, 404, { error: `no result ${body.result}` });
      // Through the same directive check as any other access to this
      // patient's data. Acknowledging a result is reading it — you cannot say
      // what you did about a value you were not allowed to see.
      const block = withheld(row.patient_id, ["Observation"]);
      if (block) {
        audit({
          action: "U",
          outcome: 4,
          resourceType: "Observation",
          patient: row.patient_id,
          detail: `withheld by patient directive ${block.id}`,
        });
        return send(res, 403, {
          error: "this record is withheld by a patient directive",
          breakGlass: "POST /api/clinical/break-glass",
        });
      }
      try {
        const acknowledged = tenant.orders.acknowledge(body.result, {
          actorId: who,
          actorKind: auth.ok ? auth.principal.kind : "unknown",
          action: body.action,
        });
        audit({
          action: "U",
          outcome: 0,
          resourceType: "Observation",
          patient: row.patient_id,
          detail: `result acknowledged: ${body.action}`,
        });
        return send(res, 200, acknowledged);
      } catch (err) {
        const mapped = mapStoreError(err);
        if (mapped.outcome === 8) console.error(`acknowledge: ${mapped.detail}`);
        audit({
          action: "U",
          outcome: mapped.outcome,
          resourceType: "Observation",
          patient: row.patient_id,
          detail: mapped.detail,
        });
        return send(res, mapped.status, { error: mapped.error });
      }
    }
    if (path === "/api/clinical/book" && method === "POST") {
      // A booking is a write about a patient, so it goes through the same
      // directive check as a read of one. SlotFull reaches the caller as 409
      // so they can offer another seat, rather than collapsing into a 400
      // that looks like a malformed body.
      const body = JSON.parse(await readBody(req)) as {
        slot?: string;
        patient?: string;
        reason?: string;
        priority?: "routine" | "urgent" | "stat";
      };
      if (!body.slot || !body.patient || !body.reason) {
        return send(res, 400, { error: "slot, patient and reason required" });
      }
      const who = auth.ok ? auth.principal.id : "unauthenticated";
      return phiFor(body.patient, "Appointment", () =>
        tenant.schedule.book({
          slotId: body.slot!,
          patientId: body.patient!,
          reason: body.reason!,
          by: { actorId: who, actorKind: auth.ok ? auth.principal.kind : "unknown" },
          ...(body.priority ? { priority: body.priority } : {}),
        })
      );
    }
    if (path === "/api/clinical/visits" && method === "GET") {
      // Travelling-clinic visits. No patient appears on a visit — it is a
      // block of capacity, not a disclosure — but it is on the clinical
      // surface so the audit-coverage guarantee holds for it like everything
      // else here.
      return phiFor(
        undefined,
        "Schedule",
        () => tenant.clinics.visits({ service: url.searchParams.get("service") ?? undefined }),
        (rows) => rows.length
      );
    }
    if (path === "/api/clinical/visit-plan" && method === "POST") {
      const body = JSON.parse(await readBody(req)) as {
        resourceId?: string;
        service?: string;
        community?: string;
        days?: Array<{ date: string; from: string; to: string }>;
        slotMinutes?: number;
        capacity?: number;
      };
      if (!body.resourceId || !body.service || !body.community || !body.days || !body.slotMinutes) {
        return send(res, 400, { error: "resourceId, service, community, days and slotMinutes required" });
      }
      const who = auth.ok ? auth.principal.id : "unauthenticated";
      return phiFor(
        undefined,
        "Schedule",
        () =>
          tenant.clinics.planVisit({
            resourceId: body.resourceId!,
            service: body.service!,
            community: body.community!,
            days: body.days!,
            slotMinutes: body.slotMinutes!,
            ...(body.capacity ? { capacity: body.capacity } : {}),
            by: { actorId: who, actorKind: auth.ok ? auth.principal.kind : "unknown" },
          }),
        (v) => v.slots.length
      );
    }
    if (path === "/api/clinical/visit-repeat" && method === "POST") {
      const body = JSON.parse(await readBody(req)) as { visit?: string; firstDay?: string };
      if (!body.visit || !body.firstDay) return send(res, 400, { error: "visit and firstDay required" });
      const who = auth.ok ? auth.principal.id : "unauthenticated";
      return phiFor(
        undefined,
        "Schedule",
        () =>
          tenant.clinics.repeatVisit(body.visit!, {
            firstDay: body.firstDay!,
            by: { actorId: who, actorKind: auth.ok ? auth.principal.kind : "unknown" },
          }),
        (v) => v.slots.length
      );
    }
    if (path === "/api/clinical/visit-cancel" && method === "POST") {
      // The weather case. The response is the phone list — who lost a seat
      // and where they now stand — so it is patient data and is filtered by
      // directive like any other list of patients.
      const body = JSON.parse(await readBody(req)) as { visit?: string; reason?: string };
      if (!body.visit || !body.reason) return send(res, 400, { error: "visit and reason required" });
      const who = auth.ok ? auth.principal.id : "unauthenticated";
      return phiFor(
        undefined,
        "Appointment",
        () => {
          const r = tenant.clinics.cancelVisit(body.visit!, {
            actorId: who,
            actorKind: auth.ok ? auth.principal.kind : "unknown",
            reason: body.reason!,
          });
          const filtered = filterByDirective(
            ["Appointment"],
            r.bumped.map((x) => ({ patient_id: x.booking.patient_id, ...x }))
          );
          return { visit: r.visit, bumped: filtered.rows, withheldCount: filtered.withheldCount };
        },
        (v) => v.bumped.length
      );
    }
    if (path === "/api/clinical/visit-reschedule" && method === "POST") {
      const body = JSON.parse(await readBody(req)) as { visit?: string; toFirstDay?: string; reason?: string };
      if (!body.visit || !body.toFirstDay || !body.reason) {
        return send(res, 400, { error: "visit, toFirstDay and reason required" });
      }
      const who = auth.ok ? auth.principal.id : "unauthenticated";
      return phiFor(
        undefined,
        "Appointment",
        () => {
          const r = tenant.clinics.rescheduleVisit(body.visit!, {
            toFirstDay: body.toFirstDay!,
            reason: body.reason!,
            by: { actorId: who, actorKind: auth.ok ? auth.principal.kind : "unknown" },
          });
          const filtered = filterByDirective(["Appointment"], r.toTell);
          return { visit: r.visit, toTell: filtered.rows, withheldCount: filtered.withheldCount };
        },
        (v) => v.toTell.length
      );
    }
    if (path === "/api/clinical/waitlist" && method === "GET") {
      const service = url.searchParams.get("service");
      if (!service) return send(res, 400, { error: "service required" });
      return phi(
        "Appointment",
        () => filterByDirective(["Appointment"], tenant.clinics.waitlist(service)),
        (r) => r.rows.length
      );
    }
    if (path === "/api/clinical/waitlist-add" && method === "POST") {
      const body = JSON.parse(await readBody(req)) as {
        service?: string;
        patient?: string;
        reason?: string;
        priority?: "routine" | "urgent" | "stat";
        community?: string;
        referral?: string;
      };
      if (!body.service || !body.patient || !body.reason) {
        return send(res, 400, { error: "service, patient and reason required" });
      }
      const who = auth.ok ? auth.principal.id : "unauthenticated";
      return phiFor(body.patient, "Appointment", () =>
        tenant.clinics.addToWaitlist({
          service: body.service!,
          patientId: body.patient!,
          reason: body.reason!,
          by: { actorId: who, actorKind: auth.ok ? auth.principal.kind : "unknown" },
          ...(body.priority ? { priority: body.priority } : {}),
          ...(body.community ? { community: body.community } : {}),
          ...(body.referral ? { referralId: body.referral } : {}),
        })
      );
    }
    if (path === "/api/clinical/waitlist-remove" && method === "POST") {
      const body = JSON.parse(await readBody(req)) as { entry?: string; reason?: string };
      if (!body.entry || !body.reason) return send(res, 400, { error: "entry and reason required" });
      const who = auth.ok ? auth.principal.id : "unauthenticated";
      // The route learns whose record it is touching from the entry, the way
      // the encounter routes do.
      const entry = tenant.clinics.entry(body.entry);
      return phiFor(entry?.patient_id, "Appointment", () =>
        tenant.clinics.removeFromWaitlist(body.entry!, {
          actorId: who,
          actorKind: auth.ok ? auth.principal.kind : "unknown",
          reason: body.reason!,
        })
      );
    }
    if (path === "/api/clinical/offer" && method === "POST") {
      const body = JSON.parse(await readBody(req)) as { entry?: string; slot?: string };
      if (!body.entry || !body.slot) return send(res, 400, { error: "entry and slot required" });
      const who = auth.ok ? auth.principal.id : "unauthenticated";
      const entry = tenant.clinics.entry(body.entry);
      return phiFor(entry?.patient_id, "Appointment", () =>
        tenant.clinics.offerSeat({
          waitlistId: body.entry!,
          slotId: body.slot!,
          by: { actorId: who, actorKind: auth.ok ? auth.principal.kind : "unknown" },
        })
      );
    }
    if (path === "/api/clinical/offer-resolve" && method === "POST") {
      const body = JSON.parse(await readBody(req)) as {
        offer?: string;
        outcome?: "accepted" | "declined" | "unreachable";
        note?: string;
      };
      if (!body.offer || !body.outcome) return send(res, 400, { error: "offer and outcome required" });
      const who = auth.ok ? auth.principal.id : "unauthenticated";
      const existing = tenant.clinics.offer(body.offer);
      const entry = existing ? tenant.clinics.entry(existing.waitlist_id) : undefined;
      return phiFor(entry?.patient_id, "Appointment", () =>
        tenant.clinics.resolveOffer(body.offer!, {
          outcome: body.outcome!,
          by: { actorId: who, actorKind: auth.ok ? auth.principal.kind : "unknown" },
          ...(body.note ? { note: body.note } : {}),
        })
      );
    }
    if (path === "/api/clinical/encounter-open" && method === "POST") {
      // Opening a visit is a write about a patient, so it goes through the
      // same directive check as a read of one. A caller who may not see this
      // patient's record may not start adding to it either.
      const body = JSON.parse(await readBody(req)) as {
        patient?: string;
        class?: string;
        reason?: string;
        location?: string;
        bookingId?: string;
        arrived?: boolean;
      };
      if (!body.patient || !body.class || !body.reason) {
        return send(res, 400, { error: "patient, class and reason required" });
      }
      const who = auth.ok ? auth.principal.id : "unauthenticated";
      return phiFor(body.patient, "Encounter", () =>
        tenant.encounters.open({
          patientId: body.patient!,
          class: body.class as EncounterClass,
          reason: body.reason!,
          by: { actorId: who, actorKind: "practitioner" },
          ...(body.location ? { location: body.location } : {}),
          ...(body.bookingId ? { bookingId: body.bookingId } : {}),
          ...(body.arrived ? { arrived: true } : {}),
        })
      );
    }
    if (
      method === "POST" &&
      (path === "/api/clinical/encounter-arrive" ||
        path === "/api/clinical/encounter-close" ||
        path === "/api/clinical/encounter-cancel")
    ) {
      const body = JSON.parse(await readBody(req)) as { id?: string; disposition?: string; reason?: string };
      if (!body.id) return send(res, 400, { error: "id required" });
      const e = tenant.encounters.get(body.id);
      if (!e) return send(res, 404, { error: `no encounter ${body.id}` });
      const who = auth.ok ? auth.principal.id : "unauthenticated";
      const by = { actorId: who, actorKind: "practitioner" };
      // The store's refusals reach the caller verbatim, because each of them
      // says something a clinician needs to read rather than a validation
      // code: a visit that started cannot be cancelled, and closing one needs
      // a disposition saying what was decided.
      return phiFor(e.patient_id, "Encounter", () => {
        if (path.endsWith("-arrive")) return tenant.encounters.arrive(body.id!, by);
        if (path.endsWith("-close")) {
          return tenant.encounters.close(body.id!, { ...by, disposition: body.disposition ?? "" });
        }
        return tenant.encounters.cancel(body.id!, { ...by, reason: body.reason ?? "" });
      });
    }
    if (path === "/api/clinical/break-glass" && method === "GET") {
      // What breaking glass has cost so far, and what is still owed.
      //
      // The description of this system says an override is safe because it is
      // loud: declared before the access, reasoned in words, the patient told,
      // and queued for review. The first two are enforced in `breakGlass()`.
      // The last two were, until this route, queues nothing could read — the
      // rows accumulated correctly and no operator, privacy officer or patient
      // could see one. A queue nobody can look at is a statistic, and the
      // whole argument for the lockbox being survivable rests on it not being
      // one.
      //
      // Deliberately not behind `phi`, for the same reason `/directives` is
      // not: filtering this by directive would hide overrides taken on exactly
      // the patients whose directives were overridden, which is the one thing
      // this view exists to show. It is admin-scoped and audited instead.
      audit({
        action: "R",
        outcome: 0,
        resourceType: "Consent",
        ...(patient ? { patient } : {}),
        detail: patient ? "break-glass history for a patient" : "break-glass oversight queues",
      });
      return send(
        res,
        200,
        patient
          ? { patient, overrides: tenant.consent.overridesFor(patient) }
          : {
              awaitingNotification: tenant.consent.pendingNotification(),
              awaitingReview: tenant.consent.pendingReview(),
              // What is late, and what could not be sent. The queue on its own
              // has no upper bound on how long a patient can go untold, and a
              // notice that failed to dispatch looks exactly like one nobody
              // has got to yet unless it is separated out here.
              overdueNotification: tenant.consent.overdueNotification(),
              undeliveredNotices: tenant.consent.undeliveredNotices(),
            }
      );
    }
    if (path === "/api/clinical/break-glass-dispatch" && method === "POST") {
      // Retrying a notice that could not be sent — an unreachable channel, a
      // misconfigured destination, a channel removed while the engine ran.
      // Safe to call repeatedly: a notice already dispatched is not sent twice,
      // because telling somebody twice that their record was opened is its own
      // small harm and a retry loop that duplicates disclosures is worse than
      // one that gives up.
      const body = JSON.parse(await readBody(req)) as { override?: string };
      if (!body.override) return send(res, 400, { error: "override required" });
      try {
        const row = tenant.consent.dispatchNotice(body.override);
        audit({
          action: "U",
          outcome: row.notice_dispatched_at ? 0 : 8,
          resourceType: "Consent",
          patient: row.patient_id,
          detail: row.notice_dispatched_at
            ? `break-glass notice dispatched as message ${row.notice_message_id}`
            : `break-glass notice could not be dispatched: ${row.notice_error ?? "no dispatcher configured"}`,
        });
        return send(res, 200, row);
      } catch (err) {
        audit({ action: "U", outcome: 8, resourceType: "Consent", detail: (err as Error).message });
        return send(res, 400, { error: (err as Error).message });
      }
    }
    if (path === "/api/clinical/break-glass-notified" && method === "POST") {
      // Recording that the patient was told. Separate from declaring, because
      // telling them happens on a channel this system does not own — a letter,
      // a phone call, a portal message — and a deployment that pretended
      // otherwise would mark every override notified the instant it was taken.
      const body = JSON.parse(await readBody(req)) as { override?: string };
      if (!body.override) return send(res, 400, { error: "override required" });
      try {
        const row = tenant.consent.notifyPatient(body.override);
        audit({
          action: "U",
          outcome: 0,
          resourceType: "Consent",
          patient: row.patient_id,
          detail: "patient told their record was opened under break-glass",
        });
        return send(res, 200, row);
      } catch (err) {
        audit({ action: "U", outcome: 8, resourceType: "Consent", detail: (err as Error).message });
        return send(res, 400, { error: (err as Error).message });
      }
    }
    if (path === "/api/clinical/break-glass-review" && method === "POST") {
      // Somebody has looked at it and said what they made of it. An override
      // nobody reviews teaches a ward that breaking glass costs nothing, and a
      // directive that costs nothing to break slows down only the people who
      // would have asked first.
      const body = JSON.parse(await readBody(req)) as { override?: string; outcome?: string };
      if (!body.override || !body.outcome) return send(res, 400, { error: "override and outcome required" });
      const who = auth.ok ? auth.principal.id : "unauthenticated";
      try {
        const row = tenant.consent.review(body.override, {
          actorId: who,
          actorKind: auth.ok ? auth.principal.kind : "unknown",
          outcome: body.outcome,
        });
        audit({
          action: "U",
          outcome: 0,
          resourceType: "Consent",
          patient: row.patient_id,
          detail: `break-glass reviewed: ${body.outcome}`,
        });
        return send(res, 200, row);
      } catch (err) {
        audit({ action: "U", outcome: 8, resourceType: "Consent", detail: (err as Error).message });
        return send(res, 400, { error: (err as Error).message });
      }
    }
    if (path === "/api/clinical/break-glass" && method === "POST") {
      const body = JSON.parse(await readBody(req)) as { patient?: string; reason?: string };
      if (!body.patient || !body.reason) return send(res, 400, { error: "patient and reason required" });
      const who = auth.ok ? auth.principal.id : "unauthenticated";
      try {
        const declared = tenant.consent.breakGlass({
          patientId: body.patient,
          by: { actorId: who, actorKind: auth.ok ? auth.principal.kind : "unknown" },
          reason: body.reason,
          ...(auth.ok && auth.principal.purposeOfUse ? { purposeOfUse: auth.principal.purposeOfUse } : {}),
        });
        // Declaring an emergency is itself an event on the trail, before any
        // record is read under it.
        audit({
          action: "E",
          outcome: 0,
          resourceType: "Consent",
          patient: body.patient,
          detail: `break-glass declared: ${body.reason}`,
        });
        return send(res, 201, declared);
      } catch (err) {
        audit({ action: "E", outcome: 8, resourceType: "Consent", patient: body.patient, detail: (err as Error).message });
        return send(res, 400, { error: (err as Error).message });
      }
    }
    if (path === "/api/clinical/directives" && method === "GET") {
      if (!patient) return send(res, 400, { error: "patient required" });
      // Deliberately not behind `phi`: a directive is the patient's own
      // instruction, and refusing to show it to somebody it withholds from
      // would leave them unable to see that a lockbox is what stopped them.
      audit({ action: "R", outcome: 0, resourceType: "Consent", patient });
      return send(res, 200, tenant.consent.directivesFor(patient));
    }
    if (path === "/api/clinical/authorities" && method === "GET") {
      if (!patient) return send(res, 400, { error: "patient required" });
      return phi("Consent", () =>
        tenant.patientAccess.whoCanSee(patient).map((row) => ({
          ...row,
          permissions: tenant.patientAccess.permissionsFor(row),
        }))
      );
    }
    if (path === "/api/clinical/authority-self" && method === "POST") {
      const body = JSON.parse(await readBody(req)) as { patient?: string; subject?: string };
      if (!body.patient || !body.subject) return send(res, 400, { error: "patient and subject required" });
      const who = auth.ok ? auth.principal.id : "unauthenticated";
      return phiFor(body.patient, "Consent", () =>
        tenant.patientAccess.grantSelf(body.patient!, body.subject!, {
          actorId: who,
          actorKind: auth.ok ? auth.principal.kind : "unknown",
        })
      );
    }
    if (path === "/api/clinical/authority-proxy" && method === "POST") {
      const body = JSON.parse(await readBody(req)) as {
        patient?: string;
        subject?: string;
        relationship?: "parent-guardian" | "substitute-decision-maker" | "representative";
        expiresAt?: string;
        permissions?: PatientPermission[];
        purpose?: string;
      };
      if (
        !body.patient ||
        !body.subject ||
        !body.relationship ||
        !body.expiresAt ||
        !body.permissions ||
        !body.purpose
      ) {
        return send(res, 400, {
          error: "patient, subject, relationship, expiresAt, permissions and purpose required",
        });
      }
      const who = auth.ok ? auth.principal.id : "unauthenticated";
      return phiFor(body.patient, "Consent", () =>
        tenant.patientAccess.grantProxy({
          patientId: body.patient!,
          subjectId: body.subject!,
          relationship: body.relationship!,
          expiresAt: body.expiresAt!,
          permissions: body.permissions!,
          purpose: body.purpose!,
          by: { actorId: who, actorKind: auth.ok ? auth.principal.kind : "unknown" },
        })
      );
    }
    if (path === "/api/clinical/authority-revoke" && method === "POST") {
      const body = JSON.parse(await readBody(req)) as { authority?: string; reason?: string };
      if (!body.authority || !body.reason) return send(res, 400, { error: "authority and reason required" });
      const row = tenant.patientAccess.authority(body.authority);
      if (!row) return send(res, 404, { error: `no authority ${body.authority}` });
      const who = auth.ok ? auth.principal.id : "unauthenticated";
      return phiFor(row.patient_id, "Consent", () =>
        tenant.patientAccess.revoke(body.authority!, {
          actorId: who,
          actorKind: auth.ok ? auth.principal.kind : "unknown",
          reason: body.reason!,
        })
      );
    }
    if (path === "/api/clinical/patient-requests" && method === "GET") {
      if (patient) {
        return phi("Task", () => tenant.patientAccess.requestsFor(patient), (rows) => rows.length);
      }
      // The unified task queue remains the cross-patient inbox. This route is
      // the request detail behind those task correlation ids.
      return phi(
        "Task",
        () => {
          const tasks = tenant.tasks.unassigned({ kind: "privacy-request" });
          const requests = tasks
            .map((task) => (task.correlation_id ? tenant.patientAccess.request(task.correlation_id) : undefined))
            .filter((row): row is NonNullable<typeof row> => row !== undefined);
          return filterByDirective(["Task"], requests);
        },
        (r) => r.rows.length
      );
    }
    if (
      method === "POST" &&
      (path === "/api/clinical/patient-request-complete" || path === "/api/clinical/patient-request-decline")
    ) {
      const body = JSON.parse(await readBody(req)) as { request?: string; outcome?: string; reason?: string };
      if (!body.request) return send(res, 400, { error: "request required" });
      const row = tenant.patientAccess.request(body.request);
      if (!row) return send(res, 404, { error: `no patient request ${body.request}` });
      const who = auth.ok ? auth.principal.id : "unauthenticated";
      if (path.endsWith("-complete")) {
        if (!body.outcome) return send(res, 400, { error: "outcome required" });
        return phiFor(row.patient_id, "Task", () =>
          tenant.patientAccess.completeRequest(body.request!, {
            actorId: who,
            actorKind: auth.ok ? auth.principal.kind : "unknown",
            outcome: body.outcome!,
          })
        );
      }
      if (!body.reason) return send(res, 400, { error: "reason required" });
      return phiFor(row.patient_id, "Task", () =>
        tenant.patientAccess.declineRequest(body.request!, {
          actorId: who,
          actorKind: auth.ok ? auth.principal.kind : "unknown",
          reason: body.reason!,
        })
      );
    }
    if (path === "/api/clinical/prescriptions" && method === "GET") {
      if (!patient) return send(res, 400, { error: "patient required" });
      return phi(
        "MedicationRequest",
        () => tenant.prescribing.forPatient(patient),
        (rows) => rows.length
      );
    }
    if (path === "/api/clinical/prescription-chase" && method === "GET") {
      // The three ways a prescription is lost, as lists rather than as
      // silence: written and never sent, sent and never acknowledged, failed
      // and never retried — plus the worst one, cancelled after transmission
      // with nobody having told the pharmacy.
      return phi("MedicationRequest", () => ({
        neverSent: filterByDirective(["MedicationRequest"], tenant.prescribing.neverSent()),
        awaitingAcknowledgement: filterByDirective(
          ["MedicationRequest"],
          tenant.prescribing.awaitingAcknowledgement()
        ),
        failed: filterByDirective(["MedicationRequest"], tenant.prescribing.failed()),
        cancellationsOwed: filterByDirective(["MedicationRequest"], tenant.prescribing.cancellationsOwed()),
      }));
    }
    if (path === "/api/clinical/prescribe" && method === "POST") {
      const body = JSON.parse(await readBody(req)) as {
        statement?: string;
        instructions?: string;
        controlled?: boolean;
      };
      if (!body.statement || !body.instructions) {
        return send(res, 400, { error: "statement and instructions required" });
      }
      const statement = tenant.meds.statement(body.statement);
      if (!statement) return send(res, 404, { error: `no medication statement ${body.statement}` });
      const who = auth.ok ? auth.principal.id : "unauthenticated";
      return phiFor(statement.patient_id, "MedicationRequest", () =>
        tenant.prescribing.write({
          statementId: body.statement!,
          instructions: body.instructions!,
          by: { actorId: who, actorKind: auth.ok ? auth.principal.kind : "unknown" },
          ...(body.controlled ? { controlled: true } : {}),
        })
      );
    }
    if (
      method === "POST" &&
      (path === "/api/clinical/prescription-transmit" ||
        path === "/api/clinical/prescription-handout" ||
        path === "/api/clinical/prescription-acknowledge" ||
        path === "/api/clinical/prescription-fail" ||
        path === "/api/clinical/prescription-replace" ||
        path === "/api/clinical/prescription-cancel" ||
        path === "/api/clinical/prescription-cancel-confirm")
    ) {
      const body = JSON.parse(await readBody(req)) as {
        prescription?: string;
        pharmacy?: string;
        reason?: string;
        detail?: string;
      };
      if (!body.prescription) return send(res, 400, { error: "prescription required" });
      const row = tenant.prescribing.get(body.prescription);
      if (!row) return send(res, 404, { error: `no prescription ${body.prescription}` });
      const who = auth.ok ? auth.principal.id : "unauthenticated";
      const by = { actorId: who, actorKind: auth.ok ? auth.principal.kind : "unknown" };
      const id = body.prescription;
      const { pharmacy, reason, detail } = body;
      return phiFor(row.patient_id, "MedicationRequest", () => {
        if (path.endsWith("-transmit")) {
          if (!pharmacy) refuse("pharmacy required");
          return tenant.prescribing.transmit(id, pharmacy, by);
        }
        if (path.endsWith("-handout")) {
          return tenant.prescribing.handOut(id, { ...by, ...(reason ? { reason } : {}) });
        }
        if (path.endsWith("-acknowledge")) {
          return tenant.prescribing.acknowledge(id, { ...by, ...(detail ? { detail } : {}) });
        }
        if (path.endsWith("-fail")) {
          if (!reason) refuse("reason required");
          return tenant.prescribing.fail(id, { ...by, reason });
        }
        if (path.endsWith("-replace")) {
          if (!reason) refuse("reason required");
          return tenant.prescribing.replaceFailed(id, { ...by, reason });
        }
        if (path.endsWith("-cancel-confirm")) {
          if (!detail) refuse("detail required: how was the pharmacy told");
          return tenant.prescribing.confirmCancellation(id, { ...by, detail });
        }
        if (!reason) refuse("reason required");
        return tenant.prescribing.cancel(id, { ...by, reason });
      });
    }
    // Migration lives under /api/clinical/ rather than a taxonomy of its own,
    // because it reads and writes patient data in bulk. That puts it behind
    // phi() and inside the source-reading test that drives every clinical
    // route and fails the build if one serves patient data without an audit
    // row — which is a stronger guarantee than a tidier URL.
    if (path === "/api/clinical/migrations" && method === "GET") {
      return phi("Bundle", () => tenant.migration.runs(), (rows) => rows.length);
    }
    if (
      method === "GET" &&
      (path === "/api/clinical/migration-report" ||
        path === "/api/clinical/migration-rejects" ||
        path === "/api/clinical/migration-sample")
    ) {
      const run = url.searchParams.get("run");
      if (!run) return send(res, 400, { error: "run required" });
      if (!tenant.migration.run(run)) return send(res, 404, { error: `no migration run ${run}` });
      return phi("Bundle", () => {
        if (path.endsWith("-report")) return tenant.migration.report(run);
        if (path.endsWith("-rejects")) return tenant.migration.rejects(run);
        return tenant.migration.validationSample(run, num(url.searchParams.get("per_type")) ?? 5);
      });
    }
    if (path === "/api/clinical/migration-begin" && method === "POST") {
      const body = JSON.parse(await readBody(req)) as {
        source?: string;
        mode?: "trial" | "cutover" | "delta";
        follows?: string;
        notes?: string;
      };
      if (!body.source || !body.mode) return send(res, 400, { error: "source and mode required" });
      const who = auth.ok ? auth.principal.id : "unauthenticated";
      return phi("Bundle", () =>
        tenant.migration.begin({
          sourceSystem: body.source!,
          mode: body.mode!,
          by: { actorId: who },
          ...(body.follows ? { follows: body.follows } : {}),
          ...(body.notes ? { notes: body.notes } : {}),
        })
      );
    }
    if (path === "/api/clinical/migration-declare" && method === "POST") {
      // The load-bearing call: without a declared source count the report can
      // say what arrived and cannot say whether that was all of it.
      const body = JSON.parse(await readBody(req)) as {
        run?: string;
        recordType?: MigrationRecordType;
        sourceCount?: number;
      };
      if (!body.run || !body.recordType || typeof body.sourceCount !== "number") {
        return send(res, 400, { error: "run, recordType and sourceCount required" });
      }
      const who = auth.ok ? auth.principal.id : "unauthenticated";
      return phi("Bundle", () =>
        tenant.migration.declare(body.run!, body.recordType!, body.sourceCount!, { actorId: who })
      );
    }
    if (path === "/api/clinical/migration-load" && method === "POST") {
      const body = JSON.parse(await readBody(req)) as { run?: string; records?: SourceRecord[] };
      if (!body.run || !Array.isArray(body.records)) {
        return send(res, 400, { error: "run and records required" });
      }
      const who = auth.ok ? auth.principal.id : "unauthenticated";
      return phi(
        "Bundle",
        () => tenant.migration.loadAll(body.run!, body.records!, { actorId: who }),
        (rows) => rows.length
      );
    }
    if (path === "/api/clinical/migration-complete" && method === "POST") {
      const body = JSON.parse(await readBody(req)) as { run?: string; acceptGapsBecause?: string };
      if (!body.run) return send(res, 400, { error: "run required" });
      const who = auth.ok ? auth.principal.id : "unauthenticated";
      return phi("Bundle", () =>
        tenant.migration.complete(body.run!, {
          actorId: who,
          ...(body.acceptGapsBecause ? { acceptGapsBecause: body.acceptGapsBecause } : {}),
        })
      );
    }
    if (path === "/api/clinical/migration-rollback" && method === "POST") {
      const body = JSON.parse(await readBody(req)) as { run?: string; reason?: string };
      if (!body.run || !body.reason) return send(res, 400, { error: "run and reason required" });
      const who = auth.ok ? auth.principal.id : "unauthenticated";
      return phi("Bundle", () => tenant.migration.rollback(body.run!, { actorId: who, reason: body.reason! }));
    }
    if (path === "/api/clinical/lab-held" && method === "GET") {
      // Results the interface could not attribute to a chart. Spans patients
      // by definition — nobody knows whose they are yet — so it is audited as
      // a read of laboratory data rather than of one patient's record.
      return phi("DiagnosticReport", () => tenant.labIntake.heldForIdentity(), (rows) => rows.length);
    }
    if (path === "/api/clinical/lab-reconcile" && method === "GET") {
      return phi("DiagnosticReport", () =>
        tenant.labIntake.reconcile({
          ...(url.searchParams.get("since") ? { since: url.searchParams.get("since")! } : {}),
          ...(url.searchParams.get("profile") ? { profileId: url.searchParams.get("profile")! } : {}),
        })
      );
    }
    if (path === "/api/clinical/lab-resolve" && method === "POST") {
      // A person names the chart. The message is then filed through exactly
      // the same path as one that arrived identified, so deduplication,
      // correction and order matching all still apply.
      const body = JSON.parse(await readBody(req)) as { hold?: string; patient?: string };
      if (!body.hold || !body.patient) return send(res, 400, { error: "hold and patient required" });
      const who = auth.ok ? auth.principal.id : "unauthenticated";
      return phiFor(body.patient, "DiagnosticReport", () =>
        tenant.labIntake.resolveIdentity(body.hold!, body.patient!, { actorId: who })
      );
    }
    if (path === "/api/clinical/gaps" && method === "POST") {
      // A cohort definition and a gap rule come in the body because they are
      // structured, not because this writes anything: it reads a population.
      const body = JSON.parse(await readBody(req)) as { cohort?: unknown; gap?: unknown; asOf?: string };
      if (!body.cohort || !body.gap) return send(res, 400, { error: "cohort and gap required" });
      audit({ action: "R", outcome: 0, resourceType: "MeasureReport", detail: "care gap query" });
      return send(res, 200, tenant.registry.gaps(body.cohort as never, body.gap as never, body.asOf));
    }
    if (path === "/api/clinical/measure" && method === "POST") {
      const body = JSON.parse(await readBody(req)) as { cohort?: unknown; measure?: unknown; asOf?: string };
      if (!body.cohort || !body.measure) return send(res, 400, { error: "cohort and measure required" });
      audit({ action: "R", outcome: 0, resourceType: "MeasureReport", detail: "quality measure" });
      return send(res, 200, tenant.registry.measure(body.cohort as never, body.measure as never, body.asOf));
    }
    if (path === "/api/clinical/safety-check" && method === "POST") {
      const body = JSON.parse(await readBody(req)) as { patient?: string; ingredient?: string; display?: string };
      if (!body.patient || !body.ingredient) return send(res, 400, { error: "patient and ingredient required" });
      const p = body.patient;
      const ingredient = body.ingredient;
      const display = body.display ?? body.ingredient;
      // A link asserts one person, so the check consults every member — a
      // penicillin allergy documented on the linked chart has to fire here,
      // or the assembled chart shows an allergy the safety check calls
      // clear. And consent composes into the check exactly as it composes
      // into that chart, member by member and section by section, the named
      // patient included: a check that read what the chart refuses this
      // caller would be a side door through the lockbox, and an
      // ingredient-by-ingredient oracle over the withheld allergy list
      // besides. Fail closed, say so in a blocking finding, break glass to
      // lift — never silence, in either direction.
      const own = restrictions(p);
      if (own.blocking && !own.underBreakGlass) {
        audit({
          action: "R",
          outcome: 4,
          resourceType: "AllergyIntolerance",
          patient: p,
          detail: `safety check refused: withheld by patient directive ${own.blocking.id}`,
        });
        return send(res, 403, { error: "this record is withheld by a patient directive", breakGlass: "POST /api/clinical/break-glass" });
      }
      const members = tenant.links.membersOf(p);
      const allergyCharts: string[] = [];
      const medicationCharts: string[] = [];
      let blockedMembers = 0;
      let allergiesLocked = 0;
      let medicationsLocked = 0;
      for (const member of members) {
        const r = member === p ? own : restrictions(member);
        if (member !== p && r.blocking && !r.underBreakGlass) {
          blockedMembers += 1;
          continue;
        }
        if (r.withheldTypes.has("AllergyIntolerance")) allergiesLocked += 1;
        else allergyCharts.push(member);
        if (r.withheldTypes.has("MedicationStatement")) medicationsLocked += 1;
        else medicationCharts.push(member);
      }
      // The named patient is audited on every answer — even one the
      // directives emptied. The route still answered a clinical question
      // about them, and a 200 with no row is exactly the silent read H-29
      // exists to refuse. Sections a directive kept out are recorded the way
      // phi() records them: types only, never content. Linked members are
      // audited only when a section of theirs was actually read — a chart a
      // directive kept out entirely was not read, and stays off the trail.
      const consulted = [...new Set([...allergyCharts, ...medicationCharts])].sort();
      const ownLocked = [
        ...(allergyCharts.includes(p) ? [] : ["AllergyIntolerance"]),
        ...(medicationCharts.includes(p) ? [] : ["MedicationStatement"]),
      ];
      audit({
        action: "R",
        outcome: 0,
        resourceType: "AllergyIntolerance",
        patient: p,
        detail:
          `safety check: ${ingredient}` +
          (ownLocked.length ? `; withheld by patient directive: ${ownLocked.join(", ")}` : ""),
      });
      for (const member of consulted) {
        if (member === p) continue;
        audit({
          action: "R",
          outcome: 0,
          resourceType: "AllergyIntolerance",
          patient: member,
          detail: `safety check for linked chart ${p}: ${ingredient}`,
        });
      }
      const result = tenant.meds.check(p, { ingredient, display }, { allergyCharts, medicationCharts });
      if (members.length > 1) result.across = consulted;
      const gaps: string[] = [];
      if (blockedMembers > 0) gaps.push(`${blockedMembers} linked chart${blockedMembers === 1 ? "" : "s"}`);
      // When no allergy chart was consultable at all, check() already
      // answered `withheld` and assess() carries the finding; the fragment
      // here covers the partial case, where some members' lists were read
      // and a directive kept others out.
      if (allergiesLocked > 0 && allergyCharts.length > 0) {
        gaps.push(`the allergy list on ${allergiesLocked} chart${allergiesLocked === 1 ? "" : "s"}`);
      }
      if (medicationsLocked > 0) {
        gaps.push(`the medication list on ${medicationsLocked} chart${medicationsLocked === 1 ? "" : "s"}`);
      }
      if (gaps.length > 0) {
        const finding: Finding = {
          kind: "withheld-by-directive",
          severity: "severe",
          message: `${gaps.join(", ")} withheld by a patient directive and not consulted; the check is incomplete`,
        };
        result.findings.push(finding);
        result.blocking.push(finding);
        result.clear = false;
      }
      return send(res, 200, result);
    }
    if (path === "/api/clinical/immunization-record" && method === "POST") {
      const body = JSON.parse(await readBody(req)) as {
        patient?: string;
        vaccine?: string;
        occurrenceAt?: string;
        status?: "given" | "refused" | "not-done";
        vaccineCode?: string;
        vaccineSystem?: string;
        lot?: string;
        site?: string;
        doseNumber?: number;
        reason?: string;
        encounter?: string;
      };
      if (!body.patient || !body.vaccine || !body.occurrenceAt) {
        return send(res, 400, { error: "patient, vaccine and occurrenceAt required" });
      }
      const who = auth.ok ? auth.principal.id : "unauthenticated";
      return phiFor(body.patient, "Immunization", () =>
        tenant.immunizations.record({
          patientId: body.patient!,
          vaccine: body.vaccine!,
          occurrenceAt: body.occurrenceAt!,
          by: { authorId: who, authorKind: auth.ok ? auth.principal.kind : "unknown" },
          ...(body.status ? { status: body.status } : {}),
          ...(body.vaccineCode ? { vaccineCode: body.vaccineCode } : {}),
          ...(body.vaccineSystem ? { vaccineSystem: body.vaccineSystem } : {}),
          ...(body.lot ? { lot: body.lot } : {}),
          ...(body.site ? { site: body.site } : {}),
          ...(body.doseNumber !== undefined ? { doseNumber: body.doseNumber } : {}),
          ...(body.reason ? { reason: body.reason } : {}),
          ...(body.encounter ? { encounterId: body.encounter } : {}),
        })
      );
    }
    if (path === "/api/clinical/vital-record" && method === "POST") {
      const body = JSON.parse(await readBody(req)) as {
        patient?: string;
        kind?: "blood-pressure" | "heart-rate" | "temperature" | "oxygen-saturation" | "body-weight" | "body-height" | "respiratory-rate" | "pain-score";
        takenAt?: string;
        value?: number;
        unit?: string;
        systolic?: number;
        diastolic?: number;
        encounter?: string;
      };
      if (!body.patient || !body.kind || !body.takenAt) {
        return send(res, 400, { error: "patient, kind and takenAt required" });
      }
      const who = auth.ok ? auth.principal.id : "unauthenticated";
      return phiFor(body.patient, "Observation", () =>
        tenant.vitals.record({
          patientId: body.patient!,
          kind: body.kind!,
          takenAt: body.takenAt!,
          by: { authorId: who, authorKind: auth.ok ? auth.principal.kind : "unknown" },
          ...(body.value !== undefined ? { value: body.value } : {}),
          ...(body.unit ? { unit: body.unit } : {}),
          ...(body.systolic !== undefined ? { systolic: body.systolic } : {}),
          ...(body.diastolic !== undefined ? { diastolic: body.diastolic } : {}),
          ...(body.encounter ? { encounterId: body.encounter } : {}),
        })
      );
    }
    if (path === "/api/clinical/care-team-assign" && method === "POST") {
      const body = JSON.parse(await readBody(req)) as {
        patient?: string;
        practitioner?: string;
        role?: "primary" | "covering" | "consultant" | "allied" | "other";
        organization?: string;
      };
      if (!body.patient || !body.practitioner || !body.role) {
        return send(res, 400, { error: "patient, practitioner and role required" });
      }
      const who = auth.ok ? auth.principal.id : "unauthenticated";
      return phiFor(body.patient, "CareTeam", () =>
        tenant.careTeam.assign({
          patientId: body.patient!,
          practitionerId: body.practitioner!,
          role: body.role!,
          by: { actorId: who },
          ...(body.organization ? { organizationId: body.organization } : {}),
        })
      );
    }
    if (path === "/api/clinical/care-team-retire" && method === "POST") {
      const body = JSON.parse(await readBody(req)) as { id?: string };
      if (!body.id) return send(res, 400, { error: "id required" });
      const row = tenant.careTeam.get(body.id);
      if (!row) return send(res, 404, { error: `no care-team membership ${body.id}` });
      return phiFor(row.patient_id, "CareTeam", () => tenant.careTeam.retire(body.id!));
    }
    if (path === "/api/clinical/coverage-record" && method === "POST") {
      const body = JSON.parse(await readBody(req)) as {
        patient?: string;
        plan?: string;
        eligibility?: "eligible" | "ineligible" | "pending" | "unknown";
        identifierSystem?: string;
        identifierValue?: string;
        detail?: string;
        effectiveFrom?: string;
        effectiveTo?: string;
      };
      if (!body.patient || !body.plan || !body.eligibility) {
        return send(res, 400, { error: "patient, plan and eligibility required" });
      }
      const who = auth.ok ? auth.principal.id : "unauthenticated";
      return phiFor(body.patient, "Coverage", () =>
        tenant.coverage.record({
          patientId: body.patient!,
          plan: body.plan!,
          eligibility: body.eligibility!,
          by: { actorId: who },
          ...(body.identifierSystem ? { identifierSystem: body.identifierSystem } : {}),
          ...(body.identifierValue ? { identifierValue: body.identifierValue } : {}),
          ...(body.detail ? { detail: body.detail } : {}),
          ...(body.effectiveFrom ? { effectiveFrom: body.effectiveFrom } : {}),
          ...(body.effectiveTo ? { effectiveTo: body.effectiveTo } : {}),
        })
      );
    }
    if (path === "/api/clinical/thread-open" && method === "POST") {
      const body = JSON.parse(await readBody(req)) as {
        patient?: string;
        subject?: string;
        body?: string;
        authorKind?: "patient" | "proxy" | "practitioner" | "clerk";
        priority?: "routine" | "urgent" | "stat";
        owner?: string;
      };
      if (!body.patient || !body.subject || !body.body || !body.authorKind) {
        return send(res, 400, { error: "patient, subject, body and authorKind required" });
      }
      const who = auth.ok ? auth.principal.id : "unauthenticated";
      return phiFor(body.patient, "Communication", () =>
        tenant.messaging.open({
          patientId: body.patient!,
          subject: body.subject!,
          body: body.body!,
          authorKind: body.authorKind!,
          by: { actorId: who, actorKind: auth.ok ? auth.principal.kind : "unknown" },
          ...(body.priority ? { priority: body.priority } : {}),
          ...(body.owner ? { ownerId: body.owner } : {}),
        })
      );
    }
    if (path === "/api/clinical/thread-reply" && method === "POST") {
      const body = JSON.parse(await readBody(req)) as {
        id?: string;
        body?: string;
        authorKind?: "patient" | "proxy" | "practitioner" | "clerk";
      };
      if (!body.id || !body.body || !body.authorKind) {
        return send(res, 400, { error: "id, body and authorKind required" });
      }
      const thread = tenant.messaging.get(body.id);
      if (!thread) return send(res, 404, { error: `no message thread ${body.id}` });
      const who = auth.ok ? auth.principal.id : "unauthenticated";
      return phiFor(thread.patient_id, "Communication", () =>
        tenant.messaging.reply(body.id!, {
          body: body.body!,
          authorKind: body.authorKind!,
          by: { actorId: who, actorKind: auth.ok ? auth.principal.kind : "unknown" },
        })
      );
    }
    if (path === "/api/clinical/thread-close" && method === "POST") {
      const body = JSON.parse(await readBody(req)) as { id?: string; reason?: string };
      if (!body.id || !body.reason) return send(res, 400, { error: "id and reason required" });
      const thread = tenant.messaging.get(body.id);
      if (!thread) return send(res, 404, { error: `no message thread ${body.id}` });
      const who = auth.ok ? auth.principal.id : "unauthenticated";
      return phiFor(thread.patient_id, "Communication", () =>
        tenant.messaging.close(body.id!, {
          actorId: who,
          actorKind: auth.ok ? auth.principal.kind : "unknown",
          reason: body.reason!,
        })
      );
    }
    if (path === "/api/clinical/thread-reopen" && method === "POST") {
      const body = JSON.parse(await readBody(req)) as { id?: string; reason?: string };
      if (!body.id || !body.reason) return send(res, 400, { error: "id and reason required" });
      const thread = tenant.messaging.get(body.id);
      if (!thread) return send(res, 404, { error: `no message thread ${body.id}` });
      const who = auth.ok ? auth.principal.id : "unauthenticated";
      return phiFor(thread.patient_id, "Communication", () =>
        tenant.messaging.reopen(body.id!, {
          actorId: who,
          actorKind: auth.ok ? auth.principal.kind : "unknown",
          reason: body.reason!,
        })
      );
    }
    if (path === "/api/clinical/thread-assign" && method === "POST") {
      const body = JSON.parse(await readBody(req)) as { id?: string; owner?: string; reason?: string };
      if (!body.id || !body.owner || !body.reason) {
        return send(res, 400, { error: "id, owner and reason required" });
      }
      const thread = tenant.messaging.get(body.id);
      if (!thread) return send(res, 404, { error: `no message thread ${body.id}` });
      const who = auth.ok ? auth.principal.id : "unauthenticated";
      return phiFor(thread.patient_id, "Communication", () =>
        tenant.messaging.assign(body.id!, body.owner!, {
          actorId: who,
          actorKind: auth.ok ? auth.principal.kind : "unknown",
          reason: body.reason!,
        })
      );
    }

    // Privacy office. Lockboxes are not applied: the office cannot be hidden
    // from the record it is charged with reviewing. HTTP still audits once.
    if (path === "/api/clinical/privacy-inbox" && method === "GET") {
      return phiOffice("Bundle", () => tenant.privacy.inbox());
    }
    if (path === "/api/clinical/privacy-reviews" && method === "GET") {
      return phiOffice("Bundle", () => tenant.privacy.listReviews(), (rows) => rows.length);
    }
    if (path === "/api/clinical/privacy-review" && method === "GET") {
      const id = url.searchParams.get("id");
      if (!id) return send(res, 400, { error: "id required" });
      return phiOffice("Bundle", () => tenant.privacy.getReview(id));
    }
    if (path === "/api/clinical/privacy-review-open" && method === "POST") {
      await readBody(req);
      return phiOffice("Bundle", () => tenant.privacy.openReview(officeActor()));
    }
    if (path === "/api/clinical/privacy-review-address" && method === "POST") {
      const body = JSON.parse(await readBody(req)) as {
        flag?: string;
        status?: "accepted" | "escalated";
        reason?: string;
      };
      if (!body.flag || !body.status || !body.reason) {
        return send(res, 400, { error: "flag, status and reason required" });
      }
      return phiOffice("Bundle", () =>
        tenant.privacy.addressFlag(body.flag!, { status: body.status!, reason: body.reason! }, officeActor())
      );
    }
    if (path === "/api/clinical/privacy-review-close" && method === "POST") {
      const body = JSON.parse(await readBody(req)) as { id?: string; conclusion?: string };
      if (!body.id || !body.conclusion) return send(res, 400, { error: "id and conclusion required" });
      return phiOffice("Bundle", () => tenant.privacy.closeReview(body.id!, { conclusion: body.conclusion! }, officeActor()));
    }
    if (path === "/api/clinical/legal-holds" && method === "GET") {
      return phiOffice("Bundle", () => tenant.privacy.listHolds(), (rows) => rows.length);
    }
    if (path === "/api/clinical/legal-hold" && method === "GET") {
      const id = url.searchParams.get("id");
      if (!id) return send(res, 400, { error: "id required" });
      return phiOffice("Bundle", () => tenant.privacy.getHold(id));
    }
    if (path === "/api/clinical/legal-hold-place" && method === "POST") {
      const body = JSON.parse(await readBody(req)) as { patientId?: string; reason?: string };
      if (!body.reason) return send(res, 400, { error: "reason required" });
      return phiOffice("Bundle", () =>
        tenant.privacy.placeHold({ reason: body.reason!, ...(body.patientId ? { patientId: body.patientId } : {}) }, officeActor())
      );
    }
    if (path === "/api/clinical/legal-hold-release" && method === "POST") {
      const body = JSON.parse(await readBody(req)) as { id?: string; reason?: string };
      if (!body.id || !body.reason) return send(res, 400, { error: "id and reason required" });
      return phiOffice("Bundle", () => tenant.privacy.releaseHold(body.id!, { reason: body.reason! }, officeActor()));
    }
    if (path === "/api/clinical/privacy-incidents" && method === "GET") {
      return phiOffice("Bundle", () => tenant.privacy.listIncidents(), (rows) => rows.length);
    }
    if (path === "/api/clinical/privacy-incident" && method === "GET") {
      const id = url.searchParams.get("id");
      if (!id) return send(res, 400, { error: "id required" });
      return phiOffice("Bundle", () => tenant.privacy.getIncident(id));
    }
    if (path === "/api/clinical/privacy-incident-open" && method === "POST") {
      await readBody(req);
      return phiOffice("Bundle", () => tenant.privacy.openIncident(officeActor()));
    }
    if (path === "/api/clinical/privacy-incident-close" && method === "POST") {
      const body = JSON.parse(await readBody(req)) as {
        id?: string;
        whatHappened?: string;
        affectedPatients?: string[];
        noneAffected?: boolean;
        notification?: "told" | "not-told";
        notificationReason?: string;
      };
      if (!body.id || !body.whatHappened || !body.notification) {
        return send(res, 400, { error: "id, whatHappened and notification required" });
      }
      return phiOffice("Bundle", () =>
        tenant.privacy.closeIncident(
          body.id!,
          {
            whatHappened: body.whatHappened!,
            notification: body.notification!,
            ...(body.affectedPatients ? { affectedPatients: body.affectedPatients } : {}),
            ...(body.noneAffected !== undefined ? { noneAffected: body.noneAffected } : {}),
            ...(body.notificationReason ? { notificationReason: body.notificationReason } : {}),
          },
          officeActor()
        )
      );
    }
    if (path === "/api/clinical/disclosures" && method === "GET") {
      return phiOffice("Bundle", () => tenant.privacy.listDisclosures(), (rows) => rows.length);
    }
    if (path === "/api/clinical/disclosure" && method === "GET") {
      const id = url.searchParams.get("id");
      if (!id) return send(res, 400, { error: "id required" });
      return phiOffice("Bundle", () => tenant.privacy.getDisclosure(id));
    }
    if (path === "/api/clinical/privacy-fulfill" && method === "POST") {
      const body = JSON.parse(await readBody(req)) as {
        request?: string;
        sections?: { name: string; count: number }[];
        purpose?: string;
      };
      if (!body.request || !Array.isArray(body.sections)) {
        return send(res, 400, { error: "request and sections required" });
      }
      return phiOffice("Bundle", () =>
        tenant.privacy.fulfillAccess(
          body.request!,
          { sections: body.sections!, ...(body.purpose ? { purpose: body.purpose } : {}) },
          officeActor()
        )
      );
    }
    if (path === "/api/clinical/privacy-deadline" && method === "POST") {
      const body = JSON.parse(await readBody(req)) as { request?: string; until?: string; reason?: string };
      if (!body.request || !body.until || !body.reason) {
        return send(res, 400, { error: "request, until and reason required" });
      }
      return phiOffice("Bundle", () => {
        tenant.privacy.extendDeadline(body.request!, { until: body.until!, reason: body.reason! }, officeActor());
        return { request: body.request, until: body.until };
      });
    }
    if (path === "/api/clinical/assurance" && method === "GET") {
      return phiOffice("Bundle", () => ({
        catalogue: tenant.privacy.catalogue(),
        findings: tenant.privacy.listFindings(),
        exercises: tenant.privacy.listExercises(),
      }));
    }
    if (path === "/api/clinical/assurance-finding" && method === "GET") {
      const id = url.searchParams.get("id");
      if (!id) return send(res, 400, { error: "id required" });
      return phiOffice("Bundle", () => tenant.privacy.getFinding(id));
    }
    if (path === "/api/clinical/assurance-finding-close" && method === "POST") {
      const body = JSON.parse(await readBody(req)) as {
        id?: string;
        remediation?: string;
        residualRisk?: string;
      };
      if (!body.id) return send(res, 400, { error: "id required" });
      return phiOffice("Bundle", () =>
        tenant.privacy.closeFinding(
          body.id!,
          {
            ...(body.remediation ? { remediation: body.remediation } : {}),
            ...(body.residualRisk ? { residualRisk: body.residualRisk } : {}),
          },
          officeActor()
        )
      );
    }
    if (path === "/api/clinical/assurance-exercise" && method === "GET") {
      const id = url.searchParams.get("id");
      if (!id) return send(res, 400, { error: "id required" });
      return phiOffice("Bundle", () => tenant.privacy.getExercise(id));
    }
    if (path === "/api/clinical/assurance-exercise-close" && method === "POST") {
      const body = JSON.parse(await readBody(req)) as {
        id?: string;
        rtoSeconds?: number;
        outcome?: "passed" | "failed";
        notes?: string;
      };
      if (!body.id || body.rtoSeconds === undefined || !body.outcome) {
        return send(res, 400, { error: "id, rtoSeconds and outcome required" });
      }
      return phiOffice("Bundle", () =>
        tenant.privacy.closeExercise(
          body.id!,
          { rtoSeconds: body.rtoSeconds!, outcome: body.outcome!, ...(body.notes ? { notes: body.notes } : {}) },
          officeActor()
        )
      );
    }
    if (path === "/api/clinical/subprocessors" && method === "GET") {
      return phiOffice("Bundle", () => tenant.privacy.listSubprocessors(), (rows) => rows.length);
    }
    if (path === "/api/clinical/subprocessor" && method === "GET") {
      const id = url.searchParams.get("id");
      if (!id) return send(res, 400, { error: "id required" });
      return phiOffice("Bundle", () => tenant.privacy.getSubprocessor(id));
    }
    if (path === "/api/clinical/subprocessor" && method === "POST") {
      const body = JSON.parse(await readBody(req)) as {
        id?: string;
        name?: string;
        purpose?: string;
        region?: string;
        status?: "candidate" | "active" | "inactive";
      };
      if (!body.name || !body.purpose || !body.status) {
        return send(res, 400, { error: "name, purpose and status required" });
      }
      return phiOffice("Bundle", () =>
        tenant.privacy.upsertSubprocessor(
          {
            name: body.name!,
            purpose: body.purpose!,
            status: body.status!,
            ...(body.id ? { id: body.id } : {}),
            ...(body.region ? { region: body.region } : {}),
          },
          officeActor()
        )
      );
    }
    return send(res, 404, { error: "not found" });
  }

  if (path === "/api/keys" && method === "GET") {
    return send(res, 200, keys.list());
  }
  if (path === "/api/keys/review" && method === "GET") {
    // The two questions worth asking about a set of credentials, and neither
    // is answerable by looking at a list of them: which have nobody using
    // them, and which are about to stop working. Both are lists somebody acts
    // on rather than numbers on a dashboard.
    return send(res, 200, {
      dormantAfterDays: num(url.searchParams.get("dormant_days")) ?? 90,
      dormant: keys.dormant(num(url.searchParams.get("dormant_days")) ?? 90),
      expiringWithinDays: num(url.searchParams.get("expiring_days")) ?? 14,
      expiring: keys.expiring(num(url.searchParams.get("expiring_days")) ?? 14),
    });
  }
  if (path.startsWith("/api/keys/") && path.endsWith("/rotate") && method === "POST") {
    const id = path.slice("/api/keys/".length, -"/rotate".length);
    const body = JSON.parse((await readBody(req)) || "{}") as { overlapDays?: number; expiresAt?: string };
    try {
      const next = keys.rotate(id, body);
      audit({ action: "U", outcome: 0, resourceType: "Device", resourceId: id, detail: `rotated to ${next.id}` });
      // The replacement key is shown once, here, exactly as a new one is.
      return send(res, 201, next);
    } catch (err) {
      audit({ action: "U", outcome: 8, resourceType: "Device", resourceId: id, detail: (err as Error).message });
      return send(res, 400, { error: (err as Error).message });
    }
  }
  if (path === "/api/keys" && method === "POST") {
    const body = JSON.parse(await readBody(req)) as {
      name?: string;
      scopes?: string[];
      expiresAt?: string;
      organizationId?: string;
      practitionerId?: string;
    };
    if (!body.name) return send(res, 400, { error: "name required" });
    try {
      // The plaintext key appears in this response and nowhere else, ever.
      const issued = keys.issue(body.name, body.scopes, {
        ...(body.expiresAt ? { expiresAt: body.expiresAt } : {}),
        // Checked against the directory inside `issue()`, so a credential
        // either names an organization that exists or names none at all.
        ...(body.organizationId ? { organizationId: body.organizationId } : {}),
        // Likewise checked: a credential acting as a practitioner nobody has
        // registered would stamp an unresolvable name on every row it produces.
        ...(body.practitionerId ? { practitionerId: body.practitionerId } : {}),
      });
      audit({
        action: "C",
        resourceType: "ApiKey",
        resourceId: issued.id,
        detail:
          `scopes: ${issued.scopes.join(" ")}` +
          (issued.organizationId ? `; organization: ${issued.organizationId}` : "; no organization") +
          (issued.practitionerId ? `; practitioner: ${issued.practitionerId}` : ""),
      });
      return send(res, 201, issued);
    } catch (err) {
      return send(res, 400, { error: err instanceof Error ? err.message : "cannot issue key" });
    }
  }
  m = /^\/api\/keys\/([0-9a-f-]+)$/.exec(path);
  if (m && method === "DELETE") {
    const revoked = keys.revoke(m[1]);
    audit({ action: "D", resourceType: "ApiKey", resourceId: m[1], outcome: revoked ? 0 : 4 });
    return revoked ? send(res, 200, { ok: true }) : send(res, 404, { error: "unknown or already revoked" });
  }

  if (method === "GET" && path === "/api/terminology/lookup") {
    const system = url.searchParams.get("system") ?? "";
    const code = url.searchParams.get("code") ?? "";
    const hit = engine.terminology.lookup(system, code);
    return hit ? send(res, 200, hit) : send(res, 404, { error: "code not found" });
  }
  if (method === "GET" && path === "/api/terminology/expand") {
    return send(res, 200, engine.terminology.expand(url.searchParams.get("valueset") ?? ""));
  }
  if (method === "GET" && path === "/api/terminology/translate") {
    return send(res, 200, {
      matches: engine.terminology.translate({
        code: url.searchParams.get("code") ?? "",
        system: url.searchParams.get("system") ?? undefined,
        map: url.searchParams.get("map") ?? undefined,
        targetSystem: url.searchParams.get("target") ?? undefined,
      }),
    });
  }
  if (method === "GET" && path === "/api/terminology/stats") {
    return send(res, 200, engine.terminology.stats());
  }

  if (method === "GET" && path === "/api/conformance/packs") {
    return send(res, 200, engine.conformance.list());
  }
  if (method === "POST" && path === "/api/conformance/validate") {
    const body = JSON.parse(await readBody(req)) as { pack?: string; resource?: Record<string, unknown> };
    const pack = engine.conformance.get(body.pack ?? "");
    if (!pack) return send(res, 404, { error: `unknown pack: ${body.pack}` });
    if (!body.resource || typeof body.resource !== "object") return send(res, 400, { error: "resource required" });
    const issues = validateResource(pack, body.resource, engine.terminology);
    const errors = issues.filter((i) => i.severity === "error").length;
    return send(res, 200, { ok: errors === 0, errors, outcome: toOperationOutcome(issues) });
  }
  if (method === "GET" && path === "/api/conformance/capability") {
    const pack = engine.conformance.get(url.searchParams.get("pack") ?? "");
    if (!pack) return send(res, 404, { error: "unknown pack" });
    return send(res, 200, checkCapability(pack, fhir.capability(baseUrl(req), VERSION)));
  }

  if (method === "GET" && path === "/fhir/CodeSystem/$lookup") {
    const hit = engine.terminology.lookup(url.searchParams.get("system") ?? "", url.searchParams.get("code") ?? "");
    if (!hit) {
      return send(res, 404, {
        resourceType: "OperationOutcome",
        issue: [{ severity: "error", code: "not-found", diagnostics: "code not found" }],
      });
    }
    return send(res, 200, {
      resourceType: "Parameters",
      parameter: [
        { name: "name", valueString: hit.system },
        { name: "display", valueString: hit.display ?? "" },
      ],
    });
  }
  if (method === "GET" && path === "/fhir/ValueSet/$expand") {
    const id = url.searchParams.get("url") ?? url.searchParams.get("valueset") ?? "";
    const exp = engine.terminology.expand(id);
    return send(res, 200, {
      resourceType: "ValueSet",
      id: exp.id,
      expansion: { timestamp: new Date().toISOString(), total: exp.total, contains: exp.codes },
    });
  }
  if (method === "GET" && path === "/fhir/ConceptMap/$translate") {
    const matches = engine.terminology.translate({
      code: url.searchParams.get("code") ?? "",
      system: url.searchParams.get("system") ?? undefined,
      map: url.searchParams.get("map") ?? undefined,
      targetSystem: url.searchParams.get("target") ?? undefined,
    });
    return send(res, 200, {
      resourceType: "Parameters",
      parameter: [
        { name: "result", valueBoolean: matches.length > 0 },
        ...matches.map((c) => ({
          name: "match",
          part: [
            { name: "equivalence", valueCode: c.equivalence },
            { name: "concept", valueCoding: { system: c.system, code: c.code, display: c.display } },
          ],
        })),
      ],
    });
  }

  if (path === "/fhir/Subscription" && method === "GET") {
    const rows = subs.list();
    return send(res, 200, {
      resourceType: "Bundle",
      type: "searchset",
      total: rows.length,
      entry: rows.map((r) => ({ fullUrl: `${baseUrl(req)}/fhir/Subscription/${r.id}`, resource: subs.toResource(r) })),
    });
  }
  if (path === "/fhir/Subscription" && method === "POST") {
    try {
      const row = subs.create(JSON.parse(await readBody(req)) as Record<string, unknown>);
      // A subscription is a standing disclosure: every record matching its
      // criteria, sent to that endpoint, indefinitely. That is a larger act
      // than any single read on this trail, and until now it was the only one
      // that left no mark. The endpoint is recorded because "who arranged for
      // patient data to go where" is the question an operator will be asked.
      audit({
        action: "C",
        resourceType: "Subscription",
        resourceId: row.id,
        detail: `rest-hook to ${row.endpoint} on criteria ${row.criteria}`,
      });
      return send(res, 201, subs.toResource(row));
    } catch (err) {
      audit({
        action: "C",
        resourceType: "Subscription",
        outcome: 4,
        detail: err instanceof Error ? err.message : "invalid subscription",
      });
      return send(res, 400, {
        resourceType: "OperationOutcome",
        issue: [{ severity: "error", code: "invalid", diagnostics: err instanceof Error ? err.message : "invalid subscription" }],
      });
    }
  }
  m = /^\/fhir\/Subscription\/([A-Za-z0-9.-]{1,64})$/.exec(path);
  if (m && method === "GET") {
    const row = subs.get(m[1]);
    if (!row) {
      return send(res, 404, {
        resourceType: "OperationOutcome",
        issue: [{ severity: "error", code: "not-found", diagnostics: `Subscription/${m[1]} is not stored` }],
      });
    }
    return send(res, 200, subs.toResource(row));
  }
  if (m && method === "DELETE") {
    // Recorded too. Ending a disclosure is as much a part of the account of
    // where patient data went as starting one, and a trail that only shows
    // live subscriptions cannot answer what was running last month.
    const existing = subs.get(m[1]);
    const removed = subs.remove(m[1]);
    audit({
      action: "D",
      resourceType: "Subscription",
      resourceId: m[1],
      outcome: removed ? 0 : 4,
      ...(existing ? { detail: `rest-hook to ${existing.endpoint} on criteria ${existing.criteria}` } : {}),
    });
    return removed ? send(res, 200, { ok: true }) : send(res, 404, { error: "not found" });
  }

  m = /^\/ingest\/([a-z0-9-]+)$/.exec(path);
  if (m && method === "POST") {
    const channel = engine.httpChannel(m[1]);
    if (!channel) return send(res, 404, { error: "no http channel at this path" });
    const body = await readBody(req);
    const ct = req.headers["content-type"] ?? "text/plain";
    const result = engine.ingest(channel.id, body, ct, "http");
    audit({
      action: "C",
      resourceType: "Message",
      resourceId: result.message.id,
      outcome: result.status === "error" ? 8 : 0,
      detail: result.error,
    });
    return send(res, result.status === "error" ? 422 : 202, {
      messageId: result.message.id,
      status: result.status,
      ...(result.error ? { error: result.error } : {}),
    });
  }

  if (path === "/fhir/metadata" && method === "GET") {
    return send(res, 200, fhir.capability(baseUrl(req), VERSION));
  }

  m = /^\/fhir\/([A-Z][A-Za-z]+)$/.exec(path);
  if (m && method === "GET") {
    const type = m[1];
    const identifier = url.searchParams.get("identifier") ?? undefined;
    const result = fhir.search(type, { identifier, count: num(url.searchParams.get("_count")) });
    audit({ action: "R", resourceType: type, patient: identifier, count: result.total });
    return send(res, 200, {
      resourceType: "Bundle",
      type: "searchset",
      total: result.total,
      entry: result.resources.map((r) => ({
        fullUrl: `${baseUrl(req)}/fhir/${type}/${String((r as { id?: unknown }).id ?? "")}`,
        resource: r,
      })),
    });
  }

  m = /^\/fhir\/([A-Z][A-Za-z]+)\/([A-Za-z0-9.-]{1,64})$/.exec(path);
  if (m && method === "GET") {
    const resource = fhir.get(m[1], m[2]);
    if (!resource) {
      // A miss still says someone went looking for this record.
      audit({ action: "R", resourceType: m[1], resourceId: m[2], outcome: 4, detail: "not found" });
      return send(res, 404, {
        resourceType: "OperationOutcome",
        issue: [{ severity: "error", code: "not-found", diagnostics: `${m[1]}/${m[2]} is not stored` }],
      });
    }
    audit({ action: "R", resourceType: m[1], resourceId: m[2], patient: firstIdentifier(resource), count: 1 });
    return send(res, 200, resource);
  }

  m = /^\/fhir\/([A-Za-z]+)$/.exec(path);
  if (m && method === "POST") {
    const body = await readBody(req);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(body) as Record<string, unknown>;
    } catch {
      return send(res, 400, { error: "body must be JSON" });
    }
    if (parsed.resourceType !== m[1]) {
      return send(res, 400, { error: `resourceType must be ${m[1]}` });
    }
    const channels = engine.fhirChannels(m[1]);
    if (channels.length === 0) return send(res, 404, { error: "no fhir channel accepts this resource type" });
    const results = channels.map((c) => engine.ingest(c.id, body, "application/fhir+json", "fhir"));
    audit({
      action: "C",
      resourceType: m[1],
      patient: firstIdentifier(parsed),
      count: results.length,
      outcome: results.some((r) => r.status === "error") ? 8 : 0,
    });
    return send(res, 202, results.map((r) => ({ channelId: r.message.channel_id, messageId: r.message.id, status: r.status })));
  }

  send(res, 404, { error: "not found" });
}

/**
 * The shipped sample messages, for the mapping editor's live preview. Reads a
 * fixed directory and never a caller-supplied path, so there is nothing here
 * for a traversal to reach.
 */
function listFixtures(): Array<{ name: string; content: string }> {
  const dir = process.env.PORTAGE_FIXTURES ?? join(process.cwd(), "fixtures");
  if (!existsSync(dir)) return [];
  const out: Array<{ name: string; content: string }> = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    try {
      const stat = statSync(full);
      if (!stat.isFile() || stat.size > 256 * 1024) continue;
      out.push({ name, content: readFileSync(full, "utf8") });
    } catch {
      // An unreadable fixture is not worth failing the listing over.
    }
  }
  return out;
}

/**
 * Whether a path reaches patient data, deciding if a refused request is worth
 * an audit row. A rejected dashboard poll is noise; a rejected reach for a
 * patient record is the thing an audit trail exists to show.
 */
function touchesPatientData(path: string): boolean {
  if (path.startsWith("/api/messages")) return true;
  if (path.startsWith("/api/clinical/")) return true;
  if (path === "/patient" || path.startsWith("/patient/")) return true;
  if (path.startsWith("/ingest/")) return true;
  if (path === "/fhir/metadata" || path.startsWith("/fhir/AuditEvent")) return false;
  return path.startsWith("/fhir/");
}

/** REST verb to FHIR AuditEvent action code. */
function verbToAction(method: string): AuditAction {
  if (method === "POST") return "C";
  if (method === "PUT" || method === "PATCH") return "U";
  if (method === "DELETE") return "D";
  return "R";
}

/** The first identifier value on a resource, for the audit trail's patient column. */
function firstIdentifier(resource: unknown): string | undefined {
  const idents = (resource as { identifier?: unknown }).identifier;
  const first = Array.isArray(idents) ? idents[0] : idents;
  const value = (first as { value?: unknown })?.value;
  return typeof value === "string" && value ? value : undefined;
}

function redactMessage(row: MessageRow): Record<string, unknown> {
  return { ...row, raw: row.raw.length > 500 ? row.raw.slice(0, 500) + "..." : row.raw };
}

function baseUrl(req: IncomingMessage): string {
  return `http://${req.headers.host ?? "localhost"}`;
}

function num(v: string | null): number | undefined {
  if (v == null) return undefined;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(json) });
  res.end(json);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
