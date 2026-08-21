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
  /** When the notice was handed to the delivery machinery, if it ever was. */
  notice_dispatched_at: string | null;
  /** The message it became, so what was sent can be found and read. */
  notice_message_id: string | null;
  /** Why nothing was sent. A notice that cannot be addressed says so. */
  notice_error: string | null;
  created_at: string;
}

/**
 * What a deployment is handed when an override needs telling the patient about.
 *
 * Deliberately not an address. Portage holds no contact details — `patient_index`
 * carries a name and a birth date and nothing to reach anybody by — so it
 * cannot resolve where this should go, and a system that invents a destination
 * for a disclosure notice sends somebody else's private business to a wrong
 * number. Routing belongs to whatever the deployment configures downstream and
 * already knows how to reach patients; this is the fact that needs sending.
 */
export interface BreakGlassNotice {
  overrideId: string;
  patientId: string;
  subjectId: string;
  subjectKind: string;
  reason: string;
  declaredAt: string;
  expiresAt: string;
  directiveId: string | null;
}

/**
 * Publishes a notice, and returns the id of the message it became.
 *
 * Throwing is a real outcome and is recorded rather than swallowed: a notice
 * nobody could address stays on `pendingNotification()` with a reason attached,
 * which is what makes an un-sendable notice visible instead of indistinguishable
 * from one nobody has got to yet.
 */
export interface NoticeDispatcher {
  dispatch(notice: BreakGlassNotice): string;
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

/**
 * What this caller may not see of this patient, separated by how much of it.
 *
 * A directive that names no entry types withholds the record; a directive
 * narrowed by `scope` withholds part of it. Collapsing those two into one
 * yes-or-no is what made a partial lockbox unusable: the only safe answer to
 * "may they read?" for a caller that could be reading anything is no, so a
 * patient who locked one section lost the whole chart.
 *
 * Keeping them apart lets the caller answer honestly at its own granularity. A
 * route serving one entry type asks about that type and gets a precise answer.
 * The assembled chart asks about all of them, serves the sections that are not
 * withheld, and — because this is a summary and a summary is read as complete
 * — says on its face which sections are missing and that a directive is why.
 */
export interface ReadRestrictions {
  /** An override is in force, so nothing is withheld. */
  underBreakGlass?: BreakGlassRow;
  /**
   * A directive that withholds the record as a whole, rather than a part.
   * A route cannot serve anything past this.
   */
  blocking?: DirectiveRow;
  /** Entry types withheld by a narrowed directive, and which directive. */
  withheldTypes: Map<string, DirectiveRow>;
}

/** How long an override lasts unless a deployment says otherwise. */
const DEFAULT_OVERRIDE_HOURS = 4;

export class ConsentDirectives {
  private db: Db;
  private overrideHours: number;
  private dispatcher: NoticeDispatcher | null;

  /**
   * The dispatcher is optional, and its absence is honest rather than silent:
   * with none configured an override lands on `pendingNotification()` exactly
   * as it did before, and the queue is still the guarantee. What changes when
   * one is configured is that the queue starts draining itself.
   */
  constructor(db: Db, opts: { overrideHours?: number; dispatcher?: NoticeDispatcher } = {}) {
    this.db = db;
    this.overrideHours = opts.overrideHours ?? DEFAULT_OVERRIDE_HOURS;
    this.dispatcher = opts.dispatcher ?? null;
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
    const r = this.restrictionsFor(input, asOf);
    if (r.underBreakGlass) {
      return { allowed: true, underBreakGlass: r.underBreakGlass, reason: "emergency override in force" };
    }
    if (r.blocking) {
      return { allowed: false, withheldBy: r.blocking, reason: "this record is withheld by a patient directive" };
    }
    // A caller that named its entry type is asking a precise question and gets
    // a precise answer. One that named none could be reading anything,
    // including the withheld part, so any narrowed directive stops it — see
    // `applies()` for why that asymmetry is the safe direction. A caller that
    // can serve its answer section by section should be asking
    // `restrictionsFor()` rather than this.
    const withheld = input.entryType
      ? r.withheldTypes.get(input.entryType)
      : r.withheldTypes.values().next().value;
    if (withheld) {
      return { allowed: false, withheldBy: withheld, reason: "this record is withheld by a patient directive" };
    }
    return { allowed: true, reason: "no directive applies" };
  }

  /**
   * Everything standing between this caller and this patient's record, split
   * into what withholds the whole of it and what withholds a part.
   *
   * The question `mayRead()` cannot answer for a caller that serves more than
   * one kind of thing. A chart is not one entry type, so "may they read the
   * chart" has no honest yes-or-no answer when the patient has locked their
   * counselling notes and nothing else.
   */
  restrictionsFor(
    input: { subjectId: string; organizationId?: string; patientId: string },
    asOf = new Date().toISOString()
  ): ReadRestrictions {
    const live = this.liveOverride(input.subjectId, input.patientId, asOf);
    if (live) return { underBreakGlass: live, withheldTypes: new Map() };

    const withheldTypes = new Map<string, DirectiveRow>();
    let blocking: DirectiveRow | undefined;
    for (const d of this.directivesFor(input.patientId, asOf)) {
      if (!this.targets(d, input)) continue;
      if (!d.scope) {
        // The first unscoped directive settles it; nothing narrower can widen
        // what a whole-record directive already withholds.
        blocking ??= d;
        continue;
      }
      for (const t of JSON.parse(d.scope) as string[]) {
        // First directive to name a type owns the refusal, so the reason a
        // clinician is shown is the one that was recorded first rather than
        // whichever happened to sort last.
        if (!withheldTypes.has(t)) withheldTypes.set(t, d);
      }
    }
    return { blocking, withheldTypes };
  }

  /**
   * Whether this directive is aimed at this caller at all.
   *
   * Only the "who" half. What a directive covers — the whole record or the
   * entry types in its `scope` — is decided by `restrictionsFor()`, because
   * that answer is not a boolean and squeezing it into one is what made a
   * partial lockbox behave as no lockbox at all.
   *
   * Fails closed on the organization, and that is the design rather than a
   * detail of it. `withhold-from-organization` can only be honoured by a
   * caller that says which organization it speaks for, and no `Principal`
   * carries one yet. Matching against `undefined` made every such directive
   * permanently inert — recorded, reported to the patient as active, and
   * enforced by nothing. Until organization identity reaches the auth layer, a
   * caller that cannot say it is outside the withheld organization is treated
   * as possibly inside it.
   *
   * The two directions cost different things. Over-withholding puts a
   * clinician in front of a refusal they can break glass through in seconds,
   * loudly and on the record. Under-withholding hands the record to exactly
   * the person the patient excluded, silently. Those are not symmetrical, and
   * this is not symmetrical about them.
   */
  private targets(d: DirectiveRow, input: { subjectId: string; organizationId?: string }): boolean {
    if (d.kind === "withhold-all") return true;
    if (d.kind === "withhold-from-provider") return d.target_id === input.subjectId;
    // A caller that says which organization it is gets an exact answer: a
    // directive against organization A does not withhold from organization B.
    // One that cannot say is still stopped, because `undefined` must not read
    // as "some other organization, so let them through" — the asymmetry is
    // deliberate and is the safe direction.
    if (d.kind === "withhold-from-organization") {
      return input.organizationId === undefined || d.target_id === input.organizationId;
    }
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
   * Notifying the patient is a separate step, and this does not take it.
   * Saying so plainly because an earlier version of this comment claimed
   * `notifyPatient` ran here and it never did — a docstring asserting a
   * guarantee the code does not provide is worse than no docstring, because
   * it is the thing a reviewer checks instead of the code. What is true is
   * that the row lands with `patient_notified_at` NULL, so the override is on
   * `pendingNotification()` from the moment it exists and stays there until
   * somebody records that the patient was told. The queue is the guarantee;
   * draining it is the deployment's job, and `GET /api/clinical/break-glass`
   * is where an operator can see what is owed.
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
    // The directive this override goes past, recorded on the row so a privacy
    // office reading it later can see what was overridden. Any directive aimed
    // at this caller counts, narrowed or not: breaking glass past a lockbox on
    // one section is still breaking glass past that patient's instruction.
    const directive = this.directivesFor(input.patientId, now.toISOString()).find((d) =>
      this.targets(d, { subjectId: input.by.actorId })
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

    // Attempted here, and never allowed to fail the override. A clinician
    // standing over an unconscious patient must not be stopped because a
    // notification queue is unreachable — that would make the safety valve
    // depend on the thing least likely to be working during an incident. A
    // failure is recorded on the row and the override stands.
    this.dispatchNotice(id);
    return this.override(id)!;
  }

  /**
   * Hands the notice to whatever the deployment configured, and records what
   * happened either way.
   *
   * Safe to call again: a notice already dispatched is not sent twice, because
   * telling a patient twice that their record was opened is its own small harm
   * and because a retry loop that duplicates disclosures is worse than one that
   * gives up. A previous *failure* is retried, which is the case worth having.
   */
  dispatchNotice(overrideId: string): BreakGlassRow {
    const row = this.override(overrideId);
    if (!row) throw new Error(`no override ${overrideId}`);
    if (row.notice_dispatched_at) return row;
    if (!this.dispatcher) return row;

    try {
      const messageId = this.dispatcher.dispatch({
        overrideId: row.id,
        patientId: row.patient_id,
        subjectId: row.subject_id,
        subjectKind: row.subject_kind,
        reason: row.reason,
        declaredAt: row.declared_at,
        expiresAt: row.expires_at,
        directiveId: row.directive_id,
      });
      this.db.sql
        .prepare(
          `UPDATE break_glass SET notice_dispatched_at = ?, notice_message_id = ?, notice_error = NULL
             WHERE tenant_id = ? AND id = ?`
        )
        .run(new Date().toISOString(), messageId, this.db.tenantId, overrideId);
    } catch (err) {
      // Recorded rather than thrown. The override is already in force and the
      // read is already happening; what is at stake here is whether anybody
      // can see that the patient has not been told, and a swallowed exception
      // is exactly how that becomes invisible.
      this.db.sql
        .prepare("UPDATE break_glass SET notice_error = ? WHERE tenant_id = ? AND id = ?")
        .run(err instanceof Error ? err.message : String(err), this.db.tenantId, overrideId);
    }
    return this.override(overrideId)!;
  }

  /**
   * Overrides the patient still has not been told about after `hours`.
   *
   * The queue on its own has no upper bound on how long somebody can go
   * untold, and "loud" that depends on a person working through a list every
   * day is loud only as long as they do. This is the escalation: what is late,
   * oldest first, whether or not anything was ever sent.
   */
  overdueNotification(hours = 24, asOf = new Date().toISOString()): BreakGlassRow[] {
    const cutoff = new Date(new Date(asOf).getTime() - hours * 3_600_000).toISOString();
    return this.db.sql
      .prepare(
        `SELECT * FROM break_glass
          WHERE tenant_id = ? AND patient_notified_at IS NULL AND declared_at <= ?
          ORDER BY declared_at`
      )
      .all(this.db.tenantId, cutoff) as unknown as BreakGlassRow[];
  }

  /** Notices that were attempted and could not be sent. */
  undeliveredNotices(): BreakGlassRow[] {
    return this.db.sql
      .prepare(
        `SELECT * FROM break_glass
          WHERE tenant_id = ? AND notice_error IS NOT NULL AND notice_dispatched_at IS NULL
          ORDER BY declared_at`
      )
      .all(this.db.tenantId) as unknown as BreakGlassRow[];
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
