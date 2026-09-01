/**
 * The unit a value was measured in, and the one place it is allowed to matter.
 *
 * A score is arithmetic over numbers whose scale the request never carried.
 * `ureaMmolL` spells one unit into a parameter name; `requiredUnits` in the
 * catalogue writes another as prose; neither is compared to what the caller
 * actually sent. 98.6 is a normal temperature in Fahrenheit and an
 * unsurvivable one in Celsius, and nothing in the old contract could tell the
 * difference.
 *
 * These tests pin three things, in order of how easy each is to get wrong:
 *
 *  1. Equivalent labels are *not* conversions. `Cel`, `°C` and `degC` name one
 *     scale, and a value in any of them is scored exactly as sent.
 *  2. A real conversion changes the number, happens once at the boundary, and
 *     is recorded — a scorer never sees a unit and cannot tell that one ran.
 *  3. A mismatch that needs a fact about the substance rather than the units
 *     is refused, not guessed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../src/db.ts";
import { ClinicalRecord } from "../src/clinical/record.ts";
import { Vitals } from "../src/clinical/vitals.ts";
import { news2FromChart } from "../src/clinical/score-from-chart.ts";
import { score } from "../src/clinical/scores.ts";
import { SCORE_DEFINITIONS, SCORE_IDS } from "../src/clinical/score-definitions.ts";
import { ingest, canonicalise, SCORE_MEASUREMENTS, UCUM_SYSTEM, MEASUREMENT_CONTRACT } from "../src/clinical/measurement.ts";
import { Refusal } from "../src/core/refusal.ts";

const refusesWith = (pattern: RegExp) => (err: unknown) =>
  err instanceof Refusal && err.status === 400 && pattern.test(err.message);

// ── Equivalence: the same scale under another name ─────────────────────────

test("equivalent UCUM labels are accepted as sent, with no conversion applied", () => {
  // Every one of these names the Celsius scale. A caller who writes "°C"
  // where UCUM writes "Cel" has not made an error worth a refusal, and the
  // number must not move.
  for (const unit of ["Cel", "°C", "C", "degC", "celsius"]) {
    const { input, ingestion } = ingest({ temperature: { value: 38.4, unit } });
    assert.equal(input.temperatureC, 38.4, `${unit} should pass through unchanged`);
    const record = ingestion.measurements[0];
    assert.equal(record.converted, false, `${unit} is the same scale, not a conversion`);
    assert.equal(record.converted === false && record.canonical, "Cel");
  }
});

test("the spelling a caller is most likely to use is accepted for each scale", () => {
  const accepted: Array<[string, string, number]> = [
    ["systolicBp", "mmHg", 120],
    ["systolicBp", "mm[Hg]", 120],
    ["respiratoryRate", "/min", 18],
    ["respiratoryRate", "breaths/min", 18],
    ["heartRate", "bpm", 72],
    ["oxygenSaturation", "%", 97],
    ["urea", "mmol/L", 6],
    ["urea", "mmol/l", 6],
    ["creatinine", "mg/dL", 1.2],
    ["creatinine", "mg/dl", 1.2],
    ["age", "a", 70],
    ["age", "years", 70],
    ["lengthOfStay", "d", 4],
    ["lengthOfStay", "days", 4],
  ];
  for (const [name, unit, value] of accepted) {
    const { ingestion } = ingest({ [name]: { value, unit } });
    assert.equal(ingestion.measurements[0].converted, false, `${name} in ${unit} should be accepted as given`);
  }
});

// ── Conversion: a different scale, changed once, on the record ─────────────

test("Fahrenheit is converted to Celsius at the boundary, and the conversion is recorded", () => {
  const { input, ingestion } = ingest({ temperature: { value: 98.6, unit: "[degF]" } });
  assert.ok(Math.abs(input.temperatureC - 37) < 1e-9, `98.6F should be 37C, got ${input.temperatureC}`);

  const record = ingestion.measurements[0];
  assert.equal(record.converted, true);
  if (record.converted) {
    assert.deepEqual(record.from, { value: 98.6, unit: "[degF]" });
    assert.equal(record.to.unit, "Cel");
    assert.match(record.rule, /degF/);
  }
  assert.equal(ingestion.contract, MEASUREMENT_CONTRACT);
  assert.equal(ingestion.system, UCUM_SYSTEM);
});

test("a converted value scores identically to the same measurement sent canonically", () => {
  // The conversion is arithmetic at the edge, not a second scoring path. A
  // patient sent in Fahrenheit and the same patient sent in Celsius are the
  // same patient, and the scorer cannot tell which arrived.
  const criteria = { onSupplementalOxygen: false, alert: true };
  const fahrenheit = ingest({
    temperature: { value: 100.4, unit: "[degF]" },
    respiratoryRate: { value: 22, unit: "/min" },
    oxygenSaturation: { value: 94, unit: "%" },
    systolicBp: { value: 105, unit: "mmHg" },
    heartRate: { value: 115, unit: "/min" },
  });
  const celsius = ingest({
    temperature: { value: 38, unit: "Cel" },
    respiratoryRate: { value: 22, unit: "/min" },
    oxygenSaturation: { value: 94, unit: "%" },
    systolicBp: { value: 105, unit: "mmHg" },
    heartRate: { value: 115, unit: "/min" },
  });
  const a = score("news2", { ...criteria, ...fahrenheit.input });
  const b = score("news2", { ...criteria, ...celsius.input });
  assert.equal(a.complete, true);
  assert.equal(a.complete && a.score, b.complete && b.score);
  assert.equal(a.complete && a.band, b.complete && b.band);
});

test("hours convert to days, and months to years, without the scorer knowing", () => {
  const { input } = ingest({ lengthOfStay: { value: 72, unit: "h" } });
  assert.equal(input.lengthOfStayDays, 3);
  const { input: months } = ingest({ age: { value: 24, unit: "mo" } });
  assert.equal(months.ageYears, 2);
});

test("sodium in mmol/L is recorded as a conversion even though the number does not move", () => {
  // The scales coincide because sodium is monovalent — a fact about the
  // substance, not the units. The factor is 1, and it is still recorded,
  // because a reader should be able to see that the equality was relied on.
  const { input, ingestion } = ingest({ sodium: { value: 134, unit: "mmol/L" } });
  assert.equal(input.sodiumMeqL, 134);
  const record = ingestion.measurements[0];
  assert.equal(record.converted, true);
  assert.match(record.converted === true ? record.rule : "", /monovalent/);
});

// ── Refusal: a mismatch that needs a clinical fact ─────────────────────────

test("a molar concentration is refused against a mass threshold, rather than guessed", () => {
  // The example H-140 names. Relating µmol/L to mg/dL needs bilirubin's molar
  // mass, which is a fact about the analyte; choosing one here would be the
  // silent rescaling this contract exists to prevent.
  assert.throws(
    () => ingest({ bilirubin: { value: 45, unit: "umol/L" } }),
    refusesWith(/bilirubin was measured in umol\/L.*molar mass/s),
  );
  assert.throws(
    () => ingest({ creatinine: { value: 180, unit: "µmol/L" } }),
    refusesWith(/creatinine was measured in µmol\/L.*molar mass/s),
  );
});

test("urea in mg/dL is refused, because BUN and urea are not the same quantity", () => {
  assert.throws(
    () => ingest({ urea: { value: 25, unit: "mg/dL" } }),
    refusesWith(/blood urea nitrogen.*different quantities/s),
  );
});

test("an unrecognised unit is refused, and the refusal says what would be accepted", () => {
  assert.throws(
    () => ingest({ oxygenSaturation: { value: 97, unit: "furlongs" } }),
    (err: unknown) =>
      err instanceof Refusal &&
      /oxygenSaturation was measured in furlongs/.test(err.message) &&
      /scored in %/.test(err.message),
  );
});

test("a unit system other than UCUM is refused rather than assumed", () => {
  assert.throws(
    () => ingest({ temperature: { value: 37, unit: "Cel", system: "http://example.org/units" } }),
    refusesWith(/reads UCUM.*only/s),
  );
  // Stating UCUM explicitly is fine, and so is omitting it.
  assert.equal(ingest({ temperature: { value: 37, unit: "Cel", system: UCUM_SYSTEM } }).input.temperatureC, 37);
});

test("a measurement with no unit, or no value, is refused", () => {
  assert.throws(
    () => canonicalise("temperature", { value: 37 } as unknown as { value: number; unit: string }),
    refusesWith(/must state the unit/),
  );
  assert.throws(() => canonicalise("temperature", { unit: "Cel" } as unknown as { value: number; unit: string }), refusesWith(/finite numeric value/));
  assert.throws(() => canonicalise("temperature", { value: NaN, unit: "Cel" }), refusesWith(/finite numeric value/));
});

test("an input this contract does not measure is refused, and lists what it does", () => {
  assert.throws(
    () => ingest({ bloodMoon: { value: 1, unit: "1" } }),
    refusesWith(/bloodMoon is not a measured score input.*temperature/s),
  );
});

// ── The catalogue and the registry cannot drift apart ──────────────────────

test("every numeric unit the catalogue requires belongs to an input the contract measures", () => {
  // This is the "parallel untyped unit strings" defect as a test. requiredUnits
  // was free prose that nothing compared to anything; a score declaring a unit
  // for a numeric input the contract cannot resolve is that gap reopening.
  //
  // Two entries are deliberately not measurements, and are named here rather
  // than skipped by a rule, so that adding a third has to be a decision:
  //
  //  - heart.troponin describes where the *category* boundaries fall
  //    ("multiple of the assay upper reference limit"). Troponin is supplied
  //    as a graded category, not a number, so there is no scale to resolve.
  //  - ciwa-ar.items describes all nine items at once rather than naming an
  //    input; each item is registered individually as a dimensionless score.
  const NOT_MEASUREMENTS = ["heart.troponin", "ciwa-ar.items"];

  const fields = new Set(Object.values(SCORE_MEASUREMENTS).map((m) => m.field));
  const unmeasured: string[] = [];
  for (const id of SCORE_IDS) {
    for (const input of Object.keys(SCORE_DEFINITIONS[id].requiredUnits)) {
      if (!fields.has(input)) unmeasured.push(`${id}.${input}`);
    }
  }
  assert.deepEqual(
    unmeasured.sort(),
    [...NOT_MEASUREMENTS].sort(),
    "a required unit that names no measurable input is the parallel-strings gap reopening",
  );
});

// ── The chart is the other ingestion boundary ─────────────────────────────

function ward() {
  const dir = mkdtempSync(join(tmpdir(), "northstar-measure-"));
  const db = new Db(join(dir, "northstar.db"));
  const clinical = new ClinicalRecord(db);
  const vitals = new Vitals(clinical);
  clinical.record({
    entryType: "Patient",
    patientId: "NT123456",
    content: { resourceType: "Patient", id: "NT123456", birthDate: "1954-03-17" },
    authorId: "reg",
    authorKind: "system",
    source: "test",
  });
  return { db, vitals, deps: { vitals, clinical }, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

const NURSE = { authorId: "rn-tetso", authorKind: "practitioner" };
const TAKEN = "2026-08-27T19:45:00.000Z";
const NOW = "2026-08-27T20:00:00.000Z";

/** Records a full NEWS2 set, letting one vital carry an explicit unit. */
function observe(w: ReturnType<typeof ward>, over: { kind: "temperature"; value: number; unit?: string }) {
  const P = "NT123456";
  w.vitals.record({ patientId: P, kind: "respiratory-rate", takenAt: TAKEN, by: NURSE, value: 16 });
  w.vitals.record({ patientId: P, kind: "heart-rate", takenAt: TAKEN, by: NURSE, value: 72 });
  w.vitals.record({ patientId: P, kind: "oxygen-saturation", takenAt: TAKEN, by: NURSE, value: 98 });
  w.vitals.record({ patientId: P, kind: "blood-pressure", takenAt: TAKEN, by: NURSE, systolic: 118, diastolic: 76 });
  w.vitals.record({ patientId: P, kind: over.kind, takenAt: TAKEN, by: NURSE, value: over.value, ...(over.unit ? { unit: over.unit } : {}) });
}

test("a chart value in a convertible unit is converted at the boundary and shows its working", () => {
  // The value is present, fresh and real, and on a scale NEWS2 is not written
  // in. Scored as it stands, 99.1 degrees Fahrenheit is a temperature no
  // living patient has. It converts — the arithmetic is exact and needs
  // nothing but the units — and the conversion travels with the evidence
  // rather than happening invisibly.
  const w = ward();
  try {
    observe(w, { kind: "temperature", value: 99.1, unit: "[degF]" });
    const r = news2FromChart(w.deps, "NT123456", { onSupplementalOxygen: false, alert: true }, { asOf: NOW });
    assert.equal(r.result.complete, true);

    const temp = r.used.find((u) => u.input === "temperatureC");
    assert.ok(temp, "the temperature should have been used");
    assert.ok(Math.abs(temp!.value - 37.2777) < 0.001, `99.1F is 37.28C, got ${temp!.value}`);
    assert.equal(temp!.recordedUnit, "[degF]");
    assert.equal(temp!.conversion?.to, "Cel");
    assert.match(temp!.conversion?.rule ?? "", /degF/);

    // And the scorer saw a Celsius number: 37.28C is unremarkable, where the
    // raw 99.1 would have scored the top of the fever scale.
    assert.equal(r.result.complete && r.result.components.temperature, 0);
  } finally {
    w.cleanup();
  }
});

test("a chart value in a unit that cannot be read at all is unavailable, not scored", () => {
  // An interface that maps the wrong field writes a pressure into the
  // temperature. There is no conversion from mm[Hg] to Cel, and inventing one
  // is not on the table, so the input is reported unavailable exactly as a
  // stale or absent one is.
  const w = ward();
  try {
    observe(w, { kind: "temperature", value: 99.1, unit: "mm[Hg]" });
    const r = news2FromChart(w.deps, "NT123456", { onSupplementalOxygen: false, alert: true }, { asOf: NOW });
    assert.equal(r.result.complete, false, "a reading on an unreadable scale must not produce a score");
    const why = r.unavailable.find((u) => u.input === "temperatureC");
    assert.ok(why, "the temperature should be reported unavailable");
    assert.match(why!.reason, /recorded in mm\[Hg\].*scored in Cel/s);
  } finally {
    w.cleanup();
  }
});

test("a chart value in an equivalent unit is used, and the unit travels with the evidence", () => {
  const w = ward();
  try {
    observe(w, { kind: "temperature", value: 36.8, unit: "Cel" });
    const r = news2FromChart(w.deps, "NT123456", { onSupplementalOxygen: false, alert: true }, { asOf: NOW });
    assert.equal(r.result.complete, true);
    {
      const temp = r.used.find((u) => u.input === "temperatureC");
      assert.equal(temp?.value, 36.8);
      assert.equal(temp?.recordedUnit, "Cel");
      assert.equal(temp?.conversion, undefined, "the same scale is not a conversion");
    }
  } finally {
    w.cleanup();
  }
});

test("a chart value with no recorded unit is still used, and says that it had none", () => {
  // Vitals written before this contract carry no unit at all. Refusing them
  // would blind every chart-derived score to the existing record, so they are
  // used — and the evidence says the record did not state a scale, rather than
  // implying one was checked.
  const w = ward();
  try {
    observe(w, { kind: "temperature", value: 36.8 });
    const r = news2FromChart(w.deps, "NT123456", { onSupplementalOxygen: false, alert: true }, { asOf: NOW });
    assert.equal(r.result.complete, true);
    {
      const temp = r.used.find((u) => u.input === "temperatureC");
      assert.equal(temp?.value, 36.8);
      assert.equal(temp?.recordedUnit, null, "an absent unit is reported as absent, not guessed");
    }
  } finally {
    w.cleanup();
  }
});

test("blood pressure recorded with the store's own default unit is read, not refused", () => {
  // vitals.record defaults blood pressure to "mmHg". If the contract could not
  // read its own store's default, every chart-derived CURB-65 and NEWS2 would
  // refuse on a value that was never wrong.
  const w = ward();
  try {
    observe(w, { kind: "temperature", value: 36.8, unit: "Cel" });
    const r = news2FromChart(w.deps, "NT123456", { onSupplementalOxygen: false, alert: true }, { asOf: NOW });
    assert.equal(r.result.complete, true);
    {
      const sbp = r.used.find((u) => u.input === "systolicBp");
      assert.equal(sbp?.value, 118);
      assert.equal(sbp?.recordedUnit, "mmHg");
    }
  } finally {
    w.cleanup();
  }
});
