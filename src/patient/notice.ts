/**
 * Sending the notice a patient is owed when somebody breaks glass on them.
 *
 * Until this existed the guarantee was "an operator is shown a list of patients
 * they owe a phone call". That is honest and it is thin: the argument for a
 * lockbox being survivable in a clinical setting rests on the override being
 * loud, and a queue that depends on somebody working through it every day is
 * loud only as long as somebody does.
 *
 * ## Why this publishes a message rather than sending anything
 *
 * Northstar does not know how to reach a patient and should not learn. The
 * patient index holds a name, a birth date and a set of identifiers — nothing
 * to reach anybody by — so any address this module produced would be one it had
 * invented. For a notice whose entire content is "somebody read your medical
 * record", sending it to a wrong number is a worse outcome than not sending it,
 * and it is the failure mode that would be discovered by the person who
 * received it.
 *
 * So the notice becomes a message on a channel the deployment configures, and
 * the deployment's destinations carry it to whatever already knows how to reach
 * patients — a portal, a letter run, a notifications service. That buys the
 * whole delivery machinery for free and on purpose: ordered, durable, retried
 * with backoff, and a dead letter when it cannot be delivered, which is the
 * same treatment every other clinical message gets. A notification that fails
 * silently would be the same defect as the queue nobody drains, one layer down.
 *
 * ## What is in it, and what is deliberately not
 *
 * The fact, not the record. Who broke glass, when, until when, and the reason
 * they gave — a patient reading this is entitled to know all four, and the
 * reason in the clinician's own words is the part that lets them judge it.
 *
 * There is no clinical content, because a disclosure notice that leaks the
 * chart while announcing that the chart was read would be self-defeating. The
 * override id is carried so the patient can ask about a specific event and an
 * operator can find it.
 */
import { randomUUID } from "node:crypto";
import type { Db } from "../db.ts";
import type { BreakGlassNotice, NoticeDispatcher } from "./consent.ts";

/** The message body a destination receives. */
export interface NoticePayload {
  type: "break-glass-notice";
  overrideId: string;
  patientId: string;
  declaredAt: string;
  expiresAt: string;
  accessedBy: { id: string; kind: string };
  reason: string;
  directiveId: string | null;
  /** Plain wording a channel can pass through unchanged. */
  summary: string;
}

/**
 * Publishes notices onto a channel, which must exist.
 *
 * The channel is checked at construction rather than at the first override.
 * Discovering that the notification channel was misspelled at the moment
 * somebody breaks glass, during an emergency, is the worst possible time to
 * find out — and the failure would be recorded on the row and easily missed.
 */
export class ChannelNoticeDispatcher implements NoticeDispatcher {
  private db: Db;
  private channelId: string;

  constructor(db: Db, channelId: string) {
    this.db = db;
    this.channelId = channelId;
  }

  dispatch(notice: BreakGlassNotice): string {
    // Re-checked per dispatch, not cached: a channel can be removed while the
    // engine runs, and a notice published to a channel that no longer exists
    // would sit in `deliveries` with no destination to go to — enqueued,
    // counted as sent, and delivered nowhere.
    if (!this.db.getChannel(this.channelId)) {
      throw new Error(`no channel '${this.channelId}' to publish the break-glass notice to`);
    }
    const payload: NoticePayload = {
      type: "break-glass-notice",
      overrideId: notice.overrideId,
      patientId: notice.patientId,
      declaredAt: notice.declaredAt,
      expiresAt: notice.expiresAt,
      accessedBy: { id: notice.subjectId, kind: notice.subjectKind },
      reason: notice.reason,
      directiveId: notice.directiveId,
      summary:
        `Your health record was accessed on ${notice.declaredAt} under an emergency override ` +
        `by ${notice.subjectId}. The reason recorded was: ${notice.reason}. ` +
        `The override expires ${notice.expiresAt}. Reference ${notice.overrideId}.`,
    };
    const message = this.db.insertMessage(
      this.channelId,
      "break-glass",
      "application/json",
      JSON.stringify(payload),
      // On the message rather than only in the body, so an operator can find
      // every notice for one patient without parsing payloads.
      { patientId: notice.patientId, overrideId: notice.overrideId }
    );
    return message.id;
  }
}

export type PatientNoticeKind = "enrolment-attested" | "result-released" | "request-completed";
export type PatientNoticeStatus = "queued" | "dispatched" | "failed" | "told";

export interface PatientNoticeRow {
  tenant_id: string;
  id: string;
  patient_id: string;
  kind: PatientNoticeKind;
  about_id: string | null;
  summary: string;
  status: PatientNoticeStatus;
  dispatched_at: string | null;
  message_id: string | null;
  error: string | null;
  told_at: string | null;
  told_by: string | null;
  created_at: string;
}

export interface PatientNoticePayload {
  type: "patient-notice";
  kind: PatientNoticeKind;
  noticeId: string;
  patientId: string;
  aboutId: string | null;
  summary: string;
}

/**
 * Notices a patient is owed that are not break-glass.
 *
 * Same rule as the override notice: publish the fact onto a configured
 * channel, never invent an address. Dispatching is not telling. A notice
 * whose payload carried a result value would be a disclosure dressed as a
 * courtesy.
 */
export class PatientNotices {
  private db: Db;
  private channelId: string | null;

  constructor(db: Db, channelId: string | null = null) {
    this.db = db;
    this.channelId = channelId;
  }

  queue(input: {
    patientId: string;
    kind: PatientNoticeKind;
    summary: string;
    aboutId?: string;
  }): PatientNoticeRow {
    const summary = input.summary.trim();
    if (!summary) throw new Error("a patient notice needs a summary");
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.sql
      .prepare(
        `INSERT INTO patient_notices
           (tenant_id, id, patient_id, kind, about_id, summary, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)`
      )
      .run(this.db.tenantId, id, input.patientId, input.kind, input.aboutId ?? null, summary, now);
    return this.dispatch(id);
  }

  /**
   * Hands the notice to the delivery machinery. Safe to call again: a
   * dispatched notice is not sent twice.
   */
  dispatch(id: string): PatientNoticeRow {
    const row = this.get(id);
    if (!row) throw new Error(`no patient notice ${id}`);
    if (row.dispatched_at) return row;
    const channelId = this.channelId;
    if (!channelId || !this.db.getChannel(channelId)) {
      const error = channelId
        ? `no channel '${channelId}' to publish the patient notice to`
        : "no patient-notice channel configured";
      this.db.sql
        .prepare(
          "UPDATE patient_notices SET status = 'failed', error = ? WHERE tenant_id = ? AND id = ?"
        )
        .run(error, this.db.tenantId, id);
      return this.get(id)!;
    }
    try {
      const payload: PatientNoticePayload = {
        type: "patient-notice",
        kind: row.kind,
        noticeId: row.id,
        patientId: row.patient_id,
        aboutId: row.about_id,
        summary: row.summary,
      };
      const message = this.db.insertMessage(
        channelId,
        "patient-notice",
        "application/json",
        JSON.stringify(payload),
        { patientId: row.patient_id, noticeId: row.id, kind: row.kind }
      );
      this.db.sql
        .prepare(
          `UPDATE patient_notices
              SET status = 'dispatched', dispatched_at = ?, message_id = ?, error = NULL
            WHERE tenant_id = ? AND id = ?`
        )
        .run(new Date().toISOString(), message.id, this.db.tenantId, id);
    } catch (err) {
      this.db.sql
        .prepare(
          "UPDATE patient_notices SET status = 'failed', error = ? WHERE tenant_id = ? AND id = ?"
        )
        .run((err as Error).message, this.db.tenantId, id);
    }
    return this.get(id)!;
  }

  /** Recording that they were told. Separate from dispatch, on purpose. */
  markTold(id: string, by: { actorId: string }): PatientNoticeRow {
    const row = this.get(id);
    if (!row) throw new Error(`no patient notice ${id}`);
    if (row.told_at) return row;
    this.db.sql
      .prepare(
        `UPDATE patient_notices
            SET status = 'told', told_at = ?, told_by = ?
          WHERE tenant_id = ? AND id = ?`
      )
      .run(new Date().toISOString(), by.actorId, this.db.tenantId, id);
    return this.get(id)!;
  }

  get(id: string): PatientNoticeRow | undefined {
    return this.db.sql
      .prepare("SELECT * FROM patient_notices WHERE tenant_id = ? AND id = ?")
      .get(this.db.tenantId, id) as unknown as PatientNoticeRow | undefined;
  }

  list(filter: { patientId?: string; status?: PatientNoticeStatus } = {}): PatientNoticeRow[] {
    if (filter.patientId && filter.status) {
      return this.db.sql
        .prepare(
          `SELECT * FROM patient_notices
            WHERE tenant_id = ? AND patient_id = ? AND status = ?
            ORDER BY created_at`
        )
        .all(this.db.tenantId, filter.patientId, filter.status) as unknown as PatientNoticeRow[];
    }
    if (filter.patientId) {
      return this.db.sql
        .prepare(
          "SELECT * FROM patient_notices WHERE tenant_id = ? AND patient_id = ? ORDER BY created_at"
        )
        .all(this.db.tenantId, filter.patientId) as unknown as PatientNoticeRow[];
    }
    if (filter.status) {
      return this.db.sql
        .prepare(
          "SELECT * FROM patient_notices WHERE tenant_id = ? AND status = ? ORDER BY created_at"
        )
        .all(this.db.tenantId, filter.status) as unknown as PatientNoticeRow[];
    }
    return this.db.sql
      .prepare("SELECT * FROM patient_notices WHERE tenant_id = ? ORDER BY created_at")
      .all(this.db.tenantId) as unknown as PatientNoticeRow[];
  }

  undelivered(): PatientNoticeRow[] {
    return this.list({ status: "failed" });
  }

  untold(): PatientNoticeRow[] {
    return this.db.sql
      .prepare(
        "SELECT * FROM patient_notices WHERE tenant_id = ? AND told_at IS NULL ORDER BY created_at"
      )
      .all(this.db.tenantId) as unknown as PatientNoticeRow[];
  }
}
