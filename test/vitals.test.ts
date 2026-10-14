/**
 * Vital signs belong at the time they were taken, and blood pressure is two
 * numbers.
 *
 * Filing a systolic without a diastolic teaches the chart to display half a
 * fact. A lab Observation without a vital-signs category is a result, not a
 * vital, and mixing them would make a potassium trend look like a pulse.
 *
 * "Never measured" is a chart gap. "No vitals on this visit" is ordinary.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../src/db.ts";
import { ClinicalRecord } from "../src/clinical/record.ts";
import { Encounters } from "../src/clinical/encounters.ts";
import { Vitals } from "../src/clinical/vitals.ts";
import { Refusal } from "../src/core/refusal.ts";

function clinic() {
  const dir = mkdtempSync(join(tmpdir(), "northstar-vitals-"));
  const db = new Db(join(dir, "northstar.db"));
  const record = new ClinicalRecord(db);
  return {
    db,
    record,
    vitals: new Vitals(record),
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}

const P = "NT123456";
const NURSE = { authorId: "rn-blondin", authorKind: "practitioner" };

test("blood pressure needs both systolic and diastolic", () => {
  const { vitals, cleanup } = clinic();
  try {
    assert.throws(
      () =>
        vitals.record({
          patientId: P,
          kind: "blood-pressure",
          takenAt: "2026-08-24T10:00:00Z",
          systolic: 142,
          by: NURSE,
        }),
      (err: unknown) => err instanceof Refusal && /diastolic/.test((err as Error).message)
    );
    const row = vitals.record({
      patientId: P,
      kind: "blood-pressure",
      takenAt: "2026-08-24T10:00:00Z",
      systolic: 142,
      diastolic: 88,
      by: NURSE,
    });
    assert.equal(row.systolic, 142);
    assert.equal(row.diastolic, 88);
    assert.equal(row.value, null);
  } finally {
    cleanup();
  }
});

test("a vital other than blood pressure needs a value, including zero", () => {
  const { vitals, cleanup } = clinic();
  try {
    assert.throws(
      () => vitals.record({ patientId: P, kind: "pain-score", takenAt: "2026-08-24T10:00:00Z", by: NURSE }),
      Refusal
    );
    const row = vitals.record({
      patientId: P,
      kind: "pain-score",
      value: 0,
      unit: "score",
      takenAt: "2026-08-24T10:00:00Z",
      by: NURSE,
    });
    assert.equal(row.value, 0);
  } finally {
    cleanup();
  }
});

test("a laboratory observation is not a vital sign", () => {
  const { record, vitals, cleanup } = clinic();
  try {
    record.record({
      entryType: "Observation",
      patientId: P,
      content: {
        resourceType: "Observation",
        status: "final",
        category: [{ coding: [{ code: "laboratory" }], text: "laboratory" }],
        code: { text: "heart-rate" },
        valueQuantity: { value: 999, unit: "/min" },
      },
      authorId: "analyser",
      authorKind: "device",
    });
    assert.equal(vitals.forPatient(P).length, 0);
    assert.equal(vitals.historyStatus(P), "never-measured");
    vitals.record({ patientId: P, kind: "heart-rate", value: 72, unit: "/min", takenAt: "2026-08-24T10:00:00Z", by: NURSE });
    assert.equal(vitals.forPatient(P).length, 1);
    assert.equal(vitals.latest(P)["heart-rate"]?.value, 72);
  } finally {
    cleanup();
  }
});

test("visit-scoped vitals do not pull the rest of the chart", () => {
  const { db, vitals, cleanup } = clinic();
  try {
    const visit = new Encounters(db).open({
      patientId: P,
      class: "in-person",
      reason: "Fever",
      by: { actorId: "rn-blondin", actorKind: "practitioner" },
      arrived: true,
    });
    vitals.record({
      patientId: P,
      kind: "temperature",
      value: 37.1,
      unit: "Cel",
      takenAt: "2026-08-23T10:00:00Z",
      by: NURSE,
    });
    vitals.record({
      patientId: P,
      kind: "temperature",
      value: 38.4,
      unit: "Cel",
      takenAt: "2026-08-24T10:00:00Z",
      encounterId: visit.id,
      by: NURSE,
    });
    assert.equal(vitals.forPatient(P).length, 2);
    assert.equal(vitals.forPatient(P, { encounterId: visit.id }).length, 1);
    assert.equal(vitals.forPatient(P, { encounterId: visit.id })[0].value, 38.4);
  } finally {
    cleanup();
  }
});

test("one custodian's vitals are not another's", () => {
  const dir = mkdtempSync(join(tmpdir(), "northstar-vitals-iso-"));
  const root = new Db(join(dir, "northstar.db"));
  try {
    root.createTenant("north", "Northern Health");
    root.createTenant("south", "Southern Health");
    const north = new Vitals(new ClinicalRecord(root.forTenant("north")));
    const south = new Vitals(new ClinicalRecord(root.forTenant("south")));
    north.record({ patientId: P, kind: "heart-rate", value: 72, takenAt: "2026-08-24T10:00:00Z", by: NURSE });
    assert.equal(north.historyStatus(P), "documented");
    assert.equal(south.historyStatus(P), "never-measured");
  } finally {
    root.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
