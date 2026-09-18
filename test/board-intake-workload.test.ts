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
