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
import type { Immunizations, ImmunizationView, ImmunizationHistory } from "../clinical/immunizations.ts";
import type { Vitals, VitalView, VitalHistory } from "../clinical/vitals.ts";
import type { Procedures, ProcedureView, ProcedureHistory } from "../clinical/procedures.ts";
import type { CarePlans, CarePlanView, CarePlanHistory } from "../clinical/careplans.ts";
import type { PatientDocuments, PatientDocumentView, DocumentHistory } from "../clinical/documents.ts";
import type { CareTeam, CareTeamRow } from "../clinical/careteam.ts";
import type { Coverage, CoverageRow } from "../clinical/coverage.ts";
import type { Schedule, SlotRow, BookingRow } from "../schedule/store.ts";
import type { PatientMessaging, ThreadRow } from "../patient/messaging.ts";

/**
 * Why a section is not the whole truth.
 *
 * Four different problems, and a renderer must not merge them. `unavailable`
 * means the panel is empty and should not be read as "none". `truncated` means
 * there is more below the fold. `withheld` means the patient asked for this
 * section not to be shown to this reader — which is neither a fault nor a
 * shortage, and showing it as one would be both wrong and quietly alarming.
 * `stale` means the panel was assembled from a cache — a reading station
 * during an outage — and everything in it is true as of the moment the cache
 * was filled, not now.
 *
 * The clinical difference is the point of keeping them apart. An allergy panel
 * that failed to load is a reason to go and look somewhere else before
 * prescribing. One the patient has locked is a reason to have a conversation,
 * or to break glass if the situation warrants it — and the refusal names the
 * way through rather than leaving a clinician to guess why a panel is bare.
 * A stale panel is a reason to ask the patient again: a cached "no known drug
 * allergies" from before this morning's reaction is worse than no chart at
 * all, because a clinician reads it as current and stops asking — which is
 * why staleness is a first-class reason here and never a footnote.
 */
export type Incompleteness =
  | { reason: "unavailable"; detail: string }
  | { reason: "truncated"; shown: number; total: number }
  | { reason: "withheld"; detail: string }
  | { reason: "stale"; asOf: string; ageHours: number };

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
  immunizationStatus: ImmunizationHistory | "unavailable";
  vitalStatus: VitalHistory | "unavailable";
  procedureStatus: ProcedureHistory | "unavailable";
  carePlanStatus: CarePlanHistory | "unavailable";
  documentStatus: DocumentHistory | "unavailable";

  allergies: Section<AllergyRow>;
  medications: Section<MedRow>;
  immunizations: Section<ImmunizationView>;
  vitals: Section<VitalView>;
  procedures: Section<ProcedureView>;
  carePlans: Section<CarePlanView>;
  documents: Section<PatientDocumentView>;
  careTeam: Section<CareTeamRow>;
  coverage: Section<CoverageRow>;
  /** Reported and not yet read by anybody, worst first. */
  unacknowledgedResults: Section<ResultRow>;
  openOrders: Section<OrderRow>;
  openReferrals: Section<ReferralRow>;
  openTasks: Section<TaskRow>;
  recentNotes: Section<{ entry: ClinicalEntry; note: NoteContent }>;
  problems: Section<ClinicalEntry>;
  openThreads: Section<ThreadRow>;

  /**
   * Present when this chart is linked to others and the sections above were
   * assembled across all of them. Every row remains attributed to the chart
   * it was written on; the link is reversible; and this block is the
   * disclosure that makes the combination honest rather than silent.
   */
  linked?: { members: string[]; note: string };

  /**
   * Present when the chart was assembled from a cache. The disclosure that
   * makes a cached chart survivable: the age is at the top of the summary,
   * on every panel, and in the omissions — a renderer that ignores all
   * three had to work at it.
   */
  stale?: { asOf: string; ageHours: number; note: string };

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
  /**
   * Other charts asserted to be the same person, when a link is in force.
   *
   * Passed in like the withheld set, and for the same reason: this module
   * assembles and owns no opinion about identity. When present, every section
   * loads across all members and the summary says on its face that it did —
   * a silently combined chart would be the exact hazard linking is built
   * against, with the direction reversed.
   */
  linkedMembers?: readonly string[];
  /**
   * When the stores being read are a cache rather than the primary — a
   * reading station during an outage — the moment the cache was filled.
   *
   * Passed in like the rest: this module assembles and owns no opinion about
   * where its stores came from; the caller that mounted a cache is the one
   * that knows. When present, staleness goes on the face of every panel and
   * the chart is never `complete`, because "complete as of 14 hours ago" and
   * "complete" are different sentences and a renderer must not be able to
   * confuse them. A value that does not parse as a timestamp throws: a cache
   * that cannot establish its own age must not serve at all, and quietly
   * serving it as fresh would be the worst of the available lies.
   */
  asOf?: string;
}

/** The stores a summary is assembled from. Any may be absent. */
export interface WorkspaceSources {
  record?: ClinicalRecord;
  notes?: ClinicalNotes;
  meds?: MedicationStore;
  orders?: OrderStore;
  referrals?: ReferralStore;
  tasks?: TaskStore;
  immunizations?: Immunizations;
  vitals?: Vitals;
  procedures?: Procedures;
  carePlans?: CarePlans;
  documents?: PatientDocuments;
  careTeam?: CareTeam;
  coverage?: Coverage;
  schedule?: Schedule;
  messaging?: PatientMessaging;
}

/**
 * Runs one section's query and reports what happened to it.
 *
 * The try/catch is deliberate and is the opposite of swallowing. A store that
 * throws must not take the whole chart down — a clinician with six of seven
 * panels is better served than one with an error page — but the panel it
 * leaves behind must say it failed rather than sit there looking like "none".
 */
export function section<T>(
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

export function describe(name: string, s: Section<unknown>): string | null {
  if (s.complete || !s.incomplete) return null;
  switch (s.incomplete.reason) {
    case "unavailable":
      return `${name}: could not be loaded (${s.incomplete.detail}) — this panel is empty because it failed, not because there is nothing`;
    case "withheld":
      return `${name}: ${s.incomplete.detail}`;
    case "truncated":
      return `${name}: showing ${s.incomplete.shown} of ${s.incomplete.total}`;
    case "stale":
      return `${name}: as of ${s.incomplete.ageHours} hours ago — anything recorded since the cache was filled is not here`;
  }
}

/**
 * The entry type each section of the chart is made of.
 *
 * What lets a directive narrowed to one type withhold one panel instead of the
 * whole chart. Listed rather than derived because the mapping is a clinical
 * judgement, not a naming convention: a patient who locks `ServiceRequest` has
 * locked both their orders and their referrals, and somebody should have to
 * decide that on purpose. Locking `DocumentReference` likewise withholds both
 * clinic notes and patient-supplied documents.
 */
export const SECTION_TYPES = {
  allergies: "AllergyIntolerance",
  medications: "MedicationStatement",
  immunizations: "Immunization",
  vitals: "Observation",
  procedures: "Procedure",
  carePlans: "CarePlan",
  documents: "DocumentReference",
  careTeam: "CareTeam",
  coverage: "Coverage",
  unacknowledgedResults: "Observation",
  openOrders: "ServiceRequest",
  openReferrals: "ServiceRequest",
  openTasks: "Task",
  recentNotes: "DocumentReference",
  problems: "Condition",
  openThreads: "Communication",
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
export const WORKLIST_TYPES: readonly string[] = [
  "Observation",
  "ServiceRequest",
  "Task",
  "MedicationStatement",
  "Appointment",
  "Communication",
  "CarePlan",
];

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
    const { record, notes, meds, orders, referrals, tasks, immunizations, vitals, procedures, carePlans, documents, careTeam, coverage, messaging } =
      this.sources;
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

    // The charts this summary draws from: the one asked for, plus any linked
    // members. Every loader runs per member and the results concatenate —
    // rows keep their own patient_id, so nothing here moves a fact between
    // charts; it only reads more of them.
    const ids = [patientId, ...(opts.linkedMembers ?? [])];
    const across = <T,>(f: (id: string) => T[]): (() => T[]) => () => ids.flatMap(f);

    const allergies = sect("allergies", meds ? across((id) => meds.allergies(id).filter((a) => a.kind !== "no-known-allergies")) : undefined, limit);
    const medications = sect("medications", meds ? across((id) => meds.current(id, { asPrescribed: true })) : undefined, limit);
    const unacknowledgedResults = sect(
      "unacknowledgedResults",
      orders ? () => orders.unacknowledged().filter((r) => ids.includes(r.patient_id)) : undefined,
      limit
    );
    const openOrders = sect(
      "openOrders",
      orders ? across((id) => orders.forPatient(id).filter((o) => o.status === "placed" || o.status === "in-progress")) : undefined,
      limit
    );
    const openReferrals = sect(
      "openReferrals",
      referrals ? () => referrals.open().filter((r) => ids.includes(r.patient_id)) : undefined,
      limit
    );
    const openTasks = sect("openTasks", tasks ? across((id) => tasks.forPatient(id)) : undefined, limit);
    const recentNotes = sect("recentNotes", notes ? across((id) => notes.forPatient(id)) : undefined, noteLimit);
    const problems = sect("problems", record ? across((id) => record.chart(id, { entryType: "Condition" })) : undefined, limit);
    const immunizationSection = sect("immunizations", immunizations ? across((id) => immunizations.forPatient(id)) : undefined, limit);
    const vitalSection = sect("vitals", vitals ? across((id) => vitals.forPatient(id)) : undefined, limit);
    const procedureSection = sect("procedures", procedures ? across((id) => procedures.forPatient(id)) : undefined, limit);
    const carePlanSection = sect("carePlans", carePlans ? across((id) => carePlans.forPatient(id)) : undefined, limit);
    const documentSection = sect("documents", documents ? across((id) => documents.forPatient(id)) : undefined, limit);
    const careTeamSection = sect("careTeam", careTeam ? across((id) => careTeam.forPatient(id, { includeRetired: true })) : undefined, limit);
    const coverageSection = sect("coverage", coverage ? across((id) => coverage.history(id)) : undefined, limit);
    const openThreads = sect("openThreads", messaging ? across((id) => messaging.forPatient(id)) : undefined, limit);

    // Allergy status is read from the store rather than inferred from the
    // section: an empty list and a never-asked patient are the distinction
    // section 5 exists for, and inferring it here would undo that.
    //
    // And it is withheld with the section rather than left at the top of the
    // chart. "never-asked" or "clear" is itself a fact about the patient's
    // allergy history, so surfacing it beside a panel the patient has locked
    // would leak the shape of what was locked — the one thing this is supposed
    // to prevent.
    // A status across linked members combines by the worst answer, because
    // the claim it makes is about the whole person. Two charts where one was
    // never asked about allergies is a person who was never fully asked:
    // reporting the documented half as the status would be the merged-chart
    // hazard arriving through the summary line instead of the panel.
    const worstOf = <T extends string>(rank: readonly T[], onError: T, per: (id: string) => T): T => {
      let worst = rank[rank.length - 1];
      for (const id of ids) {
        let v: T;
        try {
          v = per(id);
        } catch {
          v = onError;
        }
        if (rank.indexOf(v) < rank.indexOf(worst)) worst = v;
      }
      return worst;
    };

    let allergyStatus: AllergyStatus | "unavailable" = "unavailable";
    if (meds && !hidden.has(SECTION_TYPES.allergies)) {
      allergyStatus = worstOf<AllergyStatus | "unavailable">(
        ["never-asked", "unavailable", "documented", "none-documented"],
        "unavailable",
        (id) => meds.allergyStatus(id)
      );
    }

    let immunizationStatus: ImmunizationHistory | "unavailable" = "unavailable";
    if (immunizations && !hidden.has(SECTION_TYPES.immunizations)) {
      immunizationStatus = worstOf<ImmunizationHistory | "unavailable">(
        ["never-asked", "unavailable", "documented"],
        "unavailable",
        (id) => immunizations.historyStatus(id)
      );
    }

    let vitalStatus: VitalHistory | "unavailable" = "unavailable";
    if (vitals && !hidden.has(SECTION_TYPES.vitals)) {
      vitalStatus = worstOf<VitalHistory | "unavailable">(
        ["never-measured", "unavailable", "documented"],
        "unavailable",
        (id) => vitals.historyStatus(id)
      );
    }

    let procedureStatus: ProcedureHistory | "unavailable" = "unavailable";
    if (procedures && !hidden.has(SECTION_TYPES.procedures)) {
      procedureStatus = worstOf<ProcedureHistory | "unavailable">(
        ["never-recorded", "unavailable", "documented"],
        "unavailable",
        (id) => procedures.historyStatus(id)
      );
    }

    let carePlanStatus: CarePlanHistory | "unavailable" = "unavailable";
    if (carePlans && !hidden.has(SECTION_TYPES.carePlans)) {
      carePlanStatus = worstOf<CarePlanHistory | "unavailable">(
        ["never-planned", "unavailable", "documented"],
        "unavailable",
        (id) => carePlans.historyStatus(id)
      );
    }

    let documentStatus: DocumentHistory | "unavailable" = "unavailable";
    if (documents && !hidden.has(SECTION_TYPES.documents)) {
      documentStatus = worstOf<DocumentHistory | "unavailable">(
        ["never-received", "unavailable", "documented"],
        "unavailable",
        (id) => documents.historyStatus(id)
      );
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
      ["Immunizations", immunizationSection],
      ["Vitals", vitalSection],
      ["Procedures", procedureSection],
      ["Care plans", carePlanSection],
      ["Patient-supplied documents", documentSection],
      ["Care team", careTeamSection],
      ["Coverage", coverageSection],
      ["Unacknowledged results", unacknowledgedResults],
      ["Open orders", openOrders],
      ["Open referrals", openReferrals],
      ["Open tasks", openTasks],
      ["Recent notes", recentNotes],
      ["Problems", problems],
      ["Open messages", openThreads],
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
    if (immunizationStatus === "never-asked") {
      omissions.push("Immunizations: no immunization history has ever been recorded for this patient");
    } else if (immunizationStatus === "unavailable" && !hidden.has(SECTION_TYPES.immunizations)) {
      omissions.push("Immunizations: immunization history could not be determined");
    }
    if (vitalStatus === "never-measured") {
      omissions.push("Vitals: no vital signs have ever been recorded for this patient");
    } else if (vitalStatus === "unavailable" && !hidden.has(SECTION_TYPES.vitals)) {
      omissions.push("Vitals: vital-sign history could not be determined");
    }
    if (procedureStatus === "never-recorded") {
      omissions.push("Procedures: no procedure has ever been recorded for this patient");
    } else if (procedureStatus === "unavailable" && !hidden.has(SECTION_TYPES.procedures)) {
      omissions.push("Procedures: procedure history could not be determined");
    }
    if (carePlanStatus === "never-planned") {
      omissions.push("Care plans: no care plan has ever been recorded for this patient");
    } else if (carePlanStatus === "unavailable" && !hidden.has(SECTION_TYPES.carePlans)) {
      omissions.push("Care plans: care-plan history could not be determined");
    }
    if (documentStatus === "never-received") {
      omissions.push("Patient-supplied documents: no document the patient supplied has ever been recorded");
    } else if (documentStatus === "unavailable" && !hidden.has(SECTION_TYPES.documents)) {
      omissions.push("Patient-supplied documents: document history could not be determined");
    }
    if (careTeam && careTeamSection.complete && !hidden.has(SECTION_TYPES.careTeam)) {
      const currentPrimary = careTeamSection.items.find((r) => r.role === "primary" && !r.active_to);
      if (!currentPrimary) omissions.push("Care team: no current primary provider is assigned");
    }
    if (coverage && coverageSection.complete && !hidden.has(SECTION_TYPES.coverage) && !ids.some((id) => coverage.current(id))) {
      omissions.push("Coverage: no provincial coverage or eligibility has been recorded");
    }

    // A cached chart is honest only if its age is on the face of every
    // panel. Staleness stamps the sections that would otherwise read as
    // complete; a section already incomplete keeps its more specific reason
    // — a failure or a lockbox is still that, cached or not — and the
    // chart-level block plus the omissions line carry the age for all of
    // them. This runs after the per-section omissions so the list gains one
    // line about the whole chart rather than a copy per panel.
    let stale: { asOf: string; ageHours: number; note: string } | undefined;
    if (opts.asOf !== undefined) {
      const asOfMs = Date.parse(opts.asOf);
      if (Number.isNaN(asOfMs)) {
        throw new Error(`a cache that cannot establish its own age must not serve: asOf is not a timestamp (${opts.asOf})`);
      }
      const ageHours = Math.max(0, Math.round(((Date.now() - asOfMs) / 36e5) * 10) / 10);
      for (const [, s] of sections) {
        if (s.complete) {
          s.complete = false;
          s.incomplete = { reason: "stale", asOf: opts.asOf, ageHours };
        }
      }
      stale = {
        asOf: opts.asOf,
        ageHours,
        note: `assembled from a cache as of ${ageHours} hours ago; anything recorded since is not here`,
      };
      omissions.push(
        `Every panel: as of ${ageHours} hours ago — anything recorded since the cache was filled is not here`
      );
    }

    return {
      patientId,
      patient,
      generatedAt: new Date().toISOString(),
      ...(ids.length > 1
        ? {
            linked: {
              members: [...ids].sort(),
              note:
                `assembled across ${ids.length} linked charts; every row remains attributed to ` +
                "the chart it was written on, and the link is reversible",
            },
          }
        : {}),
      ...(stale ? { stale } : {}),
      allergyStatus,
      immunizationStatus,
      vitalStatus,
      procedureStatus,
      carePlanStatus,
      documentStatus,
      allergies,
      medications,
      immunizations: immunizationSection,
      vitals: vitalSection,
      procedures: procedureSection,
      carePlans: carePlanSection,
      documents: documentSection,
      careTeam: careTeamSection,
      coverage: coverageSection,
      unacknowledgedResults,
      openOrders,
      openReferrals,
      openTasks,
      recentNotes,
      problems,
      openThreads,
      // False when a section is withheld, as much as when one failed. The flag
      // means "this is not the whole chart", and a chart missing what the
      // patient locked is not the whole chart — a clinician needs to know that
      // before they act on it, even though nothing has gone wrong.
      complete:
        sections.every(([, s]) => s.complete) &&
        (allergyStatus !== "unavailable" || hidden.has(SECTION_TYPES.allergies)) &&
        (immunizationStatus !== "unavailable" || hidden.has(SECTION_TYPES.immunizations)) &&
        (vitalStatus !== "unavailable" || hidden.has(SECTION_TYPES.vitals)) &&
        (procedureStatus !== "unavailable" || hidden.has(SECTION_TYPES.procedures)) &&
        (carePlanStatus !== "unavailable" || hidden.has(SECTION_TYPES.carePlans)) &&
        (documentStatus !== "unavailable" || hidden.has(SECTION_TYPES.documents)),
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
    ordersNotWithLaboratory: Section<OrderRow>;
    cancelledOrdersStillWithLaboratory: Section<OrderRow>;
    tasks: Section<TaskRow>;
    today: Section<{ slot: SlotRow; booking: BookingRow }>;
    awaitingMessages: Section<ThreadRow>;
    unassignedMessages: Section<ThreadRow>;
    incompleteReconciliations: Section<{ id: string; patient_id: string; transition: string; started_at: string }>;
    overdueCarePlans: Section<CarePlanView>;
    complete: boolean;
    omissions: string[];
  } {
    const { orders, referrals, tasks, meds, schedule, messaging, carePlans } = this.sources;
    const limit = opts.limit ?? 50;
    const asOf = opts.asOf ?? new Date().toISOString();

    const unacknowledgedResults = section(
      orders ? () => orders.unacknowledged({ responsibleId: clinicianId }) : undefined,
      limit
    );
    // Referrals, reconciliations and overdue care plans are not owned per
    // clinician in the model, so these are the service's, not this person's.
    // Said plainly rather than filtered to nothing, which would be a quieter
    // kind of wrong.
    const stalledReferrals = section(referrals ? () => referrals.stalled(asOf) : undefined, limit);
    // "Awaiting result" is a claim about a laboratory, and until the
    // transmission work there was nothing behind it. An order placed at a site
    // with no outbound interface appeared here, went overdue, and read as a
    // slow laboratory — so the clinician chased a laboratory that had never
    // heard of it. Only orders somebody plausibly holds belong under this
    // heading: one they acknowledged, or one at a site that has declared its
    // requisitions travel on paper with the specimen.
    const withLaboratory = (o: OrderRow): boolean => {
      if (!orders) return true;
      const state = orders.transmissionState(o.id).state;
      return state === "acknowledged" || state === "no-route";
    };
    const ordersAwaitingResult = section(
      orders
        ? () => orders.awaitingResult(asOf).filter((o) => o.responsible_id === clinicianId && withLaboratory(o))
        : undefined,
      limit
    );
    // The rest, under their own heading, because they need a different action:
    // these are not late, they are not sent. Drawn from notWithFiller rather
    // than from awaitingResult so one appears as soon as it is placed instead
    // of only once it is already overdue — an order nobody sent does not
    // become worth knowing about on the day it was due.
    const ordersNotWithLaboratory = section(
      orders ? () => orders.notWithFiller().filter((o) => o.responsible_id === clinicianId) : undefined,
      limit
    );
    // The mirror, and the one that ends with a needle: cancelled here, still
    // held there, so the specimen is still due to be collected.
    const cancelledOrdersStillWithLaboratory = section(
      orders ? () => orders.cancelledButStillWithFiller().filter((o) => o.responsible_id === clinicianId) : undefined,
      limit
    );
    const taskSection = section(tasks ? () => tasks.inbox(clinicianId) : undefined, limit);
    const incompleteReconciliations = section(meds ? () => meds.incompleteReconciliations() : undefined, limit);
    const today = section(schedule ? () => schedule.today(clinicianId, asOf) : undefined, limit);
    const awaitingMessages = section(messaging ? () => messaging.inbox(clinicianId) : undefined, limit);
    const unassignedMessages = section(messaging ? () => messaging.unassigned() : undefined, limit);
    const overdueCarePlans = section(carePlans ? () => carePlans.overdue(asOf) : undefined, limit);

    const named: Array<[string, Section<unknown>]> = [
      ["Today's appointments", today],
      ["Messages awaiting a reply", awaitingMessages],
      ["Messages nobody owns", unassignedMessages],
      ["Unacknowledged results", unacknowledgedResults],
      ["Stalled referrals", stalledReferrals],
      ["Orders awaiting a result", ordersAwaitingResult],
      ["Orders no laboratory has", ordersNotWithLaboratory],
      ["Cancelled orders a laboratory still holds", cancelledOrdersStillWithLaboratory],
      ["Tasks", taskSection],
      ["Incomplete reconciliations", incompleteReconciliations],
      ["Care plans past their review date", overdueCarePlans],
    ];
    return {
      today,
      ordersNotWithLaboratory,
      cancelledOrdersStillWithLaboratory,
      awaitingMessages,
      unassignedMessages,
      unacknowledgedResults,
      stalledReferrals,
      ordersAwaitingResult,
      tasks: taskSection,
      incompleteReconciliations,
      overdueCarePlans,
      complete: named.every(([, s]) => s.complete),
      omissions: named.map(([n, s]) => describe(n, s)).filter((x): x is string => x !== null),
    };
  }
}
