/**
 * What retention does not delete.
 *
 * Retention exists to age out the message log: raw HL7 kept forever is a disk
 * problem and a privacy liability, and data minimisation is not optional for a
 * custodian. The clinical stores are the opposite case. They hold the record
 * rather than a log of traffic, and a patient's allergy to penicillin recorded
 * four years ago is not stale data.
 *
 * The dangerous reading is available and would be a catastrophe: "retention is
 * configured" heard as "patient data ages out everywhere". A sweep that
 * deleted a chart because a number in a config file said 1095 would be
 * destroying the record while reporting success — and it would report success,
 * because deleting rows is exactly what it was asked to do.
 *
 * So the boundary is a test rather than a comment. Moving it in either
 * direction means changing this file, which is a deliberate act.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { Db } from "../src/db.ts";
import { RetentionRunner } from "../src/core/retention.ts";
import { AuditStore } from "../src/audit/store.ts";
import { ClinicalRecord } from "../src/clinical/record.ts";
import { MedicationStore } from "../src/meds/store.ts";
import { OrderStore } from "../src/orders/store.ts";
import { ReferralStore } from "../src/work/referrals.ts";
import { TaskStore } from "../src/work/tasks.ts";

const P = "NT123456";
const GP = { actorId: "dr-tetso", actorKind: "practitioner" };

/** Tables that hold the record, and must survive any retention sweep. */
const RECORD_TABLES = [
  "clinical_entries",
  "medication_statements",
  "allergies",
  "med_reconciliations",
  "order_results",
  "orders",
  "referrals",
  "tasks",
  "patient_index",
];

test("a retention sweep ages out the message log and leaves the record alone", () => {
  const dir = mkdtempSync(join(tmpdir(), "portage-retb-"));
  const db = new Db(join(dir, "portage.db"));
  try {
    // A message log old enough to be well past any cutoff.
    db.upsertChannel("adt", "adt", true, "{}");
    const m = db.insertMessage("adt", "test", "text/plain", "MSH|^~\\&|LAB|...|PID|||NT123456");
    db.sql.prepare("UPDATE messages SET received_at = '2000-01-01T00:00:00Z' WHERE id = ?").run(m.id);

    // And a chart of the same vintage.
    const rec = new ClinicalRecord(db);
    const meds = new MedicationStore(db);
    const orders = new OrderStore(db);
    const referrals = new ReferralStore(db);
    const tasks = new TaskStore(db);

    rec.record({
      entryType: "Patient",
      patientId: P,
      content: { resourceType: "Patient", identifier: [{ system: "urn:jhn", value: P }], name: [{ family: "Beaulieu" }] },
      authorId: "adt-feed",
      authorKind: "device",
    });
    meds.recordAllergy({
      patientId: P,
      display: "Penicillin",
      ingredient: "penicillin",
      criticality: "high",
      reaction: "anaphylaxis",
      by: GP,
    });
    meds.record({
      patientId: P,
      code: "860975",
      display: "Metformin 500mg",
      ingredient: "metformin",
      source: "prescribed",
      adherence: "taking",
      by: GP,
    });
    meds.startReconciliation({ patientId: P, transition: "admission", by: GP });
    const o = orders.create({
      patientId: P,
      category: "lab",
      code: "2823-3",
      display: "Potassium",
      indication: "Electrolyte check",
      by: GP,
    });
    orders.place(o.id, { ...GP, responsibleId: "dr-tetso" });
    orders.report({ patientId: P, orderId: o.id, code: "2823-3", display: "Potassium", value: "7.1", reportedBy: "lab" });
    referrals.create({
      patientId: P,
      fromService: "Primary Care",
      toService: "Nephrology",
      indication: "Rising potassium",
      by: GP,
    });
    tasks.create({ kind: "result-review", title: "Review potassium", by: GP, patientId: P });

    const before = Object.fromEntries(
      RECORD_TABLES.map((t) => [t, (db.sql.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n])
    );
    for (const [t, n] of Object.entries(before)) assert.ok(n > 0, `${t} must have a row for this test to mean anything`);

    // The most aggressive policy anyone would write: purge everything past a day.
    const runner = new RetentionRunner(db, { redactAfterDays: 1, purgeAfterDays: 1 }, new AuditStore(db));
    const result = runner.run();

    assert.equal(result.purgedMessages, 1, "the traffic log is what ages out");
    assert.equal(db.listMessages({ channelId: "adt" }).length, 0);

    const after = Object.fromEntries(
      RECORD_TABLES.map((t) => [t, (db.sql.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n])
    );
    assert.deepEqual(after, before, "and the record is not a log; nothing here ages out on a timer");

    // Specifically the one that would kill somebody.
    assert.equal(meds.allergyStatus(P), "documented");
    assert.equal(meds.allergies(P)[0].ingredient, "penicillin");
    assert.equal(orders.unacknowledged().length, 1, "and an unread critical result is still owed a reader");
    assert.equal(rec.verifyChart(P).ok, true, "and the chart chain still verifies");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no clinical table is named in the purge path", () => {
  // The behavioural test above proves the sweep leaves the record alone today.
  // This one is about tomorrow: a table added to the purge list is a change
  // somebody has to make here as well, rather than something that happens
  // because a new table looked like it belonged.
  const src =
    readSource("../src/core/retention.ts") + readSource("../src/db.ts").slice(indexOfPurge()) + "";
  for (const table of RECORD_TABLES) {
    assert.ok(
      !new RegExp(`DELETE\\s+FROM\\s+${table}\\b`).test(src),
      `${table} is deleted from in the retention path — if that is intended, this test is where to say so`
    );
  }
});

function readSource(rel: string): string {
  return readFileSync(new URL(rel, import.meta.url), "utf8");
}

/** The purge helper in db.ts, and everything after it. */
function indexOfPurge(): number {
  const src = readSource("../src/db.ts");
  const i = src.indexOf("purgeBefore");
  assert.ok(i > 0, "purgeBefore should exist in db.ts");
  return i;
}
