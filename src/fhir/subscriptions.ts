/**
 * FHIR rest-hook subscriptions on the facade. A change in the resource store
 * (created or updated; unchanged upserts never notify) enqueues one durable
 * delivery per matching active subscription, riding the same queue as every
 * other destination: retry with backoff, dead-lettering, strict per-
 * subscription ordering, replay from the DLQ. Criteria supports a resource
 * type with an optional identifier token: "Observation" or
 * "Patient?identifier=NT123456" or "...?identifier=system|value".
 */
import { randomUUID } from "node:crypto";
import type { Db } from "../db.ts";
import type { DeliveryWorker } from "../core/queue.ts";
import type { SubscriptionRow } from "../types.ts";
import type { FhirUpsertResult } from "./store.ts";

export const SUBSCRIPTION_CHANNEL = "fhir-subscriptions";

export class SubscriptionManager {
  private db: Db;
  private worker: DeliveryWorker;

  constructor(db: Db, worker: DeliveryWorker) {
    this.db = db;
    this.worker = worker;
  }

  load(): number {
    let n = 0;
    for (const row of this.db.listSubscriptions()) {
      this.registerDestination(row);
      n++;
    }
    return n;
  }

  list(): SubscriptionRow[] {
    return this.db.listSubscriptions();
  }

  get(id: string): SubscriptionRow | undefined {
    return this.db.getSubscription(id);
  }

  /** Create from a FHIR Subscription resource. Returns the stored row. */
  create(resource: Record<string, unknown>): SubscriptionRow {
    if (resource.resourceType !== "Subscription") throw new Error("resourceType must be Subscription");
    const channel = (resource.channel ?? {}) as Record<string, unknown>;
    if (channel.type !== "rest-hook") throw new Error("Only channel.type rest-hook is supported");
    const endpoint = String(channel.endpoint ?? "");
    if (!/^https?:\/\//.test(endpoint)) throw new Error("channel.endpoint must be an http(s) URL");
    const criteria = String(resource.criteria ?? "");
    validateCriteria(criteria);
    const id = typeof resource.id === "string" && /^[A-Za-z0-9.-]{1,64}$/.test(resource.id) ? resource.id : randomUUID();
    if (this.db.getSubscription(id)) throw new Error(`Subscription ${id} already exists`);
    const row: SubscriptionRow = {
      id,
      status: "active",
      criteria,
      endpoint,
      payload: String(channel.payload ?? "application/fhir+json"),
      created_at: new Date().toISOString(),
    };
    this.db.insertSubscription(row);
    this.registerDestination(row);
    return row;
  }

  remove(id: string): boolean {
    const ok = this.db.deleteSubscription(id);
    if (ok) this.worker.unregisterDestination(this.db.tenantId, SUBSCRIPTION_CHANNEL, id);
    return ok;
  }

  /** Called by the store on every effective change. */
  notify(result: FhirUpsertResult, resource: Record<string, unknown>): number {
    if (!result.changed) return 0;
    let n = 0;
    for (const sub of this.db.listSubscriptions()) {
      if (sub.status !== "active") continue;
      if (!criteriaMatches(sub.criteria, resource)) continue;
      this.db.enqueueDelivery({
        messageId: `subscription:${result.resourceType}/${result.id}`,
        channelId: SUBSCRIPTION_CHANNEL,
        destinationId: sub.id,
        seq: result.versionId,
        ordered: true,
        skipOnDead: false,
        maxAttempts: 12,
        payload: JSON.stringify(resource),
        contentType: sub.payload,
      });
      n++;
    }
    return n;
  }

  /** Rebuild a FHIR Subscription resource from a stored row. */
  toResource(row: SubscriptionRow): Record<string, unknown> {
    return {
      resourceType: "Subscription",
      id: row.id,
      status: row.status,
      criteria: row.criteria,
      channel: { type: "rest-hook", endpoint: row.endpoint, payload: row.payload },
      meta: { lastUpdated: row.created_at },
    };
  }

  private registerDestination(row: SubscriptionRow): void {
    this.worker.registerDestination(
      this.db.tenantId,
      SUBSCRIPTION_CHANNEL,
      {
        id: row.id,
        type: "http",
        url: row.endpoint,
        contentType: row.payload,
        ordered: true,
        maxAttempts: 12,
        backoffBaseMs: 1000,
        backoffCapMs: 60_000,
        timeoutMs: 10_000,
      },
      0
    );
  }
}

export function validateCriteria(criteria: string): void {
  const [type, qs] = criteria.split("?", 2);
  if (!/^[A-Z][A-Za-z]+$/.test(type ?? "")) throw new Error("criteria must start with a resource type");
  if (qs) {
    const params = new URLSearchParams(qs);
    for (const key of params.keys()) {
      if (key !== "identifier") throw new Error(`Unsupported criteria parameter: ${key} (only identifier)`);
    }
  }
}

export function criteriaMatches(criteria: string, resource: Record<string, unknown>): boolean {
  const [type, qs] = criteria.split("?", 2);
  if (resource.resourceType !== type) return false;
  if (!qs) return true;
  const token = new URLSearchParams(qs).get("identifier");
  if (!token) return true;
  const bar = token.indexOf("|");
  const system = bar >= 0 ? token.slice(0, bar) : null;
  const value = bar >= 0 ? token.slice(bar + 1) : token;
  const idents = Array.isArray(resource.identifier) ? (resource.identifier as Array<Record<string, unknown>>) : [];
  return idents.some((i) => String(i.value ?? "") === value && (system === null || String(i.system ?? "") === system));
}
