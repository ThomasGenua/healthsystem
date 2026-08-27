/**
 * Computing a risk score from the chart, and the second way it goes wrong.
 *
 * `scores.ts` refuses to score a missing input, which stops an unassessed
 * patient reading as a low-risk one. Feeding those instruments from the chart
 * introduces a failure the hand-supplied form does not have: **a value that
 * is present but old.**
 *
 * A NEWS2 assembled from the most recent vitals is a NEWS2 of whenever those
 * vitals were taken. If the last set was at 06:00 and it is now 20:00, the
 * number describes a patient from fourteen hours ago and puts today's date on
 * it. Nothing about it looks stale — it is a full set of real measurements,
 * every field populated, and it will render as confidently as one taken five
 * minutes ago. The score is not wrong about the past; it is wrong about now,
 * which is the only tense anybody reads it in.
 *
 * So every input carries a maximum age, and **a value older than its window is
 * not a value**. It falls through to `missing`, and the instrument refuses
 * exactly as it would for a measurement nobody took. The windows differ by
 * instrument because the clinical question does: NEWS2 asks how the patient is
 * right now and will not accept a vital from a previous shift, while CURB-65
 * is a disposition decision over a presentation and tolerates the working day.
 *
 * ## The chart does not hold everything an instrument needs
 *
 * NEWS2 needs to know whether the patient is on supplemental oxygen and
 * whether they are alert. Neither is a vital sign, and neither is in the
 * vitals table. The tempting implementation defaults them — `oxygen: false`,
 * `alert: true` — and both defaults are the dangerous direction: a patient on
 * oxygen scores two points lower than they should, and an unresponsive one
 * scores three lower.
 *
 * Nothing is defaulted. What the chart cannot supply is reported as
 * `unavailable` with the reason, the caller supplies it or the score refuses,
 * and a user interface can use that list to ask for exactly the missing
 * pieces rather than a blank form.
 *
 * ## What this deliberately does not do
 *
 * Derive comorbidity indices from diagnosis codes. Mapping ICD-10 or SNOMED
 * onto Charlson's nineteen categories is a real piece of terminology work
 * whose failure mode is silent — a mapping that misses "chronic kidney disease
 * stage 4" produces a confident, lower score — and it deserves its own design
 * rather than a plausible lookup table bolted on here. Charlson and LACE stay
 * hand-supplied until that exists.
 */
import type { ClinicalRecord } from "./record.ts";
import type { VitalKind, Vitals, VitalView } from "./vitals.ts";
import { curb65, news2, type ScoreResult } from "./scores.ts";

/** Where a value came from and how old it was when the score was taken. */
export interface ChartSource {
  input: string;
  value: number;
  takenAt: string;
  ageHours: number;
  recordId: string;
}

export interface UnavailableInput {
  input: string;
  reason: string;
}

export interface ChartScore {
  result: ScoreResult;
  /** Every chart value the score used, with its age. The number's working. */
  used: ChartSource[];
  /** What the chart could not supply, and why, so a caller knows what to ask. */
  unavailable: UnavailableInput[];
  /**
   * The oldest value the score rests on. A score is only as current as its
   * stalest input, and this is the number to show beside it.
   */
  oldestAgeHours: number | null;
}

export interface ChartScoreDeps {
  vitals: Vitals;
  clinical: ClinicalRecord;
}

const HOUR = 3_600_000;

function ageHours(takenAt: string, asOf: string): number {
  return (new Date(asOf).getTime() - new Date(takenAt).getTime()) / HOUR;
}

/**
 * Pulls one vital, subject to its freshness window.
 *
 * Returns the reason on failure rather than a bare undefined: "nobody has ever
 * measured this" and "the last one was two days ago" are different
 * conversations with a clinician, and collapsing them into one absence loses
 * the more actionable half.
 */
function pull(
  latest: Partial<Record<VitalKind, VitalView>>,
  kind: VitalKind,
  input: string,
  maxAgeHours: number,
  asOf: string,
  read: (v: VitalView) => number | null
): { source: ChartSource } | { unavailable: UnavailableInput } {
  const v = latest[kind];
  if (!v) return { unavailable: { input, reason: `no ${kind} has ever been recorded for this patient` } };
  const value = read(v);
  if (value === null) {
    return { unavailable: { input, reason: `the most recent ${kind} carries no usable value` } };
  }
  const age = ageHours(v.takenAt, asOf);
  if (age > maxAgeHours) {
    return {
      unavailable: {
        input,
        reason:
          `the most recent ${kind} was taken ${age.toFixed(1)}h ago and this instrument accepts ` +
          `${maxAgeHours}h; a score built on it would describe the patient as they were then, not now`,
      },
    };
  }
  return { source: { input, value, takenAt: v.takenAt, ageHours: age, recordId: v.recordId } };
}

function assemble(
  results: Array<{ source: ChartSource } | { unavailable: UnavailableInput }>
): { values: Record<string, number>; used: ChartSource[]; unavailable: UnavailableInput[] } {
  const values: Record<string, number> = {};
  const used: ChartSource[] = [];
  const unavailable: UnavailableInput[] = [];
  for (const r of results) {
    if ("source" in r) {
      values[r.source.input] = r.source.value;
      used.push(r.source);
    } else {
      unavailable.push(r.unavailable);
    }
  }
  return { values, used, unavailable };
}

function finish(
  result: ScoreResult,
  used: ChartSource[],
  unavailable: UnavailableInput[]
): ChartScore {
  return {
    result,
    used,
    unavailable,
    oldestAgeHours: used.length === 0 ? null : Math.max(...used.map((u) => u.ageHours)),
  };
}

/**
 * Whole years between a birth date and a moment.
 *
 * Floors deliberately: a patient three days short of 65 is 64, and the
 * instrument's threshold is the instrument's, not something to round toward.
 */
function ageYears(birthDate: string, asOf: string): number | null {
  const born = new Date(birthDate);
  const now = new Date(asOf);
  if (!Number.isFinite(born.getTime()) || !Number.isFinite(now.getTime())) return null;
  let years = now.getUTCFullYear() - born.getUTCFullYear();
  const monthDiff = now.getUTCMonth() - born.getUTCMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getUTCDate() < born.getUTCDate())) years--;
  return years >= 0 ? years : null;
}

/** How fresh each instrument needs its observations to be, and why. */
export const FRESHNESS_HOURS = {
  /**
   * NEWS2 asks how the patient is *now*. A vital from the previous shift
   * describes somebody who may since have deteriorated, and the whole purpose
   * of an early warning score is to notice that they did.
   */
  news2: 4,
  /**
   * CURB-65 is a disposition decision taken over a presentation, so it
   * tolerates the working day — but not yesterday's observations.
   */
  "curb-65": 12,
} as const;

/**
 * NEWS2 from the chart, plus the two things the chart does not know.
 *
 * `supplied.onSupplementalOxygen` and `supplied.alert` are not vitals and are
 * not stored as any. They are required rather than defaulted: assuming air and
 * alertness understates the score by up to five points, in a patient for whom
 * the score exists to escalate.
 */
export function news2FromChart(
  deps: ChartScoreDeps,
  patientId: string,
  supplied: { onSupplementalOxygen?: boolean; alert?: boolean } = {},
  opts: { asOf?: string; maxAgeHours?: number } = {}
): ChartScore {
  const asOf = opts.asOf ?? new Date().toISOString();
  const window = opts.maxAgeHours ?? FRESHNESS_HOURS.news2;
  const latest = deps.vitals.latest(patientId);

  const { values, used, unavailable } = assemble([
    pull(latest, "respiratory-rate", "respiratoryRate", window, asOf, (v) => v.value),
    pull(latest, "oxygen-saturation", "oxygenSaturation", window, asOf, (v) => v.value),
    pull(latest, "blood-pressure", "systolicBp", window, asOf, (v) => v.systolic),
    pull(latest, "heart-rate", "heartRate", window, asOf, (v) => v.value),
    pull(latest, "temperature", "temperatureC", window, asOf, (v) => v.value),
  ]);

  // Reported as unavailable rather than defaulted. Both defaults understate.
  if (supplied.onSupplementalOxygen === undefined) {
    unavailable.push({
      input: "onSupplementalOxygen",
      reason:
        "whether the patient is on supplemental oxygen is not a vital sign and is not in the chart; " +
        "assuming air would score a patient on oxygen two points lower than they are",
    });
  }
  if (supplied.alert === undefined) {
    unavailable.push({
      input: "alert",
      reason:
        "level of consciousness is not in the chart; assuming alert would score an unresponsive patient " +
        "three points lower than they are",
    });
  }

  const result = news2({
    respiratoryRate: values.respiratoryRate,
    oxygenSaturation: values.oxygenSaturation,
    systolicBp: values.systolicBp,
    heartRate: values.heartRate,
    temperatureC: values.temperatureC,
    ...(supplied.onSupplementalOxygen === undefined ? {} : { onSupplementalOxygen: supplied.onSupplementalOxygen }),
    ...(supplied.alert === undefined ? {} : { alert: supplied.alert }),
  });
  return finish(result, used, unavailable);
}

/**
 * CURB-65 from the chart, plus confusion and urea.
 *
 * Age comes from the patient index. Confusion is a bedside assessment and urea
 * is a laboratory result whose LOINC mapping is a deployment's own; both are
 * supplied rather than inferred.
 */
export function curb65FromChart(
  deps: ChartScoreDeps,
  patientId: string,
  supplied: { confusion?: boolean; ureaMmolL?: number } = {},
  opts: { asOf?: string; maxAgeHours?: number } = {}
): ChartScore {
  const asOf = opts.asOf ?? new Date().toISOString();
  const window = opts.maxAgeHours ?? FRESHNESS_HOURS["curb-65"];
  const latest = deps.vitals.latest(patientId);

  const { values, used, unavailable } = assemble([
    pull(latest, "respiratory-rate", "respiratoryRate", window, asOf, (v) => v.value),
    pull(latest, "blood-pressure", "systolicBp", window, asOf, (v) => v.systolic),
    pull(latest, "blood-pressure", "diastolicBp", window, asOf, (v) => v.diastolic),
  ]);

  const patient = deps.clinical.patientIndex.get(patientId);
  let age: number | undefined;
  if (!patient) {
    unavailable.push({ input: "ageYears", reason: "no patient record, so age cannot be established" });
  } else if (!patient.birthDate) {
    unavailable.push({ input: "ageYears", reason: "the patient record carries no birth date" });
  } else {
    const years = ageYears(patient.birthDate, asOf);
    if (years === null) {
      unavailable.push({ input: "ageYears", reason: `the recorded birth date ${patient.birthDate} is not a date` });
    } else {
      age = years;
    }
  }

  if (supplied.confusion === undefined) {
    unavailable.push({
      input: "confusion",
      reason: "new confusion is a bedside assessment and is not held in the chart as a coded finding",
    });
  }
  if (supplied.ureaMmolL === undefined) {
    unavailable.push({
      input: "ureaMmolL",
      reason:
        "serum urea is not read from results here: the LOINC code and units a deployment receives are its own, " +
        "and guessing which result is the urea is how the wrong analyte reaches a disposition decision",
    });
  }

  const result = curb65({
    respiratoryRate: values.respiratoryRate,
    systolicBp: values.systolicBp,
    diastolicBp: values.diastolicBp,
    ...(age === undefined ? {} : { ageYears: age }),
    ...(supplied.confusion === undefined ? {} : { confusion: supplied.confusion }),
    ...(supplied.ureaMmolL === undefined ? {} : { ureaMmolL: supplied.ureaMmolL }),
  });
  return finish(result, used, unavailable);
}
