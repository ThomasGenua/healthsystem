/**
 * Procedures on the chart.
 *
 * A primary-care chart that cannot say whether a joint injection happened,
 * or why one did not, is missing a class of fact the visit notes have been
 * carrying as prose. The clinical record already accepts a `Procedure`
 * entry — this is the typed surface that writes one, so a caller cannot
 * file a completed procedure with no date, or a not-done procedure with no
 * reason, and so the chart can distinguish "never recorded" from "looked,
 * nothing on file".
 *
 * Nothing is overwritten. A correction is an amendment on the record; a
 * procedure recorded against the wrong patient is a retraction. This is
 * not a specialty procedure library and not CDS: a name, a status, a date
 * or a reason. Coding is optional and is stored as given.
 */
import type { ClinicalEntry, ClinicalRecord } from "./record.ts";
import { refuse } from "../core/refusal.ts";

export const PROCEDURE_STATUSES = ["completed", "in-progress", "not-done"] as const;
export type ProcedureStatus = (typeof PROCEDURE_STATUSES)[number];
export type ProcedureHistory = "documented" | "never-recorded";

export interface ProcedureInput {
  patientId: string;
  procedure: string;
  by: { authorId: string; authorKind: string };
  status?: ProcedureStatus;
  performedAt?: string;
  procedureCode?: string;
  procedureSystem?: string;
  reason?: string;
  encounterId?: string;
  sourceMessageId?: string;
}

export interface ProcedureView {
  recordId: string;
  patientId: string;
  encounterId: string | null;
  display: string;
  procedureCode: string | null;
  procedureSystem: string | null;
  status: ProcedureStatus;
  performedAt: string | null;
  reason: string | null;
  authorId: string;
  recordedAt: string;
}

function parse(entry: ClinicalEntry): ProcedureView {
  const c = JSON.parse(entry.content) as Record<string, unknown>;
  const code = c.code && typeof c.code === "object" ? (c.code as Record<string, unknown>) : {};
  const coding = Array.isArray(code.coding) ? (code.coding[0] as Record<string, unknown> | undefined) : undefined;
  const reason = c.statusReason && typeof c.statusReason === "object" ? (c.statusReason as Record<string, unknown>) : {};
  const status = (PROCEDURE_STATUSES as readonly string[]).includes(String(c.status))
    ? (c.status as ProcedureStatus)
    : "completed";
  return {
    recordId: entry.record_id,
    patientId: entry.patient_id,
    encounterId: entry.encounter_id,
    display: typeof code.text === "string" ? code.text : "",
    procedureCode: typeof coding?.code === "string" ? coding.code : null,
    procedureSystem: typeof coding?.system === "string" ? coding.system : null,
    status,
    performedAt: typeof c.performedDateTime === "string" ? c.performedDateTime : entry.effective_at,
    reason: typeof reason.text === "string" ? reason.text : null,
    authorId: entry.author_id,
    recordedAt: entry.recorded_at,
  };
}

export class Procedures {
  private clinical: ClinicalRecord;

  constructor(clinical: ClinicalRecord) {
    this.clinical = clinical;
  }

  record(input: ProcedureInput): ProcedureView {
    if (!input.procedure.trim()) refuse("a procedure needs a name");
    const status = input.status ?? "completed";
    if (!(PROCEDURE_STATUSES as readonly string[]).includes(status)) {
      refuse(`unknown procedure status ${status}; expected one of ${PROCEDURE_STATUSES.join(", ")}`);
    }
    if (status === "completed" && !input.performedAt?.trim()) {
      refuse("a completed procedure needs a date it was performed");
    }
    if (status === "not-done") {
      const reason = (input.reason ?? "").trim();
      if (reason.length < 12) refuse("a procedure that was not done needs a written reason (12+ characters)");
    }
    const content: Record<string, unknown> = {
      resourceType: "Procedure",
      status,
      code: {
        text: input.procedure.trim(),
        ...(input.procedureCode
          ? { coding: [{ system: input.procedureSystem ?? "", code: input.procedureCode }] }
          : {}),
      },
      ...(input.performedAt?.trim() ? { performedDateTime: input.performedAt } : {}),
      ...(input.reason?.trim() ? { statusReason: { text: input.reason.trim() } } : {}),
    };
    const entry = this.clinical.record({
      entryType: "Procedure",
      patientId: input.patientId,
      content,
      authorId: input.by.authorId,
      authorKind: input.by.authorKind,
      ...(input.performedAt?.trim() ? { effectiveAt: input.performedAt } : {}),
      ...(input.encounterId ? { encounterId: input.encounterId } : {}),
      ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}),
    });
    return parse(entry);
  }

  forPatient(patientId: string, opts: { encounterId?: string } = {}): ProcedureView[] {
    return this.clinical
      .chart(patientId, { entryType: "Procedure", encounterId: opts.encounterId })
      .map(parse);
  }

  /** Three-valued the same way allergies are: an empty list is not an answer. */
  historyStatus(patientId: string): ProcedureHistory {
    return this.forPatient(patientId).length === 0 ? "never-recorded" : "documented";
  }

  retract(recordId: string, by: { authorId: string; authorKind: string; reason: string }): ProcedureView {
    return parse(this.clinical.retract(recordId, by));
  }
}
