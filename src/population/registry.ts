/**
 * Registries, care gaps and quality measures.
 *
 * Section 12 asks who in a population needs something they have not had. The
 * arithmetic is easy. The part that is not easy, and that this module is built
 * around, is the denominator.
 *
 * A diabetes registry reports control by dividing patients whose last HbA1c
 * was under target by patients with a recent HbA1c. Patients with no recent
 * HbA1c fall out of both halves — and those are, precisely and not
 * coincidentally, the people nobody has managed. The measure therefore reads
 * best exactly where care is worst, and it does so silently: no error, no
 * warning, a clean-looking percentage on a dashboard that a health region
 * plans around.
 *
 * The same shape appears everywhere in quality measurement. Exclusions
 * accumulate, each individually defensible, until a measure describes a
 * carefully chosen subset and is reported as though it described a population.
 *
 * So every result here carries its denominator apart from its numerator, and
 * carries `unclassified` beside both: the patients the measure could not place
 * either way, with the reason. A measure that cannot say how many people it
 * could not assess is not a measure, it is a percentage.
 *
 * `MeasureResult.rate` is deliberately `null` when too much of the cohort is
 * unclassified. A number that is wrong is worse than no number, because a
 * number gets planned around.
 */
import type { Db } from "../db.ts";

/** How a patient enters a registry. */
export interface CohortRule {
  id: string;
  name: string;
  /** Chart entry types and codes that put a patient in the cohort. */
  conditionCodes?: string[];
  /** Medication ingredients that put a patient in the cohort. */
  medicationIngredients?: string[];
  /** Minimum age in years at `asOf`, inclusive. */
  minAgeYears?: number;
  maxAgeYears?: number;
}

/** Something a member of a cohort should have had, and how recently. */
export interface CareGapRule {
  id: string;
  name: string;
  /** Result codes that satisfy the requirement. */
  satisfiedByResultCodes?: string[];
  /** Medication ingredients that satisfy it, e.g. a statin for a diabetic. */
  satisfiedByMedications?: string[];
  /** How recently it must have happened. */
  withinDays: number;
}

export interface MeasureRule extends CareGapRule {
  /**
   * The value counted as controlled, for a measure rather than a bare gap.
   * Without it the measure is "did it happen", which is a gap.
   */
  target?: { code: string; below?: number; above?: number };
}

export interface CohortMember {
  patientId: string;
  /** Why they are in, so a clinician can disagree with the list. */
  because: string;
}

/**
 * A patient the rule could not place, and why.
 *
 * The important type in this file. These are not noise to be filtered — they
 * are the population the measure knows nothing about, and reporting a rate
 * without them is reporting a subset as a whole.
 */
export interface Unclassified {
  patientId: string;
  reason: "no-birth-date" | "no-qualifying-observation" | "value-not-numeric" | "no-recent-encounter";
}

export interface CareGap {
  patientId: string;
  ruleId: string;
  name: string;
  /** When it was last done, if ever. Null means never, which is different. */
  lastDone: string | null;
  overdueSinceDays: number | null;
}

export interface MeasureResult {
  ruleId: string;
  name: string;
  /** Everyone in the cohort. Not everyone assessed — that is the point. */
  denominator: number;
  numerator: number;
  /**
   * numerator/denominator, or null when too much of the cohort could not be
   * assessed. A number that is wrong is worse than no number.
   */
  rate: number | null;
  unclassified: Unclassified[];
  /** True only when every member of the cohort could be placed. */
  complete: boolean;
  /** Said in words, for a dashboard that must not print a bare percentage. */
  caveat: string | null;
}

/**
 * How much of a cohort may be unassessable before a rate is refused.
 *
 * Not zero, because some incompleteness is normal and a measure that always
 * refused would be ignored. Not high either: at a fifth unassessed, the
 * unassessed group can move the true rate by more than any intervention being
 * measured, so the number stops meaning anything.
 */
const MAX_UNCLASSIFIED_FRACTION = 0.2;

export class Registry {
  private db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /**
   * Who is in the cohort, and why.
   *
   * Membership carries its reason so a clinician can disagree with a specific
   * patient rather than with the registry. A list nobody can argue with in
   * detail is one they dismiss wholesale.
   */
  cohort(rule: CohortRule, asOf = new Date().toISOString()): { members: CohortMember[]; unclassified: Unclassified[] } {
    const members = new Map<string, string>();
    const unclassified: Unclassified[] = [];

    if (rule.conditionCodes?.length) {
      for (const row of this.byConditionCode(rule.conditionCodes)) {
        members.set(row.patient_id, `condition ${row.matched}`);
      }
    }
    if (rule.medicationIngredients?.length) {
      for (const row of this.byMedication(rule.medicationIngredients)) {
        if (!members.has(row.patient_id)) members.set(row.patient_id, `taking ${row.matched}`);
      }
    }

    if (rule.minAgeYears === undefined && rule.maxAgeYears === undefined) {
      return { members: [...members].map(([patientId, because]) => ({ patientId, because })), unclassified };
    }

    // An age criterion needs a birth date, and a patient without one cannot be
    // included or excluded honestly. Dropping them quietly is how a paediatric
    // measure comes to exclude every patient registered by a feed that does
    // not send a date of birth.
    const out: CohortMember[] = [];
    for (const [patientId, because] of members) {
      const age = this.ageYears(patientId, asOf);
      if (age === null) {
        unclassified.push({ patientId, reason: "no-birth-date" });
        continue;
      }
      if (rule.minAgeYears !== undefined && age < rule.minAgeYears) continue;
      if (rule.maxAgeYears !== undefined && age > rule.maxAgeYears) continue;
      out.push({ patientId, because: `${because}, aged ${age}` });
    }
    return { members: out, unclassified };
  }

  /**
   * Members of a cohort who are overdue something.
   *
   * "Never done" and "done, but too long ago" are both gaps and are reported
   * distinctly, because they call for different conversations — one is a
   * patient who has never been offered the test, the other is one who has been
   * and did not come back.
   */
  gaps(
    cohort: CohortRule,
    gap: CareGapRule,
    asOf = new Date().toISOString()
  ): { gaps: CareGap[]; unclassified: Unclassified[] } {
    const { members, unclassified } = this.cohort(cohort, asOf);
    const cutoff = new Date(new Date(asOf).getTime() - gap.withinDays * 86_400_000).toISOString();
    const out: CareGap[] = [];

    for (const m of members) {
      const last = this.lastSatisfying(m.patientId, gap);
      if (last && last >= cutoff) continue;
      out.push({
        patientId: m.patientId,
        ruleId: gap.id,
        name: gap.name,
        lastDone: last,
        overdueSinceDays: last ? Math.floor((new Date(asOf).getTime() - new Date(last).getTime()) / 86_400_000) : null,
      });
    }
    // Never-done first: a patient who has never been offered the test is a
    // different conversation from one who is late for their next.
    out.sort((a, b) => {
      if (a.overdueSinceDays === null && b.overdueSinceDays !== null) return -1;
      if (b.overdueSinceDays === null && a.overdueSinceDays !== null) return 1;
      return (b.overdueSinceDays ?? 0) - (a.overdueSinceDays ?? 0);
    });
    return { gaps: out, unclassified };
  }

  /**
   * A quality measure, with its denominator stated honestly.
   *
   * The denominator is the whole cohort, not the assessable part of it. A
   * patient with no recent HbA1c counts against the measure rather than
   * vanishing from it, because they are exactly the person the measure is
   * supposed to find — and a measure that improves when somebody stops being
   * tested is measuring the wrong thing.
   *
   * `rate` is null when too much of the cohort could not be assessed. Refusing
   * to produce a number is the honest output there, and the caveat says why in
   * words rather than leaving a dashboard to render a silent zero.
   */
  measure(cohort: CohortRule, rule: MeasureRule, asOf = new Date().toISOString()): MeasureResult {
    const { members, unclassified: cohortUnclassified } = this.cohort(cohort, asOf);
    const cutoff = new Date(new Date(asOf).getTime() - rule.withinDays * 86_400_000).toISOString();
    const unclassified: Unclassified[] = [...cohortUnclassified];
    let numerator = 0;

    for (const m of members) {
      const obs = rule.target ? this.lastValueOf(m.patientId, rule.target.code, cutoff) : null;

      if (rule.target) {
        if (obs === undefined) {
          // No qualifying observation in the window. Not a pass and not a
          // fail: the measure does not know, and saying so is the whole point.
          unclassified.push({ patientId: m.patientId, reason: "no-qualifying-observation" });
          continue;
        }
        const n = Number(obs);
        if (!Number.isFinite(n)) {
          unclassified.push({ patientId: m.patientId, reason: "value-not-numeric" });
          continue;
        }
        const below = rule.target.below === undefined || n < rule.target.below;
        const above = rule.target.above === undefined || n > rule.target.above;
        if (below && above) numerator++;
        continue;
      }

      // No target: the measure is "did it happen at all in the window".
      const last = this.lastSatisfying(m.patientId, rule);
      if (last && last >= cutoff) numerator++;
    }

    const denominator = members.length + cohortUnclassified.length;
    const unknown = unclassified.length;
    const tooMuchUnknown = denominator === 0 || unknown / denominator > MAX_UNCLASSIFIED_FRACTION;

    return {
      ruleId: rule.id,
      name: rule.name,
      denominator,
      numerator,
      rate: tooMuchUnknown ? null : numerator / denominator,
      unclassified,
      complete: unknown === 0,
      caveat: this.caveat(denominator, unknown, tooMuchUnknown),
    };
  }

  private caveat(denominator: number, unknown: number, refused: boolean): string | null {
    if (denominator === 0) return "no patients in the cohort; there is nothing to report";
    if (unknown === 0) return null;
    const pct = Math.round((unknown / denominator) * 100);
    const shared = `${unknown} of ${denominator} patients (${pct}%) could not be assessed`;
    return refused
      ? `${shared}, which is too many for a rate to mean anything — the unassessed are typically the least managed, so a rate computed over the rest would read better than the truth`
      : `${shared} and are counted in the denominator, not excluded from it`;
  }

  // ---- the queries -------------------------------------------------------

  private byConditionCode(codes: string[]): Array<{ patient_id: string; matched: string }> {
    // Matched against the chart's current entries, which excludes retracted
    // ones: a condition a clinician declared entered-in-error must not keep a
    // patient on a registry.
    const rows = this.db.sql
      .prepare(
        `SELECT e.patient_id, e.content FROM clinical_entries e
          WHERE e.tenant_id = ? AND e.entry_type = 'Condition' AND e.status = 'active'
            AND NOT EXISTS (
              SELECT 1 FROM clinical_entries n
               WHERE n.tenant_id = ? AND n.supersedes = e.version_id
            )`
      )
      .all(this.db.tenantId, this.db.tenantId) as Array<{ patient_id: string; content: string }>;

    const wanted = new Set(codes.map((c) => c.toLowerCase()));
    const out: Array<{ patient_id: string; matched: string }> = [];
    for (const r of rows) {
      const text = JSON.stringify(JSON.parse(r.content)).toLowerCase();
      for (const c of wanted) {
        if (text.includes(c)) {
          out.push({ patient_id: r.patient_id, matched: c });
          break;
        }
      }
    }
    return out;
  }

  private byMedication(ingredients: string[]): Array<{ patient_id: string; matched: string }> {
    const marks = ingredients.map(() => "?").join(", ");
    return this.db.sql
      .prepare(
        `SELECT DISTINCT m.patient_id, m.ingredient AS matched FROM medication_statements m
          WHERE m.tenant_id = ? AND m.status = 'active' AND m.adherence != 'not-taking'
            AND LOWER(m.ingredient) IN (${marks})
            AND NOT EXISTS (
              SELECT 1 FROM medication_statements n
               WHERE n.tenant_id = ? AND n.supersedes = m.id
            )`
      )
      .all(this.db.tenantId, ...ingredients.map((i) => i.toLowerCase()), this.db.tenantId) as Array<{
      patient_id: string;
      matched: string;
    }>;
  }

  /** When the requirement was last satisfied, by a result or a medication. */
  private lastSatisfying(patientId: string, rule: CareGapRule): string | null {
    let latest = null as string | null;

    if (rule.satisfiedByResultCodes?.length) {
      const marks = rule.satisfiedByResultCodes.map(() => "?").join(", ");
      const row = this.db.sql
        .prepare(
          `SELECT MAX(reported_at) AS at FROM order_results
            WHERE tenant_id = ? AND patient_id = ? AND code IN (${marks})
              AND result_status IN ('final', 'corrected')`
        )
        .get(this.db.tenantId, patientId, ...rule.satisfiedByResultCodes) as { at: string | null };
      if (row.at && (!latest || row.at > latest)) latest = row.at;
    }

    if (rule.satisfiedByMedications?.length) {
      const marks = rule.satisfiedByMedications.map(() => "?").join(", ");
      const row = this.db.sql
        .prepare(
          `SELECT MAX(asserted_at) AS at FROM medication_statements
            WHERE tenant_id = ? AND patient_id = ? AND status = 'active'
              AND adherence != 'not-taking' AND LOWER(ingredient) IN (${marks})`
        )
        .get(this.db.tenantId, patientId, ...rule.satisfiedByMedications.map((m) => m.toLowerCase())) as {
        at: string | null;
      };
      if (row.at && (!latest || row.at > latest)) latest = row.at;
    }
    return latest;
  }

  /** The most recent value of a code inside the window, or undefined. */
  private lastValueOf(patientId: string, code: string, cutoff: string): string | undefined {
    const row = this.db.sql
      .prepare(
        `SELECT r.value FROM order_results r
          WHERE r.tenant_id = ? AND r.patient_id = ? AND r.code = ? AND r.reported_at >= ?
            AND r.result_status IN ('final', 'corrected')
            AND NOT EXISTS (
              SELECT 1 FROM order_results n WHERE n.tenant_id = ? AND n.supersedes = r.id
            )
          ORDER BY r.reported_at DESC LIMIT 1`
      )
      .get(this.db.tenantId, patientId, code, cutoff, this.db.tenantId) as { value: string } | undefined;
    return row?.value;
  }

  private ageYears(patientId: string, asOf: string): number | null {
    const row = this.db.sql
      .prepare("SELECT birth_date FROM patient_index WHERE tenant_id = ? AND patient_id = ?")
      .get(this.db.tenantId, patientId) as { birth_date: string | null } | undefined;
    if (!row?.birth_date) return null;
    const born = new Date(row.birth_date);
    if (Number.isNaN(born.getTime())) return null;
    const now = new Date(asOf);
    let age = now.getUTCFullYear() - born.getUTCFullYear();
    const monthDiff = now.getUTCMonth() - born.getUTCMonth();
    if (monthDiff < 0 || (monthDiff === 0 && now.getUTCDate() < born.getUTCDate())) age--;
    return age;
  }
}
