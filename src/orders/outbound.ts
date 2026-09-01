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
  /**
   * Answers to this laboratory's ask-at-order-entry questions, keyed by the
   * question's code.
   *
   * Supplied rather than defaulted, and the distinction is the point. A
   * glucose reported against a fasting interval when the patient had
   * breakfast is a *wrong* result, not a missing one, and neither the
   * laboratory nor the chart can tell afterwards. An unanswered required
   * question stops the order instead.
   */
  aoeAnswers?: Record<string, string>;
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
function segment(name: string, fields: Record<number, string | undefined>): string {
  const present = Object.entries(fields).filter(([, v]) => v !== undefined);
  const max = Math.max(...present.map(([k]) => Number(k)));
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
  return build("NW", order, patient, ctx, profile);
}

/**
 * The cancellation, and the silence it closes.
 *
 * `cancel()` sets the order to cancelled here. Until this message goes, a
 * laboratory that acknowledged the order still holds it — so the specimen is
 * still collected, the test still run, and a result still comes back for a
 * test the record says nobody wanted. That is the original problem mirrored:
 * the first was claiming a laboratory had something it did not, and this is a
 * laboratory having something the record says it does not.
 *
 * ORC-1 CA, carrying the same placer order number, because a cancellation
 * naming a different requisition cancels nothing.
 */
export function buildOrderCancel(
  order: OrderRow,
  patient: PatientSummary | undefined,
  ctx: OmlContext,
  profile: LabProfile
): OmlResult {
  if (order.status !== "cancelled") {
    return {
      built: false,
      missing: ["order.status"],
      reason:
        `this order is ${order.status}, not cancelled. Sending a cancellation for an order nobody ` +
        "cancelled would stop a test somebody is waiting for.",
    };
  }
  return build("CA", order, patient, ctx, profile);
}

function build(
  control: "NW" | "CA",
  order: OrderRow,
  patient: PatientSummary | undefined,
  ctx: OmlContext,
  profile: LabProfile
): OmlResult {
  const missing: string[] = [];

  if (control === "NW" && order.status === "draft") {
    return {
      built: false,
      missing: ["order.status"],
      reason:
        "this order is still a draft. A draft is a clinician thinking; sending it books a collection " +
        "for a test nobody has ordered.",
    };
  }
  if (control === "NW" && order.status === "cancelled") {
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

  // Ask-at-order-entry. Only the questions this laboratory declares for this
  // test, and only the required ones stop the order — but an answer is never
  // invented, because the plausible default is the dangerous one: "fasting:
  // no" supplied by nobody reads exactly like "fasting: no" supplied by the
  // patient, and the reference interval turns on it.
  const questions = profile.askAtOrderEntry?.[order.code] ?? [];
  const answered = new Map<string, string>();
  for (const q of questions) {
    const given = ctx.aoeAnswers?.[q.code];
    if (given !== undefined && given.trim() !== "") {
      answered.set(q.code, given.trim());
    } else if (q.required) {
      missing.push(`answer to "${q.text}" (${q.code})`);
    }
  }

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
    1: control,
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

  // Answers ride as OBX after the OBR they qualify, which is where a
  // laboratory's engine reads them. Only answered questions are sent: an OBX
  // with an empty value asserts that somebody answered and said nothing.
  const obx = questions
    .filter((q) => answered.has(q.code))
    .map((q, i) =>
      segment("OBX", {
        1: String(i + 1),
        2: "ST",
        3: `${e(q.code)}^${e(q.text)}^${e(profile.defaultCodeSystem ?? "LN")}`,
        5: e(answered.get(q.code)!),
        ...(q.units ? { 6: e(q.units) } : {}),
        11: "O",
      })
    );

  return {
    built: true,
    message: [msh, pid, orc, obr, ...obx].join("\r") + "\r",
    controlId,
    placerOrderNumber: order.id,
    identifier: id,
  };
}

/**
 * What a laboratory's acknowledgement actually said.
 *
 * The field that matters is MSA-2, and it is the one an implementation skips.
 * MSA-1 carries the code — AA, AE, AR — and reading it alone is enough to know
 * *an* acknowledgement was positive. It is not enough to know it was an
 * acknowledgement of **this** message.
 *
 * That distinction has teeth on a real interface. Acknowledgements arrive on a
 * connection carrying other traffic, engines resend, and a slow far end can
 * answer a previous message after this one went out. An AA matched to the
 * wrong control id, recorded against this order, is the system asserting that
 * a laboratory holds a requisition it has never seen — which is the exact
 * failure the transmission work exists to prevent, reintroduced one layer up.
 *
 * So a mismatch is `failed`, never `acknowledged`. The laboratory may well
 * have the order; that is not the same as knowing they do.
 */
export type AckVerdict =
  | { outcome: "acknowledged"; code: string; detail: string }
  | { outcome: "rejected"; code: string; detail: string }
  | { outcome: "failed"; code: string | null; detail: string };

/** MSA-1 codes that mean the far end has the message. */
const ACCEPTED = new Set(["AA", "CA"]);
/** MSA-1 codes that mean it was refused, and the order is not with them. */
const REFUSED = new Set(["AE", "AR", "CE", "CR"]);

export function interpretAck(ack: string, sentControlId: string): AckVerdict {
  if (!ack || !ack.trim()) {
    return {
      outcome: "failed",
      code: null,
      detail: "nothing came back. Treat the order as not sent rather than as sent and waiting.",
    };
  }

  const msa = ack
    .split(/\r\n|\r|\n/)
    .map((l) => l.trim())
    .find((l) => l.startsWith("MSA"));
  if (!msa) {
    return {
      outcome: "failed",
      code: null,
      detail: `the reply carried no MSA segment, so it acknowledged nothing: ${ack.slice(0, 120)}`,
    };
  }

  const fields = msa.split("|");
  const code = (fields[1] ?? "").trim().toUpperCase();
  const echoed = (fields[2] ?? "").trim();
  const text = (fields[3] ?? "").trim();

  // Correlation before interpretation. A positive code for somebody else's
  // message is not a positive answer about this one.
  if (echoed !== sentControlId) {
    return {
      outcome: "failed",
      code: code || null,
      detail:
        `the acknowledgement answered message ${echoed || "(none)"}, not ${sentControlId}. ` +
        "It says nothing about this order, so this order is not known to have arrived.",
    };
  }

  if (ACCEPTED.has(code)) {
    const commit = code === "CA" ? " (commit accept: they hold the message)" : "";
    return { outcome: "acknowledged", code, detail: `${code}${commit}${text ? `: ${text}` : ""}` };
  }
  if (REFUSED.has(code)) {
    return {
      outcome: "rejected",
      code,
      detail: `${code}${text ? `: ${text}` : ""}. The order is not with them; it needs correcting and resending.`,
    };
  }
  return {
    outcome: "failed",
    code: code || null,
    detail:
      `unknown MSA-1 acknowledgement code ${code || "(empty)"}. Refusing to read it as acceptance: ` +
      "a code this does not recognise is not a code it may assume is positive.",
  };
}
