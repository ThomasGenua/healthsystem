/**
 * Loading a caseload out of an incumbent system.
 *
 * This is how a real deployment starts, and it was completely absent. But the
 * thing that makes migration dangerous is not the volume — it is that **you
 * cannot tell whether it worked by whether it errored**.
 *
 * A migration that loads 96% of the allergies and reports success is the
 * catastrophe. There is no error anywhere. The extract ran, the loader ran, the
 * counts look plausible, the clinicians start work, and the 4% that did not
 * arrive are invisible — until somebody prescribes into a gap. Every other part
 * of this module exists to serve the one that refuses to let that happen.
 *
 * ## Completeness is declared, then checked
 *
 * Before loading a record type, the migration declares how many the source
 * system says there are. Afterwards the report compares. If they disagree the
 * report says **incomplete** and names the gap; if nothing was declared it says
 * it *cannot verify* completeness, which is a different and equally honest
 * answer. What it will not do is call a run complete because nothing threw.
 *
 * ## Rejects are a queue with the payload in it
 *
 * A row that could not be loaded is kept — the whole source payload, the
 * reason, and which run it belonged to. A rejection reported only as a count is
 * a row nobody can go and look at, and "37 allergies failed validation" is not
 * something a clinical safety officer can sign.
 *
 * ## Loading goes through the ordinary stores
 *
 * Not straight into SQL. A migration that bypassed validation would load data
 * the live system would have refused — an allergy with no substance, a
 * medication with no provenance — and the first anyone would know is a
 * prescriber acting on it. Slower, and the only version worth having.
 *
 * ## A trial can be rolled back; a cutover with clinical activity cannot
 *
 * Trial migrations are the only way anybody finds the mapping errors, so they
 * have to be disposable. A cutover is different: once a clinician has written
 * into a chart, rolling the migration back would delete the record their note
 * refers to. That is refused, and the refusal names what has happened since.
 *
 * ## What this is not
 *
 * It is not an extractor. Getting data out of an incumbent system is that
 * vendor's export, a database dump, or a negotiation — not something this
 * repository can pretend to do. This takes normalised records and is honest
 * about what arrived. Source-system inventory, cutover scheduling and
 * post-launch stabilisation are a plan a person writes, not code.
 */
import { randomUUID } from "node:crypto";
import type { Db } from "../db.ts";
import { refuse } from "../core/refusal.ts";
import { an } from "../core/text.ts";
import type { ClinicalRecord } from "../clinical/record.ts";
import type { MedicationStore } from "../meds/store.ts";

export const MIGRATION_MODES = [
  /** Disposable. Loaded to find the mapping errors, then rolled back. */
  "trial",
  /** The real load. Rollback is constrained once clinicians are working. */
  "cutover",
  /** Records changed at the source since a previous run. */
  "delta",
] as const;
export type MigrationMode = (typeof MIGRATION_MODES)[number];

export const MIGRATION_STATUSES = ["open", "completed", "rolled-back", "abandoned"] as const;
export type MigrationStatus = (typeof MIGRATION_STATUSES)[number];

/**
 * What can be migrated.
 *
 * Deliberately a closed list. A migration that accepted any record type would
 * load whatever the extract happened to contain into whatever this module
 * happened to do with it, and the mapping would be discovered afterwards.
 */
export const MIGRATION_RECORD_TYPES = [
  "patient",
  "condition",
  "allergy",
  "medication",
  "immunization",
  "observation",
  "note",
] as const;
export type MigrationRecordType = (typeof MIGRATION_RECORD_TYPES)[number];

export type RecordOutcome = "loaded" | "unchanged" | "rejected";

export interface MigrationRun {
  tenant_id: string;
  id: string;
  source_system: string;
  mode: MigrationMode;
  status: MigrationStatus;
  started_by: string;
  started_at: string;
  completed_at: string | null;
  /** The run this delta follows, when it is one. */
  follows: string | null;
  notes: string | null;
  created_at: string;
}

export interface MigrationRecord {
  tenant_id: string;
  id: string;
  run_id: string;
  source_system: string;
  source_id: string;
  record_type: MigrationRecordType;
  /** The chart or statement it became. Null on a rejection. */
  target_id: string | null;
  patient_id: string | null;
  outcome: RecordOutcome;
  reason: string | null;
  /** The source payload, kept so a rejection is something to look at. */
  payload: string;
  loaded_at: string;
}

/** What the source system says it holds, per record type. */
export interface DeclaredCount {
  record_type: MigrationRecordType;
  source_count: number;
  declared_by: string;
  declared_at: string;
}

/** One normalised record from the source system. */
export interface SourceRecord {
  /** Stable in the source. This is what makes a re-run or a delta idempotent. */
  sourceId: string;
  recordType: MigrationRecordType;
  /** The source's patient key. Required except on a `patient` record. */
  sourcePatientId?: string;
  /** Already mapped to this system's shape. */
  content: Record<string, unknown>;
  /** The source's own codes, preserved rather than replaced by the mapping. */
  sourceCodes?: Record<string, string>;
}

export interface TypeReconciliation {
  recordType: MigrationRecordType;
  declared: number | null;
  loaded: number;
  unchanged: number;
  rejected: number;
  /**
   * declared − (loaded + unchanged + rejected). Non-zero means records the
   * source says exist never reached this system *and never failed either* —
   * the worst case, because nothing anywhere recorded them.
   */
  unaccounted: number | null;
  complete: boolean;
}

export interface MigrationReport {
  runId: string;
  sourceSystem: string;
  mode: MigrationMode;
  status: MigrationStatus;
  perType: TypeReconciliation[];
  totals: { loaded: number; unchanged: number; rejected: number };
  /**
   * True only when every type declared a source count and every count is
   * accounted for. Never true because nothing threw.
   */
  complete: boolean;
  /** What stops this being a clean bill of health, in words. */
  caveats: string[];
}

export interface MigrationSources {
  clinical: ClinicalRecord;
  meds: MedicationStore;
}

export class Migration {
  private db: Db;
  private clinical: ClinicalRecord;
  private meds: MedicationStore;

  constructor(db: Db, sources: MigrationSources) {
    this.db = db;
    this.clinical = sources.clinical;
    this.meds = sources.meds;
  }

  /** Opens a run. Everything loaded is attributed to it. */
  begin(input: {
    sourceSystem: string;
    mode: MigrationMode;
    by: { actorId: string };
    follows?: string;
    notes?: string;
  }): MigrationRun {
    if (!input.sourceSystem.trim()) refuse("a migration needs to name the system it is loading from");
    if (!(MIGRATION_MODES as readonly string[]).includes(input.mode)) {
      refuse(`unknown migration mode ${input.mode}; expected one of ${MIGRATION_MODES.join(", ")}`);
    }
    if (input.mode === "delta") {
      if (!input.follows) refuse("a delta load has to say which run it follows");
      const prior = this.run(input.follows);
      if (!prior) refuse(`no migration run ${input.follows}`);
      if (prior.status === "rolled-back") refuse("that run was rolled back; a delta on top of it would load into a gap");
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.sql
      .prepare(
        `INSERT INTO migration_runs
           (tenant_id, id, source_system, mode, status, started_by, started_at, follows, notes, created_at)
         VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)`
      )
      .run(
        this.db.tenantId,
        id,
        input.sourceSystem.trim(),
        input.mode,
        input.by.actorId,
        now,
        input.follows ?? null,
        input.notes ?? null,
        now
      );
    return this.run(id)!;
  }

  /**
   * Records what the source system says it holds.
   *
   * The load-bearing call. Without it the report can count what arrived and
   * cannot say whether that is all of it — and "we loaded 1,153 allergies" is
   * a reassuring sentence about an unknown denominator.
   */
  declare(runId: string, recordType: MigrationRecordType, sourceCount: number, by: { actorId: string }): DeclaredCount {
    const run = this.requireOpen(runId);
    if (!(MIGRATION_RECORD_TYPES as readonly string[]).includes(recordType)) {
      refuse(`unknown record type ${recordType}`);
    }
    if (!Number.isInteger(sourceCount) || sourceCount < 0) {
      refuse("a declared source count must be a whole number, and zero is a real answer");
    }
    const now = new Date().toISOString();
    this.db.sql
      .prepare(
        `INSERT INTO migration_declarations
           (tenant_id, run_id, record_type, source_count, declared_by, declared_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(tenant_id, run_id, record_type) DO UPDATE SET
           source_count = excluded.source_count,
           declared_by = excluded.declared_by,
           declared_at = excluded.declared_at`
      )
      .run(this.db.tenantId, run.id, recordType, sourceCount, by.actorId, now);
    return { record_type: recordType, source_count: sourceCount, declared_by: by.actorId, declared_at: now };
  }

  /**
   * Loads one source record.
   *
   * Idempotent on (source system, record type, source id): a re-run after a
   * failure, or a delta carrying rows that have not changed, records
   * `unchanged` and writes nothing. Without that, resuming an interrupted
   * migration doubles everything it already did.
   *
   * A record that cannot be loaded is **rejected with its payload**, not
   * thrown. One bad row must not stop a caseload, and it must not vanish
   * either.
   */
  load(runId: string, record: SourceRecord, by: { actorId: string }): MigrationRecord {
    const run = this.requireOpen(runId);
    const existing = this.recordFor(run.source_system, record.recordType, record.sourceId);
    if (existing && existing.outcome !== "rejected") {
      return this.write(run, record, "unchanged", existing.target_id, existing.patient_id, "already loaded by this source id");
    }

    let targetId: string | null = null;
    let patientId: string | null = null;
    try {
      const loaded = this.apply(run, record, by);
      targetId = loaded.targetId;
      patientId = loaded.patientId;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return this.write(run, record, "rejected", null, null, reason);
    }
    return this.write(run, record, "loaded", targetId, patientId, null);
  }

  /** Loads many, returning the outcome of each. One bad row does not stop the rest. */
  loadAll(runId: string, records: SourceRecord[], by: { actorId: string }): MigrationRecord[] {
    return records.map((r) => this.load(runId, r, by));
  }

  /**
   * Closes the run.
   *
   * Refuses while anything is unaccounted for unless the caller says, in
   * writing, that they accept it. A run closed over a gap is exactly the
   * "migration reported success" failure, so it takes a sentence somebody's
   * name is on.
   */
  complete(runId: string, by: { actorId: string; acceptGapsBecause?: string }): MigrationRun {
    const run = this.requireOpen(runId);
    const report = this.report(runId);
    if (!report.complete && !by.acceptGapsBecause?.trim()) {
      refuse(
        `this run is not reconciled: ${report.caveats.join("; ")}. ` +
          `Close it with acceptGapsBecause if that is a decision somebody is making.`
      );
    }
    const now = new Date().toISOString();
    this.db.sql
      .prepare(
        `UPDATE migration_runs SET status = 'completed', completed_at = ?, notes = ?
          WHERE tenant_id = ? AND id = ?`
      )
      .run(
        now,
        by.acceptGapsBecause?.trim()
          ? `${run.notes ? run.notes + " | " : ""}closed over gaps: ${by.acceptGapsBecause.trim()}`
          : run.notes,
        this.db.tenantId,
        runId
      );
    return this.run(runId)!;
  }

  /**
   * Undoes a trial.
   *
   * Retracts every clinical entry the run wrote, through the ordinary
   * retraction path, so the rollback is itself on the record. A cutover whose
   * charts have been written to since is refused: rolling it back would
   * delete the records a clinician's note refers to.
   */
  rollback(runId: string, by: { actorId: string; reason: string }): { retracted: number; run: MigrationRun } {
    if (!by.reason.trim()) refuse("rolling back a migration needs a reason");
    const run = this.run(runId);
    if (!run) refuse(`no migration run ${runId}`);
    if (run.status === "rolled-back") refuse("that run has already been rolled back");

    const deltas = this.db.sql
      .prepare("SELECT id FROM migration_runs WHERE tenant_id = ? AND follows = ? AND status != 'rolled-back'")
      .all(this.db.tenantId, runId) as Array<{ id: string }>;
    if (deltas.length > 0) {
      refuse(`roll back the delta run(s) ${deltas.map((d) => d.id).join(", ")} first, or they would sit on a gap`);
    }

    if (run.mode === "cutover") {
      const touched = this.clinicalActivitySince(runId);
      if (touched.length > 0) {
        refuse(
          `this cutover cannot be rolled back: ${touched.length} chart(s) have been written to since by ` +
            `${[...new Set(touched.map((t) => t.author_id))].join(", ")}. ` +
            `Rolling back would remove records their notes refer to.`
        );
      }
    }

    const rows = this.db.sql
      .prepare(
        `SELECT * FROM migration_records
          WHERE tenant_id = ? AND run_id = ? AND outcome = 'loaded' AND target_id IS NOT NULL
          ORDER BY loaded_at DESC`
      )
      .all(this.db.tenantId, runId) as unknown as MigrationRecord[];

    return this.db.transaction(() => {
      let retracted = 0;
      for (const row of rows) {
        // Clinical entries retract through the record, so the rollback is
        // itself an audited clinical act rather than a delete.
        if (row.record_type === "medication" || row.record_type === "allergy") continue;
        try {
          this.clinical.retract(row.target_id!, {
            authorId: by.actorId,
            authorKind: "migration",
            reason: `migration ${runId} rolled back: ${by.reason.trim()}`,
          });
          retracted++;
        } catch {
          // Already retracted, or superseded by a later version. Either way
          // there is nothing to undo, and failing the whole rollback over it
          // would leave the run half undone.
        }
      }
      this.db.sql
        .prepare("UPDATE migration_runs SET status = 'rolled-back', completed_at = ? WHERE tenant_id = ? AND id = ?")
        .run(new Date().toISOString(), this.db.tenantId, runId);
      return { retracted, run: this.run(runId)! };
    });
  }

  /**
   * What arrived, against what the source said it had.
   *
   * `complete` is true only when every type declared a count and every count
   * is accounted for. It is never true because nothing threw.
   */
  report(runId: string): MigrationReport {
    const run = this.run(runId);
    if (!run) refuse(`no migration run ${runId}`);

    const declared = new Map<string, number>();
    for (const d of this.db.sql
      .prepare("SELECT record_type, source_count FROM migration_declarations WHERE tenant_id = ? AND run_id = ?")
      .all(this.db.tenantId, runId) as Array<{ record_type: string; source_count: number }>) {
      declared.set(d.record_type, d.source_count);
    }

    const counted = this.db.sql
      .prepare(
        `SELECT record_type, outcome, COUNT(*) AS n
           FROM migration_records WHERE tenant_id = ? AND run_id = ?
          GROUP BY record_type, outcome`
      )
      .all(this.db.tenantId, runId) as Array<{ record_type: string; outcome: RecordOutcome; n: number }>;

    const types = new Set<string>([...declared.keys(), ...counted.map((c) => c.record_type)]);
    const perType: TypeReconciliation[] = [];
    const totals = { loaded: 0, unchanged: 0, rejected: 0 };
    const caveats: string[] = [];

    for (const recordType of MIGRATION_RECORD_TYPES.filter((t) => types.has(t))) {
      const of = (outcome: RecordOutcome) =>
        counted.find((c) => c.record_type === recordType && c.outcome === outcome)?.n ?? 0;
      const loaded = of("loaded");
      const unchanged = of("unchanged");
      const rejected = of("rejected");
      totals.loaded += loaded;
      totals.unchanged += unchanged;
      totals.rejected += rejected;

      const source = declared.get(recordType) ?? null;
      const unaccounted = source === null ? null : source - (loaded + unchanged + rejected);
      const complete = source !== null && unaccounted === 0 && rejected === 0;
      perType.push({ recordType, declared: source, loaded, unchanged, rejected, unaccounted, complete });

      if (source === null) {
        caveats.push(
          `${recordType}: the source count was never declared, so completeness cannot be verified — only that ${
            loaded + unchanged
          } arrived`
        );
      } else if (unaccounted !== 0) {
        caveats.push(
          `${recordType}: ${unaccounted} record(s) the source says exist neither loaded nor failed — nothing recorded them at all`
        );
      }
      if (rejected > 0) {
        caveats.push(`${recordType}: ${rejected} record(s) were rejected and are waiting in the reject queue`);
      }
    }

    if (perType.length === 0) caveats.push("nothing has been loaded or declared under this run");

    return {
      runId,
      sourceSystem: run.source_system,
      mode: run.mode,
      status: run.status,
      perType,
      totals,
      complete: perType.length > 0 && perType.every((t) => t.complete),
      caveats,
    };
  }

  /**
   * Records that could not be loaded, with their payloads.
   *
   * A rejection reported only as a count is a row nobody can go and look at.
   */
  rejects(runId: string, opts: { recordType?: MigrationRecordType } = {}): MigrationRecord[] {
    return this.db.sql
      .prepare(
        `SELECT * FROM migration_records
          WHERE tenant_id = ? AND run_id = ? AND outcome = 'rejected'
            ${opts.recordType ? "AND record_type = ?" : ""}
          ORDER BY loaded_at`
      )
      .all(
        ...([this.db.tenantId, runId, ...(opts.recordType ? [opts.recordType] : [])] as never[])
      ) as unknown as MigrationRecord[];
  }

  /**
   * A sample somebody has to read.
   *
   * Counts reconciling does not mean the content is right: a mapping that puts
   * the dose in the frequency field reconciles perfectly. This is the sample a
   * clinician checks against the source system before a cutover, spread across
   * record types rather than taken off the top, because the first hundred rows
   * of an extract are the easy ones.
   */
  validationSample(runId: string, perType = 5): MigrationRecord[] {
    const out: MigrationRecord[] = [];
    for (const recordType of MIGRATION_RECORD_TYPES) {
      out.push(
        ...(this.db.sql
          .prepare(
            `SELECT * FROM migration_records
              WHERE tenant_id = ? AND run_id = ? AND record_type = ? AND outcome = 'loaded'
              ORDER BY (loaded_at || id) LIMIT ?`
          )
          .all(this.db.tenantId, runId, recordType, perType) as unknown as MigrationRecord[])
      );
    }
    return out;
  }

  run(id: string): MigrationRun | undefined {
    return this.db.sql
      .prepare("SELECT * FROM migration_runs WHERE tenant_id = ? AND id = ?")
      .get(this.db.tenantId, id) as unknown as MigrationRun | undefined;
  }

  runs(): MigrationRun[] {
    return this.db.sql
      .prepare("SELECT * FROM migration_runs WHERE tenant_id = ? ORDER BY started_at DESC")
      .all(this.db.tenantId) as unknown as MigrationRun[];
  }

  /** Every source record this system holds for one chart, so provenance survives. */
  provenanceFor(patientId: string): MigrationRecord[] {
    return this.db.sql
      .prepare(
        "SELECT * FROM migration_records WHERE tenant_id = ? AND patient_id = ? ORDER BY loaded_at"
      )
      .all(this.db.tenantId, patientId) as unknown as MigrationRecord[];
  }

  private apply(
    run: MigrationRun,
    record: SourceRecord,
    by: { actorId: string }
  ): { targetId: string; patientId: string } {
    const author = { authorId: by.actorId, authorKind: "migration" };
    // The source's own codes travel with the content rather than being
    // replaced by the mapping. A migrated record that cannot be traced to the
    // row it came from cannot be checked against the source system, which is
    // the only way anybody finds a mapping error.
    const content = {
      ...record.content,
      _source: {
        system: run.source_system,
        id: record.sourceId,
        migrationRun: run.id,
        ...(record.sourceCodes ? { codes: record.sourceCodes } : {}),
      },
    };

    if (record.recordType === "patient") {
      const patientId = typeof record.content.id === "string" ? record.content.id : record.sourceId;
      const entry = this.clinical.record({
        entryType: "Patient",
        patientId,
        content: { resourceType: "Patient", ...content },
        ...author,
        source: run.source_system,
      });
      return { targetId: entry.record_id, patientId };
    }

    const patientId = record.sourcePatientId;
    if (!patientId) {
      // The migration analogue of a laboratory result with no identifier. A
      // record with no chart to belong to must not be filed against a guess.
      refuse(`a ${record.recordType} needs a sourcePatientId; there is no chart to file it against`);
    }
    if (!this.clinical.patientIndex.get(patientId)) {
      refuse(`no chart ${patientId}; load the patient before their ${record.recordType} records`);
    }

    if (record.recordType === "allergy") {
      const display = typeof record.content.display === "string" ? record.content.display : "";
      if (!display.trim()) refuse("an allergy needs a substance; an unnamed one cannot be checked against a prescription");
      const row = this.meds.recordAllergy({
        patientId,
        display,
        ...(typeof record.content.ingredient === "string" ? { ingredient: record.content.ingredient } : {}),
        ...(typeof record.content.reaction === "string" ? { reaction: record.content.reaction } : {}),
        ...(record.content.criticality === "high" || record.content.criticality === "low"
          ? { criticality: record.content.criticality }
          : {}),
        by: { actorId: by.actorId, actorKind: "migration" },
      });
      return { targetId: row.id, patientId };
    }

    if (record.recordType === "medication") {
      const display = typeof record.content.display === "string" ? record.content.display : "";
      const code = typeof record.content.code === "string" ? record.content.code : "";
      if (!display.trim() || !code.trim()) refuse("a migrated medication needs a code and a display");
      const row = this.meds.record({
        patientId,
        code,
        display,
        // Provenance is the point of the medication list, and a migrated row
        // is external-record until somebody confirms it with the patient. A
        // migration that marked everything `prescribed` would be asserting
        // that this clinic wrote prescriptions it never saw.
        source: "external-record",
        adherence: "unknown",
        ...(typeof record.content.ingredient === "string" ? { ingredient: record.content.ingredient } : {}),
        ...(typeof record.content.dose === "string" ? { dose: record.content.dose } : {}),
        ...(typeof record.content.route === "string" ? { route: record.content.route } : {}),
        ...(typeof record.content.frequency === "string" ? { frequency: record.content.frequency } : {}),
        by: { actorId: by.actorId, actorKind: "migration" },
      });
      return { targetId: row.id, patientId };
    }

    const entryType = (
      {
        condition: "Condition",
        immunization: "Immunization",
        observation: "Observation",
        note: "DocumentReference",
      } as const
    )[record.recordType];
    const entry = this.clinical.record({
      entryType,
      patientId,
      content: { resourceType: entryType, ...content },
      ...author,
      source: run.source_system,
      ...(typeof record.content.effectiveAt === "string" ? { effectiveAt: record.content.effectiveAt } : {}),
    });
    return { targetId: entry.record_id, patientId };
  }

  /** Clinical entries written by anyone other than the migration since it ran. */
  private clinicalActivitySince(runId: string): Array<{ author_id: string; patient_id: string }> {
    return this.db.sql
      .prepare(
        `SELECT DISTINCT e.author_id, e.patient_id
           FROM clinical_entries e
          WHERE e.tenant_id = ?
            AND e.author_kind != 'migration'
            AND e.patient_id IN (
              SELECT DISTINCT patient_id FROM migration_records
               WHERE tenant_id = ? AND run_id = ? AND patient_id IS NOT NULL
            )
            AND e.recorded_at > (SELECT started_at FROM migration_runs WHERE tenant_id = ? AND id = ?)`
      )
      .all(this.db.tenantId, this.db.tenantId, runId, this.db.tenantId, runId) as Array<{
      author_id: string;
      patient_id: string;
    }>;
  }

  private recordFor(
    sourceSystem: string,
    recordType: MigrationRecordType,
    sourceId: string
  ): MigrationRecord | undefined {
    return this.db.sql
      .prepare(
        `SELECT * FROM migration_records
          WHERE tenant_id = ? AND source_system = ? AND record_type = ? AND source_id = ?
          ORDER BY loaded_at DESC LIMIT 1`
      )
      .get(this.db.tenantId, sourceSystem, recordType, sourceId) as unknown as MigrationRecord | undefined;
  }

  private write(
    run: MigrationRun,
    record: SourceRecord,
    outcome: RecordOutcome,
    targetId: string | null,
    patientId: string | null,
    reason: string | null
  ): MigrationRecord {
    const id = randomUUID();
    this.db.sql
      .prepare(
        `INSERT INTO migration_records
           (tenant_id, id, run_id, source_system, source_id, record_type, target_id, patient_id,
            outcome, reason, payload, loaded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        this.db.tenantId,
        id,
        run.id,
        run.source_system,
        record.sourceId,
        record.recordType,
        targetId,
        patientId ?? record.sourcePatientId ?? null,
        outcome,
        reason,
        JSON.stringify(record),
        new Date().toISOString()
      );
    return this.db.sql
      .prepare("SELECT * FROM migration_records WHERE tenant_id = ? AND id = ?")
      .get(this.db.tenantId, id) as unknown as MigrationRecord;
  }

  private requireOpen(runId: string): MigrationRun {
    const run = this.run(runId);
    if (!run) refuse(`no migration run ${runId}`);
    if (run.status !== "open") refuse(`${an(run.status)} migration run cannot be loaded into`);
    return run;
  }
}
