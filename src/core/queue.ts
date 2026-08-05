/**
 * Durable delivery worker. Deliveries live in SQLite so a restart resumes
 * exactly where the process stopped. Failures back off exponentially and
 * dead-letter after max_attempts. Ordered destinations release messages
 * strictly in arrival order; a stuck head of line is resolved by replaying
 * or discarding its dead letter. The "fhirstore" destination writes into
 * the local FHIR facade instead of a remote endpoint.
 */
import type { Db } from "../db.ts";
import type { DeliveryRow, DestinationConfig } from "../types.ts";
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
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), dest.timeoutMs ?? DEFAULTS.timeoutMs);
      timer.unref?.();
      try {
        const res = await fetch(dest.url, {
          method: dest.method ?? "POST",
          headers: {
            "content-type": dest.contentType ?? contentType,
            ...(dest.headers ?? {}),
          },
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
