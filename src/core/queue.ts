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
import type { Db } from "../db.ts";
import type { DeliveryRow, DestinationConfig, DestinationTlsConfig } from "../types.ts";
import type { FhirStore } from "../fhir/store.ts";
import { mllpSend } from "../hl7/mllp.ts";

const DEFAULTS = {
  maxAttempts: 8,
  backoffBaseMs: 1_000,
  backoffCapMs: 300_000,
  timeoutMs: 15_000,
};

export class DeliveryWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private destinations = new Map<string, DestinationConfig>();
  private db: Db;
  private tickMs: number;
  private batch: number;
  private fhir?: FhirStore;

  constructor(db: Db, tickMs = 250, batch = 25, fhir?: FhirStore) {
    this.db = db;
    this.tickMs = tickMs;
    this.batch = batch;
    this.fhir = fhir;
  }

  registerDestination(channelId: string, dest: DestinationConfig, index: number): string {
    const id = dest.id ?? `${dest.type}-${index}`;
    this.destinations.set(`${channelId}:${id}`, dest);
    return id;
  }

  unregisterDestination(channelId: string, destId: string): void {
    this.destinations.delete(`${channelId}:${destId}`);
  }

  unregisterChannel(channelId: string): void {
    for (const key of this.destinations.keys()) {
      if (key.startsWith(`${channelId}:`)) this.destinations.delete(key);
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
    while (this.running) await new Promise((r) => setTimeout(r, 5));
  }

  /** One scheduling pass. Exposed for deterministic tests. */
  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const due = this.db.dueDeliveries(Date.now(), this.batch);
      await Promise.all(due.map((d) => this.attempt(d)));
      return due.length;
    } finally {
      this.running = false;
    }
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
      const ack = await this.deliver(dest, d.payload, d.content_type);
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

  private async deliver(dest: DestinationConfig, payload: string, contentType: string): Promise<string | null> {
    if (dest.type === "fhirstore") {
      if (!this.fhir) throw new Error("FHIR store not attached to this worker");
      const resource = JSON.parse(payload) as Record<string, unknown>;
      const r = this.fhir.upsert(resource);
      const verb = r.created ? "created" : r.changed ? "updated" : "unchanged";
      return `${r.resourceType}/${r.id} v${r.versionId} ${verb}`;
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
