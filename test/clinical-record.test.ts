/**
 * A correction must not be able to destroy what it corrects.
 *
 * Section 1 asks that nothing clinically material is silently overwritten and
 * that a correction retains the original with its full history. That is a
 * claim about what the storage makes impossible, not about what its callers
 * are careful to avoid — so these tests try to overwrite, try to delete, and
 * try to rewrite history, and require each attempt to be either refused or
 * caught.
 *
 * The distinction that matters throughout: a retraction is not a deletion.
 * "This was recorded against the wrong patient" and "this never happened" are
 * different claims, and a decision taken on the strength of the original
 * cannot be reviewed against a blank.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../src/db.ts";
import { ClinicalRecord } from "../src/clinical/record.ts";
import { Encounters } from "../src/clinical/encounters.ts";

function chart(): { db: Db; rec: ClinicalRecord; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "northstar-chart-"));
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

const CLINICIAN = { authorId: "dr-tetso", authorKind: "practitioner" };

test("an amendment keeps the version it replaces, and says why", () => {
  const { rec, cleanup } = chart();
  try {
    const first = rec.record({
      entryType: "Condition",
      patientId: "NT123456",
      content: { code: "E11", display: "Type 2 diabetes mellitus" },
      ...CLINICIAN,
    });

    rec.amend(
      first.record_id,
      { code: "E10", display: "Type 1 diabetes mellitus" },
      { ...CLINICIAN, reason: "coded from the wrong line of the referral" }
    );

    const history = rec.history(first.record_id);
    assert.equal(history.length, 2, "the original is a row, not a memory");
    assert.equal(JSON.parse(history[0].content).code, "E11", "and it still says what it said");
    assert.equal(history[0].superseded, true, "superseded is derived from a later version, never written back");
    assert.equal(history[0].status, "active", "and the version a clinician signed is untouched");
    assert.equal(history[1].superseded, false);
    assert.equal(history[1].supersedes, history[0].version_id, "the correction points at what it corrected");
    assert.match(history[1].amendment_reason ?? "", /wrong line of the referral/);

    // And the chart reads as the corrected value.
    const current = rec.current(first.record_id)!;
    assert.equal(JSON.parse(current.content).code, "E10");
    assert.equal(current.version, 2);
  } finally {
    cleanup();
  }
});

test("an amendment without a reason is refused", () => {
  // "Corrected" with no explanation is what tidying up looks like, and it is
  // exactly what a reviewer needs to be able to tell from a real correction.
  const { rec, cleanup } = chart();
  try {
    const e = rec.record({ entryType: "Condition", patientId: "p", content: { code: "E11" }, ...CLINICIAN });
    assert.throws(() => rec.amend(e.record_id, { code: "E10" }, { ...CLINICIAN, reason: "  " }), /needs a reason/);
    assert.equal(rec.history(e.record_id).length, 1, "and nothing is written");
  } finally {
    cleanup();
  }
});

test("a retraction marks the record without removing it", () => {
  const { rec, cleanup } = chart();
  try {
    const e = rec.record({
      entryType: "AllergyIntolerance",
      patientId: "NT123456",
      content: { code: "penicillin", criticality: "high" },
      ...CLINICIAN,
    });
    rec.retract(e.record_id, { ...CLINICIAN, reason: "recorded against the wrong patient" });

    const history = rec.history(e.record_id);
    assert.equal(history.length, 2);
    assert.equal(history[1].status, "entered-in-error");
    assert.equal(
      JSON.parse(history[1].content).code,
      "penicillin",
      "the content is carried forward: what was asserted is part of what happened"
    );

    // It leaves the working chart, and is still reachable for a review.
    assert.equal(rec.chart("NT123456").length, 0);
    assert.equal(rec.chart("NT123456", { includeRetracted: true }).length, 1);
  } finally {
    cleanup();
  }
});

test("a retracted record cannot be amended back into the chart", () => {
  // Amending a retraction would let a record that was declared an error
  // quietly become authoritative again, with no statement that it had.
  const { rec, cleanup } = chart();
  try {
    const e = rec.record({ entryType: "Condition", patientId: "p", content: { code: "E11" }, ...CLINICIAN });
    rec.retract(e.record_id, { ...CLINICIAN, reason: "wrong patient" });
    assert.throws(
      () => rec.amend(e.record_id, { code: "E10" }, { ...CLINICIAN, reason: "actually right" }),
      /entered-in-error cannot be amended/
    );
  } finally {
    cleanup();
  }
});

test("there is no way to overwrite an entry through the store", () => {
  // The guarantee is structural. Every verb is a write of a new version, so
  // the version count only ever grows.
  const { rec, cleanup } = chart();
  try {
    const e = rec.record({ entryType: "Observation", patientId: "p", content: { value: 120 }, ...CLINICIAN });
    for (let i = 0; i < 5; i++) {
      rec.amend(e.record_id, { value: 121 + i }, { ...CLINICIAN, reason: `re-read ${i}` });
    }
    const history = rec.history(e.record_id);
    assert.equal(history.length, 6);
    assert.deepEqual(
      history.map((h) => JSON.parse(h.content).value),
      [120, 121, 122, 123, 124, 125],
      "every reading ever recorded is still readable"
    );
    assert.deepEqual(
      history.map((h) => h.version),
      [1, 2, 3, 4, 5, 6]
    );
  } finally {
    cleanup();
  }
});

test("rewriting an entry's content breaks chart verification", () => {
  // The chain commits to the clinical text, not merely to metadata about it.
  // A chain over metadata alone would leave the text rewritable under an
  // intact-looking history.
  const { db, rec, cleanup } = chart();
  try {
    const e = rec.record({
      entryType: "Condition",
      patientId: "NT123456",
      content: { code: "E11", display: "Type 2 diabetes mellitus" },
      ...CLINICIAN,
    });
    rec.record({ entryType: "Observation", patientId: "NT123456", content: { value: 7.4 }, ...CLINICIAN });
    assert.equal(rec.verifyChart("NT123456").ok, true);

    db.sql
      .prepare("UPDATE clinical_entries SET content = ? WHERE version_id = ?")
      .run(JSON.stringify({ code: "E10", display: "Type 1 diabetes mellitus" }), e.version_id);

    const v = rec.verifyChart("NT123456");
    assert.equal(v.ok, false, "an edited diagnosis must not verify");
    assert.equal(v.brokenAt, e.version_id, "and the report names the entry");
  } finally {
    cleanup();
  }
});

test("removing the most recent entries is caught, not just middle ones", () => {
  // The truncation case. Nothing survives that pointed at the removed rows, so
  // linkage alone reads a shortened chart as a valid one — and deleting the
  // latest entries is what someone removing an inconvenient note would do.
  const { db, rec, cleanup } = chart();
  try {
    for (let i = 0; i < 5; i++) {
      rec.record({ entryType: "Observation", patientId: "p", content: { value: i }, ...CLINICIAN });
    }
    assert.equal(rec.verifyChart("p").checked, 5);

    db.sql.exec("DELETE FROM clinical_entries WHERE seq > (SELECT MAX(seq) - 2 FROM clinical_entries)");
    const v = rec.verifyChart("p");
    assert.equal(v.ok, false);
    assert.deepEqual(v.missing, { expected: 5, found: 3 });

    // A middle removal is caught by linkage, which is the other half.
    const fresh = chart();
    try {
      for (let i = 0; i < 5; i++) {
        fresh.rec.record({ entryType: "Observation", patientId: "p", content: { value: i }, ...CLINICIAN });
      }
      fresh.db.sql.exec("DELETE FROM clinical_entries WHERE seq = (SELECT MIN(seq) + 2 FROM clinical_entries)");
      const mid = fresh.rec.verifyChart("p");
      assert.equal(mid.ok, false);
      assert.equal(mid.missing, undefined, "a broken link is not a truncation");
    } finally {
      fresh.cleanup();
    }
  } finally {
    cleanup();
  }
});

test("one patient's chart is its own chain", () => {
  // Charts must not be interleaved into one chain, or an entry for one patient
  // could not be verified without reading everybody's.
  const { rec, cleanup } = chart();
  try {
    rec.record({ entryType: "Condition", patientId: "a", content: { code: "E11" }, ...CLINICIAN });
    rec.record({ entryType: "Condition", patientId: "b", content: { code: "I10" }, ...CLINICIAN });
    rec.record({ entryType: "Condition", patientId: "a", content: { code: "J45" }, ...CLINICIAN });

    assert.equal(rec.verifyChart("a").checked, 2);
    assert.equal(rec.verifyChart("b").checked, 1);
    assert.equal(rec.verifyChart("a").ok, true);
    assert.equal(rec.verifyChart("b").ok, true);
    assert.notEqual(rec.verifyChart("a").tip, rec.verifyChart("b").tip);
  } finally {
    cleanup();
  }
});

test("the chart shows current versions, filtered by type and encounter", () => {
  const { db, rec, cleanup } = chart();
  try {
    // Real visits: the record refuses an encounter_id that names nothing, so
    // the fixture opens the two it files against rather than inventing them.
    const encounters = new Encounters(db);
    const visit = (reason: string): string =>
      encounters.open({
        patientId: "p",
        class: "in-person",
        reason,
        by: { actorId: "clerk", actorKind: "staff" },
        arrived: true,
      }).id;
    const enc1 = visit("Review");
    const enc2 = visit("Bloods");
    const cond = rec.record({
      entryType: "Condition",
      patientId: "p",
      content: { code: "E11" },
      encounterId: enc1,
      ...CLINICIAN,
    });
    rec.amend(cond.record_id, { code: "E10" }, { ...CLINICIAN, reason: "re-coded" });
    rec.record({
      entryType: "Observation",
      patientId: "p",
      content: { value: 7.4 },
      encounterId: enc2,
      ...CLINICIAN,
    });

    const all = rec.chart("p");
    assert.equal(all.length, 2, "one row per record, at its latest version");
    assert.deepEqual(rec.chart("p", { entryType: "Condition" }).map((e) => JSON.parse(e.content).code), ["E10"]);
    assert.equal(rec.chart("p", { encounterId: enc2 }).length, 1);
  } finally {
    cleanup();
  }
});

test("provenance is recorded on every version, including who and where from", () => {
  // Section 1's last requirement: complete source, author, date, status and
  // amendment history. An entry that cannot say where it came from cannot be
  // reconciled against the interface that delivered it.
  const { rec, cleanup } = chart();
  try {
    const e = rec.record({
      entryType: "Observation",
      patientId: "p",
      content: { value: 7.4 },
      authorId: "lab-feed",
      authorKind: "device",
      source: "Dynacare ORU",
      sourceMessageId: "msg-abc",
      effectiveAt: "2026-08-05T09:12:00Z",
    });

    assert.equal(e.author_id, "lab-feed");
    assert.equal(e.author_kind, "device");
    assert.equal(e.source, "Dynacare ORU");
    assert.equal(e.source_message_id, "msg-abc");
    assert.equal(e.effective_at, "2026-08-05T09:12:00Z", "when it was true, not only when it was filed");
    assert.ok(e.recorded_at, "and when it was written down");

    // An amendment by a clinician keeps the source and names the new author.
    const fixed = rec.amend(e.record_id, { value: 7.5 }, { authorId: "dr-tetso", authorKind: "practitioner", reason: "unit conversion" });
    assert.equal(fixed.author_id, "dr-tetso");
    assert.equal(fixed.source, "Dynacare ORU", "the record still knows where it originally came from");
  } finally {
    cleanup();
  }
});

test("charts are confined to their tenant", () => {
  // The most sensitive surface on the platform, so the boundary is checked
  // here too rather than assumed from the storage tests.
  const dir = mkdtempSync(join(tmpdir(), "northstar-chart-iso-"));
  const root = new Db(join(dir, "northstar.db"));
  try {
    root.createTenant("north", "Northern Health");
    root.createTenant("south", "Southern Health");
    const north = new ClinicalRecord(root.forTenant("north"));
    const south = new ClinicalRecord(root.forTenant("south"));

    // The same patient identifier at both custodians, which is the norm: a
    // health number is issued by a province, not by a clinic.
    north.record({ entryType: "Condition", patientId: "NT123456", content: { code: "E11" }, ...CLINICIAN });
    south.record({ entryType: "Condition", patientId: "NT123456", content: { code: "I10" }, ...CLINICIAN });

    assert.deepEqual(north.chart("NT123456").map((e) => JSON.parse(e.content).code), ["E11"]);
    assert.deepEqual(south.chart("NT123456").map((e) => JSON.parse(e.content).code), ["I10"]);
    assert.equal(north.verifyChart("NT123456").checked, 1, "and neither chain counts the other's entries");
    assert.notEqual(north.verifyChart("NT123456").tip, south.verifyChart("NT123456").tip);

    // A record id from one custodian is not addressable from the other.
    const theirs = south.chart("NT123456")[0].record_id;
    assert.equal(north.current(theirs), undefined);
    assert.throws(() => north.amend(theirs, { code: "X" }, { ...CLINICIAN, reason: "reaching" }), /no clinical record/);
  } finally {
    root.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
