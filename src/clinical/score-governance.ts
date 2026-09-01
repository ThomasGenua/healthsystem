/**
 * Deployment approval for clinical risk scores.
 *
 * The formula catalogue says what Portage implements. This store records the
 * separate, local decision that a named deployment may use one implementation
 * clinically. Approval is append-only, version-bound, and expires: changing
 * the implementation or reaching the review date closes the gate without
 * somebody having to remember to turn it off.
 */
import { randomUUID } from "node:crypto";
import type { Db } from "../db.ts";
import { Refusal, refuse } from "../core/refusal.ts";
import { SCORE_DEFINITIONS, SCORE_IDS, type ScoreId } from "./score-definitions.ts";

export type ScoreApprovalStatus = "enabled" | "disabled";

export interface ScoreApprovalRow {
  tenant_id: string;
  id: string;
  score_id: ScoreId;
  implementation_version: string;
  status: ScoreApprovalStatus;
  clinical_owner: string;
  approved_population: string;
  reviewed_at: string;
  review_due: string;
  licensing_accepted_by: string;
  licensing_accepted_at: string;
  reason: string;
  recorded_by: string;
  recorded_by_kind: string;
  recorded_at: string;
  supersedes: string | null;
}

/** The exact local decision under which a number was allowed out. */
export interface ScoreAuthorization {
  approvalId: string;
  scoreId: ScoreId;
  implementationVersion: string;
  clinicalOwner: string;
  approvedPopulation: string;
  reviewedAt: string;
  reviewDue: string;
  licensingAcceptedBy: string;
  licensingAcceptedAt: string;
}

export interface ScoreApprovalState {
  scoreId: ScoreId;
  implementationVersion: string;
  enabled: boolean;
  reason: string;
  approval: ScoreApprovalRow | null;
}

function validDate(name: string, value: string): number {
  const at = new Date(value).getTime();
  if (!value.trim() || !Number.isFinite(at)) refuse(`${name} must be an ISO date-time; got ${value || "empty"}`);
  return at;
}

function scoreId(value: string): ScoreId {
  if (!(SCORE_IDS as readonly string[]).includes(value)) {
    throw new Refusal(`unknown score ${value}; expected one of ${SCORE_IDS.join(", ")}`, 400);
  }
  return value as ScoreId;
}

export class ScoreGovernance {
  private db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  current(id: ScoreId): ScoreApprovalRow | undefined {
    return this.db.sql
      .prepare(
        `SELECT * FROM score_approvals a
          WHERE a.tenant_id = ? AND a.score_id = ?
            AND NOT EXISTS (
              SELECT 1 FROM score_approvals n
               WHERE n.tenant_id = a.tenant_id AND n.supersedes = a.id
            )
          ORDER BY a.recorded_at DESC LIMIT 1`
      )
      .get(this.db.tenantId, id) as unknown as ScoreApprovalRow | undefined;
  }

  history(id: ScoreId): ScoreApprovalRow[] {
    return this.db.sql
      .prepare("SELECT * FROM score_approvals WHERE tenant_id = ? AND score_id = ? ORDER BY recorded_at, id")
      .all(this.db.tenantId, id) as unknown as ScoreApprovalRow[];
  }

  approve(input: {
    scoreId: string;
    implementationVersion: string;
    clinicalOwner: string;
    approvedPopulation: string;
    reviewedAt: string;
    reviewDue: string;
    licensingAcceptedBy: string;
    reason: string;
    by: { actorId: string; actorKind: string };
    at?: string;
  }): ScoreApprovalRow {
    const id = scoreId(input.scoreId);
    const definition = SCORE_DEFINITIONS[id];
    if (input.implementationVersion !== definition.implementationVersion) {
      refuse(
        `${id} implements ${definition.implementationVersion}; approval for ${input.implementationVersion || "an unspecified version"} cannot enable it`
      );
    }
    if (!input.clinicalOwner.trim()) refuse("score approval needs a named clinical owner");
    if (!input.approvedPopulation.trim()) refuse("score approval needs the locally approved population");
    if (!input.licensingAcceptedBy.trim()) refuse("score approval needs the person who accepted the source licensing terms");
    if (!input.reason.trim()) refuse("score approval needs a reason and review reference");
    const now = input.at ?? new Date().toISOString();
    const nowMs = validDate("approval time", now);
    const reviewedMs = validDate("reviewedAt", input.reviewedAt);
    const dueMs = validDate("reviewDue", input.reviewDue);
    if (reviewedMs > nowMs) refuse("reviewedAt cannot be in the future");
    if (dueMs <= nowMs) refuse("reviewDue must be in the future when the score is enabled");
    if (dueMs <= reviewedMs) refuse("reviewDue must be after reviewedAt");

    const prior = this.current(id);
    const rowId = randomUUID();
    this.db.sql
      .prepare(
        `INSERT INTO score_approvals
           (tenant_id, id, score_id, implementation_version, status, clinical_owner,
            approved_population, reviewed_at, review_due, licensing_accepted_by,
            licensing_accepted_at, reason, recorded_by, recorded_by_kind, recorded_at, supersedes)
         VALUES (?, ?, ?, ?, 'enabled', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        this.db.tenantId,
        rowId,
        id,
        input.implementationVersion,
        input.clinicalOwner.trim(),
        input.approvedPopulation.trim(),
        input.reviewedAt,
        input.reviewDue,
        input.licensingAcceptedBy.trim(),
        now,
        input.reason.trim(),
        input.by.actorId,
        input.by.actorKind,
        now,
        prior?.id ?? null
      );
    return this.current(id)!;
  }

  disable(input: {
    scoreId: string;
    reason: string;
    by: { actorId: string; actorKind: string };
    at?: string;
  }): ScoreApprovalRow {
    const id = scoreId(input.scoreId);
    const prior = this.current(id);
    if (!prior) refuse(`${id} has no approval to disable`, 404);
    if (!input.reason.trim()) refuse("disabling a score needs a reason");
    const now = input.at ?? new Date().toISOString();
    validDate("disable time", now);
    const rowId = randomUUID();
    this.db.sql
      .prepare(
        `INSERT INTO score_approvals
           (tenant_id, id, score_id, implementation_version, status, clinical_owner,
            approved_population, reviewed_at, review_due, licensing_accepted_by,
            licensing_accepted_at, reason, recorded_by, recorded_by_kind, recorded_at, supersedes)
         VALUES (?, ?, ?, ?, 'disabled', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        this.db.tenantId,
        rowId,
        id,
        prior.implementation_version,
        prior.clinical_owner,
        prior.approved_population,
        prior.reviewed_at,
        prior.review_due,
        prior.licensing_accepted_by,
        prior.licensing_accepted_at,
        input.reason.trim(),
        input.by.actorId,
        input.by.actorKind,
        now,
        prior.id
      );
    return this.current(id)!;
  }

  state(value: string, at = new Date().toISOString()): ScoreApprovalState {
    const id = scoreId(value);
    const definition = SCORE_DEFINITIONS[id];
    const row = this.current(id) ?? null;
    if (!row) {
      return { scoreId: id, implementationVersion: definition.implementationVersion, enabled: false, reason: "no deployment approval recorded", approval: null };
    }
    if (row.status !== "enabled") {
      return { scoreId: id, implementationVersion: definition.implementationVersion, enabled: false, reason: `disabled: ${row.reason}`, approval: row };
    }
    if (row.implementation_version !== definition.implementationVersion) {
      return {
        scoreId: id,
        implementationVersion: definition.implementationVersion,
        enabled: false,
        reason: `approval covers ${row.implementation_version}, not current implementation ${definition.implementationVersion}`,
        approval: row,
      };
    }
    const atMs = validDate("evaluation time", at);
    const dueMs = validDate("stored reviewDue", row.review_due);
    if (dueMs <= atMs) {
      return { scoreId: id, implementationVersion: definition.implementationVersion, enabled: false, reason: `clinical review expired at ${row.review_due}`, approval: row };
    }
    return { scoreId: id, implementationVersion: definition.implementationVersion, enabled: true, reason: "deployment approval is current", approval: row };
  }

  list(at = new Date().toISOString()): ScoreApprovalState[] {
    return SCORE_IDS.map((id) => this.state(id, at));
  }

  requireEnabled(value: string, at = new Date().toISOString()): ScoreAuthorization {
    const state = this.state(value, at);
    if (!state.enabled || !state.approval) {
      throw new Refusal(`${state.scoreId} is disabled for clinical use: ${state.reason}`, 409);
    }
    const a = state.approval;
    return {
      approvalId: a.id,
      scoreId: a.score_id,
      implementationVersion: a.implementation_version,
      clinicalOwner: a.clinical_owner,
      approvedPopulation: a.approved_population,
      reviewedAt: a.reviewed_at,
      reviewDue: a.review_due,
      licensingAcceptedBy: a.licensing_accepted_by,
      licensingAcceptedAt: a.licensing_accepted_at,
    };
  }
}

/**
 * Refuse a complete hand-supplied calculation unless every governed unit is
 * named exactly. Values and units travel separately so the arithmetic input
 * remains compatible with the published scorer interfaces.
 */
export function requireScoreUnits(value: string, units: unknown): Readonly<Record<string, string>> {
  const id = scoreId(value);
  const supplied = units && typeof units === "object" && !Array.isArray(units) ? (units as Record<string, unknown>) : {};
  const accepted: Record<string, string> = {};
  for (const [field, expected] of Object.entries(SCORE_DEFINITIONS[id].requiredUnits)) {
    const actual = supplied[field];
    if (actual === undefined) throw new Refusal(`${id} requires units.${field} = ${JSON.stringify(expected)}; unit was omitted`, 400);
    if (actual !== expected) {
      throw new Refusal(`${id} requires units.${field} = ${JSON.stringify(expected)}; got ${JSON.stringify(actual)}`, 400);
    }
    accepted[field] = expected;
  }
  return Object.freeze(accepted);
}
