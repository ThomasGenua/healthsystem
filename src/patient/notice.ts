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
import type { ContactChannel, PatientContacts, Unreachable } from "./contacts.ts";
import { refuse } from "../core/refusal.ts";
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

/**
 * What a provider has told us about one attempt, and the four ways that is
 * not "the patient knows".
 *
 * The delivery queue's own `delivered` means a destination returned 2xx —
 * the gateway took the request. Whether a text reached a phone is something
 * only the gateway can say, later, over a receipt path a deployment wires
 * up. So a queue success is `provider-accepted` here and nothing more, and
 * with no receipts configured an attempt stays there forever, which is the
 * honest answer rather than an optimistic one.
 *
 * `unknown` is a receipt that arrived and did not map — a status string this
 * build does not recognise. Collapsing it into `delivered` invents a fact and
 * collapsing it into `failed` invents a different one, so it keeps its own
 * name and appears on the follow-up queue alongside the failures.
 */
export type DeliveryState = "queued" | "provider-accepted" | "delivered" | "failed" | "unknown";

export interface NoticeDeliveryRow {
  tenant_id: string;
  id: string;
  notice_id: string;
  contact_id: string;
  channel: ContactChannel;
  state: DeliveryState;
  message_id: string | null;
  provider_reference: string | null;
  /** Set when quiet hours hold this back. Not a failure: a later send. */
  held_until: string | null;
  accepted_at: string | null;
  delivered_at: string | null;
  failed_at: string | null;
  detail: string | null;
  created_at: string;
  updated_at: string;
}

/** What one call to `deliver` did, including the contacts it would not use. */
export interface DeliveryReport {
  noticeId: string;
  attempted: NoticeDeliveryRow[];
  /** Contacts on file that could not be used, and why. Not an error — an answer. */
  skipped: Array<{ contactId: string; channel: ContactChannel; because: Unreachable }>;
  /** Opened when nothing could be sent, so somebody owns reaching this patient. */
  followUpTaskId: string | null;
}

/**
 * The words that leave the building.
 *
 * Deliberately the same for every kind of notice. "You have a new result"
 * tells anybody reading a lock screen that this person had a test, which is
 * clinical information arriving through the feature meant to avoid sending
 * any. The kind, the summary and the identifier of whatever it is about all
 * stay on this side; the message says there is something to see and where to
 * see it.
 *
 * Bilingual because the contact says which language, and unstated means
 * both — a notice in a language somebody does not read is a notice that was
 * not sent, and guessing English is how that happens quietly.
 */
export function noticeBody(language: string | null, clinic: string): string {
  const en = `${clinic} has an update for you. Sign in to your patient account to read it.`;
  const fr = `${clinic} a une mise a jour pour vous. Connectez-vous a votre compte patient pour la lire.`;
  const lang = (language ?? "").toLowerCase();
  if (lang.startsWith("fr")) return fr;
  if (lang.startsWith("en")) return en;
  return `${en}\n\n${fr}`;
}
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
  /** When the patient read it in the portal. Not a delivery state. */
  viewed_at: string | null;
  /** The chase somebody owns, when nothing could be sent. */
  follow_up_task_id: string | null;
  created_at: string;
}

/** The slice of the task store this needs, so notices do not depend on all of it. */
export interface NoticeTasks {
  create(input: {
    kind: string;
    title: string;
    patientId?: string;
    priority?: string;
    source?: string;
    correlationId?: string;
    by: { actorId: string; actorKind: string };
  }): { id: string };
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

  /**
   * Sends the notice to every address this patient has agreed to be reached
   * at, and says why it did not use the others.
   *
   * Nothing goes anywhere without both a verification and a consent, both
   * recorded by name; `contacts.reachability()` is the only place that rule
   * lives. A contact inside its quiet hours is held rather than dropped —
   * that is a later send, not a refusal — and `releaseHeld()` sends it when
   * the window closes.
   *
   * When no address can be used at all, a follow-up task is opened. The
   * alternative is a patient nobody can reach and nobody is assigned to,
   * which is the state this whole feature exists to make visible.
   */
  deliver(
    noticeId: string,
    deps: { contacts: PatientContacts; tasks?: NoticeTasks; clinic?: string },
    asOf = new Date()
  ): DeliveryReport {
    const notice = this.get(noticeId);
    if (!notice) refuse(`no patient notice ${noticeId}`, 404);

    return this.db.transaction(() => {
      const attempted: NoticeDeliveryRow[] = [];
      const skipped: DeliveryReport["skipped"] = [];

      for (const r of deps.contacts.reachable(notice.patient_id, asOf)) {
        if (!r.reachable && r.because !== "quiet-hours") {
          skipped.push({ contactId: r.contact.id, channel: r.contact.channel, because: r.because! });
          continue;
        }
        const existing = this.deliveryFor(noticeId, r.contact.id);
        // The unique index says one notice reaches one address once. Reaching
        // it here rather than at the constraint keeps a re-run idempotent
        // instead of a 409 an operator has to interpret.
        if (existing) {
          attempted.push(existing);
          continue;
        }
        const row = this.createDelivery(notice, r.contact, r.until ?? null, asOf);
        attempted.push(r.until ? row : this.publish(row, notice, r.contact, deps.clinic ?? "Your clinic"));
      }

      let followUpTaskId: string | null = null;
      if (attempted.length === 0) {
        followUpTaskId = this.openFollowUp(
          notice,
          deps.tasks,
          skipped.length > 0
            ? `no usable contact point: ${skipped.map((x) => `${x.channel} ${x.because}`).join(", ")}`
            : "no contact point on file"
        );
      }
      return { noticeId, attempted, skipped, followUpTaskId };
    });
  }

  /** Sends the deliveries whose quiet hours have passed. Safe to run on a timer. */
  releaseHeld(
    deps: { contacts: PatientContacts; clinic?: string },
    asOf = new Date()
  ): NoticeDeliveryRow[] {
    const due = this.db.sql
      .prepare(
        `SELECT * FROM patient_notice_deliveries
          WHERE tenant_id = ? AND state = 'queued' AND held_until IS NOT NULL AND held_until <= ?
          ORDER BY created_at`
      )
      .all(this.db.tenantId, asOf.toISOString()) as unknown as NoticeDeliveryRow[];

    const sent: NoticeDeliveryRow[] = [];
    for (const row of due) {
      const notice = this.get(row.notice_id);
      const contact = deps.contacts.get(row.contact_id);
      if (!notice || !contact) continue;
      // Re-checked rather than assumed. Consent can be withdrawn between the
      // hold and the window closing, and sending anyway would make quiet
      // hours a way to escape a withdrawal.
      const now = deps.contacts.reachability(contact, asOf);
      if (!now.reachable) {
        sent.push(this.fail(row.id, `held, then ${now.because}`, asOf));
        continue;
      }
      sent.push(this.publish(row, notice, contact, deps.clinic ?? "Your clinic"));
    }
    return sent;
  }

  /**
   * What a provider said afterwards.
   *
   * The only path to `delivered`. A deployment wires its gateway's callback
   * to this; without one, attempts stay `provider-accepted` and the follow-up
   * queue shows how many are in a state nobody has confirmed.
   */
  recordReceipt(
    deliveryId: string,
    input: { state: "delivered" | "failed" | "unknown"; reference?: string; detail?: string },
    asOf = new Date()
  ): NoticeDeliveryRow {
    const row = this.delivery(deliveryId);
    if (!row) refuse(`no notice delivery ${deliveryId}`, 404);
    if (row.state === "queued") {
      refuse("that delivery has not been handed to a provider yet, so no provider can have reported on it", 409);
    }
    const now = asOf.toISOString();
    this.db.sql
      .prepare(
        `UPDATE patient_notice_deliveries
            SET state = ?, provider_reference = COALESCE(?, provider_reference),
                delivered_at = CASE WHEN ? = 'delivered' THEN ? ELSE delivered_at END,
                failed_at = CASE WHEN ? = 'failed' THEN ? ELSE failed_at END,
                detail = COALESCE(?, detail), updated_at = ?
          WHERE tenant_id = ? AND id = ?`
      )
      .run(
        input.state,
        input.reference ?? null,
        input.state,
        now,
        input.state,
        now,
        input.detail ?? null,
        now,
        this.db.tenantId,
        deliveryId
      );
    return this.delivery(deliveryId)!;
  }

  /**
   * That the patient read it in the portal.
   *
   * A different fact from every delivery state, and the strongest one
   * available: a gateway's opinion is about a phone, and this is about a
   * person signing in and looking. It deliberately does not set `told` —
   * that stays a human writing down that they spoke to somebody — and it
   * deliberately does not touch any delivery, because a notice can be viewed
   * while every attempt to text it sits `unknown`.
   */
  markViewed(id: string, asOf = new Date()): PatientNoticeRow {
    const row = this.get(id);
    if (!row) refuse(`no patient notice ${id}`, 404);
    if (row.viewed_at) return row;
    this.db.sql
      .prepare("UPDATE patient_notices SET viewed_at = ? WHERE tenant_id = ? AND id = ? AND viewed_at IS NULL")
      .run(asOf.toISOString(), this.db.tenantId, id);
    return this.get(id)!;
  }

  delivery(id: string): NoticeDeliveryRow | undefined {
    return this.db.sql
      .prepare("SELECT * FROM patient_notice_deliveries WHERE tenant_id = ? AND id = ?")
      .get(this.db.tenantId, id) as unknown as NoticeDeliveryRow | undefined;
  }

  deliveriesFor(noticeId: string): NoticeDeliveryRow[] {
    return this.db.sql
      .prepare(
        "SELECT * FROM patient_notice_deliveries WHERE tenant_id = ? AND notice_id = ? ORDER BY created_at"
      )
      .all(this.db.tenantId, noticeId) as unknown as NoticeDeliveryRow[];
  }

  /**
   * Attempts nobody can currently say arrived.
   *
   * `failed` and `unknown` together, because an operator chasing a patient
   * needs both: one says the gateway rejected it, the other says the gateway
   * never told us, and neither means the patient was reached. A long-standing
   * `provider-accepted` belongs here too where a deployment has receipts
   * configured, which is why the caller passes the age at which silence
   * stops being normal for their gateway rather than this guessing one.
   */
  followUp(opts: { acceptedSilentForMs?: number } = {}, asOf = new Date()): NoticeDeliveryRow[] {
    const rows = this.db.sql
      .prepare(
        `SELECT * FROM patient_notice_deliveries
          WHERE tenant_id = ? AND state IN ('failed', 'unknown')
          ORDER BY created_at`
      )
      .all(this.db.tenantId) as unknown as NoticeDeliveryRow[];
    if (opts.acceptedSilentForMs === undefined) return rows;
    const cutoff = new Date(asOf.getTime() - opts.acceptedSilentForMs).toISOString();
    const silent = this.db.sql
      .prepare(
        `SELECT * FROM patient_notice_deliveries
          WHERE tenant_id = ? AND state = 'provider-accepted' AND accepted_at IS NOT NULL AND accepted_at <= ?
          ORDER BY created_at`
      )
      .all(this.db.tenantId, cutoff) as unknown as NoticeDeliveryRow[];
    return [...rows, ...silent].sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  // ---- internals ---------------------------------------------------------

  private deliveryFor(noticeId: string, contactId: string): NoticeDeliveryRow | undefined {
    return this.db.sql
      .prepare(
        "SELECT * FROM patient_notice_deliveries WHERE tenant_id = ? AND notice_id = ? AND contact_id = ?"
      )
      .get(this.db.tenantId, noticeId, contactId) as unknown as NoticeDeliveryRow | undefined;
  }

  private createDelivery(
    notice: PatientNoticeRow,
    contact: { id: string; channel: ContactChannel },
    heldUntil: string | null,
    asOf: Date
  ): NoticeDeliveryRow {
    const id = randomUUID();
    const now = asOf.toISOString();
    this.db.sql
      .prepare(
        `INSERT INTO patient_notice_deliveries
           (tenant_id, id, notice_id, contact_id, channel, state, held_until, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?)`
      )
      .run(this.db.tenantId, id, notice.id, contact.id, contact.channel, heldUntil, now, now);
    return this.delivery(id)!;
  }

  /**
   * Hands one attempt to the durable queue, and records that the queue took
   * it — which is all that has happened.
   */
  private publish(
    row: NoticeDeliveryRow,
    notice: PatientNoticeRow,
    contact: { value: string; language: string | null; channel: ContactChannel },
    clinic: string
  ): NoticeDeliveryRow {
    const channelId = this.channelId;
    if (!channelId || !this.db.getChannel(channelId)) {
      return this.fail(row.id, channelId ? `no channel '${channelId}' to send through` : "no notice channel configured");
    }
    try {
      // The address and generic words. No kind, no summary, no identifier of
      // what it is about: everything that would tell a bystander something
      // clinical stays on this side of the boundary.
      const payload = {
        type: "patient-notice-delivery" as const,
        deliveryId: row.id,
        channel: contact.channel,
        to: contact.value,
        body: noticeBody(contact.language, clinic),
      };
      const message = this.db.insertMessage(
        channelId,
        "patient-notice-delivery",
        "application/json",
        JSON.stringify(payload),
        // Deliberately not the patient id: this message carries an address and
        // travels to a gateway, and tagging it with the chart it concerns
        // would put the two together in the outbound log.
        { deliveryId: row.id, noticeChannel: contact.channel }
      );
      const now = new Date().toISOString();
      this.db.sql
        .prepare(
          `UPDATE patient_notice_deliveries
              SET state = 'provider-accepted', message_id = ?, accepted_at = ?, held_until = NULL, updated_at = ?
            WHERE tenant_id = ? AND id = ? AND state = 'queued'`
        )
        .run(message.id, now, now, this.db.tenantId, row.id);
      return this.delivery(row.id)!;
    } catch (err) {
      return this.fail(row.id, err instanceof Error ? err.message : String(err));
    }
  }

  private fail(id: string, detail: string, asOf = new Date()): NoticeDeliveryRow {
    const now = asOf.toISOString();
    this.db.sql
      .prepare(
        `UPDATE patient_notice_deliveries
            SET state = 'failed', failed_at = ?, detail = ?, held_until = NULL, updated_at = ?
          WHERE tenant_id = ? AND id = ?`
      )
      .run(now, detail, now, this.db.tenantId, id);
    return this.delivery(id)!;
  }

  private openFollowUp(notice: PatientNoticeRow, tasks: NoticeTasks | undefined, why: string): string | null {
    if (!tasks) return null;
    // The reason is in the title rather than a detail field, because a
    // worklist shows titles: "Patient could not be notified" alone sends
    // somebody to open the task to find out what to do about it.
    const task = tasks.create({
      kind: "patient-contact",
      title: `Patient could not be notified: ${why}`,
      patientId: notice.patient_id,
      priority: "routine",
      source: "patient-notice",
      correlationId: notice.id,
      by: { actorId: "patient-notice", actorKind: "device" },
    });
    this.db.sql
      .prepare("UPDATE patient_notices SET follow_up_task_id = ? WHERE tenant_id = ? AND id = ?")
      .run(task.id, this.db.tenantId, notice.id);
    return task.id;
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
