/**
 * The privacy office: queues, clocks, holds, incidents, and an assurance
 * catalogue that cannot close a finding by forgetting it.
 *
 * The audit trail records and proves. These tables are what a privacy officer
 * actually runs. A chain nobody reads proves only that nobody tampered with a
 * log nobody reads — issue #35.
 *
 * Privacy-office reads do not apply patient lockboxes. A directive that hid
 * the office from the record it is charged with reviewing would be a lock
 * with no key. HTTP still audits, and every query is still tenant-scoped.
 *
 * After-hours uses UTC clinic hours (default 07:00–19:00). Residual: not
 * clinic-local. Tests pass fixed ISO timestamps or override hours
 * (startHour === endHour → always after-hours; 0–24 → never).
 */
import { randomUUID } from "node:crypto";
import { refuse } from "../core/refusal.ts";
import type { CareTeam } from "../clinical/careteam.ts";
import type { ConsentDirectives } from "../patient/consent.ts";
import type { Db } from "../db.ts";
import type { PatientAccess } from "../patient/access.ts";
import type { TaskStore } from "../work/tasks.ts";

export type Actor = { actorId: string; actorKind: string };

export type FlagKind =
  | "after-hours"
  | "high-volume"
  | "high-volume-repeat"
  | "not-on-care-team"
  | "break-glass-unreviewed"
  | "sar-overdue"
  | "access-without-disclosure"
  | "expiring-access";

export type PrivacyFlag = {
  id: string;
  reviewId: string;
  kind: FlagKind;
  patientId: string | null;
  principalId: string | null;
  principalKind: string | null;
  detail: string;
  status: "open" | "accepted" | "escalated";
  addressedAt: string | null;
  addressedBy: string | null;
  addressReason: string | null;
};

export type PrivacyReview = {
  id: string;
  status: "open" | "closed";
  openedAt: string;
  openedBy: string;
  closedAt: string | null;
  closedBy: string | null;
  conclusion: string | null;
  taskId: string | null;
  flags: PrivacyFlag[];
};

export type LegalHold = {
  id: string;
  patientId: string | null;
  reason: string;
  placedBy: string;
  placedAt: string;
  releasedAt: string | null;
  releasedBy: string | null;
  releaseReason: string | null;
};

export type PrivacyIncident = {
  id: string;
  status: "open" | "closed";
  openedAt: string;
  openedBy: string;
  closedAt: string | null;
  closedBy: string | null;
  whatHappened: string;
  affectedPatients: string[];
  noneAffected: boolean;
  notification: "told" | "not-told" | null;
  notificationReason: string | null;
};

export type Disclosure = {
  id: string;
  patientId: string;
  requestId: string | null;
  purpose: string;
  sections: { name: string; count: number }[];
  recordedAt: string;
  recordedBy: string;
};

export type AssuranceControl = {
  id: string;
  title: string;
  area: string;
  status: "in-place" | "partial" | "not-in-place";
  evidence: string;
};

export type AssuranceFinding = {
  id: string;
  controlId: string;
  title: string;
  detail: string;
  status: "open" | "closed";
  openedAt: string;
  openedBy: string;
  closedAt: string | null;
  closedBy: string | null;
  remediation: string | null;
  residualRisk: string | null;
};

export type AssuranceExercise = {
  id: string;
  kind: string;
  status: "open" | "closed";
  startedAt: string;
  endedAt: string | null;
  rtoSeconds: number | null;
  outcome: "passed" | "failed" | null;
  notes: string | null;
  recordedBy: string;
};

export type Subprocessor = {
  id: string;
  name: string;
  purpose: string;
  region: string | null;
  status: "candidate" | "active" | "inactive";
  updatedAt: string;
};

export type AccessQueueItem = {
  id: string;
  patientId: string;
  kind: string;
  submittedAt: string;
  status: string;
  dueAt: string;
  overdue: boolean;
  completedWithoutDisclosure: boolean;
};

export type PrivacyInbox = {
  unreviewedBreakGlass: ReturnType<ConsentDirectives["pendingReview"]>;
  pendingNotification: ReturnType<ConsentDirectives["pendingNotification"]>;
  pendingAccess: AccessQueueItem[];
  expiringAccess: ReturnType<PatientAccess["expiring"]>;
  openReviews: PrivacyReview[];
  activeHolds: LegalHold[];
  openIncidents: PrivacyIncident[];
  openFindings: AssuranceFinding[];
  openExercises: AssuranceExercise[];
};

export type ClinicHours = { startHour: number; endHour: number };

const DEFAULT_HOURS: ClinicHours = { startHour: 7, endHour: 19 };
const DEFAULT_VOLUME = 20;
const DEFAULT_REPEAT = 10;
const PHIPA_DAYS = 30;

/**
 * Default clinic hours are 07:00–19:00 UTC. Residual: not clinic-local.
 * startHour === endHour means always after-hours (tests that must flag).
 * A window of 0–24 means never after-hours.
 */
export function isAfterHours(iso: string, hours: ClinicHours = DEFAULT_HOURS): boolean {
  if (hours.startHour === hours.endHour) return true;
  const hour = new Date(iso).getUTCHours();
  if (hours.startHour < hours.endHour) {
    return hour < hours.startHour || hour >= hours.endHour;
  }
  return hour >= hours.startHour || hour < hours.endHour;
}

export const ASSURANCE_CONTROLS: AssuranceControl[] = [
  {
    id: "AUTH-01",
    title: "OAuth tokens required on clinical routes",
    area: "AUTH",
    status: "in-place",
    evidence: "requiredScope() fail-closed; test/auth-bypass.test.ts",
  },
  {
    id: "AUDIT-01",
    title: "Hash-chained audit of PHI reads",
    area: "AUDIT",
    status: "in-place",
    evidence: "AuditStore; test/audit.test.ts",
  },
  {
    id: "TENANT-01",
    title: "Tenant WHERE on every PHI table",
    area: "TENANT",
    status: "in-place",
    evidence: "test/tenant-scoping.test.ts",
  },
  {
    id: "CONSENT-01",
    title: "Lockbox withhold plus break-glass",
    area: "CONSENT",
    status: "in-place",
    evidence: "test/consent.test.ts",
  },
  {
    id: "RETAIN-01",
    title: "Message log retention sweep",
    area: "RETAIN",
    status: "in-place",
    evidence: "test/retention.test.ts; an active legal hold skips the sweep",
  },
  {
    id: "BACKUP-01",
    title: "On-machine SQLite backup",
    area: "BACKUP",
    status: "in-place",
    evidence: "scripts/backup.ts; docs/RUNBOOK.md",
  },
  {
    id: "BACKUP-02",
    title: "Off-machine replica",
    area: "BACKUP",
    status: "partial",
    evidence: "Operator copies the file. No second site in this tree.",
  },
  {
    id: "PRESCRIBE-01",
    title: "Prescription outbox with signed payload",
    area: "PRESCRIBE",
    status: "in-place",
    evidence: "test/prescribe.test.ts",
  },
  {
    id: "MIGRATE-01",
    title: "Chart migration with dual-control apply",
    area: "MIGRATE",
    status: "in-place",
    evidence: "test/migration.test.ts",
  },
  {
    id: "PATIENT-01",
    title: "Patient HTML shell at /me",
    area: "PATIENT",
    status: "partial",
    evidence: "Not a certified portal. No identity-proofing, notifications, or WCAG claim.",
  },
  {
    id: "PRIVACY-01",
    title: "Privacy office reviews, holds, incidents, clocks, assurance",
    area: "PRIVACY",
    status: "in-place",
    evidence: "test/privacy-office.test.ts",
  },
];

export class PrivacyOffice {
  private db: Db;
  private consent: ConsentDirectives;
  private patientAccess: PatientAccess;
  private careTeam: CareTeam;
  private tasks: TaskStore;

  constructor(deps: {
    db: Db;
    consent: ConsentDirectives;
    patientAccess: PatientAccess;
    careTeam: CareTeam;
    tasks: TaskStore;
  }) {
    this.db = deps.db;
    this.consent = deps.consent;
    this.patientAccess = deps.patientAccess;
    this.careTeam = deps.careTeam;
    this.tasks = deps.tasks;
  }

  inbox(): PrivacyInbox {
    return {
      unreviewedBreakGlass: this.consent.pendingReview(),
      pendingNotification: this.consent.pendingNotification(),
      pendingAccess: this.accessQueue(),
      expiringAccess: this.patientAccess.expiring(),
      openReviews: this.listReviews().filter((r) => r.status === "open"),
      activeHolds: this.listHolds().filter((h) => !h.releasedAt),
      openIncidents: this.listIncidents().filter((i) => i.status === "open"),
      openFindings: this.listFindings().filter((f) => f.status === "open"),
      openExercises: this.listExercises().filter((e) => e.status === "open"),
    };
  }

  openReview(
    by: Actor,
    opts: {
      hours?: ClinicHours;
      volumeThreshold?: number;
      repeatThreshold?: number;
      sinceHours?: number;
    } = {}
  ): PrivacyReview {
    const hours = opts.hours ?? DEFAULT_HOURS;
    const volume = opts.volumeThreshold ?? DEFAULT_VOLUME;
    const repeat = opts.repeatThreshold ?? DEFAULT_REPEAT;
    const sinceHours = opts.sinceHours ?? 24;
    const since = new Date(Date.now() - sinceHours * 3_600_000).toISOString();
    const now = new Date().toISOString();
    const id = `prv-${randomUUID()}`;

    type Draft = {
      kind: FlagKind;
      patientId: string | null;
      principalId: string | null;
      principalKind: string | null;
      detail: string;
    };
    const drafts: Draft[] = [];

    for (const o of this.consent.pendingReview()) {
      drafts.push({
        kind: "break-glass-unreviewed",
        patientId: o.patient_id,
        principalId: o.subject_id,
        principalKind: o.subject_kind,
        detail: `Unreviewed override ${o.id} by ${o.subject_id}: ${o.reason}`,
      });
    }

    const reads = this.db.sql
      .prepare(
        `SELECT recorded_at, principal_id, principal_kind, patient FROM audit_events
         WHERE tenant_id = ? AND outcome = 0 AND patient IS NOT NULL AND recorded_at >= ?`
      )
      .all(this.db.tenantId, since) as {
      recorded_at: string;
      principal_id: string;
      principal_kind: string;
      patient: string;
    }[];

    const byActor = new Map<string, typeof reads>();
    for (const r of reads) {
      const list = byActor.get(r.principal_id) ?? [];
      list.push(r);
      byActor.set(r.principal_id, list);
    }
    for (const [principalId, list] of byActor) {
      const kind = list[0]?.principal_kind ?? null;
      const patients = new Set(list.map((r) => r.patient));
      if (patients.size >= volume) {
        drafts.push({
          kind: "high-volume",
          patientId: null,
          principalId,
          principalKind: kind,
          detail: `${principalId} read ${patients.size} distinct patients since ${since}`,
        });
      }
      const perPatient = new Map<string, number>();
      for (const r of list) perPatient.set(r.patient, (perPatient.get(r.patient) ?? 0) + 1);
      for (const [patientId, n] of perPatient) {
        if (n >= repeat) {
          drafts.push({
            kind: "high-volume-repeat",
            patientId,
            principalId,
            principalKind: kind,
            detail: `${principalId} read ${patientId} ${n} times since ${since}`,
          });
        }
      }
      const seenAfter = new Set<string>();
      for (const r of list) {
        if (!isAfterHours(r.recorded_at, hours)) continue;
        const key = `${principalId}|${r.patient}`;
        if (seenAfter.has(key)) continue;
        seenAfter.add(key);
        drafts.push({
          kind: "after-hours",
          patientId: r.patient,
          principalId,
          principalKind: kind,
          detail: `${principalId} read ${r.patient} at ${r.recorded_at} (UTC clinic hours ${hours.startHour}–${hours.endHour})`,
        });
      }
    }

    // Care-team membership is a join on the *person*, and an HTTP audit row
    // records the credential on principal_id (kind apikey or oauth) with the
    // clinician on practitioner_id. Filtering for principal_kind
    // "practitioner" and comparing principal_id to the team therefore matched
    // nothing real: every access through the API was skipped, and the flag
    // that exists to catch a clinician reading a chart they have no part in
    // never fired in production. This joins practitioner_id, which is the
    // identity AccessReview already uses. A credential naming no practitioner
    // cannot be on a team, so it is not this flag's business.
    const staff = this.db.sql
      .prepare(
        `SELECT DISTINCT practitioner_id, patient FROM audit_events
         WHERE tenant_id = ? AND outcome = 0 AND patient IS NOT NULL AND recorded_at >= ?
           AND practitioner_id IS NOT NULL`
      )
      .all(this.db.tenantId, since) as {
      practitioner_id: string;
      patient: string;
    }[];
    for (const r of staff) {
      const team = this.careTeam.forPatient(r.patient);
      if (team.length === 0) continue;
      if (team.some((m) => m.practitioner_id === r.practitioner_id)) continue;
      drafts.push({
        kind: "not-on-care-team",
        patientId: r.patient,
        principalId: r.practitioner_id,
        principalKind: "practitioner",
        detail: `${r.practitioner_id} read ${r.patient} and is not on the current care team`,
      });
    }

    for (const g of this.patientAccess.expiring()) {
      drafts.push({
        kind: "expiring-access",
        patientId: g.patient_id,
        principalId: g.subject_id,
        principalKind: g.relationship,
        detail: `Grant ${g.id} for ${g.subject_id} expires ${g.expires_at}`,
      });
    }

    const pending = this.db.sql
      .prepare(
        `SELECT id, patient_id, submitted_at FROM patient_requests
         WHERE tenant_id = ? AND status = 'submitted'`
      )
      .all(this.db.tenantId) as { id: string; patient_id: string; submitted_at: string }[];
    for (const r of pending) {
      const due = this.dueAt(r.id, r.submitted_at);
      if (due >= now) continue;
      drafts.push({
        kind: "sar-overdue",
        patientId: r.patient_id,
        principalId: null,
        principalKind: null,
        detail: `Request ${r.id} due ${due}`,
      });
    }

    const completed = this.db.sql
      .prepare(
        `SELECT id, patient_id FROM patient_requests
         WHERE tenant_id = ? AND status = 'completed' AND kind = 'access'`
      )
      .all(this.db.tenantId) as { id: string; patient_id: string }[];
    for (const r of completed) {
      if (this.disclosureForRequest(r.id)) continue;
      drafts.push({
        kind: "access-without-disclosure",
        patientId: r.patient_id,
        principalId: null,
        principalKind: null,
        detail: `Access request ${r.id} completed without a recorded disclosure`,
      });
    }

    const urgent = drafts.some((d) => d.kind === "sar-overdue" || d.kind === "break-glass-unreviewed");
    const task = this.tasks.create({
      kind: "privacy-request",
      title: `Privacy review ${id}`,
      by,
      priority: urgent ? "urgent" : "routine",
      correlationId: id,
    });

    this.db.transaction(() => {
      this.db.sql
        .prepare(
          `INSERT INTO privacy_reviews(tenant_id, id, status, since, opened_by, opened_at, task_id, created_at)
           VALUES (?, ?, 'open', ?, ?, ?, ?, ?)`
        )
        .run(this.db.tenantId, id, since, by.actorId, now, task.id, now);
      this.appendReviewEvent(id, now, by, "opened", `${drafts.length} flags`);
      const ins = this.db.sql.prepare(
        `INSERT INTO privacy_flags(tenant_id, id, review_id, kind, patient_id, principal_id, principal_kind, detail, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`
      );
      for (const d of drafts) {
        ins.run(
          this.db.tenantId,
          `pflg-${randomUUID()}`,
          id,
          d.kind,
          d.patientId,
          d.principalId,
          d.principalKind,
          d.detail,
          now
        );
      }
    });
    return this.getReview(id);
  }

  getReview(id: string): PrivacyReview {
    const row = this.db.sql
      .prepare(`SELECT * FROM privacy_reviews WHERE tenant_id = ? AND id = ?`)
      .get(this.db.tenantId, id) as
      | {
          id: string;
          status: "open" | "closed";
          opened_at: string;
          opened_by: string;
          closed_at: string | null;
          closed_by: string | null;
          conclusion: string | null;
          task_id: string | null;
        }
      | undefined;
    if (!row) refuse(`no privacy review ${id}`, 404);
    const flags = this.db.sql
      .prepare(`SELECT * FROM privacy_flags WHERE tenant_id = ? AND review_id = ? ORDER BY id`)
      .all(this.db.tenantId, id) as Array<{
      id: string;
      review_id: string;
      kind: FlagKind;
      patient_id: string | null;
      principal_id: string | null;
      principal_kind: string | null;
      detail: string;
      status: "open" | "accepted" | "escalated";
      addressed_at: string | null;
      addressed_by: string | null;
      address_reason: string | null;
    }>;
    return {
      id: row.id,
      status: row.status,
      openedAt: row.opened_at,
      openedBy: row.opened_by,
      closedAt: row.closed_at,
      closedBy: row.closed_by,
      conclusion: row.conclusion,
      taskId: row.task_id,
      flags: flags.map((f) => ({
        id: f.id,
        reviewId: f.review_id,
        kind: f.kind,
        patientId: f.patient_id,
        principalId: f.principal_id,
        principalKind: f.principal_kind,
        detail: f.detail,
        status: f.status,
        addressedAt: f.addressed_at,
        addressedBy: f.addressed_by,
        addressReason: f.address_reason,
      })),
    };
  }

  listReviews(): PrivacyReview[] {
    const ids = this.db.sql
      .prepare(`SELECT id FROM privacy_reviews WHERE tenant_id = ? ORDER BY opened_at DESC`)
      .all(this.db.tenantId) as { id: string }[];
    return ids.map((r) => this.getReview(r.id));
  }

  addressFlag(
    flagId: string,
    input: { status: "accepted" | "escalated"; reason: string },
    by: Actor
  ): PrivacyFlag {
    const reason = input.reason.trim();
    if (reason.length < 8) refuse("addressing a flag needs a written reason (8+ characters)");
    const row = this.db.sql
      .prepare(`SELECT review_id, status FROM privacy_flags WHERE tenant_id = ? AND id = ?`)
      .get(this.db.tenantId, flagId) as { review_id: string; status: string } | undefined;
    if (!row) refuse(`no privacy flag ${flagId}`, 404);
    const review = this.getReview(row.review_id);
    if (review.status === "closed") refuse("that review is already closed", 409);
    if (row.status !== "open") refuse("that flag is already addressed", 409);
    const now = new Date().toISOString();
    this.db.sql
      .prepare(
        `UPDATE privacy_flags SET status = ?, addressed_at = ?, addressed_by = ?, address_reason = ?
         WHERE tenant_id = ? AND id = ?`
      )
      .run(input.status, now, by.actorId, reason, this.db.tenantId, flagId);
    this.appendReviewEvent(row.review_id, now, by, "flag-addressed", `${flagId} ${input.status}`);
    return this.getReview(row.review_id).flags.find((f) => f.id === flagId)!;
  }

  closeReview(id: string, input: { conclusion: string }, by: Actor): PrivacyReview {
    const review = this.getReview(id);
    if (review.status === "closed") refuse("that review is already closed", 409);
    const conclusion = input.conclusion.trim();
    if (conclusion.length < 12) refuse("closing a review needs a written conclusion (12+ characters)");
    const open = review.flags.filter((f) => f.status === "open");
    if (open.length > 0) refuse(`address every flag before closing. ${open.length} still open`, 409);
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db.sql
        .prepare(
          `UPDATE privacy_reviews SET status = 'closed', closed_at = ?, closed_by = ?, conclusion = ?
           WHERE tenant_id = ? AND id = ?`
        )
        .run(now, by.actorId, conclusion, this.db.tenantId, id);
      this.appendReviewEvent(id, now, by, "closed", conclusion.slice(0, 200));
    });
    if (review.taskId) {
      try {
        this.tasks.complete(review.taskId, { ...by, evidence: `Review closed: ${conclusion}` });
      } catch {
        // Already completed — the review row is the record that matters.
      }
    }
    return this.getReview(id);
  }

  placeHold(input: { patientId?: string; reason: string }, by: Actor): LegalHold {
    const reason = input.reason.trim();
    if (reason.length < 12) refuse("a legal hold needs a written reason (12+ characters)");
    const now = new Date().toISOString();
    const id = `hold-${randomUUID()}`;
    this.db.sql
      .prepare(
        `INSERT INTO legal_holds(tenant_id, id, patient_id, reason, placed_by, placed_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(this.db.tenantId, id, input.patientId ?? null, reason, by.actorId, now, now);
    return this.getHold(id);
  }

  getHold(id: string): LegalHold {
    const row = this.db.sql
      .prepare(`SELECT * FROM legal_holds WHERE tenant_id = ? AND id = ?`)
      .get(this.db.tenantId, id) as
      | {
          id: string;
          patient_id: string | null;
          reason: string;
          placed_by: string;
          placed_at: string;
          released_at: string | null;
          released_by: string | null;
          release_reason: string | null;
        }
      | undefined;
    if (!row) refuse(`no legal hold ${id}`, 404);
    return {
      id: row.id,
      patientId: row.patient_id,
      reason: row.reason,
      placedBy: row.placed_by,
      placedAt: row.placed_at,
      releasedAt: row.released_at,
      releasedBy: row.released_by,
      releaseReason: row.release_reason,
    };
  }

  listHolds(): LegalHold[] {
    const ids = this.db.sql
      .prepare(`SELECT id FROM legal_holds WHERE tenant_id = ? ORDER BY placed_at DESC`)
      .all(this.db.tenantId) as { id: string }[];
    return ids.map((r) => this.getHold(r.id));
  }

  releaseHold(id: string, input: { reason: string }, by: Actor): LegalHold {
    const hold = this.getHold(id);
    if (hold.releasedAt) refuse("that hold is already released", 409);
    const reason = input.reason.trim();
    if (reason.length < 8) refuse("releasing a hold needs a written reason (8+ characters)");
    const now = new Date().toISOString();
    this.db.sql
      .prepare(
        `UPDATE legal_holds SET released_at = ?, released_by = ?, release_reason = ?
         WHERE tenant_id = ? AND id = ?`
      )
      .run(now, by.actorId, reason, this.db.tenantId, id);
    return this.getHold(id);
  }

  hasActiveHold(): boolean {
    return tenantHasActiveLegalHold(this.db);
  }

  openIncident(by: Actor): PrivacyIncident {
    const now = new Date().toISOString();
    const id = `inc-${randomUUID()}`;
    this.db.sql
      .prepare(
        `INSERT INTO privacy_incidents(tenant_id, id, status, what_happened, opened_by, opened_at, created_at)
         VALUES (?, ?, 'open', 'Incident opened; account not yet written.', ?, ?, ?)`
      )
      .run(this.db.tenantId, id, by.actorId, now, now);
    this.appendIncidentEvent(id, now, by, "opened", "opened");
    return this.getIncident(id);
  }

  getIncident(id: string): PrivacyIncident {
    const row = this.db.sql
      .prepare(`SELECT * FROM privacy_incidents WHERE tenant_id = ? AND id = ?`)
      .get(this.db.tenantId, id) as
      | {
          id: string;
          status: "open" | "closed";
          opened_at: string;
          opened_by: string;
          closed_at: string | null;
          closed_by: string | null;
          what_happened: string;
          affected_patients: string;
          none_affected: number;
          notification: "told" | "not-told" | null;
          notification_reason: string | null;
        }
      | undefined;
    if (!row) refuse(`no privacy incident ${id}`, 404);
    return {
      id: row.id,
      status: row.status,
      openedAt: row.opened_at,
      openedBy: row.opened_by,
      closedAt: row.closed_at,
      closedBy: row.closed_by,
      whatHappened: row.what_happened,
      affectedPatients: JSON.parse(row.affected_patients) as string[],
      noneAffected: row.none_affected === 1,
      notification: row.notification,
      notificationReason: row.notification_reason,
    };
  }

  listIncidents(): PrivacyIncident[] {
    const ids = this.db.sql
      .prepare(`SELECT id FROM privacy_incidents WHERE tenant_id = ? ORDER BY opened_at DESC`)
      .all(this.db.tenantId) as { id: string }[];
    return ids.map((r) => this.getIncident(r.id));
  }

  closeIncident(
    id: string,
    input: {
      whatHappened: string;
      affectedPatients?: string[];
      noneAffected?: boolean;
      notification: "told" | "not-told";
      notificationReason?: string;
    },
    by: Actor
  ): PrivacyIncident {
    const incident = this.getIncident(id);
    if (incident.status === "closed") refuse("that incident is already closed", 409);
    const what = input.whatHappened.trim();
    if (what.length < 12) refuse("closing an incident needs a written account (12+ characters)");
    const none = Boolean(input.noneAffected);
    const affected = input.affectedPatients ?? [];
    if (!none && affected.length === 0) {
      refuse("name the affected patients, or set noneAffected when nobody's information was involved");
    }
    if (none && affected.length > 0) refuse("noneAffected cannot be set when patients are named");
    if (input.notification === "not-told") {
      const reason = (input.notificationReason ?? "").trim();
      if (reason.length < 8) refuse("if patients were not told, write why (8+ characters)");
    }
    const now = new Date().toISOString();
    this.db.sql
      .prepare(
        `UPDATE privacy_incidents
         SET status = 'closed', closed_at = ?, closed_by = ?, what_happened = ?, affected_patients = ?,
             none_affected = ?, notification = ?, notification_reason = ?
         WHERE tenant_id = ? AND id = ?`
      )
      .run(
        now,
        by.actorId,
        what,
        JSON.stringify(affected),
        none ? 1 : 0,
        input.notification,
        input.notification === "not-told" ? (input.notificationReason ?? "").trim() : null,
        this.db.tenantId,
        id
      );
    this.appendIncidentEvent(id, now, by, "closed", what.slice(0, 200));
    return this.getIncident(id);
  }

  recordDisclosure(
    input: {
      patientId: string;
      requestId?: string;
      purpose?: string;
      sections: { name: string; count: number }[];
    },
    by: Actor
  ): Disclosure {
    if (!input.patientId.trim()) refuse("a disclosure needs a patient");
    if (!input.sections.length) {
      refuse("name the chart sections disclosed, with counts. not a second copy of the chart");
    }
    for (const s of input.sections) {
      if (!s.name.trim()) refuse("every section needs a name");
      if (!Number.isInteger(s.count) || s.count < 0) refuse("section counts must be non-negative integers");
    }
    if (input.requestId) {
      const req = this.db.sql
        .prepare(`SELECT id FROM patient_requests WHERE tenant_id = ? AND id = ?`)
        .get(this.db.tenantId, input.requestId) as { id: string } | undefined;
      if (!req) refuse(`no patient request ${input.requestId}`, 404);
    }
    const now = new Date().toISOString();
    const id = `disc-${randomUUID()}`;
    this.db.sql
      .prepare(
        `INSERT INTO privacy_disclosures(tenant_id, id, patient_id, request_id, purpose, sections, recorded_by, recorded_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        this.db.tenantId,
        id,
        input.patientId,
        input.requestId ?? null,
        (input.purpose ?? "access-request").trim() || "access-request",
        JSON.stringify(input.sections),
        by.actorId,
        now,
        now
      );
    return this.getDisclosure(id);
  }

  getDisclosure(id: string): Disclosure {
    const row = this.db.sql
      .prepare(`SELECT * FROM privacy_disclosures WHERE tenant_id = ? AND id = ?`)
      .get(this.db.tenantId, id) as
      | {
          id: string;
          patient_id: string;
          request_id: string | null;
          purpose: string;
          sections: string;
          recorded_at: string;
          recorded_by: string;
        }
      | undefined;
    if (!row) refuse(`no disclosure ${id}`, 404);
    return {
      id: row.id,
      patientId: row.patient_id,
      requestId: row.request_id,
      purpose: row.purpose,
      sections: JSON.parse(row.sections) as { name: string; count: number }[],
      recordedAt: row.recorded_at,
      recordedBy: row.recorded_by,
    };
  }

  listDisclosures(): Disclosure[] {
    const ids = this.db.sql
      .prepare(`SELECT id FROM privacy_disclosures WHERE tenant_id = ? ORDER BY recorded_at DESC`)
      .all(this.db.tenantId) as { id: string }[];
    return ids.map((r) => this.getDisclosure(r.id));
  }

  /**
   * Record a disclosure then complete the access request.
   * Completing without a disclosure stays possible on PatientAccess; the inbox flags it.
   */
  fulfillAccess(
    requestId: string,
    input: { sections: { name: string; count: number }[]; purpose?: string },
    by: Actor
  ): { disclosure: Disclosure; requestId: string } {
    const row = this.db.sql
      .prepare(`SELECT id, patient_id, kind, status FROM patient_requests WHERE tenant_id = ? AND id = ?`)
      .get(this.db.tenantId, requestId) as
      | { id: string; patient_id: string; kind: string; status: string }
      | undefined;
    if (!row) refuse(`no patient request ${requestId}`, 404);
    if (row.status !== "submitted") refuse(`request ${requestId} is ${row.status}, not submitted`, 409);
    if (row.kind !== "access") refuse("fulfillAccess is for access requests. corrections use completeRequest");
    // One transaction, because these two writes are one act. Recorded
    // separately, a failure between them left a durable disclosure against a
    // request still reading as submitted — the ledger saying the chart went
    // out while the queue said nobody had answered — and a retry inserted a
    // second disclosure for the same release.
    return this.db.transaction(() => {
      const disclosure = this.recordDisclosure(
        { patientId: row.patient_id, requestId, purpose: input.purpose, sections: input.sections },
        by
      );
      this.patientAccess.completeRequest(requestId, {
        ...by,
        outcome: `Disclosed ${input.sections.length} section(s); record ${disclosure.id}`,
      });
      return { disclosure, requestId };
    });
  }

  extendDeadline(requestId: string, input: { until: string; reason: string }, by: Actor): void {
    const row = this.db.sql
      .prepare(`SELECT id FROM patient_requests WHERE tenant_id = ? AND id = ?`)
      .get(this.db.tenantId, requestId) as { id: string } | undefined;
    if (!row) refuse(`no patient request ${requestId}`, 404);
    const reason = input.reason.trim();
    if (reason.length < 8) refuse("extending a deadline needs a written reason (8+ characters)");
    if (!Date.parse(input.until)) refuse("until must be an ISO timestamp");
    const now = new Date().toISOString();
    this.db.sql
      .prepare(
        `INSERT INTO privacy_deadlines(tenant_id, request_id, until_at, reason, set_by, set_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(tenant_id, request_id) DO UPDATE SET
           until_at = excluded.until_at, reason = excluded.reason, set_by = excluded.set_by, set_at = excluded.set_at`
      )
      .run(this.db.tenantId, requestId, input.until, reason, by.actorId, now);
  }

  catalogue(): AssuranceControl[] {
    return ASSURANCE_CONTROLS.map((c) => ({ ...c }));
  }

  openFinding(input: { controlId: string; description: string }, by: Actor): AssuranceFinding {
    const control = ASSURANCE_CONTROLS.find((c) => c.id === input.controlId);
    if (!control) refuse(`unknown control ${input.controlId}`);
    const description = input.description.trim();
    if (description.length < 12) refuse("a finding needs a written description (12+ characters)");
    const now = new Date().toISOString();
    const id = `find-${randomUUID()}`;
    this.db.sql
      .prepare(
        `INSERT INTO assurance_findings(tenant_id, id, control_id, title, detail, status, opened_by, opened_at, created_at)
         VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?)`
      )
      .run(this.db.tenantId, id, input.controlId, control.title, description, by.actorId, now, now);
    return this.getFinding(id);
  }

  getFinding(id: string): AssuranceFinding {
    const row = this.db.sql
      .prepare(`SELECT * FROM assurance_findings WHERE tenant_id = ? AND id = ?`)
      .get(this.db.tenantId, id) as
      | {
          id: string;
          control_id: string;
          title: string;
          detail: string;
          status: "open" | "closed";
          opened_at: string;
          opened_by: string;
          closed_at: string | null;
          closed_by: string | null;
          remediation: string | null;
          residual_risk: string | null;
        }
      | undefined;
    if (!row) refuse(`no finding ${id}`, 404);
    return {
      id: row.id,
      controlId: row.control_id,
      title: row.title,
      detail: row.detail,
      status: row.status,
      openedAt: row.opened_at,
      openedBy: row.opened_by,
      closedAt: row.closed_at,
      closedBy: row.closed_by,
      remediation: row.remediation,
      residualRisk: row.residual_risk,
    };
  }

  listFindings(): AssuranceFinding[] {
    const ids = this.db.sql
      .prepare(`SELECT id FROM assurance_findings WHERE tenant_id = ? ORDER BY opened_at DESC`)
      .all(this.db.tenantId) as { id: string }[];
    return ids.map((r) => this.getFinding(r.id));
  }

  closeFinding(id: string, input: { remediation?: string; residualRisk?: string }, by: Actor): AssuranceFinding {
    const finding = this.getFinding(id);
    if (finding.status === "closed") refuse("that finding is already closed", 409);
    const remediation = (input.remediation ?? "").trim();
    const residual = (input.residualRisk ?? "").trim();
    if (remediation.length < 8 && residual.length < 8) {
      refuse("closing a finding needs remediation or an accepted residual risk (8+ characters)");
    }
    const now = new Date().toISOString();
    this.db.sql
      .prepare(
        `UPDATE assurance_findings SET status = 'closed', closed_at = ?, closed_by = ?, remediation = ?, residual_risk = ?
         WHERE tenant_id = ? AND id = ?`
      )
      .run(now, by.actorId, remediation || null, residual || null, this.db.tenantId, id);
    return this.getFinding(id);
  }

  openExercise(input: { kind: string }, by: Actor): AssuranceExercise {
    const kind = input.kind.trim();
    if (!kind) refuse("an exercise needs a kind (for example restore-drill)");
    const now = new Date().toISOString();
    const id = `ex-${randomUUID()}`;
    this.db.sql
      .prepare(
        `INSERT INTO assurance_exercises(tenant_id, id, kind, started_at, recorded_by, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'open', ?)`
      )
      .run(this.db.tenantId, id, kind, now, by.actorId, now);
    return this.getExercise(id);
  }

  getExercise(id: string): AssuranceExercise {
    const row = this.db.sql
      .prepare(`SELECT * FROM assurance_exercises WHERE tenant_id = ? AND id = ?`)
      .get(this.db.tenantId, id) as
      | {
          id: string;
          kind: string;
          started_at: string;
          ended_at: string | null;
          rto_seconds: number | null;
          outcome: "passed" | "failed" | null;
          notes: string | null;
          recorded_by: string;
          status: "open" | "closed";
        }
      | undefined;
    if (!row) refuse(`no exercise ${id}`, 404);
    return {
      id: row.id,
      kind: row.kind,
      status: row.status,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      rtoSeconds: row.rto_seconds,
      outcome: row.outcome,
      notes: row.notes,
      recordedBy: row.recorded_by,
    };
  }

  listExercises(): AssuranceExercise[] {
    const ids = this.db.sql
      .prepare(`SELECT id FROM assurance_exercises WHERE tenant_id = ? ORDER BY started_at DESC`)
      .all(this.db.tenantId) as { id: string }[];
    return ids.map((r) => this.getExercise(r.id));
  }

  closeExercise(
    id: string,
    input: { rtoSeconds: number; outcome: "passed" | "failed"; notes?: string },
    by: Actor
  ): AssuranceExercise {
    const exercise = this.getExercise(id);
    if (exercise.status === "closed") refuse("that exercise is already closed", 409);
    if (!Number.isInteger(input.rtoSeconds) || input.rtoSeconds < 0) {
      refuse("closing an exercise needs measured RTO in seconds (integer ≥ 0)");
    }
    if (input.outcome !== "passed" && input.outcome !== "failed") refuse("outcome must be passed or failed");
    const now = new Date().toISOString();
    this.db.sql
      .prepare(
        `UPDATE assurance_exercises
         SET status = 'closed', ended_at = ?, rto_seconds = ?, outcome = ?, notes = ?, recorded_by = ?
         WHERE tenant_id = ? AND id = ?`
      )
      .run(
        now,
        input.rtoSeconds,
        input.outcome,
        input.notes?.trim() || null,
        by.actorId,
        this.db.tenantId,
        id
      );
    return this.getExercise(id);
  }

  upsertSubprocessor(
    input: {
      id?: string;
      name: string;
      purpose: string;
      region?: string;
      status: "candidate" | "active" | "inactive";
    },
    by: Actor
  ): Subprocessor {
    const name = input.name.trim();
    const purpose = input.purpose.trim();
    if (!name || !purpose) refuse("a subprocessor needs a name and purpose");
    if (input.status === "active" && !(input.region ?? "").trim()) {
      refuse("an active subprocessor needs a hosting region");
    }
    const now = new Date().toISOString();
    const existing = input.id
      ? (this.db.sql
          .prepare(`SELECT id FROM subprocessors WHERE tenant_id = ? AND id = ?`)
          .get(this.db.tenantId, input.id) as { id: string } | undefined)
      : undefined;
    const id = existing?.id ?? `sub-${randomUUID()}`;
    if (existing) {
      this.db.sql
        .prepare(
          `UPDATE subprocessors SET name = ?, purpose = ?, region = ?, status = ?, updated_at = ?
           WHERE tenant_id = ? AND id = ?`
        )
        .run(name, purpose, (input.region ?? "").trim() || null, input.status, now, this.db.tenantId, id);
    } else {
      this.db.sql
        .prepare(
          `INSERT INTO subprocessors(tenant_id, id, name, purpose, region, status, recorded_by, recorded_at, updated_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          this.db.tenantId,
          id,
          name,
          purpose,
          (input.region ?? "").trim() || null,
          input.status,
          by.actorId,
          now,
          now,
          now
        );
    }
    return this.getSubprocessor(id);
  }

  getSubprocessor(id: string): Subprocessor {
    const row = this.db.sql
      .prepare(`SELECT * FROM subprocessors WHERE tenant_id = ? AND id = ?`)
      .get(this.db.tenantId, id) as
      | {
          id: string;
          name: string;
          purpose: string;
          region: string | null;
          status: "candidate" | "active" | "inactive";
          updated_at: string;
        }
      | undefined;
    if (!row) refuse(`no subprocessor ${id}`, 404);
    return {
      id: row.id,
      name: row.name,
      purpose: row.purpose,
      region: row.region,
      status: row.status,
      updatedAt: row.updated_at,
    };
  }

  listSubprocessors(): Subprocessor[] {
    const ids = this.db.sql
      .prepare(`SELECT id FROM subprocessors WHERE tenant_id = ? ORDER BY name`)
      .all(this.db.tenantId) as { id: string }[];
    return ids.map((r) => this.getSubprocessor(r.id));
  }

  private accessQueue(): AccessQueueItem[] {
    const pending = this.db.sql
      .prepare(
        `SELECT id, patient_id, kind, submitted_at, status FROM patient_requests
         WHERE tenant_id = ? AND status = 'submitted' ORDER BY submitted_at`
      )
      .all(this.db.tenantId) as {
      id: string;
      patient_id: string;
      kind: string;
      submitted_at: string;
      status: string;
    }[];
    const completed = this.db.sql
      .prepare(
        `SELECT id, patient_id, kind, submitted_at, status FROM patient_requests
         WHERE tenant_id = ? AND status = 'completed' ORDER BY submitted_at DESC LIMIT 50`
      )
      .all(this.db.tenantId) as typeof pending;
    const now = new Date().toISOString();
    const pendingItems = pending.map((r) => {
      const dueAt = this.dueAt(r.id, r.submitted_at);
      return {
        id: r.id,
        patientId: r.patient_id,
        kind: r.kind,
        submittedAt: r.submitted_at,
        status: r.status,
        dueAt,
        overdue: dueAt < now,
        completedWithoutDisclosure: false,
      };
    });
    const completedWithout = completed
      .filter((r) => r.kind === "access" && !this.disclosureForRequest(r.id))
      .map((r) => ({
        id: r.id,
        patientId: r.patient_id,
        kind: r.kind,
        submittedAt: r.submitted_at,
        status: r.status,
        dueAt: this.dueAt(r.id, r.submitted_at),
        overdue: false,
        completedWithoutDisclosure: true,
      }));
    return [...pendingItems, ...completedWithout];
  }

  private dueAt(requestId: string, submittedAt: string): string {
    const override = this.db.sql
      .prepare(
        `SELECT until_at FROM privacy_deadlines WHERE tenant_id = ? AND request_id = ?`
      )
      .get(this.db.tenantId, requestId) as { until_at: string } | undefined;
    if (override) return override.until_at;
    const due = new Date(submittedAt);
    due.setUTCDate(due.getUTCDate() + PHIPA_DAYS);
    return due.toISOString();
  }

  private disclosureForRequest(requestId: string): boolean {
    const row = this.db.sql
      .prepare(
        `SELECT 1 AS ok FROM privacy_disclosures WHERE tenant_id = ? AND request_id = ? LIMIT 1`
      )
      .get(this.db.tenantId, requestId) as { ok: number } | undefined;
    return Boolean(row);
  }

  private appendReviewEvent(reviewId: string, at: string, by: Actor, event: string, detail: string): void {
    const seq = this.db.sql
      .prepare(
        `SELECT COALESCE(MAX(seq), 0) AS n FROM privacy_review_events WHERE tenant_id = ? AND review_id = ?`
      )
      .get(this.db.tenantId, reviewId) as { n: number };
    this.db.sql
      .prepare(
        `INSERT INTO privacy_review_events(tenant_id, review_id, seq, at, event, actor_id, actor_kind, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(this.db.tenantId, reviewId, seq.n + 1, at, event, by.actorId, by.actorKind, detail);
  }

  private appendIncidentEvent(incidentId: string, at: string, by: Actor, event: string, detail: string): void {
    const seq = this.db.sql
      .prepare(
        `SELECT COALESCE(MAX(seq), 0) AS n FROM privacy_incident_events WHERE tenant_id = ? AND incident_id = ?`
      )
      .get(this.db.tenantId, incidentId) as { n: number };
    this.db.sql
      .prepare(
        `INSERT INTO privacy_incident_events(tenant_id, incident_id, seq, at, event, actor_id, actor_kind, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(this.db.tenantId, incidentId, seq.n + 1, at, event, by.actorId, by.actorKind, detail);
  }
}

/** Used by RetentionRunner without importing PrivacyOffice (avoids a core→privacy cycle). */
export function tenantHasActiveLegalHold(db: Db): boolean {
  const row = db.sql
    .prepare(
      `SELECT 1 AS ok FROM legal_holds WHERE tenant_id = ? AND released_at IS NULL LIMIT 1`
    )
    .get(db.tenantId) as { ok: number } | undefined;
  return Boolean(row);
}
