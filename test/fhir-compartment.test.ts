/**
 * Scoping a FHIR search to one chart, and what a null means when it does.
 *
 * `fhir_resources` stored a resource's type, id and JSON, and nothing about
 * whose record it was. So a search could be narrowed to a resource type but
 * never to a patient, and the only way to answer "everything about this
 * person" was to read every row and parse it.
 *
 * The patient reference is now lifted out at write time into a column. The
 * important decision is what its absence means: a row whose patient could not
 * be determined is **excluded** from a patient-scoped search, never included.
 * Null is not a wildcard. A resource nobody could attribute is the last thing
 * that should surface under somebody's name, and if the extraction misses a
 * spelling the result is a record that fails to appear — visible and
 * conservative — rather than one that appears on the wrong chart.
 *
 * The patient-facing surface is unchanged and is deliberately not this. A
 * patient or proxy is served by `/patient/*`, where an authority grant is
 * checked per chart; this scoping is for staff and system callers who are
 * already authorised broadly and want one person's records. Keeping one
 * boundary rather than two is the point.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../src/db.ts";
import { FhirStore, patientOf } from "../src/fhir/store.ts";

const P = "NT123456";
const OTHER = "NT999999";

function site() {
  const dir = mkdtempSync(join(tmpdir(), "northstar-compartment-"));
  const path = join(dir, "northstar.db");
  const db = new Db(path);
  return {
    db,
    path,
    dir,
    fhir: new FhirStore(db),
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}

const observation = (id: string, patient: string) => ({
  resourceType: "Observation",
  id,
  status: "final",
  code: { text: "Potassium" },
  subject: { reference: `Patient/${patient}` },
});

// ── Reading the reference out ─────────────────────────────────────────────

test("the patient reference is recognised in the shapes FHIR actually uses", () => {
  assert.equal(patientOf({ resourceType: "Observation", subject: { reference: `Patient/${P}` } }), P);
  assert.equal(patientOf({ resourceType: "Condition", patient: { reference: `Patient/${P}` } }), P);
  // A Patient is about itself.
  assert.equal(patientOf({ resourceType: "Patient", id: P }), P);
  // A bare id, which some senders use.
  assert.equal(patientOf({ resourceType: "Observation", subject: { reference: P } }), P);
});

test("a reference to something that is not a patient is not read as one", () => {
  // The failure this guards: an Observation whose subject is a Group or a
  // Device landing on a patient's chart because the id happened to parse.
  assert.equal(patientOf({ resourceType: "Observation", subject: { reference: "Group/cohort-1" } }), undefined);
  assert.equal(patientOf({ resourceType: "Observation", subject: { reference: "Device/analyser-3" } }), undefined);
  assert.equal(patientOf({ resourceType: "Observation", subject: { display: "Marie Beaulieu" } }), undefined);
  assert.equal(patientOf({ resourceType: "Organization", id: "org-1" }), undefined);
  assert.equal(patientOf({ resourceType: "ValueSet", id: "vs-1" }), undefined);
});

// ── Scoping ───────────────────────────────────────────────────────────────

test("a patient-scoped search returns that patient's resources and no others", () => {
  const s = site();
  try {
    s.fhir.upsert(observation("obs-1", P));
    s.fhir.upsert(observation("obs-2", P));
    s.fhir.upsert(observation("obs-3", OTHER));

    const mine = s.fhir.search("Observation", { patient: P, count: 50 });
    assert.equal(mine.total, 2);
    assert.deepEqual(mine.resources.map((r) => String((r as { id?: unknown }).id)).sort(), ["obs-1", "obs-2"]);

    const theirs = s.fhir.search("Observation", { patient: OTHER, count: 50 });
    assert.equal(theirs.total, 1);

    // An unscoped search is unchanged: this adds a filter, it does not narrow
    // what an existing caller already sees.
    assert.equal(s.fhir.search("Observation", { count: 50 }).total, 3);
  } finally {
    s.cleanup();
  }
});

test("a resource whose patient cannot be determined is excluded, not included", () => {
  // Null is not a wildcard. This is the direction the failure has to fall.
  const s = site();
  try {
    s.fhir.upsert(observation("obs-1", P));
    s.fhir.upsert({
      resourceType: "Observation",
      id: "obs-orphan",
      status: "final",
      code: { text: "Potassium" },
      subject: { display: "a name with no reference" },
    });

    const scoped = s.fhir.search("Observation", { patient: P, count: 50 });
    assert.equal(scoped.total, 1, "the unattributable resource does not join this chart");
    assert.deepEqual(scoped.resources.map((r) => String((r as { id?: unknown }).id)), ["obs-1"]);

    // It has not vanished — an unscoped search still finds it, so the gap is
    // visible rather than a silent deletion.
    assert.equal(s.fhir.search("Observation", { count: 50 }).total, 2);
  } finally {
    s.cleanup();
  }
});

test("a scoped search for a patient with nothing returns nothing, not everything", () => {
  const s = site();
  try {
    s.fhir.upsert(observation("obs-1", P));
    const none = s.fhir.search("Observation", { patient: "NT000000", count: 50 });
    assert.equal(none.total, 0);
    assert.deepEqual(none.resources, []);
  } finally {
    s.cleanup();
  }
});

test("scoping composes with paging, and each page stays inside the chart", () => {
  const s = site();
  try {
    for (let i = 0; i < 12; i++) s.fhir.upsert(observation(`mine-${String(i).padStart(2, "0")}`, P));
    for (let i = 0; i < 12; i++) s.fhir.upsert(observation(`other-${String(i).padStart(2, "0")}`, OTHER));

    const seen: string[] = [];
    for (let offset = 0; offset < 12; offset += 5) {
      const page = s.fhir.search("Observation", { patient: P, count: 5, offset });
      assert.equal(page.total, 12, "the total is the patient's total, not the store's");
      seen.push(...page.resources.map((r) => String((r as { id?: unknown }).id)));
    }
    assert.equal(new Set(seen).size, 12);
    assert.ok(seen.every((id) => id.startsWith("mine-")), "no page leaked across the compartment");
  } finally {
    s.cleanup();
  }
});

test("one tenant's scoped search never reaches another tenant's chart", () => {
  const s = site();
  try {
    s.fhir.upsert(observation("obs-1", P));
    const other = new FhirStore(s.db.forTenant("yellowknife"));
    other.upsert(observation("obs-2", P));

    // Same patient identifier, two custodians. Neither sees the other's.
    assert.equal(s.fhir.search("Observation", { patient: P, count: 50 }).total, 1);
    assert.equal(other.search("Observation", { patient: P, count: 50 }).total, 1);
    assert.equal(
      String((s.fhir.search("Observation", { patient: P }).resources[0] as { id?: unknown }).id),
      "obs-1",
    );
    assert.equal(
      String((other.search("Observation", { patient: P }).resources[0] as { id?: unknown }).id),
      "obs-2",
    );
  } finally {
    s.cleanup();
  }
});

// ── Upgrading a database written before the column existed ────────────────

test("a database written without the column gains it, and the references are recovered", () => {
  const s = site();
  try {
    s.fhir.upsert(observation("obs-1", P));
    s.fhir.upsert(observation("obs-2", OTHER));
    s.fhir.upsert({ resourceType: "Patient", id: P, name: [{ family: "Beaulieu" }] });

    // Put the store back into its pre-migration state: the rows are there and
    // the column is empty, exactly as an upgraded database finds them.
    s.db.sql.prepare("UPDATE fhir_resources SET patient_id = NULL WHERE tenant_id = ?").run("default");
    assert.equal(s.fhir.search("Observation", { patient: P, count: 50 }).total, 0, "before the backfill, nothing is attributed");

    const filled = s.fhir.backfillPatients();
    assert.equal(filled, 3, "two observations and the patient itself");
    assert.equal(s.fhir.search("Observation", { patient: P, count: 50 }).total, 1);
    assert.equal(s.fhir.search("Patient", { patient: P, count: 50 }).total, 1);

    // Idempotent: running it again changes nothing.
    assert.equal(s.fhir.backfillPatients(), 0);
    assert.equal(s.fhir.search("Observation", { patient: P, count: 50 }).total, 1);
  } finally {
    s.cleanup();
  }
});

test("the backfill leaves a resource it cannot attribute alone, rather than guessing", () => {
  const s = site();
  try {
    s.fhir.upsert({ resourceType: "Observation", id: "obs-orphan", status: "final", code: { text: "K" } });
    s.db.sql.prepare("UPDATE fhir_resources SET patient_id = NULL WHERE tenant_id = ?").run("default");
    assert.equal(s.fhir.backfillPatients(), 0, "nothing to recover is not the same as something to invent");
    assert.equal(s.fhir.search("Observation", { count: 50 }).total, 1, "and it is still readable unscoped");
  } finally {
    s.cleanup();
  }
});

test("an update moves a resource with its subject, and does not leave it on the old chart", () => {
  // A correction that repoints a result at the right patient has to take the
  // scoping with it, or the record stays findable under the wrong name.
  const s = site();
  try {
    s.fhir.upsert(observation("obs-1", P));
    assert.equal(s.fhir.search("Observation", { patient: P }).total, 1);

    s.fhir.upsert(observation("obs-1", OTHER));
    assert.equal(s.fhir.search("Observation", { patient: P }).total, 0, "it is no longer on the first chart");
    assert.equal(s.fhir.search("Observation", { patient: OTHER }).total, 1);
  } finally {
    s.cleanup();
  }
});
