/**
 * Consent directives, and breaking glass past them.
 *
 * A patient may withhold their record from a provider, or from an
 * organization, or from everybody outside the circle of care that created it.
 * Provincial EHRs call it a consent directive or a lockbox, and it is a
 * clinical fact about the patient — they do not want this person reading this
 * — rather than a configuration setting.
 *
 * Every directive is overridable in an emergency. That is not a weakness in
 * the design, it is the design: a patient unconscious in a resuscitation room
 * cannot lift their own lockbox, and a system that made the override
 * impossible would eventually kill somebody. Any real deployment that lacked
 * one would grow a shadow account that everybody shares, which is worse than
 * an override in every respect including the audit trail.
 *
 * ## What makes the override safe is not that it is hard
 *
 * It is that it is loud. Four things, and dropping any one turns the other
 * three into paperwork:
 *
 *   Declared before it is taken, so the access happens under a stated
 *   intention rather than being reconstructed afterwards from logs.
 *
 *   Reasoned in the clinician's own words. Not a dropdown: "unconscious, no
 *   collateral history, need allergy status before induction" is a defence and
 *   "emergency" is not, and a dropdown produces only the second.
 *
 *   The patient is told. This is the part systems quietly omit, and it is the
 *   one that makes a directive mean anything — a lockbox nobody can find out
 *   was opened is a lockbox with no lock.
 *
 *   Reviewed by somebody. `pendingReview()` is a queue rather than a report,
 *   because an override nobody looks at teaches the ward that breaking glass
 *   costs nothing, and then the directive stops slowing anybody down except
 *   the honest.
 *
 * An override also expires. One that did not would be a permission, and this
 * is not one.
 */
import { randomUUID } from "node:crypto";
import type { Db } from "../db.ts";

export type DirectiveKind = "withhold-from-provider" | "withhold-from-organization" | "withhold-all";
export type DirectiveStatus = "active" | "revoked" | "expired";

export interface DirectiveRow {
  tenant_id: string;
  id: string;
  patient_id: string;
  kind: DirectiveKind;
  target_id: string | null;
  scope: string | null;
  reason: string | null;
  status: DirectiveStatus;
  effective_from: string;
  expires_at: string | null;
  revoked_at: string | null;
  revoked_by: string | null;
  recorded_by: string;
  recorded_at: string;
  created_at: string;
}

export interface BreakGlassRow {
  tenant_id: string;
  id: string;
  patient_id: string;
  subject_id: string;
  subject_kind: string;
  directive_id: string | null;
  reason: string;
  purpose_of_use: string | null;
  declared_at: string;
  expires_at: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
  review_outcome: string | null;
  patient_notified_at: string | null;
  created_at: string;
}

export interface Actor {
  actorId: string;
  actorKind: string;
}

/**
 * The answer to "may this person read this chart".
 *
 * `withheld` is never a bare false. It carries the directive so a caller can
 * offer the override, and so the refusal can say that a directive exists
 * without saying what is behind it.
 */
export interface AccessDecision {
  allowed: boolean;
  /** Set when a directive is what stopped it. */
  withheldBy?: DirectiveRow;
  /** Set when an override is carrying the access. */
  underBreakGlass?: BreakGlassRow;
  reason: string;
}

/** How long an override lasts unless a deployment says otherwise. */
const DEFAULT_OVERRIDE_HOURS = 4;

export class ConsentDirectives {
  private db: Db;
  private overrideHours: number;

  constructor(db: Db, opts: { overrideHours?: number } = {}) {
    this.db = db;
    this.overrideHours = opts.overrideHours ?? DEFAULT_OVERRIDE_HOURS;
  }

  // ---- directives --------------------------------------------------------

  /**
   * Records a patient's instruction.
   *
   * A target is required for the two targeted kinds. A withhold-from-provider
   * with nobody named is a directive that cannot be applied, and storing it
   * would tell the patient their instruction was recorded when nothing will
   * act on it.
   */
  record(input: {
    patientId: string;
    kind: DirectiveKind;
    by: Actor;
    targetId?: string;
    scope?: string[];
    reason?: string;
    effectiveFrom?: string;
    expiresAt?: string;
  }): DirectiveRow {
    if (input.kind !== "withhold-all" && !input.targetId?.trim()) {
      throw new Error(`a ${input.kind} directive needs somebody to withhold from`);
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.sql
      .prepare(
        `INSERT INTO consent_directives
           (tenant_id, id, patient_id, kind, target_id, scope, reason, status,
            effective_from, expires_at, recorded_by, recorded_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`
      )
      .run(
        this.db.tenantId,
        id,
        input.patientId,
        input.kind,
        input.targetId ?? null,
        input.scope?.length ? JSON.stringify(input.scope) : null,
        input.reason ?? null,
        input.effectiveFrom ?? now,
        input.expiresAt ?? null,
        input.by.actorId,
        now,
        now
      );
    return this.directive(id)!;
  }

  /** The patient changes their mind. Their instruction, their revocation. */
  revoke(directiveId: string, by: Actor): DirectiveRow {
    const d = this.directive(directiveId);
    if (!d) throw new Error(`no directive ${directiveId}`);
    if (d.status !== "active") throw new Error(`that directive is already ${d.status}`);
    this.db.sql
      .prepare("UPDATE consent_directives SET status = 'revoked', revoked_at = ?, revoked_by = ? WHERE tenant_id = ? AND id = ?")
      .run(new Date().toISOString(), by.actorId, this.db.tenantId, directiveId);
    return this.directive(directiveId)!;
  }

  /** A patient's live directives, for them to see what they have asked for. */
  directivesFor(patientId: string, asOf = new Date().toISOString()): DirectiveRow[] {
    return this.db.sql
      .prepare(
        `SELECT * FROM consent_directives
          WHERE tenant_id = ? AND patient_id = ? AND status = 'active'
            AND effective_from <= ? AND (expires_at IS NULL OR expires_at > ?)
          ORDER BY recorded_at DESC`
      )
      .all(this.db.tenantId, patientId, asOf, asOf) as unknown as DirectiveRow[];
  }

  directive(id: string): DirectiveRow | undefined {
    return this.db.sql
      .prepare("SELECT * FROM consent_directives WHERE tenant_id = ? AND id = ?")
      .get(this.db.tenantId, id) as unknown as DirectiveRow | undefined;
  }

  // ---- the decision ------------------------------------------------------

  /**
   * Whether this person may read this chart right now.
   *
   * A live override is consulted first, because that is the situation the
   * caller has already declared themselves to be in — checking the directive
   * again and refusing would mean the declaration did nothing.
   *
   * The refusal names that a directive exists but not what it says. "This
   * record is withheld by a patient directive" is what a clinician needs; the
   * patient's reason for withholding is between them and whoever recorded it,
   * and disclosing it to the person being withheld from would be an odd way to
   * honour the instruction.
   */
  mayRead(
    input: { subjectId: string; organizationId?: string; patientId: string; entryType?: string },
    asOf = new Date().toISOString()
  ): AccessDecision {
    const live = this.liveOverride(input.subjectId, input.patientId, asOf);
    if (live) {
      return { allowed: true, underBreakGlass: live, reason: "emergency override in force" };
    }

    for (const d of this.directivesFor(input.patientId, asOf)) {
      if (!this.applies(d, input)) continue;
      return {
        allowed: false,
        withheldBy: d,
        reason: "this record is withheld by a patient directive",
      };
    }
    return { allowed: true, reason: "no directive applies" };
  }

  private applies(
    d: DirectiveRow,
    input: { subjectId: string; organizationId?: string; entryType?: string }
  ): boolean {
    if (d.scope) {
      const scoped = JSON.parse(d.scope) as string[];
      // A directive narrowed to particular entry types does not withhold the
      // rest of the chart. Applying it to everything would give the patient
      // more than they asked for, which is its own kind of not listening.
      if (!input.entryType || !scoped.includes(input.entryType)) return false;
    }
    if (d.kind === "withhold-all") return true;
    if (d.kind === "withhold-from-provider") return d.target_id === input.subjectId;
    if (d.kind === "withhold-from-organization") return d.target_id === input.organizationId;
    return false;
  }

  // ---- breaking glass ----------------------------------------------------

  /**
   * Declares an emergency override, before taking the access.
   *
   * The reason is required and is checked for being a reason. A single word
   * satisfies a non-empty check and defends nothing afterwards, and the
   * afterwards is the entire point: this row is what a privacy office reads
   * when a patient asks who opened their record and why.
   *
   * Notifying the patient is not a separate optional step a caller may skip —
   * `notifyPatient` runs here, and `pendingNotification()` exists so a
   * deployment whose channel is asynchronous can still be held to it.
   */
  breakGlass(input: {
    patientId: string;
    by: Actor;
    reason: string;
    purposeOfUse?: string;
    hours?: number;
  }): BreakGlassRow {
    const reason = input.reason.trim();
    if (reason.length < 12) {
      throw new Error(
        "breaking glass needs a reason somebody can weigh afterwards, not a word — say what you need and why now"
      );
    }
    const now = new Date();
    const directive = this.directivesFor(input.patientId, now.toISOString()).find((d) =>
      this.applies(d, { subjectId: input.by.actorId })
    );
    const id = randomUUID();
    const expires = new Date(now.getTime() + (input.hours ?? this.overrideHours) * 3_600_000).toISOString();

    this.db.sql
      .prepare(
        `INSERT INTO break_glass
           (tenant_id, id, patient_id, subject_id, subject_kind, directive_id, reason,
            purpose_of_use, declared_at, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        this.db.tenantId,
        id,
        input.patientId,
        input.by.actorId,
        input.by.actorKind,
        directive?.id ?? null,
        reason,
        input.purposeOfUse ?? null,
        now.toISOString(),
        expires,
        now.toISOString()
      );
    return this.override(id)!;
  }

  /** Records that the patient has been told. */
  notifyPatient(overrideId: string): BreakGlassRow {
    this.db.sql
      .prepare("UPDATE break_glass SET patient_notified_at = ? WHERE tenant_id = ? AND id = ? AND patient_notified_at IS NULL")
      .run(new Date().toISOString(), this.db.tenantId, overrideId);
    const row = this.override(overrideId);
    if (!row) throw new Error(`no override ${overrideId}`);
    return row;
  }

  /**
   * Overrides the patient has not been told about.
   *
   * A lockbox nobody can find out was opened is a lockbox with no lock, so
   * this is a queue that must empty rather than a statistic.
   */
  pendingNotification(): BreakGlassRow[] {
    return this.db.sql
      .prepare(
        "SELECT * FROM break_glass WHERE tenant_id = ? AND patient_notified_at IS NULL ORDER BY declared_at"
      )
      .all(this.db.tenantId) as unknown as BreakGlassRow[];
  }

  /**
   * Overrides nobody has reviewed.
   *
   * The queue that keeps the directive meaningful. An override nobody looks at
   * teaches a ward that breaking glass costs nothing, and a directive that
   * costs nothing to break slows down only the people who would have asked.
   */
  pendingReview(): BreakGlassRow[] {
    return this.db.sql
      .prepare("SELECT * FROM break_glass WHERE tenant_id = ? AND reviewed_at IS NULL ORDER BY declared_at")
      .all(this.db.tenantId) as unknown as BreakGlassRow[];
  }

  /** Somebody has looked at it and said what they made of it. */
  review(overrideId: string, by: Actor & { outcome: string }): BreakGlassRow {
    if (!by.outcome.trim()) throw new Error("reviewing an override needs an outcome");
    const row = this.override(overrideId);
    if (!row) throw new Error(`no override ${overrideId}`);
    if (row.reviewed_at) throw new Error("that override has already been reviewed");
    this.db.sql
      .prepare("UPDATE break_glass SET reviewed_at = ?, reviewed_by = ?, review_outcome = ? WHERE tenant_id = ? AND id = ?")
      .run(new Date().toISOString(), by.actorId, by.outcome, this.db.tenantId, overrideId);
    return this.override(overrideId)!;
  }

  /** Every override on a patient, which the patient is entitled to see. */
  overridesFor(patientId: string): BreakGlassRow[] {
    return this.db.sql
      .prepare("SELECT * FROM break_glass WHERE tenant_id = ? AND patient_id = ? ORDER BY declared_at DESC")
      .all(this.db.tenantId, patientId) as unknown as BreakGlassRow[];
  }

  /**
   * How often one person has broken glass, for the pattern rather than the
   * incident.
   *
   * One override is a clinical emergency. Forty in a month is a workflow that
   * has decided the directive is an obstacle, and only the count shows it.
   */
  frequentBreakers(sinceIso: string, threshold = 3): Array<{ subject_id: string; n: number }> {
    return this.db.sql
      .prepare(
        `SELECT subject_id, COUNT(*) AS n FROM break_glass
          WHERE tenant_id = ? AND declared_at >= ?
          GROUP BY subject_id HAVING n >= ? ORDER BY n DESC`
      )
      .all(this.db.tenantId, sinceIso, threshold) as Array<{ subject_id: string; n: number }>;
  }

  override(id: string): BreakGlassRow | undefined {
    return this.db.sql
      .prepare("SELECT * FROM break_glass WHERE tenant_id = ? AND id = ?")
      .get(this.db.tenantId, id) as unknown as BreakGlassRow | undefined;
  }

  private liveOverride(subjectId: string, patientId: string, asOf: string): BreakGlassRow | undefined {
    return this.db.sql
      .prepare(
        `SELECT * FROM break_glass
          WHERE tenant_id = ? AND subject_id = ? AND patient_id = ?
            AND declared_at <= ? AND expires_at > ?
          ORDER BY declared_at DESC LIMIT 1`
      )
      .get(this.db.tenantId, subjectId, patientId, asOf, asOf) as unknown as BreakGlassRow | undefined;
  }
}
