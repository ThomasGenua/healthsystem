/**
 * Durable delivery worker. Deliveries live in SQLite so a restart resumes
 * exactly where the process stopped. Failures back off exponentially and
 * dead-letter after max_attempts. Ordered destinations release messages
 * strictly in arrival order; a stuck head of line is resolved by replaying
 * or discarding its dead letter. The "fhirstore" destination writes into
 * the local FHIR facade instead of a remote endpoint.
 */
import { request as httpsRequest } from "node:https";
import { readFileSync } from "node:fs";
import { orderingKey, type Db } from "../db.ts";
import type { ClinicalRecord, EntryType } from "../clinical/record.ts";
import type { LabIntake } from "../orders/intake.ts";
import type { LabProfile } from "../orders/hl7.ts";
import type { DeliveryRow, DestinationConfig, DestinationTlsConfig } from "../types.ts";
import type { FhirStore } from "../fhir/store.ts";
import { mllpSend } from "../hl7/mllp.ts";
import { interpretAck } from "../orders/outbound.ts";
import type { OrderStore } from "../orders/store.ts";

/** What a lab-order delivery needs to know to report itself back to the order. */
interface LabOrderMeta {
  orderId?: string;
  controlId?: string;
  kind?: "order" | "cancel";
  destination?: string;
}

const DEFAULTS = {
  maxAttempts: 8,
  backoffBaseMs: 1_000,
  backoffCapMs: 300_000,
  timeoutMs: 15_000,
};

/** Where a delivery for a given tenant should be written. */
export type StoreResolver = (tenantId: string) => {
  fhir: FhirStore;
  clinical: ClinicalRecord;
  labIntake: LabIntake;
  orders: OrderStore;
};

/** Laboratory dialects a `labresults` destination can name. */
export type LabProfileResolver = (id: string) => LabProfile | undefined;

/**
 * Reads a dotted path with array indexes, e.g. "identifier[0].value".
 * Returns a string or undefined; anything that is not a scalar at the end of
 * the path is treated as absent rather than coerced.
 */
function readPath(obj: unknown, path: string): string | undefined {
  let cur: unknown = obj;
  for (const part of path.split(".")) {
    const m = /^([^[]+)((\[\d+\])*)$/.exec(part);
    if (!m || cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[m[1]];
    for (const idx of m[2].match(/\d+/g) ?? []) {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[Number(idx)];
    }
  }
  return typeof cur === "string" || typeof cur === "number" ? String(cur) : undefined;
}

/**
 * A failure that will fail identically however many times it is retried.
 *
 * The distinction the retry loop was missing. A malformed message rejected
 * with HTTP 400, or a receiving application answering AR, does not become
 * acceptable by being sent again: the same bytes get the same answer. Retrying
 * it costs three things, and the third is the one that matters.
 *
 *   - It burns the attempt budget on a message that was never going to land.
 *   - It delays the dead letter, which is the thing a human has to look at,
 *     by the whole backoff schedule.
 *   - **It blocks the ordered destination behind it.** `drainOrdered` stops at
 *     a key whose head is waiting, so one permanently rejected message holds
 *     up every message queued behind it for the full retry cycle — and those
 *     are somebody's results arriving late because of a message that could
 *     never be delivered at all.
 *
 * Transient failures — a refused connection, a timeout, an HTTP 5xx, a 429 —
 * are the opposite and keep the existing behaviour: they are exactly what
 * retries are for.
 */
export class PermanentFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentFailure";
  }
}

export class DeliveryWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private destinations = new Map<string, DestinationConfig>();
  private db: Db;
  private tickMs: number;
  private batch: number;
  /**
   * Resolves the stores a delivery should be written into, by tenant.
   *
   * A resolver rather than a store, because one worker drains the whole node
   * and a delivery belongs to whichever custodian enqueued it. Holding a
   * single facade meant every tenant's resources were written into the
   * default one's — the delivery reported success, and the patient landed
   * under the wrong custodian. The structural scoping check could not see it:
   * the SQL underneath does name a tenant, it was simply bound to the wrong
   * handle when the store was constructed.
   */
  private stores?: StoreResolver;
  /** Messages one ordered key may send per pass, so no key starves the rest. */
  private drainLimit: number;
  private stopping = false;
  /** Laboratory dialects, so a `labresults` destination can name one. */
  private labProfiles: LabProfileResolver = () => undefined;

  constructor(db: Db, tickMs = 250, batch = 25, stores?: StoreResolver, drainLimit = 500) {
    this.db = db;
    this.tickMs = tickMs;
    this.batch = batch;
    this.stores = stores;
    this.drainLimit = drainLimit;
  }

  /** Registers the profile lookup a `labresults` destination resolves against. */
  setLabProfiles(resolver: LabProfileResolver): void {
    this.labProfiles = resolver;
  }

  registerDestination(tenantId: string, channelId: string, dest: DestinationConfig, index: number): string {
    const id = dest.id ?? `${dest.type}-${index}`;
    this.destinations.set(orderingKey(tenantId, channelId, id), dest);
    return id;
  }

  unregisterDestination(tenantId: string, channelId: string, destId: string): void {
    this.destinations.delete(orderingKey(tenantId, channelId, destId));
  }

  unregisterChannel(tenantId: string, channelId: string): void {
    for (const key of this.destinations.keys()) {
      if (key.startsWith(`${tenantId}:${channelId}:`)) this.destinations.delete(key);
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.tickMs);
    this.timer.unref?.();
  }

  /** Stop the timer and wait for any in-flight tick to finish. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    // Signals an in-progress drain loop to finish its current message and
    // stop, rather than working through a whole backlog on the way out.
    this.stopping = true;
    while (this.running) await new Promise((r) => setTimeout(r, 5));
    this.stopping = false;
  }

  /**
   * One scheduling pass. Exposed for deterministic tests.
   *
   * Deliveries are grouped by ordering key and each group is drained on its
   * own, so unrelated destinations never wait for each other.
   *
   * Within an ordered group the messages are sent strictly one at a time,
   * each only after the previous has succeeded — but in a loop, not one per
   * timer tick. That distinction is the difference between draining a backlog
   * and not: an ordered destination previously released a single message per
   * tick, because every later candidate was blocked by its predecessor still
   * being queued, capping throughput at 1/tickMs no matter how fast the
   * remote endpoint answered. A satellite outage produces thousands of queued
   * messages, so that ceiling turned a minutes-long drain into hours.
   */
  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const due = this.db.dueDeliveries(Date.now(), this.batch);
      if (due.length === 0) return 0;

      const groups = new Map<string, DeliveryRow[]>();
      for (const d of due) {
        const list = groups.get(d.ordering_key);
        if (list) list.push(d);
        else groups.set(d.ordering_key, [d]);
      }

      const counts = await Promise.all(
        [...groups.values()].map((rows) => (rows[0].ordered ? this.drainOrdered(rows[0]) : this.drainUnordered(rows)))
      );
      return counts.reduce((a, b) => a + b, 0);
    } finally {
      this.running = false;
    }
  }

  /**
   * Sends one ordering key's backlog sequentially, stopping at the first
   * failure so a retry cannot overtake the message it is behind.
   *
   * Bounded per pass so one busy channel cannot starve the others, and so
   * stop() is never left waiting on an unbounded loop.
   */
  private async drainOrdered(head: DeliveryRow): Promise<number> {
    let sent = 0;
    let next: DeliveryRow | undefined = head;
    while (next && sent < this.drainLimit) {
      const before = next.id;
      await this.attempt(next);
      sent++;
      // Only continue while the message actually left; anything else means
      // this key is blocked and must wait for its backoff.
      const settled = this.db.getDelivery(before);
      if (!settled || settled.state !== "delivered") break;
      if (this.stopping) break;
      next = this.db.nextDueForKey(head.ordering_key, Date.now());
    }
    return sent;
  }

  /** Unordered destinations have no constraint between messages. */
  private async drainUnordered(rows: DeliveryRow[]): Promise<number> {
    await Promise.all(rows.map((d) => this.attempt(d)));
    return rows.length;
  }

  private async attempt(d: DeliveryRow): Promise<void> {
    const dest = this.destinations.get(d.ordering_key);
    if (!dest) {
      this.db.markFailed(d.id, "Destination not registered", Date.now() + 5_000, false);
      return;
    }
    this.db.markInflight(d.id);
    const attempts = d.attempts + 1;
    try {
      const ack = await this.deliver(dest, d.payload, d.content_type, d.tenant_id, d.message_id);
      this.db.markDelivered(d.id, ack);
    } catch (err) {
      const permanent = err instanceof PermanentFailure;
      const message = err instanceof Error ? err.message : String(err);
      const max = dest.maxAttempts ?? DEFAULTS.maxAttempts;
      const base = dest.backoffBaseMs ?? DEFAULTS.backoffBaseMs;
      const cap = dest.backoffCapMs ?? DEFAULTS.backoffCapMs;
      const dead = permanent || attempts >= max;
      const delay = Math.min(base * 2 ** (attempts - 1), cap);
      // Said in the dead letter, because a dead letter with one attempt on it
      // otherwise reads as a retry loop that failed to run.
      const detail = permanent ? `${message} (not retried: the same message would be refused again)` : message;
      this.db.markFailed(d.id, detail, Date.now() + delay, dead);
    }
  }

  private async deliver(
    dest: DestinationConfig,
    payload: string,
    contentType: string,
    tenantId: string,
    messageId: string
  ): Promise<string | null> {
    if (dest.type === "fhirstore") {
      if (!this.stores) throw new Error("FHIR store not attached to this worker");
      const resource = JSON.parse(payload) as Record<string, unknown>;
      // A conformance failure throws, so the delivery retries and eventually
      // dead-letters with the reason attached, exactly like a rejected HTTP
      // POST. Nothing reaches the facade.
      const r = this.stores(tenantId).fhir.upsert(resource, { pack: dest.validatePack, mode: dest.validateMode });
      const verb = r.created ? "created" : r.changed ? "updated" : "unchanged";
      const annotated = r.issues?.length ? ` [${r.issues.length} conformance issue(s): ${r.issues[0].message}]` : "";
      return `${r.resourceType}/${r.id} v${r.versionId} ${verb}${annotated}`;
    }

    if (dest.type === "clinical") {
      if (!this.stores) throw new Error("clinical record not attached to this worker");
      const resource = JSON.parse(payload) as Record<string, unknown>;
      const patientId = readPath(resource, dest.patientPath);
      // Refused rather than filed somewhere convenient. An entry whose patient
      // cannot be determined has no chart to belong to, and guessing is how a
      // result ends up on the wrong one.
      if (!patientId) {
        throw new Error(`no patient identifier at ${dest.patientPath}; the entry has no chart to go on`);
      }
      const entryType = typeof resource.resourceType === "string" ? resource.resourceType : "Observation";
      const identity = dest.identity?.length ? dest.identity : [dest.patientPath];
      const key = `${entryType}|${identity.map((p) => readPath(resource, p) ?? "").join("|")}`;

      const r = this.stores(tenantId).clinical.ingest({
        entryType: entryType as EntryType,
        patientId,
        content: resource,
        authorId: dest.id ?? "interface",
        authorKind: "device",
        source: contentType,
        sourceMessageId: messageId,
        recordKey: key,
        ...(dest.encounterPath ? { encounterId: readPath(resource, dest.encounterPath) ?? undefined } : {}),
        ...(dest.effectivePath ? { effectiveAt: readPath(resource, dest.effectivePath) ?? undefined } : {}),
      });
      return `${entryType} ${r.outcome}${r.entry ? ` v${r.entry.version}` : ""}`;
    }

    if (dest.type === "labresults") {
      if (!this.stores) throw new Error("clinical stores not attached to this worker");
      // A named profile that does not exist is a failure, not a reason to fall
      // back to the generic reading. A site that configured "dynacare" and
      // silently got the generic dialect would be told its vendor interface was
      // working.
      let profile: LabProfile | undefined;
      if (dest.profile) {
        profile = this.labProfiles(dest.profile);
        if (!profile) throw new Error(`unknown laboratory profile '${dest.profile}'`);
      }
      const report = this.stores(tenantId).labIntake.ingest(payload, {
        ...(profile ? { profile } : {}),
        sourceMessageId: messageId,
      });
      // The ack a delivery records is what an operator reads when they ask what
      // an interface did, so it says the outcome per observation rather than
      // only that the message was accepted.
      const summary = report.results.map((r) => r.outcome).join(",");
      const tz = report.timezoneAssumed ? " [observation time had no timezone]" : "";
      return `${report.patientId ?? "unidentified"} ${summary}${tz}`;
    }

    if (dest.type === "http") {
      const headers = {
        "content-type": dest.contentType ?? contentType,
        ...(dest.headers ?? {}),
      };
      const timeoutMs = dest.timeoutMs ?? DEFAULTS.timeoutMs;

      // fetch() cannot present a client certificate, so a destination that
      // needs mutual TLS goes out through node:https instead. Everything else
      // stays on fetch.
      if (dest.tls) {
        return httpsSend(dest.url, dest.method ?? "POST", headers, payload, timeoutMs, dest.tls);
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      timer.unref?.();
      try {
        const res = await fetch(dest.url, {
          method: dest.method ?? "POST",
          headers,
          body: payload,
          signal: controller.signal,
        });
        const body = await res.text();
        if (!res.ok) {
          const detail = `HTTP ${res.status}: ${body.slice(0, 300)}`;
          // 4xx is a statement about this message, and sending it again will
          // produce the same statement. The two exceptions are the ones that
          // explicitly ask for a retry: 408 and 429.
          throw res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429
            ? new PermanentFailure(detail)
            : new Error(detail);
        }
        return body.slice(0, 4_000) || null;
      } finally {
        clearTimeout(timer);
      }
    }

    // A laboratory order, and the acknowledgement brought back to it.
    //
    // Which order this is travels in the message's metadata rather than in the
    // payload: the payload is the requisition as the laboratory will read it,
    // and adding our own identifiers to it would be sending them something we
    // invented for our own bookkeeping.
    if (dest.type === "lab-order") {
      if (!this.stores) throw new Error("clinical stores not attached to this worker");
      const message = this.db.getMessage(messageId);
      const meta = message?.meta ? (JSON.parse(message.meta) as LabOrderMeta) : undefined;
      if (!meta?.orderId || !meta.controlId) {
        // Permanent: nothing about retrying finds an order id that was never
        // written. Dead-lettering puts it in front of somebody instead.
        throw new PermanentFailure(
          `this delivery carries no order to record against (message ${messageId}); it cannot be attributed`
        );
      }
      const orders = this.stores(tenantId).orders;
      const kind = meta.kind === "cancel" ? "cancel" : "order";

      let ack: string;
      try {
        ack = await mllpSend(dest.host, dest.port, payload, dest.timeoutMs ?? DEFAULTS.timeoutMs);
      } catch (err) {
        // The link failed. Recorded against the order as failed, which reads
        // as *not sent* rather than sent-and-waiting, and rethrown so the
        // queue retries it — a refused connection is exactly what retries are
        // for, and the requisition may still be perfectly acceptable.
        orders.recordTransmission(
          meta.orderId,
          {
            kind,
            outcome: "failed",
            destination: meta.destination ?? `${dest.host}:${dest.port}`,
            controlId: meta.controlId,
            detail: (err as Error).message,
          },
          { actorId: "delivery-worker", actorKind: "system" }
        );
        throw err;
      }

      const verdict = interpretAck(ack, meta.controlId);
      orders.recordTransmission(
        meta.orderId,
        {
          kind,
          outcome: verdict.outcome,
          destination: meta.destination ?? `${dest.host}:${dest.port}`,
          controlId: meta.controlId,
          detail: verdict.detail,
        },
        { actorId: "delivery-worker", actorKind: "system" }
      );

      if (verdict.outcome === "acknowledged") return ack.slice(0, 4_000) || null;
      // A refusal is permanent. The same requisition sent again is refused
      // again, and each attempt would write another rejection onto the chart.
      if (verdict.outcome === "rejected") throw new PermanentFailure(verdict.detail);
      // Everything else — no acknowledgement, an acknowledgement for another
      // message, a code this does not recognise — is a maybe, and a maybe is
      // worth retrying.
      throw new Error(verdict.detail);
    }

    if (dest.type === "mllp") {
      const ack = await mllpSend(dest.host, dest.port, payload, dest.timeoutMs ?? DEFAULTS.timeoutMs);
      // AE and AR are the receiving application refusing this message, not the
      // link failing. Resending identical bytes gets an identical refusal.
      if (/(^|\r)MSA\|(AE|AR)\|/.test(ack)) throw new PermanentFailure(`Remote NAK: ${ack.slice(0, 300)}`);
      return ack.slice(0, 4_000) || null;
    }

    throw new Error(`Unknown destination type: ${(dest as { type: string }).type}`);
  }
}

/**
 * POST/PUT over node:https with a client certificate. Certificate material is
 * read per request rather than cached, so rotating a cert on disk takes effect
 * on the next attempt without restarting the engine — which matters when the
 * retry that follows a rotation is the one that has to succeed.
 */
function httpsSend(
  url: string,
  method: string,
  headers: Record<string, string>,
  payload: string,
  timeoutMs: number,
  tls: DestinationTlsConfig
): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = httpsRequest(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || 443,
        path: `${target.pathname}${target.search}`,
        method,
        headers: { ...headers, "content-length": String(Buffer.byteLength(payload)) },
        cert: tls.certPath ? readFileSync(tls.certPath) : undefined,
        key: tls.keyPath ? readFileSync(tls.keyPath) : undefined,
        ca: tls.caPath ? readFileSync(tls.caPath) : undefined,
        rejectUnauthorized: tls.rejectUnauthorized !== false,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            reject(new Error(`HTTP ${status}: ${body.slice(0, 300)}`));
            return;
          }
          resolve(body.slice(0, 4_000) || null);
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error(`timeout after ${timeoutMs}ms`)));
    req.on("error", reject);
    req.end(payload);
  });
}
