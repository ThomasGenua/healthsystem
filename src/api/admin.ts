/**
 * Admin and ingest HTTP API. No framework: node:http with a small router.
 *
 * Every request passes one authentication gate before any route runs (see
 * auth/gate.ts). Scopes: /api/* needs `admin`, GET /fhir/* needs `read`,
 * writes need `write`. The UI shell, /api/health and /fhir/metadata are open.
 *
 * GET  /api/health                       liveness, counters and alertable signals
 * GET  /metrics                          Prometheus exposition (public, no patient data)
 * GET  /api/channels                     list channels with runtime state
 * POST /api/channels                     create or replace a channel
 * GET  /api/channels/:id                 channel configuration
 * DELETE /api/channels/:id               stop and remove a channel
 * GET  /api/messages?channel_id&status   browse messages
 * GET  /api/messages/:id                 message with steps and deliveries
 * GET  /api/deliveries?channel_id&state  browse deliveries (state=dead is the DLQ)
 * POST /api/deliveries/:id/replay        requeue a dead, delivered or discarded delivery
 * POST /api/deliveries/:id/discard       discard a dead delivery, releasing ordered flow
 * GET  /api/chain/verify?channel_id      verify the channel hash chain
 * POST /api/backup                       take a verified snapshot of the database
 * GET  /api/retention                    retention policy and what it would touch
 * POST /api/retention/run                apply the policy now
 * GET  /api/audit?patient=&principal=&failures=  access trail (admin only)
 * GET  /api/audit/verify                 verify the audit hash chain
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
import { CHART_TYPES, WORKLIST_TYPES } from "../workspace/summary.ts";
import { VISIT_TYPES } from "../workspace/visit.ts";
import type { EncounterClass } from "../clinical/encounters.ts";
import { AuthGate } from "../auth/gate.ts";
import { RateLimiter, type RateLimitPolicy } from "./ratelimit.ts";
import { VERSION } from "../version.ts";
import type { AuditAction, AuditEntry } from "../audit/store.ts";
import type { TlsConfig } from "./tls.ts";
import type { ChannelConfig, MappingDoc, MessageRow } from "../types.ts";

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
}

export function startApi(engine: Engine, port: number, host = "0.0.0.0", options: ApiOptions = {}): Promise<ApiHandle> {
  const gate = options.auth ?? new AuthGate();
  // Per listener rather than per process: two engines in one test run must not
  // share a budget, and an operator running two listeners means them to be
  // independent.
  const limiter = new RateLimiter(options.rateLimit);
  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    void route(engine, req, res, gate, limiter).catch((err) => {
      send(res, 500, { error: err instanceof Error ? err.message : "internal error" });
    });
  };
  const server = options.tls ? createSecureServer(options.tls.serverOptions, handler) : createServer(handler);
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
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

async function route(
  engine: Engine,
  req: IncomingMessage,
  res: ServerResponse,
  gate: AuthGate,
  limiter: RateLimiter
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
    tenant.audit.record({
      principalId: auth.ok ? auth.principal.id : (auth.principal?.id ?? "unauthenticated"),
      principalKind: auth.ok ? auth.principal.kind : (auth.principal?.kind ?? "unknown"),
      method,
      path,
      sourceIp: req.socket.remoteAddress ?? undefined,
      // Why, not just who. A trail that cannot separate treatment from
      // curiosity cannot answer the question a privacy office actually asks.
      ...(auth.ok && auth.principal.purposeOfUse ? { purposeOfUse: auth.principal.purposeOfUse } : {}),
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

  if (method === "GET" && path === "/api/health") {
    const signals = db.healthSignals();
    const stalledAfter = num(url.searchParams.get("stalled_after_sec")) ?? 3600;
    // A stalled channel is one holding work that has sat longer than the
    // threshold. Reported rather than merely counted, because "which feed"
    // is the first thing an operator needs and the counters cannot say.
    const stalled = signals.stalledChannels.filter((c) => c.oldestQueuedAgeSec >= stalledAfter);
    return send(res, 200, {
      ok: true,
      // Degraded rather than unhealthy: the engine is working correctly by
      // holding a backlog through an outage. It is the operator's judgement
      // whether a backlog this old means something is wrong.
      // A silent feed counts too. It is the one failure that produces no
      // backlog and no dead letters, so without it here a stopped interface
      // reports a clean bill of health for as long as it stays stopped.
      degraded: stalled.length > 0 || signals.deadLetters > 0 || signals.silentChannels.length > 0,
      stats: db.stats(),
      signals: { ...signals, stalledChannels: stalled, stalledAfterSec: stalledAfter },
      // Not part of `degraded`: an unencrypted volume is a posture rather than
      // an incident, and flipping a health check to degraded forever would
      // train an operator to ignore the field that also reports a stopped
      // feed. Reported so a monitor can alert on it as its own thing.
      atRest: encryptionAtRest(engine.dataDir),
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

    const body = lines.join("\n") + "\n";
    res.writeHead(200, { "content-type": "text/plain; version=0.0.4", "content-length": Buffer.byteLength(body) });
    res.end(body);
    return;
  }

  if (path === "/api/channels" && method === "GET") {
    return send(res, 200, engine.listChannels());
  }
  if (path === "/api/channels" && method === "POST") {
    const body = await readBody(req);
    const config = JSON.parse(body) as ChannelConfig;
    await engine.addChannel(config);
    return send(res, 201, { ok: true, id: config.id });
  }

  let m = /^\/api\/channels\/([a-z0-9-]+)$/.exec(path);
  if (m) {
    if (method === "GET") {
      const cfg = engine.getChannelConfig(m[1]);
      return cfg ? send(res, 200, cfg) : send(res, 404, { error: "not found" });
    }
    if (method === "DELETE") {
      await engine.removeChannel(m[1]);
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
      audit({
        action: "E",
        resourceType: "Backup",
        detail: `snapshot ${result.path} (${result.bytes} bytes, ${result.verified.messages} messages verified)`,
      });
      return send(res, 200, result);
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

    const restrictions = (forPatient: string) => tenant.consent.restrictionsFor({ subjectId, patientId: forPatient });

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
        audit({ action: verbToAction(method), outcome: 8, resourceType, patient, detail: (err as Error).message });
        return send(res, 400, { error: (err as Error).message });
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

    if (path === "/api/clinical/chart" && method === "GET") {
      if (!patient) return send(res, 400, { error: "patient required" });
      // The chart is not one entry type, which is why it passes CHART_TYPES
      // and takes the withheld set rather than being refused outright. A
      // patient who locked their counselling notes gets a chart without that
      // panel — and the panel says a directive is why, because a summary is
      // read as complete and a silently short one is the failure this whole
      // module exists to refuse.
      return phi(
        "Composition",
        (withheldTypes) =>
          tenant.workspace.chart(patient, { limit: num(url.searchParams.get("limit")), withheldTypes }),
        undefined,
        CHART_TYPES
      );
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
        audit({
          action: "U",
          outcome: 8,
          resourceType: "Observation",
          patient: row.patient_id,
          detail: (err as Error).message,
        });
        return send(res, 400, { error: (err as Error).message });
      }
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
            }
      );
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
      // Audited as a read of the patient, because that is what it is: it
      // consults their allergies and their medication list.
      audit({ action: "R", outcome: 0, resourceType: "AllergyIntolerance", patient: p, detail: `safety check: ${ingredient}` });
      return send(res, 200, tenant.meds.check(p, { ingredient, display }));
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
    const body = JSON.parse(await readBody(req)) as { name?: string; scopes?: string[]; expiresAt?: string };
    if (!body.name) return send(res, 400, { error: "name required" });
    try {
      // The plaintext key appears in this response and nowhere else, ever.
      const issued = keys.issue(body.name, body.scopes, body.expiresAt ? { expiresAt: body.expiresAt } : {});
      audit({ action: "C", resourceType: "ApiKey", resourceId: issued.id, detail: `scopes: ${issued.scopes.join(" ")}` });
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
