/**
 * Finding a patient.
 *
 * A chart nobody can look up is not a chart, and looking one up is the point
 * at which a health record is most likely to go wrong: the wrong Marie
 * Beaulieu, the same person under two numbers, two people under one. So this
 * is deliberately small and deliberately explicit about what it does not do.
 *
 * The index is derived. Every column is recoverable from the Patient entries
 * in the clinical log, and `rebuild()` does exactly that — which is what keeps
 * the log the record and this a convenience. An index that could not be
 * rebuilt would become a second source of truth, and two sources of truth
 * about who a patient is do not stay in agreement.
 *
 * What this does not do is decide that two records are the same person.
 * Automatic merging is how a chart acquires someone else's allergies, and
 * unmerging afterwards is not a thing a clinical record can honestly offer.
 * Candidates are surfaced with the evidence; a human decides.
 */
import type { Db } from "../db.ts";
import type { ClinicalRecord } from "./record.ts";

export interface PatientSummary {
  patientId: string;
  family: string | null;
  given: string | null;
  birthDate: string | null;
  gender: string | null;
  preferredLanguage: string | null;
  phone: string | null;
  email: string | null;
  identifiers: Array<{ system: string; value: string }>;
  updatedAt: string;
}

export interface PatientSearch {
  /** Matches any identifier, as "system|value" or a bare value. */
  identifier?: string;
  family?: string;
  given?: string;
  birthDate?: string;
  limit?: number;
}

/** A pair worth a human's attention, and why. */
export interface DuplicateCandidate {
  patientIds: string[];
  reason: "shared-identifier" | "same-name-and-birth-date";
  evidence: string;
}

function readName(content: Record<string, unknown>): { family: string | null; given: string | null } {
  const names = Array.isArray(content.name) ? (content.name as Array<Record<string, unknown>>) : [];
  // An official name if one is marked, otherwise the first: a chart search
  // that ignored a preferred name would fail the person it is looking for.
  const chosen = names.find((n) => n.use === "official") ?? names[0];
  if (!chosen) return { family: null, given: null };
  const given = Array.isArray(chosen.given) ? (chosen.given as unknown[]).filter((g) => typeof g === "string") : [];
  return {
    family: typeof chosen.family === "string" ? chosen.family : null,
    given: given.length ? given.join(" ") : null,
  };
}

function readLanguage(content: Record<string, unknown>): string | null {
  const comm = Array.isArray(content.communication) ? (content.communication as Array<Record<string, unknown>>) : [];
  if (comm.length === 0) return null;
  const preferred = comm.find((c) => c.preferred === true) ?? comm[0];
  const lang = preferred.language && typeof preferred.language === "object" ? (preferred.language as Record<string, unknown>) : undefined;
  if (!lang) return null;
  if (typeof lang.text === "string" && lang.text) return lang.text;
  const coding = Array.isArray(lang.coding) ? (lang.coding[0] as Record<string, unknown> | undefined) : undefined;
  if (typeof coding?.display === "string" && coding.display) return coding.display;
  if (typeof coding?.code === "string" && coding.code) return coding.code;
  return null;
}

function readTelecom(content: Record<string, unknown>): { phone: string | null; email: string | null } {
  const raw = Array.isArray(content.telecom) ? (content.telecom as Array<Record<string, unknown>>) : [];
  let phone: string | null = null;
  let email: string | null = null;
  for (const t of raw) {
    if (typeof t.value !== "string" || !t.value) continue;
    if (t.system === "phone" && !phone) phone = t.value;
    if (t.system === "email" && !email) email = t.value;
  }
  return { phone, email };
}

function readIdentifiers(content: Record<string, unknown>): Array<{ system: string; value: string }> {
  const raw = Array.isArray(content.identifier) ? (content.identifier as Array<Record<string, unknown>>) : [];
  const out: Array<{ system: string; value: string }> = [];
  for (const i of raw) {
    if (typeof i.value === "string" && i.value) {
      out.push({ system: typeof i.system === "string" ? i.system : "", value: i.value });
    }
  }
  return out;
}

export class PatientIndex {
  private db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /**
   * Brings the index in line with a Patient entry.
   *
   * Identifiers are added, never removed. A number a patient was known by
   * remains a way to find them: a message arriving under last year's interim
   * number has to reach the same chart, and dropping it would strand records
   * that legitimately reference it.
   */
  index(patientId: string, content: Record<string, unknown>): void {
    const { family, given } = readName(content);
    const { phone, email } = readTelecom(content);
    this.db.sql
      .prepare(
        `INSERT INTO patient_index (tenant_id, patient_id, family, given, birth_date, gender, preferred_language, phone, email, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(tenant_id, patient_id) DO UPDATE SET
           family = excluded.family, given = excluded.given, birth_date = excluded.birth_date,
           gender = excluded.gender, preferred_language = excluded.preferred_language,
           phone = excluded.phone, email = excluded.email, updated_at = excluded.updated_at`
      )
      .run(
        this.db.tenantId,
        patientId,
        family,
        given,
        typeof content.birthDate === "string" ? content.birthDate : null,
        typeof content.gender === "string" ? content.gender : null,
        readLanguage(content),
        phone,
        email
      );

    const ins = this.db.sql.prepare(
      "INSERT OR IGNORE INTO patient_identifiers (tenant_id, patient_id, system, value) VALUES (?, ?, ?, ?)"
    );
    for (const id of readIdentifiers(content)) ins.run(this.db.tenantId, patientId, id.system, id.value);
    // The chart key itself is a way to find the chart.
    ins.run(this.db.tenantId, patientId, "", patientId);
  }

  get(patientId: string): PatientSummary | undefined {
    const row = this.db.sql
      .prepare("SELECT * FROM patient_index WHERE tenant_id = ? AND patient_id = ?")
      .get(this.db.tenantId, patientId) as
      | {
          patient_id: string;
          family: string | null;
          given: string | null;
          birth_date: string | null;
          gender: string | null;
          preferred_language: string | null;
          phone: string | null;
          email: string | null;
          updated_at: string;
        }
      | undefined;
    return row ? this.summary(row) : undefined;
  }

  /**
   * Searches the index.
   *
   * Every criterion given must match. A search that widened when given more
   * to go on would return more Marie Beaulieus the more the clinician knew
   * about which one they meant.
   */
  search(q: PatientSearch): PatientSummary[] {
    const clauses: string[] = [];
    const args: unknown[] = [this.db.tenantId];

    if (q.identifier) {
      const bar = q.identifier.indexOf("|");
      const system = bar >= 0 ? q.identifier.slice(0, bar) : null;
      const value = bar >= 0 ? q.identifier.slice(bar + 1) : q.identifier;
      clauses.push(
        system === null
          ? "AND p.patient_id IN (SELECT patient_id FROM patient_identifiers WHERE tenant_id = ? AND value = ?)"
          : "AND p.patient_id IN (SELECT patient_id FROM patient_identifiers WHERE tenant_id = ? AND value = ? AND system = ?)"
      );
      args.push(this.db.tenantId, value);
      if (system !== null) args.push(system);
    }
    // Case-insensitive on names, because a name typed in a hurry is not
    // capitalised the way it was filed.
    if (q.family) {
      clauses.push("AND p.family COLLATE NOCASE = ?");
      args.push(q.family);
    }
    if (q.given) {
      clauses.push("AND p.given COLLATE NOCASE LIKE ?");
      args.push(`%${q.given}%`);
    }
    if (q.birthDate) {
      clauses.push("AND p.birth_date = ?");
      args.push(q.birthDate);
    }

    const limit = Math.min(q.limit ?? 50, 200);
    const rows = this.db.sql
      .prepare(
        `SELECT p.* FROM patient_index p WHERE p.tenant_id = ? ${clauses.join(" ")}
          ORDER BY p.family, p.given LIMIT ${limit}`
      )
      .all(...(args as never[])) as Array<{
      patient_id: string;
      family: string | null;
      given: string | null;
      birth_date: string | null;
      gender: string | null;
      preferred_language: string | null;
      phone: string | null;
      email: string | null;
      updated_at: string;
    }>;
    return rows.map((r) => this.summary(r));
  }

  /**
   * Charts that may be the same person.
   *
   * Two shapes, and they mean different things. A shared identifier is close
   * to conclusive — one health number should not name two charts — while a
   * matching name and birth date is a prompt, not a finding: twins exist, and
   * so do fathers and sons with one name between them.
   *
   * Nothing is merged. Merging is how a chart acquires someone else's
   * allergies, and there is no honest way to unmerge afterwards.
   */
  duplicates(): DuplicateCandidate[] {
    const out: DuplicateCandidate[] = [];

    const shared = this.db.sql
      .prepare(
        `SELECT system, value, GROUP_CONCAT(patient_id) AS ids, COUNT(DISTINCT patient_id) AS n
           FROM patient_identifiers WHERE tenant_id = ?
          GROUP BY system, value HAVING n > 1`
      )
      .all(this.db.tenantId) as Array<{ system: string; value: string; ids: string; n: number }>;
    for (const r of shared) {
      out.push({
        patientIds: r.ids.split(","),
        reason: "shared-identifier",
        evidence: `${r.system || "(no system)"}|${r.value} names ${r.n} charts`,
      });
    }

    const sameName = this.db.sql
      .prepare(
        `SELECT family, given, birth_date, GROUP_CONCAT(patient_id) AS ids, COUNT(*) AS n
           FROM patient_index
          WHERE tenant_id = ? AND family IS NOT NULL AND birth_date IS NOT NULL
          GROUP BY family COLLATE NOCASE, given COLLATE NOCASE, birth_date HAVING n > 1`
      )
      .all(this.db.tenantId) as Array<{ family: string; given: string | null; birth_date: string; ids: string; n: number }>;
    for (const r of sameName) {
      out.push({
        patientIds: r.ids.split(","),
        reason: "same-name-and-birth-date",
        evidence: `${r.given ?? ""} ${r.family}, born ${r.birth_date}`.trim(),
      });
    }
    return out;
  }

  /**
   * Rebuilds the index from the clinical log.
   *
   * The property that keeps the log authoritative: if this can reproduce the
   * index, nothing here is a fact the log does not already hold. Worth being
   * able to run — after a restore, after a migration, or simply to prove the
   * two still agree.
   */
  rebuild(record: ClinicalRecord): number {
    this.db.sql.prepare("DELETE FROM patient_index WHERE tenant_id = ?").run(this.db.tenantId);
    this.db.sql.prepare("DELETE FROM patient_identifiers WHERE tenant_id = ?").run(this.db.tenantId);

    let n = 0;
    for (const { patientId } of record.patients()) {
      // The current version of each Patient record, which is what the index
      // describes. Retracted ones are excluded, exactly as the chart is.
      for (const entry of record.chart(patientId, { entryType: "Patient" })) {
        this.index(patientId, JSON.parse(entry.content) as Record<string, unknown>);
        n++;
      }
    }
    return n;
  }

  private summary(row: {
    patient_id: string;
    family: string | null;
    given: string | null;
    birth_date: string | null;
    gender: string | null;
    preferred_language?: string | null;
    phone?: string | null;
    email?: string | null;
    updated_at: string;
  }): PatientSummary {
    const identifiers = this.db.sql
      .prepare("SELECT system, value FROM patient_identifiers WHERE tenant_id = ? AND patient_id = ? ORDER BY system, value")
      .all(this.db.tenantId, row.patient_id) as Array<{ system: string; value: string }>;
    return {
      patientId: row.patient_id,
      family: row.family,
      given: row.given,
      birthDate: row.birth_date,
      gender: row.gender,
      preferredLanguage: row.preferred_language ?? null,
      phone: row.phone ?? null,
      email: row.email ?? null,
      identifiers,
      updatedAt: row.updated_at,
    };
  }
}
