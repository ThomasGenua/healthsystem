/**
 * Procedures on the chart are three-valued, like allergies.
 *
 * An empty list is not "none". A patient whose procedures have never been
 * recorded is a different patient from one whose history was taken and
 * found to contain nothing — and a chart that cannot tell them apart is
 * how a review discovers the gap after the fact.
 *
 * A completed procedure without a date is not a completed procedure. A
 * not-done procedure without a reason is indistinguishable afterwards from
 * one nobody recorded.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../src/db.ts";
import { ClinicalRecord } from "../src/clinical/record.ts";
import { Encounters } from "../src/clinical/encounters.ts";
import { Procedures } from "../src/clinical/procedures.ts";
import { VisitView } from "../src/workspace/visit.ts";
import { Refusal } from "../src/core/refusal.ts";

function clinic() {
  const dir = mkdtempSync(join(tmpdir(), "northstar-proc-"));
  const db = new Db(join(dir, "northstar.db"));
  const record = new ClinicalRecord(db);
  return {
    db,
    record,
    procedures: new Procedures(record),
    encounters: new Encounters(db),
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}

const P = "NT123456";
const NURSE = { authorId: "rn-blondin", authorKind: "practitioner" };

test("a completed procedure needs a date it was performed", () => {
  const { procedures, cleanup } = clinic();
  try {
    assert.throws(
      () => procedures.record({ patientId: P, procedure: "  ", performedAt: "2026-08-20T10:00:00Z", by: NURSE }),
      Refusal
    );
    assert.throws(
      () => procedures.record({ patientId: P, procedure: "Knee injection", by: NURSE }),
      (err: unknown) => err instanceof Refusal && /date it was performed/.test((err as Error).message)
    );
    const row = procedures.record({
      patientId: P,
      procedure: "Knee injection",
      performedAt: "2026-08-20T10:00:00Z",
      procedureCode: "20610",
      by: NURSE,
    });
    assert.equal(row.display, "Knee injection");
    assert.equal(row.status, "completed");
    assert.equal(row.performedAt, "2026-08-20T10:00:00Z");
    assert.equal(procedures.historyStatus(P), "documented");
  } finally {
    cleanup();
  }
});

test("a procedure that was not done needs a written reason", () => {
  const { procedures, cleanup } = clinic();
  try {
    assert.throws(
      () =>
        procedures.record({
          patientId: P,
          procedure: "Colonoscopy",
          status: "not-done",
          by: NURSE,
        }),
      (err: unknown) => err instanceof Refusal && /reason/.test((err as Error).message)
    );
    assert.throws(
      () =>
        procedures.record({
          patientId: P,
          procedure: "Colonoscopy",
          status: "not-done",
          reason: "declined",
          by: NURSE,
        }),
      (err: unknown) => err instanceof Refusal && /12/.test((err as Error).message)
    );
    const row = procedures.record({
      patientId: P,
      procedure: "Colonoscopy",
      status: "not-done",
      reason: "patient declined after the bowel-prep discussion",
      by: NURSE,
    });
    assert.equal(row.status, "not-done");
    assert.match(row.reason ?? "", /declined/);
    assert.equal(row.performedAt, null);
  } finally {
    cleanup();
  }
});

test("an empty procedure panel is never-recorded, not none", () => {
  const { procedures, cleanup } = clinic();
  try {
    assert.equal(procedures.historyStatus(P), "never-recorded");
    assert.deepEqual(procedures.forPatient(P), []);
    procedures.record({
      patientId: P,
      procedure: "IUD insertion",
      performedAt: "2025-03-01T12:00:00Z",
      by: NURSE,
    });
    assert.equal(procedures.historyStatus(P), "documented");
  } finally {
    cleanup();
  }
});

test("a retraction leaves the original on the chart chain", () => {
  const { procedures, record, cleanup } = clinic();
  try {
    const row = procedures.record({
      patientId: P,
      procedure: "Knee injection",
      performedAt: "2026-08-20T10:00:00Z",
      by: NURSE,
    });
    procedures.retract(row.recordId, { ...NURSE, reason: "recorded against the wrong patient" });
    assert.equal(procedures.forPatient(P).length, 0, "the working chart no longer shows it");
    assert.equal(record.chart(P, { entryType: "Procedure", includeRetracted: true }).length, 1);
    assert.equal(procedures.historyStatus(P), "never-recorded", "a retracted-only history is not a documented one");
  } finally {
    cleanup();
  }
});

test("one custodian cannot read another's procedures", () => {
  const dir = mkdtempSync(join(tmpdir(), "northstar-proc-iso-"));
  const root = new Db(join(dir, "northstar.db"));
  try {
    root.createTenant("north", "Northern Health");
    root.createTenant("south", "Southern Health");
    const north = new Procedures(new ClinicalRecord(root.forTenant("north")));
    const south = new Procedures(new ClinicalRecord(root.forTenant("south")));
    north.record({
      patientId: P,
      procedure: "Knee injection",
      performedAt: "2026-08-20T10:00:00Z",
      by: NURSE,
    });
    assert.equal(north.historyStatus(P), "documented");
    assert.equal(south.historyStatus(P), "never-recorded");
  } finally {
    root.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("procedures at a visit are a visit section, not findings", () => {
  const { procedures, encounters, record, cleanup } = clinic();
  try {
    const visit = encounters.open({
      patientId: P,
      class: "in-person",
      reason: "Knee review",
      by: { actorId: "dr-tetso", actorKind: "practitioner" },
      arrived: true,
    });
    record.record({
      entryType: "Condition",
      patientId: P,
      encounterId: visit.id,
      content: { resourceType: "Condition", code: { text: "Osteoarthritis of knee" } },
      ...NURSE,
    });
    procedures.record({
      patientId: P,
      procedure: "Knee injection",
      performedAt: "2026-08-20T10:00:00Z",
      encounterId: visit.id,
      by: NURSE,
    });
    const summary = new VisitView({ encounters, record }).summarise(visit.id);
    assert.equal(summary.procedures.items.length, 1);
    assert.equal(summary.procedures.items[0].display, "Knee injection");
    assert.equal(
      summary.findings.items.filter((e) => e.entry_type === "Procedure").length,
      0,
      "a procedure is not counted twice as a finding"
    );
    assert.equal(summary.findings.items.length, 1);
  } finally {
    cleanup();
  }
});
