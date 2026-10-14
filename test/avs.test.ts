/**
 * The after-visit summary: assembled only from approved content, never
 * generated. A proposed goal, a declined action, and an escalation
 * paragraph nobody wrote are the three things this exists to keep off it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine } from "../src/core/engine.ts";

const PATIENT = "NT123456";
const GP = { authorId: "dr-tetso", authorKind: "practitioner" };
const GP_ACTOR = { actorId: "dr-tetso", actorKind: "practitioner" };

async function clinic() {
  const engine = new Engine({ dbPath: ":memory:", tickMs: 15 });
  await engine.start();
  const t = engine.forTenant("default");
  t.clinical.record({
    entryType: "Patient",
    patientId: PATIENT,
    content: { resourceType: "Patient", identifier: [{ value: PATIENT }] },
    authorId: "adt",
    authorKind: "device",
  });
  const encounter = t.encounters.open({
    patientId: PATIENT,
    class: "in-person",
    reason: "Diabetes follow-up",
    by: GP_ACTOR,
    arrived: true,
  });
  return { engine, t, encounter, close: () => engine.stop() };
}

test("only approved and completed content reaches the summary", async () => {
  const s = await clinic();
  try {
    const plan = s.t.carePlans.record({
      patientId: PATIENT,
      title: "Diabetes management",
      goals: ["Lower A1C"],
      reviewBy: "2027-01-01",
      escalationCriteria: "Call the clinic if your blood sugar reads under 4 mmol/L more than once in a day.",
      by: GP,
    });

    const approvedGoal = s.t.goals.approve(
      s.t.goals.propose({ patientId: PATIENT, carePlanId: plan.recordId, description: "A1C under 7%", by: GP }).recordId,
      GP
    );
    const proposedGoal = s.t.goals.propose({ patientId: PATIENT, carePlanId: plan.recordId, description: "Not agreed yet", by: GP });
    const declinedGoal = s.t.goals.decline(
      s.t.goals.propose({ patientId: PATIENT, carePlanId: plan.recordId, description: "Rejected suggestion", by: GP }).recordId,
      { ...GP, reason: "not clinically appropriate for this patient" }
    );

    const approvedAction = s.t.actions.approve(
      s.t.actions.propose({
        patientId: PATIENT,
        carePlanId: plan.recordId,
        description: "Book a dietitian follow-up",
        responsibleId: PATIENT,
        by: GP,
      }).recordId,
      GP
    );
    const proposedAction = s.t.actions.propose({
      patientId: PATIENT,
      carePlanId: plan.recordId,
      description: "Not yet agreed action",
      responsibleId: PATIENT,
      by: GP,
    });

    const summary = s.t.avs.build(s.encounter.id);
    assert.equal(summary.plans.length, 1);
    const goalIds = summary.plans[0].goals.map((g) => g.recordId);
    assert.deepEqual(goalIds, [approvedGoal.recordId]);
    assert.ok(!goalIds.includes(proposedGoal.recordId));
    assert.ok(!goalIds.includes(declinedGoal.recordId));

    const actionIds = summary.plans[0].actions.map((a) => a.recordId);
    assert.deepEqual(actionIds, [approvedAction.recordId]);
    assert.ok(!actionIds.includes(proposedAction.recordId));

    assert.equal(summary.plans[0].escalationCriteria, "Call the clinic if your blood sugar reads under 4 mmol/L more than once in a day.");
  } finally {
    await s.close();
  }
});

test("a plan with no clinician-written escalation criteria says so, and invents nothing", async () => {
  const s = await clinic();
  try {
    s.t.carePlans.record({
      patientId: PATIENT,
      title: "Plan with no escalation text",
      goals: ["x"],
      reviewBy: "2027-01-01",
      by: GP,
    });
    const summary = s.t.avs.build(s.encounter.id);
    assert.deepEqual(summary.plans[0].escalationCriteria, { provided: false });
  } finally {
    await s.close();
  }
});

test("only orders placed during this encounter appear, not the patient's other orders", async () => {
  const s = await clinic();
  try {
    s.t.orders.create({
      patientId: PATIENT,
      category: "lab",
      code: "2823-3",
      display: "Potassium",
      indication: "Routine monitoring",
      encounterId: s.encounter.id,
      by: GP_ACTOR,
    });
    // A separate, unrelated encounter's order must not show up here.
    const otherEncounter = s.t.encounters.open({ patientId: PATIENT, class: "telephone", reason: "Unrelated call", by: GP_ACTOR });
    s.t.orders.create({
      patientId: PATIENT,
      category: "lab",
      code: "718-7",
      display: "Hemoglobin",
      indication: "Different visit",
      encounterId: otherEncounter.id,
      by: GP_ACTOR,
    });

    const summary = s.t.avs.build(s.encounter.id);
    assert.deepEqual(
      summary.ordersFromThisVisit.map((o) => o.display),
      ["Potassium"]
    );
  } finally {
    await s.close();
  }
});

test("a completed plan is not \"active\" and does not appear on a later visit's summary", async () => {
  const s = await clinic();
  try {
    const plan = s.t.carePlans.record({ patientId: PATIENT, title: "Short-term plan", goals: ["x"], reviewBy: "2027-01-01", by: GP });
    s.t.carePlans.complete(plan.recordId, { ...GP, outcome: "goal achieved ahead of schedule" });
    const summary = s.t.avs.build(s.encounter.id);
    assert.equal(summary.plans.length, 0);
  } finally {
    await s.close();
  }
});

test("building a summary for an encounter that does not exist is refused, not empty", async () => {
  const s = await clinic();
  try {
    assert.throws(() => s.t.avs.build("no-such-encounter"), /no encounter/);
  } finally {
    await s.close();
  }
});

test("an after-visit summary is confined to its tenant", async () => {
  const s = await clinic();
  try {
    const other = s.engine.forTenant("second-clinic");
    assert.throws(() => other.avs.build(s.encounter.id), /no encounter/);
  } finally {
    await s.close();
  }
});
