/**
 * Correspondence between a patient and the clinic.
 *
 * Scheduling exists. Secure messaging did not. A clinic that can book a
 * patient and cannot keep the question they asked is not finished with
 * daily work: the question lives on a sticky note, in a voicemail, or in
 * whoever happened to pick up the phone, and it disappears the moment
 * that person is not there.
 *
 * This is the durable record of that conversation. It is not a portal,
 * not email, and not a claim that anything was delivered to a phone.
 * Northstar still does not know how to reach a patient (see
 * `src/patient/notice.ts`). A future portal would write through this
 * store; until then a clerk records what the patient said, the same way
 * they write a phone message today.
 *
 * Three things are structural:
 *
 *   Nothing is deleted. A retracted question is still a question somebody
 *   asked, and a review of a missed renewal needs to see it.
 *
 *   Closing needs a reason. A thread closed with a click is
 *   indistinguishable afterwards from one answered. "Phoned; explained
 *   the potassium; no further message" is an answer. A timestamp is not.
 *
 *   Awaiting the clinic and belonging to nobody is a list, not a
 *   silence. That is how a patient message is lost without anyone doing
 *   anything wrong.
 *
 * Status follows the last speaker: a patient or proxy writing makes the
 * thread `awaiting-clinic`; a practitioner or clerk writing makes it
 * `awaiting-patient`. The inbox is the first of those.
 */
import { randomUUID } from "node:crypto";
import { an } from "../core/text.ts";
import type { Db } from "../db.ts";
import { CareTeam } from "../clinical/careteam.ts";
import { refuse } from "../core/refusal.ts";

export const MESSAGE_AUTHORS = ["patient", "proxy", "practitioner", "clerk"] as const;
export type MessageAuthorKind = (typeof MESSAGE_AUTHORS)[number];

export const THREAD_STATUSES = ["awaiting-clinic", "awaiting-patient", "closed"] as const;
export type ThreadStatus = (typeof THREAD_STATUSES)[number];

export const THREAD_PRIORITIES = ["routine", "urgent", "stat"] as const;
export type ThreadPriority = (typeof THREAD_PRIORITIES)[number];

const PRIORITY_RANK: Record<ThreadPriority, number> = { stat: 0, urgent: 1, routine: 2 };

const FROM_PATIENT = new Set<MessageAuthorKind>(["patient", "proxy"]);

export interface Actor {
  actorId: string;
  actorKind: string;
}

export interface ThreadRow {
  tenant_id: string;
  id: string;
  patient_id: string;
  subject: string;
  status: ThreadStatus;
  priority: ThreadPriority;
  owner_id: string | null;
  opened_by: string;
  opened_kind: MessageAuthorKind;
  opened_at: string;
  closed_at: string | null;
  closed_by: string | null;
  close_reason: string | null;
  created_at: string;
}

export interface MessageRow {
  tenant_id: string;
  id: string;
  thread_id: string;
  patient_id: string;
  author_id: string;
  author_kind: MessageAuthorKind;
  body: string;
  recorded_at: string;
  created_at: string;
}

export interface ThreadEvent {
  seq: number;
  thread_id: string;
  at: string;
  event: string;
  actor_id: string;
  actor_kind: string;
  detail: string | null;
}

export class PatientMessaging {
  private db: Db;
  private careTeam: CareTeam;

  constructor(db: Db) {
    this.db = db;
    this.careTeam = new CareTeam(db);
  }

  /**
   * Opens a thread with its first message.
   *
   * A subject without a body is a heading; a body without a subject cannot
   * be triaged. Both are required. A patient or proxy writing lands on the
   * clinic inbox; a clinician writing is waiting on the patient.
   *
   * If nobody is named as owner and the patient has a current primary,
   * the primary is assigned — a message that "belongs to the clinic" is
   * how it belongs to nobody. An unowned thread is still allowed, and
   * `unassigned()` is where it waits.
   */
  open(input: {
    patientId: string;
    subject: string;
    body: string;
    by: Actor;
    authorKind: MessageAuthorKind;
    priority?: ThreadPriority;
    ownerId?: string;
  }): { thread: ThreadRow; message: MessageRow } {
    if (!input.subject.trim()) refuse("a message needs a subject so it can be triaged");
    if (!input.body.trim()) refuse("a message needs a body; a subject alone is not a question");
    if (!(MESSAGE_AUTHORS as readonly string[]).includes(input.authorKind)) {
      refuse(`unknown message author ${input.authorKind}`);
    }
    const priority = input.priority ?? "routine";
    if (!(THREAD_PRIORITIES as readonly string[]).includes(priority)) {
      refuse(`unknown priority ${priority}`);
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    const fromPatient = FROM_PATIENT.has(input.authorKind);
    const status: ThreadStatus = fromPatient ? "awaiting-clinic" : "awaiting-patient";
    const owner = input.ownerId ?? this.careTeam.primary(input.patientId)?.practitioner_id ?? null;

    return this.db.transaction(() => {
      this.db.sql
        .prepare(
          `INSERT INTO patient_threads
             (tenant_id, id, patient_id, subject, status, priority, owner_id,
              opened_by, opened_kind, opened_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          this.db.tenantId,
          id,
          input.patientId,
          input.subject.trim(),
          status,
          priority,
          owner,
          input.by.actorId,
          input.authorKind,
          now,
          now
        );
      const message = this.insertMessage(id, input.patientId, input.body.trim(), input.by, input.authorKind, now);
      this.event(id, "opened", input.by, input.subject.trim());
      if (owner) this.event(id, "assigned", input.by, owner);
      return { thread: this.get(id)!, message };
    });
  }

  /** Adds a message. A closed thread cannot be written on; reopen it first. */
  reply(threadId: string, input: { body: string; by: Actor; authorKind: MessageAuthorKind }): MessageRow {
    if (!input.body.trim()) refuse("a reply needs a body");
    if (!(MESSAGE_AUTHORS as readonly string[]).includes(input.authorKind)) {
      refuse(`unknown message author ${input.authorKind}`);
    }
    const thread = this.require(threadId);
    if (thread.status === "closed") {
      refuse("that thread is closed; reopen it before writing, so the close is not silently undone");
    }
    const now = new Date().toISOString();
    const status: ThreadStatus = FROM_PATIENT.has(input.authorKind) ? "awaiting-clinic" : "awaiting-patient";
    return this.db.transaction(() => {
      const message = this.insertMessage(threadId, thread.patient_id, input.body.trim(), input.by, input.authorKind, now);
      this.db.sql
        .prepare("UPDATE patient_threads SET status = ? WHERE tenant_id = ? AND id = ?")
        .run(status, this.db.tenantId, threadId);
      this.event(threadId, "replied", input.by, input.authorKind);
      return message;
    });
  }

  /**
   * Closes a thread.
   *
   * The reason is the point. A thread the patient is still waiting on,
   * closed with nothing recorded, is the same silence as a result marked
   * acknowledged with no action. If the last speaker was the patient, the
   * reason has to say what was done instead of a written reply.
   */
  close(threadId: string, by: Actor & { reason: string }): ThreadRow {
    if (!by.reason.trim()) refuse("closing a thread needs to say what was done");
    const thread = this.require(threadId);
    if (thread.status === "closed") refuse("that thread is already closed");
    const last = this.lastMessage(threadId);
    if (last && FROM_PATIENT.has(last.author_kind) && by.reason.trim().length < 12) {
      refuse("the patient is still waiting; closing needs to say what was done about their message");
    }
    const now = new Date().toISOString();
    this.db.sql
      .prepare(
        `UPDATE patient_threads
            SET status = 'closed', closed_at = ?, closed_by = ?, close_reason = ?
          WHERE tenant_id = ? AND id = ?`
      )
      .run(now, by.actorId, by.reason.trim(), this.db.tenantId, threadId);
    this.event(threadId, "closed", by, by.reason.trim());
    return this.get(threadId)!;
  }

  reopen(threadId: string, by: Actor & { reason: string }): ThreadRow {
    if (!by.reason.trim()) refuse("reopening a thread needs a reason");
    const thread = this.require(threadId);
    if (thread.status !== "closed") refuse(`${an(thread.status)} thread is not closed`);
    const last = this.lastMessage(threadId);
    const status: ThreadStatus =
      last && FROM_PATIENT.has(last.author_kind) ? "awaiting-clinic" : "awaiting-patient";
    this.db.sql
      .prepare(
        `UPDATE patient_threads
            SET status = ?, closed_at = NULL, closed_by = NULL, close_reason = NULL
          WHERE tenant_id = ? AND id = ?`
      )
      .run(status, this.db.tenantId, threadId);
    this.event(threadId, "reopened", by, by.reason.trim());
    return this.get(threadId)!;
  }

  assign(threadId: string, ownerId: string, by: Actor & { reason: string }): ThreadRow {
    if (!ownerId.trim()) refuse("assigning a thread needs someone to give it to");
    if (!by.reason.trim()) refuse("handing a thread on needs a reason");
    const thread = this.require(threadId);
    if (thread.status === "closed") refuse("a closed thread cannot be assigned; reopen it first");
    this.db.sql
      .prepare("UPDATE patient_threads SET owner_id = ? WHERE tenant_id = ? AND id = ?")
      .run(ownerId, this.db.tenantId, threadId);
    this.event(threadId, "assigned", by, `${thread.owner_id ?? "nobody"} → ${ownerId}: ${by.reason.trim()}`);
    return this.get(threadId)!;
  }

  get(threadId: string): ThreadRow | undefined {
    return this.db.sql
      .prepare("SELECT * FROM patient_threads WHERE tenant_id = ? AND id = ?")
      .get(this.db.tenantId, threadId) as unknown as ThreadRow | undefined;
  }

  messages(threadId: string): MessageRow[] {
    return this.db.sql
      .prepare(
        "SELECT * FROM patient_messages WHERE tenant_id = ? AND thread_id = ? ORDER BY recorded_at, created_at"
      )
      .all(this.db.tenantId, threadId) as unknown as MessageRow[];
  }

  history(threadId: string): ThreadEvent[] {
    return this.db.sql
      .prepare(
        "SELECT seq, thread_id, at, event, actor_id, actor_kind, detail FROM patient_thread_events WHERE tenant_id = ? AND thread_id = ? ORDER BY seq"
      )
      .all(this.db.tenantId, threadId) as unknown as ThreadEvent[];
  }

  /** Open threads for a patient, newest first. Closed ones stay on `forPatient({ includeClosed: true })`. */
  forPatient(patientId: string, opts: { includeClosed?: boolean } = {}): ThreadRow[] {
    return this.db.sql
      .prepare(
        `SELECT * FROM patient_threads
          WHERE tenant_id = ? AND patient_id = ?${opts.includeClosed ? "" : " AND status != 'closed'"}
          ORDER BY opened_at DESC`
      )
      .all(this.db.tenantId, patientId) as unknown as ThreadRow[];
  }

  /**
   * Threads this clinician owes a reply.
   *
   * Oldest and most urgent first, never by arrival of the last click. A
   * chronological inbox is how a renewal request is buried under the day's
   * "thank you" notes.
   */
  inbox(ownerId: string): ThreadRow[] {
    const rows = this.db.sql
      .prepare(
        `SELECT * FROM patient_threads
          WHERE tenant_id = ? AND owner_id = ? AND status = 'awaiting-clinic'`
      )
      .all(this.db.tenantId, ownerId) as unknown as ThreadRow[];
    return this.rank(rows);
  }

  /** Patient messages that arrived and belong to nobody. */
  unassigned(): ThreadRow[] {
    const rows = this.db.sql
      .prepare(
        `SELECT * FROM patient_threads
          WHERE tenant_id = ? AND owner_id IS NULL AND status = 'awaiting-clinic'`
      )
      .all(this.db.tenantId) as unknown as ThreadRow[];
    return this.rank(rows);
  }

  private rank(rows: ThreadRow[]): ThreadRow[] {
    return rows.sort(
      (a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.opened_at.localeCompare(b.opened_at)
    );
  }

  private lastMessage(threadId: string): MessageRow | undefined {
    return this.db.sql
      .prepare(
        `SELECT * FROM patient_messages
          WHERE tenant_id = ? AND thread_id = ?
          ORDER BY recorded_at DESC, created_at DESC LIMIT 1`
      )
      .get(this.db.tenantId, threadId) as unknown as MessageRow | undefined;
  }

  private insertMessage(
    threadId: string,
    patientId: string,
    body: string,
    by: Actor,
    authorKind: MessageAuthorKind,
    at: string
  ): MessageRow {
    const id = randomUUID();
    this.db.sql
      .prepare(
        `INSERT INTO patient_messages
           (tenant_id, id, thread_id, patient_id, author_id, author_kind, body, recorded_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(this.db.tenantId, id, threadId, patientId, by.actorId, authorKind, body, at, at);
    return this.db.sql
      .prepare("SELECT * FROM patient_messages WHERE tenant_id = ? AND id = ?")
      .get(this.db.tenantId, id) as unknown as MessageRow;
  }

  private event(threadId: string, event: string, by: Actor, detail: string | null): void {
    this.db.sql
      .prepare(
        `INSERT INTO patient_thread_events (tenant_id, thread_id, at, event, actor_id, actor_kind, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(this.db.tenantId, threadId, new Date().toISOString(), event, by.actorId, by.actorKind, detail);
  }

  private require(id: string): ThreadRow {
    const row = this.get(id);
    if (!row) refuse(`no message thread ${id}`);
    return row;
  }
}
