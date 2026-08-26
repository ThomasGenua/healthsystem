/**
 * Reading an export without losing any of it.
 *
 * The migration module refuses to call a run complete because nothing threw.
 * This is the same rule one layer earlier, where it is easier to break: a
 * reader that skips what it does not understand hands the loader a tidy pile
 * of everything it happened to recognise, and the reconciliation then agrees
 * with itself about a number nobody chose.
 *
 * So the tests that matter here are about what happens to the awkward ones.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../src/db.ts";
import { ClinicalRecord } from "../src/clinical/record.ts";
import { MedicationStore } from "../src/meds/store.ts";
import { Migration } from "../src/migrate/run.ts";
import { readFhirBundle, readFhirNdjson } from "../src/migrate/read-fhir.ts";

const OPS = { actorId: "migration-operator" };
const P = "OLD-1001";

function site() {
  const dir = mkdtempSync(join(tmpdir(), "portage-read-"));
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

const patient = {
  resourceType: "Patient",
  id: P,
  identifier: [{ system: "urn:jhn", value: "9876543" }],
  name: [{ family: "Beaulieu", given: ["Marie"] }],
  birthDate: "1984-03-17",
};

const allergy = {
  resourceType: "AllergyIntolerance",
  id: "AL-1",
  patient: { reference: `Patient/${P}` },
  code: { coding: [{ system: "http://snomed.info/sct", code: "373270004", display: "Penicillin" }] },
  criticality: "high",
  reaction: [{ manifestation: [{ text: "Hives" }] }],
};

const bundle = (entries: unknown[], total?: number) => ({
  resourceType: "Bundle",
  type: "collection",
  ...(total === undefined ? {} : { total }),
  entry: entries.map((resource) => ({ resource })),
});

test("a resource the reader does not understand is reported, never skipped", () => {
  // The whole point. A skipped resource is a record that silently did not
  // migrate, and the reconciliation would never know it existed.
  const reading = readFhirBundle(bundle([patient, { resourceType: "Practitioner", id: "PR-1", name: [] }]));
  assert.equal(reading.records.length, 1);
  assert.equal(reading.unreadable.length, 1);
  assert.equal(reading.unreadable[0].resourceType, "Practitioner");
  assert.match(reading.unreadable[0].reason, /does not map Practitioner/);
  assert.ok(reading.unreadable[0].raw, "and the resource itself is kept, so somebody can look at it");
});

test("a resource with no id is unreadable, because a re-run would load it twice", () => {
  const reading = readFhirBundle(bundle([{ ...patient, id: undefined }]));
  assert.equal(reading.records.length, 0);
  assert.match(reading.unreadable[0].reason, /stable source key/);
});

test("the bundle's own total is the declaration, and its absence is reported as absence", () => {
  // A count derived from the entries cannot disagree with the entries, and a
  // number that cannot disagree proves nothing.
  assert.equal(readFhirBundle(bundle([patient, allergy], 2)).declaredTotal, 2);
  assert.equal(readFhirBundle(bundle([patient, allergy])).declaredTotal, null, "not inferred from what arrived");
});

test("a patient, an allergy and their provenance survive the read", () => {
  const reading = readFhirBundle(bundle([patient, allergy], 2));
  const [first, second] = reading.records;
  assert.equal(first.recordType, "patient");
  assert.equal(first.sourceId, P);
  assert.equal(first.content.birthDate, "1984-03-17");

  assert.equal(second.recordType, "allergy");
  assert.equal(second.sourcePatientId, P, "Patient/OLD-1001 resolves to the chart, not the reference");
  assert.equal(second.content.display, "Penicillin");
  assert.equal(second.content.criticality, "high");
  assert.equal(second.content.reaction, "Hives");
  assert.equal(second.sourceCodes?.["http://snomed.info/sct"], "373270004", "the source's own code travels");
  assert.deepEqual(reading.counts, { patient: 1, allergy: 1 });
});

test("patients are read first, whatever order the export put them in", () => {
  // An allergy loaded before its patient is refused against a chart that does
  // not exist. An export that happened to list them the other way round would
  // otherwise reconcile as a pile of rejections that are really one ordering
  // problem.
  const reading = readFhirBundle(bundle([allergy, patient], 2));
  assert.equal(reading.records[0].recordType, "patient");
});

test("a resource the reader maps but the stores refuse becomes a rejection with its payload", () => {
  // Not unreadable — readable, and wrong. It has to reach the loader so it
  // lands in the reject queue where somebody can go and look at it.
  const noSubstance = { resourceType: "AllergyIntolerance", id: "AL-2", patient: { reference: `Patient/${P}` }, code: {} };
  const reading = readFhirBundle(bundle([patient, noSubstance], 2));
  assert.equal(reading.unreadable.length, 0, "the reader understood it");
  assert.equal(reading.records.length, 2);

  const w = site();
  try {
    const run = w.mig.begin({ sourceSystem: "legacy-emr", mode: "cutover", by: OPS });
    w.mig.declare(run.id, "patient", 1, OPS);
    w.mig.declare(run.id, "allergy", 1, OPS);
    w.mig.loadAll(run.id, reading.records, OPS);

    const report = w.mig.report(run.id);
    assert.equal(report.totals.rejected, 1);
    assert.equal(report.complete, false, "a rejection is not a clean bill of health");
    const rejects = w.mig.rejects(run.id);
    assert.equal(rejects.length, 1);
    assert.match(rejects[0].reason ?? "", /needs a substance/);
    assert.ok(rejects[0].payload, "with the payload, not just a count");
  } finally {
    w.cleanup();
  }
});

test("an export reads, loads and reconciles end to end", () => {
  const w = site();
  try {
    const condition = {
      resourceType: "Condition",
      id: "CO-1",
      subject: { reference: `Patient/${P}` },
      code: { coding: [{ system: "http://snomed.info/sct", code: "44054006", display: "Type 2 diabetes mellitus" }] },
      onsetDateTime: "2019-06-02",
    };
    const reading = readFhirBundle(bundle([patient, allergy, condition], 3));
    assert.equal(reading.declaredTotal, 3);

    const run = w.mig.begin({ sourceSystem: "legacy-emr", mode: "cutover", by: OPS });
    for (const [recordType, count] of Object.entries(reading.counts)) {
      w.mig.declare(run.id, recordType as "patient", count, OPS);
    }
    w.mig.loadAll(run.id, reading.records, OPS);

    const report = w.mig.report(run.id);
    assert.equal(report.totals.loaded, 3);
    assert.equal(report.complete, true, "declared, loaded and accounted for");
    assert.equal(w.meds.allergies(P).length, 1);
    assert.equal(w.clinical.chart(P, { entryType: "Condition" }).length, 1);
  } finally {
    w.cleanup();
  }
});

test("a rehearsal of a read export writes nothing, so the real load still loads", () => {
  const w = site();
  try {
    const reading = readFhirBundle(bundle([patient, allergy], 2));
    const rehearsal = w.mig.dryRun({
      sourceSystem: "legacy-emr",
      by: OPS,
      declared: Object.entries(reading.counts).map(([recordType, sourceCount]) => ({
        recordType: recordType as "patient",
        sourceCount,
      })),
      records: reading.records,
    });
    assert.equal(rehearsal.dryRun, true);
    assert.equal(rehearsal.totals.loaded, 2);
    assert.equal(rehearsal.complete, true);
    assert.equal(w.mig.runs().length, 0);

    const run = w.mig.begin({ sourceSystem: "legacy-emr", mode: "cutover", by: OPS });
    const outcomes = w.mig.loadAll(run.id, reading.records, OPS);
    assert.deepEqual(outcomes.map((o) => o.outcome), ["loaded", "loaded"]);
  } finally {
    w.cleanup();
  }
});

test("one corrupt line costs that line, not the export", () => {
  const ndjson = [JSON.stringify(patient), "{not json", JSON.stringify(allergy)].join("\n");
  const reading = readFhirNdjson(ndjson);
  assert.equal(reading.records.length, 2, "the readable lines still read");
  assert.equal(reading.unreadable.length, 1);
  assert.match(reading.unreadable[0].reason, /line 2 is not JSON/);
  assert.equal(reading.declaredTotal, null, "NDJSON carries no total, and that is a gap, not a zero");
});

test("something that is not a bundle at all is said plainly", () => {
  const reading = readFhirBundle({ resourceType: "Patient", id: P });
  assert.equal(reading.records.length, 0);
  assert.match(reading.unreadable[0].reason, /not a FHIR Bundle/);
});

test("a medication keeps its instruction line as written rather than parsed", () => {
  // Splitting "one twice daily with food" into dose and frequency is a guess,
  // and a guess about a dose is the wrong place to be clever.
  const med = {
    resourceType: "MedicationStatement",
    id: "MED-1",
    subject: { reference: `Patient/${P}` },
    medicationCodeableConcept: { coding: [{ system: "urn:rxnorm", code: "860975", display: "Metformin 500mg" }] },
    dosage: [{ text: "one twice daily with food" }],
    status: "active",
  };
  const reading = readFhirBundle(bundle([med]));
  assert.equal(reading.records[0].content.code, "860975");
  assert.equal(reading.records[0].content.display, "Metformin 500mg");
  assert.equal(reading.records[0].content.dose, "one twice daily with food");
});

test("a record whose chart never arrives is rejected, not filed against a guess", () => {
  const orphan = { ...allergy, id: "AL-ORPHAN", patient: { reference: "Patient/NOBODY" } };
  const reading = readFhirBundle(bundle([orphan], 1));
  assert.equal(reading.records[0].sourcePatientId, "NOBODY", "the reader reports what it was told");

  const w = site();
  try {
    const run = w.mig.begin({ sourceSystem: "legacy-emr", mode: "cutover", by: OPS });
    w.mig.declare(run.id, "allergy", 1, OPS);
    w.mig.loadAll(run.id, reading.records, OPS);
    assert.match(w.mig.rejects(run.id)[0].reason ?? "", /no chart NOBODY/);
  } finally {
    w.cleanup();
  }
});
