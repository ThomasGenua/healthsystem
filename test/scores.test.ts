/**
 * Clinical risk scores, and the refusal that makes them safe.
 *
 * The property under test is not arithmetic. It is that a score computed from
 * incomplete data is never returned as a number.
 *
 * The obvious implementation of CURB-65 asks `urea > 7 ? 1 : 0`, and a patient
 * whose urea was never drawn scores zero for that criterion — identical to a
 * patient whose urea came back normal. The total is lower, the band is milder,
 * and the recommendation moves toward discharge. The patient reads as safer
 * because less is known about them. That is the same shape as an allergy list
 * empty because nobody asked, and it is the failure these tests exist to pin.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  curb65,
  cha2ds2Vasc,
  hasBled,
  wellsPe,
  heart,
  meldNa,
  ciwaAr,
  charlson,
  lace,
  news2,
  score,
  SCORE_IDS,
} from "../src/clinical/scores.ts";
import { Refusal } from "../src/core/refusal.ts";

// A 72-year-old with severe pneumonia: confused, urea 9, RR 32, BP 88/55.
const SEVERE_PNEUMONIA = {
  confusion: true,
  ureaMmolL: 9,
  respiratoryRate: 32,
  systolicBp: 88,
  diastolicBp: 55,
  ageYears: 72,
};

test("a missing input yields no score at all, not a lower one", () => {
  // The single most important test in this file. The patient is identical to
  // the severe case except that nobody drew a urea.
  const full = curb65(SEVERE_PNEUMONIA);
  assert.equal(full.complete, true);
  assert.equal(full.complete && full.score, 5);

  const { ureaMmolL: _dropped, ...noUrea } = SEVERE_PNEUMONIA;
  const partial = curb65(noUrea);
  assert.equal(partial.complete, false);
  assert.ok(!("score" in partial), "there is no number on the result to misread");
  assert.deepEqual(partial.complete === false && partial.missing, ["ureaMmolL"]);
  assert.match(
    partial.complete === false ? partial.reason : "",
    /makes an unassessed patient read as a lower-risk one/
  );
});

test("absent is a value; unknown is not", () => {
  // Three states, not two. Saying a finding was looked for and is absent is a
  // clinical statement; saying nothing is not, and only the second refuses.
  const absent = curb65({ ...SEVERE_PNEUMONIA, confusion: false });
  assert.equal(absent.complete, true);
  assert.equal(absent.complete && absent.score, 4, "a stated absence scores zero for that criterion");

  const unstated = curb65({ ...SEVERE_PNEUMONIA, confusion: undefined });
  assert.equal(unstated.complete, false, "an unstated criterion refuses");
});

test("every missing input is named, not just the first", () => {
  const empty = curb65({});
  assert.equal(empty.complete, false);
  assert.deepEqual(
    empty.complete === false && empty.missing,
    ["confusion", "ureaMmolL", "respiratoryRate", "systolicBp", "diastolicBp", "ageYears"],
    "a clinician should not have to resubmit six times to learn what is needed"
  );
});

test("CURB-65 matches the published thresholds and bands", () => {
  const severe = curb65(SEVERE_PNEUMONIA);
  assert.equal(severe.complete && severe.score, 5);
  assert.equal(severe.complete && severe.band, "severe");

  // A well 30-year-old with none of the criteria.
  const well = curb65({
    confusion: false,
    ureaMmolL: 4,
    respiratoryRate: 16,
    systolicBp: 120,
    diastolicBp: 78,
    ageYears: 30,
  });
  assert.equal(well.complete && well.score, 0);
  assert.equal(well.complete && well.band, "low");
});

test("either limb of the blood pressure criterion qualifies", () => {
  // The published criterion is SBP < 90 *or* DBP <= 60. An implementation that
  // checked systolic alone would miss a patient shocked in the diastolic.
  const diastolicOnly = curb65({
    confusion: false,
    ureaMmolL: 4,
    respiratoryRate: 16,
    systolicBp: 118,
    diastolicBp: 58,
    ageYears: 40,
  });
  assert.equal(diastolicOnly.complete && diastolicOnly.components.bloodPressure, 1);
});

test("CHA₂DS₂-VASc weights age and stroke at two, and never double-counts age", () => {
  const elderly = cha2ds2Vasc({
    congestiveHeartFailure: true,
    hypertension: true,
    ageYears: 78,
    diabetes: true,
    strokeTiaThromboembolism: false,
    vascularDisease: false,
    sexFemale: false,
  });
  // CHF 1 + HTN 1 + age≥75 2 + DM 1 = 5, and the 65–74 band must not also fire.
  assert.equal(elderly.complete && elderly.score, 5);
  assert.equal(elderly.complete && elderly.components.age65To74, 0);

  const midBand = cha2ds2Vasc({
    congestiveHeartFailure: false,
    hypertension: false,
    ageYears: 70,
    diabetes: false,
    strokeTiaThromboembolism: false,
    vascularDisease: false,
    sexFemale: false,
  });
  assert.equal(midBand.complete && midBand.score, 1);
});

test("HAS-BLED reads as a prompt about modifiable risk, not a veto", () => {
  const bleeder = hasBled({
    uncontrolledHypertension: true,
    abnormalRenalFunction: true,
    abnormalLiverFunction: false,
    strokeHistory: true,
    bleedingHistoryOrPredisposition: true,
    labileInr: false,
    ageYears: 80,
    antiplateletOrNsaid: true,
    alcoholExcess: false,
  });
  assert.equal(bleeder.complete && bleeder.score, 6);
  assert.equal(bleeder.complete && bleeder.band, "high");
  assert.match(
    bleeder.complete ? bleeder.interpretation : "",
    /not by itself a reason to withhold/,
    "a high bleeding score is a reason to look at modifiable factors, not to stop anticoagulation"
  );
});

test("Wells carries its half-points without floating-point drift", () => {
  const likely = wellsPe({
    clinicalSignsOfDvt: true,
    peIsLeadingDiagnosis: true,
    heartRate: 110,
    immobilisationOrSurgery: false,
    previousPeOrDvt: false,
    haemoptysis: false,
    malignancy: false,
  });
  assert.equal(likely.complete && likely.score, 7.5);
  assert.equal(likely.complete && likely.band, "high");
});

test("HEART bands a low-risk chest pain and refuses a nonsense grade", () => {
  const low = heart({
    history: "slightly-suspicious",
    ecg: "normal",
    ageYears: 38,
    riskFactors: "none",
    troponin: "at-or-below-normal",
  });
  assert.equal(low.complete && low.score, 0);
  assert.equal(low.complete && low.band, "low");

  const high = heart({
    history: "highly-suspicious",
    ecg: "significant-st-deviation",
    ageYears: 70,
    riskFactors: "three-or-more-or-atherosclerotic-disease",
    troponin: "above-three-times-normal",
  });
  assert.equal(high.complete && high.score, 10);

  assert.throws(
    () => heart({ ...low, history: "very-suspicious" as never }),
    (err: unknown) => err instanceof Refusal && /must be one of/.test((err as Error).message)
  );
});

test("MELD-Na bounds its inputs the way the published formula does", () => {
  // A normal-ish set: values under 1.0 are floored so a logarithm cannot turn
  // a normal laboratory result into a negative contribution.
  const compensated = meldNa({
    creatinineMgDl: 0.8,
    bilirubinMgDl: 0.9,
    inr: 0.9,
    sodiumMeqL: 140,
    dialysisTwiceInPastWeek: false,
  });
  assert.equal(compensated.complete && compensated.score, 6, "the floor produces the published minimum");
  assert.equal(compensated.complete && compensated.components.sodiumUsed, 137, "sodium is bounded at 137");

  // Dialysis forces creatinine to 4.0 regardless of the measured value, because
  // a dialysed patient's creatinine understates their renal failure.
  const dialysed = meldNa({
    creatinineMgDl: 1.1,
    bilirubinMgDl: 3,
    inr: 1.6,
    sodiumMeqL: 130,
    dialysisTwiceInPastWeek: true,
  });
  assert.equal(dialysed.complete && dialysed.components.creatinineUsed, 4);
  assert.ok(
    dialysed.complete && compensated.complete && dialysed.score > compensated.score,
    "forcing creatinine to 4.0 must raise the score, not lower it"
  );
});

test("CIWA-Ar scores its ten items and refuses one out of range", () => {
  const items = {
    nauseaVomiting: 2,
    tremor: 3,
    paroxysmalSweats: 3,
    anxiety: 3,
    agitation: 2,
    tactileDisturbances: 1,
    auditoryDisturbances: 1,
    visualDisturbances: 1,
    headache: 2,
    orientation: 1,
  };
  const moderate = ciwaAr(items);
  assert.equal(moderate.complete && moderate.score, 19);
  assert.equal(moderate.complete && moderate.band, "moderate");

  assert.throws(() => ciwaAr({ ...items, tremor: 9 }), /scored 0 to 7/);
  assert.throws(() => ciwaAr({ ...items, orientation: 6 }), /scored 0 to 4/);
});

test("Charlson weights conditions and adds a point per decade over 40", () => {
  const complex = charlson({
    myocardialInfarction: false,
    congestiveHeartFailure: true,
    peripheralVascularDisease: false,
    cerebrovascularDisease: false,
    dementia: false,
    chronicPulmonaryDisease: false,
    connectiveTissueDisease: false,
    pepticUlcerDisease: false,
    mildLiverDisease: false,
    diabetesWithoutComplications: true,
    hemiplegia: false,
    moderateOrSevereRenalDisease: true,
    diabetesWithEndOrganDamage: false,
    tumourWithinFiveYears: false,
    leukaemia: false,
    lymphoma: false,
    moderateOrSevereLiverDisease: false,
    metastaticSolidTumour: false,
    aids: false,
    ageYears: 70,
  });
  // CHF 1 + DM 1 + renal 2 = 4, plus three age points for 70.
  assert.equal(complex.complete && complex.score, 7);
  assert.equal(complex.complete && complex.components.age, 3);
});

test("LACE bands length of stay rather than counting days linearly", () => {
  const risky = lace({
    lengthOfStayDays: 15,
    acuteEmergentAdmission: true,
    charlsonScore: 4,
    edVisitsPastSixMonths: 5,
  });
  // LOS ≥14 is 7, acute is 3, Charlson ≥4 is 5, ED visits cap at 4.
  assert.equal(risky.complete && risky.score, 19);
  assert.equal(risky.complete && risky.band, "high");

  const short = lace({
    lengthOfStayDays: 0.5,
    acuteEmergentAdmission: false,
    charlsonScore: 0,
    edVisitsPastSixMonths: 0,
  });
  assert.equal(short.complete && short.score, 0);
});

test("NEWS2 escalates on a single deranged parameter even when the total is low", () => {
  // The property a plain aggregate misses: a patient can be unremarkable
  // everywhere except one axis, and that axis alone warrants review.
  const oneBadAxis = news2({
    respiratoryRate: 16,
    oxygenSaturation: 98,
    onSupplementalOxygen: false,
    systolicBp: 118,
    heartRate: 38,
    alert: true,
    temperatureC: 36.8,
  });
  assert.equal(oneBadAxis.complete && oneBadAxis.score, 3);
  assert.equal(oneBadAxis.complete && oneBadAxis.band, "low-medium");
  assert.match(oneBadAxis.complete ? oneBadAxis.interpretation : "", /single parameter scores 3/);

  const spread = news2({
    respiratoryRate: 22,
    oxygenSaturation: 94,
    onSupplementalOxygen: false,
    systolicBp: 105,
    heartRate: 95,
    alert: true,
    temperatureC: 38.5,
  });
  // 2 + 1 + 0 + 1 + 1 + 0 + 1 = 6, with nothing scoring 3.
  assert.equal(spread.complete && spread.score, 6);
  assert.equal(spread.complete && spread.band, "medium");

  const well = news2({
    respiratoryRate: 16,
    oxygenSaturation: 98,
    onSupplementalOxygen: false,
    systolicBp: 118,
    heartRate: 72,
    alert: true,
    temperatureC: 36.8,
  });
  assert.equal(well.complete && well.score, 0);
  assert.equal(well.complete && well.band, "none");
});

test("supplemental oxygen scores even when the saturation it produces looks fine", () => {
  // A patient at 98% on oxygen is not a patient at 98% on air.
  const onAir = news2({
    respiratoryRate: 16, oxygenSaturation: 98, onSupplementalOxygen: false,
    systolicBp: 118, heartRate: 72, alert: true, temperatureC: 36.8,
  });
  const onOxygen = news2({
    respiratoryRate: 16, oxygenSaturation: 98, onSupplementalOxygen: true,
    systolicBp: 118, heartRate: 72, alert: true, temperatureC: 36.8,
  });
  assert.equal(onAir.complete && onAir.score, 0);
  assert.equal(onOxygen.complete && onOxygen.score, 2);
});

test("every score refuses an empty submission rather than returning zero", () => {
  // A zero score reads as "nothing wrong". None of these instruments may
  // produce one from an empty form.
  for (const id of SCORE_IDS) {
    const result = score(id, {});
    assert.equal(result.complete, false, `${id} must not score an empty submission`);
    assert.ok(result.complete === false && result.missing.length > 0, `${id} must name what it needs`);
  }
});

test("an unknown score is refused, not silently skipped", () => {
  assert.throws(
    () => score("apache-iv", {}),
    (err: unknown) => err instanceof Refusal && /unknown score apache-iv/.test((err as Error).message)
  );
});

test("a completed score shows its working", () => {
  // The number has to be auditable: a clinician who disagrees needs to see
  // which criterion fired, not just the total.
  const r = curb65(SEVERE_PNEUMONIA);
  assert.equal(r.complete, true);
  if (!r.complete) return;
  assert.deepEqual(r.components, {
    confusion: 1,
    urea: 1,
    respiratoryRate: 1,
    bloodPressure: 1,
    age: 1,
  });
  assert.equal(
    Object.values(r.components).reduce((a, b) => a + b, 0),
    r.score,
    "the components must add up to the score they explain"
  );
});
