/**
 * The immunization history is three-valued, like allergies.
 *
 * An empty list is not "none". A child whose measles status has never been
 * asked about is a different patient from one whose history was taken and
 * found to contain nothing — and a chart that cannot tell them apart is
 * how an outbreak review discovers the gap after the fact.
 *
 * A refusal without a reason is not a refusal. "Not given" with nothing
 * beside it is indistinguishable afterwards from a dose nobody recorded.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../src/db.ts";
import { ClinicalRecord } from "../src/clinical/record.ts";
import { Immunizations } from "../src/clinical/immunizations.ts";
import { Refusal } from "../src/core/refusal.ts";

function clinic() {
  const dir = mkdtempSync(join(tmpdir(), "portage-imm-"));
  const db = new Db(join(dir, "portage.db"));
  const record = new ClinicalRecord(db);
  return {
    db,
    record,
    imm: new Immunizations(record),
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const P = "NT123456";
const NURSE = { authorId: "rn-blondin", authorKind: "practitioner" };

test("a given dose needs a vaccine and a date", () => {
  const { imm, cleanup } = clinic();
  try {
    assert.throws(() => imm.record({ patientId: P, vaccine: "  ", occurrenceAt: "2020-01-01T00:00:00Z", by: NURSE }), Refusal);
    assert.throws(() => imm.record({ patientId: P, vaccine: "MMR", occurrenceAt: "", by: NURSE }), Refusal);
    const row = imm.record({
      patientId: P,
      vaccine: "MMR",
      occurrenceAt: "2010-06-01T10:00:00Z",
      lot: "LOT-1",
      doseNumber: 1,
      by: NURSE,
    });
    assert.equal(row.vaccine, "MMR");
    assert.equal(row.status, "given");
    assert.equal(row.lot, "LOT-1");
    assert.equal(imm.historyStatus(P), "documented");
  } finally {
    cleanup();
  }
});

test("a refused or not-done immunization needs a reason", () => {
  const { imm, cleanup } = clinic();
  try {
    assert.throws(
      () => imm.record({ patientId: P, vaccine: "MMR", occurrenceAt: "2020-01-01T00:00:00Z", status: "refused", by: NURSE }),
      (err: unknown) => err instanceof Refusal && /reason/.test((err as Error).message)
    );
    const row = imm.record({
      patientId: P,
      vaccine: "MMR",
      occurrenceAt: "2020-01-01T00:00:00Z",
      status: "refused",
      reason: "parent declined after discussion",
      by: NURSE,
    });
    assert.equal(row.status, "refused");
    assert.match(row.reason ?? "", /declined/);
  } finally {
    cleanup();
  }
});

test("nobody asked and a documented history are different answers", () => {
  const { imm, cleanup } = clinic();
  try {
    assert.equal(imm.historyStatus(P), "never-asked");
    assert.deepEqual(imm.forPatient(P), []);
    imm.record({ patientId: P, vaccine: "Influenza", occurrenceAt: "2025-10-01T00:00:00Z", by: NURSE });
    assert.equal(imm.historyStatus(P), "documented");
  } finally {
    cleanup();
  }
});

test("a retraction leaves the original on the chart chain", () => {
  const { imm, record, cleanup } = clinic();
  try {
    const row = imm.record({ patientId: P, vaccine: "MMR", occurrenceAt: "2010-06-01T00:00:00Z", by: NURSE });
    imm.retract(row.recordId, { ...NURSE, reason: "recorded against the wrong patient" });
    assert.equal(imm.forPatient(P).length, 0, "the working chart no longer shows it");
    assert.equal(record.chart(P, { entryType: "Immunization", includeRetracted: true }).length, 1);
    assert.equal(imm.historyStatus(P), "never-asked", "a retracted-only history is not a documented one");
  } finally {
    cleanup();
  }
});

test("one custodian's immunizations are not another's", () => {
  const dir = mkdtempSync(join(tmpdir(), "portage-imm-iso-"));
  const root = new Db(join(dir, "portage.db"));
  try {
    root.createTenant("north", "Northern Health");
    root.createTenant("south", "Southern Health");
    const north = new Immunizations(new ClinicalRecord(root.forTenant("north")));
    const south = new Immunizations(new ClinicalRecord(root.forTenant("south")));
    north.record({ patientId: P, vaccine: "MMR", occurrenceAt: "2010-06-01T00:00:00Z", by: NURSE });
    assert.equal(north.historyStatus(P), "documented");
    assert.equal(south.historyStatus(P), "never-asked");
  } finally {
    root.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
