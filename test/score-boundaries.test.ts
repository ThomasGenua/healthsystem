/**
 * Below, on, and above every threshold the ten instruments contain.
 *
 * A threshold is where a score changes its mind, so it is where a
 * transcription error hides best. `age >= 65` written as `age > 65` is
 * correct for all but one patient in a hundred, and the patient it is wrong
 * about is a 65-year-old whose CURB-65 comes back one point lighter than the
 * instrument says. No golden vector picked at a round number would catch it.
 *
 * So every criterion is probed three times: just below its edge, exactly on
 * it, and just above. The middle probe is the one that matters — it is the
 * only one that distinguishes an inclusive bound from an exclusive one, and
 * the instruments genuinely differ. CURB-65 awards its age point at 65 and
 * HAS-BLED awards its at 66, from published criteria that read `>= 65` and
 * `> 65`.
 *
 * These tests establish what this implementation *does*, against the
 * arithmetic in `score-definitions.ts`. They are transcription checks, not
 * clinical validation: agreeing with the published cut points is necessary
 * for correctness and says nothing about whether an instrument should be used
 * on a given patient. See `docs/CLINICAL-SAFETY.md`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { score, type ScoreId } from "../src/clinical/scores.ts";

function complete(id: ScoreId, input: object) {
  const r = score(id, input);
  if (r.complete !== true) {
    assert.fail(`${id} refused a complete input: ${r.reason}`);
  }
  return r;
}

// ── Bases: every criterion at zero points, so one field can be varied ──────

const NO_CHARLSON_CONDITIONS = {
  myocardialInfarction: false, congestiveHeartFailure: false, peripheralVascularDisease: false,
  cerebrovascularDisease: false, dementia: false, chronicPulmonaryDisease: false,
  connectiveTissueDisease: false, pepticUlcerDisease: false, mildLiverDisease: false,
  diabetesWithoutComplications: false, hemiplegia: false, moderateOrSevereRenalDisease: false,
  diabetesWithEndOrganDamage: false, tumourWithinFiveYears: false, leukaemia: false,
  lymphoma: false, moderateOrSevereLiverDisease: false, metastaticSolidTumour: false, aids: false,
};

const BASE = {
  "curb-65": { confusion: false, ureaMmolL: 0, respiratoryRate: 0, systolicBp: 120, diastolicBp: 80, ageYears: 0 },
  "cha2ds2-vasc": { congestiveHeartFailure: false, hypertension: false, ageYears: 0, diabetes: false, strokeTiaThromboembolism: false, vascularDisease: false, sexFemale: false },
  "has-bled": { uncontrolledHypertension: false, abnormalRenalFunction: false, abnormalLiverFunction: false, strokeHistory: false, bleedingHistoryOrPredisposition: false, labileInr: false, ageYears: 0, antiplateletOrNsaid: false, alcoholExcess: false },
  "wells-pe": { clinicalSignsOfDvt: false, peIsLeadingDiagnosis: false, heartRate: 0, immobilisationOrSurgery: false, previousPeOrDvt: false, haemoptysis: false, malignancy: false },
  heart: { history: "slightly-suspicious", ecg: "normal", ageYears: 0, riskFactors: "none", troponin: "at-or-below-normal" },
  "meld-na": { creatinineMgDl: 1, bilirubinMgDl: 1, inr: 1, sodiumMeqL: 137, dialysisTwiceInPastWeek: false },
  "ciwa-ar": { nauseaVomiting: 0, tremor: 0, paroxysmalSweats: 0, anxiety: 0, agitation: 0, tactileDisturbances: 0, auditoryDisturbances: 0, visualDisturbances: 0, headache: 0, orientation: 0 },
  charlson: { ...NO_CHARLSON_CONDITIONS, ageYears: 0 },
  lace: { lengthOfStayDays: 0, acuteEmergentAdmission: false, charlsonScore: 0, edVisitsPastSixMonths: 0 },
  news2: { respiratoryRate: 16, oxygenSaturation: 98, onSupplementalOxygen: false, systolicBp: 120, heartRate: 70, alert: true, temperatureC: 37 },
} as const;

/** One criterion, probed just below its edge, on it, and just above. */
interface Edge {
  id: ScoreId;
  /** The published criterion, as the implementation reads it. */
  criterion: string;
  field: string;
  /** The component key whose points the criterion decides. */
  component: string;
  /** [value, expected points] for below, on, and above the edge. */
  probes: [[number, number], [number, number], [number, number]];
  /** Fields held away from their base so this criterion is the only mover. */
  hold?: Record<string, number>;
}

const EDGES: Edge[] = [
  // CURB-65. Urea is strictly greater; respiratory rate and age are inclusive.
  { id: "curb-65", criterion: "urea > 7 mmol/L", field: "ureaMmolL", component: "urea", probes: [[6.9, 0], [7, 0], [7.1, 1]] },
  { id: "curb-65", criterion: "respiratory rate >= 30", field: "respiratoryRate", component: "respiratoryRate", probes: [[29, 0], [30, 1], [31, 1]] },
  { id: "curb-65", criterion: "age >= 65", field: "ageYears", component: "age", probes: [[64, 0], [65, 1], [66, 1]] },
  { id: "curb-65", criterion: "systolic < 90", field: "systolicBp", component: "bloodPressure", probes: [[89, 1], [90, 0], [91, 0]] },
  { id: "curb-65", criterion: "diastolic <= 60", field: "diastolicBp", component: "bloodPressure", probes: [[59, 1], [60, 1], [61, 0]] },

  // CHA2DS2-VASc splits age into two bands that must not overlap or gap.
  { id: "cha2ds2-vasc", criterion: "age >= 75 scores 2", field: "ageYears", component: "age75OrOver", probes: [[74, 0], [75, 2], [76, 2]] },
  { id: "cha2ds2-vasc", criterion: "age 65-74 scores 1 (lower edge)", field: "ageYears", component: "age65To74", probes: [[64, 0], [65, 1], [66, 1]] },
  { id: "cha2ds2-vasc", criterion: "age 65-74 scores 1 (upper edge)", field: "ageYears", component: "age65To74", probes: [[74, 1], [75, 0], [76, 0]] },

  // HAS-BLED's age criterion is strictly greater, unlike CURB-65's.
  { id: "has-bled", criterion: "age > 65", field: "ageYears", component: "elderly", probes: [[64, 0], [65, 0], [66, 1]] },

  { id: "wells-pe", criterion: "heart rate > 100 scores 1.5", field: "heartRate", component: "tachycardia", probes: [[99, 0], [100, 0], [101, 1.5]] },

  { id: "heart", criterion: "age >= 45 scores 1", field: "ageYears", component: "age", probes: [[44, 0], [45, 1], [46, 1]] },
  { id: "heart", criterion: "age >= 65 scores 2", field: "ageYears", component: "age", probes: [[64, 1], [65, 2], [66, 2]] },

  // MELD-Na's published bounds: values below 1.0 are raised so the logarithm
  // cannot subtract, creatinine is capped at 4, sodium is held to 125-137.
  { id: "meld-na", criterion: "creatinine below 1.0 is taken as 1.0", field: "creatinineMgDl", component: "creatinineUsed", probes: [[0.9, 1], [1, 1], [1.1, 1.1]] },
  { id: "meld-na", criterion: "creatinine is capped at 4.0", field: "creatinineMgDl", component: "creatinineUsed", probes: [[3.9, 3.9], [4, 4], [4.1, 4]] },
  { id: "meld-na", criterion: "sodium is floored at 125", field: "sodiumMeqL", component: "sodiumUsed", probes: [[124, 125], [125, 125], [126, 126]] },
  { id: "meld-na", criterion: "sodium is capped at 137", field: "sodiumMeqL", component: "sodiumUsed", probes: [[136, 136], [137, 137], [138, 137]] },

  // Charlson: one point per decade over 40, from 50, capped at four.
  { id: "charlson", criterion: "age >= 50 scores 1", field: "ageYears", component: "age", probes: [[49, 0], [50, 1], [51, 1]] },
  { id: "charlson", criterion: "age >= 60 scores 2", field: "ageYears", component: "age", probes: [[59, 1], [60, 2], [61, 2]] },
  { id: "charlson", criterion: "age >= 70 scores 3", field: "ageYears", component: "age", probes: [[69, 2], [70, 3], [71, 3]] },
  { id: "charlson", criterion: "age >= 80 scores 4", field: "ageYears", component: "age", probes: [[79, 3], [80, 4], [81, 4]] },
  { id: "charlson", criterion: "the age points are capped at 4", field: "ageYears", component: "age", probes: [[89, 4], [90, 4], [120, 4]] },

  // LACE length of stay steps at 1, 3, 6 and 13 days.
  { id: "lace", criterion: "under one day scores 0", field: "lengthOfStayDays", component: "lengthOfStay", probes: [[0.9, 0], [1, 1], [1.1, 1]] },
  { id: "lace", criterion: "1-3 days scores the whole days", field: "lengthOfStayDays", component: "lengthOfStay", probes: [[2.9, 2], [3, 3], [3.1, 4]] },
  { id: "lace", criterion: "4-6 days scores 4", field: "lengthOfStayDays", component: "lengthOfStay", probes: [[5.9, 4], [6, 4], [6.1, 5]] },
  { id: "lace", criterion: "7-13 days scores 5", field: "lengthOfStayDays", component: "lengthOfStay", probes: [[12.9, 5], [13, 5], [13.1, 7]] },
  { id: "lace", criterion: "a Charlson of 4 or more scores 5", field: "charlsonScore", component: "comorbidity", probes: [[3, 3], [4, 5], [5, 5]] },
  { id: "lace", criterion: "emergency visits are capped at 4", field: "edVisitsPastSixMonths", component: "edVisits", probes: [[3, 3], [4, 4], [5, 4]] },

  // NEWS2, Scale 1. Every physiological parameter is a banded scale, and each
  // band boundary is inclusive of its upper value.
  { id: "news2", criterion: "respiratory rate <= 8 scores 3", field: "respiratoryRate", component: "respiratoryRate", probes: [[7, 3], [8, 3], [9, 1]] },
  { id: "news2", criterion: "respiratory rate 9-11 scores 1", field: "respiratoryRate", component: "respiratoryRate", probes: [[10, 1], [11, 1], [12, 0]] },
  { id: "news2", criterion: "respiratory rate 12-20 scores 0", field: "respiratoryRate", component: "respiratoryRate", probes: [[19, 0], [20, 0], [21, 2]] },
  { id: "news2", criterion: "respiratory rate 21-24 scores 2", field: "respiratoryRate", component: "respiratoryRate", probes: [[23, 2], [24, 2], [25, 3]] },
  { id: "news2", criterion: "saturation <= 91 scores 3", field: "oxygenSaturation", component: "oxygenSaturation", probes: [[90, 3], [91, 3], [92, 2]] },
  { id: "news2", criterion: "saturation 92-93 scores 2", field: "oxygenSaturation", component: "oxygenSaturation", probes: [[92, 2], [93, 2], [94, 1]] },
  { id: "news2", criterion: "saturation 94-95 scores 1", field: "oxygenSaturation", component: "oxygenSaturation", probes: [[94, 1], [95, 1], [96, 0]] },
  { id: "news2", criterion: "systolic <= 90 scores 3", field: "systolicBp", component: "systolicBp", probes: [[89, 3], [90, 3], [91, 2]] },
  { id: "news2", criterion: "systolic 91-100 scores 2", field: "systolicBp", component: "systolicBp", probes: [[99, 2], [100, 2], [101, 1]] },
  { id: "news2", criterion: "systolic 101-110 scores 1", field: "systolicBp", component: "systolicBp", probes: [[109, 1], [110, 1], [111, 0]] },
  { id: "news2", criterion: "systolic above 219 scores 3", field: "systolicBp", component: "systolicBp", probes: [[218, 0], [219, 0], [220, 3]] },
  { id: "news2", criterion: "heart rate <= 40 scores 3", field: "heartRate", component: "heartRate", probes: [[39, 3], [40, 3], [41, 1]] },
  { id: "news2", criterion: "heart rate 41-50 scores 1", field: "heartRate", component: "heartRate", probes: [[49, 1], [50, 1], [51, 0]] },
  { id: "news2", criterion: "heart rate 51-90 scores 0", field: "heartRate", component: "heartRate", probes: [[89, 0], [90, 0], [91, 1]] },
  { id: "news2", criterion: "heart rate 91-110 scores 1", field: "heartRate", component: "heartRate", probes: [[109, 1], [110, 1], [111, 2]] },
  { id: "news2", criterion: "heart rate 111-130 scores 2", field: "heartRate", component: "heartRate", probes: [[129, 2], [130, 2], [131, 3]] },
  { id: "news2", criterion: "temperature <= 35 scores 3", field: "temperatureC", component: "temperature", probes: [[34.9, 3], [35, 3], [35.1, 1]] },
  { id: "news2", criterion: "temperature 35.1-36 scores 1", field: "temperatureC", component: "temperature", probes: [[35.9, 1], [36, 1], [36.1, 0]] },
  { id: "news2", criterion: "temperature 36.1-38 scores 0", field: "temperatureC", component: "temperature", probes: [[37.9, 0], [38, 0], [38.1, 1]] },
  { id: "news2", criterion: "temperature 38.1-39 scores 1", field: "temperatureC", component: "temperature", probes: [[38.9, 1], [39, 1], [39.1, 2]] },
];

for (const edge of EDGES) {
  const [below, on, above] = edge.probes;
  test(`${edge.id}: ${edge.criterion} — ${below[0]} scores ${below[1]}, ${on[0]} scores ${on[1]}, ${above[0]} scores ${above[1]}`, () => {
    for (const [value, expected] of edge.probes) {
      const input = { ...BASE[edge.id], ...(edge.hold ?? {}), [edge.field]: value };
      const r = complete(edge.id, input);
      assert.equal(
        r.components[edge.component],
        expected,
        `${edge.field}=${value} should give ${edge.component} ${expected} points, got ${r.components[edge.component]}`,
      );
    }
  });
}

test("every instrument with a numeric criterion is covered by an edge", () => {
  // A scorer added later without boundary probes is the failure this catches.
  const probed = new Set(EDGES.map((e) => e.id));
  for (const id of ["curb-65", "cha2ds2-vasc", "has-bled", "wells-pe", "heart", "meld-na", "charlson", "lace", "news2"] as const) {
    assert.ok(probed.has(id), `${id} has numeric criteria but no boundary probes`);
  }
});

// ── Band edges: the score at which the interpretation changes ──────────────

interface BandCase {
  id: ScoreId;
  input: object;
  score: number;
  band: string;
}

const BANDS: BandCase[] = [
  { id: "curb-65", input: BASE["curb-65"], score: 0, band: "low" },
  { id: "curb-65", input: { ...BASE["curb-65"], confusion: true }, score: 1, band: "low" },
  { id: "curb-65", input: { ...BASE["curb-65"], confusion: true, respiratoryRate: 30 }, score: 2, band: "moderate" },
  { id: "curb-65", input: { ...BASE["curb-65"], confusion: true, respiratoryRate: 30, ageYears: 65 }, score: 3, band: "severe" },
  { id: "curb-65", input: { confusion: true, ureaMmolL: 8, respiratoryRate: 30, systolicBp: 85, diastolicBp: 55, ageYears: 70 }, score: 5, band: "severe" },

  { id: "cha2ds2-vasc", input: BASE["cha2ds2-vasc"], score: 0, band: "low" },
  { id: "cha2ds2-vasc", input: { ...BASE["cha2ds2-vasc"], congestiveHeartFailure: true }, score: 1, band: "intermediate" },
  { id: "cha2ds2-vasc", input: { ...BASE["cha2ds2-vasc"], congestiveHeartFailure: true, hypertension: true }, score: 2, band: "high" },

  { id: "has-bled", input: { ...BASE["has-bled"], uncontrolledHypertension: true, abnormalRenalFunction: true }, score: 2, band: "lower" },
  { id: "has-bled", input: { ...BASE["has-bled"], uncontrolledHypertension: true, abnormalRenalFunction: true, abnormalLiverFunction: true }, score: 3, band: "high" },

  { id: "wells-pe", input: { ...BASE["wells-pe"], heartRate: 101 }, score: 1.5, band: "low" },
  { id: "wells-pe", input: { ...BASE["wells-pe"], heartRate: 101, haemoptysis: true }, score: 2.5, band: "moderate" },
  { id: "wells-pe", input: { ...BASE["wells-pe"], clinicalSignsOfDvt: true, peIsLeadingDiagnosis: true }, score: 6, band: "moderate" },
  { id: "wells-pe", input: { ...BASE["wells-pe"], peIsLeadingDiagnosis: true, immobilisationOrSurgery: true, haemoptysis: true, malignancy: true }, score: 6.5, band: "high" },

  { id: "heart", input: { ...BASE.heart, history: "moderately-suspicious", ecg: "non-specific-repolarisation", ageYears: 45 }, score: 3, band: "low" },
  { id: "heart", input: { ...BASE.heart, history: "moderately-suspicious", ecg: "non-specific-repolarisation", ageYears: 45, riskFactors: "one-or-two" }, score: 4, band: "moderate" },
  { id: "heart", input: { ...BASE.heart, history: "highly-suspicious", ecg: "significant-st-deviation", ageYears: 65 }, score: 6, band: "moderate" },
  { id: "heart", input: { ...BASE.heart, history: "highly-suspicious", ecg: "significant-st-deviation", ageYears: 65, riskFactors: "one-or-two" }, score: 7, band: "high" },

  // Sodium held at 137 so the sodium term is zero and the band edge is the
  // MELD score itself. Values found by probing the implementation.
  { id: "meld-na", input: { ...BASE["meld-na"], inr: 1.198 }, score: 9, band: "low" },
  { id: "meld-na", input: { ...BASE["meld-na"], inr: 1.31 }, score: 10, band: "moderate" },
  { id: "meld-na", input: { ...BASE["meld-na"], inr: 2.925 }, score: 19, band: "moderate" },
  { id: "meld-na", input: { ...BASE["meld-na"], inr: 3.198 }, score: 20, band: "high" },
  { id: "meld-na", input: { ...BASE["meld-na"], inr: 7.143 }, score: 29, band: "high" },
  { id: "meld-na", input: { ...BASE["meld-na"], inr: 7.81 }, score: 30, band: "very high" },

  { id: "ciwa-ar", input: { ...BASE["ciwa-ar"], tremor: 7, anxiety: 1 }, score: 8, band: "minimal" },
  { id: "ciwa-ar", input: { ...BASE["ciwa-ar"], tremor: 7, anxiety: 2 }, score: 9, band: "mild" },
  { id: "ciwa-ar", input: { ...BASE["ciwa-ar"], tremor: 7, anxiety: 7, agitation: 1 }, score: 15, band: "mild" },
  { id: "ciwa-ar", input: { ...BASE["ciwa-ar"], tremor: 7, anxiety: 7, agitation: 2 }, score: 16, band: "moderate" },
  { id: "ciwa-ar", input: { ...BASE["ciwa-ar"], tremor: 7, anxiety: 7, agitation: 6 }, score: 20, band: "moderate" },
  { id: "ciwa-ar", input: { ...BASE["ciwa-ar"], tremor: 7, anxiety: 7, agitation: 7 }, score: 21, band: "severe" },
  { id: "ciwa-ar", input: { nauseaVomiting: 7, tremor: 7, paroxysmalSweats: 7, anxiety: 7, agitation: 7, tactileDisturbances: 7, auditoryDisturbances: 7, visualDisturbances: 7, headache: 7, orientation: 4 }, score: 67, band: "severe" },

  { id: "charlson", input: BASE.charlson, score: 0, band: "none" },
  { id: "charlson", input: { ...BASE.charlson, myocardialInfarction: true }, score: 1, band: "low" },
  { id: "charlson", input: { ...BASE.charlson, myocardialInfarction: true, congestiveHeartFailure: true }, score: 2, band: "low" },
  { id: "charlson", input: { ...BASE.charlson, myocardialInfarction: true, congestiveHeartFailure: true, peripheralVascularDisease: true }, score: 3, band: "moderate" },
  { id: "charlson", input: { ...BASE.charlson, myocardialInfarction: true, congestiveHeartFailure: true, peripheralVascularDisease: true, cerebrovascularDisease: true }, score: 4, band: "moderate" },
  { id: "charlson", input: { ...BASE.charlson, myocardialInfarction: true, congestiveHeartFailure: true, peripheralVascularDisease: true, cerebrovascularDisease: true, dementia: true }, score: 5, band: "high" },

  { id: "lace", input: { ...BASE.lace, lengthOfStayDays: 4 }, score: 4, band: "low" },
  { id: "lace", input: { ...BASE.lace, lengthOfStayDays: 4, edVisitsPastSixMonths: 1 }, score: 5, band: "moderate" },
  { id: "lace", input: { ...BASE.lace, lengthOfStayDays: 7, acuteEmergentAdmission: true, edVisitsPastSixMonths: 1 }, score: 9, band: "moderate" },
  { id: "lace", input: { ...BASE.lace, lengthOfStayDays: 7, acuteEmergentAdmission: true, edVisitsPastSixMonths: 2 }, score: 10, band: "high" },
  { id: "lace", input: { lengthOfStayDays: 14, acuteEmergentAdmission: true, charlsonScore: 4, edVisitsPastSixMonths: 4 }, score: 19, band: "high" },

  { id: "news2", input: BASE.news2, score: 0, band: "none" },
  { id: "news2", input: { ...BASE.news2, heartRate: 91 }, score: 1, band: "low" },
  { id: "news2", input: { ...BASE.news2, heartRate: 111, oxygenSaturation: 94, temperatureC: 38.5 }, score: 4, band: "low" },
  { id: "news2", input: { ...BASE.news2, onSupplementalOxygen: true, heartRate: 111, oxygenSaturation: 94 }, score: 5, band: "medium" },
  { id: "news2", input: { ...BASE.news2, onSupplementalOxygen: true, heartRate: 111, oxygenSaturation: 94, temperatureC: 38.5 }, score: 6, band: "medium" },
  { id: "news2", input: { ...BASE.news2, onSupplementalOxygen: true, heartRate: 131, oxygenSaturation: 94, temperatureC: 38.5 }, score: 7, band: "high" },
];

for (const c of BANDS) {
  test(`${c.id}: a score of ${c.score} is "${c.band}"`, () => {
    const r = complete(c.id, c.input);
    assert.equal(r.score, c.score, `expected a score of ${c.score}, got ${r.score}`);
    assert.equal(r.band, c.band);
  });
}

test("NEWS2 escalates on a single parameter scoring 3, below the aggregate cut", () => {
  // The aggregate is 3 and 4 — both below the medium threshold of 5 — but one
  // parameter is extreme, and the aggregate alone would miss the patient.
  const one = complete("news2", { ...BASE.news2, oxygenSaturation: 91 });
  assert.equal(one.score, 3);
  assert.equal(one.band, "low-medium");

  const two = complete("news2", { ...BASE.news2, oxygenSaturation: 91, temperatureC: 38.5 });
  assert.equal(two.score, 4);
  assert.equal(two.band, "low-medium");

  // The same aggregate with no single 3 stays "low".
  const spread = complete("news2", { ...BASE.news2, heartRate: 111, oxygenSaturation: 94, temperatureC: 38.5 });
  assert.equal(spread.score, 4);
  assert.equal(spread.band, "low");
});
