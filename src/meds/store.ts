/**
 * The medication list, the allergy list, and reconciliation between them.
 *
 * The failure this is built around is a list that says what was prescribed
 * rather than what the patient is taking. Those are different claims. A
 * prescription written eighteen months ago is evidence that somebody intended
 * a drug, not that it is in the patient — and the patient who stopped their
 * statin because of muscle aches and mentioned it to nobody has a chart that
 * says otherwise. Every dose calculated around that list is calculated around
 * a drug that is not there.
 *
 * So provenance is required on every statement, `adherence` is a separate
 * column from `status`, and the list can be read either way: what is
 * prescribed, or what the patient says they take. A system that cannot tell
 * them apart is the commonest medication error there is.
 *
 * Statements are appended, never updated, for the same reason results are: a
 * claim made at a time stays true about that time. A dose change is a new row
 * superseding the old one, and the old dose remains legible because "what was
 * the patient on when this happened" is the question a review asks.
 *
 * Stopping requires a reason. A drug that vanishes from a list with nothing
 * recorded is indistinguishable from one deleted by mistake, and the two call
 * for opposite responses from the next prescriber to read it.
 */
import { randomUUID } from "node:crypto";
import { an } from "../core/text.ts";
import type { Db } from "../db.ts";
import { Refusal } from "../core/refusal.ts";
import { Encounters } from "../clinical/encounters.ts";
import { assess, normalise, type AllergyStatus, type Finding, type InteractionSource, type SafetyCheck } from "./safety.ts";

export type MedSource = "prescribed" | "patient-reported" | "pharmacy-dispense" | "reconciled" | "external-record";
export type MedStatus = "active" | "completed" | "stopped" | "on-hold" | "entered-in-error";
export type Adherence = "taking" | "not-taking" | "taking-differently" | "unknown";
export type AllergyKind = "allergy" | "intolerance" | "no-known-allergies";
export type Criticality = "low" | "high" | "unable-to-assess";
export type Transition = "admission" | "transfer" | "discharge" | "ambulatory-review";
export type Decision = "continue" | "stop" | "modify" | "start" | "unresolved";

export interface MedRow {
  tenant_id: string;
  id: string;
  patient_id: string;
  encounter_id: string | null;
  code: string;
  code_system: string | null;
  display: string;
  ingredient: string | null;
  dose: string | null;
  route: string | null;
  frequency: string | null;
  source: MedSource;
  status: MedStatus;
  adherence: Adherence;
  indication: string | null;
  prescriber_id: string | null;
  stop_reason: string | null;
  effective_from: string | null;
  effective_to: string | null;
  supersedes: string | null;
  asserted_by: string;
  asserted_at: string;
  source_message_id: string | null;
  created_at: string;
}

export interface AllergyRow {
  tenant_id: string;
  id: string;
  patient_id: string;
  code: string | null;
  code_system: string | null;
  display: string | null;
  ingredient: string | null;
  kind: AllergyKind;
  criticality: Criticality;
  reaction: string | null;
  status: string;
  supersedes: string | null;
  asserted_by: string;
  asserted_at: string;
  source_message_id: string | null;
  created_at: string;
}

export interface ReconciliationRow {
  tenant_id: string;
  id: string;
  patient_id: string;
  encounter_id: string | null;
  transition: Transition;
  status: "open" | "completed" | "abandoned";
  started_by: string;
  started_at: string;
  completed_by: string | null;
  completed_at: string | null;
  abandon_reason: string | null;
  created_at: string;
}

export interface ReconciliationItem {
  tenant_id: string;
  id: string;
  reconciliation_id: string;
  statement_id: string | null;
  display: string;
  prior: string | null;
  proposed: string | null;
  decision: Decision;
  reason: string | null;
  decided_by: string | null;
  decided_at: string | null;
  created_at: string;
}

export interface Actor {
  actorId: string;
  actorKind: string;
}

export class MedicationStore {
  private db: Db;
  private interactions: InteractionSource | null;
  private encounters: Encounters;

  constructor(db: Db, interactions: InteractionSource | null = null) {
    this.db = db;
    this.interactions = interactions;
    this.encounters = new Encounters(db);
  }

  // ---- the list ----------------------------------------------------------

  /**
   * Records that a patient is on something, and on whose word.
   *
   * `source` is required and has no default. A default would be a guess about
   * provenance written into the record as a fact, and provenance is the one
   * thing this list exists to keep straight.
   */
  record(input: {
    patientId: string;
    code: string;
    display: string;
    source: MedSource;
    by: Actor;
    ingredient?: string;
    codeSystem?: string;
    dose?: string;
    route?: string;
    frequency?: string;
    indication?: string;
    prescriberId?: string;
    adherence?: Adherence;
    encounterId?: string;
    effectiveFrom?: string;
    sourceMessageId?: string;
  }): MedRow {
    return this.db.transaction(() => this.insert(input, null, "active"));
  }

  /**
   * Changes a dose, route or frequency.
   *
   * A new statement superseding the old one, so the earlier dose stays
   * readable. "What was the patient on when this happened" is not answerable
   * from a table that was updated in place.
   */
  revise(
    statementId: string,
    changes: { dose?: string; route?: string; frequency?: string; adherence?: Adherence; indication?: string },
    by: Actor & { source?: MedSource }
  ): MedRow {
    const prior = this.statement(statementId);
    if (!prior) throw new Error(`no medication statement ${statementId}`);
    if (this.supersededBy(statementId)) throw new Error("that statement has already been revised");
    if (prior.status === "stopped" || prior.status === "entered-in-error") {
      throw new Error(`${an(prior.status)} medication cannot be revised; record a new one`);
    }
    return this.db.transaction(() =>
      this.insert(
        {
          patientId: prior.patient_id,
          code: prior.code,
          display: prior.display,
          codeSystem: prior.code_system ?? undefined,
          ingredient: prior.ingredient ?? undefined,
          dose: changes.dose ?? prior.dose ?? undefined,
          route: changes.route ?? prior.route ?? undefined,
          frequency: changes.frequency ?? prior.frequency ?? undefined,
          indication: changes.indication ?? prior.indication ?? undefined,
          prescriberId: prior.prescriber_id ?? undefined,
          adherence: changes.adherence ?? prior.adherence,
          encounterId: prior.encounter_id ?? undefined,
          source: by.source ?? prior.source,
          by,
        },
        statementId,
        "active"
      )
    );
  }

  /**
   * Stops a medication, with a reason.
   *
   * Required, and not for tidiness. A drug that disappears with nothing
   * recorded is indistinguishable from one removed in error, and the next
   * prescriber's response to those two should be opposite.
   */
  stop(statementId: string, by: Actor & { reason: string }): MedRow {
    if (!by.reason.trim()) throw new Error("stopping a medication needs a reason");
    const prior = this.statement(statementId);
    if (!prior) throw new Error(`no medication statement ${statementId}`);
    if (this.supersededBy(statementId)) throw new Error("that statement has already been superseded");
    if (prior.status === "stopped") throw new Error("this medication is already stopped");
    const row = this.db.transaction(() => {
      const next = this.insert(
        {
          patientId: prior.patient_id,
          code: prior.code,
          display: prior.display,
          codeSystem: prior.code_system ?? undefined,
          ingredient: prior.ingredient ?? undefined,
          dose: prior.dose ?? undefined,
          route: prior.route ?? undefined,
          frequency: prior.frequency ?? undefined,
          indication: prior.indication ?? undefined,
          prescriberId: prior.prescriber_id ?? undefined,
          adherence: "not-taking",
          encounterId: prior.encounter_id ?? undefined,
          source: prior.source,
          by,
        },
        statementId,
        "stopped",
        by.reason
      );
      return next;
    });
    return row;
  }

  /**
   * What the patient is actually taking, as opposed to what is prescribed.
   *
   * The default excludes anything the patient has said they are not taking,
   * because that is the list a prescriber needs when calculating a dose. Pass
   * `asPrescribed` for the other list — both are real, and conflating them is
   * the error.
   */
  current(patientId: string, opts: { asPrescribed?: boolean; includeStopped?: boolean } = {}): MedRow[] {
    const rows = this.db.sql
      .prepare(
        `SELECT m.* FROM medication_statements m
          WHERE m.tenant_id = ? AND m.patient_id = ?
            AND m.status != 'entered-in-error'
            AND NOT EXISTS (
              SELECT 1 FROM medication_statements n
               WHERE n.tenant_id = ? AND n.supersedes = m.id
            )
          ORDER BY m.display`
      )
      .all(this.db.tenantId, patientId, this.db.tenantId) as unknown as MedRow[];
    return rows.filter((r) => {
      if (!opts.includeStopped && r.status === "stopped") return false;
      if (!opts.asPrescribed && r.adherence === "not-taking") return false;
      return true;
    });
  }

  /** Every version of a statement, oldest first. */
  /** The medication statements written during one visit. */
  forEncounter(encounterId: string): MedRow[] {
    return this.db.sql
      .prepare(
        `SELECT * FROM medication_statements WHERE tenant_id = ? AND encounter_id = ?
          ORDER BY created_at`
      )
      .all(this.db.tenantId, encounterId) as unknown as MedRow[];
  }

  historyOf(statementId: string): MedRow[] {
    const chain: MedRow[] = [];
    let cursor = this.statement(statementId);
    while (cursor) {
      chain.unshift(cursor);
      cursor = cursor.supersedes ? this.statement(cursor.supersedes) : undefined;
    }
    let last = chain[chain.length - 1];
    for (;;) {
      const next = last ? this.supersededBy(last.id) : undefined;
      if (!next) break;
      const row = this.statement(next)!;
      chain.push(row);
      last = row;
    }
    return chain;
  }

  statement(id: string): MedRow | undefined {
    return this.db.sql
      .prepare("SELECT * FROM medication_statements WHERE tenant_id = ? AND id = ?")
      .get(this.db.tenantId, id) as unknown as MedRow | undefined;
  }

  // ---- allergies ---------------------------------------------------------

  /** Records an allergy or intolerance. */
  recordAllergy(input: {
    patientId: string;
    display: string;
    by: Actor;
    ingredient?: string;
    code?: string;
    codeSystem?: string;
    kind?: "allergy" | "intolerance";
    criticality?: Criticality;
    reaction?: string;
    sourceMessageId?: string;
  }): AllergyRow {
    return this.insertAllergy({
      ...input,
      kind: input.kind ?? "allergy",
    });
  }

  /**
   * Records that the patient was asked and has no known allergies.
   *
   * A row, not an absence, and this is the whole point of the table. An empty
   * allergy list because nobody asked and one because the answer was none are
   * clinically opposite, and they look identical unless the second is written
   * down. Without this, a check returns "no contraindications" for a patient
   * whose history was never taken.
   */
  recordNoKnownAllergies(patientId: string, by: Actor): AllergyRow {
    return this.insertAllergy({ patientId, display: "No known drug allergies", by, kind: "no-known-allergies" });
  }

  /**
   * Whether the allergy question has been asked, and what the answer was.
   *
   * Three outcomes, never two.
   */
  allergyStatus(patientId: string): AllergyStatus {
    const rows = this.allergies(patientId);
    if (rows.some((a) => a.kind !== "no-known-allergies")) return "documented";
    if (rows.length > 0) return "none-documented";
    return "never-asked";
  }

  /** Active allergy records, most recent assertion of each kept. */
  allergies(patientId: string): AllergyRow[] {
    return this.db.sql
      .prepare(
        `SELECT a.* FROM allergies a
          WHERE a.tenant_id = ? AND a.patient_id = ? AND a.status = 'active'
            AND NOT EXISTS (
              SELECT 1 FROM allergies n WHERE n.tenant_id = ? AND n.supersedes = a.id
            )
          ORDER BY a.asserted_at`
      )
      .all(this.db.tenantId, patientId, this.db.tenantId) as unknown as AllergyRow[];
  }

  // ---- the check ---------------------------------------------------------

  /**
   * Runs the safety check for a proposed medication.
   *
   * Never blocks and never decides. It reports, including reporting that it
   * could not check — `never-asked` allergies and an unavailable interaction
   * source are findings, not silence.
   */
  check(patientId: string, proposed: { ingredient: string; display: string }): SafetyCheck {
    const current = this.current(patientId, { asPrescribed: true })
      .filter((m) => m.status === "active" || m.status === "on-hold")
      .map((m) => ({ ingredient: m.ingredient ?? m.display, display: m.display }));
    return assess({
      proposedIngredient: proposed.ingredient,
      proposedDisplay: proposed.display,
      allergies: this.allergies(patientId).filter((a) => a.kind !== "no-known-allergies"),
      allergyStatus: this.allergyStatus(patientId),
      currentIngredients: current,
      interactions: this.interactions,
    });
  }

  /**
   * Prescribes, running the check first.
   *
   * A blocking finding requires an override with a reason. The prescriber may
   * always proceed — an emergency does not wait for an allergy history, and a
   * system that refuses outright is one clinicians route around — but
   * proceeding is an act that is recorded, with what they were told and what
   * they said about it. An override nobody can produce afterwards is the same
   * as no warning having been shown.
   */
  prescribe(
    input: {
      patientId: string;
      code: string;
      display: string;
      ingredient: string;
      by: Actor;
      prescriberId?: string;
      dose?: string;
      route?: string;
      frequency?: string;
      indication?: string;
      codeSystem?: string;
      encounterId?: string;
      effectiveFrom?: string;
    },
    override?: { reason: string }
  ): { statement: MedRow; check: SafetyCheck } {
    const check = this.check(input.patientId, { ingredient: input.ingredient, display: input.display });
    if (check.blocking.length > 0) {
      if (!override || !override.reason.trim()) {
        throw new PrescriptionRefused(check);
      }
    }
    const statement = this.db.transaction(() => {
      const row = this.insert(
        { ...input, source: "prescribed", prescriberId: input.prescriberId ?? input.by.actorId, adherence: "taking" },
        null,
        "active"
      );
      if (check.blocking.length > 0 && override) {
        this.event(input.patientId, row.id, "override", input.by, {
          detail: override.reason,
          overrides: JSON.stringify(check.blocking.map((f) => ({ kind: f.kind, severity: f.severity, message: f.message }))),
        });
      }
      return row;
    });
    return { statement, check };
  }

  // ---- reconciliation ----------------------------------------------------

  /**
   * Opens a reconciliation at a transition of care.
   *
   * Every current medication becomes a line requiring a decision. Seeding it
   * from the list rather than leaving it empty is the difference between a
   * reconciliation and a form: an empty one is completed by doing nothing.
   */
  startReconciliation(input: {
    patientId: string;
    transition: Transition;
    by: Actor;
    encounterId?: string;
  }): ReconciliationRow {
    if (input.encounterId) this.encounters.validateFor(input.encounterId, input.patientId);
    const id = randomUUID();
    const now = new Date().toISOString();
    return this.db.transaction(() => {
      this.db.sql
        .prepare(
          `INSERT INTO med_reconciliations
             (tenant_id, id, patient_id, encounter_id, transition, status, started_by, started_at, created_at)
           VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?)`
        )
        .run(this.db.tenantId, id, input.patientId, input.encounterId ?? null, input.transition, input.by.actorId, now, now);

      for (const m of this.current(input.patientId, { asPrescribed: true })) {
        this.db.sql
          .prepare(
            `INSERT INTO med_reconciliation_items
               (tenant_id, id, reconciliation_id, statement_id, display, prior, decision, created_at)
             VALUES (?, ?, ?, ?, ?, ?, 'unresolved', ?)`
          )
          .run(
            this.db.tenantId,
            randomUUID(),
            id,
            m.id,
            m.display,
            [m.dose, m.route, m.frequency].filter(Boolean).join(" ") || null,
            now
          );
      }
      this.event(input.patientId, null, "reconciliation-started", input.by, { detail: input.transition });
      return this.reconciliation(id)!;
    });
  }

  /** Adds a medication the patient turned out to be taking. */
  addToReconciliation(reconciliationId: string, display: string, proposed: string | null, by: Actor): ReconciliationItem {
    const rec = this.requireReconciliation(reconciliationId);
    if (rec.status !== "open") throw new Error(`${an(rec.status)} reconciliation cannot be added to`);
    const id = randomUUID();
    this.db.sql
      .prepare(
        `INSERT INTO med_reconciliation_items
           (tenant_id, id, reconciliation_id, display, proposed, decision, created_at)
         VALUES (?, ?, ?, ?, ?, 'unresolved', ?)`
      )
      .run(this.db.tenantId, id, reconciliationId, display, proposed, new Date().toISOString());
    this.event(rec.patient_id, null, "reconciliation-item-added", by, { detail: display });
    return this.item(id)!;
  }

  /** Resolves one line. A stop or a modification needs a reason. */
  decide(itemId: string, decision: Decision, by: Actor & { reason?: string }): ReconciliationItem {
    const item = this.item(itemId);
    if (!item) throw new Error(`no reconciliation item ${itemId}`);
    if (decision === "unresolved") throw new Error("a decision cannot be to leave it undecided");
    if ((decision === "stop" || decision === "modify") && !by.reason?.trim()) {
      throw new Error(`${an(decision)} decision needs a reason`);
    }
    const rec = this.requireReconciliation(item.reconciliation_id);
    if (rec.status !== "open") throw new Error(`${an(rec.status)} reconciliation cannot be changed`);
    this.db.sql
      .prepare(
        `UPDATE med_reconciliation_items SET decision = ?, reason = ?, decided_by = ?, decided_at = ?
          WHERE tenant_id = ? AND id = ?`
      )
      .run(decision, by.reason ?? null, by.actorId, new Date().toISOString(), this.db.tenantId, itemId);
    return this.item(itemId)!;
  }

  /**
   * Completes a reconciliation, and refuses while anything is undecided.
   *
   * The refusal is the point. A reconciliation marked done with lines nobody
   * resolved is worse than one never started, because the chart now says the
   * work was done — and the next clinician has no reason to look again. The
   * unresolved lines are named in the error so the refusal is actionable.
   */
  completeReconciliation(reconciliationId: string, by: Actor): ReconciliationRow {
    const rec = this.requireReconciliation(reconciliationId);
    if (rec.status !== "open") throw new Error(`this reconciliation is already ${rec.status}`);
    const open = this.items(reconciliationId).filter((i) => i.decision === "unresolved");
    if (open.length > 0) {
      throw new Error(`${open.length} medication(s) still undecided: ${open.map((i) => i.display).join(", ")}`);
    }
    return this.db.transaction(() => {
      const now = new Date().toISOString();
      this.db.sql
        .prepare(
          `UPDATE med_reconciliations SET status = 'completed', completed_by = ?, completed_at = ?
            WHERE tenant_id = ? AND id = ?`
        )
        .run(by.actorId, now, this.db.tenantId, reconciliationId);
      // The decisions are applied to the list, which is what makes this a
      // reconciliation rather than a questionnaire.
      for (const item of this.items(reconciliationId)) {
        if (item.decision === "stop" && item.statement_id) {
          const live = this.statement(item.statement_id);
          if (live && live.status !== "stopped" && !this.supersededBy(live.id)) {
            this.stop(live.id, { ...by, reason: item.reason ?? `stopped at ${rec.transition}` });
          }
        }
      }
      this.event(rec.patient_id, null, "reconciliation-completed", by, { detail: rec.transition });
      return this.reconciliation(reconciliationId)!;
    });
  }

  /** Abandons one, with a reason, so it does not sit open forever. */
  abandonReconciliation(reconciliationId: string, by: Actor & { reason: string }): ReconciliationRow {
    if (!by.reason.trim()) throw new Error("abandoning a reconciliation needs a reason");
    const rec = this.requireReconciliation(reconciliationId);
    if (rec.status !== "open") throw new Error(`this reconciliation is already ${rec.status}`);
    this.db.sql
      .prepare("UPDATE med_reconciliations SET status = 'abandoned', abandon_reason = ? WHERE tenant_id = ? AND id = ?")
      .run(by.reason, this.db.tenantId, reconciliationId);
    this.event(rec.patient_id, null, "reconciliation-abandoned", by, { detail: by.reason });
    return this.reconciliation(reconciliationId)!;
  }

  /** Transitions of care where the reconciliation was never finished. */
  incompleteReconciliations(): ReconciliationRow[] {
    return this.db.sql
      .prepare("SELECT * FROM med_reconciliations WHERE tenant_id = ? AND status = 'open' ORDER BY started_at")
      .all(this.db.tenantId) as unknown as ReconciliationRow[];
  }

  reconciliation(id: string): ReconciliationRow | undefined {
    return this.db.sql
      .prepare("SELECT * FROM med_reconciliations WHERE tenant_id = ? AND id = ?")
      .get(this.db.tenantId, id) as unknown as ReconciliationRow | undefined;
  }

  items(reconciliationId: string): ReconciliationItem[] {
    return this.db.sql
      .prepare("SELECT * FROM med_reconciliation_items WHERE tenant_id = ? AND reconciliation_id = ? ORDER BY display")
      .all(this.db.tenantId, reconciliationId) as unknown as ReconciliationItem[];
  }

  item(id: string): ReconciliationItem | undefined {
    return this.db.sql
      .prepare("SELECT * FROM med_reconciliation_items WHERE tenant_id = ? AND id = ?")
      .get(this.db.tenantId, id) as unknown as ReconciliationItem | undefined;
  }

  /** Everything that happened to this patient's medications, in order. */
  events(patientId: string): Array<{
    seq: number;
    at: string;
    event: string;
    actor_id: string;
    detail: string | null;
    overrides: string | null;
  }> {
    return this.db.sql
      .prepare("SELECT * FROM medication_events WHERE tenant_id = ? AND patient_id = ? ORDER BY seq")
      .all(this.db.tenantId, patientId) as never;
  }

  // ---- internals ---------------------------------------------------------

  private insert(
    input: {
      patientId: string;
      code: string;
      display: string;
      source: MedSource;
      by: Actor;
      ingredient?: string;
      codeSystem?: string;
      dose?: string;
      route?: string;
      frequency?: string;
      indication?: string;
      prescriberId?: string;
      adherence?: Adherence;
      encounterId?: string;
      effectiveFrom?: string;
      sourceMessageId?: string;
    },
    supersedes: string | null,
    status: MedStatus,
    stopReason?: string
  ): MedRow {
    // An encounter_id that names nothing, or names another patient's visit,
    // is worse than none: it reads as provenance and is not. Checked here
    // rather than at every caller, because the callers are the ones that
    // forget.
    if (input.encounterId) this.encounters.validateFor(input.encounterId, input.patientId);
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.sql
      .prepare(
        `INSERT INTO medication_statements
           (tenant_id, id, patient_id, encounter_id, code, code_system, display, ingredient, dose, route,
            frequency, source, status, adherence, indication, prescriber_id, stop_reason, effective_from,
            effective_to, supersedes, asserted_by, asserted_at, source_message_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        this.db.tenantId,
        id,
        input.patientId,
        input.encounterId ?? null,
        input.code,
        input.codeSystem ?? null,
        input.display,
        input.ingredient ?? normalise(input.display),
        input.dose ?? null,
        input.route ?? null,
        input.frequency ?? null,
        input.source,
        status,
        input.adherence ?? "unknown",
        input.indication ?? null,
        input.prescriberId ?? null,
        stopReason ?? null,
        input.effectiveFrom ?? null,
        status === "stopped" ? now : null,
        supersedes,
        input.by.actorId,
        now,
        input.sourceMessageId ?? null,
        now
      );
    this.event(input.patientId, id, status === "stopped" ? "stopped" : supersedes ? "revised" : "recorded", input.by, {
      detail: `${input.display}${input.dose ? " " + input.dose : ""}${stopReason ? `: ${stopReason}` : ""}`,
    });
    return this.statement(id)!;
  }

  private insertAllergy(input: {
    patientId: string;
    display: string;
    by: Actor;
    ingredient?: string;
    code?: string;
    codeSystem?: string;
    kind: AllergyKind;
    criticality?: Criticality;
    reaction?: string;
    sourceMessageId?: string;
  }): AllergyRow {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.sql
      .prepare(
        `INSERT INTO allergies
           (tenant_id, id, patient_id, code, code_system, display, ingredient, kind, criticality,
            reaction, status, supersedes, asserted_by, asserted_at, source_message_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?, ?, ?)`
      )
      .run(
        this.db.tenantId,
        id,
        input.patientId,
        input.code ?? null,
        input.codeSystem ?? null,
        input.display,
        input.ingredient ?? (input.kind === "no-known-allergies" ? null : normalise(input.display)),
        input.kind,
        input.criticality ?? "unable-to-assess",
        input.reaction ?? null,
        input.by.actorId,
        now,
        input.sourceMessageId ?? null,
        now
      );
    this.event(input.patientId, null, `allergy-${input.kind}`, input.by, { detail: input.display });
    return this.db.sql
      .prepare("SELECT * FROM allergies WHERE tenant_id = ? AND id = ?")
      .get(this.db.tenantId, id) as unknown as AllergyRow;
  }

  private supersededBy(statementId: string): string | undefined {
    const row = this.db.sql
      .prepare("SELECT id FROM medication_statements WHERE tenant_id = ? AND supersedes = ?")
      .get(this.db.tenantId, statementId) as { id: string } | undefined;
    return row?.id;
  }

  private requireReconciliation(id: string): ReconciliationRow {
    const rec = this.reconciliation(id);
    if (!rec) throw new Error(`no reconciliation ${id}`);
    return rec;
  }

  private event(
    patientId: string,
    statementId: string | null,
    event: string,
    by: Actor,
    extra: { detail?: string; overrides?: string }
  ): void {
    this.db.sql
      .prepare(
        `INSERT INTO medication_events (tenant_id, patient_id, statement_id, at, event, actor_id, actor_kind, detail, overrides)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        this.db.tenantId,
        patientId,
        statementId,
        new Date().toISOString(),
        event,
        by.actorId,
        by.actorKind,
        extra.detail ?? null,
        extra.overrides ?? null
      );
  }
}

/** Thrown when a prescription would proceed past a blocking finding. */
export class PrescriptionRefused extends Refusal {
  readonly check: SafetyCheck;
  readonly findings: Finding[];

  constructor(check: SafetyCheck) {
    super(`prescription refused without an override: ${check.blocking.map((f) => f.message).join("; ")}`, 409);
    this.name = "PrescriptionRefused";
    this.check = check;
    this.findings = check.blocking;
  }
}
