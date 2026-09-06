/**
 * Goals and actions on a care plan — the structured half item 61 asks for.
 *
 * `CarePlans` already writes a title, prose goal strings and a review date
 * onto the append-only record. What it cannot do is answer "who is doing
 * what by when, and has it happened" for any one goal, because a goal there
 * is a sentence inside a blob, not a thing with its own history.
 *
 * So a goal here is its own entry, and an action serving it is another,
 * using `record()`/`amend()` exactly as `CarePlans` does — the version chain
 * is what "preserve versions and distinguish proposed, approved, completed,
 * declined, superseded" already means once something lives on the append-only
 * record: nothing is overwritten, and a status change is a new version next
 * to the one it changed from.
 *
 * `status` here is five values chosen to match what the item asks for, not
 * FHIR's `Goal.lifecycleStatus` code system — which has no "superseded" and
 * uses "accepted"/"rejected" rather than "approved"/"declined". This is the
 * same kind of documented departure `reviewBy` already is on `CarePlans`:
 * named for what it is rather than forced into a code system it does not
 * match. `resourceType` still says `Goal`, and an action's says `Task`,
 * reusing an entry type record.ts declared and nothing had written yet.
 *
 * ## Revision is supersession, not editing
 *
 * A goal whose target changes is not the same goal with new numbers — the
 * old target was agreed to and then replaced, and a plan reviewed six months
 * later needs to see both facts. `revise()` amends the old entry to
 * `superseded` and writes a new one carrying the same care plan and a
 * `supersedes` pointer, rather than changing the description in place.
 *
 * ## What this does not decide
 *
 * Escalation criteria and clinical instructions are not generated here.
 * `CarePlans.record()` takes an optional `escalationCriteria` string that
 * only a clinician supplies; nothing in this file, or in the after-visit
 * summary built from it, invents one when it is absent — see src/clinical/avs.ts.
 */
import type { ClinicalEntry, ClinicalRecord } from "./record.ts";
import { refuse } from "../core/refusal.ts";

export const GOAL_STATUSES = ["proposed", "approved", "completed", "declined", "superseded"] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

export interface Actor {
  authorId: string;
  authorKind: string;
}

/** What an action serves, when it points at work that already exists elsewhere. */
export type LinkKind = "task" | "appointment" | "order" | "referral";
export interface ActionLink {
  kind: LinkKind;
  id: string;
}

/** The minimal existence check this needs from each linked store — see discharge.ts for the same loose coupling. */
export interface LinkSources {
  task?: { get(id: string): unknown };
  appointment?: { get(id: string): unknown };
  order?: { get(id: string): unknown };
  referral?: { get(id: string): unknown };
}

export interface GoalInput {
  patientId: string;
  carePlanId: string;
  description: string;
  reviewBy?: string;
  by: Actor;
}

export interface GoalView {
  recordId: string;
  patientId: string;
  carePlanId: string;
  description: string;
  status: GoalStatus;
  reviewBy: string | null;
  reason: string | null;
  supersededBy: string | null;
  authorId: string;
  recordedAt: string;
}

function parseGoal(entry: ClinicalEntry): GoalView {
  const c = JSON.parse(entry.content) as Record<string, unknown>;
  const status = (GOAL_STATUSES as readonly string[]).includes(String(c.status)) ? (c.status as GoalStatus) : "proposed";
  return {
    recordId: entry.record_id,
    patientId: entry.patient_id,
    carePlanId: typeof c.carePlanId === "string" ? c.carePlanId : "",
    description: typeof c.description === "string" ? c.description : "",
    status,
    reviewBy: typeof c.reviewBy === "string" ? c.reviewBy : null,
    reason: typeof c.reason === "string" ? c.reason : null,
    supersededBy: typeof c.supersededBy === "string" ? c.supersededBy : null,
    authorId: entry.author_id,
    recordedAt: entry.recorded_at,
  };
}

function goalBlob(g: GoalView, patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    resourceType: "Goal",
    carePlanId: g.carePlanId,
    description: g.description,
    status: g.status,
    ...(g.reviewBy ? { reviewBy: g.reviewBy } : {}),
    ...(g.reason ? { reason: g.reason } : {}),
    ...(g.supersededBy ? { supersededBy: g.supersededBy } : {}),
    ...patch,
  };
}

const OPEN_GOAL: readonly GoalStatus[] = ["proposed", "approved"];

export class Goals {
  private clinical: ClinicalRecord;

  constructor(clinical: ClinicalRecord) {
    this.clinical = clinical;
  }

  private require(recordId: string): GoalView {
    const entry = this.clinical.current(recordId);
    if (!entry || entry.entry_type !== "Goal" || entry.status === "entered-in-error") refuse(`no goal ${recordId}`, 404);
    return parseGoal(entry);
  }

  propose(input: GoalInput): GoalView {
    if (!input.description.trim()) refuse("a goal needs a description");
    if (!input.carePlanId.trim()) refuse("a goal has to belong to a care plan");
    if (input.reviewBy && Number.isNaN(Date.parse(input.reviewBy))) {
      refuse("a goal review date has to be a date, not a word");
    }
    const entry = this.clinical.record({
      entryType: "Goal",
      patientId: input.patientId,
      content: {
        resourceType: "Goal",
        carePlanId: input.carePlanId,
        description: input.description.trim(),
        status: "proposed",
        ...(input.reviewBy ? { reviewBy: input.reviewBy } : {}),
      },
      authorId: input.by.authorId,
      authorKind: input.by.authorKind,
    });
    return parseGoal(entry);
  }

  /** A clinician taking a proposed goal into the plan. */
  approve(recordId: string, by: Actor): GoalView {
    const current = this.require(recordId);
    if (current.status !== "proposed") refuse(`a ${current.status} goal cannot be approved`);
    return parseGoal(
      this.clinical.amend(recordId, goalBlob({ ...current, status: "approved" }), {
        authorId: by.authorId,
        authorKind: by.authorKind,
        reason: "approved",
      })
    );
  }

  decline(recordId: string, by: Actor & { reason: string }): GoalView {
    const current = this.require(recordId);
    if (current.status !== "proposed") refuse(`a ${current.status} goal cannot be declined`);
    if (!by.reason.trim()) refuse("declining a goal needs a reason");
    return parseGoal(
      this.clinical.amend(recordId, goalBlob({ ...current, status: "declined", reason: by.reason.trim() }), {
        authorId: by.authorId,
        authorKind: by.authorKind,
        reason: by.reason.trim(),
      })
    );
  }

  complete(recordId: string, by: Actor & { outcome: string }): GoalView {
    const current = this.require(recordId);
    if (current.status !== "approved") refuse(`only an approved goal can be completed, not ${current.status}`);
    if (!by.outcome.trim()) refuse("completing a goal needs a written outcome");
    return parseGoal(
      this.clinical.amend(recordId, goalBlob({ ...current, status: "completed", reason: by.outcome.trim() }), {
        authorId: by.authorId,
        authorKind: by.authorKind,
        reason: by.outcome.trim(),
      })
    );
  }

  /**
   * Replaces an open goal with a revised one. The old entry becomes
   * `superseded` — never edited in place — and the new one is what
   * `forPlan()` and the after-visit summary see from here on.
   */
  revise(recordId: string, input: { description?: string; reviewBy?: string; by: Actor & { reason: string } }): GoalView {
    const current = this.require(recordId);
    if (!OPEN_GOAL.includes(current.status)) refuse(`a ${current.status} goal cannot be revised`);
    if (!input.by.reason.trim()) refuse("revising a goal needs a reason");
    const replacement = this.propose({
      patientId: current.patientId,
      carePlanId: current.carePlanId,
      description: input.description?.trim() || current.description,
      ...(input.reviewBy ? { reviewBy: input.reviewBy } : current.reviewBy ? { reviewBy: current.reviewBy } : {}),
      by: input.by,
    });
    // The replacement is always proposed, whatever the old goal's status was
    // — a revision to an already-agreed goal goes through approve() again
    // rather than inheriting authority from whoever happened to call revise().
    this.clinical.amend(
      recordId,
      goalBlob({ ...current, status: "superseded", supersededBy: replacement.recordId, reason: input.by.reason.trim() }),
      { authorId: input.by.authorId, authorKind: input.by.authorKind, reason: input.by.reason.trim() }
    );
    return replacement;
  }

  get(recordId: string): GoalView | undefined {
    const entry = this.clinical.current(recordId);
    if (!entry || entry.entry_type !== "Goal" || entry.status === "entered-in-error") return undefined;
    return parseGoal(entry);
  }

  forPlan(carePlanId: string): GoalView[] {
    return this.clinical.currentOfType("Goal").map(parseGoal).filter((g) => g.carePlanId === carePlanId);
  }

  forPatient(patientId: string): GoalView[] {
    return this.clinical.chart(patientId, { entryType: "Goal" }).map(parseGoal);
  }
}

// ------------------------------------------------------------------- Actions

export interface ActionInput {
  patientId: string;
  carePlanId: string;
  goalId?: string;
  description: string;
  responsibleId: string;
  dueAt?: string;
  link?: ActionLink;
  by: Actor;
}

export interface ActionView {
  recordId: string;
  patientId: string;
  carePlanId: string;
  goalId: string | null;
  description: string;
  responsibleId: string;
  dueAt: string | null;
  status: GoalStatus;
  progress: string | null;
  reason: string | null;
  link: ActionLink | null;
  supersededBy: string | null;
  authorId: string;
  recordedAt: string;
}

function parseAction(entry: ClinicalEntry): ActionView {
  const c = JSON.parse(entry.content) as Record<string, unknown>;
  const status = (GOAL_STATUSES as readonly string[]).includes(String(c.status)) ? (c.status as GoalStatus) : "proposed";
  const link =
    c.link && typeof c.link === "object" && typeof (c.link as { kind?: unknown }).kind === "string"
      ? (c.link as ActionLink)
      : null;
  return {
    recordId: entry.record_id,
    patientId: entry.patient_id,
    carePlanId: typeof c.carePlanId === "string" ? c.carePlanId : "",
    goalId: typeof c.goalId === "string" ? c.goalId : null,
    description: typeof c.description === "string" ? c.description : "",
    responsibleId: typeof c.responsibleId === "string" ? c.responsibleId : "",
    dueAt: typeof c.dueAt === "string" ? c.dueAt : null,
    status,
    progress: typeof c.progress === "string" ? c.progress : null,
    reason: typeof c.reason === "string" ? c.reason : null,
    link,
    supersededBy: typeof c.supersededBy === "string" ? c.supersededBy : null,
    authorId: entry.author_id,
    recordedAt: entry.recorded_at,
  };
}

function actionBlob(a: ActionView, patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    resourceType: "Task",
    carePlanId: a.carePlanId,
    ...(a.goalId ? { goalId: a.goalId } : {}),
    description: a.description,
    responsibleId: a.responsibleId,
    ...(a.dueAt ? { dueAt: a.dueAt } : {}),
    status: a.status,
    ...(a.progress ? { progress: a.progress } : {}),
    ...(a.reason ? { reason: a.reason } : {}),
    ...(a.link ? { link: a.link } : {}),
    ...(a.supersededBy ? { supersededBy: a.supersededBy } : {}),
    ...patch,
  };
}

export class Actions {
  private clinical: ClinicalRecord;
  private links: LinkSources;

  constructor(clinical: ClinicalRecord, links: LinkSources = {}) {
    this.clinical = clinical;
    this.links = links;
  }

  private require(recordId: string): ActionView {
    const entry = this.clinical.current(recordId);
    if (!entry || entry.entry_type !== "Task" || entry.status === "entered-in-error") refuse(`no action ${recordId}`, 404);
    return parseAction(entry);
  }

  private validateLink(link?: ActionLink): void {
    if (!link) return;
    const source = this.links[link.kind];
    if (!source) return; // Not configured; recorded as asserted, the same as an encounterId nobody can check yet.
    if (!source.get(link.id)) refuse(`no ${link.kind} ${link.id} to link this action to`);
  }

  propose(input: ActionInput): ActionView {
    if (!input.description.trim()) refuse("an action needs a description");
    if (!input.carePlanId.trim()) refuse("an action has to belong to a care plan");
    if (!input.responsibleId.trim()) refuse("an action needs a responsible person");
    if (input.dueAt && Number.isNaN(Date.parse(input.dueAt))) refuse("an action due date has to be a date, not a word");
    this.validateLink(input.link);
    const entry = this.clinical.record({
      entryType: "Task",
      patientId: input.patientId,
      content: {
        resourceType: "Task",
        carePlanId: input.carePlanId,
        ...(input.goalId ? { goalId: input.goalId } : {}),
        description: input.description.trim(),
        responsibleId: input.responsibleId,
        ...(input.dueAt ? { dueAt: input.dueAt } : {}),
        status: "proposed",
        ...(input.link ? { link: input.link } : {}),
      },
      authorId: input.by.authorId,
      authorKind: input.by.authorKind,
    });
    return parseAction(entry);
  }

  approve(recordId: string, by: Actor): ActionView {
    const current = this.require(recordId);
    if (current.status !== "proposed") refuse(`a ${current.status} action cannot be approved`);
    return parseAction(
      this.clinical.amend(recordId, actionBlob({ ...current, status: "approved" }), {
        authorId: by.authorId,
        authorKind: by.authorKind,
        reason: "approved",
      })
    );
  }

  decline(recordId: string, by: Actor & { reason: string }): ActionView {
    const current = this.require(recordId);
    if (current.status !== "proposed") refuse(`a ${current.status} action cannot be declined`);
    if (!by.reason.trim()) refuse("declining an action needs a reason");
    return parseAction(
      this.clinical.amend(recordId, actionBlob({ ...current, status: "declined", reason: by.reason.trim() }), {
        authorId: by.authorId,
        authorKind: by.authorKind,
        reason: by.reason.trim(),
      })
    );
  }

  /** A progress note on an approved action. Stays approved — this is not completion. */
  recordProgress(recordId: string, by: Actor & { progress: string }): ActionView {
    const current = this.require(recordId);
    if (current.status !== "approved") refuse(`progress can only be recorded on an approved action, not ${current.status}`);
    if (!by.progress.trim()) refuse("a progress note needs text");
    return parseAction(
      this.clinical.amend(recordId, actionBlob({ ...current, progress: by.progress.trim() }), {
        authorId: by.authorId,
        authorKind: by.authorKind,
        reason: `progress: ${by.progress.trim()}`,
      })
    );
  }

  complete(recordId: string, by: Actor & { outcome: string }): ActionView {
    const current = this.require(recordId);
    if (current.status !== "approved") refuse(`only an approved action can be completed, not ${current.status}`);
    if (!by.outcome.trim()) refuse("completing an action needs a written outcome");
    return parseAction(
      this.clinical.amend(recordId, actionBlob({ ...current, status: "completed", reason: by.outcome.trim() }), {
        authorId: by.authorId,
        authorKind: by.authorKind,
        reason: by.outcome.trim(),
      })
    );
  }

  get(recordId: string): ActionView | undefined {
    const entry = this.clinical.current(recordId);
    if (!entry || entry.entry_type !== "Task" || entry.status === "entered-in-error") return undefined;
    return parseAction(entry);
  }

  forPlan(carePlanId: string): ActionView[] {
    return this.clinical.currentOfType("Task").map(parseAction).filter((a) => a.carePlanId === carePlanId);
  }

  forPatient(patientId: string): ActionView[] {
    return this.clinical.chart(patientId, { entryType: "Task" }).map(parseAction);
  }

  /** Approved actions past their due date, oldest first — the same shape as CarePlans.overdue(). */
  overdue(asOf = new Date().toISOString()): ActionView[] {
    const asOfMs = Date.parse(asOf);
    if (Number.isNaN(asOfMs)) return [];
    return this.clinical
      .currentOfType("Task")
      .map(parseAction)
      .filter((a) => {
        if (a.status !== "approved" || !a.dueAt) return false;
        const due = Date.parse(a.dueAt);
        return !Number.isNaN(due) && due < asOfMs;
      })
      .sort((a, b) => (a.dueAt ?? "").localeCompare(b.dueAt ?? ""));
  }
}
