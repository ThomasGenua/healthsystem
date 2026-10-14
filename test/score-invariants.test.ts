/**
 * Properties that hold across every instrument, whatever its arithmetic.
 *
 * `score-boundaries.test.ts` checks each threshold against the published
 * criterion — that CURB-65 awards its age point at 65 and HAS-BLED awards its
 * at 66. That is transcription: it catches a number typed wrong, and it can
 * only ever check the cases somebody thought to write down.
 *
 * This file checks the shape instead. A risk score is a sum of things that
 * make a patient worse, so finding one more of them cannot make the total
 * smaller. No individual boundary test says that, and an implementation can
 * pass every one of them while still, somewhere in a rewritten branch, paying
 * a patient a point for being sicker.
 *
 * ## Where the shape genuinely bends
 *
 * "More of a bad thing scores higher" is true of criteria, not of numbers. A
 * temperature of 35 °C scores 3 on NEWS2 and 37 °C scores 0, so *raising* that
 * value lowers the score — correctly, because the instrument is scoring
 * derangement in both directions and 35 °C is deranged. Asserting blanket
 * numeric monotonicity would fail on exactly the behaviour NEWS2 exists to
 * have.
 *
 * So each numeric criterion declares its direction, and the U-shaped ones are
 * named and asserted to *be* U-shaped. That way the property is a real
 * constraint rather than a lowest common denominator, and a later change that
 * quietly flattens NEWS2's low-end alarm fails here.
 *
 * ## What these are not
 *
 * They establish what this implementation does, and nothing about whether an
 * instrument should be used on a given patient. A score that satisfies every
 * property in this file is still
 * `implementation-tested-not-independently-clinically-validated`, which the
 * last test in the file asserts has not quietly changed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { score, type ScoreId, SCORE_IDS } from "../src/clinical/scores.ts";
import { SCORE_DEFINITIONS } from "../src/clinical/score-definitions.ts";

function complete(id: ScoreId, input: object) {
  const r = score(id, input);
  if (r.complete !== true) assert.fail(`${id} refused a complete input: ${r.reason}`);
  return r;
}

const CHARLSON_CONDITIONS = [
  "myocardialInfarction", "congestiveHeartFailure", "peripheralVascularDisease", "cerebrovascularDisease",
  "dementia", "chronicPulmonaryDisease", "connectiveTissueDisease", "pepticUlcerDisease", "mildLiverDisease",
  "diabetesWithoutComplications", "hemiplegia", "moderateOrSevereRenalDisease", "diabetesWithEndOrganDamage",
  "tumourWithinFiveYears", "leukaemia", "lymphoma", "moderateOrSevereLiverDisease", "metastaticSolidTumour", "aids",
] as const;

const CIWA_ITEMS = [
  "nauseaVomiting", "tremor", "paroxysmalSweats", "anxiety", "agitation",
  "tactileDisturbances", "auditoryDisturbances", "visualDisturbances", "headache",
] as const;

/** Every criterion at its lowest-risk setting, so anything added can only add. */
const BASE: Record<ScoreId, Record<string, unknown>> = {
  "curb-65": { confusion: false, ureaMmolL: 0, respiratoryRate: 0, systolicBp: 120, diastolicBp: 80, ageYears: 0 },
  "cha2ds2-vasc": { congestiveHeartFailure: false, hypertension: false, ageYears: 0, diabetes: false, strokeTiaThromboembolism: false, vascularDisease: false, sexFemale: false },
  "has-bled": { uncontrolledHypertension: false, abnormalRenalFunction: false, abnormalLiverFunction: false, strokeHistory: false, bleedingHistoryOrPredisposition: false, labileInr: false, ageYears: 0, antiplateletOrNsaid: false, alcoholExcess: false },
  "wells-pe": { clinicalSignsOfDvt: false, peIsLeadingDiagnosis: false, heartRate: 0, immobilisationOrSurgery: false, previousPeOrDvt: false, haemoptysis: false, malignancy: false },
  heart: { history: "slightly-suspicious", ecg: "normal", ageYears: 0, riskFactors: "none", troponin: "at-or-below-normal" },
  "meld-na": { creatinineMgDl: 1, bilirubinMgDl: 1, inr: 1, sodiumMeqL: 137, dialysisTwiceInPastWeek: false },
  "ciwa-ar": { ...Object.fromEntries(CIWA_ITEMS.map((i) => [i, 0])), orientation: 0 },
  charlson: { ...Object.fromEntries(CHARLSON_CONDITIONS.map((c) => [c, false])), ageYears: 0 },
  lace: { lengthOfStayDays: 0, acuteEmergentAdmission: false, charlsonScore: 0, edVisitsPastSixMonths: 0 },
  news2: { respiratoryRate: 16, oxygenSaturation: 98, onSupplementalOxygen: false, systolicBp: 120, heartRate: 70, alert: true, temperatureC: 37 },
};

/** Boolean criteria whose presence is the bad thing. */
const POSITIVE_FLAGS: Record<ScoreId, readonly string[]> = {
  "curb-65": ["confusion"],
  "cha2ds2-vasc": ["congestiveHeartFailure", "hypertension", "diabetes", "strokeTiaThromboembolism", "vascularDisease", "sexFemale"],
  "has-bled": ["uncontrolledHypertension", "abnormalRenalFunction", "abnormalLiverFunction", "strokeHistory", "bleedingHistoryOrPredisposition", "labileInr", "antiplateletOrNsaid", "alcoholExcess"],
  "wells-pe": ["clinicalSignsOfDvt", "peIsLeadingDiagnosis", "immobilisationOrSurgery", "previousPeOrDvt", "haemoptysis", "malignancy"],
  heart: [],
  "meld-na": ["dialysisTwiceInPastWeek"],
  "ciwa-ar": [],
  charlson: [...CHARLSON_CONDITIONS],
  lace: ["acuteEmergentAdmission"],
  // NEWS2's two flags are inverted from one another: needing oxygen is the bad
  // thing, and being alert is the good one, so `alert` is handled below.
  news2: ["onSupplementalOxygen"],
};

/** Graded criteria, listed from least to most severe. */
const LADDERS: Array<{ id: ScoreId; field: string; steps: readonly string[] }> = [
  { id: "heart", field: "history", steps: ["slightly-suspicious", "moderately-suspicious", "highly-suspicious"] },
  { id: "heart", field: "ecg", steps: ["normal", "non-specific-repolarisation", "significant-st-deviation"] },
  { id: "heart", field: "riskFactors", steps: ["none", "one-or-two", "three-or-more-or-atherosclerotic-disease"] },
  { id: "heart", field: "troponin", steps: ["at-or-below-normal", "one-to-three-times-normal", "above-three-times-normal"] },
];

/**
 * Numeric criteria and which way risk runs.
 *
 * `up` — a larger reading is a sicker patient. `down` — a smaller one is.
 * `both` — the instrument scores derangement in either direction, so the score
 * is U-shaped in this value and neither direction is monotone.
 */
const NUMERIC_DIRECTION: Array<{
  id: ScoreId;
  field: string;
  direction: "up" | "down" | "both";
  probes: readonly number[];
  /** Other fields held away from base so this criterion is actually live. */
  hold?: Record<string, number>;
}> = [
  { id: "curb-65", field: "ureaMmolL", direction: "up", probes: [0, 5, 7, 7.1, 12, 40] },
  { id: "curb-65", field: "respiratoryRate", direction: "up", probes: [0, 12, 29, 30, 45] },
  { id: "curb-65", field: "ageYears", direction: "up", probes: [0, 40, 64, 65, 90] },
  { id: "curb-65", field: "systolicBp", direction: "down", probes: [200, 120, 91, 90, 89, 40] },
  { id: "curb-65", field: "diastolicBp", direction: "down", probes: [120, 80, 61, 60, 30] },
  { id: "cha2ds2-vasc", field: "ageYears", direction: "up", probes: [0, 50, 64, 65, 74, 75, 95] },
  { id: "has-bled", field: "ageYears", direction: "up", probes: [0, 50, 65, 66, 95] },
  { id: "wells-pe", field: "heartRate", direction: "up", probes: [0, 60, 100, 101, 180] },
  { id: "heart", field: "ageYears", direction: "up", probes: [0, 44, 45, 64, 65, 95] },
  { id: "meld-na", field: "creatinineMgDl", direction: "up", probes: [0.5, 1, 2, 4, 8] },
  { id: "meld-na", field: "bilirubinMgDl", direction: "up", probes: [0.5, 1, 3, 10, 30] },
  { id: "meld-na", field: "inr", direction: "up", probes: [0.5, 1, 2, 4, 9] },
  // A falling sodium raises MELD-Na, which is the whole reason the Na term
  // exists — but only above a MELD of 11, per the UNOS formula. At the base
  // input MELD is 6.4, so the sodium term never runs and probing it there
  // asserts nothing: an inverted sodium term passed this file until the INR
  // was raised to bring MELD into the range where sodium counts.
  { id: "meld-na", field: "sodiumMeqL", direction: "down", probes: [140, 137, 133, 128, 125, 120], hold: { inr: 3 } },
  { id: "lace", field: "lengthOfStayDays", direction: "up", probes: [0, 1, 3, 6, 13, 30] },
  { id: "lace", field: "charlsonScore", direction: "up", probes: [0, 1, 3, 4, 12] },
  { id: "lace", field: "edVisitsPastSixMonths", direction: "up", probes: [0, 1, 4, 9] },
  { id: "charlson", field: "ageYears", direction: "up", probes: [0, 49, 50, 60, 70, 80, 100] },
  ...CIWA_ITEMS.map((f) => ({ id: "ciwa-ar" as ScoreId, field: f, direction: "up" as const, probes: [0, 1, 4, 7] })),
  { id: "ciwa-ar", field: "orientation", direction: "up", probes: [0, 1, 4] },
  // NEWS2 scores derangement in both directions; see the header.
  { id: "news2", field: "respiratoryRate", direction: "both", probes: [4, 8, 9, 12, 20, 21, 25, 40] },
  { id: "news2", field: "systolicBp", direction: "both", probes: [70, 90, 91, 101, 111, 219, 220, 260] },
  { id: "news2", field: "heartRate", direction: "both", probes: [30, 40, 41, 51, 91, 111, 131, 180] },
  { id: "news2", field: "temperatureC", direction: "both", probes: [33, 35, 35.1, 36.1, 38, 38.1, 39.1, 41] },
  // Saturation is the one NEWS2 parameter that runs one way only.
  { id: "news2", field: "oxygenSaturation", direction: "down", probes: [100, 96, 95, 94, 93, 92, 91, 70] },
];

const totalOf = (id: ScoreId, input: object) => complete(id, input).score;

// ── The property the whole file exists for ────────────────────────────────

test("adding a positive criterion never lowers the score", () => {
  for (const id of SCORE_IDS) {
    const base = BASE[id];
    const before = totalOf(id, base);
    for (const flag of POSITIVE_FLAGS[id]) {
      const after = totalOf(id, { ...base, [flag]: true });
      assert.ok(after >= before, `${id}: setting ${flag} lowered the score from ${before} to ${after}`);
    }
  }
});

test("losing alertness never lowers NEWS2, because the flag runs the other way", () => {
  const base = BASE.news2;
  const alert = totalOf("news2", base);
  const notAlert = totalOf("news2", { ...base, alert: false });
  assert.ok(notAlert >= alert, `a patient who is not alert scored ${notAlert} against ${alert}`);
});

test("every positive criterion together is at least every one of them alone", () => {
  // A stronger form: the flags do not interact to cancel each other out.
  for (const id of SCORE_IDS) {
    const flags = POSITIVE_FLAGS[id];
    if (flags.length === 0) continue;
    const all = totalOf(id, { ...BASE[id], ...Object.fromEntries(flags.map((f) => [f, true])) });
    for (const flag of flags) {
      const one = totalOf(id, { ...BASE[id], [flag]: true });
      assert.ok(all >= one, `${id}: all criteria together (${all}) scored below ${flag} alone (${one})`);
    }
  }
});

test("stepping a graded criterion up never lowers the score", () => {
  for (const { id, field, steps } of LADDERS) {
    let previous = -Infinity;
    for (const step of steps) {
      const total = totalOf(id, { ...BASE[id], [field]: step });
      assert.ok(total >= previous, `${id}.${field}: "${step}" scored ${total}, below the step before it (${previous})`);
      previous = total;
    }
  }
});

test("a numeric criterion moves the score only in its declared direction", () => {
  for (const { id, field, direction, probes, hold } of NUMERIC_DIRECTION) {
    if (direction === "both") continue;
    const ordered = direction === "up" ? [...probes].sort((a, b) => a - b) : [...probes].sort((a, b) => b - a);
    let previous = -Infinity;
    for (const value of ordered) {
      const total = totalOf(id, { ...BASE[id], ...(hold ?? {}), [field]: value });
      assert.ok(
        total >= previous,
        `${id}.${field} is declared ${direction}, but ${value} scored ${total} after ${previous}`,
      );
      previous = total;
    }
  }
});

test("the U-shaped NEWS2 parameters really are U-shaped, in both directions", () => {
  // Not a lowest-common-denominator escape from the property above: each of
  // these must genuinely score at both extremes and less in the middle, so a
  // change that flattens the low-end alarm — the one that catches a patient
  // going cold and bradycardic — fails here rather than passing quietly.
  for (const { id, field, direction, probes, hold } of NUMERIC_DIRECTION) {
    if (direction !== "both") continue;
    const totals = probes.map((v) => ({ v, total: totalOf(id, { ...BASE[id], ...(hold ?? {}), [field]: v }) }));
    const lowest = totals.reduce((a, b) => (b.total < a.total ? b : a));
    const first = totals[0];
    const last = totals[totals.length - 1];
    assert.ok(
      first.total > lowest.total,
      `${field}: the low extreme (${first.v}) scored ${first.total}, no more than the middle (${lowest.total})`,
    );
    assert.ok(
      last.total > lowest.total,
      `${field}: the high extreme (${last.v}) scored ${last.total}, no more than the middle (${lowest.total})`,
    );
  }
});

test("no numeric criterion is probed somewhere it cannot move the score", () => {
  // The guard on the two tests above. A probe set that produces one total
  // whatever the value asserts nothing at all, and passes forever — which is
  // exactly what MELD-Na's sodium did, because at the base input the score
  // sits below the threshold where the sodium term applies. A monotonicity
  // test that cannot fail is worse than no test, because it reads like cover.
  for (const { id, field, probes, hold } of NUMERIC_DIRECTION) {
    const totals = new Set(probes.map((v) => totalOf(id, { ...BASE[id], ...(hold ?? {}), [field]: v })));
    assert.ok(
      totals.size > 1,
      `${id}.${field}: every probe scored ${[...totals][0]}, so this criterion is being tested where it is inert`,
    );
  }
});

// ── Structural properties ─────────────────────────────────────────────────

test("an additive score is exactly the sum of the components it publishes", () => {
  // MELD-Na is excluded and named rather than skipped by a rule: its
  // components are the working of a logarithmic formula — the pre-sodium MELD,
  // the clamped sodium, the capped creatinine — and were never addends. A
  // reader who assumed otherwise would mis-add them, which is why the
  // distinction is asserted rather than left to be noticed.
  for (const id of SCORE_IDS) {
    if (id === "meld-na") continue;
    for (const input of [BASE[id], { ...BASE[id], ...Object.fromEntries(POSITIVE_FLAGS[id].map((f) => [f, true])) }]) {
      const r = complete(id, input);
      const sum = Object.values(r.components).reduce((a, b) => a + b, 0);
      assert.equal(r.score, sum, `${id}: score ${r.score} is not the sum of its components (${sum})`);
    }
  }
  const meld = complete("meld-na", BASE["meld-na"]);
  const meldSum = Object.values(meld.components).reduce((a, b) => a + b, 0);
  assert.notEqual(meld.score, meldSum, "MELD-Na's components are its working, not addends; this test should say so");
});

test("a score is a function of its input and nothing else", () => {
  for (const id of SCORE_IDS) {
    const input = { ...BASE[id], ...Object.fromEntries(POSITIVE_FLAGS[id].map((f) => [f, true])) };
    const a = complete(id, input);
    const b = complete(id, { ...input });
    assert.equal(a.score, b.score, `${id} is not deterministic`);
    assert.equal(a.band, b.band);
    assert.deepEqual(a.components, b.components);
  }
});

test("removing any one required input withholds the number entirely", () => {
  for (const id of SCORE_IDS) {
    const base = BASE[id];
    for (const field of Object.keys(base)) {
      const { [field]: _dropped, ...missing } = base;
      const r = score(id, missing);
      assert.equal(r.complete, false, `${id} produced a score without ${field}`);
      assert.ok(!("score" in r), `${id} without ${field} still carries a score field`);
      assert.ok(
        r.complete === false && r.missing.includes(field),
        `${id} did not name ${field} among its missing inputs`,
      );
    }
  }
});

test("a higher total never lands in a safer band", () => {
  // Bands are ordered least to most concerning. Walking the whole reachable
  // range of each score, the band index must never go down as the total rises.
  const ORDER: Record<ScoreId, readonly string[]> = {
    "curb-65": ["low", "moderate", "severe"],
    "cha2ds2-vasc": ["low", "intermediate", "high"],
    "has-bled": ["lower", "high"],
    "wells-pe": ["low", "moderate", "high"],
    heart: ["low", "moderate", "high"],
    "meld-na": ["low", "moderate", "high", "very high"],
    "ciwa-ar": ["minimal", "mild", "moderate", "severe"],
    charlson: ["none", "low", "moderate", "high"],
    lace: ["low", "moderate", "high"],
    news2: ["none", "low", "low-medium", "medium", "high"],
  };
  for (const id of SCORE_IDS) {
    if (id === "news2") continue; // its single-parameter escalation is not a function of the total
    const seen = new Map<number, string>();
    const base = BASE[id];
    const flags = POSITIVE_FLAGS[id];
    for (let n = 0; n <= flags.length; n++) {
      const r = complete(id, { ...base, ...Object.fromEntries(flags.slice(0, n).map((f) => [f, true])) });
      seen.set(r.score, r.band);
    }
    const totals = [...seen.keys()].sort((a, b) => a - b);
    let previous = -1;
    for (const t of totals) {
      const index = ORDER[id].indexOf(seen.get(t)!);
      assert.ok(index >= 0, `${id}: unknown band "${seen.get(t)}"`);
      assert.ok(index >= previous, `${id}: a score of ${t} banded as "${seen.get(t)}", safer than a lower score did`);
      previous = index;
    }
  }
});

test("NEWS2 escalates on one extreme parameter even where the total does not", () => {
  // The deliberate exception to the rule above, asserted so nobody removes it
  // to make the banding uniform.
  const single = complete("news2", { ...BASE.news2, oxygenSaturation: 91 });
  assert.equal(single.score, 3);
  assert.equal(single.band, "low-medium");
  const spread = complete("news2", { ...BASE.news2, heartRate: 111, oxygenSaturation: 94 });
  assert.equal(spread.score, 3);
  assert.equal(spread.band, "low", "the same total without a single 3 is not escalated");
});

// ── What passing all of the above still does not establish ────────────────

test("passing every property here leaves the assurance state unreviewed", () => {
  // The point of the file, stated as a test. These are implementation
  // properties. None of them is evidence that an instrument is fit for a
  // patient, and a green run must never be mistaken for one.
  for (const id of SCORE_IDS) {
    const a = SCORE_DEFINITIONS[id].assurance;
    assert.equal(a.status, "implementation-tested-not-independently-clinically-validated", `${id} changed its assurance status`);
    assert.equal(a.independentClinicalReview, false, `${id} claims an independent clinical review`);
    assert.equal(a.clinicalOwner, null, `${id} names a clinical owner`);
    assert.equal(a.reviewedAt, null, `${id} carries a review date`);
  }
});
