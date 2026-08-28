/**
 * What happened during one visit.
 *
 * The encounter-scoped counterpart to the assembled chart, and it inherits the
 * chart's central position rather than restating it: **a summary is read as
 * complete**. A clinician writing a discharge summary, or picking up a patient
 * from a colleague, opens this precisely so they do not have to go looking —
 * and having looked, they proceed on the basis that what is here is what there
 * is. So a section that failed to load must say so, and must never render as
 * "nothing was ordered at this visit", which is a different and far more
 * dangerous sentence.
 *
 * The sections come from the stores that already own an `encounter_id`: orders
 * and their results, medication statements, and the clinical entries — notes,
 * problems, observations — that were filed against the visit. This module owns
 * no data and assembles what exists, exactly as `Workspace` does for the chart.
 *
 * One thing it deliberately does not do: infer membership. Only content that
 * names this encounter belongs to it. The alternative — a time window around
 * the visit — is what everybody has to do before encounters exist, and it is
 * wrong in the ordinary case where two clinicians see the same patient an hour
 * apart.
 */
import type { ClinicalRecord, ClinicalEntry } from "../clinical/record.ts";
import type { MedicationStore, MedRow } from "../meds/store.ts";
import type { OrderStore, OrderRow, ResultRow } from "../orders/store.ts";
import type { Encounters, EncounterRow, ParticipantRow } from "../clinical/encounters.ts";
import { Vitals, type VitalView } from "../clinical/vitals.ts";
import { Procedures, type ProcedureView } from "../clinical/procedures.ts";
import { type Section, section, describe } from "./summary.ts";

export interface VisitSources {
  encounters: Encounters;
  record?: ClinicalRecord;
  meds?: MedicationStore;
  orders?: OrderStore;
}

export interface VisitOptions {
  limit?: number;
  /**
   * Entry types this reader may not see, because the patient said so.
   *
   * Same contract as `SummaryOptions.withheldTypes`: passed in rather than
   * looked up, because this module assembles and owns no opinion about
   * consent. A withheld section is dropped and says a directive is why.
   */
  withheldTypes?: ReadonlySet<string>;
}

export interface VisitSummary {
  encounterId: string;
  /** Undefined when the encounter does not exist — itself worth showing,
   * rather than an empty visit that looks like one where nothing happened. */
  encounter: EncounterRow | undefined;
  generatedAt: string;

  participants: Section<ParticipantRow>;
  orders: Section<OrderRow>;
  results: Section<ResultRow>;
  medications: Section<MedRow>;
  notes: Section<ClinicalEntry>;
  /** Vital signs taken at this visit. Empty here is ordinary, not "never measured". */
  vitals: Section<VitalView>;
  /** Procedures recorded against this visit. Empty here is ordinary, not "never recorded". */
  procedures: Section<ProcedureView>;
  /** Problems and observations recorded against this visit. Procedures have their own section. */
  findings: Section<ClinicalEntry>;

  complete: boolean;
  omissions: string[];
}

/** Which entry type each section is made of, so a scope-narrowed directive
 * withholds one section rather than the whole visit. Same judgement as
 * `SECTION_TYPES` in the chart, and listed for the same reason. */
export const VISIT_SECTION_TYPES = {
  orders: "ServiceRequest",
  results: "Observation",
  medications: "MedicationStatement",
  notes: "DocumentReference",
  vitals: "Observation",
  procedures: "Procedure",
  findings: "Condition",
} as const;

/** Every entry type an assembled visit may return. */
export const VISIT_TYPES: readonly string[] = [...new Set(Object.values(VISIT_SECTION_TYPES))];

const WITHHELD_DETAIL = "withheld by a patient directive; break glass to see it if the situation warrants it";

function withheld<T>(): Section<T> {
  return { items: [], complete: false, incomplete: { reason: "withheld", detail: WITHHELD_DETAIL } };
}

export class VisitView {
  private sources: VisitSources;

  constructor(sources: VisitSources) {
    this.sources = sources;
  }

  summarise(encounterId: string, opts: VisitOptions = {}): VisitSummary {
    const limit = opts.limit ?? 100;
    const withheldTypes = opts.withheldTypes ?? new Set<string>();
    const { encounters, record, meds, orders } = this.sources;

    let encounter: EncounterRow | undefined;
    try {
      encounter = encounters.get(encounterId);
    } catch {
      encounter = undefined;
    }
    const patientId = encounter?.patient_id;

    // A section is never loaded when its type is withheld. Loading and then
    // dropping would put the content in this process's memory and one careless
    // log line away from the reader the patient excluded.
    const sect = <T>(key: keyof typeof VISIT_SECTION_TYPES, load: (() => T[]) | undefined, missing?: string): Section<T> =>
      withheldTypes.has(VISIT_SECTION_TYPES[key]) ? withheld<T>() : section(load, limit, missing);

    const participants = section(() => encounters.participants(encounterId), limit);

    const orderSection = sect<OrderRow>("orders", orders ? () => orders.forEncounter(encounterId) : undefined);

    // Results hang off the orders placed at this visit rather than off the
    // encounter directly, because a result has no encounter of its own — it
    // answers an order, and the order is what belongs to the visit. A result
    // that arrives next week still belongs to the visit that asked for it.
    // If the orders section came back short, so does this one, and it says
    // why: reporting the results of the orders that did load would understate
    // what came back, which is the shape of the mistake this whole module
    // exists to refuse.
    const results = sect<ResultRow>(
      "results",
      orders && orderSection.complete ? () => orderSection.items.flatMap((o) => orders.resultsFor(o.id)) : undefined,
      orders
        ? "the orders this visit placed could not all be loaded, so their results would be an undercount"
        : "not configured in this deployment"
    );

    const medications = sect<MedRow>("medications", meds ? () => meds.forEncounter(encounterId) : undefined);

    const notes = sect<ClinicalEntry>(
      "notes",
      record && patientId
        ? () => record.chart(patientId, { entryType: "DocumentReference", encounterId })
        : undefined,
      patientId ? "not configured in this deployment" : "the encounter could not be read, so its notes cannot be found"
    );

    // Taken at this visit only. "Never measured" belongs on the chart, not
    // here: a visit with no vitals is ordinary, and saying otherwise would
    // flag every telephone review as a gap.
    const vitals = sect<VitalView>(
      "vitals",
      record && patientId ? () => new Vitals(record).forPatient(patientId, { encounterId }) : undefined,
      patientId ? "not configured in this deployment" : "the encounter could not be read, so its vitals cannot be found"
    );

    const procedures = sect<ProcedureView>(
      "procedures",
      record && patientId ? () => new Procedures(record).forPatient(patientId, { encounterId }) : undefined,
      patientId ? "not configured in this deployment" : "the encounter could not be read, so its procedures cannot be found"
    );

    const findings = sect<ClinicalEntry>(
      "findings",
      record && patientId
        ? () =>
            record
              .chart(patientId, { encounterId })
              .filter((e) => e.entry_type === "Condition" || e.entry_type === "Observation")
        : undefined,
      patientId ? "not configured in this deployment" : "the encounter could not be read, so its findings cannot be found"
    );

    const sections: Array<[string, Section<unknown>]> = [
      ["participants", participants],
      ["orders", orderSection],
      ["results", results],
      ["medications", medications],
      ["notes", notes],
      ["vitals", vitals],
      ["procedures", procedures],
      ["findings", findings],
    ];
    const omissions = sections.map(([name, s]) => describe(name, s)).filter((d): d is string => d !== null);
    if (!encounter) omissions.push(`encounter: no encounter ${encounterId} in this tenant`);

    return {
      encounterId,
      encounter,
      generatedAt: new Date().toISOString(),
      participants,
      orders: orderSection,
      results,
      medications,
      notes,
      vitals,
      procedures,
      findings,
      complete: omissions.length === 0,
      omissions,
    };
  }
}
