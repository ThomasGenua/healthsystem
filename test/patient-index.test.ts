/**
 * Finding the right patient.
 *
 * The point in a health record most likely to go wrong is not storage, it is
 * lookup: the wrong Marie Beaulieu, one person under two numbers, two people
 * under one. So these check the failures that matter clinically rather than
 * that a query returns rows.
 *
 * The load-bearing test is the last one. The index is derived, and it is only
 * honestly derived if rebuilding it from the log reproduces it — otherwise it
 * has quietly become a second source of truth about who a patient is, and two
 * sources of truth about identity do not stay in agreement.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../src/db.ts";
import { ClinicalRecord } from "../src/clinical/record.ts";

function chart(): { db: Db; rec: ClinicalRecord; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "northstar-pidx-"));
  const db = new Db(join(dir, "northstar.db"));
  return {
    db,
    rec: new ClinicalRecord(db),
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}

const FEED = { authorId: "adt-feed", authorKind: "device" };

function patient(rec: ClinicalRecord, id: string, content: Record<string, unknown>) {
  return rec.record({ entryType: "Patient", patientId: id, content, ...FEED });
}

const BEAULIEU = {
  resourceType: "Patient",
  identifier: [{ system: "urn:jhn", value: "NT123456" }],
  name: [{ family: "Beaulieu", given: ["Marie", "Louise"], use: "official" }],
  birthDate: "1984-03-17",
  gender: "female",
};

test("a patient is findable by identifier, name and birth date", () => {
  const { rec, cleanup } = chart();
  try {
    patient(rec, "NT123456", BEAULIEU);
    const idx = rec.patientIndex;

    assert.equal(idx.search({ identifier: "NT123456" })[0].family, "Beaulieu");
    assert.equal(idx.search({ identifier: "urn:jhn|NT123456" })[0].family, "Beaulieu");
    assert.equal(idx.search({ family: "Beaulieu" })[0].patientId, "NT123456");
    assert.equal(idx.search({ family: "beaulieu" }).length, 1, "a name typed in a hurry is not capitalised as filed");
    assert.equal(idx.search({ given: "Marie" }).length, 1);
    assert.equal(idx.search({ birthDate: "1984-03-17" }).length, 1);

    const summary = idx.get("NT123456")!;
    assert.equal(summary.given, "Marie Louise");
    assert.equal(summary.gender, "female");
    assert.equal(summary.preferredLanguage, null);
    assert.equal(summary.phone, null);
    assert.equal(summary.email, null);
    assert.deepEqual(
      summary.identifiers.map((i) => i.value).sort(),
      ["NT123456", "NT123456"],
      "the chart key is itself a way in, alongside the health number"
    );
  } finally {
    cleanup();
  }
});

test("preferred language and telecom are recovered from the Patient entry", () => {
  const { rec, cleanup } = chart();
  try {
    patient(rec, "NT123456", {
      ...BEAULIEU,
      telecom: [
        { system: "phone", value: "867-555-0100" },
        { system: "email", value: "marie@example.net" },
      ],
      communication: [
        { language: { text: "fr-CA" }, preferred: true },
        { language: { text: "en" } },
      ],
    });
    const summary = rec.patientIndex.get("NT123456")!;
    assert.equal(summary.preferredLanguage, "fr-CA");
    assert.equal(summary.phone, "867-555-0100");
    assert.equal(summary.email, "marie@example.net");

    rec.patientIndex.rebuild(rec);
    const again = rec.patientIndex.get("NT123456")!;
    assert.equal(again.preferredLanguage, "fr-CA");
    assert.equal(again.phone, "867-555-0100");
    assert.equal(again.email, "marie@example.net");
  } finally {
    cleanup();
  }
});

test("more criteria narrow the search, never widen it", () => {
  // A search that widened as the clinician supplied more would return more
  // wrong Maries the better they knew which one they meant.
  const { rec, cleanup } = chart();
  try {
    patient(rec, "NT1", BEAULIEU);
    patient(rec, "NT2", { ...BEAULIEU, identifier: [{ system: "urn:jhn", value: "NT999" }], birthDate: "1991-11-02" });

    const idx = rec.patientIndex;
    assert.equal(idx.search({ family: "Beaulieu" }).length, 2);
    assert.equal(idx.search({ family: "Beaulieu", birthDate: "1984-03-17" }).length, 1);
    assert.equal(idx.search({ family: "Beaulieu", birthDate: "1984-03-17", given: "Marie" }).length, 1);
    assert.equal(idx.search({ family: "Beaulieu", birthDate: "2001-01-01" }).length, 0);
  } finally {
    cleanup();
  }
});

test("an identifier a patient was previously known by still finds them", () => {
  // A message arriving under last year's interim number has to reach the same
  // chart. Dropping identifiers on update would strand records that reference
  // them, and those records do not stop existing.
  const { rec, cleanup } = chart();
  try {
    const p = patient(rec, "NT123456", {
      ...BEAULIEU,
      identifier: [{ system: "urn:interim", value: "TEMP-4471" }],
    });
    assert.equal(rec.patientIndex.search({ identifier: "TEMP-4471" }).length, 1);

    rec.amend(p.record_id, BEAULIEU, { ...FEED, reason: "provincial number issued" });

    const idx = rec.patientIndex;
    assert.equal(idx.search({ identifier: "NT123456" }).length, 1, "the new number finds them");
    assert.equal(idx.search({ identifier: "TEMP-4471" }).length, 1, "and so does the one they arrived under");
  } finally {
    cleanup();
  }
});

test("one identifier naming two charts is surfaced, not merged", () => {
  // Close to conclusive: a health number should not name two charts. Still
  // surfaced rather than acted on — merging is how a chart acquires someone
  // else's allergies, and there is no honest unmerge.
  const { rec, cleanup } = chart();
  try {
    patient(rec, "chart-a", BEAULIEU);
    patient(rec, "chart-b", { ...BEAULIEU, name: [{ family: "Beaulieu", given: ["M."] }] });

    const dupes = rec.patientIndex.duplicates().filter((d) => d.reason === "shared-identifier");
    assert.equal(dupes.length, 1);
    assert.deepEqual(dupes[0].patientIds.sort(), ["chart-a", "chart-b"]);
    assert.match(dupes[0].evidence, /NT123456 names 2 charts/);

    // And both charts are still separately readable: nothing was combined.
    assert.equal(rec.patientIndex.get("chart-a")!.given, "Marie Louise");
    assert.equal(rec.patientIndex.get("chart-b")!.given, "M.");
  } finally {
    cleanup();
  }
});

test("a matching name and birth date is a prompt, not a finding", () => {
  // Twins exist, and so do fathers and sons with one name between them. The
  // reason is reported so a human can weigh it.
  const { rec, cleanup } = chart();
  try {
    patient(rec, "NT1", { ...BEAULIEU, identifier: [{ system: "urn:jhn", value: "NT1" }] });
    patient(rec, "NT2", { ...BEAULIEU, identifier: [{ system: "urn:jhn", value: "NT2" }] });

    const dupes = rec.patientIndex.duplicates();
    assert.equal(dupes.filter((d) => d.reason === "shared-identifier").length, 0, "different numbers, so not that");
    const byName = dupes.filter((d) => d.reason === "same-name-and-birth-date");
    assert.equal(byName.length, 1);
    assert.match(byName[0].evidence, /Marie Louise Beaulieu, born 1984-03-17/);
  } finally {
    cleanup();
  }
});

test("the index is exactly what the log says, and can be rebuilt to prove it", () => {
  // The load-bearing property. If rebuilding from the log reproduces the
  // index, nothing in the index is a fact the log does not already hold — so
  // the log is the record and this is a convenience. If it did not, identity
  // would have two sources of truth.
  const { db, rec, cleanup } = chart();
  try {
    const a = patient(rec, "NT123456", BEAULIEU);
    patient(rec, "NT999", {
      ...BEAULIEU,
      identifier: [{ system: "urn:jhn", value: "NT999" }],
      name: [{ family: "Tetso", given: ["John"] }],
      birthDate: "1970-01-02",
    });
    rec.amend(a.record_id, { ...BEAULIEU, gender: "other" }, { ...FEED, reason: "corrected at registration" });

    const before = ["NT123456", "NT999"].map((id) => JSON.stringify(rec.patientIndex.get(id)));

    // Wipe it and derive it again from the entries alone.
    db.sql.exec("DELETE FROM patient_index");
    db.sql.exec("DELETE FROM patient_identifiers");
    assert.equal(rec.patientIndex.get("NT123456"), undefined, "the setup must really have emptied it");

    const rebuilt = rec.patientIndex.rebuild(rec);
    assert.equal(rebuilt, 2);
    const after = ["NT123456", "NT999"].map((id) => JSON.stringify(rec.patientIndex.get(id)));

    // updated_at moves, since the rows were written again; everything that
    // describes the patient must not.
    const strip = (s: string) => JSON.parse(s) as Record<string, unknown>;
    for (let i = 0; i < before.length; i++) {
      const b = strip(before[i]);
      const a2 = strip(after[i]);
      delete b.updatedAt;
      delete a2.updatedAt;
      assert.deepEqual(a2, b, "the rebuilt index must say exactly what the live one did");
    }
    assert.equal((strip(after[0]) as { gender: string }).gender, "other", "including the amendment");
  } finally {
    cleanup();
  }
});

test("a retracted patient leaves the index on rebuild", () => {
  // A chart marked entered-in-error must stop being findable, or a search
  // keeps offering a record a clinician has already declared wrong.
  const { rec, cleanup } = chart();
  try {
    const p = patient(rec, "NT123456", BEAULIEU);
    patient(rec, "NT999", { ...BEAULIEU, identifier: [{ system: "urn:jhn", value: "NT999" }] });
    rec.retract(p.record_id, { authorId: "dr-tetso", authorKind: "practitioner", reason: "created in error" });

    rec.patientIndex.rebuild(rec);
    assert.equal(rec.patientIndex.get("NT123456"), undefined);
    assert.equal(rec.patientIndex.get("NT999")?.patientId, "NT999", "and the other chart is untouched");

    // The entries themselves are still there: retraction is not deletion.
    assert.equal(rec.chart("NT123456", { includeRetracted: true }).length, 1);
  } finally {
    cleanup();
  }
});

test("the index is confined to its tenant", () => {
  const dir = mkdtempSync(join(tmpdir(), "northstar-pidx-iso-"));
  const root = new Db(join(dir, "northstar.db"));
  try {
    root.createTenant("north", "Northern Health");
    root.createTenant("south", "Southern Health");
    const north = new ClinicalRecord(root.forTenant("north"));
    const south = new ClinicalRecord(root.forTenant("south"));

    patient(north, "NT123456", BEAULIEU);
    patient(south, "NT123456", { ...BEAULIEU, name: [{ family: "Different", given: ["Person"] }] });

    assert.equal(north.patientIndex.search({ identifier: "NT123456" })[0].family, "Beaulieu");
    assert.equal(south.patientIndex.search({ identifier: "NT123456" })[0].family, "Different");
    assert.equal(
      north.patientIndex.duplicates().length,
      0,
      "the same number at two custodians is not a duplicate: it is the same province"
    );
  } finally {
    root.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
