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
import type { DeliveryRow, DestinationConfig, DestinationTlsConfig } from "../types.ts";
import type { FhirStore } from "../fhir/store.ts";
import { mllpSend } from "../hl7/mllp.ts";

const DEFAULTS = {
  maxAttempts: 8,
  backoffBaseMs: 1_000,
  backoffCapMs: 300_000,
  timeoutMs: 15_000,
};

/** Where a delivery for a given tenant should be written. */
export type StoreResolver = (tenantId: string) => { fhir: FhirStore; clinical: ClinicalRecord };

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

  constructor(db: Db, tickMs = 250, batch = 25, stores?: StoreResolver, drainLimit = 500) {
    this.db = db;
    this.tickMs = tickMs;
    this.batch = batch;
    this.stores = stores;
    this.drainLimit = drainLimit;
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
      const message = err instanceof Error ? err.message : String(err);
      const max = dest.maxAttempts ?? DEFAULTS.maxAttempts;
      const base = dest.backoffBaseMs ?? DEFAULTS.backoffBaseMs;
      const cap = dest.backoffCapMs ?? DEFAULTS.backoffCapMs;
      const dead = attempts >= max;
      const delay = Math.min(base * 2 ** (attempts - 1), cap);
      this.db.markFailed(d.id, message, Date.now() + delay, dead);
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
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`);
        return body.slice(0, 4_000) || null;
      } finally {
        clearTimeout(timer);
      }
    }

    if (dest.type === "mllp") {
      const ack = await mllpSend(dest.host, dest.port, payload, dest.timeoutMs ?? DEFAULTS.timeoutMs);
      if (/(^|\r)MSA\|(AE|AR)\|/.test(ack)) throw new Error(`Remote NAK: ${ack.slice(0, 300)}`);
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
