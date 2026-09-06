/**
 * One ordered read across every domain, each entry pointing back to the
 * record it came from.
 *
 * `Workspace.chart()` already assembles every domain with a per-section
 * status — this does not replace that, and does not re-derive withheld or
 * never-recorded honesty, which stays exactly where it is. What this adds is
 * the one thing a set of sections cannot answer on its own: what happened
 * in what order. A result, a procedure, and a care-plan goal being approved
 * are three different stores; a patient's or a clinician's question — "what
 * has actually happened since March" — is one timeline, not three lists to
 * cross-reference by eye.
 *
 * Every entry carries `sourceRecordId` and `sourceKind`, which is the whole
 * point: a timeline that could not be traced back to the record behind it
 * would be a second, unaccountable copy of the chart.
 */
import type { OrderStore } from "../orders/store.ts";
import type { Vitals } from "./vitals.ts";
import type { Procedures } from "./procedures.ts";
import type { Immunizations } from "./immunizations.ts";
import type { Encounters } from "./encounters.ts";
import type { Goals, Actions } from "./goals.ts";

export type TimelineKind = "result" | "vital" | "procedure" | "immunization" | "encounter" | "goal" | "action";

export interface TimelineEntry {
  at: string;
  kind: TimelineKind;
  label: string;
  sourceRecordId: string;
  patientId: string;
  /** True when `at` is a fallback (when it was written down) rather than when it clinically happened. */
  approximateTime: boolean;
}

export interface TimelineSources {
  orders?: OrderStore;
  vitals?: Vitals;
  procedures?: Procedures;
  immunizations?: Immunizations;
  encounters?: Encounters;
  goals?: Goals;
  actions?: Actions;
}

export class Timeline {
  private sources: TimelineSources;

  constructor(sources: TimelineSources) {
    this.sources = sources;
  }

  /**
   * Every entry for one patient, oldest first. A source not wired in simply
   * contributes nothing — the same absent-not-broken shape `Workspace` uses
   * for a section it was not given a store for.
   */
  forPatient(patientId: string): TimelineEntry[] {
    const entries: TimelineEntry[] = [];
    const { orders, vitals, procedures, immunizations, encounters, goals, actions } = this.sources;

    if (orders) {
      for (const r of orders.currentResultsFor(patientId)) {
        entries.push({
          at: r.observed_at ?? r.reported_at,
          kind: "result",
          label: `${r.display}: ${r.value}${r.unit ? ` ${r.unit}` : ""}`,
          sourceRecordId: r.id,
          patientId,
          approximateTime: r.observed_at === null,
        });
      }
    }
    if (vitals) {
      for (const v of vitals.forPatient(patientId)) {
        entries.push({
          at: v.takenAt,
          kind: "vital",
          label: `${v.kind}${v.value !== null ? `: ${v.value}${v.unit ? ` ${v.unit}` : ""}` : ""}`,
          sourceRecordId: v.recordId,
          patientId,
          approximateTime: false,
        });
      }
    }
    if (procedures) {
      for (const p of procedures.forPatient(patientId)) {
        entries.push({
          at: p.performedAt ?? p.recordedAt,
          kind: "procedure",
          label: p.display,
          sourceRecordId: p.recordId,
          patientId,
          approximateTime: p.performedAt === null,
        });
      }
    }
    if (immunizations) {
      for (const i of immunizations.forPatient(patientId)) {
        entries.push({
          at: i.occurrenceAt,
          kind: "immunization",
          label: i.vaccine,
          sourceRecordId: i.recordId,
          patientId,
          approximateTime: false,
        });
      }
    }
    if (encounters) {
      for (const e of encounters.forPatient(patientId, { includeCancelled: false })) {
        entries.push({
          at: e.started_at ?? e.created_at,
          kind: "encounter",
          label: e.reason,
          sourceRecordId: e.id,
          patientId,
          approximateTime: e.started_at === null,
        });
      }
    }
    if (goals) {
      for (const g of goals.forPatient(patientId)) {
        if (g.status === "proposed") continue; // a suggestion is not yet an event in this patient's history
        entries.push({
          at: g.recordedAt,
          kind: "goal",
          label: `${g.description} (${g.status})`,
          sourceRecordId: g.recordId,
          patientId,
          approximateTime: false,
        });
      }
    }
    if (actions) {
      for (const a of actions.forPatient(patientId)) {
        if (a.status === "proposed") continue;
        entries.push({
          at: a.recordedAt,
          kind: "action",
          label: `${a.description} (${a.status})`,
          sourceRecordId: a.recordId,
          patientId,
          approximateTime: false,
        });
      }
    }

    return entries.sort((a, b) => a.at.localeCompare(b.at));
  }
}
