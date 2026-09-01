/**
 * The domain of a measurement, and why it is not one of its thresholds.
 *
 * `scores.test.ts` pins the rule that an input nobody stated yields no score.
 * This file pins the rule one step out from it: an input somebody stated that
 * no measurement could have produced yields no score *either*, and is not
 * reported as though it were absent.
 *
 * The difference is operational. "Nobody drew a urea" tells a clinician to go
 * and draw one. "The saturation you sent was 140%" tells a developer their
 * unit conversion is wrong, and there is nothing for a clinician to collect.
 * Folding the second into the first sends a real person looking for a
 * measurement that was never missing, while the defect that produced 140 goes
 * on producing it.
 *
 * Nothing here encodes a clinical judgement. Every bound under test is
 * definitional — a percentage cannot exceed 100, a count cannot be fractional,
 * nothing is colder than absolute zero, and CIWA-Ar's own items are scored
 * 0-7 — so no test in this file can move a real patient between bands.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  curb65,
  cha2ds2Vasc,
  hasBled,
  heart,
  charlson,
  ciwaAr,
  lace,
  meldNa,
  news2,
  wellsPe,
} from "../src/clinical/scores.ts";
import { Refusal } from "../src/core/refusal.ts";

/** A complete, unremarkable input for each scorer that needs a numeric field. */
const COMPLETE = {
  curb65: { confusion: false, ureaMmolL: 5, respiratoryRate: 16, systolicBp: 120, diastolicBp: 80, ageYears: 50 },
  news2: { respiratoryRate: 16, oxygenSaturation: 98, onSupplementalOxygen: false, systolicBp: 120, heartRate: 70, alert: true, temperatureC: 37 },
  lace: { lengthOfStayDays: 3, acuteEmergentAdmission: false, charlsonScore: 2, edVisitsPastSixMonths: 1 },
  meldNa: { creatinineMgDl: 1, bilirubinMgDl: 1, inr: 1, sodiumMeqL: 137, dialysisTwiceInPastWeek: false },
  ciwa: {
    nauseaVomiting: 0, tremor: 0, paroxysmalSweats: 0, anxiety: 0, agitation: 0,
    tactileDisturbances: 0, auditoryDisturbances: 0, visualDisturbances: 0, headache: 0, orientation: 0,
  },
} as const;

const refusesWith = (pattern: RegExp) => (err: unknown) =>
  err instanceof Refusal && err.status === 400 && pattern.test(err.message);

// ── Values no measurement could have produced ──────────────────────────────

test("a negative age is refused, in every instrument that asks for one", () => {
  // The same input name means the same thing in all four, because the domain
  // is keyed by the name and not by the scorer.
  assert.throws(() => curb65({ ...COMPLETE.curb65, ageYears: -1 }), refusesWith(/ageYears .*cannot be negative; got -1/));
  assert.throws(
    () => cha2ds2Vasc({ congestiveHeartFailure: false, hypertension: false, ageYears: -1, diabetes: false, strokeTiaThromboembolism: false, vascularDisease: false, sexFemale: false }),
    refusesWith(/ageYears .*cannot be negative/),
  );
  assert.throws(
    () => hasBled({ uncontrolledHypertension: false, abnormalRenalFunction: false, abnormalLiverFunction: false, strokeHistory: false, bleedingHistoryOrPredisposition: false, labileInr: false, ageYears: -0.5, antiplateletOrNsaid: false, alcoholExcess: false }),
    refusesWith(/ageYears .*cannot be negative/),
  );
  assert.throws(
    () => heart({ history: "slightly-suspicious", ecg: "normal", ageYears: -40, riskFactors: "none", troponin: "at-or-below-normal" }),
    refusesWith(/ageYears .*cannot be negative/),
  );
});

test("a saturation outside 0 to 100 is refused, and both ends of the range are accepted", () => {
  assert.throws(() => news2({ ...COMPLETE.news2, oxygenSaturation: 101 }), refusesWith(/oxygenSaturation .*0 to 100; got 101/));
  assert.throws(() => news2({ ...COMPLETE.news2, oxygenSaturation: -1 }), refusesWith(/oxygenSaturation .*0 to 100; got -1/));

  // 0 and 100 are readings, not errors: a saturation of 100% on oxygen is
  // ordinary, and refusing it would refuse a real patient.
  for (const spo2 of [0, 100]) {
    const r = news2({ ...COMPLETE.news2, oxygenSaturation: spo2 });
    assert.equal(r.complete, true);
  }
});

test("a CIWA-Ar item outside 0 to 7, or between whole numbers, is refused", () => {
  assert.throws(() => ciwaAr({ ...COMPLETE.ciwa, tremor: 8 }), refusesWith(/tremor .*0 to 7 in whole points; got 8/));
  assert.throws(() => ciwaAr({ ...COMPLETE.ciwa, tremor: -1 }), refusesWith(/tremor .*0 to 7 in whole points; got -1/));

  // The published instrument has no half-points. Before this, 3.5 scored 3.5.
  assert.throws(() => ciwaAr({ ...COMPLETE.ciwa, anxiety: 3.5 }), refusesWith(/anxiety .*whole points; got 3.5/));
  assert.throws(() => ciwaAr({ ...COMPLETE.ciwa, orientation: 2.5 }), refusesWith(/orientation .*whole points; got 2.5/));
  assert.throws(() => ciwaAr({ ...COMPLETE.ciwa, orientation: 5 }), refusesWith(/orientation .*0 to 4 in whole points; got 5/));

  // The extremes of both scales are legitimate.
  const worst = ciwaAr({
    nauseaVomiting: 7, tremor: 7, paroxysmalSweats: 7, anxiety: 7, agitation: 7,
    tactileDisturbances: 7, auditoryDisturbances: 7, visualDisturbances: 7, headache: 7, orientation: 4,
  });
  assert.equal(worst.complete, true);
  assert.equal(worst.complete && worst.score, 67);
});

test("a negative length of stay is refused, and a zero-day stay is not", () => {
  assert.throws(() => lace({ ...COMPLETE.lace, lengthOfStayDays: -2 }), refusesWith(/lengthOfStayDays .*cannot be negative; got -2/));
  const sameDay = lace({ ...COMPLETE.lace, lengthOfStayDays: 0 });
  assert.equal(sameDay.complete, true);
});

test("counts are refused when negative or fractional, because half a visit did not happen", () => {
  assert.throws(() => lace({ ...COMPLETE.lace, edVisitsPastSixMonths: -1 }), refusesWith(/edVisitsPastSixMonths .*negative or fractional; got -1/));
  assert.throws(() => lace({ ...COMPLETE.lace, edVisitsPastSixMonths: 1.5 }), refusesWith(/edVisitsPastSixMonths .*negative or fractional; got 1.5/));
  assert.throws(() => lace({ ...COMPLETE.lace, charlsonScore: -3 }), refusesWith(/charlsonScore .*negative or fractional; got -3/));
  assert.throws(() => lace({ ...COMPLETE.lace, charlsonScore: 2.5 }), refusesWith(/charlsonScore .*negative or fractional; got 2.5/));
});

test("negative laboratory concentrations and vital signs are refused", () => {
  assert.throws(() => curb65({ ...COMPLETE.curb65, ureaMmolL: -0.1 }), refusesWith(/ureaMmolL .*cannot be negative/));
  assert.throws(() => curb65({ ...COMPLETE.curb65, respiratoryRate: -4 }), refusesWith(/respiratoryRate .*cannot be negative/));
  assert.throws(() => curb65({ ...COMPLETE.curb65, systolicBp: -120 }), refusesWith(/systolicBp .*cannot be negative/));
  assert.throws(() => curb65({ ...COMPLETE.curb65, diastolicBp: -80 }), refusesWith(/diastolicBp .*cannot be negative/));
  assert.throws(() => meldNa({ ...COMPLETE.meldNa, creatinineMgDl: -1 }), refusesWith(/creatinineMgDl .*cannot be negative/));
  assert.throws(() => meldNa({ ...COMPLETE.meldNa, bilirubinMgDl: -1 }), refusesWith(/bilirubinMgDl .*cannot be negative/));
  assert.throws(() => meldNa({ ...COMPLETE.meldNa, inr: -1 }), refusesWith(/inr .*cannot be negative/));
  assert.throws(() => meldNa({ ...COMPLETE.meldNa, sodiumMeqL: -1 }), refusesWith(/sodiumMeqL .*cannot be negative/));
  assert.throws(
    () => wellsPe({ clinicalSignsOfDvt: false, peIsLeadingDiagnosis: false, heartRate: -70, immobilisationOrSurgery: false, previousPeOrDvt: false, haemoptysis: false, malignancy: false }),
    refusesWith(/heartRate .*cannot be negative/),
  );
});

test("a temperature below absolute zero is refused, and absolute zero itself is the bound", () => {
  assert.throws(() => news2({ ...COMPLETE.news2, temperatureC: -300 }), refusesWith(/temperatureC .*below absolute zero; got -300/));
  const atBound = news2({ ...COMPLETE.news2, temperatureC: -273.15 });
  assert.equal(atBound.complete, true);
});

// ── Non-finite and non-numeric values ──────────────────────────────────────

test("a non-finite value is refused as unusable, not reported as a missing input", () => {
  // This is the conflation the domain layer exists to end. NaN used to join
  // the missing list, so a caller whose arithmetic produced NaN was told to go
  // and measure something they had already measured.
  for (const bad of [NaN, Infinity, -Infinity]) {
    assert.throws(
      () => curb65({ ...COMPLETE.curb65, ureaMmolL: bad }),
      refusesWith(/ureaMmolL must be a finite number; got (NaN|Infinity|-Infinity)/),
      `${bad} should refuse`,
    );
  }
});

test("a value of the wrong type is refused by type, without echoing what was sent", () => {
  const sent = "<script>105</script>";
  assert.throws(
    () => curb65({ ...COMPLETE.curb65, respiratoryRate: sent as unknown as number }),
    (err: unknown) =>
      err instanceof Refusal &&
      err.status === 400 &&
      /respiratoryRate must be a finite number; got a string/.test(err.message) &&
      // Caller-supplied text reaches logs and operator screens. It is named by
      // type and not quoted back.
      !err.message.includes(sent),
  );
});

// ── What the domain layer deliberately did not change ──────────────────────

test("an input nobody stated is still missing, not refused", () => {
  const { ureaMmolL, ...noUrea } = COMPLETE.curb65;
  const r = curb65(noUrea);
  assert.equal(r.complete, false);
  assert.deepEqual(r.complete === false && r.missing, ["ureaMmolL"]);
  assert.ok(!("score" in r), "an incomplete result carries no score field");
});

test("an explicit null is absence, not an impossible value", () => {
  // A caller who serialises "no value" as null is saying nobody stated it.
  const r = curb65({ ...COMPLETE.curb65, ureaMmolL: null as unknown as number });
  assert.equal(r.complete, false);
  assert.deepEqual(r.complete === false && r.missing, ["ureaMmolL"]);
});

test("a criterion stated absent still scores zero, and is not confused with an unstated one", () => {
  const absent = curb65({ ...COMPLETE.curb65, confusion: false });
  assert.equal(absent.complete, true);
  assert.equal(absent.complete && absent.components.confusion, 0);

  const { confusion, ...unstated } = COMPLETE.curb65;
  const r = curb65(unstated);
  assert.equal(r.complete, false);
  assert.deepEqual(r.complete === false && r.missing, ["confusion"]);
});

test("an impossible value is reported ahead of the inputs that are merely missing", () => {
  // Both faults are present: the saturation cannot be a reading, and four
  // other inputs were never stated. The impossible one is reported, because
  // it is a defect in the caller and collecting the missing inputs would not
  // fix it.
  assert.throws(
    () => news2({ oxygenSaturation: 140, respiratoryRate: 16 }),
    refusesWith(/oxygenSaturation .*0 to 100; got 140/),
  );
});

test("a domain refusal happens before any arithmetic, so no partial score escapes", () => {
  // charlson sums nineteen weighted conditions before it reaches the age.
  // A bad age must not produce a result carrying the comorbidity subtotal.
  assert.throws(
    () => charlson({ myocardialInfarction: true, congestiveHeartFailure: true, peripheralVascularDisease: false, cerebrovascularDisease: false, dementia: false, chronicPulmonaryDisease: false, connectiveTissueDisease: false, pepticUlcerDisease: false, mildLiverDisease: false, diabetesWithoutComplications: false, hemiplegia: false, moderateOrSevereRenalDisease: false, diabetesWithEndOrganDamage: false, tumourWithinFiveYears: false, leukaemia: false, lymphoma: false, moderateOrSevereLiverDisease: false, metastaticSolidTumour: false, aids: false, ageYears: -1 }),
    refusesWith(/ageYears .*cannot be negative/),
  );
});
