/**
 * De-identified release with small-cell suppression — #54.
 *
 * The property under test is exact: in the communities this system is built
 * for, a small count is a name. "3 of 41 uncontrolled" identifies people to
 * anyone who knows a community of 300, and so does "38 of 41 controlled",
 * because subtraction works. A release is aggregate counts, suppressed both
 * ways, wearing its method on its face — and it does not exist without a
 * recipient and a purpose.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { Db } from "../src/db.ts";
import { Engine } from "../src/core/engine.ts";
import { startApi } from "../src/api/admin.ts";
import { AuthGate } from "../src/auth/gate.ts";
import {
  releaseMeasure,
  releaseGaps,
  releaseWorkflowMeasure,
  DEFAULT_SUPPRESSION_THRESHOLD,
  type MeasureRelease,
} from "../src/population/release.ts";
import type { MeasureResult, CareGap } from "../src/population/registry.ts";
import type { WorkflowMeasureResult } from "../src/population/effectiveness.ts";

const TO = { recipient: "NWT quality improvement committee", purpose: "quarterly review" };
const AS_OF = "2026-08-26T00:00:00.000Z";

function measure(denominator: number, numerator: number, unclassified = 0): MeasureResult {
  return {
    ruleId: "hba1c-8",
    name: "HbA1c under 8",
    denominator,
    numerator,
    rate: denominator > 0 ? numerator / denominator : null,
    unclassified: Array.from({ length: unclassified }, (_, i) => ({
      patientId: `NT-U-${i}`,
      reason: "no-qualifying-observation" as const,
    })),
    complete: unclassified === 0,
    caveat: null,
  };
}

function workflowMeasure(denominator: number, numerator: number, unclassified = 0): WorkflowMeasureResult {
  return {
    metricId: "missed-appointments",
    name: "Missed appointments",
    from: "2026-08-01T00:00:00.000Z",
    to: "2026-08-31T00:00:00.000Z",
    asOf: AS_OF,
    denominator,
    numerator,
    rate: denominator > 0 ? numerator / denominator : null,
    unclassified: Array.from({ length: unclassified }, (_, i) => ({
      id: `booking-${i}`,
      patientId: `NT-U-${i}`,
      reason: "the appointment time has passed with no attendance outcome recorded",
    })),
    complete: unclassified === 0,
    caveat: null,
  };
}

function gap(patientId: string, lastDone: string | null): CareGap {
  return { patientId, ruleId: "a1c", name: "HbA1c", lastDone, overdueSinceDays: lastDone ? 400 : null };
}

function counts(r: MeasureRelease | ReturnType<typeof releaseGaps>): Record<string, number | null> {
  return Object.fromEntries(r.cells.map((c) => [c.label, c.count]));
}

test("a small cell is suppressed, and zero is published", () => {
  const r = releaseMeasure(measure(41, 3), AS_OF, TO);
  const byLabel = Object.fromEntries(r.cells.map((c) => [c.label, c]));
  assert.equal(byLabel["meeting target"].suppressed, true);
  assert.equal(byLabel["meeting target"].count, null);
  assert.equal(byLabel["meeting target"].reason, "small-cell");
  assert.equal(byLabel["cohort"].count, 41, "the cohort's size is not an attribute of anyone in it");
  assert.equal(r.method.threshold, DEFAULT_SUPPRESSION_THRESHOLD);

  const zero = releaseMeasure(measure(41, 0), AS_OF, TO);
  assert.equal(counts(zero)["meeting target"], 0, "the absence of patients names nobody");
});

test("38 of 41 is as identifying as 3 of 41: the complement is suppressed too", () => {
  // The 3 not meeting target are the identifiable ones; publishing 38 and
  // the cohort of 41 hands them back by subtraction.
  const r = releaseMeasure(measure(41, 38), AS_OF, TO);
  const byLabel = Object.fromEntries(r.cells.map((c) => [c.label, c]));
  assert.equal(byLabel["not meeting target"].suppressed, true, "the 3 are suppressed for their own size");
  assert.equal(byLabel["meeting target"].suppressed, true, "and the 38 for the 3's sake");
  assert.equal(byLabel["meeting target"].reason, "complementary");
  assert.ok(r.method.suppressedCells >= 2);
});

test("a rate that would undo the suppression is suppressed with it", () => {
  // 3/41 is not less identifying as 0.073: with the denominator published,
  // the rate is the numerator wearing a decimal point.
  const r = releaseMeasure(measure(41, 3), AS_OF, TO);
  assert.equal(r.rate, null);
  assert.match(r.caveat ?? "", /undo the suppression/);

  const fine = releaseMeasure(measure(41, 20), AS_OF, TO);
  assert.ok(fine.rate !== null, "an unsuppressed release keeps its rate");
});

test("no patient identifier appears anywhere in a release", () => {
  const m = measure(41, 3, 4);
  const r = releaseMeasure(m, AS_OF, TO);
  const flat = JSON.stringify(r);
  for (const u of m.unclassified) {
    assert.ok(!flat.includes(u.patientId), `${u.patientId} must not appear in the release`);
  }
  assert.equal(r.containsPatientLevelData, false);
  assert.ok(counts(r)["could not be assessed"] !== undefined, "unclassified stay counted, never dropped");
});

test("a gaps release splits never-done from overdue, and the halves protect each other", () => {
  const gaps = [gap("NT-1", null), gap("NT-2", null), gap("NT-3", null), gap("NT-4", "2025-01-01"), gap("NT-5", "2025-01-01"), gap("NT-6", "2025-01-01"), gap("NT-7", "2025-01-01")];
  // open = 7 (published), never-done = 3 (small), overdue = 4 (small):
  // both halves suppressed for their own size — and if only one had been
  // small, the other would go complementarily, because they sum to 7.
  const r = releaseGaps({ gaps, unclassified: [], cohortSize: 30 }, "a1c", "HbA1c", AS_OF, TO);
  const byLabel = Object.fromEntries(r.cells.map((c) => [c.label, c]));
  assert.equal(byLabel["gap open"].count, 7);
  assert.equal(byLabel["never done"].suppressed, true);
  assert.equal(byLabel["overdue"].suppressed, true);
  assert.equal(byLabel["gap closed"].count, 23);
});

test("halves of a suppressed total are suppressed with it", () => {
  // open = 3 (suppressed small) with closed = 27 published → closed goes
  // complementarily; and never-done 0 + overdue 3 would rebuild open by
  // addition, so the halves go too.
  const gaps = [gap("NT-1", "2025-01-01"), gap("NT-2", "2025-01-01"), gap("NT-3", "2025-01-01")];
  const r = releaseGaps({ gaps, unclassified: [], cohortSize: 30 }, "a1c", "HbA1c", AS_OF, TO);
  const byLabel = Object.fromEntries(r.cells.map((c) => [c.label, c]));
  assert.equal(byLabel["gap open"].suppressed, true);
  assert.equal(byLabel["gap closed"].suppressed, true);
  assert.equal(byLabel["gap closed"].reason, "complementary");
  assert.equal(byLabel["overdue"].suppressed, true, "a half of a suppressed total leaks a floor of it");
  assert.equal(byLabel["never done"].count, 0, "zero stays zero — it reveals nothing about the hidden count beyond what suppression admits");
});

test("a suppressed number does not survive in prose", () => {
  // The registry's caveat says "4 of 41 patients could not be assessed" —
  // the honesty the registry exists for, and in a release the exact leak
  // that would un-suppress the cell above it.
  const m = measure(41, 20, 4);
  m.caveat = "4 of 41 patients (10%) could not be assessed and are counted in the denominator, not excluded from it";
  const r = releaseMeasure(m, AS_OF, TO);
  const byLabel = Object.fromEntries(r.cells.map((c) => [c.label, c]));
  assert.equal(byLabel["could not be assessed"].suppressed, true);
  assert.ok(!(r.caveat ?? "").includes("4 of 41"), "the caveat must not carry the suppressed count");
  assert.match(r.caveat ?? "", /count is suppressed as a small cell/);
});

test("a release does not exist without a recipient and a purpose", () => {
  assert.throws(() => releaseMeasure(measure(41, 20), AS_OF, { recipient: " ", purpose: "review" }), /needs a recipient and a purpose/);
  assert.throws(() => releaseMeasure(measure(41, 20), AS_OF, { recipient: "QI", purpose: "" }), /needs a recipient and a purpose/);
});

// -------------------------------------------------- item 67's workflow metrics

test("a workflow metric is releasable through the same suppression, not a second implementation of it", () => {
  const small = releaseWorkflowMeasure(workflowMeasure(41, 3), TO);
  const byLabel = Object.fromEntries(small.cells.map((c) => [c.label, c]));
  assert.equal(byLabel["counted"].suppressed, true);
  assert.equal(byLabel["counted"].count, null);
  assert.equal(byLabel["in scope"].count, 41);
  assert.equal(small.method.threshold, DEFAULT_SUPPRESSION_THRESHOLD);
  assert.equal(small.metricId, "missed-appointments");
});

test("a workflow metric's complement protects the small cell the same way a clinical measure's does", () => {
  const r = releaseWorkflowMeasure(workflowMeasure(41, 38), TO);
  const byLabel = Object.fromEntries(r.cells.map((c) => [c.label, c]));
  assert.equal(byLabel["not counted"].suppressed, true, "the 3 not counted are suppressed for their own size");
  assert.equal(byLabel["not counted"].reason, "small-cell");
  assert.equal(byLabel["counted"].suppressed, true, "and the 38 counted for the 3's sake");
  assert.equal(byLabel["counted"].reason, "complementary");
});

test("a workflow metric's rate is withheld when publishing it would undo suppression", () => {
  const r = releaseWorkflowMeasure(workflowMeasure(41, 3), TO);
  assert.equal(r.rate, null);
  assert.match(r.caveat ?? "", /rate withheld/);
});

test("a workflow release still needs a recipient and a purpose", () => {
  assert.throws(
    () => releaseWorkflowMeasure(workflowMeasure(41, 20), { recipient: " ", purpose: "review" }),
    /needs a recipient and a purpose/
  );
});

test("an unclassified count suppressed as small does not leak its size through the caveat", () => {
  const m = workflowMeasure(41, 20, 3);
  m.caveat = "3 of 41 (7%) could not be classified either way";
  const r = releaseWorkflowMeasure(m, TO);
  const byLabel = Object.fromEntries(r.cells.map((c) => [c.label, c]));
  assert.equal(byLabel["could not be classified"].suppressed, true);
  assert.ok(!(r.caveat ?? "").includes("3 of 41"), "the caveat must not carry the suppressed count");
});

test("a threshold below 2 is refused as suppression in name only", () => {
  assert.throws(() => releaseMeasure(measure(41, 3), AS_OF, { ...TO, threshold: 1 }), /wearing the label/);
  const raised = releaseMeasure(measure(41, 7), AS_OF, { ...TO, threshold: 10 });
  const byLabel = Object.fromEntries(raised.cells.map((c) => [c.label, c]));
  assert.equal(byLabel["meeting target"].suppressed, true, "a custodian may raise the threshold");
});

test("the route releases through the trail, with the recipient on the record", async () => {
  const engine = new Engine({ dbPath: ":memory:", tickMs: 25 });
  await engine.start();
  const t = engine.forTenant("default");
  const admin = t.keys.issue("ops", ["admin"]);
  const api = await startApi(engine, 0, "127.0.0.1", { auth: new AuthGate({ keys: engine.keys }) });
  const base = `http://127.0.0.1:${api.port}`;
  try {
    const res = await fetch(`${base}/api/clinical/release`, {
      method: "POST",
      headers: { authorization: `Bearer ${admin.key}`, "content-type": "application/json" },
      body: JSON.stringify({
        kind: "measure",
        cohort: { id: "dm", name: "Diabetes", conditionCodes: ["diabetes"] },
        measure: { id: "hba1c-8", name: "HbA1c under 8", withinDays: 365, target: { code: "4548-4", below: 8 } },
        recipient: "NWT quality improvement committee",
        purpose: "quarterly diabetes review",
      }),
    });
    assert.equal(res.status, 200);
    const released = (await res.json()) as MeasureRelease;
    assert.equal(released.containsPatientLevelData, false);

    const row = t.audit
      .list({ limit: 10 })
      .find((r) => /de-identified release to NWT quality improvement committee/.test(r.detail ?? ""));
    assert.ok(row, "the release is on the chained trail with its recipient");
    assert.match(row?.detail ?? "", /for quarterly diabetes review/);
    assert.match(row?.detail ?? "", /threshold 5/);

    const refused = await fetch(`${base}/api/clinical/release`, {
      method: "POST",
      headers: { authorization: `Bearer ${admin.key}`, "content-type": "application/json" },
      body: JSON.stringify({
        kind: "measure",
        cohort: { id: "dm", name: "Diabetes", conditionCodes: ["diabetes"] },
        measure: { id: "hba1c-8", name: "HbA1c", withinDays: 365 },
      }),
    });
    assert.equal(refused.status, 400, "no recipient, no release");
  } finally {
    await api.close();
    await engine.stop();
  }
});

test("releases are confined to their custodian", () => {
  const db = new Db(":memory:");
  try {
    db.createTenant("north", "Northern Health", "Northern Regional Custodian");
    // The release module is pure over registry outputs, and the registry is
    // tenant-scoped — this pins that the pure layer cannot reach across: a
    // release built from one tenant's measure contains only that measure's
    // numbers, and nothing in the document identifies rows to reach back to.
    const r = releaseMeasure(measure(10, 7), AS_OF, TO);
    assert.equal(JSON.stringify(r).includes("patientId"), false);
  } finally {
    db.close();
  }
});
