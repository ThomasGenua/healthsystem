/**
 * Provincial coverage and eligibility.
 *
 * A health-card number on the patient index finds the chart. Whether that
 * card is currently good is a different claim, and it changes: a card
 * expires, a plan is suspended, eligibility is pending a review. Filing
 * the new status by overwriting the old one loses "were they covered when
 * this visit happened", which is what a billing dispute and a coverage
 * audit both ask.
 *
 * So a change is a new row that supersedes the previous current one. The
 * old row stays. "Unknown" is a real eligibility, not a missing field —
 * a chart that cannot say whether the patient is covered must say it
 * cannot say, not invent "eligible".
 */
import { randomUUID } from "node:crypto";
import type { Db } from "../db.ts";
import { refuse } from "../core/refusal.ts";

export const COVERAGE_ELIGIBILITY = ["eligible", "ineligible", "pending", "unknown"] as const;
export type CoverageEligibility = (typeof COVERAGE_ELIGIBILITY)[number];

export interface CoverageRow {
  tenant_id: string;
  id: string;
  patient_id: string;
  plan: string;
  identifier_system: string | null;
  identifier_value: string | null;
  eligibility: CoverageEligibility;
  eligibility_detail: string | null;
  effective_from: string | null;
  effective_to: string | null;
  supersedes: string | null;
  asserted_by: string;
  asserted_at: string;
  created_at: string;
}

export class Coverage {
  private db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  record(input: {
    patientId: string;
    plan: string;
    eligibility: CoverageEligibility;
    by: { actorId: string };
    identifierSystem?: string;
    identifierValue?: string;
    detail?: string;
    effectiveFrom?: string;
    effectiveTo?: string;
  }): CoverageRow {
    if (!input.plan.trim()) refuse("coverage needs a plan (OHIP, NIHB, uninsured, …)");
    if (!(COVERAGE_ELIGIBILITY as readonly string[]).includes(input.eligibility)) {
      refuse(`unknown eligibility ${input.eligibility}; expected one of ${COVERAGE_ELIGIBILITY.join(", ")}`);
    }
    const prior = this.current(input.patientId);
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.sql
      .prepare(
        `INSERT INTO coverage
           (tenant_id, id, patient_id, plan, identifier_system, identifier_value,
            eligibility, eligibility_detail, effective_from, effective_to, supersedes,
            asserted_by, asserted_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        this.db.tenantId,
        id,
        input.patientId,
        input.plan,
        input.identifierSystem ?? null,
        input.identifierValue ?? null,
        input.eligibility,
        input.detail ?? null,
        input.effectiveFrom ?? now,
        input.effectiveTo ?? null,
        prior?.id ?? null,
        input.by.actorId,
        now,
        now
      );
    return this.get(id)!;
  }

  get(id: string): CoverageRow | undefined {
    return this.db.sql
      .prepare("SELECT * FROM coverage WHERE tenant_id = ? AND id = ?")
      .get(this.db.tenantId, id) as unknown as CoverageRow | undefined;
  }

  /** The current claim. A superseded row is history, not current. */
  current(patientId: string): CoverageRow | undefined {
    return this.db.sql
      .prepare(
        `SELECT * FROM coverage c
          WHERE c.tenant_id = ? AND c.patient_id = ?
            AND NOT EXISTS (
              SELECT 1 FROM coverage n
               WHERE n.tenant_id = c.tenant_id AND n.supersedes = c.id
            )
          ORDER BY c.created_at DESC LIMIT 1`
      )
      .get(this.db.tenantId, patientId) as unknown as CoverageRow | undefined;
  }

  history(patientId: string): CoverageRow[] {
    return this.db.sql
      .prepare("SELECT * FROM coverage WHERE tenant_id = ? AND patient_id = ? ORDER BY created_at")
      .all(this.db.tenantId, patientId) as unknown as CoverageRow[];
  }
}
