/**
 * The after-visit summary: what a patient is handed once the content behind
 * it has actually been approved.
 *
 * This is an assembler, not a store — it writes nothing and invents nothing.
 * Everything in it is read from somewhere a clinician (or, for the visit
 * itself, the scheduling and ordering machinery already covered by other
 * approvals) put it:
 *
 *   - the visit's own reason and disposition, from the encounter
 *   - goals and actions on the patient's care plans, filtered to `approved`
 *     and `completed` — a `proposed` goal is somebody's suggestion nobody
 *     has agreed to yet, and a `declined` one was refused; neither belongs
 *     in front of a patient as though it were the plan
 *   - orders placed during this specific visit, because `encounter_id` on
 *     an order is a real link rather than a guess from timing
 *   - each active plan's escalation criteria, verbatim if a clinician wrote
 *     one and a plain statement that none exists if not — never a generated
 *     "call 911 if..." paragraph standing in for a clinician's own words
 *
 * What this deliberately does not do: join referrals or prescriptions into
 * "this visit" by matching on time, because neither carries an encounter
 * link a summary could cite honestly. Attributing one to a visit it might
 * not belong to would be worse than leaving it out, so it is left out —
 * recorded here as a limitation, not silently worked around.
 */
import type { CarePlans } from "./careplans.ts";
import type { Goals, Actions, GoalView, ActionView } from "./goals.ts";
import type { Encounters } from "./encounters.ts";
import type { OrderStore, OrderRow } from "../orders/store.ts";
import { refuse } from "../core/refusal.ts";

export interface AfterVisitSummary {
  patientId: string;
  encounterId: string;
  visit: { reason: string; disposition: string | null; startedAt: string | null; endedAt: string | null };
  plans: Array<{
    recordId: string;
    title: string;
    escalationCriteria: string | { provided: false };
    goals: GoalView[];
    actions: ActionView[];
  }>;
  ordersFromThisVisit: OrderRow[];
  generatedAt: string;
}

export class AfterVisitSummaries {
  private carePlans: CarePlans;
  private goals: Goals;
  private actions: Actions;
  private encounters: Encounters;
  private orders: OrderStore;

  constructor(deps: {
    carePlans: CarePlans;
    goals: Goals;
    actions: Actions;
    encounters: Encounters;
    orders: OrderStore;
  }) {
    this.carePlans = deps.carePlans;
    this.goals = deps.goals;
    this.actions = deps.actions;
    this.encounters = deps.encounters;
    this.orders = deps.orders;
  }

  build(encounterId: string): AfterVisitSummary {
    const visit = this.encounters.get(encounterId);
    if (!visit) refuse(`no encounter ${encounterId}`, 404);

    const plans = this.carePlans.active(visit.patient_id).map((plan) => {
      const approvedOrBetter = new Set(["approved", "completed"]);
      return {
        recordId: plan.recordId,
        title: plan.title,
        escalationCriteria: plan.escalationCriteria ? plan.escalationCriteria : ({ provided: false } as const),
        goals: this.goals.forPlan(plan.recordId).filter((g) => approvedOrBetter.has(g.status)),
        actions: this.actions.forPlan(plan.recordId).filter((a) => approvedOrBetter.has(a.status)),
      };
    });

    const ordersFromThisVisit = this.orders.forPatient(visit.patient_id).filter((o) => o.encounter_id === encounterId);

    return {
      patientId: visit.patient_id,
      encounterId,
      visit: {
        reason: visit.reason,
        disposition: visit.disposition,
        startedAt: visit.started_at,
        endedAt: visit.ended_at,
      },
      plans,
      ordersFromThisVisit,
      generatedAt: new Date().toISOString(),
    };
  }
}
