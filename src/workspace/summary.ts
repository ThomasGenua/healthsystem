/**
 * The assembled chart: everything about a patient, in one place.
 *
 * Section 2 asks for a longitudinal view a clinician can open and act from.
 * The temptation is to treat that as presentation — join the tables, render
 * the panels — and the reason it is not is what this module is built around.
 *
 * A summary is read as complete. That is its entire clinical function: a
 * clinician opens it precisely so they do not have to go looking, and having
 * looked, they proceed on the basis that what is there is what there is. So
 * the dangerous failure is not an error. It is a section that came back short
 * — a store that threw and was caught, a list truncated at fifty, a category
 * nobody wired in — rendering as an empty panel that means "none" when it
 * actually means "not asked". An empty allergy panel is the same lie as an
 * empty allergy list, and the same one section 5 refuses to tell.
 *
 * So every section carries its own completeness, and the summary as a whole
 * carries `complete` and `omissions`. A section that could not be loaded says
 * so; a section that was cut short says how many it dropped. Nothing here
 * returns a short list silently, and `complete === false` is the flag a
 * renderer must surface rather than a detail it may ignore.
 *
 * The sources are the stores that already exist. This module owns no data and
 * no second copy of anything — it assembles, declares what it assembled, and
 * is honest about the rest.
 */
import type { ClinicalRecord, ClinicalEntry } from "../clinical/record.ts";
import type { PatientSummary } from "../clinical/patients.ts";
import type { MedicationStore, MedRow, AllergyRow } from "../meds/store.ts";
import type { AllergyStatus } from "../meds/safety.ts";
import type { OrderStore, OrderRow, ResultRow } from "../orders/store.ts";
import type { ReferralStore, ReferralRow } from "../work/referrals.ts";
import type { TaskStore, TaskRow } from "../work/tasks.ts";
import type { ClinicalNotes, NoteContent } from "../clinical/notes.ts";

/**
 * Why a section is not the whole truth.
 *
 * Three different problems, and a renderer must not merge them. `unavailable`
 * means the panel is empty and should not be read as "none". `truncated` means
 * there is more below the fold. `withheld` means the patient asked for this
 * section not to be shown to this reader — which is neither a fault nor a
 * shortage, and showing it as one would be both wrong and quietly alarming.
 *
 * The clinical difference is the point of keeping them apart. An allergy panel
 * that failed to load is a reason to go and look somewhere else before
 * prescribing. One the patient has locked is a reason to have a conversation,
 * or to break glass if the situation warrants it — and the refusal names the
 * way through rather than leaving a clinician to guess why a panel is bare.
 */
export type Incompleteness =
  | { reason: "unavailable"; detail: string }
  | { reason: "truncated"; shown: number; total: number }
  | { reason: "withheld"; detail: string };

export interface Section<T> {
  items: T[];
  /** True only when everything was loaded and nothing was dropped. */
  complete: boolean;
  /** Absent when complete. */
  incomplete?: Incompleteness;
}

export interface ChartSummary {
  patientId: string;
  /** Undefined when the patient is not in the index — itself worth showing. */
  patient: PatientSummary | undefined;
  generatedAt: string;

  /**
   * Three-valued, and carried up to the top of the summary rather than left
   * inside the allergies section. A clinician scanning a chart needs to see
   * "never asked" without reading a panel that looks empty.
   */
  allergyStatus: AllergyStatus | "unavailable";

  allergies: Section<AllergyRow>;
  medications: Section<MedRow>;
  /** Reported and not yet read by anybody, worst first. */
  unacknowledgedResults: Section<ResultRow>;
  openOrders: Section<OrderRow>;
  openReferrals: Section<ReferralRow>;
  openTasks: Section<TaskRow>;
  recentNotes: Section<{ entry: ClinicalEntry; note: NoteContent }>;
  problems: Section<ClinicalEntry>;

  /**
   * Whether every section is complete.
   *
   * The single flag a renderer has to honour. False means the chart in front
   * of the clinician is not the whole chart, and saying so is the difference
   * between a summary and a summary that can be trusted.
   */
  complete: boolean;
  /** What is missing and why, in words fit to put on the screen. */
  omissions: string[];
}

export interface SummaryOptions {
  /** Per-section cap. A summary is not a data dump; it does say when it cut. */
  limit?: number;
  noteLimit?: number;
  /**
   * Entry types this reader may not see, because the patient said so.
   *
   * Passed in rather than looked up: this module assembles a chart and owns no
   * opinion about consent, and the caller that knows who is asking is the one
   * that can answer. An empty or absent set means nothing is withheld, which
   * is the ordinary case.
   */
  withheldTypes?: ReadonlySet<string>;
}

/** The stores a summary is assembled from. Any may be absent. */
export interface WorkspaceSources {
  record?: ClinicalRecord;
  notes?: ClinicalNotes;
  meds?: MedicationStore;
  orders?: OrderStore;
  referrals?: ReferralStore;
  tasks?: TaskStore;
}

/**
 * Runs one section's query and reports what happened to it.
 *
 * The try/catch is deliberate and is the opposite of swallowing. A store that
 * throws must not take the whole chart down — a clinician with six of seven
 * panels is better served than one with an error page — but the panel it
 * leaves behind must say it failed rather than sit there looking like "none".
 */
function section<T>(
  load: (() => T[]) | undefined,
  limit: number,
  missing = "not configured in this deployment"
): Section<T> {
  if (!load) return { items: [], complete: false, incomplete: { reason: "unavailable", detail: missing } };
  let all: T[];
  try {
    all = load();
  } catch (err) {
    return {
      items: [],
      complete: false,
      incomplete: { reason: "unavailable", detail: (err as Error).message },
    };
  }
  if (all.length > limit) {
    return { items: all.slice(0, limit), complete: false, incomplete: { reason: "truncated", shown: limit, total: all.length } };
  }
  return { items: all, complete: true };
}

function describe(name: string, s: Section<unknown>): string | null {
  if (s.complete || !s.incomplete) return null;
  switch (s.incomplete.reason) {
    case "unavailable":
      return `${name}: could not be loaded (${s.incomplete.detail}) — this panel is empty because it failed, not because there is nothing`;
    case "withheld":
      return `${name}: ${s.incomplete.detail}`;
    case "truncated":
      return `${name}: showing ${s.incomplete.shown} of ${s.incomplete.total}`;
  }
}

/**
 * The entry type each section of the chart is made of.
 *
 * What lets a directive narrowed to one type withhold one panel instead of the
 * whole chart. Listed rather than derived because the mapping is a clinical
 * judgement, not a naming convention: a patient who locks `ServiceRequest` has
 * locked both their orders and their referrals, and somebody should have to
 * decide that on purpose.
 */
export const SECTION_TYPES = {
  allergies: "AllergyIntolerance",
  medications: "MedicationStatement",
  unacknowledgedResults: "Observation",
  openOrders: "ServiceRequest",
  openReferrals: "ServiceRequest",
  openTasks: "Task",
  recentNotes: "DocumentReference",
  problems: "Condition",
} as const;

/** Every entry type the assembled chart may return. */
export const CHART_TYPES: readonly string[] = [...new Set(Object.values(SECTION_TYPES))];

/**
 * Every entry type a worklist may return.
 *
 * A worklist spans patients rather than naming one, so no single patient's
 * directive can refuse it — rows are withheld individually instead. Declared
 * anyway so the route says what it serves, and so a kind of work added to it
 * later is covered rather than quietly exempt.
 */
export const WORKLIST_TYPES: readonly string[] = ["Observation", "ServiceRequest", "Task", "MedicationStatement"];

/**
 * Replaces a section with the fact that it was withheld.
 *
 * The items are dropped rather than counted, because a count is itself a
 * disclosure: "3 documents withheld" tells a reader the patient has
 * counselling notes, which is most of what the lockbox was hiding.
 */
function withhold<T>(detail: string): Section<T> {
  return { items: [], complete: false, incomplete: { reason: "withheld", detail } };
}

const WITHHELD_DETAIL = "withheld by a patient directive; break glass to see it if the situation warrants it";

export class Workspace {
  private sources: WorkspaceSources;

  constructor(sources: WorkspaceSources) {
    this.sources = sources;
  }

  /**
   * Assembles the chart.
   *
   * Never throws for a missing or failing section. It reports instead, because
   * the failure mode being guarded against is a clinician believing they have
   * seen everything.
   */
  chart(patientId: string, opts: SummaryOptions = {}): ChartSummary {
    const { record, notes, meds, orders, referrals, tasks } = this.sources;
    const limit = opts.limit ?? 50;
    const noteLimit = opts.noteLimit ?? 10;

    // A withheld section is not loaded and then filtered — it is not loaded.
    // Reading rows the patient locked in order to throw them away is still
    // reading them, and on a system whose whole argument is that access is
    // audited and consent is enforced before the read, that distinction is the
    // one being made.
    const hidden = opts.withheldTypes ?? new Set<string>();
    const sect = <T,>(key: keyof typeof SECTION_TYPES, load: (() => T[]) | undefined, cap: number): Section<T> =>
      hidden.has(SECTION_TYPES[key]) ? withhold<T>(WITHHELD_DETAIL) : section(load, cap);

    const allergies = sect("allergies", meds ? () => meds.allergies(patientId).filter((a) => a.kind !== "no-known-allergies") : undefined, limit);
    const medications = sect("medications", meds ? () => meds.current(patientId, { asPrescribed: true }) : undefined, limit);
    const unacknowledgedResults = sect(
      "unacknowledgedResults",
      orders ? () => orders.unacknowledged().filter((r) => r.patient_id === patientId) : undefined,
      limit
    );
    const openOrders = sect(
      "openOrders",
      orders ? () => orders.forPatient(patientId).filter((o) => o.status === "placed" || o.status === "in-progress") : undefined,
      limit
    );
    const openReferrals = sect(
      "openReferrals",
      referrals ? () => referrals.open().filter((r) => r.patient_id === patientId) : undefined,
      limit
    );
    const openTasks = sect("openTasks", tasks ? () => tasks.forPatient(patientId) : undefined, limit);
    const recentNotes = sect("recentNotes", notes ? () => notes.forPatient(patientId) : undefined, noteLimit);
    const problems = sect("problems", record ? () => record.chart(patientId, { entryType: "Condition" }) : undefined, limit);

    // Allergy status is read from the store rather than inferred from the
    // section: an empty list and a never-asked patient are the distinction
    // section 5 exists for, and inferring it here would undo that.
    //
    // And it is withheld with the section rather than left at the top of the
    // chart. "never-asked" or "clear" is itself a fact about the patient's
    // allergy history, so surfacing it beside a panel the patient has locked
    // would leak the shape of what was locked — the one thing this is supposed
    // to prevent.
    let allergyStatus: AllergyStatus | "unavailable" = "unavailable";
    if (meds && !hidden.has(SECTION_TYPES.allergies)) {
      try {
        allergyStatus = meds.allergyStatus(patientId);
      } catch {
        allergyStatus = "unavailable";
      }
    }

    let patient: PatientSummary | undefined;
    try {
      patient = record?.patientIndex.get(patientId);
    } catch {
      patient = undefined;
    }

    const sections: Array<[string, Section<unknown>]> = [
      ["Allergies", allergies],
      ["Medications", medications],
      ["Unacknowledged results", unacknowledgedResults],
      ["Open orders", openOrders],
      ["Open referrals", openReferrals],
      ["Open tasks", openTasks],
      ["Recent notes", recentNotes],
      ["Problems", problems],
    ];
    const omissions = sections.map(([n, s]) => describe(n, s)).filter((x): x is string => x !== null);
    if (allergyStatus === "never-asked") {
      omissions.push("Allergies: no allergy history has ever been recorded for this patient");
    } else if (allergyStatus === "unavailable" && !hidden.has(SECTION_TYPES.allergies)) {
      // Not when the section is withheld: the panel already says a directive
      // is why, and "could not be determined" beside it would read as a second,
      // technical fault and send somebody looking for a bug.
      omissions.push("Allergies: allergy status could not be determined");
    }

    return {
      patientId,
      patient,
      generatedAt: new Date().toISOString(),
      allergyStatus,
      allergies,
      medications,
      unacknowledgedResults,
      openOrders,
      openReferrals,
      openTasks,
      recentNotes,
      problems,
      // False when a section is withheld, as much as when one failed. The flag
      // means "this is not the whole chart", and a chart missing what the
      // patient locked is not the whole chart — a clinician needs to know that
      // before they act on it, even though nothing has gone wrong.
      complete:
        sections.every(([, s]) => s.complete) &&
        (allergyStatus !== "unavailable" || hidden.has(SECTION_TYPES.allergies)),
      omissions,
    };
  }

  /**
   * What is owed to a clinician right now, across every kind of work.
   *
   * A clinician's day is not one queue. Results wait in one place, referrals
   * in another, tasks in a third, and each system reports its own as though it
   * were the whole picture. The value of one view is that nothing is owed to
   * them somewhere they are not looking — so this too reports what it could
   * not reach, for the same reason.
   */
  worklist(
    clinicianId: string,
    opts: { limit?: number; asOf?: string } = {}
  ): {
    unacknowledgedResults: Section<ResultRow>;
    stalledReferrals: Section<ReferralRow>;
    ordersAwaitingResult: Section<OrderRow>;
    tasks: Section<TaskRow>;
    incompleteReconciliations: Section<{ id: string; patient_id: string; transition: string; started_at: string }>;
    complete: boolean;
    omissions: string[];
  } {
    const { orders, referrals, tasks, meds } = this.sources;
    const limit = opts.limit ?? 50;
    const asOf = opts.asOf ?? new Date().toISOString();

    const unacknowledgedResults = section(
      orders ? () => orders.unacknowledged({ responsibleId: clinicianId }) : undefined,
      limit
    );
    // Referrals and reconciliations are not owned per clinician in the model,
    // so these are the service's, not this person's. Said plainly rather than
    // filtered to nothing, which would be a quieter kind of wrong.
    const stalledReferrals = section(referrals ? () => referrals.stalled(asOf) : undefined, limit);
    const ordersAwaitingResult = section(
      orders ? () => orders.awaitingResult(asOf).filter((o) => o.responsible_id === clinicianId) : undefined,
      limit
    );
    const taskSection = section(tasks ? () => tasks.inbox(clinicianId) : undefined, limit);
    const incompleteReconciliations = section(meds ? () => meds.incompleteReconciliations() : undefined, limit);

    const named: Array<[string, Section<unknown>]> = [
      ["Unacknowledged results", unacknowledgedResults],
      ["Stalled referrals", stalledReferrals],
      ["Orders awaiting a result", ordersAwaitingResult],
      ["Tasks", taskSection],
      ["Incomplete reconciliations", incompleteReconciliations],
    ];
    return {
      unacknowledgedResults,
      stalledReferrals,
      ordersAwaitingResult,
      tasks: taskSection,
      incompleteReconciliations,
      complete: named.every(([, s]) => s.complete),
      omissions: named.map(([n, s]) => describe(n, s)).filter((x): x is string => x !== null),
    };
  }
}
