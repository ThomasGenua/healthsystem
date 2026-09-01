/**
 * Reading a laboratory ORU^R01 into something the order loop can file.
 *
 * There was already a channel that mapped ORU messages onto the FHIR facade,
 * and it was easy to mistake for a laboratory interface. It is not one. The
 * facade is a copy of a resource; the clinical question is whether the test
 * somebody ordered came back, whether the value replaced an earlier one, and
 * whether anybody has read it. That lives in `OrderStore`, and until this
 * module nothing connected the two — a result could arrive, be stored as an
 * Observation, and leave the order it answered sitting on the overdue list
 * forever.
 *
 * ## What is deliberately data rather than code
 *
 * Every laboratory sends a slightly different ORU. They disagree about which
 * field carries the requisition number, which assigning authority stamps the
 * health number, and whether local codes or LOINC lead. Those differences are
 * a `LabProfile` — a JSON document an operator writes — because the
 * alternative is a fork per laboratory, and a fork per laboratory is how a
 * platform stops being one platform.
 *
 * What is *not* configurable is the meaning of a result status or an abnormal
 * flag. Those come from HL7 tables 0085 and 0078, and letting a site redefine
 * "critical" is not flexibility.
 *
 * ## Timestamps
 *
 * An HL7 timestamp with no offset is ambiguous, and a result an hour out is a
 * result on the wrong side of a shift change. `hl7DateToIso` in the parser
 * drops offsets entirely, which is fine for a display string and not fine
 * here, so this module reads them: an explicit offset is used, a profile's
 * declared offset is applied when the message carries none, and a timestamp
 * with neither is returned as naive with `timezoneAssumed` set so the caller
 * can say so rather than quietly inventing UTC.
 */
import { getHl7, parseHl7, type Hl7Message } from "../hl7/parser.ts";
import { refuse } from "../core/refusal.ts";
import type { AbnormalFlag, ResultStatus } from "./store.ts";

/**
 * One laboratory's dialect. Written as configuration, loaded per channel.
 *
 * Nothing here changes what a value means — only where to find it.
 */
export interface LabProfile {
  id: string;
  name: string;
  /**
   * The identifier system a matched patient identifier is recorded under, so
   * the patient index is searched with the same system the registration feed
   * wrote. Without it the search falls back to a bare value match, which is
   * wider than it should be and is reported as such.
   */
  patientIdentifierSystem?: string;
  /**
   * PID-3.4, the assigning authority whose identifier is the health number.
   * A lab that sends its own accession number in the same field is the
   * ordinary case, and matching on the wrong one finds nobody — or worse,
   * finds somebody else.
   */
  patientAssigningAuthority?: string;
  /** Where the requisition number this clinic issued appears. */
  placerOrderPaths?: string[];
  /** Where the laboratory's own accession number appears. */
  fillerOrderPaths?: string[];
  /**
   * Offset applied to timestamps that carry none, e.g. "-05:00". Declared
   * rather than guessed: a laboratory in one timezone reporting to a clinic in
   * another is normal in Canada.
   */
  timezoneOffset?: string;
  /** Preferred coding system when the message does not name one. */
  defaultCodeSystem?: string;
  /**
   * Questions this laboratory requires answered before it will run a test,
   * keyed by the ordered test's code.
   *
   * Ask-at-order-entry is not paperwork. A glucose reported against a fasting
   * reference interval when the patient had breakfast is a wrong result, not a
   * missing one, and the laboratory cannot tell the difference from the
   * specimen. Which questions apply is the laboratory's own statement, so it
   * lives in their profile rather than being inferred from the test code.
   */
  askAtOrderEntry?: Record<string, AoeQuestion[]>;
}

/** A question a laboratory requires answered before it will run a test. */
export interface AoeQuestion {
  /** The observation identifier the answer is reported under, e.g. a LOINC code. */
  code: string;
  /** How the question reads to whoever has to answer it. */
  text: string;
  /**
   * Whether the laboratory refuses the order without it.
   *
   * A question that is not required is still asked and still sent when
   * answered — the flag decides whether its absence stops the order, not
   * whether it matters.
   */
  required: boolean;
  /** Units the answer must be in, where the answer is a quantity. */
  units?: string;
}

export const GENERIC_LAB_PROFILE: LabProfile = {
  id: "generic-oru",
  name: "Generic HL7 v2.x ORU^R01",
  placerOrderPaths: ["ORC-2.1", "OBR-2.1"],
  fillerOrderPaths: ["ORC-3.1", "OBR-3.1"],
};

/** An identifier as the message carried it. */
export interface MessageIdentifier {
  value: string;
  assigningAuthority: string;
  typeCode: string;
}

export interface ParsedObservation {
  /** OBX-3.1, the analyte. */
  code: string;
  codeSystem: string | null;
  display: string;
  /** OBX-4. Distinguishes two of the same analyte on one specimen. */
  subId: string;
  value: string;
  unit: string | null;
  referenceRange: string | null;
  abnormalFlag: AbnormalFlag;
  resultStatus: ResultStatus;
  observedAt: string | null;
  /** True when a time was read without any zone information at all. */
  timezoneAssumed: boolean;
  /** OBX-11 exactly as sent, kept because a mapping is an interpretation. */
  rawStatus: string;
  /** OBX-8 exactly as sent, for the same reason. */
  rawFlag: string;
  /** Free-text NTE lines attached to this observation. */
  notes: string[];
}

export interface ParsedOru {
  messageControlId: string;
  sendingApplication: string;
  sendingFacility: string;
  patient: {
    identifiers: MessageIdentifier[];
    family: string;
    given: string;
    birthDate: string;
  };
  placerOrderNumber: string;
  fillerOrderNumber: string;
  /** OBR-4, the panel or battery. */
  panelCode: string;
  panelDisplay: string;
  reportedAt: string | null;
  observations: ParsedObservation[];
  profileId: string;
}

/**
 * HL7 table 0085. A status this does not recognise is refused rather than
 * defaulted: filing an unknown status as `final` would start an
 * acknowledgement clock on something the laboratory may not have finished,
 * and filing it as `preliminary` would silence one it had.
 */
const RESULT_STATUS: Record<string, ResultStatus> = {
  P: "preliminary",
  R: "preliminary",
  S: "preliminary",
  I: "preliminary",
  F: "final",
  U: "final",
  C: "corrected",
  X: "cancelled",
  D: "cancelled",
  W: "cancelled",
};

/**
 * HL7 table 0078. `AA` is "critically abnormal" and is treated as critical
 * without a direction, because a critical result with no direction still has
 * to be on the critical clock.
 */
const ABNORMAL_FLAG: Record<string, AbnormalFlag> = {
  "": "normal",
  N: "normal",
  L: "low",
  H: "high",
  LL: "critical-low",
  HH: "critical-high",
  "<": "low",
  ">": "high",
  A: "abnormal",
  AA: "abnormal",
  S: "abnormal",
  R: "abnormal",
  I: "abnormal",
  MS: "abnormal",
  VS: "abnormal",
};

/** True when the flag means "act now", whatever direction it points. */
export function isCriticalFlag(raw: string): boolean {
  const f = raw.trim().toUpperCase();
  return f === "LL" || f === "HH" || f === "AA";
}

/**
 * An HL7 timestamp as an instant, honouring an offset when there is one.
 *
 * Returns the naive form and `assumed: true` when neither the message nor the
 * profile says which zone it is in. The caller records that rather than
 * pretending: "we do not know which hour this was" is a fact worth keeping on
 * a result whose value depends on when it was taken.
 */
export function hl7Instant(ts: string, fallbackOffset?: string): { iso: string | null; assumed: boolean } {
  const t = ts.trim();
  if (!t) return { iso: null, assumed: false };
  const m = /^(\d{4})(\d{2})(\d{2})(?:(\d{2})(\d{2})(\d{2})?(?:\.\d+)?)?([+-]\d{4}|Z)?/.exec(t);
  if (!m) return { iso: null, assumed: false };
  const [, y, mo, da, h, mi, s, zone] = m;
  if (!h) return { iso: `${y}-${mo}-${da}`, assumed: false };
  const base = `${y}-${mo}-${da}T${h}:${mi ?? "00"}:${s ?? "00"}`;
  if (zone === "Z") return { iso: new Date(`${base}Z`).toISOString(), assumed: false };
  if (zone) {
    const offset = `${zone.slice(0, 3)}:${zone.slice(3)}`;
    return { iso: new Date(`${base}${offset}`).toISOString(), assumed: false };
  }
  if (fallbackOffset) {
    const normalised = /^[+-]\d{2}:?\d{2}$/.test(fallbackOffset.trim())
      ? fallbackOffset.trim().replace(/^([+-]\d{2})(\d{2})$/, "$1:$2")
      : null;
    if (!normalised) refuse(`lab profile timezoneOffset must look like -05:00, got ${fallbackOffset}`);
    return { iso: new Date(`${base}${normalised}`).toISOString(), assumed: false };
  }
  return { iso: base, assumed: true };
}

function firstOf(msg: Hl7Message, paths: string[]): string {
  for (const p of paths) {
    const v = getHl7(msg, p).trim();
    if (v) return v;
  }
  return "";
}

/** Every PID-3 repetition, with its assigning authority and type. */
function readIdentifiers(msg: Hl7Message): MessageIdentifier[] {
  const out: MessageIdentifier[] = [];
  // Repetitions are 1-based and there is no count that survives an empty
  // field, so this walks until two consecutive repetitions are empty rather
  // than trusting countHl7 on a field labs pad inconsistently.
  let misses = 0;
  for (let rep = 1; rep <= 20 && misses < 2; rep++) {
    const value = getHl7(msg, `PID-3[${rep}].1`).trim();
    if (!value) {
      misses++;
      continue;
    }
    misses = 0;
    out.push({
      value,
      assigningAuthority: getHl7(msg, `PID-3[${rep}].4`).trim(),
      typeCode: getHl7(msg, `PID-3[${rep}].5`).trim(),
    });
  }
  return out;
}

/**
 * Parses one ORU^R01 carrying one OBR.
 *
 * The channel splits per OBR group before this runs, because a message with
 * two batteries is two orders and filing them together would attach one
 * laboratory's accession number to the other's results.
 */
export function parseOru(raw: string, profile: LabProfile = GENERIC_LAB_PROFILE): ParsedOru {
  const msg = parseHl7(raw);
  const type = `${getHl7(msg, "MSH-9.1")}^${getHl7(msg, "MSH-9.2")}`;
  if (!type.startsWith("ORU")) {
    refuse(`not a laboratory result message: MSH-9 is ${type || "(empty)"}`);
  }
  if (!msg.segments.some((s) => s.name === "OBR")) {
    refuse("an ORU with no OBR names no test, so there is no order it could answer");
  }

  const observations: ParsedObservation[] = [];
  const segments = msg.segments;
  for (let i = 0; i < segments.length; i++) {
    if (segments[i].name !== "OBX") continue;
    // Positional rather than by index into a filtered list: an NTE belongs to
    // the OBX it follows, and filtering loses that adjacency.
    const obxNumber = observations.length + 1;
    const at = (field: string) => getHl7(msg, `OBX[${obxNumber}]-${field}`).trim();

    const rawStatus = at("11").toUpperCase();
    const status = RESULT_STATUS[rawStatus];
    if (!status) {
      refuse(`unknown OBX-11 result status "${rawStatus || "(empty)"}"; refusing rather than guessing whether it is final`);
    }
    const rawFlag = at("8").toUpperCase();
    const flag = ABNORMAL_FLAG[rawFlag];
    if (flag === undefined) {
      refuse(`unknown OBX-8 abnormal flag "${rawFlag}"; refusing rather than filing it as normal`);
    }

    const observed = hl7Instant(at("14"), profile.timezoneOffset);
    const notes: string[] = [];
    for (let j = i + 1; j < segments.length && segments[j].name === "NTE"; j++) {
      const nteNumber = segments.slice(0, j + 1).filter((s) => s.name === "NTE").length;
      const text = getHl7(msg, `NTE[${nteNumber}]-3`).trim();
      if (text) notes.push(text);
    }

    // OBX-5 can repeat, and a repeated value is one value to a human reading
    // it: "gram-positive cocci~in clusters". Joined rather than truncated,
    // because dropping the tail of a microbiology result loses the finding.
    const value = at("5");
    observations.push({
      code: at("3.1"),
      codeSystem: at("3.3") || profile.defaultCodeSystem || null,
      display: at("3.2") || at("3.1"),
      subId: at("4"),
      value,
      unit: at("6.1") || null,
      referenceRange: at("7") || null,
      abnormalFlag: flag,
      resultStatus: status,
      observedAt: observed.iso,
      timezoneAssumed: observed.assumed,
      rawStatus,
      rawFlag,
      notes,
    });
  }

  if (observations.length === 0) {
    refuse("an ORU with no OBX carries no result");
  }

  const reported = hl7Instant(getHl7(msg, "OBR-22"), profile.timezoneOffset);
  return {
    messageControlId: getHl7(msg, "MSH-10").trim(),
    sendingApplication: getHl7(msg, "MSH-3.1").trim(),
    sendingFacility: getHl7(msg, "MSH-4.1").trim(),
    patient: {
      identifiers: readIdentifiers(msg),
      family: getHl7(msg, "PID-5.1").trim(),
      given: getHl7(msg, "PID-5.2").trim(),
      birthDate: getHl7(msg, "PID-7").trim(),
    },
    placerOrderNumber: firstOf(msg, profile.placerOrderPaths ?? GENERIC_LAB_PROFILE.placerOrderPaths!),
    fillerOrderNumber: firstOf(msg, profile.fillerOrderPaths ?? GENERIC_LAB_PROFILE.fillerOrderPaths!),
    panelCode: getHl7(msg, "OBR-4.1").trim(),
    panelDisplay: getHl7(msg, "OBR-4.2").trim() || getHl7(msg, "OBR-4.1").trim(),
    reportedAt: reported.iso,
    observations,
    profileId: profile.id,
  };
}

/**
 * The identity of one reported analyte, stable across retransmission.
 *
 * The laboratory's accession number, the analyte, and the sub-id that
 * separates two of the same analyte on one specimen. This is what makes a
 * resend a no-op and a correction a correction: without it, a nightly repeat
 * of the day's results files every value a second time, and the queue fills
 * with duplicates that each need acknowledging.
 *
 * Falls back to the placer number when a laboratory sends no accession, and
 * refuses when there is neither — a result with no order identity of any kind
 * cannot be deduplicated, and silently treating every copy as new is worse
 * than saying so.
 */
export function resultKey(parsed: ParsedOru, obs: ParsedObservation): string {
  const order = parsed.fillerOrderNumber || parsed.placerOrderNumber;
  if (!order) {
    refuse("this result carries neither a filler nor a placer order number, so a resend cannot be told from a new result");
  }
  return [parsed.profileId, order, obs.code, obs.subId].join("|");
}
