/**
 * Whether the workflows built for items 58 through 66 actually help, over a
 * stated window, with the same honesty `MeasureResult` (registry.ts) already
 * holds a clinical measure to: a denominator that is the whole population in
 * scope rather than the assessable part of it, a preserved set of cases this
 * cannot classify, and a rate that refuses itself rather than being computed
 * over too much unknown.
 *
 * Six metrics, one per bullet in the item this answers:
 *
 *   - `timeToClinicianReview` — a pre-visit intake submission (item 60)
 *     reviewed within a stated target.
 *   - `unresolvedFollowUp` — a discharge follow-up item (item 62) resolved,
 *     not merely raised.
 *   - `referralCompletion` — a referral (section 8) that reached a real
 *     outcome, not just left "draft".
 *   - `notificationFailures` — a patient notice's delivery attempt (item 59)
 *     that a gateway confirms failed.
 *   - `missedAppointments` — a booking whose patient did not attend.
 *   - `staffTaskBurden` — a unified-inbox task (section 8) completed against
 *     what arrived, for one person or the whole tenant.
 *
 * ## What "unknown" means here, and where it does not appear
 *
 * Three of six have a genuine unknown: a notification whose delivery state
 * is `unknown` or an unreceipted `provider-accepted` (nobody can say it
 * reached anyone — see notice.ts's own DeliveryState doc), and a booking
 * whose appointment time has passed with no attendance outcome recorded
 * (nobody wrote down what happened). The other three — review, follow-up,
 * referral, task completion — have no genuine unknown: every row's status is
 * one of a small closed set an application wrote, never null, never
 * ambiguous. "Still open" is not unknown; it is a real, current answer that
 * correctly weighs down the rate, the same way a care gap never done weighs
 * down a registry's denominator. Saying so explicitly, per metric, is safer
 * than a shared type that implies every metric has some.
 *
 * ## What this deliberately does not invent
 *
 * No metric here defaults a target duration. "Reviewed within how long" and
 * "how long after the appointment before a missing outcome counts against
 * the count" are operational decisions a deployment makes, not facts this
 * module can assert — the same discipline `Trends.staleness()` already
 * applies to a clinical interval. Both are required parameters with no
 * fallback.
 */
import { MAX_UNCLASSIFIED_FRACTION } from "./registry.ts";
import { refuse } from "../core/refusal.ts";

export interface WorkflowUnclassified {
  /** The submission, item, referral, booking, delivery or task this is about. */
  id: string;
  patientId: string | null;
  reason: string;
}

export interface WorkflowMeasureResult {
  metricId: string;
  name: string;
  from: string;
  to: string;
  asOf: string;
  /** Everyone/everything in scope for the window. Not everyone assessed — that is the point. */
  denominator: number;
  numerator: number;
  rate: number | null;
  unclassified: WorkflowUnclassified[];
  complete: boolean;
  caveat: string | null;
}

function requireWindow(from: string, to: string): void {
  const f = new Date(from).getTime();
  const t = new Date(to).getTime();
  if (Number.isNaN(f) || Number.isNaN(t)) refuse("from and to must both be dates a Date can parse");
  if (t < f) refuse("to must not be before from");
}

function requirePositive(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    refuse(`${label} must be a positive number; there is no default, because the target is a deployment's decision, not a fact this module can assert`);
  }
}

function build(
  metricId: string,
  name: string,
  from: string,
  to: string,
  asOf: string,
  denominator: number,
  numerator: number,
  unclassified: WorkflowUnclassified[],
  extraCaveat?: string
): WorkflowMeasureResult {
  const tooMuchUnknown = denominator === 0 || unclassified.length / denominator > MAX_UNCLASSIFIED_FRACTION;
  const caveats: string[] = [];
  if (denominator === 0) caveats.push("nothing was in scope for this window; there is nothing to report");
  else if (unclassified.length > 0) {
    const pct = Math.round((unclassified.length / denominator) * 100);
    caveats.push(
      `${unclassified.length} of ${denominator} (${pct}%) could not be classified either way${tooMuchUnknown ? " — too many to publish a rate" : ""}`
    );
  }
  if (extraCaveat) caveats.push(extraCaveat);
  return {
    metricId,
    name,
    from,
    to,
    asOf,
    denominator,
    numerator,
    rate: tooMuchUnknown ? null : numerator / denominator,
    unclassified,
    complete: unclassified.length === 0,
    caveat: caveats.length ? caveats.join("; ") : null,
  };
}

// ------------------------------------------------------- time to clinician review

export interface ReviewSource {
  submittedBetween(from: string, to: string): Array<{ id: string; patient_id: string; status: string; submitted_at: string | null; reviewed_at: string | null }>;
}

/**
 * Denominator: pre-visit intake submissions that entered the review queue
 * (left `draft`) in the window. Exclusions: none beyond that — a draft
 * never submitted has no reviewer waiting on it. Numerator: of those,
 * reviewed within `target.withinHours` of submission. Unknown: none — a
 * submission is always draft, submitted or reviewed, never ambiguous; a
 * still-`submitted` one is not unknown, it is a real answer that correctly
 * counts against the rate the same way a never-done care gap does.
 */
export function timeToClinicianReview(
  source: ReviewSource,
  input: { from: string; to: string; target: { withinHours: number } },
  asOf: string = new Date().toISOString()
): WorkflowMeasureResult {
  requireWindow(input.from, input.to);
  requirePositive(input.target.withinHours, "target.withinHours");
  const rows = source.submittedBetween(input.from, input.to);
  const asOfMs = new Date(asOf).getTime();
  let numerator = 0;
  for (const r of rows) {
    if (!r.reviewed_at || !r.submitted_at) continue;
    const reviewedAt = new Date(r.reviewed_at).getTime();
    if (reviewedAt > asOfMs) continue; // A future review has not happened as of asOf; do not count it early.
    const hours = (reviewedAt - new Date(r.submitted_at).getTime()) / 3_600_000;
    if (hours <= input.target.withinHours) numerator++;
  }
  return build("time-to-clinician-review", "Time to clinician review", input.from, input.to, asOf, rows.length, numerator, []);
}

// --------------------------------------------------------------- unresolved follow-up

export interface FollowUpSource {
  itemsRaisedBetween(from: string, to: string): Array<{ id: string; patientId: string; status: string }>;
}

/**
 * Denominator: discharge follow-up items raised in the window, excluding
 * ones a clinician determined were not actually needed (`not-needed`) — an
 * item marked as never having required action is a different fact from one
 * still owed, and counting it against follow-through would understate care
 * that was, correctly, not given. Numerator: resolved as of `asOf`.
 * Unknown: none — status is always outstanding, resolved or not-needed.
 */
export function unresolvedFollowUp(
  source: FollowUpSource,
  input: { from: string; to: string },
  asOf: string = new Date().toISOString()
): WorkflowMeasureResult {
  requireWindow(input.from, input.to);
  const rows = source.itemsRaisedBetween(input.from, input.to).filter((r) => r.status !== "not-needed");
  const numerator = rows.filter((r) => r.status === "resolved").length;
  return build("unresolved-follow-up", "Unresolved discharge follow-up", input.from, input.to, asOf, rows.length, numerator, []);
}

// --------------------------------------------------------------- referral completion

export interface ReferralCompletionSource {
  sentBetween(from: string, to: string): Array<{ id: string; patient_id: string; status: string }>;
}

/**
 * Denominator: referrals actually sent (left `draft`) in the window,
 * excluding `declined` and `cancelled` — both are a real, deliberate
 * outcome a clinician or receiving service chose, not a referral that fell
 * through the cracks, and folding either into "not completed" would call a
 * decision a failure. Numerator: reached `closed` as of `asOf` — the one
 * status that carries a recorded outcome; `reported` alone is not counted,
 * matching `ReferralStore.waitDays()`'s own existing choice to keep a
 * referral's clock running until it is actually closed. Unknown: none —
 * every status this store writes is one of a fixed, unambiguous set.
 */
export function referralCompletion(
  source: ReferralCompletionSource,
  input: { from: string; to: string },
  asOf: string = new Date().toISOString()
): WorkflowMeasureResult {
  requireWindow(input.from, input.to);
  const rows = source.sentBetween(input.from, input.to).filter((r) => r.status !== "declined" && r.status !== "cancelled");
  const numerator = rows.filter((r) => r.status === "closed").length;
  return build("referral-completion", "Referral completion", input.from, input.to, asOf, rows.length, numerator, []);
}

// --------------------------------------------------------------- notification failures

export interface NotificationFailureSource {
  deliveriesBetween(from: string, to: string): Array<{ id: string; state: string }>;
}

/**
 * Denominator: delivery attempts that actually left `queued` in the window
 * — a held or not-yet-attempted send is not yet a fact about failure either
 * way. Numerator: `failed`, confirmed by the gateway. Unknown: `unknown`
 * (a receipt arrived that this build could not map) and `provider-accepted`
 * (the gateway took it; nothing has confirmed delivery, which — with no
 * receipt path configured — is where every attempt sits forever). Treating
 * an unconfirmed send as a success is exactly the optimism notice.ts's own
 * DeliveryState was built to refuse (H-183); this metric refuses it too.
 */
export function notificationFailures(
  source: NotificationFailureSource,
  input: { from: string; to: string },
  asOf: string = new Date().toISOString()
): WorkflowMeasureResult {
  requireWindow(input.from, input.to);
  const attempted = source.deliveriesBetween(input.from, input.to).filter((d) => d.state !== "queued");
  const numerator = attempted.filter((d) => d.state === "failed").length;
  const unclassified: WorkflowUnclassified[] = attempted
    .filter((d) => d.state === "unknown" || d.state === "provider-accepted")
    .map((d) => ({
      id: d.id,
      patientId: null,
      reason: d.state === "unknown" ? "a delivery receipt arrived that this build could not map" : "no delivery receipt has confirmed this attempt either way",
    }));
  return build("notification-failures", "Notification delivery failures", input.from, input.to, asOf, attempted.length, numerator, unclassified);
}

// --------------------------------------------------------------- missed appointments

export interface MissedAppointmentSource {
  bookingsBetween(from: string, to: string): Array<{ id: string; patient_id: string; status: string; startsAt: string }>;
}

/**
 * Denominator: bookings whose appointment fell in the window, excluding
 * `cancelled` ones — a cancellation is a different, deliberate outcome, not
 * a miss. Numerator: `did-not-attend`. Unknown: still `booked` with the
 * appointment time more than `outcomeGraceHours` in the past — nobody
 * recorded whether the patient came, which is a real gap in the record
 * rather than an attendance. The grace period is required, with no default,
 * for the same reason a review target is: how long is reasonable before a
 * missing outcome counts against the count is an operational decision, not
 * a fact this module can assert.
 */
export function missedAppointments(
  source: MissedAppointmentSource,
  input: { from: string; to: string; outcomeGraceHours: number },
  asOf: string = new Date().toISOString()
): WorkflowMeasureResult {
  requireWindow(input.from, input.to);
  requirePositive(input.outcomeGraceHours, "outcomeGraceHours");
  const rows = source.bookingsBetween(input.from, input.to).filter((b) => b.status !== "cancelled");
  const asOfMs = new Date(asOf).getTime();
  const numerator = rows.filter((b) => b.status === "did-not-attend").length;
  const unclassified: WorkflowUnclassified[] = rows
    .filter((b) => b.status === "booked" && asOfMs - new Date(b.startsAt).getTime() > input.outcomeGraceHours * 3_600_000)
    .map((b) => ({ id: b.id, patientId: b.patient_id, reason: "the appointment time has passed with no attendance outcome recorded" }));
  return build("missed-appointments", "Missed appointments", input.from, input.to, asOf, rows.length, numerator, unclassified);
}

// --------------------------------------------------------------- staff task burden

export interface TaskBurdenSource {
  createdBetween(from: string, to: string): Array<{ id: string; patient_id: string | null; status: string; owner_id: string | null }>;
}

/**
 * Denominator: tasks created in the window, excluding `cancelled` — a
 * decision not to do something is a different fact from not having done
 * it, matching TaskStore.cancel()'s own stated reason completion and
 * cancellation are distinct outcomes. Numerator: `completed` as of `asOf`.
 * Filtered to one owner when `ownerId` is given, since burden is a fact
 * about a person, not a tenant-wide average that could read as fine while
 * one person carries all of it. Unknown: none — a task's status is always
 * one of a fixed, unambiguous set.
 */
export function staffTaskBurden(
  source: TaskBurdenSource,
  input: { from: string; to: string; ownerId?: string },
  asOf: string = new Date().toISOString()
): WorkflowMeasureResult {
  requireWindow(input.from, input.to);
  const rows = source
    .createdBetween(input.from, input.to)
    .filter((t) => t.status !== "cancelled")
    .filter((t) => !input.ownerId || t.owner_id === input.ownerId);
  const numerator = rows.filter((t) => t.status === "completed").length;
  return build(
    "staff-task-burden",
    input.ownerId ? `Task completion for ${input.ownerId}` : "Task completion, tenant-wide",
    input.from,
    input.to,
    asOf,
    rows.length,
    numerator,
    []
  );
}
