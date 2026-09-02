/**
 * Running the dispatch sweep on a clock, and deciding who it runs for.
 *
 * `dispatch.ts` knows how to hand every sendable order to the queue once.
 * This is what makes that happen without anybody asking: a timer, and the
 * three questions a timer forces — how often, for which custodians, and out
 * of which door.
 *
 * ## How often
 *
 * The interval is the delay between a clinician placing an order and the
 * laboratory being able to see it, so it is measured against how fast a
 * patient walks. Somebody leaves the exam room and goes to the draw station;
 * a requisition that has not arrived by the time they sit down is a specimen
 * collected against nothing, or a patient sent home to come back. An hour —
 * the retention sweep's cadence — is far too slow for that. A second is a
 * table scan per custodian for a queue that is almost always empty. A minute
 * is the right order of magnitude and is not a number anybody should have to
 * think about; `NORTHSTAR_ORDER_DISPATCH_INTERVAL_MS` is there for the site
 * that has to.
 *
 * Setting it to `0` turns the sweep off, and a site that wants orders to
 * leave only when a human presses send should set exactly that. It is a
 * declaration rather than an omission, which is the difference between "we
 * decided against automatic send" and "nobody ever configured this".
 *
 * ## For which custodians
 *
 * Every tenant whose status is active. A suspended tenant is one whose
 * custodian relationship has ended: their credentials already stop working at
 * the gate, and transmitting their orders would be disclosing a patient's
 * details to a laboratory on behalf of somebody who no longer holds the
 * relationship that justified holding them. The sweep runs inside the engine,
 * which holds the exclusive instance lock, so two processes cannot both sweep
 * one database.
 *
 * ## Out of which door
 *
 * The `lab-order` destination on an enabled channel. Nothing new to
 * configure: a site that has declared a route that transmits *and* stood up a
 * destination for it has said, twice and deliberately, that these orders
 * leave here.
 *
 * That the channel must be **enabled** is load-bearing rather than tidy. A
 * reading station runs a full engine over a restored copy of the primary's
 * database, and `fillStation` flips every channel in that copy off precisely
 * so the station does not become a second engine sending the primary's feeds
 * (H-39). A sweep that ignored the flag would resend every placed order in
 * the snapshot from a machine that is not the record — H-164 again, from a
 * node that cannot even tell it has already happened.
 *
 * ## Two laboratories
 *
 * A route declares its destination as a name a human wrote ("Dynacare
 * Winnipeg"), and a channel declares its destinations as queue identifiers.
 * Nothing maps one to the other yet, which is invisible while a site sends to
 * one laboratory and a coin toss once it sends to two. So the sweep refuses
 * the ambiguity: with more than one `lab-order` destination for a tenant it
 * sweeps none of them and says why. Sending a requisition to the wrong
 * laboratory is worse than sending it late, and the site that first has two
 * is the site that can say which is which.
 */
import { dispatchCancellations, dispatchPlacedOrders, type DispatchResult } from "./dispatch.ts";
import { readEnv } from "../core/naming.ts";
import type { PatientIndex } from "../clinical/patients.ts";
import type { OrderStore } from "./store.ts";
import type { LabProfile } from "./hl7.ts";
import type { ChannelConfig } from "../types.ts";
import type { Db } from "../db.ts";

/** The per-tenant pieces the sweep needs, resolved when a pass reaches them. */
export interface SweepTenant {
  db: Db;
  orders: OrderStore;
  patients: PatientIndex;
}

export interface SweepDeps {
  /** The engine's own handle, used only to enumerate tenants. */
  db: Db;
  forTenant: (tenantId: string) => SweepTenant;
  profiles: (id: string) => LabProfile | undefined;
}

/** What one pass did, per tenant, in enough detail to say why nothing moved. */
export interface SweepPass {
  tenants: number;
  enqueued: string[];
  unbuildable: DispatchResult["unbuildable"];
  /**
   * Tenants the sweep declined to act for, with the reason.
   *
   * Separate from `unbuildable` because the cause is configuration rather
   * than a chart: nobody can fix these by recording a missing answer.
   */
  skipped: Array<{ tenant: string; reason: string }>;
}

export const DEFAULT_INTERVAL_MS = 60_000;

/** Reads the configured cadence; `0` means the sweep does not run. */
export function resolveInterval(env: NodeJS.ProcessEnv = process.env): number {
  const raw = readEnv("ORDER_DISPATCH_INTERVAL_MS", env);
  if (raw === undefined || raw.trim() === "") return DEFAULT_INTERVAL_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(
      `NORTHSTAR_ORDER_DISPATCH_INTERVAL_MS must be a non-negative number of milliseconds, got ${JSON.stringify(raw)}. ` +
        "Use 0 to send orders only when somebody presses send."
    );
  }
  return n;
}

/**
 * The one `lab-order` door out of a tenant, or the reason there is not one.
 *
 * Exported because the refusal is worth asserting directly: the interesting
 * cases are a station's disabled channels and a site with two laboratories,
 * and neither should have to be reached through a timer to be tested.
 */
export function labOrderDoor(
  db: Db
): { channelId: string; destinationId: string } | { reason: string } | undefined {
  const doors: Array<{ channelId: string; destinationId: string }> = [];
  for (const row of db.listChannels()) {
    // Disabled means disabled. A reading station's every channel is off.
    if (!row.enabled) continue;
    let config: ChannelConfig;
    try {
      config = JSON.parse(row.config) as ChannelConfig;
    } catch {
      continue;
    }
    (config.destinations ?? []).forEach((dest, index) => {
      if (dest.type !== "lab-order") return;
      doors.push({ channelId: config.id, destinationId: dest.id ?? `${dest.type}-${index}` });
    });
  }
  if (doors.length === 0) return undefined;
  if (doors.length > 1) {
    return {
      reason:
        `this tenant has ${doors.length} lab-order destinations (` +
        doors.map((d) => `${d.channelId}/${d.destinationId}`).join(", ") +
        "), and an order route names its laboratory as a label rather than as one of these. " +
        "Sending a requisition to the wrong laboratory is worse than sending it late, so nothing was swept. " +
        "Leave one lab-order destination enabled, or send these orders with POST /api/clinical/order-send.",
    };
  }
  return doors[0];
}

/**
 * Sweeps placed orders onto the outbound queue on a timer.
 *
 * Modelled on `RetentionRunner`: it sweeps once at start so an instance that
 * was down overnight does not sit on yesterday's orders until the first
 * interval elapses, it never lets a failing pass take the process down, and
 * it does not hold the event loop open.
 */
export class OrderDispatchSweeper {
  private deps: SweepDeps;
  private intervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  /** The last pass, so `/api/admin/...` and tests can see what it did. */
  last: SweepPass | null = null;

  constructor(deps: SweepDeps, intervalMs = resolveInterval()) {
    this.deps = deps;
    this.intervalMs = intervalMs;
  }

  get enabled(): boolean {
    return this.intervalMs > 0;
  }

  /** One pass over every active tenant. Safe to call directly; tests do. */
  run(): SweepPass {
    const pass: SweepPass = { tenants: 0, enqueued: [], unbuildable: [], skipped: [] };
    for (const tenant of this.deps.db.listTenants()) {
      if (tenant.status !== "active") {
        // Not reported as skipped: a suspended custodian is a settled state
        // rather than something to fix, and listing it every minute would
        // bury the configuration problems this list exists to surface.
        continue;
      }
      const door = labOrderDoor(this.deps.db.forTenant(tenant.id));
      if (door === undefined) continue; // No door out. Nothing to say about it.
      if ("reason" in door) {
        pass.skipped.push({ tenant: tenant.id, reason: door.reason });
        continue;
      }
      const view = this.deps.forTenant(tenant.id);
      pass.tenants += 1;
      const deps = {
        db: view.db,
        orders: view.orders,
        patients: view.patients,
        profiles: this.deps.profiles,
        channelId: door.channelId,
        destinationId: door.destinationId,
      };
      // Withdrawals first. Both lists are disjoint -- an order is placed or
      // it is cancelled -- so the order of these two calls changes nothing
      // about what is sent. It changes what happens when a pass is cut short
      // by the per-call limit, and a withdrawal that waits a minute is a
      // patient who may already be sitting down to be drawn.
      for (const result of [dispatchCancellations(deps), dispatchPlacedOrders(deps)]) {
        pass.enqueued.push(...result.enqueued);
        pass.unbuildable.push(...result.unbuildable);
      }
    }
    this.last = pass;
    return pass;
  }

  start(): void {
    if (!this.enabled || this.timer) return;
    this.safeRun();
    this.timer = setInterval(() => this.safeRun(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private safeRun(): void {
    try {
      const pass = this.run();
      // Said once per pass rather than once per order per pass: a line every
      // minute for the same stuck order is how a real one stops being read.
      for (const skip of pass.skipped) console.warn(`order dispatch: tenant ${skip.tenant}: ${skip.reason}`);
    } catch (err) {
      // A sweep that throws must not take the engine down. The orders it did
      // not reach are still on the not-with-a-laboratory list, and the next
      // pass tries again.
      console.error(`order dispatch sweep: ${err instanceof Error ? err.message : err}`);
    }
  }
}
