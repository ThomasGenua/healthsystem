/**
 * Clinical eligibility rules, published and never edited.
 *
 * `Registry.cohort()` and `Registry.gaps()` take a `CohortRule` and a
 * `CareGapRule` as plain objects — correct for a caller that already knows
 * which rule it means, and silent about which version of a rule a list was
 * actually built from. Item 64 asks for the rule itself to be "separately
 * governed and versioned": an outreach campaign should be able to say
 * "diabetes-a1c-overdue, version 3" and have that mean the same thing a
 * year from now, whatever a clinician has since changed rule 3 into.
 *
 * So this is the same shape `Questionnaires.publish()` already is in
 * src/patient/intake.ts: `publish()` only ever inserts, a change is a new
 * version next to the old one, and `get(id, version)` finds exactly what
 * was published, forever.
 */
import type { Db } from "../db.ts";
import { refuse } from "../core/refusal.ts";
import type { CohortRule, CareGapRule } from "./registry.ts";

export interface Actor {
  actorId: string;
  actorKind: string;
}

export interface EligibilityRuleRow {
  tenant_id: string;
  id: string;
  version: number;
  name: string;
  cohort: string;
  gap: string;
  status: "active" | "retired";
  published_by: string;
  published_at: string;
}

export interface EligibilityRuleView {
  id: string;
  version: number;
  name: string;
  cohort: CohortRule;
  gap: CareGapRule;
  status: "active" | "retired";
  publishedBy: string;
  publishedAt: string;
}

function parse(row: EligibilityRuleRow): EligibilityRuleView {
  return {
    id: row.id,
    version: row.version,
    name: row.name,
    cohort: JSON.parse(row.cohort) as CohortRule,
    gap: JSON.parse(row.gap) as CareGapRule,
    status: row.status,
    publishedBy: row.published_by,
    publishedAt: row.published_at,
  };
}

export class EligibilityRules {
  private db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  publish(input: { id: string; name: string; cohort: CohortRule; gap: CareGapRule; by: Actor }): EligibilityRuleView {
    if (!input.id.trim()) refuse("an eligibility rule needs an id");
    if (!input.name.trim()) refuse("an eligibility rule needs a name");
    if (!input.gap.withinDays || input.gap.withinDays <= 0) {
      refuse("an eligibility rule's care-gap window has to be a positive number of days");
    }

    return this.db.transaction(() => {
      const latest = this.db.sql
        .prepare("SELECT MAX(version) AS v FROM eligibility_rules WHERE tenant_id = ? AND id = ?")
        .get(this.db.tenantId, input.id) as { v: number | null };
      const version = (latest?.v ?? 0) + 1;
      const now = new Date().toISOString();
      if (version > 1) {
        this.db.sql
          .prepare("UPDATE eligibility_rules SET status = 'retired' WHERE tenant_id = ? AND id = ? AND status = 'active'")
          .run(this.db.tenantId, input.id);
      }
      this.db.sql
        .prepare(
          `INSERT INTO eligibility_rules (tenant_id, id, version, name, cohort, gap, status, published_by, published_at)
           VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`
        )
        .run(
          this.db.tenantId,
          input.id,
          version,
          input.name.trim(),
          JSON.stringify(input.cohort),
          JSON.stringify(input.gap),
          input.by.actorId,
          now
        );
      return this.get(input.id, version)!;
    });
  }

  get(id: string, version?: number): EligibilityRuleView | undefined {
    const row =
      version !== undefined
        ? (this.db.sql
            .prepare("SELECT * FROM eligibility_rules WHERE tenant_id = ? AND id = ? AND version = ?")
            .get(this.db.tenantId, id, version) as unknown as EligibilityRuleRow | undefined)
        : (this.db.sql
            .prepare(
              "SELECT * FROM eligibility_rules WHERE tenant_id = ? AND id = ? AND status = 'active' ORDER BY version DESC LIMIT 1"
            )
            .get(this.db.tenantId, id) as unknown as EligibilityRuleRow | undefined);
    return row ? parse(row) : undefined;
  }

  /** The active version of every published rule — what a new campaign may be built from. */
  list(): EligibilityRuleView[] {
    return (
      this.db.sql
        .prepare("SELECT * FROM eligibility_rules WHERE tenant_id = ? AND status = 'active' ORDER BY name")
        .all(this.db.tenantId) as unknown as EligibilityRuleRow[]
    ).map(parse);
  }
}
