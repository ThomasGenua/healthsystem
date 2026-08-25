/**
 * Travelling clinics: the visit as one thing, and the waitlist as policy.
 *
 * The two failure modes this exists against, and that these tests aim at:
 * a cancelled visit scattering into twenty orphaned cancellations with no
 * common cause and no queue for the next plane, and a waitlist ordered by
 * whoever happens to be on top of the pile — an ordering nobody agreed to,
 * invented by accident, deciding who waits longer.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { Db } from "../src/db.ts";
import { Schedule, SlotFull } from "../src/schedule/store.ts";
import { Clinics } from "../src/schedule/clinics.ts";

const CLERK = { actorId: "clerk", actorKind: "staff" };
const DAYS = [
  { date: "2027-03-02", from: "09:00", to: "12:00" },
  { date: "2027-03-03", from: "13:00", to: "15:00" },
];

function boot(): { db: Db; clinics: Clinics; schedule: Schedule } {
  const db = new Db(":memory:");
  return { db, clinics: new Clinics(db), schedule: new Schedule(db) };
}

test("a planned visit is ordinary slots, and the unique index still guards them", () => {
  const { db, clinics, schedule } = boot();
  try {
    const { visit, slots } = clinics.planVisit({
      resourceId: "dr-cardio",
      service: "Cardiology",
      community: "Fort Smith",
      days: DAYS,
      slotMinutes: 30,
      by: CLERK,
    });

    // Two days: 09:00–12:00 in 30-minute slots is 6, 13:00–15:00 is 4.
    assert.equal(slots.length, 10);
    assert.ok(slots.every((s) => s.visit_id === visit.id));
    assert.equal(visit.starts_on, "2027-03-02");
    assert.equal(visit.ends_on, "2027-03-03");

    // Ordinary rows: book() books them, and the constraint that makes
    // double-booking impossible was not routed around by the generator.
    schedule.book({ slotId: slots[0].id, patientId: "NT1", reason: "Murmur", by: CLERK });
    assert.throws(
      () => schedule.book({ slotId: slots[0].id, patientId: "NT2", reason: "Murmur", by: CLERK }),
      SlotFull
    );
  } finally {
    db.close();
  }
});

test("the same as last time is one call, and copies what actually ran", () => {
  const { db, clinics } = boot();
  try {
    const first = clinics.planVisit({
      resourceId: "dr-cardio",
      service: "Cardiology",
      community: "Fort Smith",
      days: DAYS,
      slotMinutes: 30,
      capacity: 2,
      by: CLERK,
    });

    const next = clinics.repeatVisit(first.visit.id, { firstDay: "2027-04-06", by: CLERK });

    assert.equal(next.slots.length, first.slots.length, "same number of seats");
    assert.equal(next.visit.starts_on, "2027-04-06");
    assert.equal(next.visit.ends_on, "2027-04-07", "the day spacing carried over");
    assert.equal(next.visit.community, "Fort Smith");
    assert.equal(next.slots[0].capacity, 2, "capacity carried over");
    // Same times of day, new dates.
    assert.deepEqual(
      next.slots.map((s) => s.starts_at.slice(11, 16)),
      first.slots.map((s) => s.starts_at.slice(11, 16))
    );
  } finally {
    db.close();
  }
});

test("cancelling a visit is one act: the common cause on every booking, and the queue for the next plane", () => {
  const { db, clinics, schedule } = boot();
  try {
    const { visit, slots } = clinics.planVisit({
      resourceId: "dr-cardio",
      service: "Cardiology",
      community: "Fort Smith",
      days: [DAYS[0]],
      slotMinutes: 30,
      by: CLERK,
    });
    const b1 = schedule.book({ slotId: slots[0].id, patientId: "NT1", reason: "Murmur", by: CLERK, priority: "urgent" });
    schedule.book({ slotId: slots[1].id, patientId: "NT2", reason: "Follow-up", by: CLERK });

    const r = clinics.cancelVisit(visit.id, { ...CLERK, reason: "runway closed by weather" });

    assert.equal(r.visit.status, "cancelled");
    assert.equal(r.bumped.length, 2);

    // The common cause is on each booking, not scattered.
    const cancelled = schedule.booking(b1.id)!;
    assert.equal(cancelled.status, "cancelled");
    assert.match(cancelled.cancel_reason ?? "", /visit cancelled: runway closed/);

    // Each patient is in the queue for the next visit, bump counted, priority
    // and referral carried, and their wait dated from when they booked — the
    // weather does not send anybody to the back of the line.
    const entry = clinics.entry(r.bumped[0].waitlistId)!;
    assert.equal(entry.status, "waiting");
    assert.equal(entry.bump_count, 1);
    assert.equal(entry.priority, "urgent");
    assert.equal(entry.added_at, b1.booked_at);

    // Unbooked slots are blocked, not deleted: the clinic that was supposed
    // to run is what a capacity report is made of.
    const remaining = clinics.slotsOf(visit.id).filter((s) => s.status === "blocked");
    assert.equal(remaining.length, slots.length);
  } finally {
    db.close();
  }
});

test("a patient bumped twice is visible, and never loses their place", () => {
  const { db, clinics, schedule } = boot();
  try {
    const plan = (date: string) =>
      clinics.planVisit({
        resourceId: "dr-cardio",
        service: "Cardiology",
        community: "Fort Smith",
        days: [{ date, from: "09:00", to: "10:00" }],
        slotMinutes: 30,
        by: CLERK,
      });

    const first = plan("2027-03-02");
    schedule.book({ slotId: first.slots[0].id, patientId: "NT1", reason: "Murmur", by: CLERK });
    clinics.cancelVisit(first.visit.id, { ...CLERK, reason: "weather" });
    const afterOne = clinics.waitlist("Cardiology")[0];
    assert.equal(afterOne.bump_count, 1);

    // The next plane comes; they get the seat; the weather turns again.
    const second = plan("2027-04-06");
    const offer = clinics.offerSeat({ waitlistId: afterOne.id, slotId: second.slots[0].id, by: CLERK });
    clinics.resolveOffer(offer.id, { outcome: "accepted", by: CLERK });
    clinics.cancelVisit(second.visit.id, { ...CLERK, reason: "weather again" });

    const afterTwo = clinics.entry(afterOne.id)!;
    assert.equal(afterTwo.bump_count, 2, "both bumps are on the same entry");
    assert.equal(afterTwo.status, "waiting");
    assert.equal(afterTwo.added_at, afterOne.added_at, "and the clock never reset");
  } finally {
    db.close();
  }
});

test("moving a visit keeps every booking and says who has to be told", () => {
  const { db, clinics, schedule } = boot();
  try {
    const { visit, slots } = clinics.planVisit({
      resourceId: "dr-cardio",
      service: "Cardiology",
      community: "Fort Smith",
      days: DAYS,
      slotMinutes: 30,
      by: CLERK,
    });
    const b = schedule.book({ slotId: slots[0].id, patientId: "NT1", reason: "Murmur", by: CLERK });

    const r = clinics.rescheduleVisit(visit.id, { toFirstDay: "2027-03-09", by: CLERK, reason: "plane delayed a week" });

    assert.equal(r.visit.starts_on, "2027-03-09");
    assert.equal(r.visit.ends_on, "2027-03-10");
    assert.equal(r.toTell.length, 1, "the phone list is the return value");
    assert.equal(r.toTell[0].id, b.id);

    // The booking survived on its seat; only the time moved; the move is on
    // the booking's history, because a rescheduled appointment nobody was
    // told about is a did-not-attend the clinic caused.
    const moved = schedule.slot(slots[0].id)!;
    assert.equal(moved.starts_at.slice(0, 10), "2027-03-09");
    assert.equal(moved.starts_at.slice(11, 16), slots[0].starts_at.slice(11, 16));
    const history = schedule.history(b.id);
    assert.ok(history.some((e) => e.event === "visit-rescheduled" && /plane delayed/.test(e.detail ?? "")));
  } finally {
    db.close();
  }
});

test("the waitlist order is the stated policy, not the insertion order", () => {
  const { db, clinics } = boot();
  try {
    // Inserted in exactly the wrong order for every key.
    clinics.addToWaitlist({ service: "Cardiology", patientId: "routine-late", reason: "r", by: CLERK });
    const early = clinics.addToWaitlist({ service: "Cardiology", patientId: "routine-early", reason: "r", by: CLERK });
    db.sql
      .prepare("UPDATE schedule_waitlist SET added_at = '2026-01-01T00:00:00.000Z' WHERE tenant_id = 'default' AND id = ?")
      .run(early.id);
    clinics.addToWaitlist({ service: "Cardiology", patientId: "urgent-one", reason: "r", by: CLERK, priority: "urgent" });
    const bumped = clinics.addToWaitlist({ service: "Cardiology", patientId: "routine-bumped", reason: "r", by: CLERK });
    db.sql
      .prepare(
        "UPDATE schedule_waitlist SET added_at = '2026-01-01T00:00:00.000Z', bump_count = 2 WHERE tenant_id = 'default' AND id = ?"
      )
      .run(bumped.id);

    assert.deepEqual(
      clinics.waitlist("Cardiology").map((e) => e.patient_id),
      ["urgent-one", "routine-bumped", "routine-early", "routine-late"],
      "priority first, then waited-longest, then most-bumped as the tiebreak"
    );
  } finally {
    db.close();
  }
});

test("declined and unreachable are different facts, and neither costs a place", () => {
  const { db, clinics } = boot();
  try {
    const { slots } = clinics.planVisit({
      resourceId: "dr-cardio",
      service: "Cardiology",
      community: "Fort Smith",
      days: [DAYS[0]],
      slotMinutes: 30,
      by: CLERK,
    });
    const entry = clinics.addToWaitlist({ service: "Cardiology", patientId: "NT1", reason: "Murmur", by: CLERK });

    const first = clinics.offerSeat({ waitlistId: entry.id, slotId: slots[0].id, by: CLERK });
    assert.equal(clinics.entry(entry.id)!.status, "offered");
    assert.throws(
      () => clinics.offerSeat({ waitlistId: entry.id, slotId: slots[1].id, by: CLERK }),
      /already has an offer out/
    );

    clinics.resolveOffer(first.id, { outcome: "unreachable", by: CLERK, note: "no answer, message left at the band office" });
    assert.equal(clinics.entry(entry.id)!.status, "waiting", "unreachable goes back in the queue");

    const second = clinics.offerSeat({ waitlistId: entry.id, slotId: slots[1].id, by: CLERK });
    clinics.resolveOffer(second.id, { outcome: "declined", by: CLERK, note: "prefers the spring visit" });
    assert.equal(clinics.entry(entry.id)!.status, "waiting");

    // The record keeps them apart: a community with one phone line is not a
    // community that keeps saying no.
    const outcomes = clinics.offersFor(entry.id).map((o) => o.outcome);
    assert.deepEqual(outcomes, ["unreachable", "declined"]);
  } finally {
    db.close();
  }
});

test("accepting an offer books through the front door, so a taken seat refuses honestly", () => {
  const { db, clinics, schedule } = boot();
  try {
    const { slots } = clinics.planVisit({
      resourceId: "dr-cardio",
      service: "Cardiology",
      community: "Fort Smith",
      days: [{ date: "2027-03-02", from: "09:00", to: "09:30" }],
      slotMinutes: 30,
      by: CLERK,
    });
    const entry = clinics.addToWaitlist({
      service: "Cardiology",
      patientId: "NT1",
      reason: "Murmur",
      by: CLERK,
      priority: "urgent",
      referralId: "ref-1",
    });
    const offer = clinics.offerSeat({ waitlistId: entry.id, slotId: slots[0].id, by: CLERK });

    // Somebody else takes the last seat while the offer is out.
    schedule.book({ slotId: slots[0].id, patientId: "NT2", reason: "Walk-in", by: CLERK });

    assert.throws(() => clinics.resolveOffer(offer.id, { outcome: "accepted", by: CLERK }), SlotFull);

    // The refusal reached the operator, and the record tells the truth about
    // what happened: the offer lapsed — the patient said yes and did nothing
    // wrong — and their place in the queue is intact.
    const lapsed = clinics.offer(offer.id)!;
    assert.equal(lapsed.outcome, "lapsed");
    assert.match(lapsed.note ?? "", /taken while the offer was out/);
    assert.equal(clinics.entry(entry.id)!.status, "waiting");

    // On a free seat, acceptance is a real booking carrying what the entry
    // knew — priority and the referral it answers.
    const more = clinics.planVisit({
      resourceId: "dr-cardio",
      service: "Cardiology",
      community: "Fort Smith",
      days: [{ date: "2027-03-03", from: "09:00", to: "09:30" }],
      slotMinutes: 30,
      by: CLERK,
    });
    const retry = clinics.offerSeat({ waitlistId: entry.id, slotId: more.slots[0].id, by: CLERK });
    const done = clinics.resolveOffer(retry.id, { outcome: "accepted", by: CLERK });
    assert.equal(done.booking!.priority, "urgent");
    assert.equal(done.booking!.referral_id, "ref-1");
    assert.equal(clinics.entry(entry.id)!.status, "booked");
  } finally {
    db.close();
  }
});

test("an offer says where the seat is, and says both places when they differ", () => {
  const { db, clinics } = boot();
  try {
    const { slots } = clinics.planVisit({
      resourceId: "dr-cardio",
      service: "Cardiology",
      community: "Fort Smith",
      days: [DAYS[0]],
      slotMinutes: 30,
      by: CLERK,
    });
    const far = clinics.addToWaitlist({
      service: "Cardiology",
      patientId: "NT1",
      reason: "Murmur",
      by: CLERK,
      community: "Ulukhaktok",
    });
    const offer = clinics.offerSeat({ waitlistId: far.id, slotId: slots[0].id, by: CLERK });
    assert.equal(offer.place, "Fort Smith — patient is in Ulukhaktok");

    const near = clinics.addToWaitlist({
      service: "Cardiology",
      patientId: "NT2",
      reason: "Murmur",
      by: CLERK,
      community: "Fort Smith",
    });
    const local = clinics.offerSeat({ waitlistId: near.id, slotId: slots[1].id, by: CLERK });
    assert.equal(local.place, "Fort Smith");
  } finally {
    db.close();
  }
});

test("one patient cannot wait twice for the same service", () => {
  const { db, clinics } = boot();
  try {
    clinics.addToWaitlist({ service: "Cardiology", patientId: "NT1", reason: "Murmur", by: CLERK });
    assert.throws(
      () => clinics.addToWaitlist({ service: "Cardiology", patientId: "NT1", reason: "Again", by: CLERK }),
      /already waiting on the Cardiology waitlist/
    );
    // A different service is a different wait.
    clinics.addToWaitlist({ service: "Dermatology", patientId: "NT1", reason: "Rash", by: CLERK });
  } finally {
    db.close();
  }
});
