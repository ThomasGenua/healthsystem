/**
 * Handing an order to a laboratory, and recording honestly what came back.
 *
 * `outbound.ts` builds the message and refuses to build a wrong one.
 * `store.ts` holds the states. This is the only place the two meet a socket,
 * and it exists as its own module because every step of it can fail in a way
 * that must not be read as success:
 *
 *   - The build refuses          -> nothing is sent, and nothing is recorded
 *                                   as sent.
 *   - The transport throws       -> `failed`, which reads as *not sent*, not
 *                                   as sent-and-waiting.
 *   - The reply is not an ACK    -> `failed`.
 *   - The ACK answers another
 *     message                    -> `failed`. See `interpretAck`.
 *   - The ACK is negative        -> `rejected`, and the order is not with them.
 *
 * The attempt is recorded **before** the send, not after. A process that dies
 * between writing to the socket and writing to the database would otherwise
 * leave an order that reads as never sent while a laboratory holds it — and a
 * clinician resending it produces two requisitions for one specimen. Recording
 * first makes the ambiguous case say `sent`, which is the true statement: it
 * went, and nothing has confirmed it arrived.
 */
import { mllpSend } from "../hl7/mllp.ts";
import { buildOml, buildOrderCancel, interpretAck, type OmlContext } from "./outbound.ts";
import type { Actor, OrderStore, TransmissionRow, TransmissionState } from "./store.ts";
import type { PatientIndex } from "../clinical/patients.ts";
import type { LabProfile } from "./hl7.ts";

export interface SendTarget {
  host: string;
  port: number;
  timeoutMs?: number;
}

export interface SendDeps {
  orders: OrderStore;
  patients: PatientIndex;
  profile: LabProfile;
  /** Injectable so the tests exercise the real decisions without a socket. */
  transport?: (target: SendTarget, message: string) => Promise<string>;
}

export type SendResult =
  | { sent: true; state: TransmissionState; attempts: TransmissionRow[]; controlId: string }
  | { sent: false; reason: string; missing?: string[]; state: TransmissionState };

async function deliver(
  deps: SendDeps,
  orderId: string,
  kind: "order" | "cancel",
  target: SendTarget,
  ctx: OmlContext,
  by: Actor
): Promise<SendResult> {
  const order = deps.orders.get(orderId);
  if (!order) return { sent: false, reason: `no order ${orderId}`, state: { state: "not-sent", detail: "unknown order" } };

  const routing = deps.orders.orderRouting(order.category);
  if (!routing || !routing.transmits) {
    const state = deps.orders.transmissionState(orderId);
    return {
      sent: false,
      reason:
        `${order.category} orders are not declared to leave this site, so nothing was sent. ` +
        "Declare a route before sending, rather than sending against an undeclared one.",
      state,
    };
  }

  const patient = deps.patients.get(order.patient_id);
  const built = kind === "cancel"
    ? buildOrderCancel(order, patient, ctx, deps.profile)
    : buildOml(order, patient, ctx, deps.profile);

  if (!built.built) {
    // Deliberately not recorded as an attempt. Nothing was handed to anybody,
    // and a `failed` row here would read as "we tried and the line was down".
    return {
      sent: false,
      reason: built.reason,
      missing: built.missing,
      state: kind === "cancel" ? deps.orders.cancellationState(orderId) : deps.orders.transmissionState(orderId),
    };
  }

  const destination = routing.destination ?? `${target.host}:${target.port}`;
  deps.orders.recordTransmission(
    orderId,
    {
      kind,
      outcome: "sent",
      destination,
      controlId: built.controlId,
      detail: kind === "cancel" ? "cancellation handed to the transport" : "order handed to the transport",
    },
    by
  );

  const send = deps.transport ?? ((t, m) => mllpSend(t.host, t.port, m, t.timeoutMs ?? 10_000));
  let ack: string;
  try {
    ack = await send(target, built.message);
  } catch (err) {
    deps.orders.recordTransmission(
      orderId,
      { kind, outcome: "failed", destination, controlId: built.controlId, detail: (err as Error).message },
      by
    );
    return {
      sent: false,
      reason: `the transport failed: ${(err as Error).message}`,
      state: kind === "cancel" ? deps.orders.cancellationState(orderId) : deps.orders.transmissionState(orderId),
    };
  }

  const verdict = interpretAck(ack, built.controlId);
  deps.orders.recordTransmission(
    orderId,
    { kind, outcome: verdict.outcome, destination, controlId: built.controlId, detail: verdict.detail },
    by
  );

  const state = kind === "cancel" ? deps.orders.cancellationState(orderId) : deps.orders.transmissionState(orderId);
  if (verdict.outcome === "acknowledged") {
    return { sent: true, state, attempts: deps.orders.transmissions(orderId, kind), controlId: built.controlId };
  }
  return { sent: false, reason: verdict.detail, state };
}

/** Sends a placed order and records what the laboratory said. */
export function sendOrder(
  deps: SendDeps,
  orderId: string,
  target: SendTarget,
  ctx: OmlContext,
  by: Actor
): Promise<SendResult> {
  return deliver(deps, orderId, "order", target, ctx, by);
}

/**
 * Sends the cancellation for an order cancelled here.
 *
 * Worth sending even when the original was only `sent` rather than
 * acknowledged: if it did arrive, this withdraws it, and if it did not, a
 * cancellation for an order the laboratory never had is harmless. The
 * asymmetry is deliberate — the cost of an unnecessary cancellation is an
 * ignored message, and the cost of a missing one is a specimen taken from a
 * patient who was told the test was called off.
 */
export function sendOrderCancellation(
  deps: SendDeps,
  orderId: string,
  target: SendTarget,
  ctx: OmlContext,
  by: Actor
): Promise<SendResult> {
  return deliver(deps, orderId, "cancel", target, ctx, by);
}
