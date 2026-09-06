/**
 * The longitudinal clinical record.
 *
 * Section 1's requirement is not a feature, it is a constraint on storage:
 * nothing clinically material may be silently overwritten, and a correction
 * must retain the original with its full history. A table you UPDATE cannot
 * satisfy that however carefully it is used — the guarantee has to be that
 * there is no way to overwrite, not that nobody does.
 *
 * So this store has no update path. Three verbs, all of them writes:
 *
 *   record()  states something new
 *   amend()   states a correction, as a new version pointing at the one it
 *             supersedes, with a reason
 *   retract() marks a record entered-in-error, again as a new version
 *
 * A retraction is not a delete. "This allergy was recorded against the wrong
 * patient" and "this allergy never existed" are different claims, and only the
 * first is true — the entry was really made, really acted on, and a review of
 * the decision that followed it needs to see what the chart said at the time.
 *
 * Every version is hash-chained into its patient's chart, so removing one
 * breaks the next one's back-pointer and removing the most recent ones
 * disagrees with the version counter. That is the same construction the
 * message lineage and the audit trail use, and it is here for the same reason:
 * an amendment history that can be quietly rewritten is not a history.
 *
 * One table for every kind of entry. Problems, allergies, vitals, notes and
 * encounters differ in their content, not in what has to be true about them —
 * an author, a time, a status, a supersession link, a place on the chain.
 * Fifteen tables would be fifteen chances to leave one of those out.
 */
import { createHash, randomUUID } from "node:crypto";
import type { Db } from "../db.ts";
import { PatientIndex } from "./patients.ts";
import { Encounters } from "./encounters.ts";

/**
 * What an entry is. FHIR R4 resource names where one fits, so the facade and
 * the interfaces speak the same vocabulary as the chart.
 */
export type EntryType =
  | "Patient"
  | "Encounter"
  | "Condition"
  | "AllergyIntolerance"
  | "MedicationStatement"
  | "Immunization"
  | "Observation"
  | "Procedure"
  | "DocumentReference"
  | "CarePlan"
  | "Consent"
  | "ServiceRequest"
  | "Task"
  // A patient's own answers, frozen at the moment they submitted them. See
  // src/patient/intake.ts.
  | "QuestionnaireResponse"
  // A care-plan goal, structured and versioned like anything else here. See
  // src/clinical/goals.ts. "Task" above is what an action serving one uses.
  | "Goal";

/**
 * What a version asserted when it was written. Not "amended" — that is a fact
 * about a later version existing, derived rather than stored, so nothing ever
 * has to go back and change a row that a clinician wrote.
 */
export type EntryStatus = "active" | "entered-in-error";

export interface ClinicalEntry {
  seq: number;
  tenant_id: string;
  version_id: string;
  record_id: string;
  version: number;
  entry_type: EntryType;
  patient_id: string;
  encounter_id: string | null;
  content: string;
  status: EntryStatus;
  author_id: string;
  author_kind: string;
  source: string | null;
  source_message_id: string | null;
  recorded_at: string;
  effective_at: string | null;
  supersedes: string | null;
  amendment_reason: string | null;
  record_key: string | null;
  hash: string;
  prev_hash: string | null;
}

export interface RecordInput {
  entryType: EntryType;
  patientId: string;
  content: Record<string, unknown>;
  authorId: string;
  authorKind: string;
  encounterId?: string;
  source?: string;
  sourceMessageId?: string;
  /** When it was clinically true, if that differs from when it was written. */
  effectiveAt?: string;
  /** Supply to make a record's id predictable; otherwise one is generated. */
  recordId?: string;
  /**
   * Business key identifying the logical record across messages, so a
   * retransmission or an update lands on the record it is about.
   */
  recordKey?: string;
}

/** The fields the chain commits to: everything that could be falsified. */
function digest(prev: string | null, e: Omit<ClinicalEntry, "seq" | "hash" | "prev_hash">): string {
  const h = createHash("sha256").update(prev ?? "");
  for (const part of [
    e.version_id,
    e.record_id,
    String(e.version),
    e.entry_type,
    e.patient_id,
    e.encounter_id ?? "",
    // The content itself, not a summary of it. A chain over metadata alone
    // would let the clinical text be rewritten under an intact history.
    createHash("sha256").update(e.content).digest("hex"),
    e.status,
    e.author_id,
    e.author_kind,
    e.source ?? "",
    e.recorded_at,
    e.effective_at ?? "",
    e.supersedes ?? "",
    e.amendment_reason ?? "",
    e.record_key ?? "",
  ]) {
    h.update("|").update(part);
  }
  return h.digest("hex");
}

export class ClinicalRecord {
  private db: Db;
  private index: PatientIndex;
  private encounters: Encounters;

  constructor(db: Db) {
    this.db = db;
    this.index = new PatientIndex(db);
    this.encounters = new Encounters(db);
  }

  /** States something new about a patient. Returns the version written. */
  record(input: RecordInput): ClinicalEntry {
    return this.append({
      ...input,
      recordId: input.recordId ?? randomUUID(),
      version: 1,
      status: "active",
      supersedes: null,
      amendmentReason: null,
    });
  }

  /**
   * Corrects a record. The superseded version stays exactly as it was, and is
   * marked `amended` so history reads as a correction rather than as two
   * competing assertions.
   *
   * A reason is required. "Corrected" with no explanation is the shape an
   * amendment takes when someone is tidying up rather than fixing something,
   * and it is the one a reviewer most needs to be able to tell apart.
   */
  amend(
    recordId: string,
    content: Record<string, unknown>,
    by: { authorId: string; authorKind: string; reason: string; effectiveAt?: string }
  ): ClinicalEntry {
    if (!by.reason.trim()) throw new Error("an amendment needs a reason");
    const current = this.current(recordId);
    if (!current) throw new Error(`no clinical record ${recordId}`);
    if (current.status === "entered-in-error") {
      throw new Error("a record marked entered-in-error cannot be amended; record a new one");
    }

    return this.append({
      entryType: current.entry_type,
      patientId: current.patient_id,
      ...(current.encounter_id ? { encounterId: current.encounter_id } : {}),
      content,
      authorId: by.authorId,
      authorKind: by.authorKind,
      ...(by.effectiveAt ? { effectiveAt: by.effectiveAt } : {}),
      ...(current.source ? { source: current.source } : {}),
      recordId,
      ...(current.record_key ? { recordKey: current.record_key } : {}),
      version: current.version + 1,
      status: "active",
      supersedes: current.version_id,
      amendmentReason: by.reason,
    });
  }

  /**
   * Marks a record entered-in-error, which is what a chart does instead of
   * deleting. The content is carried forward unchanged: what was asserted is
   * part of the account of what happened, and a decision taken on the strength
   * of it cannot be reviewed against a blank.
   */
  retract(recordId: string, by: { authorId: string; authorKind: string; reason: string }): ClinicalEntry {
    if (!by.reason.trim()) throw new Error("a retraction needs a reason");
    const current = this.current(recordId);
    if (!current) throw new Error(`no clinical record ${recordId}`);

    return this.append({
      entryType: current.entry_type,
      patientId: current.patient_id,
      ...(current.encounter_id ? { encounterId: current.encounter_id } : {}),
      content: JSON.parse(current.content) as Record<string, unknown>,
      authorId: by.authorId,
      authorKind: by.authorKind,
      ...(current.source ? { source: current.source } : {}),
      recordId,
      ...(current.record_key ? { recordKey: current.record_key } : {}),
      version: current.version + 1,
      status: "entered-in-error",
      supersedes: current.version_id,
      amendmentReason: by.reason,
    });
  }

  /**
   * Files what an interface said, onto the record it is about.
   *
   * Three outcomes, and the middle one carries the weight:
   *
   *   unknown record  -> a first version
   *   same content    -> nothing written
   *   changed content -> an amendment, naming the message that changed it
   *
   * The no-op is not an optimisation. Interfaces retransmit — on reconnect,
   * on replay, on a nightly resend of the day's admissions — and a chart that
   * grew a version per retransmission would bury the two amendments that
   * mattered under four hundred that said nothing. Compared on content rather
   * than on arrival, the same way the FHIR facade decides whether a write
   * changed anything.
   *
   * A retracted record is left alone. Something a clinician marked as entered
   * in error must not be quietly reinstated by the next routine message from
   * the system that produced it.
   */
  ingest(input: RecordInput & { recordKey: string }): { entry?: ClinicalEntry; outcome: "created" | "amended" | "unchanged" | "retracted" } {
    const existing = this.byKey(input.recordKey);
    if (!existing) return { entry: this.record(input), outcome: "created" };
    if (existing.status === "entered-in-error") return { outcome: "retracted" };

    if (existing.content === JSON.stringify(input.content)) return { entry: existing, outcome: "unchanged" };

    return {
      entry: this.amend(existing.record_id, input.content, {
        authorId: input.authorId,
        authorKind: input.authorKind,
        ...(input.effectiveAt ? { effectiveAt: input.effectiveAt } : {}),
        reason: input.sourceMessageId ? `updated by message ${input.sourceMessageId}` : "updated by interface",
      }),
      outcome: "amended",
    };
  }

  /** The latest version of the record a business key identifies. */
  byKey(recordKey: string): ClinicalEntry | undefined {
    return this.db.sql
      .prepare("SELECT * FROM clinical_entries WHERE tenant_id = ? AND record_key = ? ORDER BY version DESC LIMIT 1")
      .get(this.db.tenantId, recordKey) as unknown as ClinicalEntry | undefined;
  }

  /** The latest version of a record, whatever its status. */
  current(recordId: string): ClinicalEntry | undefined {
    return this.db.sql
      .prepare(
        "SELECT * FROM clinical_entries WHERE tenant_id = ? AND record_id = ? ORDER BY version DESC LIMIT 1"
      )
      .get(this.db.tenantId, recordId) as unknown as ClinicalEntry | undefined;
  }

  /**
   * Every version of a record, oldest first. The amendment history.
   *
   * `superseded` is computed from a later version existing, never stored. An
   * earlier design marked the replaced row instead, which meant an amendment
   * wrote to a version a clinician had already signed — the one thing an
   * append-only record exists to prevent — and, because the chain commits to
   * every field including status, broke the chart's own verification. There is
   * now no statement anywhere in this store that updates an entry.
   */
  history(recordId: string): Array<ClinicalEntry & { superseded: boolean }> {
    const rows = this.db.sql
      .prepare("SELECT * FROM clinical_entries WHERE tenant_id = ? AND record_id = ? ORDER BY version")
      .all(this.db.tenantId, recordId) as unknown as ClinicalEntry[];
    return rows.map((r, i) => ({ ...r, superseded: i < rows.length - 1 }));
  }

  /**
   * The chart: the current version of every record for a patient.
   *
   * Retracted records are excluded by default, because a chart is what is
   * believed to be true now — but they are never gone, and `includeRetracted`
   * brings them back for the review that needs them.
   */
  chart(
    patientId: string,
    opts: { entryType?: EntryType; encounterId?: string; includeRetracted?: boolean } = {}
  ): ClinicalEntry[] {
    const clauses: string[] = [];
    const args: unknown[] = [this.db.tenantId, patientId];
    if (opts.entryType) {
      clauses.push("AND entry_type = ?");
      args.push(opts.entryType);
    }
    if (opts.encounterId) {
      clauses.push("AND encounter_id = ?");
      args.push(opts.encounterId);
    }
    if (!opts.includeRetracted) clauses.push("AND status != 'entered-in-error'");

    return this.db.sql
      .prepare(
        `SELECT * FROM clinical_entries
          WHERE tenant_id = ? AND patient_id = ? ${clauses.join(" ")}
            AND version = (
              SELECT MAX(v.version) FROM clinical_entries v
               WHERE v.tenant_id = clinical_entries.tenant_id AND v.record_id = clinical_entries.record_id)
          ORDER BY seq`
      )
      .all(...(args as never[])) as unknown as ClinicalEntry[];
  }

  /**
   * The current version of every record of one type, across every patient
   * in this tenant.
   *
   * A worklist that has to find care plans past their review date cannot
   * walk the patient index and hope. Retracted rows stay out, the same way
   * they stay off a chart: the working list is what is believed to be true
   * now.
   */
  currentOfType(entryType: EntryType): ClinicalEntry[] {
    return this.db.sql
      .prepare(
        `SELECT * FROM clinical_entries
          WHERE tenant_id = ? AND entry_type = ? AND status != 'entered-in-error'
            AND version = (
              SELECT MAX(v.version) FROM clinical_entries v
               WHERE v.tenant_id = clinical_entries.tenant_id AND v.record_id = clinical_entries.record_id)
          ORDER BY seq`
      )
      .all(this.db.tenantId, entryType) as unknown as ClinicalEntry[];
  }

  /** Every version written for a patient, oldest first. */
  entries(patientId: string): ClinicalEntry[] {
    return this.db.sql
      .prepare("SELECT * FROM clinical_entries WHERE tenant_id = ? AND patient_id = ? ORDER BY seq")
      .all(this.db.tenantId, patientId) as unknown as ClinicalEntry[];
  }

  /**
   * Walks a patient's chart chain.
   *
   * Same two-part construction as the message and audit chains, and for the
   * same reasons. Linkage catches an edited entry and one removed from the
   * middle; the version counter catches removal from the end, which linkage
   * cannot see because nothing survives that pointed at the missing rows.
   */
  verifyChart(patientId: string): {
    ok: boolean;
    checked: number;
    tip?: string;
    brokenAt?: string;
    missing?: { expected: number; found: number };
  } {
    const rows = this.entries(patientId);
    let prev: string | null = null;
    let checked = 0;
    for (const r of rows) {
      const expect = digest(prev, r);
      if (r.prev_hash !== prev || r.hash !== expect) return { ok: false, checked, brokenAt: r.version_id };
      prev = r.hash;
      checked++;
    }

    const issued = this.db.sql
      .prepare("SELECT issued FROM clinical_counters WHERE tenant_id = ? AND patient_id = ?")
      .get(this.db.tenantId, patientId) as { issued: number } | undefined;
    if (issued && issued.issued !== checked) {
      return { ok: false, checked, missing: { expected: issued.issued, found: checked } };
    }
    return { ok: true, checked, ...(prev ? { tip: prev } : {}) };
  }

  /** The lookup index over these charts. */
  get patientIndex(): PatientIndex {
    return this.index;
  }

  /** Patients with at least one entry, for a chart index. */
  patients(): Array<{ patientId: string; entries: number; lastRecordedAt: string }> {
    return this.db.sql
      .prepare(
        `SELECT patient_id AS patientId, COUNT(*) AS entries, MAX(recorded_at) AS lastRecordedAt
           FROM clinical_entries WHERE tenant_id = ?
          GROUP BY patient_id ORDER BY lastRecordedAt DESC`
      )
      .all(this.db.tenantId) as Array<{ patientId: string; entries: number; lastRecordedAt: string }>;
  }

  /** The chain tip for a patient, read fresh: charts are written rarely. */
  private tip(patientId: string): string | null {
    const row = this.db.sql
      .prepare("SELECT hash FROM clinical_entries WHERE tenant_id = ? AND patient_id = ? ORDER BY seq DESC LIMIT 1")
      .get(this.db.tenantId, patientId) as { hash: string } | undefined;
    return row?.hash ?? null;
  }

  private append(
    input: RecordInput & {
      recordId: string;
      version: number;
      status: EntryStatus;
      supersedes: string | null;
      amendmentReason: string | null;
    }
  ): ClinicalEntry {
    // An encounter_id that names nothing, or names another patient's visit,
    // is worse than none: it reads as provenance and is not. Checked here
    // rather than at every caller, because the callers are the ones that
    // forget.
    if (input.encounterId) this.encounters.validateFor(input.encounterId, input.patientId);
    return this.db.transaction(() => {
      const versionId = randomUUID();
      const row: Omit<ClinicalEntry, "seq" | "hash" | "prev_hash"> = {
        tenant_id: this.db.tenantId,
        version_id: versionId,
        record_id: input.recordId,
        version: input.version,
        entry_type: input.entryType,
        patient_id: input.patientId,
        encounter_id: input.encounterId ?? null,
        content: JSON.stringify(input.content),
        status: input.status,
        author_id: input.authorId,
        author_kind: input.authorKind,
        source: input.source ?? null,
        source_message_id: input.sourceMessageId ?? null,
        recorded_at: new Date().toISOString(),
        effective_at: input.effectiveAt ?? null,
        supersedes: input.supersedes,
        amendment_reason: input.amendmentReason,
        record_key: input.recordKey ?? null,
      };
      const prev = this.tip(input.patientId);
      const hash = digest(prev, row);

      this.db.sql
        .prepare(
          `INSERT INTO clinical_entries
             (tenant_id, version_id, record_id, version, entry_type, patient_id, encounter_id, content,
              status, author_id, author_kind, source, source_message_id, recorded_at, effective_at,
              supersedes, amendment_reason, record_key, hash, prev_hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          row.tenant_id,
          row.version_id,
          row.record_id,
          row.version,
          row.entry_type,
          row.patient_id,
          row.encounter_id,
          row.content,
          row.status,
          row.author_id,
          row.author_kind,
          row.source,
          row.source_message_id,
          row.recorded_at,
          row.effective_at,
          row.supersedes,
          row.amendment_reason,
          row.record_key,
          hash,
          prev
        );

      this.db.sql
        .prepare(
          `INSERT INTO clinical_counters (tenant_id, patient_id, issued) VALUES (?, ?, 1)
           ON CONFLICT(tenant_id, patient_id) DO UPDATE SET issued = issued + 1`
        )
        .run(this.db.tenantId, input.patientId);

      // The lookup index follows the log, in the same transaction, so the two
      // cannot disagree across a crash. It is still derived: rebuild() from
      // the log reproduces it exactly, which is what keeps the log the record.
      if (input.entryType === "Patient" && input.status !== "entered-in-error") {
        this.index.index(input.patientId, input.content);
      }

      return this.db.sql
        .prepare("SELECT * FROM clinical_entries WHERE tenant_id = ? AND version_id = ?")
        .get(this.db.tenantId, versionId) as unknown as ClinicalEntry;
    });
  }
}
