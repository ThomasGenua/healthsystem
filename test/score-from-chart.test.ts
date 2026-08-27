/**
 * Scores computed from the chart, and the second way they go wrong.
 *
 * `scores.ts` refuses a missing input. Feeding the same instruments from the
 * chart adds a failure the hand-supplied form cannot have: a value that is
 * present but old. A NEWS2 built from the 06:00 observations at 20:00 is a
 * complete set of real measurements, every field populated, rendering exactly
 * as confidently as one taken five minutes ago — and describing a patient from
 * fourteen hours ago.
 *
 * These tests pin that a stale value is not a value, and that nothing the
 * chart does not hold is quietly defaulted into place.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../src/db.ts";
import { ClinicalRecord } from "../src/clinical/record.ts";
import { Vitals, type VitalKind } from "../src/clinical/vitals.ts";
import { news2FromChart, curb65FromChart, FRESHNESS_HOURS } from "../src/clinical/score-from-chart.ts";

const P = "NT123456";
const NURSE = { authorId: "rn-tetso", authorKind: "practitioner" };
const NOW = "2026-08-27T20:00:00.000Z";

function ward() {
  const dir = mkdtempSync(join(tmpdir(), "northstar-score-"));
  const db = new Db(join(dir, "northstar.db"));
  const clinical = new ClinicalRecord(db);
  const vitals = new Vitals(clinical);
  clinical.record({
    entryType: "Patient",
    patientId: P,
    content: { resourceType: "Patient", id: P, birthDate: "1954-03-17", name: [{ family: "Beaulieu", given: ["Marie"] }] },
    authorId: "reg",
    authorKind: "system",
    source: "test",
  });
  return {
    db,
    clinical,
    vitals,
    deps: { vitals, clinical },
    /** Records a full set of observations at one moment. */
    observe: (takenAt: string, over: Partial<Record<VitalKind, number>> = {}, bp: [number, number] = [118, 76]) => {
      const set: Array<[VitalKind, number]> = [
        ["respiratory-rate", over["respiratory-rate"] ?? 16],
        ["heart-rate", over["heart-rate"] ?? 72],
        ["oxygen-saturation", over["oxygen-saturation"] ?? 98],
        ["temperature", over.temperature ?? 36.8],
      ];
      for (const [kind, value] of set) {
        vitals.record({ patientId: P, kind, takenAt, by: NURSE, value });
      }
      vitals.record({ patientId: P, kind: "blood-pressure", takenAt, by: NURSE, systolic: bp[0], diastolic: bp[1] });
    },
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("a fresh set of vitals scores, and shows every value it used", () => {
  const w = ward();
  try {
    w.observe("2026-08-27T19:30:00.000Z");
    const out = news2FromChart(w.deps, P, { onSupplementalOxygen: false, alert: true }, { asOf: NOW });
    assert.equal(out.result.complete, true);
    assert.equal(out.result.complete && out.result.score, 0);
    assert.equal(out.used.length, 5, "five chart values, each cited");
    assert.equal(out.unavailable.length, 0);
    for (const u of out.used) {
      assert.ok(u.recordId, `${u.input} names the record it came from`);
      assert.ok(u.ageHours >= 0 && u.ageHours < 1);
    }
    assert.ok(out.oldestAgeHours !== null && out.oldestAgeHours < 1);
  } finally {
    w.cleanup();
  }
});

test("a stale set of vitals refuses, rather than scoring a patient from this morning", () => {
  // The whole point. These are real, complete, plausible measurements — and
  // fourteen hours old. The score would render with the same confidence as a
  // fresh one and describe a patient who may since have deteriorated.
  const w = ward();
  try {
    w.observe("2026-08-27T06:00:00.000Z");
    const out = news2FromChart(w.deps, P, { onSupplementalOxygen: false, alert: true }, { asOf: NOW });
    assert.equal(out.result.complete, false, "no number comes out of a fourteen-hour-old observation set");
    assert.equal(out.used.length, 0);
    assert.equal(out.unavailable.length, 5);
    assert.match(out.unavailable[0].reason, /14\.0h ago/);
    assert.match(out.unavailable[0].reason, /as they were then, not now/);
  } finally {
    w.cleanup();
  }
});

test("the freshness window is the instrument's clinical question, not one number", () => {
  // NEWS2 asks how the patient is right now; CURB-65 is a disposition taken
  // over a presentation. The same observations answer one and not the other.
  const w = ward();
  try {
    w.observe("2026-08-27T12:00:00.000Z", { "respiratory-rate": 32 }, [88, 55]);
    const eightHours = { asOf: NOW };

    const acute = news2FromChart(w.deps, P, { onSupplementalOxygen: false, alert: true }, eightHours);
    assert.equal(acute.result.complete, false, "eight hours is too old for an early warning score");

    const disposition = curb65FromChart(w.deps, P, { confusion: true, ureaMmolL: 9 }, eightHours);
    assert.equal(disposition.result.complete, true, "and within CURB-65's window");
    assert.equal(disposition.result.complete && disposition.result.score, 5);
    assert.equal(FRESHNESS_HOURS.news2 < FRESHNESS_HOURS["curb-65"], true);
  } finally {
    w.cleanup();
  }
});

test("only the stale inputs fall out; fresh ones are still used", () => {
  const w = ward();
  try {
    w.observe("2026-08-27T06:00:00.000Z");
    // One vital re-taken just now; the rest still this morning's.
    w.vitals.record({ patientId: P, kind: "heart-rate", takenAt: "2026-08-27T19:45:00.000Z", by: NURSE, value: 104 });

    const out = news2FromChart(w.deps, P, { onSupplementalOxygen: false, alert: true }, { asOf: NOW });
    assert.equal(out.result.complete, false, "the score still refuses — one fresh vital is not a set");
    assert.deepEqual(out.used.map((u) => u.input), ["heartRate"], "but the fresh one is used and cited");
    assert.equal(out.unavailable.length, 4);
  } finally {
    w.cleanup();
  }
});

test("a vital nobody has ever recorded reads differently from one that is old", () => {
  // Two different conversations with a clinician, and collapsing them into one
  // absence loses the more actionable half.
  const w = ward();
  try {
    w.vitals.record({ patientId: P, kind: "heart-rate", takenAt: "2026-08-27T19:45:00.000Z", by: NURSE, value: 72 });
    const out = news2FromChart(w.deps, P, { onSupplementalOxygen: false, alert: true }, { asOf: NOW });
    const never = out.unavailable.find((u) => u.input === "respiratoryRate");
    assert.ok(never);
    assert.match(never!.reason, /has ever been recorded/);
    assert.ok(!/ago and this instrument accepts/.test(never!.reason));
  } finally {
    w.cleanup();
  }
});

test("supplemental oxygen is never assumed, because the assumption understates", () => {
  // A patient on oxygen scores two points lower if the chart assumes air, and
  // NEWS2 exists to escalate exactly that patient.
  const w = ward();
  try {
    w.observe("2026-08-27T19:30:00.000Z");
    const notAsked = news2FromChart(w.deps, P, { alert: true }, { asOf: NOW });
    assert.equal(notAsked.result.complete, false);
    const finding = notAsked.unavailable.find((u) => u.input === "onSupplementalOxygen");
    assert.ok(finding);
    assert.match(finding!.reason, /two points lower/);

    const onOxygen = news2FromChart(w.deps, P, { onSupplementalOxygen: true, alert: true }, { asOf: NOW });
    assert.equal(onOxygen.result.complete && onOxygen.result.score, 2, "supplied, it scores");
  } finally {
    w.cleanup();
  }
});

test("consciousness is never assumed either", () => {
  const w = ward();
  try {
    w.observe("2026-08-27T19:30:00.000Z");
    const notAsked = news2FromChart(w.deps, P, { onSupplementalOxygen: false }, { asOf: NOW });
    assert.equal(notAsked.result.complete, false);
    assert.match(
      notAsked.unavailable.find((u) => u.input === "alert")!.reason,
      /three points lower/
    );
  } finally {
    w.cleanup();
  }
});

test("age comes from the chart, floored, and its absence is reported", () => {
  const w = ward();
  try {
    w.observe("2026-08-27T19:30:00.000Z", { "respiratory-rate": 32 }, [88, 55]);
    const out = curb65FromChart(w.deps, P, { confusion: false, ureaMmolL: 9 }, { asOf: NOW });
    assert.equal(out.result.complete, true);
    // Born 1954-03-17, so 72 on 2026-08-27: confusion 0 + urea 1 + RR 1 + BP 1 + age 1.
    assert.equal(out.result.complete && out.result.score, 4);
    assert.equal(out.result.complete && out.result.components.age, 1);

    const unknown = curb65FromChart(w.deps, "NT-NOBODY", { confusion: false, ureaMmolL: 9 }, { asOf: NOW });
    assert.equal(unknown.result.complete, false);
    assert.ok(unknown.unavailable.some((u) => u.input === "ageYears" && /no patient record/.test(u.reason)));
  } finally {
    w.cleanup();
  }
});

test("urea is not guessed at from results", () => {
  // Which LOINC code and units a deployment receives is its own, and picking
  // the wrong analyte feeds a disposition decision with somebody else's number.
  const w = ward();
  try {
    w.observe("2026-08-27T19:30:00.000Z");
    const out = curb65FromChart(w.deps, P, { confusion: false }, { asOf: NOW });
    assert.equal(out.result.complete, false);
    const finding = out.unavailable.find((u) => u.input === "ureaMmolL");
    assert.ok(finding);
    assert.match(finding!.reason, /guessing which result is the urea/);
  } finally {
    w.cleanup();
  }
});

test("the score is only as current as its stalest input", () => {
  // The number to show beside a score. A set spanning three hours is a
  // three-hour-old score, whatever the newest reading says.
  const w = ward();
  try {
    w.observe("2026-08-27T17:00:00.000Z");
    w.vitals.record({ patientId: P, kind: "heart-rate", takenAt: "2026-08-27T19:55:00.000Z", by: NURSE, value: 72 });
    const out = news2FromChart(w.deps, P, { onSupplementalOxygen: false, alert: true }, { asOf: NOW });
    assert.equal(out.result.complete, true);
    assert.ok(out.oldestAgeHours !== null);
    assert.ok(Math.abs(out.oldestAgeHours! - 3) < 0.01, "three hours, not the five minutes of the newest reading");
  } finally {
    w.cleanup();
  }
});

test("the window can be widened deliberately, and says what it used", () => {
  // A deployment may have a reason — a stable ward, a rehabilitation setting.
  // It is a decision somebody makes, not a default that drifts.
  const w = ward();
  try {
    w.observe("2026-08-27T06:00:00.000Z");
    const wide = news2FromChart(
      w.deps,
      P,
      { onSupplementalOxygen: false, alert: true },
      { asOf: NOW, maxAgeHours: 24 }
    );
    assert.equal(wide.result.complete, true);
    assert.ok(wide.oldestAgeHours !== null && wide.oldestAgeHours > 13);
  } finally {
    w.cleanup();
  }
});
