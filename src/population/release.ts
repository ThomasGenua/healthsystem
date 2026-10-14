/**
 * De-identified release: registry numbers that can leave the building.
 *
 * The registry answers honestly inside the walls — patient-level rows, each
 * membership carrying its reason. Nothing of that shape may leave for a QI
 * committee, an evaluation, or a research request, because in the communities
 * this system is built for, **a small count is a name**. "3 of 41 diabetics
 * uncontrolled" identifies people to anyone who knows a community of 300 —
 * and so does "38 of 41 controlled", because subtraction works.
 *
 * So a release is aggregate counts only, with two suppressions applied and
 * the method stated on the face of the document:
 *
 * - **Small cells**: a count from 1 to threshold−1 is suppressed. Zero is
 *   published — the absence of patients names nobody — and the threshold
 *   defaults to 5, may be raised, and is refused below 2, because a
 *   threshold of 1 is suppression turned off while still wearing the label.
 * - **Complements**: where a published total would let subtraction recover a
 *   suppressed cell — the 38-of-41 problem — the complement is suppressed
 *   too. A rate is a division that undoes suppression, so a rate whose
 *   numerator or complement is suppressed is suppressed with it.
 *
 * A release also needs a **recipient** and a **purpose**, refused without
 * them: an extract with nobody it goes to is not a release, it is a leak
 * with paperwork pending. The route records both on the chained audit trail.
 * The privacy office's disclosure ledger is deliberately not used — it is
 * chart-scoped by construction ("a disclosure needs a patient"), and an
 * aggregate release names no chart; the trail is the right book.
 *
 * What this is not: consent for secondary use. Directives here govern who
 * may read a chart, and an aggregate count is not a chart read. Whether a
 * patient may opt out of being *counted* is a governance decision this
 * module does not make, and the release says so rather than implying it is
 * handled.
 */
import { Refusal } from "../core/refusal.ts";
import type { MeasureResult, CareGap, Unclassified } from "./registry.ts";
import type { WorkflowMeasureResult } from "./effectiveness.ts";

export const DEFAULT_SUPPRESSION_THRESHOLD = 5;

/** One published number, or the honest absence of one. */
export interface ReleasedCell {
  label: string;
  /** Null when suppressed. Never 0-by-substitution: zero is a real count. */
  count: number | null;
  suppressed: boolean;
  /** Why, when suppressed: its own size, or its complement's. */
  reason?: "small-cell" | "complementary";
}

export interface ReleaseMethod {
  threshold: number;
  suppressedCells: number;
  note: string;
}

export interface MeasureRelease {
  kind: "measure";
  ruleId: string;
  name: string;
  asOf: string;
  cells: ReleasedCell[];
  /** Null when refused by the registry or when suppression would be undone. */
  rate: number | null;
  /** The registry's own caveat, or the suppression's, in words. */
  caveat: string | null;
  method: ReleaseMethod;
  /** Explicit, so a reviewer does not have to prove a negative. */
  containsPatientLevelData: false;
}

export interface GapsRelease {
  kind: "gaps";
  ruleId: string;
  name: string;
  asOf: string;
  cells: ReleasedCell[];
  method: ReleaseMethod;
  containsPatientLevelData: false;
}

const METHOD_NOTE =
  "counts from 1 to threshold-1 are suppressed; zero is published; where a published total would let " +
  "subtraction recover a suppressed count, the complement is suppressed too; a rate that would undo a " +
  "suppression is suppressed with it; unclassified patients remain counted, never dropped; " +
  "consent for secondary use is a governance decision this release does not decide";

function resolveThreshold(threshold?: number): number {
  const k = threshold ?? DEFAULT_SUPPRESSION_THRESHOLD;
  if (!Number.isFinite(k) || k < 2) {
    throw new Refusal(
      `a suppression threshold of ${threshold} is suppression turned off while wearing the label; 2 is the floor and 5 the default`,
      400
    );
  }
  return k;
}

function requireDestination(recipient: string, purpose: string): void {
  if (!recipient.trim() || !purpose.trim()) {
    throw new Refusal(
      "a release needs a recipient and a purpose somebody can weigh afterwards — an extract with nobody it goes to is not a release",
      400
    );
  }
}

/** A count, folded to a cell under the small-cell rule. */
function cell(label: string, count: number, k: number): ReleasedCell {
  if (count > 0 && count < k) {
    return { label, count: null, suppressed: true, reason: "small-cell" };
  }
  return { label, count, suppressed: false };
}

function suppressComplementarily(a: ReleasedCell, b: ReleasedCell): void {
  // Two cells that sum to a published total: one suppressed and one published
  // is one suppressed and one recoverable. The complement goes too, and says
  // it went for the complement's sake rather than its own size.
  if (a.suppressed !== b.suppressed) {
    const survivor = a.suppressed ? b : a;
    survivor.count = null;
    survivor.suppressed = true;
    survivor.reason = "complementary";
  }
}

export interface ReleaseOptions {
  recipient: string;
  purpose: string;
  threshold?: number;
}

/**
 * A quality measure, releasable.
 *
 * The denominator is published even when small-ish (it is the cohort's size,
 * not an attribute of anyone in it) — but numerator and its complement
 * within the denominator protect each other, and the rate follows them.
 */
export function releaseMeasure(measure: MeasureResult, asOf: string, opts: ReleaseOptions): MeasureRelease {
  requireDestination(opts.recipient, opts.purpose);
  const k = resolveThreshold(opts.threshold);

  const denominator = cell("cohort", measure.denominator, k);
  const numerator = cell("meeting target", measure.numerator, k);
  const complement = cell("not meeting target", measure.denominator - measure.numerator, k);
  suppressComplementarily(numerator, complement);
  const unclassified = cell("could not be assessed", measure.unclassified.length, k);

  const cells = [denominator, numerator, complement, unclassified];
  const suppressedCells = cells.filter((c) => c.suppressed).length;

  // The registry may already have refused the rate; suppression only ever
  // takes more away. A rate over a suppressed numerator would hand the
  // count straight back — 3/41 is not less identifying as 0.073.
  const rate = numerator.suppressed || denominator.suppressed ? null : measure.rate;
  // The registry's caveat speaks in exact counts ("4 of 41 patients could
  // not be assessed"), which inside the walls is the honesty the registry
  // exists for — and in a release would un-suppress the very cell above it.
  // A suppressed number must not survive in prose.
  const caveat = numerator.suppressed
    ? "rate withheld: publishing it would undo the suppression of the counts beneath it"
    : unclassified.suppressed && measure.caveat
      ? "some patients could not be assessed; their count is suppressed as a small cell, and they remain in the denominator, not excluded from it"
      : measure.caveat;

  return {
    kind: "measure",
    ruleId: measure.ruleId,
    name: measure.name,
    asOf,
    cells,
    rate,
    caveat,
    method: { threshold: k, suppressedCells, note: METHOD_NOTE },
    containsPatientLevelData: false,
  };
}

export interface WorkflowMeasureRelease {
  kind: "workflow-measure";
  metricId: string;
  name: string;
  from: string;
  to: string;
  asOf: string;
  cells: ReleasedCell[];
  rate: number | null;
  caveat: string | null;
  method: ReleaseMethod;
  containsPatientLevelData: false;
}

/**
 * One of item 67's six effectiveness metrics, releasable.
 *
 * The same shape as `releaseMeasure()`, on purpose: the item's own text asks
 * to reuse the aggregate-release and small-cell protections this file
 * already has, not to build a second set for a second kind of denominator.
 * The denominator here is what was in scope for the window (submissions,
 * referrals, bookings, deliveries, or tasks) rather than a clinical cohort,
 * but a small count of either still names people, so it is folded the same
 * way.
 */
export function releaseWorkflowMeasure(measure: WorkflowMeasureResult, opts: ReleaseOptions): WorkflowMeasureRelease {
  requireDestination(opts.recipient, opts.purpose);
  const k = resolveThreshold(opts.threshold);

  const denominator = cell("in scope", measure.denominator, k);
  const numerator = cell("counted", measure.numerator, k);
  const complement = cell("not counted", measure.denominator - measure.numerator, k);
  suppressComplementarily(numerator, complement);
  const unclassified = cell("could not be classified", measure.unclassified.length, k);

  const cells = [denominator, numerator, complement, unclassified];
  const suppressedCells = cells.filter((c) => c.suppressed).length;

  const rate = numerator.suppressed || denominator.suppressed ? null : measure.rate;
  const caveat = numerator.suppressed
    ? "rate withheld: publishing it would undo the suppression of the counts beneath it"
    : unclassified.suppressed && measure.caveat
      ? "some cases could not be classified either way; their count is suppressed as a small cell, and they remain in the denominator, not excluded from it"
      : measure.caveat;

  return {
    kind: "workflow-measure",
    metricId: measure.metricId,
    name: measure.name,
    from: measure.from,
    to: measure.to,
    asOf: measure.asOf,
    cells,
    rate,
    caveat,
    method: { threshold: k, suppressedCells, note: METHOD_NOTE },
    containsPatientLevelData: false,
  };
}

/**
 * A care-gap summary, releasable.
 *
 * The gap list itself is a worklist — patient-keyed on purpose, for the
 * people chasing it — and never leaves. What leaves is how many, split by
 * never-done versus overdue, with open and closed protecting each other.
 */
export function releaseGaps(
  input: { gaps: CareGap[]; unclassified: Unclassified[]; cohortSize: number },
  ruleId: string,
  name: string,
  asOf: string,
  opts: ReleaseOptions
): GapsRelease {
  requireDestination(opts.recipient, opts.purpose);
  const k = resolveThreshold(opts.threshold);

  const cohort = cell("cohort", input.cohortSize, k);
  const open = cell("gap open", input.gaps.length, k);
  const closed = cell("gap closed", input.cohortSize - input.gaps.length, k);
  suppressComplementarily(open, closed);

  const neverDone = cell("never done", input.gaps.filter((g) => g.lastDone === null).length, k);
  const overdue = cell("overdue", input.gaps.filter((g) => g.lastDone !== null).length, k);
  if (open.suppressed) {
    // The halves sum to a count that was just suppressed — but under a
    // suppressed total every nonzero half is smaller than the threshold and
    // already suppressed for its own size, and a zero half stays published
    // because zero reveals no magnitude. This branch therefore guards
    // arithmetic drift rather than a reachable case today, and says so.
    for (const c of [neverDone, overdue]) {
      if (!c.suppressed && c.count !== 0) {
        c.count = null;
        c.suppressed = true;
        c.reason = "complementary";
      }
    }
  } else {
    // The total is published, so the halves protect each other the same way
    // open and closed do.
    suppressComplementarily(neverDone, overdue);
  }

  const unclassified = cell("could not be assessed", input.unclassified.length, k);

  const cells = [cohort, open, closed, neverDone, overdue, unclassified];
  return {
    kind: "gaps",
    ruleId,
    name,
    asOf,
    cells,
    method: { threshold: k, suppressedCells: cells.filter((c) => c.suppressed).length, note: METHOD_NOTE },
    containsPatientLevelData: false,
  };
}
