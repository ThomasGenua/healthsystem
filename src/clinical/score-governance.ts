/**
 * Whether a clinical score may be used here, and who said so.
 *
 * `scores.ts` is arithmetic over published instruments, and it is correct
 * arithmetic. That is not the same as permission to act on the number. An
 * instrument derived in one population, implemented from a paper, and never
 * looked at by anybody accountable at this site is a calculator — and a
 * calculator wired into a chart, returning a band and an interpretation, is
 * indistinguishable at the point of care from a decision somebody stands
 * behind.
 *
 * So the default is off. A score with no approval row does not compute
 * through the governed route, and the empty table is the safe state rather
 * than an unconfigured one. Nothing here can enable a score as a side effect:
 * the only way is an operator recording a decision, naming a clinician who
 * owns it and a date it must be looked at again.
 *
 * ## What this deliberately cannot do
 *
 * It cannot invent an approval, a reviewer, or a review date. `reviewDue` is
 * supplied and never computed from a default interval, because a date the
 * system chose is not a commitment anybody made. The clinical owner must
 * resolve to a practitioner the directory holds and has not retired, so
 * "approved by Dr Smith" cannot outlive Dr Smith's registration. And there is
 * no renewal that extends an approval without a new decision: an expiry that
 * clears itself is not an expiry.
 *
 * ## Two people, not one
 *
 * The operator who records the decision and the clinician who owns it are
 * separate columns because they are frequently separate people — a systems
 * administrator entering what a medical director decided. A record that
 * conflates them can answer neither "who is accountable for this clinically"
 * nor "who typed it in", and both questions get asked after an incident.
 */
import { randomUUID } from "node:crypto";
import type { Db } from "../db.ts";
import { Refusal } from "../core/refusal.ts";
import { Directory } from "../directory/store.ts";
import { SCORE_DEFINITIONS, SCORE_IDS, type ScoreId } from "./score-definitions.ts";

/**
 * Where a score stands right now.
 *
 * Only `current` and `expiring` permit use. Everything else is a reason it
 * does not, and each is distinct because they need different actions: an
 * expired approval needs a reviewer, a version mismatch needs somebody to
 * look at what changed in the arithmetic, and a withdrawal needs nothing at
 * all — it was deliberate.
 */
export type ScoreStatus =
  | "never-approved"
  | "current"
  | "expiring"
  | "expired"
  | "version-mismatch"
  | "disabled";

export interface ApprovalRow {
  id: string;
  scoreId: ScoreId;
  implementationVersion: string;
  decision: "approved" | "disabled";
  reason: string;
  clinicalOwnerId: string | null;
  clinicalOwnerDisplay: string | null;
  reviewDue: string | null;
  recordedBy: { id: string; kind: string };
  supersedes: string | null;
  recordedAt: string;
}

export interface ScoreState {
  scoreId: ScoreId;
  name: string;
  status: ScoreStatus;
  /** True only for `current` and `expiring`. Nothing else may compute. */
  enabled: boolean;
  /** The decision in force, where there is one. */
  approval: ApprovalRow | null;
  /** The version the code implements now, which may differ from the approved one. */
  runningVersion: string;
  /** Days until review is due; negative once past. Null with no approval. */
  daysUntilReview: number | null;
  /** One line an operator can act on. */
  detail: string;
}

const DAY_MS = 86_400_000;

function rowToApproval(r: Record<string, unknown>): ApprovalRow {
  return {
    id: String(r.id),
    scoreId: String(r.score_id) as ScoreId,
    implementationVersion: String(r.implementation_version),
    decision: String(r.decision) as "approved" | "disabled",
    reason: String(r.reason),
    clinicalOwnerId: (r.clinical_owner_id as string | null) ?? null,
    clinicalOwnerDisplay: (r.clinical_owner_display as string | null) ?? null,
    reviewDue: (r.review_due as string | null) ?? null,
    recordedBy: { id: String(r.recorded_by_id), kind: String(r.recorded_by_kind) },
    supersedes: (r.supersedes as string | null) ?? null,
    recordedAt: String(r.recorded_at),
  };
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}(T|$)/.test(value)) return false;
  return Number.isFinite(new Date(value).getTime());
}

export class ScoreGovernance {
  private readonly db: Db;
  private readonly directory: Directory;

  constructor(db: Db) {
    this.db = db;
    this.directory = new Directory(db);
  }

  /** Every decision ever recorded for a score, newest first. Append-only. */
  history(scoreId: ScoreId): ApprovalRow[] {
    return (
      this.db.sql
        .prepare(
          "SELECT * FROM score_approvals WHERE tenant_id = ? AND score_id = ? ORDER BY recorded_at DESC, rowid DESC"
        )
        .all(this.db.tenantId, scoreId) as unknown as Array<Record<string, unknown>>
    ).map(rowToApproval);
  }

  private latest(scoreId: ScoreId): ApprovalRow | null {
    return this.history(scoreId)[0] ?? null;
  }

  /**
   * Where one score stands.
   *
   * `expiringWithinDays` only decides where the line between `current` and
   * `expiring` falls; both permit use. Nothing about a score changes on its
   * own as the clock moves except this, which is the point — an approval
   * ages whether or not anybody runs a report.
   */
  state(scoreId: ScoreId, opts: { asOf?: Date; expiringWithinDays?: number } = {}): ScoreState {
    const asOf = opts.asOf ?? new Date();
    const within = opts.expiringWithinDays ?? 30;
    const definition = SCORE_DEFINITIONS[scoreId];
    const runningVersion = definition.implementationVersion;
    const approval = this.latest(scoreId);
    const base = { scoreId, name: definition.name, approval, runningVersion };

    if (!approval) {
      return {
        ...base,
        status: "never-approved",
        enabled: false,
        daysUntilReview: null,
        detail: `${definition.name} has never been approved for use here; it is disabled, which is the default for every score`,
      };
    }
    if (approval.decision === "disabled") {
      return {
        ...base,
        status: "disabled",
        enabled: false,
        daysUntilReview: null,
        detail: `${definition.name} was disabled on ${approval.recordedAt} by ${approval.recordedBy.id}: ${approval.reason}`,
      };
    }
    if (approval.implementationVersion !== runningVersion) {
      return {
        ...base,
        status: "version-mismatch",
        enabled: false,
        daysUntilReview: null,
        detail:
          `${definition.name} was approved for implementation ${approval.implementationVersion} and this build runs ` +
          `${runningVersion}; the arithmetic has changed since anybody looked at it, so it is disabled until re-approved`,
      };
    }

    const due = approval.reviewDue === null ? null : new Date(approval.reviewDue);
    const days = due === null ? null : Math.floor((due.getTime() - asOf.getTime()) / DAY_MS);
    if (days === null) {
      // Not reachable through approve(), which requires a review date. Kept so
      // a row written by an older build cannot read as indefinitely valid.
      return {
        ...base,
        status: "expired",
        enabled: false,
        daysUntilReview: null,
        detail: `${definition.name} carries an approval with no review date, which cannot be treated as current`,
      };
    }
    if (days < 0) {
      return {
        ...base,
        status: "expired",
        enabled: false,
        daysUntilReview: days,
        detail:
          `${definition.name} was due for review on ${approval.reviewDue}, ${-days} day(s) ago, and is disabled until ` +
          `${approval.clinicalOwnerDisplay ?? "its clinical owner"} reviews it. Nothing renews on its own.`,
      };
    }
    if (days <= within) {
      return {
        ...base,
        status: "expiring",
        enabled: true,
        daysUntilReview: days,
        detail: `${definition.name} is due for review on ${approval.reviewDue}, in ${days} day(s)`,
      };
    }
    return {
      ...base,
      status: "current",
      enabled: true,
      daysUntilReview: days,
      detail: `${definition.name} is approved until review on ${approval.reviewDue}`,
    };
  }

  /** Every score, in catalogue order. The admin panel's whole payload. */
  all(opts: { asOf?: Date; expiringWithinDays?: number } = {}): ScoreState[] {
    return SCORE_IDS.map((id) => this.state(id, opts));
  }

  /**
   * Approvals already past review, or due within the window.
   *
   * Reporting only. Reading this never changes a status, and there is no
   * variant of it that renews anything.
   */
  expiring(withinDays: number, asOf: Date = new Date()): ScoreState[] {
    if (!Number.isInteger(withinDays) || withinDays < 0) {
      throw new Refusal(`withinDays must be a whole number of days, not ${withinDays}`, 400);
    }
    return this.all({ asOf, expiringWithinDays: withinDays }).filter(
      (s) => s.status === "expiring" || s.status === "expired"
    );
  }

  /** True only where a decision in force permits use. Everything else is off. */
  enabled(scoreId: ScoreId, asOf: Date = new Date()): boolean {
    return this.state(scoreId, { asOf }).enabled;
  }

  /**
   * Refuses unless the score may be used, saying which of the reasons applies.
   *
   * The gate the governed routes call. It is a throw rather than a boolean so
   * that a caller who forgets to check cannot accidentally serve a number.
   */
  require(scoreId: ScoreId, asOf: Date = new Date()): ScoreState {
    const state = this.state(scoreId, { asOf });
    if (!state.enabled) {
      throw new Refusal(
        `${state.name} is not approved for use here (${state.status}): ${state.detail}`,
        403
      );
    }
    return state;
  }

  /**
   * Records a decision that a score may be used, or may no longer be.
   *
   * Both directions go through one path because both are the same kind of
   * fact: somebody accountable decided something, in writing, at a time.
   */
  private record(input: {
    scoreId: ScoreId;
    decision: "approved" | "disabled";
    reason: string;
    clinicalOwnerId?: string;
    reviewDue?: string;
    by: { id: string; kind: string };
    at?: Date;
  }): ApprovalRow {
    const { scoreId, decision, by } = input;
    if (!(SCORE_IDS as readonly string[]).includes(scoreId)) {
      throw new Refusal(`unknown score ${scoreId}`, 400);
    }
    const reason = (input.reason ?? "").trim();
    // The same bar as breaking the glass: a decision with no stated basis
    // cannot be reviewed, and "ok" is not a basis.
    if (reason.length < 12) {
      throw new Refusal(
        `a written reason of at least 12 characters is required to ${decision === "approved" ? "approve" : "disable"} ${scoreId}`,
        400
      );
    }
    if (!by?.id) throw new Refusal("the operator recording the decision must be identified", 400);

    let ownerId: string | null = null;
    let ownerDisplay: string | null = null;
    let reviewDue: string | null = null;

    if (decision === "approved") {
      if (!input.clinicalOwnerId) {
        throw new Refusal(
          `approving ${scoreId} requires the practitioner who owns it clinically; an approval nobody owns cannot be reviewed`,
          400
        );
      }
      // Tenant-scoped by the directory, so one site cannot name another's
      // clinician. Retired is refused as well as unknown: an approval resting
      // on somebody who has left is not a live accountability.
      const owner = this.directory.resolve("practitioner", input.clinicalOwnerId);
      if (!owner.known) {
        throw new Refusal(
          `no practitioner ${input.clinicalOwnerId} in the directory; a clinical owner must be a registered practitioner`,
          400
        );
      }
      if (!owner.active) {
        throw new Refusal(
          `practitioner ${input.clinicalOwnerId} was retired on ${owner.retiredAt}; a retired clinician cannot own a live approval`,
          400
        );
      }
      ownerId = owner.id;
      ownerDisplay = owner.display;

      if (!input.reviewDue || !isIsoDate(input.reviewDue)) {
        throw new Refusal(
          `approving ${scoreId} requires an explicit review date (ISO 8601); none is computed, because a date this system picked is not a commitment anybody made`,
          400
        );
      }
      reviewDue = input.reviewDue;
    }

    const at = (input.at ?? new Date()).toISOString();
    const prior = this.latest(scoreId);
    const row: ApprovalRow = {
      id: randomUUID(),
      scoreId,
      // Always the version running now: a decision is about the arithmetic in
      // front of the person making it.
      implementationVersion: SCORE_DEFINITIONS[scoreId].implementationVersion,
      decision,
      reason,
      clinicalOwnerId: ownerId,
      clinicalOwnerDisplay: ownerDisplay,
      reviewDue,
      recordedBy: { id: by.id, kind: by.kind },
      supersedes: prior?.id ?? null,
      recordedAt: at,
    };
    this.db.sql
      .prepare(
        `INSERT INTO score_approvals
           (tenant_id, id, score_id, implementation_version, decision, reason,
            clinical_owner_id, clinical_owner_display, review_due,
            recorded_by_id, recorded_by_kind, supersedes, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        this.db.tenantId, row.id, row.scoreId, row.implementationVersion, row.decision, row.reason,
        row.clinicalOwnerId, row.clinicalOwnerDisplay, row.reviewDue,
        row.recordedBy.id, row.recordedBy.kind, row.supersedes, row.recordedAt
      );
    return row;
  }

  /** Approves a score for use here, or renews one by recording a new decision. */
  approve(input: {
    scoreId: ScoreId;
    clinicalOwnerId: string;
    reviewDue: string;
    reason: string;
    by: { id: string; kind: string };
    at?: Date;
  }): ApprovalRow {
    return this.record({ ...input, decision: "approved" });
  }

  /** Withdraws a score from use. Requires a reason, like every other decision. */
  disable(input: {
    scoreId: ScoreId;
    reason: string;
    by: { id: string; kind: string };
    at?: Date;
  }): ApprovalRow {
    return this.record({ ...input, decision: "disabled" });
  }
}
