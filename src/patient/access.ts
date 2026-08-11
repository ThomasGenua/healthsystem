/**
 * What a patient can see of their own record, and who else may see it.
 *
 * Section 11 has two failures that nothing else in this system has, and they
 * pull in opposite directions.
 *
 * ## Delegated authority that never ends
 *
 * A parent's access to a child's chart is correct until a birthday and wrong
 * afterwards — and nothing about that day generates an event. No message
 * arrives, no status changes, no queue fills up. The grant simply keeps
 * working, and a sixteen-year-old's mental health notes stay readable by
 * someone who is no longer entitled to them, for years, with nobody doing
 * anything wrong.
 *
 * The same shape covers a substitute decision-maker whose authority ended when
 * capacity returned, and a representative named during a hospital admission
 * that finished in 2019.
 *
 * So authority is time-bounded by construction. A delegated grant without an
 * expiry is refused rather than defaulted, the check is against the clock
 * rather than against a status somebody has to remember to change, and
 * `expiring()` exists so a renewal is a decision somebody makes rather than a
 * lapse somebody discovers.
 *
 * ## Release timing
 *
 * Immediate release is the default and it is right: a patient waiting a week
 * for a normal result while their clinician's inbox fills is the harm the
 * information-blocking rules were written against.
 *
 * But "immediate, no exceptions" means a person can learn they have cancer
 * from a phone at eleven at night with nobody to ask. A system that cannot
 * express that has not solved the problem — it has picked the other side of
 * it. So a hold is possible and is deliberately hard to abuse: bounded (every
 * hold has an end), reasoned, attributed, and *visible*. The patient sees that
 * something is being held and when it lifts.
 *
 * That last part is the one that matters. A silent hold is indistinguishable
 * from a result that never came back, which is the practice the release rules
 * exist to stop — and it is worse, because the patient has no idea there is
 * anything to ask about.
 */
import { randomUUID } from "node:crypto";
import type { Db } from "../db.ts";
import type { OrderStore, ResultRow } from "../orders/store.ts";

export type Relationship = "self" | "parent-guardian" | "substitute-decision-maker" | "representative";
export type Extent = "full" | "summary";

/**
 * Why a result is being held, as a category the patient is shown.
 *
 * A category rather than the clinical justification, because the patient
 * should not have to read a note about themselves written for someone else in
 * order to understand why they are waiting.
 */
export type HoldCategory = "clinician-will-discuss" | "identity-unconfirmed" | "third-party-information" | "patient-request";

const HOLD_TEXT: Record<HoldCategory, string> = {
  "clinician-will-discuss": "Your clinician will discuss this result with you.",
  "identity-unconfirmed": "This result is being confirmed before release.",
  "third-party-information": "This result mentions someone else and is being reviewed.",
  "patient-request": "You asked us to hold this result.",
};

export interface AuthorityRow {
  tenant_id: string;
  id: string;
  patient_id: string;
  subject_id: string;
  relationship: Relationship;
  extent: Extent;
  expires_at: string | null;
  revoked_at: string | null;
  revoked_by: string | null;
  revoke_reason: string | null;
  granted_by: string;
  granted_at: string;
  reason: string | null;
  created_at: string;
}

export interface Actor {
  actorId: string;
  actorKind: string;
}

/** What a patient sees of one result. */
export interface PatientResult {
  resultId: string;
  display: string;
  reportedAt: string;
  /** Present only once released. */
  value?: string;
  unit?: string | null;
  abnormalFlag?: string;
  /** Present only while held. */
  held?: { because: string; until: string | null };
}

export class PatientAccess {
  private db: Db;
  private orders: OrderStore;

  constructor(db: Db, orders: OrderStore) {
    this.db = db;
    this.orders = orders;
  }

  // ---- authority ---------------------------------------------------------

  /** The patient's own access to their own record. Does not expire. */
  grantSelf(patientId: string, subjectId: string, by: Actor): AuthorityRow {
    return this.insertGrant({
      patientId,
      subjectId,
      relationship: "self",
      extent: "full",
      expiresAt: null,
      by,
    });
  }

  /**
   * Gives somebody else access, until a date.
   *
   * The expiry is required and has no default. A default would be this
   * module's guess written into the record as somebody's decision, and the
   * decision — when does this end — is the entire safeguard. For a parent it
   * is the age of majority in the jurisdiction; for a substitute decision-maker
   * it is a review date; neither is something a library should choose.
   */
  grantProxy(input: {
    patientId: string;
    subjectId: string;
    relationship: Exclude<Relationship, "self">;
    expiresAt: string;
    by: Actor;
    extent?: Extent;
    reason?: string;
  }): AuthorityRow {
    if (!input.expiresAt) {
      throw new Error("delegated access needs an expiry; an authority that never ends is the failure this guards against");
    }
    if (new Date(input.expiresAt).getTime() <= Date.now()) {
      throw new Error("that expiry is already past");
    }
    return this.insertGrant({ ...input, expiresAt: input.expiresAt });
  }

  /** Ends a grant early, with a reason. */
  revoke(authorityId: string, by: Actor & { reason: string }): AuthorityRow {
    if (!by.reason.trim()) throw new Error("revoking access needs a reason");
    const row = this.authority(authorityId);
    if (!row) throw new Error(`no authority ${authorityId}`);
    if (row.revoked_at) throw new Error("that access is already revoked");
    this.db.sql
      .prepare(
        "UPDATE patient_authority SET revoked_at = ?, revoked_by = ?, revoke_reason = ? WHERE tenant_id = ? AND id = ?"
      )
      .run(new Date().toISOString(), by.actorId, by.reason, this.db.tenantId, authorityId);
    return this.authority(authorityId)!;
  }

  /**
   * Whether this person may see this chart right now.
   *
   * Against the clock, not against a status. A grant that expired yesterday is
   * not authority, whether or not anything has run since.
   */
  may(subjectId: string, patientId: string, asOf = new Date().toISOString()): AuthorityRow | undefined {
    const rows = this.db.sql
      .prepare(
        `SELECT * FROM patient_authority
          WHERE tenant_id = ? AND subject_id = ? AND patient_id = ? AND revoked_at IS NULL
            AND (expires_at IS NULL OR expires_at > ?)
          ORDER BY granted_at DESC`
      )
      .all(this.db.tenantId, subjectId, patientId, asOf) as unknown as AuthorityRow[];
    return rows[0];
  }

  /**
   * Grants about to lapse.
   *
   * So a renewal is a decision somebody makes rather than a lapse somebody
   * discovers. A parent who still needs access to a disabled adult child's
   * chart should be asked, not silently cut off — and equally, one who should
   * not have it should stop, on the day.
   */
  expiring(withinDays = 30, asOf = new Date().toISOString()): AuthorityRow[] {
    const until = new Date(new Date(asOf).getTime() + withinDays * 86_400_000).toISOString();
    return this.db.sql
      .prepare(
        `SELECT * FROM patient_authority
          WHERE tenant_id = ? AND revoked_at IS NULL AND expires_at IS NOT NULL
            AND expires_at > ? AND expires_at <= ?
          ORDER BY expires_at`
      )
      .all(this.db.tenantId, asOf, until) as unknown as AuthorityRow[];
  }

  /** Everyone with live access to a chart, for the patient to review. */
  whoCanSee(patientId: string, asOf = new Date().toISOString()): AuthorityRow[] {
    return this.db.sql
      .prepare(
        `SELECT * FROM patient_authority
          WHERE tenant_id = ? AND patient_id = ? AND revoked_at IS NULL
            AND (expires_at IS NULL OR expires_at > ?)
          ORDER BY relationship, granted_at`
      )
      .all(this.db.tenantId, patientId, asOf) as unknown as AuthorityRow[];
  }

  authority(id: string): AuthorityRow | undefined {
    return this.db.sql
      .prepare("SELECT * FROM patient_authority WHERE tenant_id = ? AND id = ?")
      .get(this.db.tenantId, id) as unknown as AuthorityRow | undefined;
  }

  // ---- release -----------------------------------------------------------

  /**
   * Holds a result back from the patient view, until a date.
   *
   * Bounded, reasoned, attributed and visible. The end date is required for
   * the same reason a proxy's expiry is: a hold with no end is a result
   * withheld indefinitely, which is exactly the practice being legislated
   * against.
   */
  hold(input: {
    resultId: string;
    category: HoldCategory;
    releaseAt: string;
    by: Actor;
    reason: string;
  }): void {
    if (!input.reason.trim()) throw new Error("holding a result needs a reason");
    if (!input.releaseAt) throw new Error("a hold needs an end; a result held indefinitely is a result withheld");
    if (new Date(input.releaseAt).getTime() <= Date.now()) throw new Error("that release date is already past");
    const r = this.orders.result(input.resultId);
    if (!r) throw new Error(`no result ${input.resultId}`);

    this.db.sql
      .prepare(
        `INSERT INTO result_release
           (tenant_id, result_id, patient_id, state, hold_reason, hold_category, release_at, held_by, held_at, created_at)
         VALUES (?, ?, ?, 'held', ?, ?, ?, ?, ?, ?)
         ON CONFLICT(tenant_id, result_id) DO UPDATE SET
           state = 'held', hold_reason = excluded.hold_reason, hold_category = excluded.hold_category,
           release_at = excluded.release_at, held_by = excluded.held_by, held_at = excluded.held_at`
      )
      .run(
        this.db.tenantId,
        input.resultId,
        r.patient_id,
        input.reason,
        input.category,
        input.releaseAt,
        input.by.actorId,
        new Date().toISOString(),
        new Date().toISOString()
      );
  }

  /** Lifts a hold early, once the conversation has happened. */
  release(resultId: string, by: Actor): void {
    const now = new Date().toISOString();
    this.db.sql
      .prepare(
        `UPDATE result_release SET state = 'immediate', released_by = ?, released_at = ?
          WHERE tenant_id = ? AND result_id = ?`
      )
      .run(by.actorId, now, this.db.tenantId, resultId);
  }

  /**
   * Results as the patient sees them.
   *
   * A held result still appears, saying that it is held and when it lifts. It
   * is not omitted, because an omitted result is indistinguishable from one
   * that never came back — and the patient then has no idea there is anything
   * to ask about, which is the failure the whole release regime exists to
   * prevent.
   *
   * A hold whose date has passed is released by the clock. Nothing has to run.
   */
  resultsFor(patientId: string, asOf = new Date().toISOString()): PatientResult[] {
    const rows = this.db.sql
      .prepare(
        `SELECT r.*, rel.state AS rel_state, rel.hold_category AS rel_category, rel.release_at AS rel_release_at
           FROM order_results r
           LEFT JOIN result_release rel ON rel.tenant_id = r.tenant_id AND rel.result_id = r.id
          WHERE r.tenant_id = ? AND r.patient_id = ? AND r.result_status != 'cancelled'
            AND NOT EXISTS (
              SELECT 1 FROM order_results n WHERE n.tenant_id = ? AND n.supersedes = r.id
            )
          ORDER BY r.reported_at DESC`
      )
      .all(this.db.tenantId, patientId, this.db.tenantId) as unknown as Array<
      ResultRow & { rel_state: string | null; rel_category: HoldCategory | null; rel_release_at: string | null }
    >;

    return rows.map((r) => {
      const held = r.rel_state === "held" && (!r.rel_release_at || r.rel_release_at > asOf);
      if (!held) {
        return {
          resultId: r.id,
          display: r.display,
          reportedAt: r.reported_at,
          value: r.value,
          unit: r.unit,
          abnormalFlag: r.abnormal_flag,
        };
      }
      return {
        resultId: r.id,
        display: r.display,
        reportedAt: r.reported_at,
        held: {
          because: r.rel_category ? HOLD_TEXT[r.rel_category] : "This result is being reviewed.",
          until: r.rel_release_at,
        },
      };
    });
  }

  /** Holds still in force, so none of them is forgotten. */
  activeHolds(asOf = new Date().toISOString()): Array<{ result_id: string; patient_id: string; release_at: string | null }> {
    return this.db.sql
      .prepare(
        `SELECT result_id, patient_id, release_at FROM result_release
          WHERE tenant_id = ? AND state = 'held' AND (release_at IS NULL OR release_at > ?)
          ORDER BY release_at`
      )
      .all(this.db.tenantId, asOf) as never;
  }

  // ---- the patient's own access log --------------------------------------

  /** Records an access by a patient or their proxy. */
  logAccess(input: {
    patientId: string;
    subjectId: string;
    relationship: Relationship;
    action: string;
    outcome: "allowed" | "refused";
    resource?: string;
    detail?: string;
  }): void {
    this.db.sql
      .prepare(
        `INSERT INTO patient_access_log
           (tenant_id, patient_id, subject_id, relationship, at, action, resource, outcome, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        this.db.tenantId,
        input.patientId,
        input.subjectId,
        input.relationship,
        new Date().toISOString(),
        input.action,
        input.resource ?? null,
        input.outcome,
        input.detail ?? null
      );
  }

  /**
   * The patient's own view of who looked at their record.
   *
   * Section 11 requires a patient be able to see this, and a proxy's accesses
   * are in it: "my ex-husband opened my chart four times last month" is
   * precisely the thing a patient has a right to find out, and it is
   * unanswerable if proxy reads are logged as the patient's own.
   */
  accessLog(patientId: string, limit = 100): Array<{
    seq: number;
    at: string;
    subject_id: string;
    relationship: string;
    action: string;
    resource: string | null;
    outcome: string;
    detail: string | null;
  }> {
    return this.db.sql
      .prepare(
        `SELECT seq, at, subject_id, relationship, action, resource, outcome, detail
           FROM patient_access_log WHERE tenant_id = ? AND patient_id = ?
          ORDER BY seq DESC LIMIT ?`
      )
      .all(this.db.tenantId, patientId, limit) as never;
  }

  private insertGrant(input: {
    patientId: string;
    subjectId: string;
    relationship: Relationship;
    extent?: Extent;
    expiresAt: string | null;
    by: Actor;
    reason?: string;
  }): AuthorityRow {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.sql
      .prepare(
        `INSERT INTO patient_authority
           (tenant_id, id, patient_id, subject_id, relationship, extent, expires_at,
            granted_by, granted_at, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        this.db.tenantId,
        id,
        input.patientId,
        input.subjectId,
        input.relationship,
        input.extent ?? "full",
        input.expiresAt,
        input.by.actorId,
        now,
        input.reason ?? null,
        now
      );
    return this.authority(id)!;
  }
}
