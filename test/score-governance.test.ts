/**
 * Permission to use a score, as distinct from the arithmetic being right.
 *
 * `scores.ts` computes correctly and `score-invariants.test.ts` proves the
 * shape holds. Neither says anybody may act on the number. An instrument
 * derived in one population, implemented from a paper and never looked at by
 * anyone accountable at this site is a calculator — and a calculator wired
 * into a chart, returning a band and an interpretation, is indistinguishable
 * at the point of care from a decision somebody stands behind.
 *
 * So the default is off, and the first test here is that the empty table is
 * the safe state rather than an unconfigured one. The rest are the ways an
 * approval can stop being one: it expires, the arithmetic changes underneath
 * it, its owner leaves, or somebody withdraws it. Each disables the score,
 * and none of them clears itself.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../src/db.ts";
import { Directory } from "../src/directory/store.ts";
import { ScoreGovernance } from "../src/clinical/score-governance.ts";
import { SCORE_IDS } from "../src/clinical/score-definitions.ts";
import { Refusal } from "../src/core/refusal.ts";

const OPS = { id: "ops-lachance", kind: "apikey" };
const FUTURE = "2027-06-30";

function site() {
  const dir = mkdtempSync(join(tmpdir(), "northstar-gov-"));
  const db = new Db(join(dir, "northstar.db"));
  const directory = new Directory(db);
  directory.addPractitioner({ id: "dr-tetso", family: "Tetso", given: "Jean" });
  return {
    db,
    directory,
    gov: new ScoreGovernance(db),
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}

const approve = (s: ReturnType<typeof site>, over: Record<string, unknown> = {}) =>
  s.gov.approve({
    scoreId: "curb-65",
    clinicalOwnerId: "dr-tetso",
    reviewDue: FUTURE,
    reason: "reviewed against the published instrument by the medical director",
    by: OPS,
    ...over,
  } as Parameters<ScoreGovernance["approve"]>[0]);

// ── The default ───────────────────────────────────────────────────────────

test("every score is disabled before anybody says otherwise", () => {
  const s = site();
  try {
    for (const id of SCORE_IDS) {
      const state = s.gov.state(id);
      assert.equal(state.status, "never-approved", `${id} should start unapproved`);
      assert.equal(state.enabled, false, `${id} should start disabled`);
      assert.equal(state.approval, null);
    }
    assert.equal(s.gov.all().filter((x) => x.enabled).length, 0, "no score is enabled on an empty table");
  } finally {
    s.cleanup();
  }
});

test("the gate throws rather than returning false, so a forgotten check cannot serve a number", () => {
  const s = site();
  try {
    assert.throws(
      () => s.gov.require("news2"),
      (err: unknown) => err instanceof Refusal && err.status === 403 && /not approved for use here/.test(err.message),
    );
  } finally {
    s.cleanup();
  }
});

// ── Recording a decision ──────────────────────────────────────────────────

test("an approval names the instrument, the owner, the operator and the review date", () => {
  const s = site();
  try {
    const row = approve(s);
    assert.equal(row.scoreId, "curb-65");
    assert.equal(row.decision, "approved");
    assert.equal(row.clinicalOwnerId, "dr-tetso");
    // A readable snapshot, so the record stays legible after the directory changes.
    assert.equal(row.clinicalOwnerDisplay, "Jean Tetso");
    assert.equal(row.reviewDue, FUTURE);
    // The operator who typed it is not the clinician who owns it.
    assert.equal(row.recordedBy.id, "ops-lachance");
    assert.notEqual(row.recordedBy.id, row.clinicalOwnerId);
    assert.equal(row.supersedes, null, "the first decision supersedes nothing");
    assert.ok(row.implementationVersion, "the decision records which arithmetic it was about");

    assert.equal(s.gov.state("curb-65").status, "current");
    assert.equal(s.gov.enabled("curb-65"), true);
    // And only that one.
    assert.deepEqual(s.gov.all().filter((x) => x.enabled).map((x) => x.scoreId), ["curb-65"]);
  } finally {
    s.cleanup();
  }
});

test("nothing can be approved without a written reason, an owner and a review date", () => {
  const s = site();
  try {
    assert.throws(() => approve(s, { reason: "ok" }), /written reason of at least 12 characters/);
    assert.throws(() => approve(s, { reason: "" }), /written reason/);
    assert.throws(() => approve(s, { clinicalOwnerId: "" }), /requires the practitioner who owns it/);
    assert.throws(() => approve(s, { reviewDue: "" }), /requires an explicit review date/);
    assert.throws(() => approve(s, { reviewDue: "soon" }), /requires an explicit review date/);
    // Nothing was recorded by any of those attempts.
    assert.equal(s.gov.state("curb-65").status, "never-approved");
    assert.equal(s.gov.history("curb-65").length, 0);
  } finally {
    s.cleanup();
  }
});

test("a review date is never computed, only supplied", () => {
  const s = site();
  try {
    const row = approve(s, { reviewDue: "2026-11-05" });
    assert.equal(row.reviewDue, "2026-11-05", "the date recorded is the date given, not a default interval");
  } finally {
    s.cleanup();
  }
});

test("a clinical owner must be a practitioner the directory holds and has not retired", () => {
  const s = site();
  try {
    assert.throws(() => approve(s, { clinicalOwnerId: "dr-nobody" }), /no practitioner dr-nobody in the directory/);

    s.directory.addPractitioner({ id: "dr-gone", family: "Gone", given: "Pat" });
    s.directory.retire("practitioner", "dr-gone");
    assert.throws(() => approve(s, { clinicalOwnerId: "dr-gone" }), /retired.*cannot own a live approval/s);

    assert.equal(s.gov.state("curb-65").status, "never-approved");
  } finally {
    s.cleanup();
  }
});

// ── The ways an approval stops being one ──────────────────────────────────

test("an approval past its review date disables the score, and does not renew itself", () => {
  const s = site();
  try {
    approve(s, { reviewDue: "2026-09-01" });
    const before = new Date("2026-08-25T00:00:00.000Z");
    assert.equal(s.gov.state("curb-65", { asOf: before }).status, "expiring");
    assert.equal(s.gov.enabled("curb-65", before), true);

    const after = new Date("2026-09-02T00:00:00.000Z");
    const expired = s.gov.state("curb-65", { asOf: after });
    assert.equal(expired.status, "expired");
    assert.equal(expired.enabled, false);
    assert.match(expired.detail, /Nothing renews on its own/);

    // Reading the state repeatedly, and asking for the expiring report, must
    // not quietly extend anything.
    s.gov.expiring(30, after);
    s.gov.all({ asOf: after });
    assert.equal(s.gov.state("curb-65", { asOf: after }).status, "expired");
    assert.equal(s.gov.history("curb-65").length, 1, "reading never writes a decision");
  } finally {
    s.cleanup();
  }
});

test("expiring reports what is already past as well as what is due soon", () => {
  const s = site();
  try {
    approve(s, { scoreId: "curb-65", reviewDue: "2026-09-10" });
    approve(s, { scoreId: "news2", reviewDue: "2026-08-01" });
    approve(s, { scoreId: "lace", reviewDue: "2030-01-01" });

    const asOf = new Date("2026-09-01T00:00:00.000Z");
    const due = s.gov.expiring(30, asOf);
    const byId = Object.fromEntries(due.map((d) => [d.scoreId, d.status]));
    assert.equal(byId["curb-65"], "expiring", "nine days out is due soon");
    assert.equal(byId["news2"], "expired", "a month past is expired");
    assert.equal(byId["lace"], undefined, "years out is not reported");

    // A narrower window excludes the one that is merely approaching, but never
    // the one already past: an expired approval is not less urgent close up.
    const narrow = s.gov.expiring(3, asOf).map((d) => d.scoreId);
    assert.ok(!narrow.includes("curb-65"));
    assert.ok(narrow.includes("news2"));

    assert.throws(() => s.gov.expiring(-1, asOf), /whole number of days/);
  } finally {
    s.cleanup();
  }
});

test("an approval does not survive the arithmetic changing underneath it", () => {
  const s = site();
  try {
    approve(s);
    assert.equal(s.gov.state("curb-65").status, "current");

    // The decision was about one implementation; the code now runs another.
    s.db.sql
      .prepare("UPDATE score_approvals SET implementation_version = ? WHERE tenant_id = ? AND score_id = ?")
      .run("portage-0", "default", "curb-65");

    const state = s.gov.state("curb-65");
    assert.equal(state.status, "version-mismatch");
    assert.equal(state.enabled, false);
    assert.match(state.detail, /arithmetic has changed since anybody looked at it/);
  } finally {
    s.cleanup();
  }
});

test("disabling requires a reason, and supersedes the approval without erasing it", () => {
  const s = site();
  try {
    const first = approve(s);
    assert.throws(() => s.gov.disable({ scoreId: "curb-65", reason: "no", by: OPS }), /written reason/);

    const off = s.gov.disable({
      scoreId: "curb-65",
      reason: "withdrawn pending review of the urea threshold",
      by: OPS,
    });
    assert.equal(off.decision, "disabled");
    assert.equal(off.supersedes, first.id, "the withdrawal points at what it replaced");
    assert.equal(s.gov.state("curb-65").status, "disabled");
    assert.equal(s.gov.enabled("curb-65"), false);

    // Append-only: the approval is still on the record, so "who allowed this,
    // and what did they know" survives the reversal.
    const history = s.gov.history("curb-65");
    assert.equal(history.length, 2);
    assert.equal(history[1].id, first.id);
    assert.equal(history[1].decision, "approved");
  } finally {
    s.cleanup();
  }
});

test("a disabled score comes back only by a new decision, which supersedes the withdrawal", () => {
  const s = site();
  try {
    approve(s);
    s.gov.disable({ scoreId: "curb-65", reason: "withdrawn while the threshold is checked", by: OPS });
    const again = approve(s, { reason: "threshold confirmed against the source; returned to use" });
    assert.equal(s.gov.state("curb-65").status, "current");
    assert.equal(s.gov.history("curb-65").length, 3);
    assert.equal(again.supersedes, s.gov.history("curb-65")[1].id);
  } finally {
    s.cleanup();
  }
});

// ── Tenancy ───────────────────────────────────────────────────────────────

test("one site's approval does not enable another site's score", () => {
  const s = site();
  try {
    approve(s);
    assert.equal(s.gov.enabled("curb-65"), true);

    const other = new ScoreGovernance(s.db.forTenant("yellowknife"));
    assert.equal(other.state("curb-65").status, "never-approved");
    assert.equal(other.enabled("curb-65"), false);
    assert.equal(other.history("curb-65").length, 0);
    assert.throws(() => other.require("curb-65"), (e: unknown) => e instanceof Refusal && e.status === 403);
  } finally {
    s.cleanup();
  }
});

test("a clinical owner from another tenant's directory is not a clinical owner here", () => {
  const s = site();
  try {
    const other = s.db.forTenant("yellowknife");
    new Directory(other).addPractitioner({ id: "dr-elsewhere", family: "Elsewhere", given: "Sam" });
    assert.throws(() => approve(s, { clinicalOwnerId: "dr-elsewhere" }), /no practitioner dr-elsewhere in the directory/);
  } finally {
    s.cleanup();
  }
});
