/**
 * Local terminology store. Holds code system concepts, ValueSet memberships
 * and ConceptMap entries in SQLite, loaded from JSON packs at boot. The
 * shipped pack is a clearly labelled demo subset: SNOMED CT CA, LOINC,
 * pCLOCD, ICD-10-CA and CCI are licensed distributions that an operator
 * loads through the same pack format under their own licence.
 */
import type { Db } from "../db.ts";

export interface TerminologyPack {
  id: string;
  name?: string;
  concepts?: Array<{ system: string; code: string; display?: string }>;
  valueSets?: Array<{ id: string; include: Array<{ system: string; codes: string[] }> }>;
  conceptMaps?: Array<{
    id: string;
    entries: Array<{
      sourceSystem: string;
      sourceCode: string;
      targetSystem: string;
      targetCode: string;
      targetDisplay?: string;
      equivalence?: string;
    }>;
  }>;
}

export interface Coding {
  system: string;
  code: string;
  display?: string;
}

export class TerminologyStore {
  private db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  loadPack(pack: TerminologyPack): { concepts: number; valueSetMembers: number; mapEntries: number } {
    let concepts = 0;
    let members = 0;
    let entries = 0;
    const insC = this.db.sql.prepare(
      `INSERT INTO term_concepts (system, code, display) VALUES (?, ?, ?)
       ON CONFLICT(system, code) DO UPDATE SET display = excluded.display`
    );
    for (const c of pack.concepts ?? []) {
      insC.run(c.system, c.code, c.display ?? null);
      concepts++;
    }
    const insV = this.db.sql.prepare(
      "INSERT OR IGNORE INTO term_valueset_members (valueset, system, code) VALUES (?, ?, ?)"
    );
    for (const vs of pack.valueSets ?? []) {
      for (const inc of vs.include) {
        for (const code of inc.codes) {
          insV.run(vs.id, inc.system, code);
          members++;
        }
      }
    }
    const insM = this.db.sql.prepare(
      `INSERT OR IGNORE INTO term_map_entries
         (map_id, source_system, source_code, target_system, target_code, target_display, equivalence)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    for (const cm of pack.conceptMaps ?? []) {
      for (const e of cm.entries) {
        insM.run(cm.id, e.sourceSystem, e.sourceCode, e.targetSystem, e.targetCode, e.targetDisplay ?? null, e.equivalence ?? "equivalent");
        entries++;
      }
    }
    return { concepts, valueSetMembers: members, mapEntries: entries };
  }

  lookup(system: string, code: string): Coding | undefined {
    const row = this.db.sql
      .prepare("SELECT system, code, display FROM term_concepts WHERE system = ? AND code = ?")
      .get(system, code) as Coding | undefined;
    return row ?? undefined;
  }

  expand(valueset: string): { id: string; total: number; codes: Coding[] } {
    const rows = this.db.sql
      .prepare(
        `SELECT m.system, m.code, c.display FROM term_valueset_members m
         LEFT JOIN term_concepts c ON c.system = m.system AND c.code = m.code
         WHERE m.valueset = ? ORDER BY m.system, m.code`
      )
      .all(valueset) as Array<{ system: string; code: string; display: string | null }>;
    return {
      id: valueset,
      total: rows.length,
      codes: rows.map((r) => ({ system: r.system, code: r.code, display: r.display ?? undefined })),
    };
  }

  /** Codes in a ValueSet as a flat set, for conformance membership checks. */
  memberCodes(valueset: string): Set<string> {
    return new Set(this.expand(valueset).codes.map((c) => c.code));
  }

  translate(params: { code: string; system?: string; map?: string; targetSystem?: string }): Array<Coding & { equivalence: string; map: string }> {
    const clauses = ["source_code = ?"];
    const args: unknown[] = [params.code];
    if (params.system) {
      clauses.push("source_system = ?");
      args.push(params.system);
    }
    if (params.map) {
      clauses.push("map_id = ?");
      args.push(params.map);
    }
    if (params.targetSystem) {
      clauses.push("target_system = ?");
      args.push(params.targetSystem);
    }
    const rows = this.db.sql
      .prepare(
        `SELECT map_id, target_system, target_code, target_display, equivalence
         FROM term_map_entries WHERE ${clauses.join(" AND ")} ORDER BY map_id LIMIT 20`
      )
      .all(...(args as never[])) as Array<{
      map_id: string;
      target_system: string;
      target_code: string;
      target_display: string | null;
      equivalence: string;
    }>;
    return rows.map((r) => ({
      system: r.target_system,
      code: r.target_code,
      display: r.target_display ?? undefined,
      equivalence: r.equivalence,
      map: r.map_id,
    }));
  }

  stats(): { concepts: number; valueSets: number; maps: number } {
    const n = (q: string) => (this.db.sql.prepare(q).get() as { n: number }).n;
    return {
      concepts: n("SELECT COUNT(*) AS n FROM term_concepts"),
      valueSets: n("SELECT COUNT(DISTINCT valueset) AS n FROM term_valueset_members"),
      maps: n("SELECT COUNT(DISTINCT map_id) AS n FROM term_map_entries"),
    };
  }
}
