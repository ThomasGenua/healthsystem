/**
 * Who is responsible for this patient.
 *
 * A chart that names `dr-tetso` as a string on a note is not a care team.
 * The directory says whether that person exists and works here; this says
 * they belong on this chart, in a role, for a stretch of time. A locum
 * covering March is not the most-responsible provider, and retiring the
 * MRP must not erase that they were the MRP — the row grows an end date.
 *
 * At most one *current* primary. Two people who both believe they are
 * most responsible is how a result goes to neither inbox.
 */
import { randomUUID } from "node:crypto";
import type { Db } from "../db.ts";
import { Directory } from "../directory/store.ts";
import { refuse } from "../core/refusal.ts";

export const CARE_TEAM_ROLES = ["primary", "covering", "consultant", "allied", "other"] as const;
export type CareTeamRole = (typeof CARE_TEAM_ROLES)[number];

export interface CareTeamRow {
  tenant_id: string;
  id: string;
  patient_id: string;
  practitioner_id: string;
  organization_id: string | null;
  role: CareTeamRole;
  active_from: string;
  active_to: string | null;
  asserted_by: string;
  asserted_at: string;
  created_at: string;
}

export class CareTeam {
  private db: Db;
  private directory: Directory;

  constructor(db: Db) {
    this.db = db;
    this.directory = new Directory(db);
  }

  assign(input: {
    patientId: string;
    practitionerId: string;
    role: CareTeamRole;
    by: { actorId: string };
    organizationId?: string;
    activeFrom?: string;
  }): CareTeamRow {
    if (!(CARE_TEAM_ROLES as readonly string[]).includes(input.role)) {
      refuse(`unknown care-team role ${input.role}; expected one of ${CARE_TEAM_ROLES.join(", ")}`);
    }
    this.directory.require("practitioner", input.practitionerId);
    if (input.organizationId) this.directory.require("organization", input.organizationId);

    return this.db.transaction(() => {
      if (input.role === "primary") {
        const current = this.primary(input.patientId);
        if (current) {
          refuse(
            `patient already has a primary provider (${current.practitioner_id}); retire them before assigning another`
          );
        }
      }
      const id = randomUUID();
      const now = new Date().toISOString();
      this.db.sql
        .prepare(
          `INSERT INTO care_team
             (tenant_id, id, patient_id, practitioner_id, organization_id, role,
              active_from, active_to, asserted_by, asserted_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`
        )
        .run(
          this.db.tenantId,
          id,
          input.patientId,
          input.practitionerId,
          input.organizationId ?? null,
          input.role,
          input.activeFrom ?? now,
          input.by.actorId,
          now,
          now
        );
      return this.get(id)!;
    });
  }

  /** Ends a membership without deleting it. The visits they attended stay theirs. */
  retire(id: string, at?: string): CareTeamRow {
    const row = this.get(id);
    if (!row) refuse(`no care-team membership ${id}`);
    if (row.active_to) refuse("that membership has already ended");
    this.db.sql
      .prepare("UPDATE care_team SET active_to = ? WHERE tenant_id = ? AND id = ?")
      .run(at ?? new Date().toISOString(), this.db.tenantId, id);
    return this.get(id)!;
  }

  get(id: string): CareTeamRow | undefined {
    return this.db.sql
      .prepare("SELECT * FROM care_team WHERE tenant_id = ? AND id = ?")
      .get(this.db.tenantId, id) as unknown as CareTeamRow | undefined;
  }

  forPatient(patientId: string, opts: { includeRetired?: boolean } = {}): CareTeamRow[] {
    return this.db.sql
      .prepare(
        `SELECT * FROM care_team
          WHERE tenant_id = ? AND patient_id = ?${opts.includeRetired ? "" : " AND active_to IS NULL"}
          ORDER BY role, active_from`
      )
      .all(this.db.tenantId, patientId) as unknown as CareTeamRow[];
  }

  primary(patientId: string): CareTeamRow | undefined {
    return this.forPatient(patientId).find((r) => r.role === "primary");
  }

  /** Patients this practitioner is currently responsible for. */
  forPractitioner(practitionerId: string): CareTeamRow[] {
    return this.db.sql
      .prepare(
        `SELECT * FROM care_team
          WHERE tenant_id = ? AND practitioner_id = ? AND active_to IS NULL
          ORDER BY role, patient_id`
      )
      .all(this.db.tenantId, practitionerId) as unknown as CareTeamRow[];
  }
}
