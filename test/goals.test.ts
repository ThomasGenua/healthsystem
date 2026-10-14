/**
 * Goals and actions on a care plan: item 61's "proposed, approved, completed,
 * declined, superseded" distinction, kept the same way any other correction
 * on the chart is kept — as a new version next to the one it replaced, never
 * an edit in place.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../src/db.ts";
import { ClinicalRecord } from "../src/clinical/record.ts";
import { CarePlans } from "../src/clinical/careplans.ts";
import { Goals, Actions } from "../src/clinical/goals.ts";

function clinic() {
  const dir = mkdtempSync(join(tmpdir(), "northstar-goals-"));
  const db = new Db(join(dir, "northstar.db"));
  const record = new ClinicalRecord(db);
  return {
    db,
    record,
    plans: new CarePlans(record),
    goals: new Goals(record),
    actions: new Actions(record),
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}

const P = "NT123456";
const GP = { authorId: "dr-tetso", authorKind: "practitioner" };
const PATIENT_AUTHOR = { authorId: P, authorKind: "patient" };

function openPlan(c: ReturnType<typeof clinic>) {
  return c.plans.record({
    patientId: P,
    title: "Diabetes management",
    goals: ["Lower A1C"],
    reviewBy: "2027-01-01",
    by: GP,
  });
}

test("a proposed goal is not on the plan until a clinician approves it", () => {
  const c = clinic();
  try {
    const plan = openPlan(c);
    const goal = c.goals.propose({ patientId: P, carePlanId: plan.recordId, description: "Walk 30 minutes daily", by: PATIENT_AUTHOR });
    assert.equal(goal.status, "proposed");

    const approved = c.goals.approve(goal.recordId, GP);
    assert.equal(approved.status, "approved");
    assert.equal(approved.recordId, goal.recordId, "approval is a new version of the same goal, not a new one");

    // The full history survives: two versions, not one row overwritten.
    assert.equal(c.record.history(goal.recordId).length, 2);
  } finally {
    c.cleanup();
  }
});

test("only a proposed goal can be approved or declined; only an approved one can be completed", () => {
  const c = clinic();
  try {
    const plan = openPlan(c);
    const goal = c.goals.propose({ patientId: P, carePlanId: plan.recordId, description: "Quit smoking", by: PATIENT_AUTHOR });

    assert.throws(() => c.goals.complete(goal.recordId, { ...GP, outcome: "done" }), /only an approved goal/);
    const declined = c.goals.decline(goal.recordId, { ...GP, reason: "already addressed on the smoking-cessation plan" });
    assert.equal(declined.status, "declined");

    assert.throws(() => c.goals.approve(goal.recordId, GP), /a declined goal cannot be approved/);

    const goal2 = c.goals.propose({ patientId: P, carePlanId: plan.recordId, description: "Reduce sodium intake", by: PATIENT_AUTHOR });
    const approved2 = c.goals.approve(goal2.recordId, GP);
    assert.throws(() => c.goals.complete(approved2.recordId, { ...GP, outcome: "" }), /written outcome/);
    const completed = c.goals.complete(approved2.recordId, { ...GP, outcome: "sodium intake now within target range" });
    assert.equal(completed.status, "completed");
  } finally {
    c.cleanup();
  }
});

test("revising a goal supersedes it rather than editing it, and the old text survives", () => {
  const c = clinic();
  try {
    const plan = openPlan(c);
    const original = c.goals.approve(
      c.goals.propose({ patientId: P, carePlanId: plan.recordId, description: "A1C under 7.5%", reviewBy: "2027-01-01", by: GP })
        .recordId,
      GP
    );

    const revised = c.goals.revise(original.recordId, {
      description: "A1C under 7.0%",
      by: { ...GP, reason: "patient is tolerating the new regimen well" },
    });
    assert.notEqual(revised.recordId, original.recordId, "a revision is a new goal, not the same one edited");
    assert.equal(revised.status, "proposed", "a revision needs its own approval, even of an already-agreed goal");
    // Read fresh from the store too, not just the value revise() handed
    // back — a caller polling the plan later must see the same answer.
    assert.equal(c.goals.get(revised.recordId)!.status, "proposed");

    const oldNow = c.goals.get(original.recordId)!;
    assert.equal(oldNow.status, "superseded");
    assert.equal(oldNow.supersededBy, revised.recordId);

    // And the original text is still there — nothing rewrote it.
    const firstVersion = c.record.history(original.recordId).find((e) => e.version === 1)!;
    assert.equal(JSON.parse(firstVersion.content).description, "A1C under 7.5%");

    assert.deepEqual(
      c.goals.forPlan(plan.recordId).map((g) => g.description).sort(),
      ["A1C under 7.0%", "A1C under 7.5%"].sort()
    );
  } finally {
    c.cleanup();
  }
});

test("an action needs a responsible person, and progress can only be recorded once approved", () => {
  const c = clinic();
  try {
    const plan = openPlan(c);
    assert.throws(() =>
      c.actions.propose({ patientId: P, carePlanId: plan.recordId, description: "Book dietitian", responsibleId: "", by: GP })
    );

    const action = c.actions.propose({
      patientId: P,
      carePlanId: plan.recordId,
      description: "Book a dietitian follow-up",
      responsibleId: P,
      dueAt: "2026-10-01",
      by: GP,
    });
    assert.throws(() => c.actions.recordProgress(action.recordId, { ...GP, progress: "called" }), /only be recorded on an approved/);

    const approved = c.actions.approve(action.recordId, GP);
    const withProgress = c.actions.recordProgress(approved.recordId, { ...GP, progress: "appointment booked for next week" });
    assert.equal(withProgress.progress, "appointment booked for next week");
    assert.equal(withProgress.status, "approved", "a progress note is not completion");

    const completed = c.actions.complete(withProgress.recordId, { ...GP, outcome: "attended; plan updated" });
    assert.equal(completed.status, "completed");
  } finally {
    c.cleanup();
  }
});

test("an action can link to an existing task, and refuses a link to one that does not exist", () => {
  const c = clinic();
  try {
    const plan = openPlan(c);
    const tasks = new Map([["real-task-1", true]]);
    const actionsWithLinks = new Actions(c.record, { task: { get: (id: string) => tasks.get(id) } });

    const linked = actionsWithLinks.propose({
      patientId: P,
      carePlanId: plan.recordId,
      description: "Follow up on the referral",
      responsibleId: "dr-tetso",
      link: { kind: "task", id: "real-task-1" },
      by: GP,
    });
    assert.deepEqual(linked.link, { kind: "task", id: "real-task-1" });

    assert.throws(
      () =>
        actionsWithLinks.propose({
          patientId: P,
          carePlanId: plan.recordId,
          description: "Follow up on nothing",
          responsibleId: "dr-tetso",
          link: { kind: "task", id: "no-such-task" },
          by: GP,
        }),
      /no task no-such-task/
    );
  } finally {
    c.cleanup();
  }
});

test("overdue actions are approved and past their due date only", () => {
  const c = clinic();
  try {
    const plan = openPlan(c);
    const overdue = c.actions.approve(
      c.actions.propose({
        patientId: P,
        carePlanId: plan.recordId,
        description: "Overdue action",
        responsibleId: "dr-tetso",
        dueAt: "2020-01-01",
        by: GP,
      }).recordId,
      GP
    );
    c.actions.approve(
      c.actions.propose({
        patientId: P,
        carePlanId: plan.recordId,
        description: "Not yet due",
        responsibleId: "dr-tetso",
        dueAt: "2099-01-01",
        by: GP,
      }).recordId,
      GP
    );
    // Proposed (never approved) and therefore not this list, however overdue its date is.
    c.actions.propose({
      patientId: P,
      carePlanId: plan.recordId,
      description: "Never approved",
      responsibleId: "dr-tetso",
      dueAt: "2020-01-01",
      by: GP,
    });

    const rows = c.actions.overdue();
    assert.deepEqual(
      rows.map((a) => a.recordId),
      [overdue.recordId]
    );
  } finally {
    c.cleanup();
  }
});

test("goals and actions are confined to their care plan and their patient", () => {
  const c = clinic();
  try {
    const plan = openPlan(c);
    const otherPlan = c.plans.record({ patientId: P, title: "Other plan", goals: ["x"], reviewBy: "2027-01-01", by: GP });
    c.goals.propose({ patientId: P, carePlanId: plan.recordId, description: "In plan one", by: GP });
    c.goals.propose({ patientId: P, carePlanId: otherPlan.recordId, description: "In plan two", by: GP });

    assert.equal(c.goals.forPlan(plan.recordId).length, 1);
    assert.equal(c.goals.forPlan(otherPlan.recordId).length, 1);
    assert.equal(c.goals.forPatient(P).length, 2);
  } finally {
    c.cleanup();
  }
});
