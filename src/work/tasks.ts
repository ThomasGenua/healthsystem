/**
 * The unified inbox.
 *
 * Section 8's requirement is one sentence long and is the whole design:
 * clinically important work must not disappear between people or
 * organizations. Work is rarely lost by being deleted. It is lost by being
 * reassigned to someone who has left, closed with nothing to show for it, or
 * left owned by nobody — which means it appears on nobody's list and is
 * therefore invisible in exactly the way that matters.
 *
 * So three things are structural rather than procedural:
 *
 *   Nothing is ever removed. `cancel` is a status with a reason, distinct from
 *   `complete`, because "we decided not to" and "we did it" are different
 *   answers to an audit and only one of them is aftercare.
 *
 *   Completion requires evidence. A task closed with an empty hand is
 *   indistinguishable afterwards from one abandoned, and the difference is the
 *   entire question a review asks.
 *
 *   An unowned item is visible, not absent. `unassigned()` is a queue someone
 *   is responsible for, so the failure mode where an item quietly belongs to
 *   nobody becomes a list rather than a silence.
 *
 * Every transition is appended to a log with an actor and a reason, so
 * delegation history is a record rather than a reconstruction.
 */
import { randomUUID } from "node:crypto";
import { an } from "../core/text.ts";
import type { Db } from "../db.ts";

/** What the item is, which is also which queue it belongs in. */
export type TaskKind =
  | "result-review"
  | "message"
  | "referral"
  | "prescription-renewal"
  | "form"
  | "document"
  | "care-gap"
  | "administrative"
  | "privacy-request"
  | "portal-submission"
  // A patient the clinic could not reach. Its own kind rather than
  // administrative: the work is chasing a person, and burying it among
  // configuration chores is how "nobody could be told" stops being visible.
  | "patient-contact";

export type TaskPriority = "routine" | "urgent" | "stat";
export type TaskStatus = "open" | "in-progress" | "completed" | "cancelled";

export interface TaskRow {
  tenant_id: string;
  id: string;
  kind: TaskKind;
  title: string;
  patient_id: string | null;
  encounter_id: string | null;
  priority: TaskPriority;
  status: TaskStatus;
  owner_id: string | null;
  due_at: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  source: string | null;
  source_message_id: string | null;
  correlation_id: string | null;
}

export interface TaskEvent {
  seq: number;
  task_id: string;
  at: string;
  event: string;
  actor_id: string;
  actor_kind: string;
  from_owner: string | null;
  to_owner: string | null;
  detail: string | null;
  evidence: string | null;
}

export interface Actor {
  actorId: string;
  actorKind: string;
}

const PRIORITY_RANK: Record<TaskPriority, number> = { stat: 0, urgent: 1, routine: 2 };

export class TaskStore {
  private db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  create(input: {
    kind: TaskKind;
    title: string;
    by: Actor;
    patientId?: string;
    encounterId?: string;
    priority?: TaskPriority;
    ownerId?: string;
    dueAt?: string;
    source?: string;
    sourceMessageId?: string;
    correlationId?: string;
  }): TaskRow {
    const id = randomUUID();
    const now = new Date().toISOString();
    return this.db.transaction(() => {
      this.db.sql
        .prepare(
          `INSERT INTO tasks
             (tenant_id, id, kind, title, patient_id, encounter_id, priority, status, owner_id,
              due_at, created_at, updated_at, source, source_message_id, correlation_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          this.db.tenantId,
          id,
          input.kind,
          input.title,
          input.patientId ?? null,
          input.encounterId ?? null,
          input.priority ?? "routine",
          input.ownerId ?? null,
          input.dueAt ?? null,
          now,
          now,
          input.source ?? null,
          input.sourceMessageId ?? null,
          input.correlationId ?? null
        );
      this.event(id, "created", input.by, { toOwner: input.ownerId ?? null, detail: input.title });
      return this.get(id)!;
    });
  }

  /**
   * Gives the item to someone.
   *
   * Reassignment records both ends. "Who had this when it went wrong" is the
   * question asked afterwards, and an owner column alone cannot answer it —
   * it only ever knows who has it now.
   */
  assign(taskId: string, ownerId: string, by: Actor & { reason?: string }): TaskRow {
    const task = this.require(taskId);
    if (task.status === "completed" || task.status === "cancelled") {
      throw new Error(`${an(task.status)} task cannot be reassigned; reopen it or raise a new one`);
    }
    return this.db.transaction(() => {
      this.db.sql
        .prepare("UPDATE tasks SET owner_id = ?, updated_at = ? WHERE tenant_id = ? AND id = ?")
        .run(ownerId, new Date().toISOString(), this.db.tenantId, taskId);
      this.event(taskId, task.owner_id ? "reassigned" : "assigned", by, {
        fromOwner: task.owner_id,
        toOwner: ownerId,
        ...(by.reason ? { detail: by.reason } : {}),
      });
      return this.get(taskId)!;
    });
  }

  /**
   * Hands an item back to the unassigned queue.
   *
   * Deliberately an action with a reason rather than a side effect of somebody
   * leaving. Work released on purpose is visible; work stranded on a departed
   * account is not, and that is the difference this exists to make.
   */
  release(taskId: string, by: Actor & { reason: string }): TaskRow {
    if (!by.reason.trim()) throw new Error("releasing an item needs a reason");
    const task = this.require(taskId);
    return this.db.transaction(() => {
      this.db.sql
        .prepare("UPDATE tasks SET owner_id = NULL, updated_at = ? WHERE tenant_id = ? AND id = ?")
        .run(new Date().toISOString(), this.db.tenantId, taskId);
      this.event(taskId, "released", by, { fromOwner: task.owner_id, detail: by.reason });
      return this.get(taskId)!;
    });
  }

  start(taskId: string, by: Actor): TaskRow {
    const task = this.require(taskId);
    if (task.status !== "open") throw new Error(`${an(task.status)} task cannot be started`);
    return this.setStatus(taskId, "in-progress", by, {});
  }

  /**
   * Closes an item as done.
   *
   * Evidence is required, and it is the point. A task closed with nothing to
   * show for it is indistinguishable, afterwards, from one abandoned — and
   * "the result was acknowledged" versus "the result was marked acknowledged"
   * is precisely the distinction a review of a missed diagnosis turns on.
   */
  complete(taskId: string, by: Actor & { evidence: string }): TaskRow {
    if (!by.evidence.trim()) {
      throw new Error("completing an item needs evidence of what was done");
    }
    const task = this.require(taskId);
    if (task.status === "completed") throw new Error("this task is already completed");
    if (task.status === "cancelled") throw new Error("a cancelled task cannot be completed");
    return this.setStatus(taskId, "completed", by, { evidence: by.evidence });
  }

  /**
   * Closes an item as not to be done.
   *
   * Separate from completion because "we decided not to" and "we did it" are
   * different answers, and only one of them is aftercare.
   */
  cancel(taskId: string, by: Actor & { reason: string }): TaskRow {
    if (!by.reason.trim()) throw new Error("cancelling an item needs a reason");
    const task = this.require(taskId);
    if (task.status === "completed") throw new Error("a completed task cannot be cancelled");
    return this.setStatus(taskId, "cancelled", by, { detail: by.reason });
  }

  /** Puts a closed item back in play, which is a transition like any other. */
  reopen(taskId: string, by: Actor & { reason: string }): TaskRow {
    if (!by.reason.trim()) throw new Error("reopening an item needs a reason");
    const task = this.require(taskId);
    if (task.status === "open" || task.status === "in-progress") throw new Error("this task is not closed");
    return this.db.transaction(() => {
      this.db.sql
        .prepare("UPDATE tasks SET status = 'open', closed_at = NULL, updated_at = ? WHERE tenant_id = ? AND id = ?")
        .run(new Date().toISOString(), this.db.tenantId, taskId);
      this.event(taskId, "reopened", by, { detail: by.reason });
      return this.get(taskId)!;
    });
  }

  /** Raises the priority, recording who decided and why. */
  escalate(taskId: string, priority: TaskPriority, by: Actor & { reason: string }): TaskRow {
    if (!by.reason.trim()) throw new Error("escalating an item needs a reason");
    const task = this.require(taskId);
    return this.db.transaction(() => {
      this.db.sql
        .prepare("UPDATE tasks SET priority = ?, updated_at = ? WHERE tenant_id = ? AND id = ?")
        .run(priority, new Date().toISOString(), this.db.tenantId, taskId);
      this.event(taskId, "escalated", by, { detail: `${task.priority} to ${priority}: ${by.reason}` });
      return this.get(taskId)!;
    });
  }

  get(taskId: string): TaskRow | undefined {
    return this.db.sql
      .prepare("SELECT * FROM tasks WHERE tenant_id = ? AND id = ?")
      .get(this.db.tenantId, taskId) as unknown as TaskRow | undefined;
  }

  /** Every transition, oldest first. The delegation history. */
  history(taskId: string): TaskEvent[] {
    return this.db.sql
      .prepare("SELECT * FROM task_events WHERE tenant_id = ? AND task_id = ? ORDER BY seq")
      .all(this.db.tenantId, taskId) as unknown as TaskEvent[];
  }

  /**
   * One person's inbox.
   *
   * Ordered by urgency, then by how overdue, then by age — not by arrival.
   * A chronological inbox buries the one item that mattered under the forty
   * that did not, which is the mechanism by which a critical result is missed
   * without anyone doing anything wrong.
   */
  inbox(ownerId: string, opts: { kind?: TaskKind; limit?: number } = {}): TaskRow[] {
    const rows = this.db.sql
      .prepare(
        `SELECT * FROM tasks
          WHERE tenant_id = ? AND owner_id = ? AND status IN ('open', 'in-progress')
            ${opts.kind ? "AND kind = ?" : ""}`
      )
      .all(...([this.db.tenantId, ownerId, ...(opts.kind ? [opts.kind] : [])] as never[])) as unknown as TaskRow[];
    return this.rank(rows).slice(0, Math.min(opts.limit ?? 100, 500));
  }

  /**
   * Items nobody owns.
   *
   * The queue that exists so that "belongs to nobody" is a list rather than a
   * silence. Every item here is work that arrived and has not been picked up.
   */
  unassigned(opts: { kind?: TaskKind; limit?: number } = {}): TaskRow[] {
    const rows = this.db.sql
      .prepare(
        `SELECT * FROM tasks
          WHERE tenant_id = ? AND owner_id IS NULL AND status IN ('open', 'in-progress')
            ${opts.kind ? "AND kind = ?" : ""}`
      )
      .all(...([this.db.tenantId, ...(opts.kind ? [opts.kind] : [])] as never[])) as unknown as TaskRow[];
    return this.rank(rows).slice(0, Math.min(opts.limit ?? 100, 500));
  }

  /** Open items past their due date, most overdue first. */
  overdue(asOf = new Date().toISOString()): TaskRow[] {
    const rows = this.db.sql
      .prepare(
        `SELECT * FROM tasks
          WHERE tenant_id = ? AND status IN ('open', 'in-progress') AND due_at IS NOT NULL AND due_at < ?`
      )
      .all(this.db.tenantId, asOf) as unknown as TaskRow[];
    return rows.sort((a, b) => (a.due_at ?? "").localeCompare(b.due_at ?? ""));
  }

  /** Open work for a patient, so a chart can show what is outstanding. */
  forPatient(patientId: string): TaskRow[] {
    const rows = this.db.sql
      .prepare("SELECT * FROM tasks WHERE tenant_id = ? AND patient_id = ? AND status IN ('open', 'in-progress')")
      .all(this.db.tenantId, patientId) as unknown as TaskRow[];
    return this.rank(rows);
  }

  /**
   * Everything sharing a correlation identifier.
   *
   * How a loop is recognised as one thing: a referral raised here and the
   * consult report that answers it later are two items and one question.
   */
  correlated(correlationId: string): TaskRow[] {
    return this.db.sql
      .prepare("SELECT * FROM tasks WHERE tenant_id = ? AND correlation_id = ? ORDER BY created_at")
      .all(this.db.tenantId, correlationId) as unknown as TaskRow[];
  }

  /** Counts for a workload view: how much is open, unowned and overdue. */
  load(): { open: number; unassigned: number; overdue: number; byKind: Record<string, number> } {
    const open = this.db.sql
      .prepare("SELECT COUNT(*) AS n FROM tasks WHERE tenant_id = ? AND status IN ('open', 'in-progress')")
      .get(this.db.tenantId) as { n: number };
    const unowned = this.db.sql
      .prepare(
        "SELECT COUNT(*) AS n FROM tasks WHERE tenant_id = ? AND owner_id IS NULL AND status IN ('open', 'in-progress')"
      )
      .get(this.db.tenantId) as { n: number };
    const byKind = this.db.sql
      .prepare(
        "SELECT kind, COUNT(*) AS n FROM tasks WHERE tenant_id = ? AND status IN ('open', 'in-progress') GROUP BY kind"
      )
      .all(this.db.tenantId) as Array<{ kind: string; n: number }>;
    return {
      open: open.n,
      unassigned: unowned.n,
      overdue: this.overdue().length,
      byKind: Object.fromEntries(byKind.map((r) => [r.kind, r.n])),
    };
  }

  private rank(rows: TaskRow[]): TaskRow[] {
    return rows.sort((a, b) => {
      const p = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
      if (p !== 0) return p;
      // A due date beats no due date: something with a deadline is more likely
      // to be the thing that gets forgotten.
      if (a.due_at && b.due_at && a.due_at !== b.due_at) return a.due_at.localeCompare(b.due_at);
      if (a.due_at && !b.due_at) return -1;
      if (!a.due_at && b.due_at) return 1;
      return a.created_at.localeCompare(b.created_at);
    });
  }

  private setStatus(
    taskId: string,
    status: TaskStatus,
    by: Actor,
    extra: { detail?: string; evidence?: string }
  ): TaskRow {
    return this.db.transaction(() => {
      const now = new Date().toISOString();
      const closing = status === "completed" || status === "cancelled";
      this.db.sql
        .prepare("UPDATE tasks SET status = ?, updated_at = ?, closed_at = ? WHERE tenant_id = ? AND id = ?")
        .run(status, now, closing ? now : null, this.db.tenantId, taskId);
      this.event(taskId, status, by, extra);
      return this.get(taskId)!;
    });
  }

  private event(
    taskId: string,
    event: string,
    by: Actor,
    extra: { fromOwner?: string | null; toOwner?: string | null; detail?: string; evidence?: string }
  ): void {
    this.db.sql
      .prepare(
        `INSERT INTO task_events (tenant_id, task_id, at, event, actor_id, actor_kind, from_owner, to_owner, detail, evidence)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        this.db.tenantId,
        taskId,
        new Date().toISOString(),
        event,
        by.actorId,
        by.actorKind,
        extra.fromOwner ?? null,
        extra.toOwner ?? null,
        extra.detail ?? null,
        extra.evidence ?? null
      );
  }

  private require(taskId: string): TaskRow {
    const task = this.get(taskId);
    if (!task) throw new Error(`no task ${taskId}`);
    return task;
  }
}
