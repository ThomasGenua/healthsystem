/**
 * A migration that reports success and dropped 4% of the allergies.
 *
 * That is the failure this module exists for, and the reason it is dangerous is
 * that nothing errors. The extract ran, the loader ran, the counts look
 * plausible, the clinicians start work, and the records that never arrived are
 * invisible until somebody prescribes into a gap.
 *
 * So the load-bearing tests here are the ones about *counting*: a run cannot
 * call itself complete because nothing threw, a gap between what the source
 * said it had and what arrived is named, and a run with no declared source
 * count says it cannot verify completeness rather than implying it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../src/db.ts";
import { ClinicalRecord } from "../src/clinical/record.ts";
import { MedicationStore } from "../src/meds/store.ts";
import { Migration, type SourceRecord } from "../src/migrate/run.ts";
import { Refusal } from "../src/core/refusal.ts";

const OPS = { actorId: "migration-operator" };
const P = "OLD-1001";

function site() {
  const dir = mkdtempSync(join(tmpdir(), "portage-mig-"));
  const db = new Db(join(dir, "portage.db"));
  const clinical = new ClinicalRecord(db);
  const meds = new MedicationStore(db, { check: () => [] });
  return {
    db,
    clinical,
    meds,
    mig: new Migration(db, { clinical, meds }),
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const patientRecord = (sourceId = P): SourceRecord => ({
  sourceId,
  recordType: "patient",
  content: {
    id: sourceId,
    identifier: [{ system: "urn:jhn", value: sourceId }],
    name: [{ family: "Beaulieu", given: ["Marie"], use: "official" }],
    birthDate: "1984-03-17",
  },
  sourceCodes: { legacyChartNumber: `CH-${sourceId}` },
});

const allergyRecord = (sourceId: string, display = "Penicillin"): SourceRecord => ({
  sourceId,
  recordType: "allergy",
  sourcePatientId: P,
  content: { display, ingredient: display.toLowerCase(), criticality: "high", reaction: "anaphylaxis" },
  sourceCodes: { legacyAllergyCode: "PEN" },
});

test("a run cannot call itself complete because nothing threw", () => {
  // The whole point. The source system says four allergies; three arrive; no
  // error anywhere. A report that said "complete" here is the catastrophe.
  const w = site();
  try {
    const run = w.mig.begin({ sourceSystem: "legacy-emr", mode: "trial", by: OPS });
    w.mig.declare(run.id, "patient", 1, OPS);
    w.mig.declare(run.id, "allergy", 4, OPS);

    w.mig.load(run.id, patientRecord(), OPS);
    for (const [i, drug] of ["Penicillin", "Sulfa", "Latex"].entries()) {
      w.mig.load(run.id, allergyRecord(`AL-${i}`, drug), OPS);
    }

    const report = w.mig.report(run.id);
    assert.equal(report.complete, false, "three of four is not complete");
    const allergies = report.perType.find((t) => t.recordType === "allergy")!;
    assert.equal(allergies.declared, 4);
    assert.equal(allergies.loaded, 3);
    assert.equal(allergies.unaccounted, 1);
    assert.equal(allergies.complete, false);
    assert.ok(
      report.caveats.some((c) => /allergy: 1 record\(s\).*neither loaded nor failed/.test(c)),
      `the gap has to be named, got ${JSON.stringify(report.caveats)}`
    );

    // And the run refuses to close over it without somebody saying so.
    assert.throws(
      () => w.mig.complete(run.id, OPS),
      (err: unknown) => err instanceof Refusal && /not reconciled/.test((err as Error).message)
    );
    assert.equal(w.mig.run(run.id)!.status, "open");
  } finally {
    w.cleanup();
  }
});

test("a run with nothing declared says it cannot verify completeness", () => {
  // A different and equally honest answer from "complete". "We loaded 1,153
  // allergies" is a reassuring sentence about an unknown denominator.
  const w = site();
  try {
    const run = w.mig.begin({ sourceSystem: "legacy-emr", mode: "trial", by: OPS });
    w.mig.load(run.id, patientRecord(), OPS);
    w.mig.load(run.id, allergyRecord("AL-1"), OPS);

    const report = w.mig.report(run.id);
    assert.equal(report.complete, false);
    assert.equal(report.perType.find((t) => t.recordType === "allergy")!.declared, null);
    assert.equal(report.perType.find((t) => t.recordType === "allergy")!.unaccounted, null);
    assert.ok(report.caveats.every((c) => !/neither loaded nor failed/.test(c)), "no false gap claim either");
    assert.ok(report.caveats.some((c) => /never declared, so completeness cannot be verified/.test(c)));
  } finally {
    w.cleanup();
  }
});

test("a fully declared and fully loaded run reconciles, and can be closed", () => {
  const w = site();
  try {
    const run = w.mig.begin({ sourceSystem: "legacy-emr", mode: "trial", by: OPS });
    w.mig.declare(run.id, "patient", 1, OPS);
    w.mig.declare(run.id, "allergy", 2, OPS);
    w.mig.load(run.id, patientRecord(), OPS);
    w.mig.load(run.id, allergyRecord("AL-1", "Penicillin"), OPS);
    w.mig.load(run.id, allergyRecord("AL-2", "Sulfa"), OPS);

    const report = w.mig.report(run.id);
    assert.equal(report.complete, true);
    assert.deepEqual(report.totals, { loaded: 3, unchanged: 0, rejected: 0 });
    assert.equal(w.mig.complete(run.id, OPS).status, "completed");

    // And nothing more can be loaded into a closed run.
    assert.throws(() => w.mig.load(run.id, allergyRecord("AL-3"), OPS), Refusal);
  } finally {
    w.cleanup();
  }
});

test("a gap can be accepted, but only in writing and on the record", () => {
  const w = site();
  try {
    const run = w.mig.begin({ sourceSystem: "legacy-emr", mode: "cutover", by: OPS });
    w.mig.declare(run.id, "patient", 1, OPS);
    w.mig.declare(run.id, "allergy", 2, OPS);
    w.mig.load(run.id, patientRecord(), OPS);
    w.mig.load(run.id, allergyRecord("AL-1"), OPS);

    const closed = w.mig.complete(run.id, {
      ...OPS,
      acceptGapsBecause: "the missing allergy was a duplicate confirmed by the source vendor",
    });
    assert.equal(closed.status, "completed");
    assert.match(closed.notes ?? "", /closed over gaps: the missing allergy was a duplicate/);
  } finally {
    w.cleanup();
  }
});

test("a record that cannot be loaded is rejected with its payload, not thrown away", () => {
  // One bad row must not stop a caseload, and must not vanish either.
  // "37 allergies failed validation" is not something anybody can sign.
  const w = site();
  try {
    const run = w.mig.begin({ sourceSystem: "legacy-emr", mode: "trial", by: OPS });
    w.mig.load(run.id, patientRecord(), OPS);

    const outcomes = w.mig.loadAll(
      run.id,
      [
        allergyRecord("AL-1", "Penicillin"),
        // No substance: an allergy nobody can check a prescription against.
        { sourceId: "AL-BAD", recordType: "allergy", sourcePatientId: P, content: { display: "  " } },
        allergyRecord("AL-2", "Sulfa"),
      ],
      OPS
    );
    assert.deepEqual(outcomes.map((o) => o.outcome), ["loaded", "rejected", "loaded"]);

    const rejects = w.mig.rejects(run.id);
    assert.equal(rejects.length, 1);
    assert.equal(rejects[0].source_id, "AL-BAD");
    assert.match(rejects[0].reason ?? "", /needs a substance/);
    // The payload is there, so the rejection is something to open.
    assert.match(rejects[0].payload, /AL-BAD/);
    assert.ok(w.mig.report(run.id).caveats.some((c) => /1 record\(s\) were rejected/.test(c)));
  } finally {
    w.cleanup();
  }
});

test("loading is idempotent, so a resumed run does not double what it already did", () => {
  const w = site();
  try {
    const run = w.mig.begin({ sourceSystem: "legacy-emr", mode: "trial", by: OPS });
    w.mig.load(run.id, patientRecord(), OPS);
    const first = w.mig.load(run.id, allergyRecord("AL-1"), OPS);
    assert.equal(first.outcome, "loaded");

    const again = w.mig.load(run.id, allergyRecord("AL-1"), OPS);
    assert.equal(again.outcome, "unchanged");
    assert.equal(again.target_id, first.target_id);
    assert.equal(w.meds.allergies(P).length, 1, "one allergy, not two");

    // The report counts it once and does not read as a gap.
    w.mig.declare(run.id, "patient", 1, OPS);
    w.mig.declare(run.id, "allergy", 1, OPS);
    const allergy = w.mig.report(run.id).perType.find((t) => t.recordType === "allergy")!;
    assert.equal(allergy.loaded, 1);
    assert.equal(allergy.unchanged, 1);
    assert.equal(allergy.unaccounted, -1, "counted twice against a declared one, which the report shows rather than hides");
  } finally {
    w.cleanup();
  }
});

test("a delta run only loads what changed, and cannot sit on a rolled-back run", () => {
  const w = site();
  try {
    const first = w.mig.begin({ sourceSystem: "legacy-emr", mode: "trial", by: OPS });
    w.mig.load(first.id, patientRecord(), OPS);
    w.mig.load(first.id, allergyRecord("AL-1"), OPS);
    w.mig.complete(first.id, { ...OPS, acceptGapsBecause: "trial, counts not declared" });

    assert.throws(
      () => w.mig.begin({ sourceSystem: "legacy-emr", mode: "delta", by: OPS }),
      (err: unknown) => err instanceof Refusal && /which run it follows/.test((err as Error).message)
    );

    const delta = w.mig.begin({ sourceSystem: "legacy-emr", mode: "delta", by: OPS, follows: first.id });
    // The unchanged row is recognised across runs, because identity is the
    // source's, not the run's.
    assert.equal(w.mig.load(delta.id, allergyRecord("AL-1"), OPS).outcome, "unchanged");
    assert.equal(w.mig.load(delta.id, allergyRecord("AL-2", "Sulfa"), OPS).outcome, "loaded");
    assert.equal(w.meds.allergies(P).length, 2);

    w.mig.rollback(delta.id, { ...OPS, reason: "delta mapping was wrong" });
    w.mig.rollback(first.id, { ...OPS, reason: "starting again" });
    assert.throws(
      () => w.mig.begin({ sourceSystem: "legacy-emr", mode: "delta", by: OPS, follows: first.id }),
      (err: unknown) => err instanceof Refusal && /rolled back/.test((err as Error).message)
    );
  } finally {
    w.cleanup();
  }
});

test("a trial is rolled back by retraction, so the rollback is itself on the record", () => {
  // Retraction rather than deletion: a migration that deleted its own rows
  // would leave no evidence it had ever run, which is the opposite of what a
  // trial is for.
  const w = site();
  try {
    const run = w.mig.begin({ sourceSystem: "legacy-emr", mode: "trial", by: OPS });
    w.mig.load(run.id, patientRecord(), OPS);
    w.mig.loadAll(
      run.id,
      [
        { sourceId: "CO-1", recordType: "condition", sourcePatientId: P, content: { code: { text: "Type 2 diabetes" } } },
        { sourceId: "CO-2", recordType: "condition", sourcePatientId: P, content: { code: { text: "Hypertension" } } },
      ],
      OPS
    );
    assert.equal(w.clinical.chart(P, { entryType: "Condition" }).length, 2);

    assert.throws(() => w.mig.rollback(run.id, { ...OPS, reason: "" }), /needs a reason/);
    const { retracted, run: after } = w.mig.rollback(run.id, { ...OPS, reason: "problem codes mapped wrong" });
    assert.equal(after.status, "rolled-back");
    assert.ok(retracted >= 2);
    assert.equal(w.clinical.chart(P, { entryType: "Condition" }).length, 0, "off the working chart");
    assert.ok(
      w.clinical.chart(P, { entryType: "Condition", includeRetracted: true }).length >= 2,
      "and still there, because a retraction is not a deletion"
    );
    assert.throws(() => w.mig.rollback(run.id, { ...OPS, reason: "again" }), Refusal);
  } finally {
    w.cleanup();
  }
});

test("a cutover cannot be rolled back once a clinician has written into a chart", () => {
  // Rolling it back would remove the records their note refers to.
  const w = site();
  try {
    const run = w.mig.begin({ sourceSystem: "legacy-emr", mode: "cutover", by: OPS });
    w.mig.load(run.id, patientRecord(), OPS);
    w.mig.load(run.id, {
      sourceId: "CO-1",
      recordType: "condition",
      sourcePatientId: P,
      content: { code: { text: "Type 2 diabetes" } },
    }, OPS);

    w.clinical.record({
      entryType: "DocumentReference",
      patientId: P,
      content: { resourceType: "DocumentReference", description: "Reviewed the migrated problem list" },
      authorId: "dr-tetso",
      authorKind: "practitioner",
    });

    assert.throws(
      () => w.mig.rollback(run.id, { ...OPS, reason: "mapping was wrong" }),
      (err: unknown) =>
        err instanceof Refusal &&
        /cannot be rolled back/.test((err as Error).message) &&
        /dr-tetso/.test((err as Error).message)
    );
    assert.equal(w.clinical.chart(P, { entryType: "Condition" }).length, 1, "and nothing was removed");
  } finally {
    w.cleanup();
  }
});

test("a cutover with no clinical activity since can still be rolled back", () => {
  const w = site();
  try {
    const run = w.mig.begin({ sourceSystem: "legacy-emr", mode: "cutover", by: OPS });
    w.mig.load(run.id, patientRecord(), OPS);
    w.mig.load(run.id, {
      sourceId: "CO-1",
      recordType: "condition",
      sourcePatientId: P,
      content: { code: { text: "Type 2 diabetes" } },
    }, OPS);
    assert.equal(w.mig.rollback(run.id, { ...OPS, reason: "found the mapping error before go-live" }).run.status, "rolled-back");
  } finally {
    w.cleanup();
  }
});

test("source codes and the run that loaded a record are preserved on the chart", () => {
  // A migrated record that cannot be traced to the row it came from cannot be
  // checked against the source system, and checking against the source is the
  // only way a mapping error is ever found.
  const w = site();
  try {
    const run = w.mig.begin({ sourceSystem: "legacy-emr", mode: "trial", by: OPS });
    w.mig.load(run.id, patientRecord(), OPS);
    const loaded = w.mig.load(
      run.id,
      {
        sourceId: "CO-1",
        recordType: "condition",
        sourcePatientId: P,
        content: { code: { text: "Type 2 diabetes" } },
        sourceCodes: { icd9: "250.00" },
      },
      OPS
    );

    const entry = w.clinical.chart(P, { entryType: "Condition" })[0];
    const content = JSON.parse(entry.content) as { _source: { system: string; id: string; migrationRun: string; codes: Record<string, string> } };
    assert.equal(content._source.system, "legacy-emr");
    assert.equal(content._source.id, "CO-1");
    assert.equal(content._source.migrationRun, run.id);
    assert.equal(content._source.codes.icd9, "250.00", "the source's own code, not just the mapped one");
    assert.equal(entry.source, "legacy-emr");

    // And the same trail from the other direction.
    const provenance = w.mig.provenanceFor(P);
    assert.equal(provenance.length, 2);
    assert.ok(provenance.some((r) => r.target_id === loaded.target_id));
  } finally {
    w.cleanup();
  }
});

test("a migrated medication is external-record, never prescribed", () => {
  // A migration that marked everything `prescribed` would assert that this
  // clinic wrote prescriptions it never saw — and provenance is the one thing
  // the medication list exists to keep straight.
  const w = site();
  try {
    const run = w.mig.begin({ sourceSystem: "legacy-emr", mode: "trial", by: OPS });
    w.mig.load(run.id, patientRecord(), OPS);
    w.mig.load(
      run.id,
      {
        sourceId: "MED-1",
        recordType: "medication",
        sourcePatientId: P,
        content: { code: "860975", display: "Metformin 500mg", ingredient: "metformin", dose: "500 mg" },
      },
      OPS
    );

    const rows = w.meds.current(P, { asPrescribed: true });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source, "external-record");
    assert.equal(rows[0].adherence, "unknown", "nobody has asked the patient yet");

    // It is on the taking-list too, and that is deliberate: a migrated chart
    // that showed the patient on nothing until somebody re-confirmed every
    // drug would be far more dangerous than one showing them on a list marked
    // unconfirmed. `unknown` adherence is what carries the caveat, and
    // reconciliation after a transition of care is what resolves it.
    assert.equal(w.meds.current(P).length, 1);
    assert.equal(w.meds.current(P)[0].adherence, "unknown");
  } finally {
    w.cleanup();
  }
});

test("a clinical record with no chart to belong to is rejected, not filed against a guess", () => {
  const w = site();
  try {
    const run = w.mig.begin({ sourceSystem: "legacy-emr", mode: "trial", by: OPS });
    const orphan = w.mig.load(
      run.id,
      { sourceId: "CO-9", recordType: "condition", sourcePatientId: "NOBODY", content: { code: { text: "x" } } },
      OPS
    );
    assert.equal(orphan.outcome, "rejected");
    assert.match(orphan.reason ?? "", /no chart NOBODY/);

    const noPatient = w.mig.load(
      run.id,
      { sourceId: "CO-10", recordType: "condition", content: { code: { text: "x" } } },
      OPS
    );
    assert.equal(noPatient.outcome, "rejected");
    assert.match(noPatient.reason ?? "", /needs a sourcePatientId/);
  } finally {
    w.cleanup();
  }
});

test("the validation sample spreads across record types, because the first rows are the easy ones", () => {
  // Counts reconciling does not mean the content is right: a mapping that puts
  // the dose in the frequency field reconciles perfectly.
  const w = site();
  try {
    const run = w.mig.begin({ sourceSystem: "legacy-emr", mode: "trial", by: OPS });
    w.mig.load(run.id, patientRecord(), OPS);
    for (let i = 0; i < 8; i++) w.mig.load(run.id, allergyRecord(`AL-${i}`, `Drug ${i}`), OPS);
    for (let i = 0; i < 8; i++) {
      w.mig.load(
        run.id,
        { sourceId: `CO-${i}`, recordType: "condition", sourcePatientId: P, content: { code: { text: `Problem ${i}` } } },
        OPS
      );
    }

    const sample = w.mig.validationSample(run.id, 3);
    const types = new Set(sample.map((s) => s.record_type));
    assert.ok(types.has("allergy") && types.has("condition") && types.has("patient"));
    assert.equal(sample.filter((s) => s.record_type === "allergy").length, 3);
    assert.equal(sample.filter((s) => s.record_type === "condition").length, 3);
  } finally {
    w.cleanup();
  }
});

test("a run refuses a nonsense mode, type or declared count", () => {
  const w = site();
  try {
    assert.throws(() => w.mig.begin({ sourceSystem: "  ", mode: "trial", by: OPS }), Refusal);
    assert.throws(
      () => w.mig.begin({ sourceSystem: "x", mode: "wholesale" as never, by: OPS }),
      (err: unknown) => err instanceof Refusal && /unknown migration mode/.test((err as Error).message)
    );
    const run = w.mig.begin({ sourceSystem: "legacy-emr", mode: "trial", by: OPS });
    assert.throws(() => w.mig.declare(run.id, "diagnosis" as never, 1, OPS), Refusal);
    assert.throws(() => w.mig.declare(run.id, "allergy", -1, OPS), Refusal);
    assert.throws(() => w.mig.declare(run.id, "allergy", 1.5, OPS), Refusal);
    // Zero is a real answer: a source system with no allergies at all is a
    // fact, and declaring it is how the report can say so.
    assert.equal(w.mig.declare(run.id, "allergy", 0, OPS).source_count, 0);
  } finally {
    w.cleanup();
  }
});

test("a re-declared count replaces the earlier one rather than accumulating", () => {
  const w = site();
  try {
    const run = w.mig.begin({ sourceSystem: "legacy-emr", mode: "trial", by: OPS });
    w.mig.declare(run.id, "allergy", 5, OPS);
    w.mig.declare(run.id, "allergy", 4, { actorId: "vendor-corrected" });
    w.mig.load(run.id, patientRecord(), OPS);
    w.mig.declare(run.id, "patient", 1, OPS);
    for (let i = 0; i < 4; i++) w.mig.load(run.id, allergyRecord(`AL-${i}`, `Drug ${i}`), OPS);

    const report = w.mig.report(run.id);
    assert.equal(report.perType.find((t) => t.recordType === "allergy")!.declared, 4);
    assert.equal(report.complete, true);
  } finally {
    w.cleanup();
  }
});

test("migrations are confined to their tenant", () => {
  const dir = mkdtempSync(join(tmpdir(), "portage-mig-iso-"));
  const root = new Db(join(dir, "portage.db"));
  try {
    root.createTenant("north", "Northern Health");
    root.createTenant("south", "Southern Health");
    const build = (t: string) => {
      const db = root.forTenant(t);
      const clinical = new ClinicalRecord(db);
      const meds = new MedicationStore(db, { check: () => [] });
      return { clinical, meds, mig: new Migration(db, { clinical, meds }) };
    };
    const north = build("north");
    const south = build("south");

    const run = north.mig.begin({ sourceSystem: "legacy-emr", mode: "trial", by: OPS });
    north.mig.load(run.id, patientRecord(), OPS);
    north.mig.load(run.id, allergyRecord("AL-1"), OPS);

    assert.equal(north.mig.runs().length, 1);
    assert.equal(south.mig.runs().length, 0);
    assert.equal(south.mig.run(run.id), undefined);
    assert.equal(south.meds.allergies(P).length, 0);
    // The same source id at another custodian is a different record, not a
    // duplicate: two sites migrating from the same vendor is ordinary.
    const southRun = south.mig.begin({ sourceSystem: "legacy-emr", mode: "trial", by: OPS });
    south.mig.load(southRun.id, patientRecord(), OPS);
    assert.equal(south.mig.load(southRun.id, allergyRecord("AL-1"), OPS).outcome, "loaded");
  } finally {
    root.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- rehearsing it ------------------------------------------------------

test("a dry run reports what would happen and writes absolutely nothing", () => {
  // The point of rehearsing a migration is finding the mapping errors before
  // they are in a chart. A rehearsal that left rows behind would be a
  // migration with extra steps.
  const w = site();
  try {
    const report = w.mig.dryRun({
      sourceSystem: "legacy-emr",
      by: OPS,
      declared: [
        { recordType: "patient", sourceCount: 1 },
        { recordType: "allergy", sourceCount: 2 },
      ],
      records: [patientRecord(), allergyRecord("AL-1"), allergyRecord("AL-2", "Sulfa")],
    });

    assert.equal(report.dryRun, true);
    assert.equal(report.totals.loaded, 3, "it says what would have landed");
    assert.equal(report.totals.rejected, 0);
    assert.equal(report.complete, true, "declared and accounted for");

    // Nothing survives: not the run, not the records, not the chart writes.
    assert.equal(w.mig.runs().length, 0, "the run itself is gone");
    assert.equal(w.mig.provenanceFor(P).length, 0, "no migration record survives");
    assert.equal(w.meds.allergies(P).length, 0, "and nothing reached the chart");
  } finally {
    w.cleanup();
  }
});

test("a dry run finds the rejections a real run would, because it uses the real stores", () => {
  // A validator written alongside the loader is a second opinion that drifts
  // from the first. This one is the loader.
  const w = site();
  try {
    const broken: SourceRecord = {
      sourceId: "AL-BAD",
      recordType: "allergy",
      sourcePatientId: "OLD-NOBODY",
      content: { display: "Penicillin" },
    };
    const report = w.mig.dryRun({
      sourceSystem: "legacy-emr",
      by: OPS,
      declared: [{ recordType: "allergy", sourceCount: 1 }],
      records: [broken],
    });
    assert.equal(report.totals.rejected, 1, "an allergy for a patient nobody migrated cannot load");
    assert.equal(report.totals.loaded, 0);
    // Every declared record is accounted for — and a run holding a rejection
    // is still not complete, which is the stricter and correct answer.
    assert.equal(report.perType[0].unaccounted, 0, "nothing vanished");
    assert.equal(report.complete, false, "a rejection is not a clean bill of health");
    assert.ok(report.caveats.some((c) => /rejected/.test(c)), "and the report says so in words");
    assert.equal(w.mig.runs().length, 0);
  } finally {
    w.cleanup();
  }
});

test("a dry run says what a rehearsal cannot prove", () => {
  // Honest about its own limits, in the report rather than in a comment
  // somebody reads afterwards.
  const w = site();
  try {
    const report = w.mig.dryRun({
      sourceSystem: "legacy-emr",
      by: OPS,
      declared: [{ recordType: "patient", sourceCount: 1 }],
      records: [patientRecord()],
    });
    assert.ok(
      report.caveats.some((c) => /can be refused at cutover/.test(c)),
      "a clean rehearsal today is not a promise about cutover"
    );
    assert.ok(
      report.caveats.some((c) => /in the order given/.test(c)),
      "and the order the batch was validated in is part of the result"
    );
  } finally {
    w.cleanup();
  }
});

test("a dry run with nothing declared reconciles perfectly and says it means nothing", () => {
  // The same trap as the real run: counts that agree with themselves.
  const w = site();
  try {
    const report = w.mig.dryRun({ sourceSystem: "legacy-emr", by: OPS, records: [patientRecord()] });
    assert.equal(report.complete, false, "nothing declared is not a clean bill of health");
    assert.ok(report.caveats.some((c) => /declare/i.test(c)));
  } finally {
    w.cleanup();
  }
});

test("a rehearsal leaves the real run free to use the same source ids", () => {
  // If the dry run's bookkeeping survived, every record would come back
  // "unchanged" on the real load and nothing would actually migrate — the
  // worst possible outcome, and a silent one.
  const w = site();
  try {
    const records = [patientRecord(), allergyRecord("AL-1")];
    w.mig.dryRun({ sourceSystem: "legacy-emr", by: OPS, records });

    const run = w.mig.begin({ sourceSystem: "legacy-emr", mode: "cutover", by: OPS });
    const outcomes = w.mig.loadAll(run.id, records, OPS);
    assert.deepEqual(
      outcomes.map((o) => o.outcome),
      ["loaded", "loaded"],
      "the real load actually loads"
    );
    assert.equal(w.meds.allergies(P).length, 1);
  } finally {
    w.cleanup();
  }
});
