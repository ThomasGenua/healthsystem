/**
 * A care plan without a review date never ends.
 *
 * The same failure as a proxy grant without an expiry: something that looks
 * finished because nobody is looking at it. Completing one needs a written
 * outcome; revoking one needs a written reason; both are amendments, not
 * overwrites. An empty panel is never-planned, not none. A plan past its
 * review date is work, not a status.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../src/db.ts";
import { ClinicalRecord } from "../src/clinical/record.ts";
import { CarePlans } from "../src/clinical/careplans.ts";
import { Refusal } from "../src/core/refusal.ts";

function clinic() {
  const dir = mkdtempSync(join(tmpdir(), "northstar-plan-"));
  const db = new Db(join(dir, "northstar.db"));
  const record = new ClinicalRecord(db);
  return {
    db,
    record,
    plans: new CarePlans(record),
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}

const P = "NT123456";
const GP = { authorId: "dr-tetso", authorKind: "practitioner" };

function openPlan(
  plans: CarePlans,
  extra: Partial<{ title: string; goals: string[]; reviewBy: string; status: "draft" | "active" }> = {}
) {
  return plans.record({
    patientId: P,
    title: extra.title ?? "Type 2 diabetes care plan",
    goals: extra.goals ?? ["HbA1c under 7 percent"],
    reviewBy: extra.reviewBy ?? "2026-12-01T00:00:00Z",
    by: GP,
    ...(extra.status ? { status: extra.status } : {}),
  });
}

test("a care plan without a review date is refused, not defaulted", () => {
  const { plans, cleanup } = clinic();
  try {
    assert.throws(
      () =>
        plans.record({
          patientId: P,
          title: "Type 2 diabetes care plan",
          goals: ["HbA1c under 7 percent"],
          reviewBy: "  ",
          by: GP,
        }),
      (err: unknown) => err instanceof Refusal && /review date/.test((err as Error).message)
    );
    const row = openPlan(plans);
    assert.equal(row.reviewBy, "2026-12-01T00:00:00Z");
    assert.equal(row.status, "active");
  } finally {
    cleanup();
  }
});

test("a care plan without a goal is not a plan", () => {
  const { plans, cleanup } = clinic();
  try {
    assert.throws(
      () =>
        plans.record({
          patientId: P,
          title: "Type 2 diabetes care plan",
          goals: ["  "],
          reviewBy: "2026-12-01T00:00:00Z",
          by: GP,
        }),
      (err: unknown) => err instanceof Refusal && /goal/.test((err as Error).message)
    );
    const row = openPlan(plans);
    assert.deepEqual(row.goals, ["HbA1c under 7 percent"]);
  } finally {
    cleanup();
  }
});

test("completing a care plan needs a written outcome", () => {
  const { plans, record, cleanup } = clinic();
  try {
    const row = openPlan(plans);
    assert.throws(
      () => plans.complete(row.recordId, { ...GP, outcome: "done" }),
      (err: unknown) => err instanceof Refusal && /outcome/.test((err as Error).message)
    );
    const done = plans.complete(row.recordId, {
      ...GP,
      outcome: "HbA1c 6.8; plan goals met at annual review",
    });
    assert.equal(done.status, "completed");
    assert.match(done.outcome ?? "", /6\.8/);
    assert.equal(plans.get(row.recordId)?.status, "completed");
    assert.equal(record.history(row.recordId).length, 2, "completing is an amendment, not an overwrite");
    assert.throws(
      () => plans.complete(row.recordId, { ...GP, outcome: "trying to complete it again for some reason" }),
      Refusal
    );
  } finally {
    cleanup();
  }
});

test("revoking a care plan needs a written reason", () => {
  const { plans, cleanup } = clinic();
  try {
    const row = openPlan(plans, { status: "draft" });
    assert.throws(() => plans.revoke(row.recordId, { ...GP, reason: "stop" }), Refusal);
    const revoked = plans.revoke(row.recordId, {
      ...GP,
      reason: "patient moved; care transferred to Fort Smith",
    });
    assert.equal(revoked.status, "revoked");
    assert.match(revoked.reason ?? "", /transferred/);
  } finally {
    cleanup();
  }
});

test("a care plan past its review date is work, not a status", () => {
  const { plans, cleanup } = clinic();
  try {
    openPlan(plans, { reviewBy: "2020-01-01T00:00:00Z" });
    openPlan(plans, {
      title: "Asthma action plan",
      goals: ["no unscheduled visits this winter"],
      reviewBy: "2029-01-01T00:00:00Z",
    });
    const due = plans.overdue("2026-08-28T12:00:00Z");
    assert.equal(due.length, 1);
    assert.equal(due[0].title, "Type 2 diabetes care plan");
    assert.equal(plans.overdue("2019-12-01T00:00:00Z").length, 0, "not yet due is not work");
  } finally {
    cleanup();
  }
});

test("an empty care-plan panel is never-planned, not none", () => {
  const { plans, cleanup } = clinic();
  try {
    assert.equal(plans.historyStatus(P), "never-planned");
    assert.deepEqual(plans.forPatient(P), []);
    openPlan(plans);
    assert.equal(plans.historyStatus(P), "documented");
    assert.equal(plans.active(P).length, 1);
  } finally {
    cleanup();
  }
});

test("one custodian cannot read another's care plans", () => {
  const dir = mkdtempSync(join(tmpdir(), "northstar-plan-iso-"));
  const root = new Db(join(dir, "northstar.db"));
  try {
    root.createTenant("north", "Northern Health");
    root.createTenant("south", "Southern Health");
    const north = new CarePlans(new ClinicalRecord(root.forTenant("north")));
    const south = new CarePlans(new ClinicalRecord(root.forTenant("south")));
    north.record({
      patientId: P,
      title: "Type 2 diabetes care plan",
      goals: ["HbA1c under 7 percent"],
      reviewBy: "2026-12-01T00:00:00Z",
      by: GP,
    });
    assert.equal(north.historyStatus(P), "documented");
    assert.equal(south.historyStatus(P), "never-planned");
    assert.equal(south.overdue("2027-01-01T00:00:00Z").length, 0);
  } finally {
    root.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
