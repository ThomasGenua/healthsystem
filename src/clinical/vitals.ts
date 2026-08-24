/**
 * Vital signs and clinical measurements.
 *
 * A vital recorded an hour late belongs at the time it was taken, which is
 * why this writes an Observation onto the clinical record with
 * `effectiveAt` rather than trusting `recorded_at`. Blood pressure is two
 * numbers that must arrive together — a systolic without a diastolic is
 * not a measurement, and filing it as one would teach a chart to display
 * half a fact.
 *
 * "Never measured" is a different answer from "no vitals on this visit".
 * The first is a gap in the chart; the second is ordinary. The chart
 * carries the distinction so a panel that is empty because nobody has
 * ever taken a blood pressure does not read as "normal".
 */
import type { ClinicalEntry, ClinicalRecord } from "./record.ts";
import { refuse } from "../core/refusal.ts";

export const VITAL_KINDS = [
  "blood-pressure",
  "heart-rate",
  "temperature",
  "oxygen-saturation",
  "body-weight",
  "body-height",
  "respiratory-rate",
  "pain-score",
] as const;

export type VitalKind = (typeof VITAL_KINDS)[number];
export type VitalHistory = "documented" | "never-measured";

export interface VitalInput {
  patientId: string;
  kind: VitalKind;
  takenAt: string;
  by: { authorId: string; authorKind: string };
  value?: number;
  unit?: string;
  systolic?: number;
  diastolic?: number;
  encounterId?: string;
  sourceMessageId?: string;
}

export interface VitalView {
  recordId: string;
  patientId: string;
  encounterId: string | null;
  kind: VitalKind;
  value: number | null;
  unit: string | null;
  systolic: number | null;
  diastolic: number | null;
  takenAt: string;
  authorId: string;
  recordedAt: string;
}

function isVitalObservation(entry: ClinicalEntry): boolean {
  const c = JSON.parse(entry.content) as Record<string, unknown>;
  const cats = Array.isArray(c.category) ? c.category : [];
  return cats.some((cat) => {
    if (!cat || typeof cat !== "object") return false;
    const o = cat as Record<string, unknown>;
    if (o.text === "vital-signs") return true;
    const coding = Array.isArray(o.coding) ? o.coding : [];
    return coding.some((x) => x && typeof x === "object" && (x as { code?: string }).code === "vital-signs");
  });
}

function parse(entry: ClinicalEntry): VitalView {
  const c = JSON.parse(entry.content) as Record<string, unknown>;
  const code = c.code && typeof c.code === "object" ? (c.code as Record<string, unknown>) : {};
  const kind = (typeof code.text === "string" && (VITAL_KINDS as readonly string[]).includes(code.text)
    ? code.text
    : "heart-rate") as VitalKind;
  const qty = c.valueQuantity && typeof c.valueQuantity === "object" ? (c.valueQuantity as Record<string, unknown>) : {};
  const components = Array.isArray(c.component) ? (c.component as Array<Record<string, unknown>>) : [];
  const byName = (name: string) => {
    const hit = components.find((x) => {
      const cc = x.code && typeof x.code === "object" ? (x.code as Record<string, unknown>) : {};
      return cc.text === name;
    });
    const q = hit?.valueQuantity && typeof hit.valueQuantity === "object" ? (hit.valueQuantity as Record<string, unknown>) : {};
    return typeof q.value === "number" ? q.value : null;
  };
  return {
    recordId: entry.record_id,
    patientId: entry.patient_id,
    encounterId: entry.encounter_id,
    kind,
    value: typeof qty.value === "number" ? qty.value : null,
    unit: typeof qty.unit === "string" ? qty.unit : null,
    systolic: byName("systolic"),
    diastolic: byName("diastolic"),
    takenAt: typeof c.effectiveDateTime === "string" ? c.effectiveDateTime : entry.effective_at ?? entry.recorded_at,
    authorId: entry.author_id,
    recordedAt: entry.recorded_at,
  };
}

export class Vitals {
  private clinical: ClinicalRecord;

  constructor(clinical: ClinicalRecord) {
    this.clinical = clinical;
  }

  record(input: VitalInput): VitalView {
    if (!(VITAL_KINDS as readonly string[]).includes(input.kind)) {
      refuse(`unknown vital ${input.kind}; expected one of ${VITAL_KINDS.join(", ")}`);
    }
    if (!input.takenAt.trim()) refuse("a vital sign needs the time it was taken");
    if (input.kind === "blood-pressure") {
      if (input.systolic === undefined || input.diastolic === undefined) {
        refuse("blood pressure needs both systolic and diastolic");
      }
    } else if (input.value === undefined) {
      refuse("a vital sign needs a value");
    }

    const content: Record<string, unknown> = {
      resourceType: "Observation",
      status: "final",
      category: [
        {
          coding: [{ system: "http://terminology.hl7.org/CodeSystem/observation-category", code: "vital-signs" }],
          text: "vital-signs",
        },
      ],
      code: { text: input.kind },
      effectiveDateTime: input.takenAt,
    };
    if (input.kind === "blood-pressure") {
      content.component = [
        { code: { text: "systolic" }, valueQuantity: { value: input.systolic, unit: input.unit ?? "mmHg" } },
        { code: { text: "diastolic" }, valueQuantity: { value: input.diastolic, unit: input.unit ?? "mmHg" } },
      ];
    } else {
      content.valueQuantity = { value: input.value, unit: input.unit ?? "" };
    }

    const entry = this.clinical.record({
      entryType: "Observation",
      patientId: input.patientId,
      content,
      authorId: input.by.authorId,
      authorKind: input.by.authorKind,
      effectiveAt: input.takenAt,
      ...(input.encounterId ? { encounterId: input.encounterId } : {}),
      ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}),
    });
    return parse(entry);
  }

  forPatient(patientId: string, opts: { encounterId?: string } = {}): VitalView[] {
    return this.clinical
      .chart(patientId, { entryType: "Observation", encounterId: opts.encounterId })
      .filter(isVitalObservation)
      .map(parse);
  }

  /** The most recent measurement of each kind. */
  latest(patientId: string): Partial<Record<VitalKind, VitalView>> {
    const out: Partial<Record<VitalKind, VitalView>> = {};
    for (const v of this.forPatient(patientId)) {
      const have = out[v.kind];
      if (!have || v.takenAt > have.takenAt) out[v.kind] = v;
    }
    return out;
  }

  historyStatus(patientId: string): VitalHistory {
    return this.forPatient(patientId).length === 0 ? "never-measured" : "documented";
  }

  retract(recordId: string, by: { authorId: string; authorKind: string; reason: string }): VitalView {
    return parse(this.clinical.retract(recordId, by));
  }
}
