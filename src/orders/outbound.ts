/**
 * Turning an order into the message that actually asks for it.
 *
 * `store.ts` records that an order was placed and, since the transmission
 * work, whether anybody was ever told. This is the piece that does the
 * telling: an OML^O21 a laboratory's interface engine will accept.
 *
 * The whole module is built around refusing. An order message that is
 * *nearly* right is worse than none at all, because the failure is not a
 * rejection — it is a requisition that files somewhere. A blank patient
 * identifier gets rejected, which is fine. A *plausible* one gets accepted and
 * matched, and the specimen is drawn against somebody else's chart. So every
 * field that could send a result to the wrong patient, or bring it back
 * unmatchable, is required rather than defaulted, and a message that cannot be
 * built completely is not built at all.
 *
 * ## What is refused, and why each one
 *
 *   - **No declared assigning authority.** A laboratory receives PID-3 and
 *     files it under whichever numbering it believes you sent. Guessing which
 *     of a patient's identifiers is the health number is the same mistake the
 *     inbound side refuses to make, in the direction that is harder to detect:
 *     inbound, the wrong guess finds nobody; outbound, it creates a record.
 *
 *   - **No identifier under that authority.** Sending the order without one,
 *     or with a different one, asks the laboratory to guess instead.
 *
 *   - **No birth date.** It is the check digit of patient matching. Labs
 *     verify against it, and a requisition that cannot be verified is either
 *     rejected on receipt or accepted on the name alone — and names are not
 *     unique in a community of four hundred people.
 *
 *   - **No timezone.** A collection time an hour out is on the wrong side of a
 *     shift change, and a fasting glucose an hour early is a different test.
 *     Declared, never inferred from this machine's clock.
 *
 *   - **An order nobody placed.** A draft is a clinician thinking. Sending it
 *     books a specimen collection for a test that was never ordered.
 *
 * ## What this deliberately does not do
 *
 * Choose the laboratory. Routing is declared per category in `store.ts` and
 * the caller passes the destination it resolved; a builder that picked its own
 * recipient from a code would be inventing clinical routing out of a lookup
 * table.
 *
 * It also does not send. Building and transmitting are separate so a message
 * can be produced, inspected and shown to a laboratory's integration analyst
 * during commissioning without anything being on a wire — which is exactly how
 * the first conversation with Dynacare or LifeLabs will go.
 */
import { escapeHl7, type Hl7Delimiters } from "../hl7/parser.ts";
import type { PatientSummary } from "../clinical/patients.ts";
import type { LabProfile } from "./hl7.ts";
import type { OrderRow, OrderPriority } from "./store.ts";

const D: Hl7Delimiters = { field: "|", component: "^", repetition: "~", escape: "\\", subcomponent: "&" };

export type OmlResult =
  | {
      built: true;
      message: string;
      controlId: string;
      /** Our requisition number. The laboratory echoes it, and it is how the result comes home. */
      placerOrderNumber: string;
      /** Exactly which identifier went out, so a rejection can be diagnosed without guessing. */
      identifier: { authority: string; value: string };
    }
  | { built: false; missing: string[]; reason: string };

export interface OmlContext {
  sendingApplication: string;
  sendingFacility: string;
  receivingApplication: string;
  receivingFacility: string;
  /**
   * The offset to stamp on every timestamp, e.g. "-06:00". Required, and not
   * read from this machine: a server in one timezone sending for a clinic in
   * another is ordinary in the north, and the clinic's is the one that matters.
   */
  timezoneOffset: string;
  orderingProvider: { id: string; family: string; given?: string };
  /** Overridable so a message is reproducible under test. */
  controlId?: string;
  now?: string;
}

/** HL7 priority codes. `stat` is the one that must never be silently downgraded. */
const PRIORITY: Record<OrderPriority, string> = { routine: "R", urgent: "A", stat: "S" };

/**
 * Formats an instant as HL7 YYYYMMDDHHMMSS with an explicit offset.
 *
 * The offset is appended rather than applied: the caller declared the clinic's
 * zone, and rewriting the instant into it would quietly change the time this
 * says the order was placed.
 */
function stamp(iso: string, offset: string): string {
  const d = new Date(iso);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const base =
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
  return `${base}${offset.replace(":", "")}`;
}

function e(value: string): string {
  return escapeHl7(value, D);
}

/**
 * Builds a segment from explicit field numbers.
 *
 * Positional arrays are how HL7 field errors happen: a run of empty strings
 * between two values is uncountable by eye, and one too many silently shifts
 * everything after it. That is not a message that fails — the indication
 * arrives in Specimen Received Date/Time and the ordering provider in the
 * callback phone number, and a laboratory either rejects it or files it. Both
 * of those were in the first draft of this file, found by reading the bytes
 * rather than by rereading the array.
 *
 * Numbers here are HL7 field numbers, so `{ 13: indication }` is OBR-13 and
 * can be checked against a specification without counting anything.
 */
function segment(name: string, fields: Record<number, string>): string {
  const max = Math.max(...Object.keys(fields).map(Number));
  const out = [name];
  for (let i = 1; i <= max; i++) out.push(fields[i] ?? "");
  return out.join(D.field);
}

/**
 * Builds an OML^O21 for a placed order, or says what it is missing.
 *
 * Never partially builds. The `missing` list is every field that stopped it,
 * not the first — an integration analyst commissioning an interface wants one
 * list, not five round trips.
 */
export function buildOml(
  order: OrderRow,
  patient: PatientSummary | undefined,
  ctx: OmlContext,
  profile: LabProfile
): OmlResult {
  const missing: string[] = [];

  if (order.status === "draft") {
    return {
      built: false,
      missing: ["order.status"],
      reason:
        "this order is still a draft. A draft is a clinician thinking; sending it books a collection " +
        "for a test nobody has ordered.",
    };
  }
  if (order.status === "cancelled") {
    return {
      built: false,
      missing: ["order.status"],
      reason: "this order was cancelled. Sending it would ask for a specimen nobody wants taken.",
    };
  }

  if (!ctx.timezoneOffset || !/^[+-]\d{2}:?\d{2}$/.test(ctx.timezoneOffset)) {
    missing.push("timezoneOffset");
  }
  if (!patient) missing.push("patient");
  if (patient && !patient.birthDate) missing.push("patient.birthDate");
  if (patient && !patient.family) missing.push("patient.family");

  const authority = profile.patientAssigningAuthority;
  if (!authority) missing.push("profile.patientAssigningAuthority");

  let identifier: { authority: string; value: string } | undefined;
  if (patient && authority) {
    const match = patient.identifiers.find((i) => i.system === authority);
    if (match) identifier = { authority, value: match.value };
    else missing.push(`patient identifier under ${authority}`);
  }

  if (!ctx.orderingProvider?.id) missing.push("orderingProvider.id");
  if (!ctx.orderingProvider?.family) missing.push("orderingProvider.family");

  if (missing.length > 0) {
    return {
      built: false,
      missing,
      reason:
        `this order cannot be sent as it stands: ${missing.join(", ")}. Nothing was built — a message with ` +
        "a guessed identifier is not rejected, it is accepted and matched to somebody.",
    };
  }

  const now = ctx.now ?? new Date().toISOString();
  const controlId = ctx.controlId ?? `NS${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const at = stamp(now, ctx.timezoneOffset);
  const orderedAt = stamp(order.ordered_at ?? now, ctx.timezoneOffset);
  const p = patient!;
  const id = identifier!;
  const provider = `${e(ctx.orderingProvider.id)}^${e(ctx.orderingProvider.family)}^${e(ctx.orderingProvider.given ?? "")}`;

  // MSH is the one segment that cannot go through segment(): MSH-1 *is* the
  // field separator and MSH-2 the encoding characters, so the first two
  // "fields" are the delimiters themselves.
  const msh = [
    "MSH",
    "^~\\&",
    e(ctx.sendingApplication),
    e(ctx.sendingFacility),
    e(ctx.receivingApplication),
    e(ctx.receivingFacility),
    at,
    "",
    "OML^O21^OML_O21",
    e(controlId),
    "P",
    "2.5.1",
  ].join(D.field);

  const pid = segment("PID", {
    1: "1",
    3: `${e(id.value)}^^^${e(id.authority)}^${e(id.authority)}`,
    5: `${e(p.family!)}^${e(p.given ?? "")}`,
    7: p.birthDate!.replace(/-/g, ""),
    8: e(p.gender ?? ""),
  });

  // ORC-1 NW: a new order. Never RP or CA from here — a change to a placed
  // order is its own message, and reusing NW for one is how a laboratory ends
  // up holding two requisitions for one specimen.
  const orc = segment("ORC", {
    1: "NW",
    2: e(order.id),
    9: orderedAt,
    12: provider,
  });

  const obr = segment("OBR", {
    1: "1",
    2: e(order.id),
    4: `${e(order.code)}^${e(order.display)}^${e(order.code_system ?? profile.defaultCodeSystem ?? "LN")}`,
    5: PRIORITY[order.priority],
    // OBR-6 Requested Date/Time, not OBR-7. For an order the specimen has not
    // been collected, and OBR-7 is when it was — putting the order time there
    // asserts a collection that has not happened.
    6: orderedAt,
    // OBR-13 Relevant Clinical Information: what the laboratory needs to
    // interpret the result and to judge whether the test was appropriate. The
    // order store refuses an order without one.
    13: e(order.indication),
    16: provider,
  });

  return {
    built: true,
    message: [msh, pid, orc, obr].join("\r") + "\r",
    controlId,
    placerOrderNumber: order.id,
    identifier: id,
  };
}
