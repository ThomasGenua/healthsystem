/**
 * A series of the same measurement over time, and the timeline that merges
 * every domain into one ordered read.
 *
 * ## Comparable is a claim this file will not make lightly
 *
 * `src/clinical/measurement.ts` already validates conversion for the small,
 * fixed set of quantities the clinical scores measure — temperature, heart
 * rate, respiratory rate, blood pressure, oxygen saturation — because each of
 * those has a real, checked scale behind it. A vital-sign series reuses that
 * contract directly: two readings in different units convert if the contract
 * says they can, and refuse with the contract's own reason if they cannot.
 *
 * A laboratory result series has no such contract. `2823-3` (potassium) has
 * no molar-mass entry in measurement.ts, and inventing one here — deciding
 * that µmol/L and mg/dL of some analyte are the same falls under a formula
 * this file made up — is exactly the silent rescaling measurement.ts exists
 * to stop, moved one file over. So a result series calls two points
 * comparable only when their units are the identical string. Two truly
 * equivalent spellings of one unit will read as "not comparable" here until
 * that equivalence is taught to measurement.ts's own registry, which is a
 * narrower and more honest gap than guessing.
 *
 * ## Corrections are kept, not folded away
 *
 * A superseded result is still a point on the series, with its own
 * `supersedes` pointer intact — a chart reviewed after a correction should
 * be able to show what the value used to say next to what it says now,
 * which a series that silently dropped the old value could not do.
 */
import type { OrderStore, ResultRow } from "../orders/store.ts";
import type { Vitals, VitalView, VitalKind } from "./vitals.ts";
import { canonicalise, type Measurement } from "./measurement.ts";

/** The handful of vital kinds measurement.ts also validates a scale for. */
const VITAL_MEASUREMENT_FIELD: Partial<Record<VitalKind, string>> = {
  "heart-rate": "heartRate",
  temperature: "temperature",
  "respiratory-rate": "respiratoryRate",
  "oxygen-saturation": "oxygenSaturation",
};

export type TrendSource = "result" | "vital";

export interface TrendPoint {
  recordId: string;
  source: TrendSource;
  value: number | null;
  unit: string | null;
  referenceRange: string | null;
  collectedAt: string | null;
  reportedAt: string;
  reportedBy: string;
  status: string;
  supersedes: string | null;
  encounterId: string | null;
}

export interface IncomparablePair {
  a: string;
  b: string;
  reason: string;
}

export interface TrendSeries {
  points: TrendPoint[];
  /** False the moment any two points cannot be placed on one scale together. */
  comparableThroughout: boolean;
  incomparablePairs: IncomparablePair[];
}

function assembleComparability(
  points: TrendPoint[],
  convert?: (from: TrendPoint, to: TrendPoint) => { ok: true } | { ok: false; reason: string }
): { comparableThroughout: boolean; incomparablePairs: IncomparablePair[] } {
  const withValue = points.filter((p) => p.value !== null && p.unit !== null);
  const pairs: IncomparablePair[] = [];
  for (let i = 1; i < withValue.length; i++) {
    const a = withValue[i - 1];
    const b = withValue[i];
    if (a.unit === b.unit) continue;
    const verdict = convert ? convert(a, b) : { ok: false as const, reason: "different units, no validated conversion for this measurement" };
    if (!verdict.ok) pairs.push({ a: a.recordId, b: b.recordId, reason: verdict.reason });
  }
  return { comparableThroughout: pairs.length === 0, incomparablePairs: pairs };
}

export class Trends {
  private orders: OrderStore;
  private vitals: Vitals;

  constructor(deps: { orders: OrderStore; vitals: Vitals }) {
    this.orders = deps.orders;
    this.vitals = deps.vitals;
  }

  /**
   * A laboratory or unsolicited result series for one patient and one code.
   * Units are compared as exact strings only — see the module docstring for
   * why this file will not guess an equivalence measurement.ts has not
   * already validated.
   */
  resultSeries(patientId: string, code: string): TrendSeries {
    const rows: ResultRow[] = this.orders.resultSeries(patientId, code);
    const points: TrendPoint[] = rows.map((r) => ({
      recordId: r.id,
      source: "result",
      value: numericValue(r.value),
      unit: r.unit,
      referenceRange: r.reference_range,
      collectedAt: r.observed_at,
      reportedAt: r.reported_at,
      reportedBy: r.reported_by,
      status: r.result_status,
      supersedes: r.supersedes,
      encounterId: null,
    }));
    return { points, ...assembleComparability(points) };
  }

  /**
   * A vital-sign series. Where the kind matches a quantity measurement.ts
   * already validates a scale for, a genuine unit conversion is attempted
   * through that same contract rather than assumed.
   */
  vitalSeries(patientId: string, kind: VitalKind): TrendSeries {
    const rows: VitalView[] = this.vitals.forPatient(patientId).filter((v) => v.kind === kind);
    const points: TrendPoint[] = rows.map((v) => ({
      recordId: v.recordId,
      source: "vital",
      value: v.value,
      unit: v.unit,
      referenceRange: null,
      collectedAt: v.takenAt,
      reportedAt: v.recordedAt,
      reportedBy: v.authorId,
      status: "recorded",
      supersedes: null,
      encounterId: v.encounterId,
    }));

    const field = VITAL_MEASUREMENT_FIELD[kind];
    const convert = field
      ? (from: TrendPoint, to: TrendPoint): { ok: true } | { ok: false; reason: string } => {
          if (from.unit === null || to.unit === null) return { ok: false, reason: "a point with no unit cannot be placed on a scale" };
          try {
            canonicalise(field, { value: from.value ?? 0, unit: from.unit } as Measurement);
            canonicalise(field, { value: to.value ?? 0, unit: to.unit } as Measurement);
            return { ok: true };
          } catch (err) {
            return { ok: false, reason: err instanceof Error ? err.message : String(err) };
          }
        }
      : undefined;

    return { points, ...assembleComparability(points, convert) };
  }

  /**
   * Whether the most recent point is older than a clinically-decided
   * interval. The interval is never defaulted — how often a given
   * measurement should recur is a clinical or programme decision, not a
   * number this file may pick on a deployment's behalf.
   */
  staleness(series: TrendSeries, expectedIntervalDays: number, asOf = new Date()): { stale: boolean; daysSinceLast: number | null } {
    if (expectedIntervalDays <= 0) throw new Error("an expected interval has to be a positive number of days");
    const withDates = series.points.filter((p) => p.collectedAt).map((p) => Date.parse(p.collectedAt!));
    if (withDates.length === 0) return { stale: false, daysSinceLast: null };
    const last = Math.max(...withDates);
    const days = (asOf.getTime() - last) / 86_400_000;
    return { stale: days > expectedIntervalDays, daysSinceLast: Math.round(days * 10) / 10 };
  }
}

function numericValue(v: string): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
