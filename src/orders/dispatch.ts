/**
 * Handing placed orders, and withdrawals of them, to the outbound queue —
 * each exactly once.
 *
 * `send.ts` sends one order when somebody asks. This is what makes it happen
 * without anybody asking: a sweep that finds orders nobody has sent, builds
 * each into a message, and puts it on the ordinary delivery queue — the same
 * one that carries every other outbound message, with its retries, its
 * ordering and its dead-letter queue. A second queue beside that one would be
 * a second thing to monitor, a second place for a message to be stuck, and a
 * second set of failures nobody has seen before.
 *
 * ## Why the enqueue and the record are one transaction
 *
 * The sweep decides what to send by asking which orders read as `not-sent`.
 * Handing one to the queue and recording that handover are two writes, and a
 * process that died between them would leave an order on the queue that still
 * reads as never sent. The next sweep would enqueue it again.
 *
 * That is not a duplicate message. It is **two requisitions for one specimen**:
 * the laboratory books two collections, or draws twice, or reports one result
 * against an order the clinician cannot find. So both writes go in one
 * transaction, and the ambiguous case does not exist.
 *
 * ## Why withdrawals are swept too
 *
 * Because their absence is the quiet one. An order that never left is visible
 * as an order no laboratory has, on a list built to show exactly that. A
 * cancellation that never left is visible as a cancelled order — which is
 * what the chart says, what the clinician saw, and what the patient was
 * told. The only thing that disagrees is a requisition on a bench somewhere
 * else, and nothing here can see it.
 *
 * So the two halves go out on one clock and through one door. A sweep that
 * carried orders and not withdrawals would not look half-finished; it would
 * look like it was working.
 *
 * ## What it does not do
 *
 * Build a message it cannot build. An order missing an ask-at-order-entry
 * answer, or a patient identifier under the laboratory's authority, is left
 * alone — it stays on the "no laboratory has this" list with its reason, where
 * somebody can act on it, rather than being enqueued to fail. The sweep runs
 * again later, so an order that could not be built this morning goes out this
 * afternoon once the answer is recorded, with no intervention.
 */
import { buildOml, buildOrderCancel, type OmlContext } from "./outbound.ts";
import type { Actor, OrderRouting, OrderRow, OrderStore } from "./store.ts";
import type { PatientIndex } from "../clinical/patients.ts";
import type { LabProfile } from "./hl7.ts";
import type { Db } from "../db.ts";

export interface DispatchDeps {
  db: Db;
  orders: OrderStore;
  patients: PatientIndex;
  profiles: (id: string) => LabProfile | undefined;
  /** The channel outbound orders are queued on, so they share its history. */
  channelId: string;
  /** The registered destination carrying orders for this route. */
  destinationId: string;
}

export interface DispatchResult {
  /** Orders handed to the queue on this pass. */
  enqueued: string[];
  /**
   * Orders that could not be built, with the reason.
   *
   * Reported rather than swallowed: a sweep that silently skipped them would
   * make "nothing to send" and "three orders nobody can send" look identical
   * from outside, and the second is the one somebody has to act on.
   */
  unbuildable: Array<{ order: string; missing: string[]; reason: string }>;
}

const SYSTEM: Actor = { actorId: "order-dispatch", actorKind: "system" };

function contextFor(routing: OrderRouting, orderedBy: string): OmlContext {
  return {
    sendingApplication: routing.sending_application!,
    sendingFacility: routing.sending_facility!,
    receivingApplication: routing.receiving_application!,
    receivingFacility: routing.receiving_facility!,
    timezoneOffset: routing.timezone_offset!,
    orderingProvider: { id: orderedBy, family: orderedBy },
  };
}

/**
 * Enqueues every placed order that no laboratory has and that can be built.
 *
 * Idempotent by construction: it only considers orders whose transmission
 * state is `not-sent`, and recording the handover inside the same transaction
 * moves them out of that state before anything else can look.
 */
export function dispatchPlacedOrders(deps: DispatchDeps, limit = 50): DispatchResult {
  const result: DispatchResult = { enqueued: [], unbuildable: [] };

  for (const order of deps.orders.notWithFiller().slice(0, limit)) {
    // Only orders that have gone nowhere at all. `sent` means the queue
    // already has it; `rejected` and `failed` are answers somebody has to
    // read, not conditions to retry behind their back.
    if (order.transmission.state !== "not-sent") continue;
    hand(deps, order, "order", result);
  }

  return result;
}

/**
 * Withdraws every cancelled order a laboratory could still act on.
 *
 * The other half, and the half whose absence is silent. An order that never
 * left shows up on a worklist as an order no laboratory has; a cancellation
 * that never left shows up as an order that *was* cancelled — the chart says
 * so, the clinician saw it, and the only thing that disagrees is a
 * requisition on a bench four hundred kilometres away. So a sweep that
 * carried orders out and not withdrawals would not read as half-finished. It
 * would read as working.
 *
 * The list is `cancellationsNotSent`, which is deliberately not the worklist's
 * `cancelledButStillWithFiller`: see there for why an order still sitting in
 * the outbound queue is chased too.
 */
export function dispatchCancellations(deps: DispatchDeps, limit = 50): DispatchResult {
  const result: DispatchResult = { enqueued: [], unbuildable: [] };
  for (const order of deps.orders.cancellationsNotSent().slice(0, limit)) {
    hand(deps, order, "cancel", result);
  }
  return result;
}

/**
 * Builds one order or one withdrawal and hands it to the queue, or says why
 * it could not. Shared so that a message and its withdrawal cannot drift
 * apart in how they are addressed, queued or recorded.
 */
function hand(deps: DispatchDeps, order: OrderRow, kind: "order" | "cancel", result: DispatchResult): void {
  const routing = deps.orders.orderRouting(order.category);
  if (!routing?.transmits) return;
  const profile = deps.profiles(routing.profile_id ?? "");
  if (!profile) {
    result.unbuildable.push({
      order: order.id,
      missing: ["profile"],
      reason:
        `this route builds against laboratory profile ${routing.profile_id}, which is not loaded. ` +
        "A message built against a profile nobody has is a message built against a guess.",
    });
    return;
  }

  const patient = deps.patients.get(order.patient_id);
  const context = contextFor(routing, order.ordered_by);
  const built =
    kind === "cancel"
      ? buildOrderCancel(order, patient, context, profile)
      : buildOml(order, patient, context, profile);

  if (!built.built) {
    result.unbuildable.push({ order: order.id, missing: built.missing, reason: built.reason });
    return;
  }

  // One transaction. A crash between the enqueue and the record would leave
  // an order on the queue still reading as never sent, and the next sweep
  // would enqueue it again -- two requisitions for one specimen.
  deps.db.transaction(() => {
    const message = deps.db.insertMessage(deps.channelId, "order-dispatch", "x-application/hl7-v2+er7", built.message, {
      orderId: order.id,
      controlId: built.controlId,
      kind,
      destination: routing.destination,
    });
    deps.db.enqueueDelivery({
      messageId: message.id,
      channelId: deps.channelId,
      destinationId: deps.destinationId,
      seq: message.seq,
      // Ordered, which is what keeps a withdrawal behind the order it
      // withdraws: the laboratory reads ORC-1 NW and then ORC-1 CA in the
      // order they were queued, rather than being asked to cancel something
      // it has not been given yet.
      ordered: true,
      skipOnDead: true,
      maxAttempts: 5,
      payload: built.message,
      contentType: "x-application/hl7-v2+er7",
    });
    deps.orders.recordTransmission(
      order.id,
      {
        kind,
        outcome: "sent",
        destination: routing.destination ?? deps.destinationId,
        controlId: built.controlId,
        detail: "handed to the outbound queue",
      },
      SYSTEM
    );
  });
  result.enqueued.push(order.id);
}
