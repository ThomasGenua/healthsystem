/**
 * Two things an operations board owes that were built and never shown.
 *
 * Item 66 of the patient-workflows roadmap: `IntakeSubmissions.open()` and
 * `TaskStore.load()` both existed and nothing in `src/workspace/board.ts`
 * called either, so the capability was there and no screen surfaced it.
 *
 * The intake one is the sharper of the two. A patient sits down before their
 * visit and writes out what they are taking and what has changed. Until a
 * clinician reads it the visit proceeds on what the chart said last time —
 * and a board with no intake panel looks exactly like a clinic where
 * everybody's submission has been read.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine } from "../src/core/engine.ts";
import { ClinicBoard } from "../src/workspace/board.ts";
import type { Question } from "../src/patient/intake.ts";

const PATIENT = "NT000001";
const OTHER = "NT000002";
const CLERK = { actorId: "clerk-1", actorKind: "staff" };
const NURSE = { actorId: "nurse-1", actorKind: "practitioner" };
const PATIENT_ACTOR = { actorId: PATIENT, actorKind: "patient" };
const QUESTIONS: Question[] = [
  { key: "fasting", label: "Have you fasted for 8 hours?", type: "boolean", required: true },
];

async function clinic() {
  const engine = new Engine({ dbPath: ":memory:", tickMs: 15, orderDispatchIntervalMs: 0 });
  await engine.start();
  const t = engine.forTenant("default");
  for (const id of [PATIENT, OTHER]) {
    t.clinical.record({
      entryType: "Patient", patientId: id,
      content: { resourceType: "Patient", identifier: [{ value: id }] },
      authorId: "adt", authorKind: "device",
    });
  }
  t.questionnaires.publish({ id: "pre-visit", title: "Pre-visit check-in", questions: QUESTIONS, by: CLERK });
  const submit = (patientId: string) => {
    const draft = t.intake.saveDraft({
      patientId, questionnaireId: "pre-visit", answers: { fasting: true }, by: { actorId: patientId, actorKind: "patient" },
    });
    return t.intake.submit(draft.id, { actorId: patientId, actorKind: "patient" });
  };
  return { engine, t, submit, close: () => engine.stop() };
}

test("a submission the patient sent and nobody has read is on the board", () => {
  return clinic().then(async (s) => {
    try {
      const sent = s.submit(PATIENT);
      const panel = s.t.board.attention().intakeAwaitingReview;
      assert.ok(panel, "the panel exists once intake is wired");
      assert.deepEqual(panel.rows.map((r) => r.id), [sent.id]);
      assert.match(panel.because, /nobody has read it/);
    } finally {
      await s.close();
    }
  });
});

test("a submission somebody has read leaves the panel", () => {
  return clinic().then(async (s) => {
    try {
      const sent = s.submit(PATIENT);
      s.t.intake.review(sent.id, { outcome: "accepted", note: "medication list matches", by: NURSE });
      assert.deepEqual(s.t.board.attention().intakeAwaitingReview!.rows, []);
    } finally {
      await s.close();
    }
  });
});

test("a draft the patient never sent is not somebody else's work", () => {
  // The panel is what the clinic owes the patient, not what the patient owes
  // the clinic. A half-finished form nobody submitted is not waiting on a
  // reviewer, and putting it here would bury the ones that are.
  return clinic().then(async (s) => {
    try {
      s.t.intake.saveDraft({
        patientId: PATIENT, questionnaireId: "pre-visit", answers: {}, by: PATIENT_ACTOR,
      });
      assert.deepEqual(s.t.board.attention().intakeAwaitingReview!.rows, []);
    } finally {
      await s.close();
    }
  });
});

test("the oldest submission is first, because one that waited through its own visit is not preparation", () => {
  return clinic().then(async (s) => {
    try {
      const first = s.submit(PATIENT);
      const second = s.submit(OTHER);
      assert.deepEqual(
        s.t.board.attention().intakeAwaitingReview!.rows.map((r) => r.id),
        [first.id, second.id]
      );
    } finally {
      await s.close();
    }
  });
});

test("a deployment with no intake gets no panel, not an empty one", () => {
  // The rule this file already worked under: an empty panel and a quiet day
  // look the same, and only one of them is true.
  return clinic().then(async (s) => {
    try {
      const withoutIntake = new ClinicBoard({
        schedule: s.t.schedule, encounters: s.t.encounters, tasks: s.t.tasks,
        discharges: s.t.discharges, handoffs: s.t.handoffs,
      });
      assert.equal("intakeAwaitingReview" in withoutIntake.attention(), false);
      assert.ok("unreachablePatients" in withoutIntake.attention(), "the rest of the board is unaffected");
    } finally {
      await s.close();
    }
  });
});

test("the board says how much work is open and how much belongs to nobody", () => {
  return clinic().then(async (s) => {
    try {
      s.t.tasks.create({ kind: "result-review", title: "Potassium 7.1", by: NURSE, patientId: PATIENT, ownerId: NURSE.actorId });
      s.t.tasks.create({ kind: "result-review", title: "Nobody has this", by: NURSE, patientId: OTHER });

      const load = s.t.board.workload();
      assert.ok(load);
      assert.equal(load.open, 2);
      assert.equal(load.unassigned, 1, "the count worth reading first");
      assert.equal(load.byKind["result-review"], 2);
      assert.match(load.because, /nobody has picked up/);
    } finally {
      await s.close();
    }
  });
});

test("a board whose task source cannot count says nothing rather than zero", () => {
  // Zero open tasks and a source that cannot answer are different facts, and
  // the second one must not render as the first.
  return clinic().then(async (s) => {
    try {
      const board = new ClinicBoard({
        schedule: s.t.schedule, encounters: s.t.encounters,
        tasks: { openOfKind: (k, o) => s.t.tasks.openOfKind(k, o) },
        discharges: s.t.discharges, handoffs: s.t.handoffs,
      });
      assert.equal(board.workload(), undefined);
    } finally {
      await s.close();
    }
  });
});

// --- the half #106 could not build --------------------------------------

/**
 * Who is coming in today with nothing sent in.
 *
 * #106 left this out on purpose. `appointment_id` existed on an intake row
 * and the portal never set one, so every submission was attached to nothing
 * and a panel built on it would have named every expected patient every
 * day. The portal records the visit now, so the question is answerable —
 * and it is asked per appointment, because a form submitted before the last
 * visit says nothing about this one.
 */
const RESOURCE = "dr-okpik";

async function clinicDay() {
  const s = await clinic();
  const t = s.t;
  const book = (patientId: string, hour: number) => {
    const slot = t.schedule.openSlot({
      resourceId: RESOURCE,
      resourceKind: "practitioner",
      service: "Family practice",
      startsAt: `2026-03-04T${String(hour).padStart(2, "0")}:00:00.000Z`,
      endsAt: `2026-03-04T${String(hour).padStart(2, "0")}:30:00.000Z`,
    });
    return t.schedule.book({ slotId: slot.id, patientId, reason: "Follow-up", by: CLERK }).id;
  };
  const submitFor = (patientId: string, appointmentId?: string) => {
    const draft = t.intake.saveDraft({
      patientId,
      questionnaireId: "pre-visit",
      answers: { fasting: true },
      ...(appointmentId ? { appointmentId } : {}),
      by: { actorId: patientId, actorKind: "patient" },
    });
    return t.intake.submit(draft.id, { actorId: patientId, actorKind: "patient" });
  };
  // Mid-morning on the booked day, so both appointments are still expected.
  const asOf = new Date("2026-03-04T08:30:00.000Z");
  return { ...s, book, submitFor, asOf };
}

test("somebody expected today with nothing sent in is on the board", async () => {
  const s = await clinicDay();
  try {
    const prepared = s.book(PATIENT, 9);
    s.book(OTHER, 10);
    s.submitFor(PATIENT, prepared);

    const panel = s.t.board.expectedWithoutIntake([RESOURCE], s.asOf);
    assert.ok(panel);
    assert.deepEqual(panel.rows.map((r) => r.patientId), [OTHER]);
    assert.match(panel.because, /nothing was sent in before the visit/);
  } finally {
    await s.close();
  }
});

test("a form sent in for a different visit does not cover this one", async () => {
  // The reason this is asked per appointment. Counting any submission ever
  // would tell a clinician they had a current medication list because the
  // patient filled one in last year.
  const s = await clinicDay();
  try {
    const lastYear = s.book(PATIENT, 8);
    const today = s.book(PATIENT, 11);
    s.submitFor(PATIENT, lastYear);

    const rows = s.t.board.expectedWithoutIntake([RESOURCE], s.asOf)!.rows;
    assert.ok(
      rows.some((r) => r.bookingId === today),
      "the 11:00 visit has nothing of its own and must still be listed"
    );
  } finally {
    await s.close();
  }
});

test("a form attached to no visit covers no visit", async () => {
  // Null is not a wildcard, for the reason it is not one in a
  // patient-scoped search: a visit showing as unprepared when a form exists
  // somewhere is recoverable; one showing as ready when nothing was sent
  // for it is what puts a clinician in the room without a history.
  const s = await clinicDay();
  try {
    const today = s.book(PATIENT, 9);
    s.submitFor(PATIENT);

    assert.deepEqual(
      s.t.board.expectedWithoutIntake([RESOURCE], s.asOf)!.rows.map((r) => r.bookingId),
      [today]
    );
  } finally {
    await s.close();
  }
});

test("a deployment with no intake gets no panel here either", async () => {
  const s = await clinicDay();
  try {
    s.book(PATIENT, 9);
    const withoutIntake = new ClinicBoard({
      schedule: s.t.schedule, encounters: s.t.encounters, tasks: s.t.tasks,
      discharges: s.t.discharges, handoffs: s.t.handoffs,
    });
    assert.equal(withoutIntake.expectedWithoutIntake([RESOURCE], s.asOf), undefined);
  } finally {
    await s.close();
  }
});
