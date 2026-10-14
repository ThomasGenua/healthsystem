/**
 * Care plans on the chart.
 *
 * A plan that nobody will look at again is not a plan — it is a note with
 * a future tense. The clinical record already accepts a `CarePlan` entry;
 * this is the typed surface that writes one, so a caller cannot file an
 * active plan with no goal and no review date, and so completing or
 * revoking it is an amendment rather than an overwrite.
 *
 * FHIR CarePlan has no honest review-date field. `period.end` would mean
 * the plan itself ended. The date is stored as `reviewBy` on the content
 * blob, named for what it is. A plan past that date is work, not a
 * status — the same shape as a referral that went quiet.
 *
 * This is not a provincial care-plan product, not CDS, and not a library
 * of specialty pathways. A title, a goal, a review date, a status.
 */
import type { ClinicalEntry, ClinicalRecord } from "./record.ts";
import { refuse } from "../core/refusal.ts";

export const CARE_PLAN_STATUSES = ["draft", "active", "completed", "revoked"] as const;
export type CarePlanStatus = (typeof CARE_PLAN_STATUSES)[number];
export type CarePlanHistory = "documented" | "never-planned";

const OPEN: readonly CarePlanStatus[] = ["draft", "active"];

export interface CarePlanInput {
  patientId: string;
  title: string;
  goals: string[];
  reviewBy: string;
  by: { authorId: string; authorKind: string };
  status?: "draft" | "active";
  description?: string;
  encounterId?: string;
  sourceMessageId?: string;
  /**
   * What to tell the patient to watch for, and when to call rather than
   * wait — a clinician's own words, or nothing. An after-visit summary
   * assembled from this plan (src/clinical/avs.ts) either quotes this
   * verbatim or states plainly that none was provided; it never writes one.
   */
  escalationCriteria?: string;
}

export interface CarePlanView {
  recordId: string;
  patientId: string;
  encounterId: string | null;
  title: string;
  description: string | null;
  goals: string[];
  status: CarePlanStatus;
  reviewBy: string | null;
  outcome: string | null;
  reason: string | null;
  escalationCriteria: string | null;
  authorId: string;
  recordedAt: string;
}

function parse(entry: ClinicalEntry): CarePlanView {
  const c = JSON.parse(entry.content) as Record<string, unknown>;
  const goals = Array.isArray(c.goal)
    ? (c.goal as unknown[])
        .map((g) => {
          if (!g || typeof g !== "object") return "";
          const desc = (g as { description?: unknown }).description;
          if (desc && typeof desc === "object" && typeof (desc as { text?: unknown }).text === "string") {
            return (desc as { text: string }).text;
          }
          return "";
        })
        .filter((t) => t.length > 0)
    : [];
  const outcome = c.outcome && typeof c.outcome === "object" ? (c.outcome as { text?: unknown }).text : undefined;
  const reason =
    c.statusReason && typeof c.statusReason === "object" ? (c.statusReason as { text?: unknown }).text : undefined;
  const status = (CARE_PLAN_STATUSES as readonly string[]).includes(String(c.status))
    ? (c.status as CarePlanStatus)
    : "active";
  return {
    recordId: entry.record_id,
    patientId: entry.patient_id,
    encounterId: entry.encounter_id,
    title: typeof c.title === "string" ? c.title : "",
    description: typeof c.description === "string" ? c.description : null,
    goals,
    status,
    reviewBy: typeof c.reviewBy === "string" ? c.reviewBy : null,
    outcome: typeof outcome === "string" ? outcome : null,
    reason: typeof reason === "string" ? reason : null,
    escalationCriteria: typeof c.escalationCriteria === "string" ? c.escalationCriteria : null,
    authorId: entry.author_id,
    recordedAt: entry.recorded_at,
  };
}

function blob(plan: CarePlanView, patch: Record<string, unknown>): Record<string, unknown> {
  return {
    resourceType: "CarePlan",
    status: plan.status,
    intent: "plan",
    title: plan.title,
    ...(plan.description ? { description: plan.description } : {}),
    goal: plan.goals.map((text) => ({ description: { text } })),
    ...(plan.reviewBy ? { reviewBy: plan.reviewBy } : {}),
    ...(plan.outcome ? { outcome: { text: plan.outcome } } : {}),
    ...(plan.reason ? { statusReason: { text: plan.reason } } : {}),
    ...(plan.escalationCriteria ? { escalationCriteria: plan.escalationCriteria } : {}),
    ...patch,
  };
}

export class CarePlans {
  private clinical: ClinicalRecord;

  constructor(clinical: ClinicalRecord) {
    this.clinical = clinical;
  }

  record(input: CarePlanInput): CarePlanView {
    if (!input.title.trim()) refuse("a care plan needs a title");
    const goals = input.goals.map((g) => g.trim()).filter((g) => g.length > 0);
    if (goals.length === 0) refuse("a care plan without a goal is not a plan");
    if (!input.reviewBy.trim()) refuse("a care plan without a review date is refused, not defaulted");
    if (Number.isNaN(Date.parse(input.reviewBy))) {
      refuse("a care plan review date has to be a date, not a word");
    }
    const status = input.status ?? "active";
    if (status !== "draft" && status !== "active") {
      refuse("a new care plan is draft or active; completing and revoking are amendments");
    }
    const content: Record<string, unknown> = {
      resourceType: "CarePlan",
      status,
      intent: "plan",
      title: input.title.trim(),
      ...(input.description?.trim() ? { description: input.description.trim() } : {}),
      goal: goals.map((text) => ({ description: { text } })),
      reviewBy: input.reviewBy.trim(),
      ...(input.escalationCriteria?.trim() ? { escalationCriteria: input.escalationCriteria.trim() } : {}),
    };
    const entry = this.clinical.record({
      entryType: "CarePlan",
      patientId: input.patientId,
      content,
      authorId: input.by.authorId,
      authorKind: input.by.authorKind,
      ...(input.encounterId ? { encounterId: input.encounterId } : {}),
      ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}),
    });
    return parse(entry);
  }

  get(recordId: string): CarePlanView | undefined {
    const entry = this.clinical.current(recordId);
    if (!entry || entry.entry_type !== "CarePlan" || entry.status === "entered-in-error") return undefined;
    return parse(entry);
  }

  forPatient(patientId: string): CarePlanView[] {
    return this.clinical.chart(patientId, { entryType: "CarePlan" }).map(parse);
  }

  active(patientId: string): CarePlanView[] {
    return this.forPatient(patientId).filter((p) => p.status === "active");
  }

  /** Three-valued the same way allergies are: an empty list is not an answer. */
  historyStatus(patientId: string): CarePlanHistory {
    return this.forPatient(patientId).length === 0 ? "never-planned" : "documented";
  }

  /**
   * Active plans past their review date, oldest first.
   *
   * Service-wide, the same way stalled referrals are: a plan nobody owns is
   * still a plan that is owed a look. Draft, completed and revoked plans
   * are not this list.
   */
  overdue(asOf = new Date().toISOString()): CarePlanView[] {
    const asOfMs = Date.parse(asOf);
    if (Number.isNaN(asOfMs)) return [];
    return this.clinical
      .currentOfType("CarePlan")
      .map(parse)
      .filter((p) => {
        if (p.status !== "active" || !p.reviewBy) return false;
        const due = Date.parse(p.reviewBy);
        return !Number.isNaN(due) && due < asOfMs;
      })
      .sort((a, b) => (a.reviewBy ?? "").localeCompare(b.reviewBy ?? ""));
  }

  complete(
    recordId: string,
    by: { authorId: string; authorKind: string; outcome: string }
  ): CarePlanView {
    const current = this.get(recordId);
    if (!current) refuse(`no care plan ${recordId}`, 404);
    if (!OPEN.includes(current.status)) {
      refuse("only an open care plan can be completed");
    }
    const outcome = by.outcome.trim();
    if (outcome.length < 12) refuse("completing a care plan needs a written outcome (12+ characters)");
    return parse(
      this.clinical.amend(recordId, blob(current, { status: "completed", outcome: { text: outcome } }), {
        authorId: by.authorId,
        authorKind: by.authorKind,
        reason: outcome,
      })
    );
  }

  revoke(recordId: string, by: { authorId: string; authorKind: string; reason: string }): CarePlanView {
    const current = this.get(recordId);
    if (!current) refuse(`no care plan ${recordId}`, 404);
    if (!OPEN.includes(current.status)) {
      refuse("only an open care plan can be revoked");
    }
    const reason = by.reason.trim();
    if (reason.length < 12) refuse("revoking a care plan needs a written reason (12+ characters)");
    return parse(
      this.clinical.amend(recordId, blob(current, { status: "revoked", statusReason: { text: reason } }), {
        authorId: by.authorId,
        authorKind: by.authorKind,
        reason,
      })
    );
  }

  retract(recordId: string, by: { authorId: string; authorKind: string; reason: string }): CarePlanView {
    return parse(this.clinical.retract(recordId, by));
  }
}
