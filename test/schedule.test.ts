/**
 * A slot belongs to one patient, and a missed appointment is not the end.
 *
 * Two failures, unrelated except that both are ways a schedule quietly breaks.
 *
 * The first is double-booking. Check-then-insert cannot prevent it: between
 * reading "free" and writing "booked" another booking fits, and the window is
 * exactly as wide as the gap between two statements. Under a real clinic — two
 * clerks, a portal and an inbound SIU feed on one diary — that window is hit,
 * and the failure is discovered in the waiting room. The load-bearing test
 * below therefore bypasses the store's own check entirely, because a guarantee
 * that only holds when callers behave is not a guarantee.
 *
 * The second is the missed appointment nobody picks up. For a routine review,
 * marking did-not-attend and closing the record is right. For the patient who
 * missed the appointment answering an urgent referral it is a catastrophe with
 * no error attached: the referral reads booked, the clinic's list is clear,
 * and nobody is waiting for anything.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Db } from "../src/db.ts";
import { Schedule, SlotFull } from "../src/schedule/store.ts";
import { an } from "../src/core/text.ts";

const CLERK = { actorId: "booking-clerk", actorKind: "practitioner" };
const NURSE = { actorId: "rn-blondin", actorKind: "practitioner" };
const P1 = "NT123456";
const P2 = "NT999999";

function clinic() {
  const dir = mkdtempSync(join(tmpdir(), "portage-sched-"));
  const db = new Db(join(dir, "portage.db"));
  return {
    db,
    s: new Schedule(db),
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const MORNING = { resourceId: "dr-tetso", service: "General practice", startsAt: "2026-07-01T09:00:00Z", endsAt: "2026-07-01T09:15:00Z" };

test("the database refuses a second booking on a seat, whatever the caller does", () => {
  // The load-bearing test. It goes around book() entirely and writes the row
  // a racing second process would write — because a guarantee enforced only
  // by the code path that checks is not enforced at all.
  const { db, s, cleanup } = clinic();
  try {
    const slot = s.openSlot(MORNING);
    const first = s.book({ slotId: slot.id, patientId: P1, reason: "Knee review", by: CLERK });
    assert.equal(first.seat, 0);

    const raw = () =>
      db.sql
        .prepare(
          `INSERT INTO schedule_bookings
             (tenant_id, id, slot_id, patient_id, seat, status, reason, priority, booked_by, booked_at, created_at)
           VALUES ('default', ?, ?, ?, 0, 'booked', 'raced in', 'routine', 'other-clerk', '2026-06-01', '2026-06-01')`
        )
        .run(randomUUID(), slot.id, P2);

    assert.throws(raw, /UNIQUE constraint failed/, "the index is the guarantee, not the check above it");
    assert.equal(s.liveBookings(slot.id).length, 1);
    assert.equal(s.liveBookings(slot.id)[0].patient_id, P1);

    // And through the API it is a clear refusal rather than a constraint error.
    assert.throws(() => s.book({ slotId: slot.id, patientId: P2, reason: "Also knee", by: CLERK }), SlotFull);
  } finally {
    cleanup();
  }
});

test("cancelling frees the seat and keeps the record", () => {
  // Not deleted. A pattern of cancellations is made of exactly these rows —
  // for the clinic, and sometimes for the patient, whose repeated
  // cancellations are a clinical signal rather than an administrative one.
  const { db, s, cleanup } = clinic();
  try {
    const slot = s.openSlot(MORNING);
    const first = s.book({ slotId: slot.id, patientId: P1, reason: "Knee review", by: CLERK });

    assert.throws(() => s.cancel(first.id, { ...CLERK, reason: "" }), /needs a reason/);
    assert.equal(s.liveBookings(slot.id).length, 1, "the refusal freed nothing");

    s.cancel(first.id, { ...CLERK, reason: "patient rebooking after holiday" });
    assert.equal(s.liveBookings(slot.id).length, 0);
    assert.equal((db.sql.prepare("SELECT COUNT(*) AS n FROM schedule_bookings").get() as { n: number }).n, 1);

    const second = s.book({ slotId: slot.id, patientId: P2, reason: "Chest pain", by: CLERK });
    assert.equal(second.seat, 0, "the freed seat is reusable");
    assert.equal(s.forPatient(P1).length, 0, "and a cancelled appointment is not one the patient is coming to");
    assert.equal(s.forPatient(P1, { includeCancelled: true }).length, 1);
    assert.throws(() => s.cancel(first.id, { ...CLERK, reason: "again" }), /a cancelled booking cannot be cancelled/);
  } finally {
    cleanup();
  }
});

test("overbooking is a number somebody chose, not a constraint defeated", () => {
  // Real clinical practice. A scheduler that makes it impossible is one that
  // gets routed around, and a clinic overbooking in a paper diary is worse
  // off than one overbooking here.
  const { s, cleanup } = clinic();
  try {
    const slot = s.openSlot({ ...MORNING, capacity: 2 });
    const a = s.book({ slotId: slot.id, patientId: P1, reason: "Review", by: CLERK });
    const b = s.book({ slotId: slot.id, patientId: P2, reason: "Review", by: CLERK });

    assert.deepEqual([a.seat, b.seat], [0, 1]);
    assert.throws(() => s.book({ slotId: slot.id, patientId: "NT3", reason: "Review", by: CLERK }), SlotFull);
    assert.equal(s.available({ service: "General practice" }).length, 0, "and a full slot is not offered");

    s.cancel(a.id, { ...CLERK, reason: "patient unwell" });
    assert.equal(s.available({ service: "General practice" }).length, 1, "one seat back, so the slot is offered again");
    assert.equal(s.book({ slotId: slot.id, patientId: "NT3", reason: "Review", by: CLERK }).seat, 0);
  } finally {
    cleanup();
  }
});

test("a missed urgent appointment is work, not a status", () => {
  // The second failure. Nothing errors: the referral reads booked, the
  // clinic's list is clear, and nobody is waiting for anything.
  const { s, cleanup } = clinic();
  try {
    const routineSlot = s.openSlot(MORNING);
    const urgentSlot = s.openSlot({ ...MORNING, startsAt: "2026-07-01T09:15:00Z", endsAt: "2026-07-01T09:30:00Z" });
    const referralSlot = s.openSlot({ ...MORNING, startsAt: "2026-07-01T09:30:00Z", endsAt: "2026-07-01T09:45:00Z" });

    const routine = s.book({ slotId: routineSlot.id, patientId: P1, reason: "Annual review", by: CLERK });
    const urgent = s.book({ slotId: urgentSlot.id, patientId: P2, reason: "Two-week wait", by: CLERK, priority: "urgent" });
    const answering = s.book({
      slotId: referralSlot.id,
      patientId: "NT3",
      reason: "Nephrology first appointment",
      by: CLERK,
      referralId: "ref-1",
    });

    const r = s.didNotAttend(routine.id, NURSE);
    assert.equal(r.followUpRequired, false, "a missed annual review is administrative");
    assert.equal(r.because, null);

    const u = s.didNotAttend(urgent.id, NURSE);
    assert.equal(u.followUpRequired, true);
    assert.match(u.because!, /an urgent appointment was missed/);

    const a = s.didNotAttend(answering.id, NURSE);
    assert.equal(a.followUpRequired, true);
    assert.match(a.because!, /answers a referral, which is still open and now has nothing booked against it/);

    const owed = s.unresolvedNonAttendance();
    assert.deepEqual(owed.map((b) => b.id).sort(), [urgent.id, answering.id].sort());
    assert.equal(owed[0].priority, "urgent", "worst first: a missed urgent appointment gets less recoverable weekly");
  } finally {
    cleanup();
  }
});

test("a missed appointment leaves the list only when somebody says what they did", () => {
  const { s, cleanup } = clinic();
  try {
    const slot = s.openSlot(MORNING);
    const b = s.book({ slotId: slot.id, patientId: P1, reason: "Two-week wait", by: CLERK, priority: "urgent" });
    s.didNotAttend(b.id, NURSE);
    assert.equal(s.unresolvedNonAttendance().length, 1);

    assert.throws(() => s.resolveNonAttendance(b.id, { ...NURSE, action: "" }), /needs to say what was done/);
    assert.equal(s.unresolvedNonAttendance().length, 1, "and a refusal clears nothing");

    s.resolveNonAttendance(b.id, { ...NURSE, action: "Telephoned, rebooked for 8 July, GP informed" });
    assert.equal(s.unresolvedNonAttendance().length, 0);
    assert.match(s.history(b.id).at(-1)!.detail!, /rebooked for 8 July/);
  } finally {
    cleanup();
  }
});

test("attending closes the booking and does not appear as owed", () => {
  const { s, cleanup } = clinic();
  try {
    const slot = s.openSlot(MORNING);
    const b = s.book({ slotId: slot.id, patientId: P1, reason: "Two-week wait", by: CLERK, priority: "urgent" });
    s.attended(b.id, NURSE);

    assert.equal(s.booking(b.id)!.status, "attended");
    assert.equal(s.unresolvedNonAttendance().length, 0);
    assert.throws(() => s.didNotAttend(b.id, NURSE), /an attended booking cannot be marked did-not-attend/);
    assert.throws(() => s.cancel(b.id, { ...NURSE, reason: "late" }), /an attended booking cannot be cancelled/);
    assert.equal(s.liveBookings(slot.id).length, 1, "and an attended booking still holds its seat");
  } finally {
    cleanup();
  }
});

test("a booking needs a reason, and a slot must end after it starts", () => {
  const { s, cleanup } = clinic();
  try {
    assert.throws(() => s.openSlot({ ...MORNING, endsAt: MORNING.startsAt }), /must end after it starts/);
    assert.throws(() => s.openSlot({ ...MORNING, capacity: 0 }), /positive whole number/);

    const slot = s.openSlot(MORNING);
    assert.throws(
      () => s.book({ slotId: slot.id, patientId: P1, reason: "  ", by: CLERK }),
      /a list that has to be cut cannot be triaged without one/
    );
    assert.equal(s.liveBookings(slot.id).length, 0);
    assert.throws(() => s.book({ slotId: "nope", patientId: P1, reason: "x", by: CLERK }), /no slot nope/);
  } finally {
    cleanup();
  }
});

test("a blocked slot is not bookable and is not deleted", () => {
  // Leave, a meeting, a scanner down. A slot that exists and must not be
  // booked is different from one that does not exist: deleting it loses the
  // fact that the clinic was supposed to be running.
  const { s, cleanup } = clinic();
  try {
    const slot = s.openSlot(MORNING);
    assert.throws(() => s.blockSlot(slot.id, ""), /needs a reason/);

    s.blockSlot(slot.id, "study leave");
    assert.throws(() => s.book({ slotId: slot.id, patientId: P1, reason: "Review", by: CLERK }), /is blocked: study leave/);
    assert.equal(s.available({ service: "General practice" }).length, 0);
    assert.equal(s.slot(slot.id)!.status, "blocked", "still there, for the capacity report");

    // And a slot with a patient in it cannot be blocked out from under them.
    const other = s.openSlot({ ...MORNING, startsAt: "2026-07-01T10:00:00Z", endsAt: "2026-07-01T10:15:00Z" });
    s.book({ slotId: other.id, patientId: P1, reason: "Review", by: CLERK });
    assert.throws(() => s.blockSlot(other.id, "study leave"), /cancel it first so the patient is told/);
  } finally {
    cleanup();
  }
});

test("availability and a diary answer different questions about the same slots", () => {
  const { s, cleanup } = clinic();
  try {
    const nine = s.openSlot(MORNING);
    s.openSlot({ ...MORNING, startsAt: "2026-07-01T09:15:00Z", endsAt: "2026-07-01T09:30:00Z" });
    s.openSlot({ ...MORNING, resourceId: "dr-hale", startsAt: "2026-07-01T09:00:00Z", endsAt: "2026-07-01T09:15:00Z" });
    s.openSlot({ ...MORNING, service: "Physiotherapy", startsAt: "2026-07-02T09:00:00Z", endsAt: "2026-07-02T09:30:00Z" });
    s.book({ slotId: nine.id, patientId: P1, reason: "Knee review", by: CLERK });

    assert.equal(s.available({ service: "General practice" }).length, 2, "the booked one is not free");
    assert.equal(s.available({ resourceId: "dr-tetso" }).length, 2, "two of dr-tetso's three slots are free");
    assert.equal(s.available({ resourceId: "dr-hale" }).length, 1);
    assert.equal(s.available({ service: "Physiotherapy" }).length, 1);
    assert.equal(s.available({ from: "2026-07-02T00:00:00Z" }).length, 1);
    assert.equal(s.available({ to: "2026-07-02T00:00:00Z" }).length, 2);

    const diary = s.diary("dr-tetso", "2026-07-01T00:00:00Z", "2026-07-02T00:00:00Z");
    assert.equal(diary.length, 2, "a diary shows the booked one too — that is what a diary is for");
    assert.equal(diary[0].bookings[0].patient_id, P1);
    assert.equal(diary[1].bookings.length, 0);
  } finally {
    cleanup();
  }
});

test("the schedule is confined to its tenant", () => {
  const dir = mkdtempSync(join(tmpdir(), "portage-sched-iso-"));
  const root = new Db(join(dir, "portage.db"));
  try {
    root.createTenant("north", "Northern Health");
    root.createTenant("south", "Southern Health");
    const north = new Schedule(root.forTenant("north"));
    const south = new Schedule(root.forTenant("south"));

    const slot = north.openSlot(MORNING);
    const b = north.book({ slotId: slot.id, patientId: P1, reason: "Two-week wait", by: CLERK, priority: "urgent" });
    north.didNotAttend(b.id, NURSE);

    assert.equal(south.slot(slot.id), undefined);
    assert.equal(south.booking(b.id), undefined);
    assert.equal(south.available().length, 0, "one custodian's clinic is not another's");
    assert.equal(south.unresolvedNonAttendance().length, 0);
    assert.equal(north.unresolvedNonAttendance().length, 1);
    assert.equal(south.forPatient(P1).length, 0);
    assert.throws(() => south.book({ slotId: slot.id, patientId: P1, reason: "reaching", by: CLERK }), /no slot/);

    // And the same resource name at two custodians is two different diaries.
    const s2 = south.openSlot(MORNING);
    assert.equal(south.diary("dr-tetso", "2026-07-01T00:00:00Z", "2026-07-02T00:00:00Z").length, 1);
    assert.equal(south.diary("dr-tetso", "2026-07-01T00:00:00Z", "2026-07-02T00:00:00Z")[0].slot.id, s2.id);
  } finally {
    root.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("error messages read as English, including where the vowel rule is wrong", () => {
  // An error message is part of the product: "a accepted referral cannot be
  // booked" is what a clerk sees at the moment something has gone wrong, and
  // reading like a template costs a little of the confidence they need in it.
  //
  // The spelling rule alone gets this system's own vocabulary wrong in both
  // directions, which is why there are exception lists rather than a regex on
  // vowels.
  assert.equal(an("attended"), "an attended");
  assert.equal(an("accepted"), "an accepted");
  assert.equal(an("urgent"), "an urgent");
  assert.equal(an("in-progress"), "an in-progress");
  assert.equal(an("open"), "an open");
  assert.equal(an("draft"), "a draft");
  assert.equal(an("booked"), "a booked");
  assert.equal(an("did-not-attend"), "a did-not-attend");

  // The two directions the spelling rule gets wrong.
  assert.equal(an("unit"), "a unit", "a vowel that sounds like a consonant");
  assert.equal(an("universal precaution"), "a universal precaution");
  assert.equal(an("hour"), "an hour", "a consonant that is not sounded");
  assert.equal(an("honest mistake"), "an honest mistake");

  assert.equal(an(""), "a", "and nothing at all does not crash a message");
});
