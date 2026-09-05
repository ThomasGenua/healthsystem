/**
 * The board on the wall, and the one only staff can see.
 *
 * A waiting-room display is the most ordinary feature in a clinic and the
 * one with the widest audience: everybody in the room reads it, continuously,
 * and nobody records that they did. A board naming patients discloses who is
 * seeing a doctor today to that person's neighbour and to whoever is waiting
 * for somebody else.
 *
 * So the property these exist to pin is that the public rendering has no
 * field an identifier could go in — not that it happens to omit one today.
 * The rest is the front desk's actual question: who is here, how long have
 * they been waiting, which rooms are free, and who has fallen through.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine } from "../src/core/engine.ts";
import { visitToken } from "../src/workspace/board.ts";

const PATIENT = "NT000001";
const OTHER = "NT000002";
const DOCTOR = { actorId: "dr-okpik", actorKind: "practitioner" };
const RESOURCE = "dr-okpik";

/** A clinic day: three appointments on the hour, one patient per chart. */
async function clinic() {
  const engine = new Engine({ dbPath: ":memory:", tickMs: 15 });
  await engine.start();
  const t = engine.forTenant("default");
  for (const id of [PATIENT, OTHER, "NT000003"]) {
    t.clinical.record({
      entryType: "Patient",
      patientId: id,
      content: { resourceType: "Patient", identifier: [{ value: id }] },
      authorId: "adt",
      authorKind: "device",
    });
  }
  const book = (patientId: string, hour: number, priority?: "routine" | "urgent" | "stat") => {
    const slot = t.schedule.openSlot({
      resourceId: RESOURCE,
      service: "Family practice",
      startsAt: `2026-03-04T${String(hour).padStart(2, "0")}:00:00.000Z`,
      endsAt: `2026-03-04T${String(hour).padStart(2, "0")}:30:00.000Z`,
      resourceKind: "practitioner",
    });
    const booking = t.schedule.book({
      slotId: slot.id,
      patientId,
      reason: "Follow-up",
      by: DOCTOR,
      ...(priority ? { priority } : {}),
    });
    return { slot, booking };
  };
  return { engine, t, book, close: () => engine.stop() };
}

test("the public board has nowhere to put a name", async () => {
  const s = await clinic();
  try {
    const first = s.book(PATIENT, 9);
    s.book(OTHER, 10);
    const at = new Date("2026-03-04T09:20:00.000Z");

    const staff = s.t.board.waiting([RESOURCE], at);
    assert.equal(staff.length, 2);
    assert.ok(staff.every((r) => r.patientId), "the staff view names people, because staff need that");

    const wall = s.t.board.publicBoard([RESOURCE], at);
    assert.equal(wall.length, 2);
    for (const row of wall) {
      // By construction, not by omission. Three fields, and none of them can
      // hold an identifier.
      assert.deepEqual(Object.keys(row).sort(), ["state", "token", "waitingMinutes"]);
    }
    const rendered = JSON.stringify(wall);
    for (const secret of [PATIENT, OTHER, "Follow-up", first.booking.id, first.slot.id]) {
      assert.ok(!rendered.includes(secret), `the wall board carried ${secret}`);
    }
  } finally {
    await s.close();
  }
});

test("a visit token is stable for the visit, different for the next, and readable across a room", () => {
  const a = visitToken("booking-alpha");
  assert.equal(a, visitToken("booking-alpha"), "the same visit gets the same token all afternoon");
  assert.notEqual(a, visitToken("booking-beta"));
  assert.equal(a.length, 4);
  // Across a corpus, not one sample. Checking a single token for an ambiguous
  // glyph passes most of the time whatever the alphabet is, which is a test
  // that reports on luck.
  const corpus = Array.from({ length: 400 }, (_, i) => visitToken(`booking-${i}`));
  for (const token of corpus) {
    // 0/O and 1/I/L are the pairs somebody gets wrong from six metres away.
    assert.ok(!/[01OIL]/.test(token), `${token} contains a glyph that is misread at distance`);
    assert.equal(token.length, 4);
  }
  // And it is not a counter: a counter tells the room how many people are
  // ahead of you, which is a fact about somebody else.
  assert.ok(new Set(corpus).size > 350, `only ${new Set(corpus).size} distinct tokens in 400 bookings`);
});

test("somebody who has left the building leaves the wall", async () => {
  const s = await clinic();
  try {
    const { booking } = s.book(PATIENT, 9);
    const encounter = s.t.encounters.open({
      patientId: PATIENT,
      class: "in-person",
      reason: "Follow-up",
      by: DOCTOR,
      bookingId: booking.id,
      arrived: true,
    });
    const at = new Date("2026-03-04T09:20:00.000Z");
    assert.equal(s.t.board.publicBoard([RESOURCE], at).length, 1);

    s.t.encounters.close(encounter.id, { ...DOCTOR, disposition: "home" });

    // Off the wall: a token that stays up all afternoon is one somebody can
    // watch to learn how long a particular person was in with a clinician.
    assert.deepEqual(s.t.board.publicBoard([RESOURCE], at), []);
    // Still on the staff view, where the front desk needs it.
    const staff = s.t.board.waiting([RESOURCE], at);
    assert.equal(staff[0].state, "finished");
    assert.equal(staff[0].because, "seen");
  } finally {
    await s.close();
  }
});

test("the board says who is here, who is expected, and who did not come", async () => {
  const s = await clinic();
  try {
    const here = s.book(PATIENT, 9);
    s.book(OTHER, 11);
    const missed = s.book("NT000003", 8);

    s.t.encounters.open({
      patientId: PATIENT,
      class: "in-person",
      reason: "Follow-up",
      by: DOCTOR,
      bookingId: here.booking.id,
      arrived: true,
    });
    s.t.schedule.didNotAttend(missed.booking.id, DOCTOR);

    const rows = s.t.board.waiting([RESOURCE], new Date("2026-03-04T09:20:00.000Z"));
    const byState = Object.fromEntries(rows.map((r) => [r.state, r]));

    // Arrived first: they are in the building and the clinic is holding them up.
    assert.equal(rows[0].state, "arrived");
    assert.match(byState.arrived.because, /here and waiting 20 minutes past their appointment/);
    assert.match(byState.expected.because, /expected in 100 minutes/);
    assert.equal(byState["did-not-attend"].because, "did not attend");

    // And it does not claim to know something it cannot: one encounter status
    // covers both "in the waiting room" and "with the clinician".
    assert.ok(rows.every((r) => r.progressKnown === false));
  } finally {
    await s.close();
  }
});

test("an urgent patient outranks a longer wait, and the row says so", async () => {
  const s = await clinic();
  try {
    const early = s.book(PATIENT, 8);
    const urgent = s.book(OTHER, 9, "urgent");
    for (const b of [early, urgent]) {
      s.t.encounters.open({
        patientId: b.booking.patient_id,
        class: "in-person",
        reason: "Follow-up",
        by: DOCTOR,
        bookingId: b.booking.id,
        arrived: true,
      });
    }

    const rows = s.t.board.waiting([RESOURCE], new Date("2026-03-04T09:30:00.000Z"));
    assert.equal(rows[0].patientId, OTHER, "urgent first");
    assert.match(rows[0].because, /^urgent priority, here and waiting 30 minutes/);
    // The longer wait is second, and its row still states its own case, so a
    // clerk overriding the order is disagreeing with something written down.
    assert.equal(rows[1].patientId, PATIENT);
    assert.match(rows[1].because, /here and waiting 90 minutes/);
  } finally {
    await s.close();
  }
});

test("a room with nothing scheduled is not the same as a room that is free", async () => {
  const s = await clinic();
  try {
    s.book(PATIENT, 9);
    const at = new Date("2026-03-04T08:00:00.000Z");

    const [busy] = s.t.board.resources([RESOURCE], at);
    assert.equal(busy.slots, 1);
    assert.equal(busy.booked, 1);
    assert.equal(busy.free, 0);
    assert.match(busy.because, /every one of today's 1 seats is taken/);

    const [empty] = s.t.board.resources(["room-2"], at);
    assert.equal(empty.slots, 0);
    assert.match(empty.because, /nothing scheduled today, which is not the same as being free/);
  } finally {
    await s.close();
  }
});

test("a resource with a gap says when the next one is", async () => {
  const s = await clinic();
  try {
    s.book(PATIENT, 9);
    // A second slot, unbooked.
    s.t.schedule.openSlot({
      resourceId: RESOURCE,
      service: "Family practice",
      startsAt: "2026-03-04T14:00:00.000Z",
      endsAt: "2026-03-04T14:30:00.000Z",
      resourceKind: "practitioner",
    });

    const [row] = s.t.board.resources([RESOURCE], new Date("2026-03-04T08:00:00.000Z"));
    assert.equal(row.slots, 2);
    assert.equal(row.free, 1);
    assert.equal(row.nextFreeAt, "2026-03-04T14:00:00.000Z");
    assert.match(row.because, /1 of 2 seats open, next at 14:00/);
    assert.equal(row.kind, "practitioner");
  } finally {
    await s.close();
  }
});

test("a patient nobody could reach is on the board, owned or not", async () => {
  const s = await clinic();
  try {
    // An address on file that nobody verified, so the notice cannot go out.
    s.t.contacts.add({ patientId: PATIENT, channel: "sms", value: "+15550100" });
    const notice = s.t.notices.queue({
      patientId: PATIENT,
      kind: "result-released",
      summary: "A result was released",
    });
    const report = s.t.notices.deliver(notice.id, { contacts: s.t.contacts, tasks: s.t.tasks });
    assert.ok(report.followUpTaskId);

    const attention = s.t.board.attention();
    assert.deepEqual(
      attention.unreachablePatients.map((x) => x.id),
      [report.followUpTaskId]
    );
    assert.match(attention.because, /nobody has been able to tell this patient/);

    // Somebody picks it up. It stays: assigned is not finished, and a patient
    // nobody has managed to tell is still a patient nobody has told.
    s.t.tasks.assign(report.followUpTaskId!, "clerk-avery", { actorId: "clerk-avery", actorKind: "practitioner" });
    assert.equal(s.t.board.attention().unreachablePatients.length, 1);

    s.t.tasks.complete(report.followUpTaskId!, {
      actorId: "clerk-avery",
      actorKind: "practitioner",
      evidence: "reached her on her sister's phone; new number verified at the desk",
    });
    assert.deepEqual(s.t.board.attention().unreachablePatients, []);
  } finally {
    await s.close();
  }
});

test("one custodian's waiting room is not another's", async () => {
  const engine = new Engine({ dbPath: ":memory:", tickMs: 15 });
  await engine.start();
  try {
    engine.db.createTenant("south", "south", "south");
    const north = engine.forTenant("default");
    const south = engine.forTenant("south");

    north.clinical.record({
      entryType: "Patient",
      patientId: PATIENT,
      content: { resourceType: "Patient", identifier: [{ value: PATIENT }] },
      authorId: "adt",
      authorKind: "device",
    });
    const slot = north.schedule.openSlot({
      resourceId: RESOURCE,
      service: "Family practice",
      startsAt: "2026-03-04T09:00:00.000Z",
      endsAt: "2026-03-04T09:30:00.000Z",
    });
    north.schedule.book({ slotId: slot.id, patientId: PATIENT, reason: "Follow-up", by: DOCTOR });

    const at = new Date("2026-03-04T09:10:00.000Z");
    assert.equal(north.board.waiting([RESOURCE], at).length, 1);
    assert.deepEqual(south.board.waiting([RESOURCE], at), [], "the southern site's board is its own");
    assert.deepEqual(south.board.publicBoard([RESOURCE], at), []);
  } finally {
    await engine.stop();
  }
});

test("a cancelled booking is on nobody's board", async () => {
  const s = await clinic();
  try {
    const { booking } = s.book(PATIENT, 9);
    s.t.schedule.cancel(booking.id, { ...DOCTOR, reason: "patient rebooked for next week" });
    const at = new Date("2026-03-04T09:10:00.000Z");
    assert.deepEqual(s.t.board.waiting([RESOURCE], at), []);
    assert.deepEqual(s.t.board.publicBoard([RESOURCE], at), []);
  } finally {
    await s.close();
  }
});
