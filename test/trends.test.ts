/**
 * Item 63: a trend that never silently rescales, and a timeline that traces
 * back to what it summarises.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine } from "../src/core/engine.ts";

const PATIENT = "NT123456";
const GP = { authorId: "dr-tetso", authorKind: "practitioner" };
const LAB = "Synthetic Regional Laboratory";

async function clinic() {
  const engine = new Engine({ dbPath: ":memory:", tickMs: 15 });
  await engine.start();
  const t = engine.forTenant("default");
  t.clinical.record({
    entryType: "Patient",
    patientId: PATIENT,
    content: { resourceType: "Patient", identifier: [{ value: PATIENT }] },
    authorId: "adt",
    authorKind: "device",
  });
  return { engine, t, close: () => engine.stop() };
}

test("a result series keeps a correction next to the value it replaced", async () => {
  const s = await clinic();
  try {
    const first = s.t.orders.report({
      patientId: PATIENT,
      code: "2823-3",
      display: "Potassium",
      value: "6.9",
      unit: "mmol/L",
      referenceRange: "3.5-5.0",
      observedAt: "2026-01-01T09:00:00Z",
      reportedBy: LAB,
    });
    s.t.orders.correct(first.id, { value: "4.2", unit: "mmol/L", reportedBy: LAB, observedAt: "2026-01-01T09:00:00Z" });

    const series = s.t.trends.resultSeries(PATIENT, "2823-3");
    assert.equal(series.points.length, 2);
    assert.equal(series.points[0].value, 6.9);
    assert.equal(series.points[0].status, "final", "the superseded row itself is not rewritten");
    assert.equal(series.points[1].value, 4.2);
    assert.equal(series.points[1].status, "corrected");
    assert.equal(series.points[1].supersedes, first.id);
    assert.equal(series.comparableThroughout, true, "same unit throughout");
  } finally {
    await s.close();
  }
});

test("a result series in two different units is marked not comparable, never silently rescaled", async () => {
  const s = await clinic();
  try {
    s.t.orders.report({
      patientId: PATIENT,
      code: "2951-2",
      display: "Sodium",
      value: "140",
      unit: "mmol/L",
      observedAt: "2026-01-01T09:00:00Z",
      reportedBy: LAB,
    });
    s.t.orders.report({
      patientId: PATIENT,
      code: "2951-2",
      display: "Sodium",
      value: "322",
      unit: "mg/dL",
      observedAt: "2026-06-01T09:00:00Z",
      reportedBy: "A different laboratory",
    });

    const series = s.t.trends.resultSeries(PATIENT, "2951-2");
    assert.equal(series.comparableThroughout, false);
    assert.equal(series.incomparablePairs.length, 1);
    assert.match(series.incomparablePairs[0].reason, /no validated conversion/);
  } finally {
    await s.close();
  }
});

test("a vital series converts through the validated measurement contract, and refuses what it cannot", async () => {
  const s = await clinic();
  try {
    s.t.vitals.record({ patientId: PATIENT, kind: "temperature", value: 37, unit: "Cel", takenAt: "2026-01-01T09:00:00Z", by: GP });
    s.t.vitals.record({ patientId: PATIENT, kind: "temperature", value: 98.6, unit: "[degF]", takenAt: "2026-02-01T09:00:00Z", by: GP });

    const series = s.t.trends.vitalSeries(PATIENT, "temperature");
    assert.equal(series.points.length, 2);
    assert.equal(series.comparableThroughout, true, "Celsius and Fahrenheit are a validated conversion");
  } finally {
    await s.close();
  }
});

test("a vital series does not just assume a conversion — an incompatible unit is genuinely refused", async () => {
  const s = await clinic();
  try {
    s.t.vitals.record({ patientId: PATIENT, kind: "temperature", value: 37, unit: "Cel", takenAt: "2026-01-01T09:00:00Z", by: GP });
    // A unit the temperature scale neither recognizes nor converts from.
    s.t.vitals.record({ patientId: PATIENT, kind: "temperature", value: 12, unit: "furlong", takenAt: "2026-02-01T09:00:00Z", by: GP });

    const series = s.t.trends.vitalSeries(PATIENT, "temperature");
    assert.equal(series.comparableThroughout, false);
    assert.equal(series.incomparablePairs.length, 1);
  } finally {
    await s.close();
  }
});

test("staleness needs a real interval and never defaults one", async () => {
  const s = await clinic();
  try {
    s.t.orders.report({
      patientId: PATIENT,
      code: "4548-4",
      display: "HbA1c",
      value: "7.1",
      unit: "%",
      observedAt: "2025-01-01T00:00:00Z",
      reportedBy: LAB,
    });
    const series = s.t.trends.resultSeries(PATIENT, "4548-4");

    assert.throws(() => s.t.trends.staleness(series, 0), /positive number of days/);
    const stale = s.t.trends.staleness(series, 90, new Date("2026-01-01T00:00:00Z"));
    assert.equal(stale.stale, true);
    assert.ok(stale.daysSinceLast! > 300);

    const fresh = s.t.trends.staleness(series, 90, new Date("2025-01-15T00:00:00Z"));
    assert.equal(fresh.stale, false);
  } finally {
    await s.close();
  }
});

test("an empty series is not stale — there is nothing to be stale relative to", async () => {
  const s = await clinic();
  try {
    const series = s.t.trends.resultSeries(PATIENT, "no-such-code-yet");
    const result = s.t.trends.staleness(series, 30);
    assert.deepEqual(result, { stale: false, daysSinceLast: null });
  } finally {
    await s.close();
  }
});

test("a trend series is confined to its own patient and its own tenant", async () => {
  const s = await clinic();
  try {
    const other = "NT999999";
    s.t.clinical.record({
      entryType: "Patient",
      patientId: other,
      content: { resourceType: "Patient", identifier: [{ value: other }] },
      authorId: "adt",
      authorKind: "device",
    });
    s.t.orders.report({ patientId: other, code: "2823-3", display: "Potassium", value: "4.0", unit: "mmol/L", reportedBy: LAB });
    s.t.orders.report({ patientId: PATIENT, code: "2823-3", display: "Potassium", value: "4.5", unit: "mmol/L", reportedBy: LAB });

    assert.equal(s.t.trends.resultSeries(PATIENT, "2823-3").points.length, 1);
    assert.equal(s.t.trends.resultSeries(other, "2823-3").points.length, 1);

    const secondTenant = s.engine.forTenant("second-clinic");
    assert.deepEqual(secondTenant.trends.resultSeries(PATIENT, "2823-3").points, []);
  } finally {
    await s.close();
  }
});

// --------------------------------------------------------------- Timeline

test("the timeline merges every domain in order and points back to each source", async () => {
  const s = await clinic();
  try {
    // The result is dated in the far future and the rest in the recent
    // past, so a timeline that merely appended domains in the fixed order
    // this function reads them (results, then vitals, then procedures, then
    // goals and actions) would place the result FIRST — because orders are
    // read first in the code — while genuine sorting must place it LAST.
    // Reversed here specifically so date order and "the order the code
    // happens to read domains in" disagree, and only one of the two is what
    // this test can pass against.
    const procedure = s.t.procedures.record({
      patientId: PATIENT,
      procedure: "Wound dressing change",
      performedAt: "2026-03-01T09:00:00Z",
      by: GP,
    });
    const result = s.t.orders.report({
      patientId: PATIENT,
      code: "2823-3",
      display: "Potassium",
      value: "6.9",
      unit: "mmol/L",
      observedAt: "2099-01-01T09:00:00Z",
      reportedBy: LAB,
    });
    // A correction, filed after the fact: only the latest version of this
    // result belongs on the timeline, not the value it replaced.
    const corrected = s.t.orders.correct(result.id, { value: "4.1", unit: "mmol/L", reportedBy: LAB, observedAt: "2099-01-01T09:00:00Z" });
    const vital = s.t.vitals.record({
      patientId: PATIENT,
      kind: "heart-rate",
      value: 72,
      unit: "/min",
      takenAt: "2026-02-01T09:00:00Z",
      by: GP,
    });
    const plan = s.t.carePlans.record({ patientId: PATIENT, title: "Plan", goals: ["x"], reviewBy: "2027-01-01", by: GP });
    const goal = s.t.goals.approve(
      s.t.goals.propose({ patientId: PATIENT, carePlanId: plan.recordId, description: "Walk daily", by: GP }).recordId,
      GP
    );
    const proposedGoal = s.t.goals.propose({ patientId: PATIENT, carePlanId: plan.recordId, description: "Not agreed", by: GP });
    const approvedAction = s.t.actions.approve(
      s.t.actions.propose({ patientId: PATIENT, carePlanId: plan.recordId, description: "Book a follow-up", responsibleId: PATIENT, by: GP })
        .recordId,
      GP
    );
    const proposedAction = s.t.actions.propose({
      patientId: PATIENT,
      carePlanId: plan.recordId,
      description: "Not yet agreed action",
      responsibleId: PATIENT,
      by: GP,
    });

    const timeline = s.t.timeline.forPatient(PATIENT);
    const kinds = timeline.map((e) => e.kind);
    assert.ok(kinds.includes("result"));
    assert.ok(kinds.includes("vital"));
    assert.ok(kinds.includes("procedure"));
    assert.ok(kinds.includes("goal"));
    assert.ok(kinds.includes("action"));

    // In order, oldest first — despite procedures.record() being called first above.
    const times = timeline.map((e) => e.at);
    assert.deepEqual([...times].sort(), times);
    assert.equal(
      timeline[timeline.length - 1].kind,
      "result",
      "the result is dated latest and must sort last despite orders being read first in the code"
    );

    // Every entry traces back to a real record, and a correction shows its
    // current value only — the superseded row is not a second entry.
    const resultEntries = timeline.filter((e) => e.kind === "result");
    assert.equal(resultEntries.length, 1);
    assert.equal(resultEntries[0].sourceRecordId, corrected.id);
    assert.ok(!timeline.some((e) => e.sourceRecordId === result.id), "the superseded version is not its own timeline entry");

    const vitalEntry = timeline.find((e) => e.kind === "vital")!;
    assert.equal(vitalEntry.sourceRecordId, vital.recordId);
    const procedureEntry = timeline.find((e) => e.kind === "procedure")!;
    assert.equal(procedureEntry.sourceRecordId, procedure.recordId);
    const goalEntry = timeline.find((e) => e.kind === "goal")!;
    assert.equal(goalEntry.sourceRecordId, goal.recordId);
    const actionEntry = timeline.find((e) => e.kind === "action")!;
    assert.equal(actionEntry.sourceRecordId, approvedAction.recordId);

    // A mere suggestion nobody agreed to is not yet an event in this patient's history.
    assert.ok(!timeline.some((e) => e.sourceRecordId === proposedGoal.recordId));
    assert.ok(!timeline.some((e) => e.sourceRecordId === proposedAction.recordId));
  } finally {
    await s.close();
  }
});

test("a timeline with no source stores wired in is empty, not broken", async () => {
  const s = await clinic();
  try {
    const bare = new (await import("../src/clinical/timeline.ts")).Timeline({});
    assert.deepEqual(bare.forPatient(PATIENT), []);
  } finally {
    await s.close();
  }
});
