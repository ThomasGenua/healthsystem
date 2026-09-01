/**
 * Handing placed orders to the outbound queue, exactly once.
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
import type { Actor, OrderRouting, OrderStore } from "./store.ts";
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

    const routing = deps.orders.orderRouting(order.category);
    if (!routing?.transmits) continue;
    const profile = deps.profiles(routing.profile_id ?? "");
    if (!profile) {
      result.unbuildable.push({
        order: order.id,
        missing: ["profile"],
        reason:
          `this route builds against laboratory profile ${routing.profile_id}, which is not loaded. ` +
          "A message built against a profile nobody has is a message built against a guess.",
      });
      continue;
    }

    const patient = deps.patients.get(order.patient_id);
    const cancelling = order.status === "cancelled";
    const built = cancelling
      ? buildOrderCancel(order, patient, contextFor(routing, order.ordered_by), profile)
      : buildOml(order, patient, contextFor(routing, order.ordered_by), profile);

    if (!built.built) {
      result.unbuildable.push({ order: order.id, missing: built.missing, reason: built.reason });
      continue;
    }

    // One transaction. A crash between the enqueue and the record would leave
    // an order on the queue still reading as never sent, and the next sweep
    // would enqueue it again -- two requisitions for one specimen.
    deps.db.transaction(() => {
      const message = deps.db.insertMessage(deps.channelId, "order-dispatch", "x-application/hl7-v2+er7", built.message, {
        orderId: order.id,
        controlId: built.controlId,
        kind: cancelling ? "cancel" : "order",
        destination: routing.destination,
      });
      deps.db.enqueueDelivery({
        messageId: message.id,
        channelId: deps.channelId,
        destinationId: deps.destinationId,
        seq: message.seq,
        ordered: true,
        skipOnDead: true,
        maxAttempts: 5,
        payload: built.message,
        contentType: "x-application/hl7-v2+er7",
      });
      deps.orders.recordTransmission(
        order.id,
        {
          kind: cancelling ? "cancel" : "order",
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

  return result;
}
