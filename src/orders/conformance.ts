/**
 * What a laboratory's own messages do against a profile, before anybody
 * trusts the interface.
 *
 * A laboratory interface is agreed on paper and then discovered in practice.
 * The specification says the accession number is in ORC-3; the messages put it
 * in OBR-3. The specification does not mention a timezone; the messages carry
 * timestamps with no offset, and every result lands an hour out. None of that
 * is visible until real messages meet real parsing code, and by then the
 * interface is usually live.
 *
 * So this reads a set of the laboratory's own sample messages against a
 * profile and says, per message and in aggregate, exactly what happened: what
 * parsed, what refused and why, which fields were absent, and which
 * assumptions had to be made. It is the artifact to take *into* a connectivity
 * test rather than the report written after one.
 *
 * ## What it will not tell you
 *
 * That the interface conforms. It cannot: it reports what these messages did
 * against this profile, and a sample set that happens to contain no corrected
 * result says nothing whatever about corrected results. The report says so on
 * its face rather than leaving a reader to assume coverage it never had.
 *
 * It also does not write a profile. Guessing field locations from a sample and
 * calling the result a vendor interface is exactly the failure `labs/README.md`
 * refuses — a site that configured a vendor profile and silently got a guess
 * would believe it had an interface it does not have. What this does is show
 * which fields a profile would need to name, so that filling one in from the
 * laboratory's specification is a short job rather than an excavation.
 */
import { Refusal } from "../core/refusal.ts";
import { GENERIC_LAB_PROFILE, parseOru, type LabProfile, type ParsedOru } from "./hl7.ts";

/** Something worth a human's attention about one message. */
export interface ConformanceFinding {
  /** Machine-readable, so a report can be diffed between releases. */
  kind:
    | "unparsed"
    | "no-filler-order-number"
    | "no-placer-order-number"
    | "no-patient-identifier"
    | "identifier-authority-undeclared"
    | "identifier-ambiguous"
    | "timezone-assumed"
    | "no-observations"
    | "unmapped-panel-code";
  /** Why it matters, in the words a person would use to raise it with the lab. */
  detail: string;
  /** True when this stops the message being filed at all. */
  blocking: boolean;
}

export interface MessageReading {
  /** Index in the supplied set, so a finding can be traced to a file. */
  index: number;
  label: string;
  parsed: boolean;
  messageControlId: string | null;
  observationCount: number;
  findings: ConformanceFinding[];
}

export interface ConformanceReport {
  profileId: string;
  profileName: string;
  messagesRead: number;
  messagesParsed: number;
  messagesRefused: number;
  /** Every finding raised, counted by kind, for the summary a lab wants. */
  byKind: Record<string, number>;
  messages: MessageReading[];
  /**
   * What this report does not establish. Always populated: there is no
   * combination of results that makes a sample set into a conformance
   * statement, and a report that could read as one would be worse than none.
   */
  limits: string[];
}

/**
 * Reads one message and says what it did.
 *
 * A refusal from the parser is a finding rather than an exception: the point
 * of the exercise is to collect every problem in one pass, and stopping at the
 * first would turn a fifty-message sample into fifty round trips.
 */
function readOne(raw: string, index: number, label: string, profile: LabProfile): MessageReading {
  const findings: ConformanceFinding[] = [];
  let parsed: ParsedOru;
  try {
    parsed = parseOru(raw, profile);
  } catch (err) {
    return {
      index,
      label,
      parsed: false,
      messageControlId: null,
      observationCount: 0,
      findings: [
        {
          kind: "unparsed",
          detail: err instanceof Refusal || err instanceof Error ? err.message : String(err),
          blocking: true,
        },
      ],
    };
  }

  // Deduplication hangs off the filler order number. A laboratory that sends
  // none cannot have its resends told apart from new results, and a resend on
  // reconnect then fills the unacknowledged queue with duplicates of results
  // somebody already actioned.
  if (!parsed.fillerOrderNumber) {
    findings.push({
      kind: "no-filler-order-number",
      detail:
        "no filler order number in any path this profile names, so a retransmission cannot be told from a new result. " +
        "Ask the laboratory which field carries their accession number.",
      blocking: false,
    });
  }

  // The placer number is how a result closes the requisition this clinic
  // issued. Without it the result files, but nothing closes.
  if (!parsed.placerOrderNumber) {
    findings.push({
      kind: "no-placer-order-number",
      detail:
        "no placer order number, so this result cannot close the order it answers — it will file as unsolicited. " +
        "Ask whether the laboratory echoes the requisition number, and in which field.",
      blocking: false,
    });
  }

  if (parsed.patient.identifiers.length === 0) {
    findings.push({
      kind: "no-patient-identifier",
      detail:
        "no patient identifier in PID-3, so this result cannot be matched to a chart and would be held for identity. " +
        "This is the correct behaviour and an unusable interface: the laboratory has to send an identifier.",
      blocking: true,
    });
  } else if (parsed.patient.identifiers.length > 1 && !profile.patientAssigningAuthority) {
    // The ordinary case: a lab sends the health number and its own accession
    // number in the same repeating field. Matching the wrong one finds nobody,
    // or somebody else.
    findings.push({
      kind: "identifier-authority-undeclared",
      detail:
        `${parsed.patient.identifiers.length} identifiers in PID-3 (` +
        parsed.patient.identifiers.map((i) => `${i.assigningAuthority || "?"}:${i.typeCode || "?"}`).join(", ") +
        ") and the profile declares no patientAssigningAuthority. Declare which one is the health number.",
      blocking: false,
    });
  } else if (
    profile.patientAssigningAuthority &&
    !parsed.patient.identifiers.some((i) => i.assigningAuthority === profile.patientAssigningAuthority)
  ) {
    findings.push({
      kind: "identifier-ambiguous",
      detail:
        `the profile expects assigning authority "${profile.patientAssigningAuthority}" but this message sends ` +
        (parsed.patient.identifiers.map((i) => i.assigningAuthority || "(none)").join(", ") || "(none)") +
        ". Every result from this laboratory would be held for identity.",
      blocking: true,
    });
  }

  const assumed = parsed.observations.filter((o) => o.timezoneAssumed).length;
  if (assumed > 0) {
    findings.push({
      kind: "timezone-assumed",
      detail:
        `${assumed} of ${parsed.observations.length} observation time(s) carry no zone and the profile declares no ` +
        "timezoneOffset, so they are filed with the assumption flagged. A result an hour out is a result on the " +
        "wrong side of a shift change.",
      blocking: false,
    });
  }

  if (parsed.observations.length === 0) {
    findings.push({ kind: "no-observations", detail: "the message carries no OBX, so there is no result to file.", blocking: true });
  }

  if (!parsed.panelCode) {
    findings.push({
      kind: "unmapped-panel-code",
      detail: "OBR-4 carries no panel code, so the battery this answers cannot be named on the chart.",
      blocking: false,
    });
  }

  return {
    index,
    label,
    parsed: true,
    messageControlId: parsed.messageControlId || null,
    observationCount: parsed.observations.length,
    findings,
  };
}

/**
 * Runs a sample set against a profile.
 *
 * `labels` lets a caller name each message — a filename, usually — so a
 * finding points at something a person can open.
 */
export function checkConformance(
  messages: string[],
  opts: { profile?: LabProfile; labels?: string[] } = {}
): ConformanceReport {
  const profile = opts.profile ?? GENERIC_LAB_PROFILE;
  const readings = messages.map((raw, i) => readOne(raw, i, opts.labels?.[i] ?? `message ${i + 1}`, profile));

  const byKind: Record<string, number> = {};
  for (const r of readings) {
    for (const f of r.findings) byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;
  }

  const parsedCount = readings.filter((r) => r.parsed).length;
  const limits = [
    `This report describes ${messages.length} message(s) against profile "${profile.id}". It is not a statement ` +
      "that the interface conforms, and no number of passing messages would make it one.",
    "A sample set exercises only what it happens to contain: if none of these messages is a corrected or " +
      "cancelled result, nothing here says how those behave.",
    "Nothing was inferred into a profile. Field locations come from the laboratory's specification, not from " +
      "what a sample happened to put where.",
  ];
  if (profile.id === GENERIC_LAB_PROFILE.id) {
    limits.push(
      "This ran against the generic standards-conformant reading rather than a vendor profile. A laboratory that " +
        "departs from the standard will show findings here that a correct profile would resolve."
    );
  }

  return {
    profileId: profile.id,
    profileName: profile.name,
    messagesRead: messages.length,
    messagesParsed: parsedCount,
    messagesRefused: messages.length - parsedCount,
    byKind,
    messages: readings,
    limits,
  };
}

/** The report as text, for a terminal or an email to an integration analyst. */
export function formatReport(report: ConformanceReport): string {
  const lines: string[] = [];
  lines.push(`Laboratory ORU conformance reading`);
  lines.push(`profile: ${report.profileId} — ${report.profileName}`);
  lines.push(`messages: ${report.messagesRead} read, ${report.messagesParsed} parsed, ${report.messagesRefused} refused`);
  lines.push("");

  if (Object.keys(report.byKind).length === 0) {
    lines.push("No findings. Every message parsed and carried everything this profile looks for.");
  } else {
    lines.push("Findings by kind:");
    for (const [kind, n] of Object.entries(report.byKind).sort((a, b) => b[1] - a[1])) {
      lines.push(`  ${String(n).padStart(4)}  ${kind}`);
    }
  }
  lines.push("");

  for (const m of report.messages) {
    if (m.findings.length === 0) continue;
    lines.push(`${m.label}${m.messageControlId ? ` (MSH-10 ${m.messageControlId})` : ""}`);
    for (const f of m.findings) {
      lines.push(`  ${f.blocking ? "BLOCKING" : "note    "}  ${f.kind}`);
      lines.push(`            ${f.detail}`);
    }
    lines.push("");
  }

  lines.push("What this does not establish:");
  for (const l of report.limits) lines.push(`  - ${l}`);
  return lines.join("\n");
}
