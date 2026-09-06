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
import type { TaskStore } from "../work/tasks.ts";

export type Relationship = "self" | "parent-guardian" | "substitute-decision-maker" | "representative";
export type Extent = "full" | "summary";

/**
 * Capabilities a patient or proxy grant may exercise.
 *
 * A proxy's scope has to be data, not prose. "Help with appointments" must
 * not quietly become access to result values or private message bodies. The
 * patient themselves receive all of these; delegated grants name an explicit
 * subset and may never delegate again.
 */
export const PATIENT_PERMISSIONS = [
  "summary",
  "results",
  "appointments",
  "messages",
  "access-log",
  "requests",
  "delegates",
  "intake",
] as const;
export type PatientPermission = (typeof PATIENT_PERMISSIONS)[number];
const PROXY_PERMISSIONS = PATIENT_PERMISSIONS.filter((p) => p !== "delegates");

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
  /** JSON array. Nullable only on rows written before scoped grants existed. */
  permissions: string | null;
  /** Why this delegated access exists, separate from its scope and expiry. */
  purpose: string | null;
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

export type PatientRequestKind = "access" | "correction";
export interface PatientRequestRow {
  tenant_id: string;
  id: string;
  patient_id: string;
  kind: PatientRequestKind;
  target: string | null;
  detail: string;
  status: "submitted" | "completed" | "declined";
  submitted_by: string;
  relationship: Relationship;
  submitted_at: string;
  task_id: string;
  completed_at: string | null;
  outcome: string | null;
  created_at: string;
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
  private tasks: TaskStore | null;

  constructor(db: Db, orders: OrderStore, tasks: TaskStore | null = null) {
    this.db = db;
    this.orders = orders;
    this.tasks = tasks;
  }

  // ---- authority ---------------------------------------------------------

  /** The patient's own access to their own record. Does not expire. */
  grantSelf(patientId: string, subjectId: string, by: Actor): AuthorityRow {
    return this.insertGrant({
      patientId,
      subjectId,
      relationship: "self",
      extent: "full",
      permissions: [...PATIENT_PERMISSIONS],
      purpose: "patient access to own record",
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
    /** What this proxy may do. Explicit; no default broad grant. */
    permissions: PatientPermission[];
    /** Why the proxy needs access. Explicit and shown in the patient's review. */
    purpose: string;
    extent?: Extent;
  }): AuthorityRow {
    if (!input.expiresAt) {
      throw new Error("delegated access needs an expiry; an authority that never ends is the failure this guards against");
    }
    if (new Date(input.expiresAt).getTime() <= Date.now()) {
      throw new Error("that expiry is already past");
    }
    if (!input.purpose.trim()) {
      throw new Error("delegated access needs a purpose the patient can review");
    }
    if (!Array.isArray(input.permissions) || input.permissions.length === 0) {
      throw new Error("delegated access needs at least one explicit permission");
    }
    const unknown = input.permissions.filter((p) => !(PROXY_PERMISSIONS as readonly string[]).includes(p));
    if (unknown.length > 0) {
      throw new Error(`proxy permission not allowed: ${unknown.join(", ")}`);
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

  /** Every chart this OAuth subject may act for right now. */
  forSubject(subjectId: string, asOf = new Date().toISOString()): AuthorityRow[] {
    return this.db.sql
      .prepare(
        `SELECT * FROM patient_authority
          WHERE tenant_id = ? AND subject_id = ? AND revoked_at IS NULL
            AND (expires_at IS NULL OR expires_at > ?)
          ORDER BY relationship, granted_at`
      )
      .all(this.db.tenantId, subjectId, asOf) as unknown as AuthorityRow[];
  }

  /**
   * Every OAuth subject holding a live grant in this custodian, and the
   * charts each one reaches.
   *
   * Written for the development identity provider, which lists who may sign
   * in. It is the reverse of `forSubject` and it is deliberately bounded by
   * the tenant like everything else here: a picker that spanned custodians
   * would enumerate one clinic's delegates to another's, which is a
   * disclosure whether or not the environment is a demo.
   *
   * The relationship travels with each chart so a caregiver's picker can say
   * which chart is theirs and which they hold on somebody else's behalf. It
   * never names a chart the grant does not reach.
   */
  liveSubjects(asOf = new Date().toISOString()): Array<{
    subject: string;
    patients: Array<{ patientId: string; relationship: string }>;
  }> {
    const rows = this.db.sql
      .prepare(
        `SELECT subject_id, patient_id, relationship FROM patient_authority
          WHERE tenant_id = ? AND revoked_at IS NULL
            AND (expires_at IS NULL OR expires_at > ?)
          ORDER BY subject_id, relationship, patient_id`
      )
      .all(this.db.tenantId, asOf) as Array<{ subject_id: string; patient_id: string; relationship: string }>;
    const by = new Map<string, Array<{ patientId: string; relationship: string }>>();
    for (const row of rows) {
      const list = by.get(row.subject_id) ?? [];
      list.push({ patientId: row.patient_id, relationship: row.relationship });
      by.set(row.subject_id, list);
    }
    return [...by.entries()].map(([subject, patients]) => ({ subject, patients }));
  }

  /**
   * Whether one live grant contains one capability.
   *
   * Old self grants are all-capability because they are the patient's own.
   * Pre-scope proxy rows fail narrow: summary grants get summary,
   * appointments and released results; old full grants additionally get
   * messages, requests and the access log. Neither can manage delegates.
   */
  allows(authority: AuthorityRow, permission: PatientPermission): boolean {
    return this.permissionsFor(authority).includes(permission);
  }

  permissionsFor(authority: AuthorityRow): PatientPermission[] {
    if (authority.permissions) {
      try {
        const parsed = JSON.parse(authority.permissions) as unknown;
        if (Array.isArray(parsed)) {
          return parsed.filter(
            (p): p is PatientPermission =>
              typeof p === "string" && (PATIENT_PERMISSIONS as readonly string[]).includes(p)
          );
        }
      } catch {
        // Fall through to the deliberately narrow legacy interpretation.
      }
    }
    if (authority.relationship === "self") return [...PATIENT_PERMISSIONS];
    const summary: PatientPermission[] = ["summary", "results", "appointments"];
    return authority.extent === "summary" ? summary : [...summary, "messages", "access-log", "requests", "intake"];
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
    /** `none` records an OAuth subject that had no live grant. */
    relationship: Relationship | "none";
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

  // ---- access and correction requests -----------------------------------

  /**
   * Gives the patient a durable request and the clinic durable work.
   *
   * A web form stored only in the portal is a receipt nobody owes. The
   * request row is what the patient can see; the linked privacy-request task
   * is what appears in the clinic's unassigned inbox and cannot be completed
   * without evidence.
   */
  submitRequest(input: {
    patientId: string;
    kind: PatientRequestKind;
    target?: string;
    detail: string;
    by: { subjectId: string; relationship: Relationship };
  }): PatientRequestRow {
    if (input.kind !== "access" && input.kind !== "correction") {
      throw new Error("a patient request must be access or correction");
    }
    if (!input.detail.trim()) throw new Error("a patient request needs detail");
    if (input.kind === "correction" && !input.target?.trim()) {
      throw new Error("a correction request needs to identify what should be corrected");
    }
    if (!this.tasks) throw new Error("patient request inbox is not configured");

    const id = randomUUID();
    const now = new Date().toISOString();
    return this.db.transaction(() => {
      const task = this.tasks!.create({
        kind: "privacy-request",
        title: input.kind === "access" ? "Patient access request" : "Patient correction request",
        patientId: input.patientId,
        priority: "routine",
        source: "patient-access",
        correlationId: id,
        by: { actorId: input.by.subjectId, actorKind: input.by.relationship === "self" ? "patient" : "proxy" },
      });
      this.db.sql
        .prepare(
          `INSERT INTO patient_requests
             (tenant_id, id, patient_id, kind, target, detail, status,
              submitted_by, relationship, submitted_at, task_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'submitted', ?, ?, ?, ?, ?)`
        )
        .run(
          this.db.tenantId,
          id,
          input.patientId,
          input.kind,
          input.target?.trim() || null,
          input.detail.trim(),
          input.by.subjectId,
          input.by.relationship,
          now,
          task.id,
          now
        );
      this.requestEvent(id, "submitted", { actorId: input.by.subjectId, actorKind: input.by.relationship }, input.detail);
      return this.request(id)!;
    });
  }

  request(id: string): PatientRequestRow | undefined {
    return this.db.sql
      .prepare("SELECT * FROM patient_requests WHERE tenant_id = ? AND id = ?")
      .get(this.db.tenantId, id) as unknown as PatientRequestRow | undefined;
  }

  requestsFor(patientId: string): PatientRequestRow[] {
    return this.db.sql
      .prepare("SELECT * FROM patient_requests WHERE tenant_id = ? AND patient_id = ? ORDER BY submitted_at DESC")
      .all(this.db.tenantId, patientId) as unknown as PatientRequestRow[];
  }

  completeRequest(id: string, by: Actor & { outcome: string }): PatientRequestRow {
    if (!by.outcome.trim()) throw new Error("completing a patient request needs to say what was provided or corrected");
    const row = this.request(id);
    if (!row) throw new Error(`no patient request ${id}`);
    if (row.status !== "submitted") throw new Error(`that patient request is already ${row.status}`);
    if (!this.tasks) throw new Error("patient request inbox is not configured");
    return this.db.transaction(() => {
      this.tasks!.complete(row.task_id, { ...by, evidence: by.outcome.trim() });
      const now = new Date().toISOString();
      const completed = this.db.sql
        .prepare(
          `UPDATE patient_requests SET status = 'completed', completed_at = ?, outcome = ?
            WHERE tenant_id = ? AND id = ? AND status = 'submitted'`
        )
        .run(now, by.outcome.trim(), this.db.tenantId, id);
      // Two people answering one access request would otherwise leave the
      // later outcome over the earlier, with only one of them told they did it.
      if (completed.changes === 0) {
        throw new Error(`patient request ${id} is no longer submitted; it was answered while this was being applied`);
      }
      this.requestEvent(id, "completed", by, by.outcome.trim());
      return this.request(id)!;
    });
  }

  declineRequest(id: string, by: Actor & { reason: string }): PatientRequestRow {
    if (!by.reason.trim()) throw new Error("declining a patient request needs a reason");
    const row = this.request(id);
    if (!row) throw new Error(`no patient request ${id}`);
    if (row.status !== "submitted") throw new Error(`that patient request is already ${row.status}`);
    if (!this.tasks) throw new Error("patient request inbox is not configured");
    return this.db.transaction(() => {
      this.tasks!.cancel(row.task_id, { ...by, reason: by.reason.trim() });
      const now = new Date().toISOString();
      const declined = this.db.sql
        .prepare(
          `UPDATE patient_requests SET status = 'declined', completed_at = ?, outcome = ?
            WHERE tenant_id = ? AND id = ? AND status = 'submitted'`
        )
        .run(now, by.reason.trim(), this.db.tenantId, id);
      // A decline racing a completion must not overwrite the fulfilment: the
      // patient was given their record, and saying otherwise is the wrong way
      // for this to fail.
      if (declined.changes === 0) {
        throw new Error(`patient request ${id} is no longer submitted; it was answered while this was being applied`);
      }
      this.requestEvent(id, "declined", by, by.reason.trim());
      return this.request(id)!;
    });
  }

  private insertGrant(input: {
    patientId: string;
    subjectId: string;
    relationship: Relationship;
    extent?: Extent;
    permissions: PatientPermission[];
    purpose: string;
    expiresAt: string | null;
    by: Actor;
  }): AuthorityRow {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.sql
      .prepare(
        `INSERT INTO patient_authority
           (tenant_id, id, patient_id, subject_id, relationship, extent, permissions, purpose, expires_at,
            granted_by, granted_at, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        this.db.tenantId,
        id,
        input.patientId,
        input.subjectId,
        input.relationship,
        input.extent ?? "full",
        JSON.stringify([...new Set(input.permissions)]),
        input.purpose.trim(),
        input.expiresAt,
        input.by.actorId,
        now,
        input.purpose.trim(),
        now
      );
    return this.authority(id)!;
  }

  private requestEvent(requestId: string, event: string, by: Actor, detail: string): void {
    this.db.sql
      .prepare(
        `INSERT INTO patient_request_events
           (tenant_id, request_id, at, event, actor_id, actor_kind, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(this.db.tenantId, requestId, new Date().toISOString(), event, by.actorId, by.actorKind, detail);
  }
}
