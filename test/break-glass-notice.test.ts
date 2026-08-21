/**
 * Sending the notice, rather than recording that somebody owes one.
 *
 * The queue was real and it was thin: `pendingNotification()` listed patients
 * an operator owed a phone call, and nothing sent anything. The argument for a
 * lockbox being survivable in a clinical setting rests on the override being
 * loud, and a queue that depends on somebody working through it every day is
 * loud only for as long as somebody does.
 *
 * What these check is the part that is easy to get wrong in the safe-looking
 * direction: that a dispatch failure is visible rather than silent, that it
 * never blocks the override, and that nobody is told twice.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { Db } from "../src/db.ts";
import { Engine } from "../src/core/engine.ts";
import { ConsentDirectives, type BreakGlassNotice, type NoticeDispatcher } from "../src/patient/consent.ts";
import { ChannelNoticeDispatcher, type NoticePayload } from "../src/patient/notice.ts";
import { MedicationStore } from "../src/meds/store.ts";

const P = "NT880042";
const ED = { actorId: "dr-hale", actorKind: "practitioner" };
const REASON = "unresponsive on arrival, no collateral history, need the allergy list before induction";

const CHANNEL = JSON.stringify({
  id: "patient-notices",
  name: "Patient notices",
  source: { type: "http", path: "notices" },
  destinations: [],
});

function withChannel(): Db {
  const db = new Db(":memory:");
  db.upsertChannel("patient-notices", "Patient notices", true, CHANNEL);
  return db;
}

test("breaking glass publishes the notice, and says which message it became", () => {
  const db = withChannel();
  try {
    const consent = new ConsentDirectives(db, { dispatcher: new ChannelNoticeDispatcher(db, "patient-notices") });
    const bg = consent.breakGlass({ patientId: P, by: ED, reason: REASON });

    assert.ok(bg.notice_dispatched_at, "the notice was handed to the delivery machinery");
    assert.ok(bg.notice_message_id, "and it names the message it became");
    assert.equal(bg.notice_error, null);

    // "We sent it" is not "we know they were told". The override is still owed
    // an acknowledgement and is still on the queue.
    assert.equal(bg.patient_notified_at, null);
    assert.equal(consent.pendingNotification().length, 1);

    const message = db.getMessage(bg.notice_message_id!);
    const payload = JSON.parse(message!.raw) as NoticePayload;
    assert.equal(payload.type, "break-glass-notice");
    assert.equal(payload.patientId, P);
    assert.equal(payload.accessedBy.id, "dr-hale");
    assert.equal(payload.reason, REASON);
    assert.match(payload.summary, /accessed on .* under an emergency override/);
  } finally {
    db.close();
  }
});

test("the notice carries the fact and none of the record", () => {
  // A disclosure notice that leaked the chart while announcing the chart had
  // been read would be self-defeating.
  //
  // Note what is *not* forbidden: the clinician's reason, quoted verbatim,
  // which may well mention what they needed ("the allergy list"). That is the
  // clinician's own justification and the patient is entitled to read it — it
  // is the part that lets them judge whether the override was warranted. What
  // must not appear is anything from the chart itself.
  const db = withChannel();
  try {
    const meds = new MedicationStore(db);
    meds.recordAllergy({
      patientId: P,
      display: "Penicillin",
      ingredient: "penicillin",
      criticality: "high",
      by: ED,
    });

    const consent = new ConsentDirectives(db, { dispatcher: new ChannelNoticeDispatcher(db, "patient-notices") });
    const bg = consent.breakGlass({ patientId: P, by: ED, reason: REASON });
    const raw = db.getMessage(bg.notice_message_id!)!.raw;

    // The thing actually in this patient's record, which is the thing the
    // notice must not disclose while announcing that it was read.
    assert.ok(!raw.toLowerCase().includes("penicillin"), "the notice must not carry what the chart says");

    // And the payload is exactly the documented shape — no chart fields have
    // been added to it since.
    const payload = JSON.parse(raw) as NoticePayload;
    assert.deepEqual(Object.keys(payload).sort(), [
      "accessedBy",
      "declaredAt",
      "directiveId",
      "expiresAt",
      "overrideId",
      "patientId",
      "reason",
      "summary",
      "type",
    ]);
    assert.ok(payload.declaredAt && payload.expiresAt && payload.overrideId);
  } finally {
    db.close();
  }
});

test("a notice that cannot be sent is a visible failure, not a silent one", () => {
  // The failure this whole issue is about, one layer down: a notification that
  // fails quietly is the same defect as a queue nobody drains.
  const db = new Db(":memory:");
  try {
    // No channel of that name, which is what a misconfigured deployment or a
    // channel deleted while the engine ran both look like.
    const consent = new ConsentDirectives(db, { dispatcher: new ChannelNoticeDispatcher(db, "missing") });
    const bg = consent.breakGlass({ patientId: P, by: ED, reason: REASON });

    assert.equal(bg.notice_dispatched_at, null);
    assert.match(bg.notice_error ?? "", /no channel 'missing'/);

    const undelivered = consent.undeliveredNotices();
    assert.equal(undelivered.length, 1);
    assert.equal(undelivered[0].id, bg.id);
  } finally {
    db.close();
  }
});

test("a dispatch failure never stops somebody breaking glass", () => {
  // The safety valve must not depend on the notification queue being
  // reachable. A clinician standing over an unconscious patient being refused
  // because a message broker is down is the failure mode that gets a shared
  // login created, which is worse in every respect including the audit trail.
  const db = new Db(":memory:");
  try {
    const exploding: NoticeDispatcher = {
      dispatch(): string {
        throw new Error("broker unreachable");
      },
    };
    const consent = new ConsentDirectives(db, { dispatcher: exploding });
    const bg = consent.breakGlass({ patientId: P, by: ED, reason: REASON });

    assert.ok(bg.id, "the override stands");
    assert.equal(consent.mayRead({ subjectId: ED.actorId, patientId: P }).allowed, true);
    assert.match(bg.notice_error ?? "", /broker unreachable/);
  } finally {
    db.close();
  }
});

test("a failed notice can be retried, and a sent one is never sent twice", () => {
  // Telling a patient twice that their record was opened is its own small
  // harm, and a retry loop that duplicates disclosures is worse than one that
  // gives up.
  const db = new Db(":memory:");
  try {
    let attempts = 0;
    const flaky: NoticeDispatcher = {
      dispatch(n: BreakGlassNotice): string {
        attempts++;
        if (attempts === 1) throw new Error("broker unreachable");
        return `msg-for-${n.overrideId}`;
      },
    };
    const consent = new ConsentDirectives(db, { dispatcher: flaky });
    const bg = consent.breakGlass({ patientId: P, by: ED, reason: REASON });
    assert.equal(bg.notice_dispatched_at, null, "first attempt failed");

    const retried = consent.dispatchNotice(bg.id);
    assert.ok(retried.notice_dispatched_at);
    assert.equal(retried.notice_error, null, "the old failure is cleared, not left to confuse an operator");
    assert.equal(attempts, 2);

    consent.dispatchNotice(bg.id);
    consent.dispatchNotice(bg.id);
    assert.equal(attempts, 2, "an already-sent notice is not sent again");
  } finally {
    db.close();
  }
});

test("with no dispatcher configured, nothing changes", () => {
  // A site that has not configured a destination is not pretending to send
  // anything, and its queue behaves exactly as it did before.
  const db = new Db(":memory:");
  try {
    const consent = new ConsentDirectives(db);
    const bg = consent.breakGlass({ patientId: P, by: ED, reason: REASON });

    assert.equal(bg.notice_dispatched_at, null);
    assert.equal(bg.notice_error, null, "not an error — there is nothing configured to send with");
    assert.equal(consent.pendingNotification().length, 1);
  } finally {
    db.close();
  }
});

test("an override nobody has acted on is overdue, and says so", () => {
  // The queue had no upper bound on how long a patient could go untold.
  const db = new Db(":memory:");
  try {
    const consent = new ConsentDirectives(db);
    const bg = consent.breakGlass({ patientId: P, by: ED, reason: REASON });

    assert.equal(consent.overdueNotification(24).length, 0, "not overdue yet");

    const twoDaysOn = new Date(Date.now() + 48 * 3_600_000).toISOString();
    const late = consent.overdueNotification(24, twoDaysOn);
    assert.equal(late.length, 1);
    assert.equal(late[0].id, bg.id);

    // Telling the patient takes it off the escalation, which is the only thing
    // that should — dispatching alone does not, because sent is not told.
    consent.notifyPatient(bg.id);
    assert.equal(consent.overdueNotification(24, twoDaysOn).length, 0);
  } finally {
    db.close();
  }
});

test("the engine wires a dispatcher when a deployment names a channel", async () => {
  // End to end through the real construction path, because a collaborator that
  // works in a unit test and is never wired is the shape of bug this codebase
  // has been finding all week.
  const engine = new Engine({ dbPath: ":memory:", tickMs: 15, breakGlassNoticeChannel: "patient-notices" });
  await engine.start();
  try {
    const t = engine.forTenant("default");
    t.db.upsertChannel("patient-notices", "Patient notices", true, CHANNEL);

    const bg = t.consent.breakGlass({ patientId: P, by: ED, reason: REASON });
    assert.ok(bg.notice_dispatched_at, "the engine's consent store dispatches");
    assert.ok(bg.notice_message_id);
  } finally {
    await engine.stop();
  }
});
