/**
 * The immunization history.
 *
 * A primary-care chart that cannot say whether a child has had their
 * measles vaccine is not a primary-care chart. The clinical record already
 * accepts an `Immunization` entry — this is the typed surface that writes
 * one, so a caller cannot file a "given" dose with no date, or a refusal
 * with no reason, and so the chart can distinguish "never asked" from
 * "asked, none on file".
 *
 * Nothing is overwritten. A correction is an amendment on the record; a
 * dose recorded against the wrong patient is a retraction. The history
 * stays readable because "had they been vaccinated when this outbreak
 * started" is a question a review asks.
 */
import type { ClinicalEntry, ClinicalRecord } from "./record.ts";
import { refuse } from "../core/refusal.ts";

export type ImmunizationStatus = "given" | "refused" | "not-done";
export type ImmunizationHistory = "documented" | "never-asked";

export interface ImmunizationInput {
  patientId: string;
  vaccine: string;
  occurrenceAt: string;
  by: { authorId: string; authorKind: string };
  status?: ImmunizationStatus;
  vaccineCode?: string;
  vaccineSystem?: string;
  lot?: string;
  site?: string;
  doseNumber?: number;
  reason?: string;
  encounterId?: string;
  sourceMessageId?: string;
}

export interface ImmunizationView {
  recordId: string;
  patientId: string;
  encounterId: string | null;
  vaccine: string;
  vaccineCode: string | null;
  vaccineSystem: string | null;
  status: ImmunizationStatus;
  occurrenceAt: string;
  lot: string | null;
  site: string | null;
  doseNumber: number | null;
  reason: string | null;
  authorId: string;
  recordedAt: string;
}

function parse(entry: ClinicalEntry): ImmunizationView {
  const c = JSON.parse(entry.content) as Record<string, unknown>;
  const vaccineCode = c.vaccineCode && typeof c.vaccineCode === "object" ? (c.vaccineCode as Record<string, unknown>) : {};
  const coding = Array.isArray(vaccineCode.coding) ? (vaccineCode.coding[0] as Record<string, unknown> | undefined) : undefined;
  const site = c.site && typeof c.site === "object" ? (c.site as Record<string, unknown>) : {};
  const reason = c.statusReason && typeof c.statusReason === "object" ? (c.statusReason as Record<string, unknown>) : {};
  const proto = Array.isArray(c.protocolApplied) ? (c.protocolApplied[0] as Record<string, unknown> | undefined) : undefined;
  const reasonCode = Array.isArray(reason.coding) ? (reason.coding[0] as { code?: string } | undefined)?.code : undefined;
  const fhirStatus =
    c.status === "not-done"
      ? reasonCode === "refused" || (typeof reason.text === "string" && /refus/i.test(reason.text))
        ? "refused"
        : "not-done"
      : "given";
  return {
    recordId: entry.record_id,
    patientId: entry.patient_id,
    encounterId: entry.encounter_id,
    vaccine: typeof vaccineCode.text === "string" ? vaccineCode.text : "",
    vaccineCode: typeof coding?.code === "string" ? coding.code : null,
    vaccineSystem: typeof coding?.system === "string" ? coding.system : null,
    status: fhirStatus,
    occurrenceAt: typeof c.occurrenceDateTime === "string" ? c.occurrenceDateTime : entry.effective_at ?? entry.recorded_at,
    lot: typeof c.lotNumber === "string" ? c.lotNumber : null,
    site: typeof site.text === "string" ? site.text : null,
    doseNumber: typeof proto?.doseNumberPositiveInt === "number" ? proto.doseNumberPositiveInt : null,
    reason: typeof reason.text === "string" ? reason.text : null,
    authorId: entry.author_id,
    recordedAt: entry.recorded_at,
  };
}

export class Immunizations {
  private clinical: ClinicalRecord;

  constructor(clinical: ClinicalRecord) {
    this.clinical = clinical;
  }

  record(input: ImmunizationInput): ImmunizationView {
    if (!input.vaccine.trim()) refuse("an immunization needs a vaccine name");
    if (!input.occurrenceAt.trim()) refuse("an immunization needs the date it was given or refused");
    const status = input.status ?? "given";
    if (status !== "given" && !input.reason?.trim()) {
      refuse("a refused or not-done immunization needs a reason");
    }
    const content: Record<string, unknown> = {
      resourceType: "Immunization",
      status: status === "given" ? "completed" : "not-done",
      vaccineCode: {
        text: input.vaccine,
        ...(input.vaccineCode
          ? { coding: [{ system: input.vaccineSystem ?? "", code: input.vaccineCode }] }
          : {}),
      },
      occurrenceDateTime: input.occurrenceAt,
      ...(input.lot ? { lotNumber: input.lot } : {}),
      ...(input.site ? { site: { text: input.site } } : {}),
      ...(input.doseNumber !== undefined ? { protocolApplied: [{ doseNumberPositiveInt: input.doseNumber }] } : {}),
      ...(input.reason || status !== "given"
        ? {
            statusReason: {
              ...(input.reason ? { text: input.reason } : {}),
              coding: [{ code: status }],
            },
          }
        : {}),
    };
    const entry = this.clinical.record({
      entryType: "Immunization",
      patientId: input.patientId,
      content,
      authorId: input.by.authorId,
      authorKind: input.by.authorKind,
      effectiveAt: input.occurrenceAt,
      ...(input.encounterId ? { encounterId: input.encounterId } : {}),
      ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}),
    });
    return parse(entry);
  }

  forPatient(patientId: string): ImmunizationView[] {
    return this.clinical.chart(patientId, { entryType: "Immunization" }).map(parse);
  }

  /** Three-valued the same way allergies are: an empty list is not an answer. */
  historyStatus(patientId: string): ImmunizationHistory {
    return this.forPatient(patientId).length === 0 ? "never-asked" : "documented";
  }

  retract(recordId: string, by: { authorId: string; authorKind: string; reason: string }): ImmunizationView {
    return parse(this.clinical.retract(recordId, by));
  }
}
