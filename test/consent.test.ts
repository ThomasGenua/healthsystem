/**
 * A lockbox that can be opened, loudly.
 *
 * A patient may withhold their record from a provider. Every such directive
 * has to be overridable in an emergency — a patient unconscious in a
 * resuscitation room cannot lift their own lockbox, and a system that made the
 * override impossible would eventually kill somebody, or grow a shared account
 * that everybody uses, which is worse in every respect including the trail.
 *
 * So the safety is not that the override is hard. It is that it is loud, and
 * these tests are about the four things that make it loud: declared before the
 * access, reasoned in words somebody can weigh, the patient told, and somebody
 * reviewing it. Dropping any one turns the other three into paperwork — an
 * override nobody looks at teaches a ward that breaking glass costs nothing,
 * and a directive that costs nothing to break slows down only the people who
 * would have asked permission anyway.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../src/db.ts";
import { ConsentDirectives } from "../src/patient/consent.ts";

const P = "NT123456";
const CLERK = { actorId: "privacy-office", actorKind: "practitioner" };
const ED = { actorId: "dr-hale", actorKind: "practitioner" };
const EXCLUDED = { actorId: "dr-tetso", actorKind: "practitioner" };

function office(overrideHours?: number) {
  const dir = mkdtempSync(join(tmpdir(), "portage-consent-"));
  const db = new Db(join(dir, "portage.db"));
  return {
    db,
    c: new ConsentDirectives(db, overrideHours ? { overrideHours } : {}),
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const GOOD_REASON = "unconscious, no collateral history, need allergy status before induction";

test("a directive withholds from the named provider and nobody else", () => {
  const { c, cleanup } = office();
  try {
    c.record({
      patientId: P,
      kind: "withhold-from-provider",
      targetId: "dr-tetso",
      by: CLERK,
      reason: "former partner works at that practice",
    });

    const refused = c.mayRead({ subjectId: "dr-tetso", patientId: P });
    assert.equal(refused.allowed, false);
    assert.equal(refused.reason, "this record is withheld by a patient directive");
    assert.ok(refused.withheldBy, "and the caller is given the directive, so an override can be offered");

    assert.equal(c.mayRead({ subjectId: "dr-hale", patientId: P }).allowed, true, "and it withholds from one person");
  } finally {
    cleanup();
  }
});

test("the refusal says a directive exists, never what it says", () => {
  // The patient's reason for withholding is between them and whoever recorded
  // it. Disclosing it to the person being withheld from would be an odd way to
  // honour the instruction.
  const { c, cleanup } = office();
  try {
    c.record({
      patientId: P,
      kind: "withhold-from-provider",
      targetId: "dr-tetso",
      by: CLERK,
      reason: "former partner works at that practice",
    });
    const refused = c.mayRead({ subjectId: "dr-tetso", patientId: P });
    assert.ok(!refused.reason.includes("partner"), "the clinician learns that, not why");
    assert.ok(!refused.reason.includes("practice"));
  } finally {
    cleanup();
  }
});

test("breaking glass needs a reason somebody can weigh, not a word", () => {
  // The row is what a privacy office reads when a patient asks who opened
  // their record and why. "Emergency" defends nothing, and a dropdown produces
  // only "emergency".
  const { c, cleanup } = office();
  try {
    c.record({ patientId: P, kind: "withhold-all", by: CLERK });

    assert.throws(() => c.breakGlass({ patientId: P, by: ED, reason: "" }), /not a word/);
    assert.throws(() => c.breakGlass({ patientId: P, by: ED, reason: "emergency" }), /say what you need and why now/);
    assert.equal(c.mayRead({ subjectId: "dr-hale", patientId: P }).allowed, false, "and nothing was opened");
    assert.equal(c.pendingReview().length, 0);

    const bg = c.breakGlass({ patientId: P, by: ED, reason: GOOD_REASON });
    assert.match(bg.reason, /before induction/);
    assert.equal(c.mayRead({ subjectId: "dr-hale", patientId: P }).allowed, true);
  } finally {
    cleanup();
  }
});

test("an override carries the access, and the decision says so", () => {
  const { c, cleanup } = office();
  try {
    const d = c.record({ patientId: P, kind: "withhold-from-provider", targetId: "dr-hale", by: CLERK });
    const bg = c.breakGlass({ patientId: P, by: ED, reason: GOOD_REASON, purposeOfUse: "TREAT" });

    const decision = c.mayRead({ subjectId: "dr-hale", patientId: P });
    assert.equal(decision.allowed, true);
    assert.equal(decision.underBreakGlass?.id, bg.id, "an access under an override is not an ordinary access");
    assert.equal(decision.reason, "emergency override in force");
    assert.equal(bg.directive_id, d.id, "and the override names what it went past");
    assert.equal(bg.purpose_of_use, "TREAT");
  } finally {
    cleanup();
  }
});

test("an override expires; it is an emergency, not a permission", () => {
  const { c, cleanup } = office(4);
  try {
    c.record({ patientId: P, kind: "withhold-all", by: CLERK });
    const bg = c.breakGlass({ patientId: P, by: ED, reason: GOOD_REASON });

    assert.equal(c.mayRead({ subjectId: "dr-hale", patientId: P }).allowed, true);
    const after = new Date(new Date(bg.expires_at).getTime() + 1000).toISOString();
    assert.equal(
      c.mayRead({ subjectId: "dr-hale", patientId: P }, after).allowed,
      false,
      "the lockbox closes again on its own"
    );
  } finally {
    cleanup();
  }
});

test("the patient is told, and the queue does not empty until they are", () => {
  // The part systems quietly omit, and the one that makes a directive mean
  // anything. A lockbox nobody can find out was opened is a lockbox with no
  // lock.
  const { c, cleanup } = office();
  try {
    c.record({ patientId: P, kind: "withhold-all", by: CLERK });
    const bg = c.breakGlass({ patientId: P, by: ED, reason: GOOD_REASON });

    assert.equal(bg.patient_notified_at, null);
    assert.deepEqual(c.pendingNotification().map((r) => r.id), [bg.id]);

    const told = c.notifyPatient(bg.id);
    assert.ok(told.patient_notified_at);
    assert.equal(c.pendingNotification().length, 0);

    // And the patient can see it themselves, which is the other half.
    const theirs = c.overridesFor(P);
    assert.equal(theirs.length, 1);
    assert.equal(theirs[0].subject_id, "dr-hale");
    assert.match(theirs[0].reason, /before induction/);
  } finally {
    cleanup();
  }
});

test("an override waits in a review queue until somebody says what they made of it", () => {
  const { c, cleanup } = office();
  try {
    c.record({ patientId: P, kind: "withhold-all", by: CLERK });
    const bg = c.breakGlass({ patientId: P, by: ED, reason: GOOD_REASON });
    assert.deepEqual(c.pendingReview().map((r) => r.id), [bg.id]);

    assert.throws(() => c.review(bg.id, { ...CLERK, outcome: "" }), /needs an outcome/);
    assert.equal(c.pendingReview().length, 1, "a refusal clears nothing");

    const done = c.review(bg.id, { ...CLERK, outcome: "appropriate; ED attendance confirmed in the record" });
    assert.equal(c.pendingReview().length, 0);
    assert.equal(done.reviewed_by, "privacy-office");
    assert.match(done.review_outcome!, /appropriate/);
    assert.throws(() => c.review(bg.id, { ...CLERK, outcome: "again" }), /already been reviewed/);

    // Reviewing does not extend it: the access window and the paperwork are
    // separate things.
    const after = new Date(new Date(bg.expires_at).getTime() + 1000).toISOString();
    assert.equal(c.mayRead({ subjectId: "dr-hale", patientId: P }, after).allowed, false);
  } finally {
    cleanup();
  }
});

test("breaking glass repeatedly is a pattern, and the pattern is the finding", () => {
  // One override is a clinical emergency. Forty in a month is a workflow that
  // has decided the directive is an obstacle, and only the count shows it.
  const { c, cleanup } = office();
  try {
    c.record({ patientId: P, kind: "withhold-all", by: CLERK });
    c.record({ patientId: "NT2", kind: "withhold-all", by: CLERK });
    c.record({ patientId: "NT3", kind: "withhold-all", by: CLERK });

    for (const p of [P, "NT2", "NT3"]) c.breakGlass({ patientId: p, by: ED, reason: GOOD_REASON });
    c.breakGlass({ patientId: P, by: EXCLUDED, reason: GOOD_REASON });

    const frequent = c.frequentBreakers("2000-01-01T00:00:00Z", 3);
    assert.deepEqual(
      frequent.map((f) => [f.subject_id, f.n]),
      [["dr-hale", 3]],
      "three from one person, once from another"
    );
    assert.equal(c.frequentBreakers("2000-01-01T00:00:00Z", 5).length, 0);
    assert.equal(c.pendingReview().length, 4, "and every one of them is still owed a look");
  } finally {
    cleanup();
  }
});

test("a directive narrowed to some entry types does not withhold the rest", () => {
  // Applying it to everything would give the patient more than they asked for,
  // which is its own kind of not listening.
  const { c, cleanup } = office();
  try {
    c.record({
      patientId: P,
      kind: "withhold-all",
      scope: ["DocumentReference"],
      by: CLERK,
      reason: "counselling notes only",
    });

    assert.equal(c.mayRead({ subjectId: "dr-tetso", patientId: P, entryType: "DocumentReference" }).allowed, false);
    assert.equal(c.mayRead({ subjectId: "dr-tetso", patientId: P, entryType: "AllergyIntolerance" }).allowed, true);

    // A read that names no type is a read that may return any type, so the
    // narrowed directive applies to it. This used to assert that such a read
    // was "not the withheld one", which sounds reasonable until you notice
    // that the only caller in the system — `phi()` — names no type. Every
    // scoped directive therefore withheld nothing over HTTP: the patient
    // locked their counselling notes and GET /api/clinical/chart served them
    // with a 200. Proven at the boundary in test/clinical-api.test.ts, which
    // is where it was invisible.
    assert.equal(
      c.mayRead({ subjectId: "dr-tetso", patientId: P }).allowed,
      false,
      "a read that cannot say which type it is reading may return the withheld one"
    );
  } finally {
    cleanup();
  }
});

test("a directive can be withheld from an organization rather than a person", () => {
  const { c, cleanup } = office();
  try {
    c.record({ patientId: P, kind: "withhold-from-organization", targetId: "yk-clinic", by: CLERK });

    assert.equal(c.mayRead({ subjectId: "anyone", organizationId: "yk-clinic", patientId: P }).allowed, false);
    assert.equal(c.mayRead({ subjectId: "anyone", organizationId: "stanton", patientId: P }).allowed, true);

    // A caller that does not say which organization it speaks for is withheld
    // from, rather than let through. This used to assert the opposite, and the
    // consequence was that the directive was enforced by nothing at all: no
    // Principal carries an organization, so `phi()` had none to pass, so
    // `undefined === "yk-clinic"` was false on every request and the record
    // was served to the organization the patient had excluded — while
    // GET /api/clinical/directives went on reporting the directive as active.
    //
    // Withholding from a caller that cannot identify itself is the wrong
    // answer for a caller that is in fact some third organization. It is the
    // recoverable wrong answer: they see that a directive exists and can break
    // glass through it in seconds, loudly and on the record. The other wrong
    // answer is silent and permanent.
    assert.equal(
      c.mayRead({ subjectId: "anyone", patientId: P }).allowed,
      false,
      "a caller that cannot say it is outside the withheld organization is not assumed to be"
    );

    assert.throws(
      () => c.record({ patientId: P, kind: "withhold-from-organization", by: CLERK }),
      /needs somebody to withhold from/
    );
  } finally {
    cleanup();
  }
});

test("a directive the patient revoked, or that expired, stops applying", () => {
  const { c, cleanup } = office();
  try {
    const d = c.record({ patientId: P, kind: "withhold-from-provider", targetId: "dr-tetso", by: CLERK });
    assert.equal(c.mayRead({ subjectId: "dr-tetso", patientId: P }).allowed, false);

    c.revoke(d.id, CLERK);
    assert.equal(c.mayRead({ subjectId: "dr-tetso", patientId: P }).allowed, true, "their instruction, their revocation");
    assert.equal(c.directivesFor(P).length, 0);
    assert.throws(() => c.revoke(d.id, CLERK), /already revoked/);

    const soon = new Date(Date.now() + 86_400_000).toISOString();
    const later = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const timed = c.record({
      patientId: P,
      kind: "withhold-from-provider",
      targetId: "dr-hale",
      by: CLERK,
      expiresAt: soon,
    });
    assert.equal(c.mayRead({ subjectId: "dr-hale", patientId: P }).allowed, false, "in force today");
    assert.equal(c.mayRead({ subjectId: "dr-hale", patientId: P }, later).allowed, true, "and lapsed the day after");
    assert.equal(c.directive(timed.id)!.status, "active", "expiry is by the clock, not by a sweep changing a status");

    // And one dated to start later does not apply before it starts, which is
    // the other end of the same property.
    const future = c.record({
      patientId: "NT2",
      kind: "withhold-all",
      by: CLERK,
      effectiveFrom: later,
    });
    assert.equal(c.mayRead({ subjectId: "anyone", patientId: "NT2" }).allowed, true);
    assert.equal(
      c.mayRead({ subjectId: "anyone", patientId: "NT2" }, new Date(Date.now() + 3 * 86_400_000).toISOString()).allowed,
      false
    );
    assert.ok(future.id);
  } finally {
    cleanup();
  }
});

test("breaking glass where there is no directive is still recorded", () => {
  // A clinician who declares an emergency on a record nobody withheld has
  // still declared one, and the declaration is the thing worth keeping: it is
  // how "I did not realise there was no lockbox" is told apart from a habit.
  const { c, cleanup } = office();
  try {
    const bg = c.breakGlass({ patientId: P, by: ED, reason: GOOD_REASON });
    assert.equal(bg.directive_id, null);
    assert.equal(c.pendingReview().length, 1);
    assert.equal(c.pendingNotification().length, 1, "and the patient is told about that too");
  } finally {
    cleanup();
  }
});

test("directives and overrides are confined to their tenant", () => {
  const dir = mkdtempSync(join(tmpdir(), "portage-consent-iso-"));
  const root = new Db(join(dir, "portage.db"));
  try {
    root.createTenant("north", "Northern Health");
    root.createTenant("south", "Southern Health");
    const north = new ConsentDirectives(root.forTenant("north"));
    const south = new ConsentDirectives(root.forTenant("south"));

    north.record({ patientId: P, kind: "withhold-from-provider", targetId: "dr-tetso", by: CLERK });
    const bg = north.breakGlass({ patientId: P, by: ED, reason: GOOD_REASON });

    assert.equal(north.mayRead({ subjectId: "dr-tetso", patientId: P }).allowed, false);
    assert.equal(
      south.mayRead({ subjectId: "dr-tetso", patientId: P }).allowed,
      true,
      "a directive at one custodian does not withhold another custodian's record"
    );
    assert.equal(south.directivesFor(P).length, 0);
    assert.equal(south.override(bg.id), undefined);
    assert.equal(south.pendingReview().length, 0);
    assert.equal(north.pendingReview().length, 1);
    assert.equal(south.overridesFor(P).length, 0);
  } finally {
    root.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
