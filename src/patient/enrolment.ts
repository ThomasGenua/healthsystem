/**
 * Clinic-attested enrolment: binding an OAuth subject to a chart.
 *
 * The patient/proxy API already requires a live grant. Until this existed,
 * `grantSelf` was how a clerk bound a subject, with nothing on the record
 * saying how they knew the person in front of them was the patient. A grant
 * with no attestation is how a chart ends up readable by the wrong OAuth
 * account, for years, with nobody having done anything that looks like a
 * mistake.
 *
 * This is not identity-proofing, not ONE ID, and not a portal enrolment
 * form. A named person writes, in their own words, how they checked.
 * Twelve characters, same bar as breaking glass — "in person" is not a
 * method. A pending row is not authority. GET /me does not enrol anyone.
 *
 * Proxy enrolments still need an expiry, a purpose and explicit permissions.
 * The grant path is `PatientAccess`; this module does not invent a second one.
 */
import { randomUUID } from "node:crypto";
import { refuse } from "../core/refusal.ts";
import type { Db } from "../db.ts";
import type { Actor, PatientAccess, PatientPermission, Relationship } from "./access.ts";
import type { PatientNotices } from "./notice.ts";

const METHOD_MIN = 12;

export type EnrolmentStatus = "pending" | "attested" | "declined";

export interface EnrolmentRow {
  tenant_id: string;
  id: string;
  patient_id: string;
  subject_id: string;
  relationship: Relationship;
  status: EnrolmentStatus;
  requested_at: string;
  requested_by: string;
  requested_kind: string;
  method: string | null;
  attested_at: string | null;
  attested_by: string | null;
  declined_at: string | null;
  declined_by: string | null;
  decline_reason: string | null;
  authority_id: string | null;
  purpose: string | null;
  permissions: string | null;
  expires_at: string | null;
  created_at: string;
}

export class PatientEnrolment {
  private db: Db;
  private access: PatientAccess;
  private notices: PatientNotices;

  constructor(db: Db, access: PatientAccess, notices: PatientNotices) {
    this.db = db;
    this.access = access;
    this.notices = notices;
  }

  /**
   * Someone presented. They are not on the chart until a person attests.
   */
  request(input: {
    patientId: string;
    subjectId: string;
    relationship: Relationship;
    by: Actor;
    purpose?: string;
    permissions?: PatientPermission[];
    expiresAt?: string;
  }): EnrolmentRow {
    const patientId = input.patientId.trim();
    const subjectId = input.subjectId.trim();
    if (!patientId || !subjectId) refuse("enrolment needs a patient and an OAuth subject");
    if (input.relationship !== "self") {
      if (!input.expiresAt) {
        refuse("delegated enrolment needs an expiry; an authority that never ends is the failure this guards against");
      }
      if (!input.purpose?.trim()) refuse("delegated enrolment needs a purpose the patient can review");
      if (!input.permissions?.length) refuse("delegated enrolment needs at least one explicit permission");
    }
    const existing = this.pendingFor(patientId, subjectId);
    if (existing) refuse("that subject already has a pending enrolment for this chart");
    if (this.access.may(subjectId, patientId)) {
      refuse("that subject already has live access to this chart");
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.sql
      .prepare(
        `INSERT INTO patient_enrolments
           (tenant_id, id, patient_id, subject_id, relationship, status,
            requested_at, requested_by, requested_kind, purpose, permissions, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        this.db.tenantId,
        id,
        patientId,
        subjectId,
        input.relationship,
        now,
        input.by.actorId,
        input.by.actorKind,
        input.purpose?.trim() ?? null,
        input.permissions ? JSON.stringify(input.permissions) : null,
        input.expiresAt ?? null,
        now
      );
    return this.get(id)!;
  }

  /**
   * The one-visit path: the person is in front of the clerk, identity is
   * checked, and the grant is issued in the same act. Still records a method.
   */
  attestInPerson(input: {
    patientId: string;
    subjectId: string;
    relationship: Relationship;
    method: string;
    by: Actor;
    purpose?: string;
    permissions?: PatientPermission[];
    expiresAt?: string;
  }): EnrolmentRow {
    return this.db.transaction(() => {
      const pending = this.pendingFor(input.patientId.trim(), input.subjectId.trim());
      const row = pending ?? this.request(input);
      return this.attest(row.id, { method: input.method, by: input.by });
    });
  }

  attest(id: string, input: { method: string; by: Actor }): EnrolmentRow {
    const method = input.method.trim();
    if (method.length < METHOD_MIN) {
      refuse("attesting enrolment needs a written method of verification, not a word");
    }
    const row = this.get(id);
    if (!row) refuse(`no enrolment ${id}`);
    if (row.status === "attested") refuse("that enrolment is already attested");
    if (row.status === "declined") refuse("that enrolment was declined");
    if (this.access.may(row.subject_id, row.patient_id)) {
      refuse("that subject already has live access to this chart");
    }

    return this.db.transaction(() => {
      const grant =
        row.relationship === "self"
          ? this.access.grantSelf(row.patient_id, row.subject_id, input.by)
          : this.access.grantProxy({
              patientId: row.patient_id,
              subjectId: row.subject_id,
              relationship: row.relationship as Exclude<Relationship, "self">,
              expiresAt: row.expires_at!,
              purpose: row.purpose!,
              permissions: JSON.parse(row.permissions!) as PatientPermission[],
              by: input.by,
            });
      const now = new Date().toISOString();
      this.db.sql
        .prepare(
          `UPDATE patient_enrolments
              SET status = 'attested', method = ?, attested_at = ?, attested_by = ?, authority_id = ?
            WHERE tenant_id = ? AND id = ?`
        )
        .run(method, now, input.by.actorId, grant.id, this.db.tenantId, id);
      this.notices.queue({
        patientId: row.patient_id,
        kind: "enrolment-attested",
        aboutId: id,
        summary: `Your clinic has attested your identity and bound this account to your chart. Reference ${id}.`,
      });
      return this.get(id)!;
    });
  }

  decline(id: string, input: { reason: string; by: Actor }): EnrolmentRow {
    const reason = input.reason.trim();
    if (reason.length < METHOD_MIN) {
      refuse("declining enrolment needs a written reason, not a word");
    }
    const row = this.get(id);
    if (!row) refuse(`no enrolment ${id}`);
    if (row.status !== "pending") refuse(`that enrolment is already ${row.status}`);
    const now = new Date().toISOString();
    this.db.sql
      .prepare(
        `UPDATE patient_enrolments
            SET status = 'declined', declined_at = ?, declined_by = ?, decline_reason = ?
          WHERE tenant_id = ? AND id = ?`
      )
      .run(now, input.by.actorId, reason, this.db.tenantId, id);
    return this.get(id)!;
  }

  get(id: string): EnrolmentRow | undefined {
    return this.db.sql
      .prepare("SELECT * FROM patient_enrolments WHERE tenant_id = ? AND id = ?")
      .get(this.db.tenantId, id) as unknown as EnrolmentRow | undefined;
  }

  list(filter: { status?: EnrolmentStatus; patientId?: string } = {}): EnrolmentRow[] {
    if (filter.patientId && filter.status) {
      return this.db.sql
        .prepare(
          `SELECT * FROM patient_enrolments
            WHERE tenant_id = ? AND patient_id = ? AND status = ?
            ORDER BY requested_at`
        )
        .all(this.db.tenantId, filter.patientId, filter.status) as unknown as EnrolmentRow[];
    }
    if (filter.patientId) {
      return this.db.sql
        .prepare(
          "SELECT * FROM patient_enrolments WHERE tenant_id = ? AND patient_id = ? ORDER BY requested_at"
        )
        .all(this.db.tenantId, filter.patientId) as unknown as EnrolmentRow[];
    }
    if (filter.status) {
      return this.db.sql
        .prepare(
          "SELECT * FROM patient_enrolments WHERE tenant_id = ? AND status = ? ORDER BY requested_at"
        )
        .all(this.db.tenantId, filter.status) as unknown as EnrolmentRow[];
    }
    return this.db.sql
      .prepare("SELECT * FROM patient_enrolments WHERE tenant_id = ? ORDER BY requested_at")
      .all(this.db.tenantId) as unknown as EnrolmentRow[];
  }

  pending(): EnrolmentRow[] {
    return this.list({ status: "pending" });
  }

  private pendingFor(patientId: string, subjectId: string): EnrolmentRow | undefined {
    return this.db.sql
      .prepare(
        `SELECT * FROM patient_enrolments
          WHERE tenant_id = ? AND patient_id = ? AND subject_id = ? AND status = 'pending'`
      )
      .get(this.db.tenantId, patientId, subjectId) as unknown as EnrolmentRow | undefined;
  }
}
