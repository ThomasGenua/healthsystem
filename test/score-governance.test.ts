/** Deployment score approval is a gate, not a label. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Db } from "../src/db.ts";
import { ScoreGovernance, requireScoreUnits } from "../src/clinical/score-governance.ts";

const REVIEW = {
  scoreId: "curb-65",
  implementationVersion: "portage-1",
  clinicalOwner: "Dr Jean Tetso",
  approvedPopulation: "Adults presenting to this deployment with community-acquired pneumonia",
  reviewedAt: "2026-08-01T00:00:00.000Z",
  reviewDue: "2027-08-01T00:00:00.000Z",
  licensingAcceptedBy: "clinical-governance-board",
  reason: "Board minute CGB-2026-14",
  by: { actorId: "cso-tetso", actorKind: "practitioner" },
  at: "2026-09-01T00:00:00.000Z",
} as const;

test("scores are disabled until a named, current, version-bound review enables them", () => {
  const db = new Db(":memory:");
  try {
    const governance = new ScoreGovernance(db);
    assert.equal(governance.state("curb-65", REVIEW.at).enabled, false);
    assert.throws(() => governance.requireEnabled("curb-65", REVIEW.at), /no deployment approval recorded/);

    const row = governance.approve(REVIEW);
    const authorization = governance.requireEnabled("curb-65", REVIEW.at);
    assert.equal(authorization.approvalId, row.id);
    assert.equal(authorization.implementationVersion, "portage-1");
    assert.equal(authorization.clinicalOwner, "Dr Jean Tetso");

    assert.throws(
      () => governance.requireEnabled("curb-65", "2027-08-01T00:00:00.000Z"),
      /clinical review expired/
    );

    // Simulates opening a database whose approval names the implementation
    // from before an upgrade. The current code must not inherit that decision.
    db.sql
      .prepare("UPDATE score_approvals SET implementation_version = ? WHERE tenant_id = ? AND id = ?")
      .run("portage-0", db.tenantId, row.id);
    assert.throws(() => governance.requireEnabled("curb-65", REVIEW.at), /not current implementation portage-1/);
  } finally {
    db.close();
  }
});

test("renewal and disable are append-only decisions", () => {
  const db = new Db(":memory:");
  try {
    const governance = new ScoreGovernance(db);
    const enabled = governance.approve(REVIEW);
    const disabled = governance.disable({
      scoreId: "curb-65",
      reason: "steward guidance changed; review required",
      by: REVIEW.by,
      at: "2026-10-01T00:00:00.000Z",
    });
    assert.equal(disabled.supersedes, enabled.id);
    assert.equal(governance.history("curb-65").length, 2);
    assert.throws(() => governance.requireEnabled("curb-65", "2026-10-02T00:00:00.000Z"), /disabled/);
  } finally {
    db.close();
  }
});

test("approval cannot be invented for the wrong implementation or without governance evidence", () => {
  const db = new Db(":memory:");
  try {
    const governance = new ScoreGovernance(db);
    assert.throws(() => governance.approve({ ...REVIEW, implementationVersion: "portage-0" }), /cannot enable/);
    assert.throws(() => governance.approve({ ...REVIEW, clinicalOwner: "" }), /named clinical owner/);
    assert.throws(() => governance.approve({ ...REVIEW, reviewDue: REVIEW.at }), /must be in the future/);
  } finally {
    db.close();
  }
});

test("approval is tenant-scoped", () => {
  const db = new Db(":memory:");
  try {
    new ScoreGovernance(db.forTenant("north")).approve(REVIEW);
    assert.equal(new ScoreGovernance(db.forTenant("north")).state("curb-65", REVIEW.at).enabled, true);
    assert.equal(new ScoreGovernance(db.forTenant("south")).state("curb-65", REVIEW.at).enabled, false);
  } finally {
    db.close();
  }
});

test("a complete hand-supplied score must name every governed unit exactly", () => {
  const units = {
    ureaMmolL: "mmol/L",
    respiratoryRate: "breaths/min",
    systolicBp: "mmHg",
    diastolicBp: "mmHg",
    ageYears: "completed years",
  };
  assert.deepEqual(requireScoreUnits("curb-65", units), units);
  assert.throws(() => requireScoreUnits("curb-65", { ...units, ureaMmolL: "mg/dL" }), /requires units\.ureaMmolL/);
  const { ureaMmolL: _omitted, ...missing } = units;
  assert.throws(() => requireScoreUnits("curb-65", missing), /unit was omitted/);
});
