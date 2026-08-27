/**
 * The denominator is the measure.
 *
 * Section 12 asks who in a population needs something they have not had. The
 * arithmetic is easy; the denominator is not.
 *
 * A diabetes registry reports control by dividing patients whose last HbA1c
 * was under target by patients with a recent HbA1c. Patients with no recent
 * HbA1c fall out of both halves — and those are, precisely and not
 * coincidentally, the people nobody has managed. The measure therefore reads
 * best exactly where care is worst, silently: no error, no warning, a clean
 * percentage on a dashboard a health region plans around.
 *
 * The first two tests are that failure, built deliberately and required to be
 * refused. The rest are the ordinary correctness the refusal depends on.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../src/db.ts";
import { ClinicalRecord } from "../src/clinical/record.ts";
import { MedicationStore } from "../src/meds/store.ts";
import { OrderStore } from "../src/orders/store.ts";
import { Registry, type CohortRule, type MeasureRule } from "../src/population/registry.ts";

const GP = { actorId: "dr-tetso", actorKind: "practitioner" };
const GP_AUTHOR = { authorId: "dr-tetso", authorKind: "practitioner" };
const NOW = "2026-06-01T00:00:00Z";
const daysAgo = (n: number) => new Date(new Date(NOW).getTime() - n * 86_400_000).toISOString();

const DIABETES: CohortRule = {
  id: "dm",
  name: "Diabetes register",
  conditionCodes: ["diabetes"],
};

const HBA1C_CONTROL: MeasureRule = {
  id: "dm-hba1c",
  name: "HbA1c below 8.0% in the last year",
  withinDays: 365,
  target: { code: "4548-4", below: 8.0 },
};

function region() {
  const dir = mkdtempSync(join(tmpdir(), "northstar-reg-"));
  const db = new Db(join(dir, "northstar.db"));
  const record = new ClinicalRecord(db);
  const meds = new MedicationStore(db);
  const orders = new OrderStore(db);
  return {
    db,
    record,
    meds,
    orders,
    reg: new Registry(db),
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function patient(r: ReturnType<typeof region>, id: string, opts: { birthDate?: string | null; diabetic?: boolean } = {}) {
  r.record.record({
    entryType: "Patient",
    patientId: id,
    content: {
      resourceType: "Patient",
      identifier: [{ system: "urn:jhn", value: id }],
      name: [{ family: "Beaulieu", given: [id] }],
      ...(opts.birthDate === null ? {} : { birthDate: opts.birthDate ?? "1970-01-01" }),
    },
    authorId: "adt-feed",
    authorKind: "device",
  });
  if (opts.diabetic !== false) {
    r.record.record({
      entryType: "Condition",
      patientId: id,
      content: { resourceType: "Condition", code: { text: "Type 2 diabetes mellitus" } },
      ...GP_AUTHOR,
    });
  }
  return id;
}

function hba1c(r: ReturnType<typeof region>, patientId: string, value: string, at: string) {
  const o = r.orders.create({
    patientId,
    category: "lab",
    code: "4548-4",
    display: "HbA1c",
    indication: "Diabetes review",
    by: GP,
  });
  r.orders.place(o.id, { ...GP, responsibleId: "dr-tetso" });
  return r.orders.report({
    patientId,
    orderId: o.id,
    code: "4548-4",
    display: "HbA1c",
    value,
    reportedBy: "analyser",
    reportedAt: at,
  });
}

test("patients nobody tested are in the denominator, not dropped from it", () => {
  // The failure the module exists for. Four diabetics: two tested and
  // controlled, two never tested at all. The naive measure divides 2 by 2 and
  // reports 100% control — and the two it dropped are the two nobody has
  // managed, which is why they have no result.
  const r = region();
  try {
    patient(r, "tested-good-1");
    patient(r, "tested-good-2");
    patient(r, "never-tested-1");
    patient(r, "never-tested-2");
    hba1c(r, "tested-good-1", "6.8", daysAgo(30));
    hba1c(r, "tested-good-2", "7.2", daysAgo(60));

    const m = r.reg.measure(DIABETES, HBA1C_CONTROL, NOW);

    assert.equal(m.denominator, 4, "everyone in the cohort, not everyone assessable");
    assert.equal(m.numerator, 2);
    assert.equal(m.unclassified.length, 2);
    assert.deepEqual(m.unclassified.map((u) => u.reason), ["no-qualifying-observation", "no-qualifying-observation"]);
    assert.equal(m.complete, false);
    assert.equal(
      m.rate,
      null,
      "half the cohort unassessed, so no rate — a number that is wrong is worse than none, because a number gets planned around"
    );
    assert.match(m.caveat!, /2 of 4 patients \(50%\) could not be assessed/);
    assert.match(m.caveat!, /the unassessed are typically the least managed/);
  } finally {
    r.cleanup();
  }
});

test("a small unassessed group still counts against the rate rather than vanishing", () => {
  // Below the refusal threshold a rate is produced — a measure that always
  // refused would be ignored — but the unassessed stay in the denominator, so
  // the rate falls when people stop being tested rather than rising.
  const r = region();
  try {
    for (let i = 0; i < 9; i++) {
      patient(r, `p${i}`);
      hba1c(r, `p${i}`, "6.5", daysAgo(30));
    }
    patient(r, "untested");

    const m = r.reg.measure(DIABETES, HBA1C_CONTROL, NOW);
    assert.equal(m.denominator, 10);
    assert.equal(m.numerator, 9);
    assert.equal(m.rate, 0.9, "nine of ten, not nine of nine");
    assert.equal(m.complete, false);
    assert.match(m.caveat!, /counted in the denominator, not excluded from it/);

    // And the direction that matters: a patient stopping being tested must
    // make the measure worse, never better.
    patient(r, "another-untested");
    const worse = r.reg.measure(DIABETES, HBA1C_CONTROL, NOW);
    assert.ok(worse.rate! < m.rate!, "a measure that improves when somebody stops being tested measures the wrong thing");
  } finally {
    r.cleanup();
  }
});

test("a result outside the window is not an answer, and says so distinctly", () => {
  const r = region();
  try {
    patient(r, "stale");
    for (let i = 0; i < 9; i++) {
      patient(r, `ok${i}`);
      hba1c(r, `ok${i}`, "6.5", daysAgo(30));
    }
    hba1c(r, "stale", "6.1", daysAgo(400));

    const m = r.reg.measure(DIABETES, HBA1C_CONTROL, NOW);
    assert.equal(m.denominator, 10);
    assert.equal(m.numerator, 9, "a good number from two years ago is not evidence of control now");
    assert.deepEqual(m.unclassified, [{ patientId: "stale", reason: "no-qualifying-observation" }]);
  } finally {
    r.cleanup();
  }
});

test("a value that is not a number is unclassified, never counted as a pass", () => {
  // "Sample haemolysed" parsed as 0 is below 8.0, and would count as control.
  const r = region();
  try {
    patient(r, "haemolysed");
    for (let i = 0; i < 9; i++) {
      patient(r, `ok${i}`);
      hba1c(r, `ok${i}`, "6.5", daysAgo(30));
    }
    hba1c(r, "haemolysed", "sample haemolysed", daysAgo(10));

    const m = r.reg.measure(DIABETES, HBA1C_CONTROL, NOW);
    assert.equal(m.numerator, 9);
    assert.deepEqual(m.unclassified, [{ patientId: "haemolysed", reason: "value-not-numeric" }]);
    assert.equal(m.denominator, 10);
  } finally {
    r.cleanup();
  }
});

test("a patient with no birth date is unclassified rather than silently excluded", () => {
  // How a paediatric measure comes to exclude every patient registered by a
  // feed that does not send a date of birth — and reports a clean rate over
  // the rest.
  const r = region();
  try {
    patient(r, "adult", { birthDate: "1970-01-01" });
    patient(r, "no-dob", { birthDate: null });

    const adults: CohortRule = { ...DIABETES, minAgeYears: 18 };
    const { members, unclassified } = r.reg.cohort(adults, NOW);

    assert.deepEqual(members.map((m) => m.patientId), ["adult"]);
    assert.deepEqual(unclassified, [{ patientId: "no-dob", reason: "no-birth-date" }]);

    // And it reaches the measure, where it counts against the denominator.
    const m = r.reg.measure(adults, HBA1C_CONTROL, NOW);
    assert.equal(m.denominator, 2);
    assert.equal(m.rate, null);
    assert.ok(m.unclassified.some((u) => u.reason === "no-birth-date"));
  } finally {
    r.cleanup();
  }
});

test("cohort membership carries its reason, so a clinician can argue with one patient", () => {
  // A list nobody can argue with in detail is one they dismiss wholesale.
  const r = region();
  try {
    patient(r, "by-condition");
    patient(r, "by-drug", { diabetic: false });
    r.meds.record({
      patientId: "by-drug",
      code: "860975",
      display: "Metformin 500mg",
      ingredient: "metformin",
      source: "prescribed",
      adherence: "taking",
      by: GP,
    });

    const rule: CohortRule = { ...DIABETES, medicationIngredients: ["metformin"] };
    const { members } = r.reg.cohort(rule, NOW);
    assert.equal(members.length, 2);
    assert.match(members.find((m) => m.patientId === "by-condition")!.because, /condition diabetes/);
    assert.match(members.find((m) => m.patientId === "by-drug")!.because, /taking metformin/);
  } finally {
    r.cleanup();
  }
});

test("a condition a clinician retracted takes the patient off the register", () => {
  // A register that keeps someone on it after the diagnosis was declared
  // entered-in-error keeps recalling them for a disease they do not have.
  const r = region();
  try {
    patient(r, "keeps");
    patient(r, "corrected");
    const wrong = r.record.chart("corrected", { entryType: "Condition" })[0];
    r.record.retract(wrong.record_id, { ...GP_AUTHOR, reason: "recorded on the wrong patient" });

    const { members } = r.reg.cohort(DIABETES, NOW);
    assert.deepEqual(members.map((m) => m.patientId), ["keeps"]);
  } finally {
    r.cleanup();
  }
});

test("a drug the patient stopped taking does not keep them on the register", () => {
  const r = region();
  try {
    patient(r, "stopped", { diabetic: false });
    const s = r.meds.record({
      patientId: "stopped",
      code: "860975",
      display: "Metformin 500mg",
      ingredient: "metformin",
      source: "prescribed",
      adherence: "taking",
      by: GP,
    });
    const rule: CohortRule = { id: "dm", name: "Diabetes register", medicationIngredients: ["metformin"] };
    assert.equal(r.reg.cohort(rule, NOW).members.length, 1);

    r.meds.revise(s.id, { adherence: "not-taking" }, { ...GP, source: "patient-reported" });
    assert.equal(r.reg.cohort(rule, NOW).members.length, 0, "the register is of people taking it, not prescriptions");
  } finally {
    r.cleanup();
  }
});

test("never done and overdue are different gaps, and never done comes first", () => {
  // Different conversations: one patient has never been offered the test, the
  // other has been and did not come back.
  const r = region();
  try {
    patient(r, "never");
    patient(r, "overdue");
    patient(r, "current");
    hba1c(r, "overdue", "9.1", daysAgo(500));
    hba1c(r, "current", "6.4", daysAgo(20));

    const { gaps } = r.reg.gaps(DIABETES, { id: "g", name: "HbA1c yearly", withinDays: 365, satisfiedByResultCodes: ["4548-4"] }, NOW);

    assert.deepEqual(gaps.map((g) => g.patientId), ["never", "overdue"], "and the current patient is not chased");
    assert.equal(gaps[0].lastDone, null);
    assert.equal(gaps[0].overdueSinceDays, null, "never is not a very large number of days");
    assert.equal(gaps[1].overdueSinceDays, 500);
  } finally {
    r.cleanup();
  }
});

test("a gap satisfied by a medication rather than a test is closed", () => {
  // "Diabetic patients on a statin" is a gap closed by a prescription, not a
  // result, and a rule engine that only understood results would recall every
  // patient already treated.
  const r = region();
  try {
    patient(r, "on-statin");
    patient(r, "not-on-statin");
    r.meds.record({
      patientId: "on-statin",
      code: "617314",
      display: "Atorvastatin 40mg",
      ingredient: "atorvastatin",
      source: "prescribed",
      adherence: "taking",
      by: GP,
    });

    const { gaps } = r.reg.gaps(
      DIABETES,
      { id: "statin", name: "Statin for diabetes", withinDays: 365, satisfiedByMedications: ["atorvastatin"] },
      NOW
    );
    assert.deepEqual(gaps.map((g) => g.patientId), ["not-on-statin"]);
  } finally {
    r.cleanup();
  }
});

test("a measure counts the corrected value, not the one it replaced", () => {
  const r = region();
  try {
    for (let i = 0; i < 9; i++) {
      patient(r, `ok${i}`);
      hba1c(r, `ok${i}`, "6.5", daysAgo(30));
    }
    patient(r, "corrected");
    const first = hba1c(r, "corrected", "6.2", daysAgo(30));
    r.orders.correct(first.id, { value: "11.4", reportedBy: "analyser" });

    const m = r.reg.measure(DIABETES, HBA1C_CONTROL, NOW);
    assert.equal(m.denominator, 10);
    assert.equal(m.numerator, 9, "the correction is the value, and it is not controlled");
    assert.equal(m.complete, true);
    assert.equal(m.rate, 0.9);
    assert.equal(m.caveat, null);
  } finally {
    r.cleanup();
  }
});

test("an empty cohort reports nothing rather than a rate", () => {
  const r = region();
  try {
    const m = r.reg.measure(DIABETES, HBA1C_CONTROL, NOW);
    assert.equal(m.denominator, 0);
    assert.equal(m.rate, null, "zero over zero is not 0%, and a dashboard rendering 0% would be read as terrible care");
    assert.match(m.caveat!, /no patients in the cohort/);
  } finally {
    r.cleanup();
  }
});

test("registries are confined to their tenant", () => {
  const dir = mkdtempSync(join(tmpdir(), "northstar-reg-iso-"));
  const root = new Db(join(dir, "northstar.db"));
  try {
    root.createTenant("north", "Northern Health");
    root.createTenant("south", "Southern Health");
    const build = (t: string) => {
      const db = root.forTenant(t);
      return { record: new ClinicalRecord(db), meds: new MedicationStore(db), orders: new OrderStore(db), reg: new Registry(db), db };
    };
    const north = build("north");
    const south = build("south");

    // The same health number at two custodians: a province issues it, so this
    // is the normal case rather than an edge one.
    patient(north as never, "shared-id");
    hba1c(north as never, "shared-id", "6.1", daysAgo(30));

    assert.equal(north.reg.cohort(DIABETES, NOW).members.length, 1);
    assert.equal(south.reg.cohort(DIABETES, NOW).members.length, 0, "one custodian's register is not another's");
    assert.equal(south.reg.measure(DIABETES, HBA1C_CONTROL, NOW).denominator, 0);
    assert.equal(north.reg.measure(DIABETES, HBA1C_CONTROL, NOW).numerator, 1);
  } finally {
    root.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
