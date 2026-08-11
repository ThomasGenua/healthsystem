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
 * `unavailable` and `truncated` are different problems: the first means the
 * panel is empty and should not be read as "none", the second means there is
 * more below the fold. Both must reach the reader.
 */
export type Incompleteness =
  | { reason: "unavailable"; detail: string }
  | { reason: "truncated"; shown: number; total: number };

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
  return s.incomplete.reason === "unavailable"
    ? `${name}: could not be loaded (${s.incomplete.detail}) — this panel is empty because it failed, not because there is nothing`
    : `${name}: showing ${s.incomplete.shown} of ${s.incomplete.total}`;
}

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

    const allergies = section(meds ? () => meds.allergies(patientId).filter((a) => a.kind !== "no-known-allergies") : undefined, limit);
    const medications = section(meds ? () => meds.current(patientId, { asPrescribed: true }) : undefined, limit);
    const unacknowledgedResults = section(
      orders ? () => orders.unacknowledged().filter((r) => r.patient_id === patientId) : undefined,
      limit
    );
    const openOrders = section(
      orders ? () => orders.forPatient(patientId).filter((o) => o.status === "placed" || o.status === "in-progress") : undefined,
      limit
    );
    const openReferrals = section(
      referrals ? () => referrals.open().filter((r) => r.patient_id === patientId) : undefined,
      limit
    );
    const openTasks = section(tasks ? () => tasks.forPatient(patientId) : undefined, limit);
    const recentNotes = section(notes ? () => notes.forPatient(patientId) : undefined, noteLimit);
    const problems = section(record ? () => record.chart(patientId, { entryType: "Condition" }) : undefined, limit);

    // Allergy status is read from the store rather than inferred from the
    // section: an empty list and a never-asked patient are the distinction
    // section 5 exists for, and inferring it here would undo that.
    let allergyStatus: AllergyStatus | "unavailable" = "unavailable";
    if (meds) {
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
    } else if (allergyStatus === "unavailable") {
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
      complete: sections.every(([, s]) => s.complete) && allergyStatus !== "unavailable",
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
