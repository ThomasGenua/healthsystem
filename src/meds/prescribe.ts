/**
 * Getting a prescription to a pharmacy, and knowing whether it arrived.
 *
 * A prescription was recorded carefully and then went nowhere. The clinician
 * wrote it into the chart, printed it or read it down the phone, and the
 * pharmacy wrote it again at their end — two records of one decision, drifting
 * apart from the moment they were made. That is the failure this module is
 * about, and it is not solved by a "sent" flag.
 *
 * Four things are structural, because each is a way a prescription is lost or
 * doubled:
 *
 * ## Not transmitted is a state, not an absence
 *
 * Printing a prescription and handing it to the patient is a real workflow and
 * will remain one for as long as there are pharmacies without an interface. So
 * `handOut()` records exactly that: this prescription left the building on
 * paper, and nobody should be waiting for an acknowledgement. What is refused
 * is the third state — a prescription that is neither transmitted nor
 * deliberately printed, sitting in the chart looking finished. That is the one
 * a patient goes to collect and finds nothing.
 *
 * ## Transmitting twice is a double dispense
 *
 * The dangerous retry. A pharmacy that receives the same prescription twice
 * may dispense it twice, and for an opioid that is a serious adverse event
 * with no error attached anywhere. So a second transmission of the same
 * prescription is refused unless it explicitly says it is replacing a failed
 * one, and that decision is recorded with a reason.
 *
 * ## Sent is not received
 *
 * Northstar does not know how to talk to a pharmacy network and should not
 * pretend to. A transmission is published onto a channel the deployment
 * configures, and the delivery machinery carries it — ordered, retried,
 * dead-lettered — exactly like every other clinical message. What comes back
 * is an acknowledgement somebody or something records. Until then the
 * prescription is *outstanding*, and `awaitingAcknowledgement()` is the list
 * that stops "we sent it" from being the end of the story.
 *
 * ## Dispensed is not prescribed, and unknown is not "no"
 *
 * A prescription that reached a pharmacy is not a medication in a patient. It
 * becomes one when somebody collects it, and the gap between those two facts
 * is where a chart starts lying: every screen shows the drug, nothing shows
 * that it is still on a shelf. So a dispense is recorded as its own event.
 *
 * What makes that honest rather than decorative is the third state. A
 * prescription with no dispense against it means the patient did not collect
 * it **only where the pharmacy is declared to report dispenses**. Everywhere
 * else the absence means nothing at all, and saying "never collected" would
 * flag every prescription sent to a pharmacy that simply does not send
 * notifications. Silence is `unknown`, and it says so.
 *
 * ## A renewal request is work, not a message
 *
 * A pharmacy asking for a repeat is a decision a prescriber has to make, and
 * a decision that arrives as a fax, an email or a note in a queue nobody owns
 * is a decision that gets made late or not at all. It arrives here as an item
 * in the unified worklist, which cannot be closed without saying what was
 * done.
 *
 * ## A controlled substance is not an ordinary prescription
 *
 * Electronic prescribing of narcotics and controlled drugs is separately
 * regulated, and a system that transmitted one because it could would be
 * putting a deployment in breach without telling it. It is refused unless the
 * deployment has declared the authorisation it holds, and the declaration is
 * recorded on the prescription.
 */
import { randomUUID } from "node:crypto";
import type { Db } from "../db.ts";
import { refuse } from "../core/refusal.ts";
import { an } from "../core/text.ts";
import { Directory } from "../directory/store.ts";
import type { TaskRow, TaskStore } from "../work/tasks.ts";
import type { MedicationStore, MedRow } from "./store.ts";
import type { Finding, SafetyCheck } from "./safety.ts";

export const PRESCRIPTION_STATUSES = [
  /** Written, not yet gone anywhere. Nobody is waiting. */
  "draft",
  /** Published to the pharmacy channel; waiting on an acknowledgement. */
  "transmitted",
  /** The pharmacy confirmed receipt. */
  "acknowledged",
  /** Deliberately given to the patient on paper. Nobody is waiting. */
  "handed-out",
  /** The transmission could not be sent, or was rejected. */
  "failed",
  /** Withdrawn. A transmitted prescription also needs the pharmacy told. */
  "cancelled",
] as const;
export type PrescriptionStatus = (typeof PRESCRIPTION_STATUSES)[number];

/** How long a transmitted prescription may go unacknowledged before it is chased. */
const ACK_WINDOW_HOURS = 4;

/** How far ahead of us a pharmacy's clock may be before a dispense is refused. */
const CLOCK_SKEW_HOURS = 24;

/**
 * What the pharmacy did with it.
 *
 * `not-collected` is the one worth having: a pharmacy that returns a
 * prescription to stock is reporting a fact, and a reported fact is
 * actionable in a way an absence never is.
 */
export const DISPENSE_OUTCOMES = ["dispensed", "partially-dispensed", "not-collected"] as const;
export type DispenseOutcome = (typeof DISPENSE_OUTCOMES)[number];

export interface DispenseRow {
  tenant_id: string;
  id: string;
  prescription_id: string;
  patient_id: string;
  outcome: DispenseOutcome;
  /** When the pharmacy says it happened, which is not when we heard. */
  dispensed_at: string;
  quantity: string | null;
  days_supply: number | null;
  reported_at: string;
  reported_by: string;
  source_message_id: string | null;
  detail: string | null;
}

/**
 * Whether this prescription reached the patient, as far as anyone can tell.
 *
 * `unknown` is not a failure to compute. It is the answer for a prescription
 * sent to a pharmacy that does not report dispenses, and it is the only
 * honest one: nothing about that silence distinguishes a patient who
 * collected their medication from one who never went.
 */
export type DispenseState =
  | { state: "not-applicable"; detail: string }
  | { state: "unknown"; detail: string }
  | { state: "awaiting"; detail: string }
  | { state: "dispensed"; at: string; detail: string }
  | { state: "partially-dispensed"; at: string; detail: string }
  | { state: "not-collected"; at: string; detail: string };

/**
 * The safety check as the prescriber saw it, travelling with the script.
 *
 * A pharmacist runs their own check; that is the point of two professionals.
 * What they cannot reconstruct is what *this* check saw and what the
 * prescriber decided to sign past, and a pharmacist who does not know an
 * interaction was already considered either calls to ask or assumes it was
 * missed. Both are worse than being told.
 */
export interface TransmittedSafetyCheck {
  allergyStatus: string;
  clear: boolean;
  findings: Array<{ kind: string; severity: string; message: string }>;
  /** Findings the prescriber signed past, and why. */
  overridden: Array<{ kind: string; severity: string; message: string }>;
  overrideReason: string | null;
}

export interface PrescriptionRow {
  tenant_id: string;
  id: string;
  statement_id: string;
  patient_id: string;
  /** The directory organization the prescription is for. Null when handed out. */
  pharmacy_id: string | null;
  status: PrescriptionStatus;
  /** Written for the patient, not for the pharmacy's parser. */
  instructions: string;
  /** 1 when this drug is controlled, so the safeguards applied. */
  controlled: number;
  /** The authorisation a deployment declared to transmit a controlled drug. */
  controlled_authority: string | null;
  prescriber_id: string;
  written_at: string;
  transmitted_at: string | null;
  /** The message this became, so a transmission can be traced to a delivery. */
  message_id: string | null;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  ack_due_by: string | null;
  failure_reason: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  /** The prescription this one replaces after a failure. */
  replaces: string | null;
  /**
   * Whether the pharmacy reported dispenses when this was sent. Null on a
   * prescription that never went to one. Snapshotted deliberately: a
   * declaration made later says nothing about what this silence meant.
   */
  dispense_reporting: number | null;
  /** The safety check as it was shown to the prescriber, as JSON. */
  safety_summary: string | null;
  created_at: string;
}

export interface PrescriptionEvent {
  seq: number;
  prescription_id: string;
  at: string;
  event: string;
  actor_id: string;
  actor_kind: string;
  detail: string | null;
}

export interface Actor {
  actorId: string;
  actorKind: string;
}

/**
 * Publishes a prescription onto a channel.
 *
 * Deliberately the same shape as the break-glass notice dispatcher, and for
 * the same reason: this system holds nothing it could reach a pharmacy with,
 * so the transmission becomes a message and the deployment's destinations
 * carry it to whatever already speaks to pharmacies.
 */
export interface PharmacyDispatcher {
  /** Returns the message id. Throwing means nothing was sent. */
  dispatch(payload: PrescriptionPayload): string;
}

export interface PrescriptionPayload {
  type: "prescription";
  prescriptionId: string;
  patientId: string;
  pharmacyId: string;
  prescriberId: string;
  medication: {
    code: string;
    codeSystem: string | null;
    display: string;
    dose: string | null;
    route: string | null;
    frequency: string | null;
  };
  instructions: string;
  controlled: boolean;
  writtenAt: string;
  /** Set when this replaces a failed transmission, so a pharmacy can tell. */
  replaces: string | null;
  /**
   * What the prescriber's own check saw. Null means no check was recorded
   * with this prescription — which a pharmacy must read as *not checked
   * here*, never as checked and clear.
   */
  safetyCheck: TransmittedSafetyCheck | null;
}

/**
 * Folds a safety check into what a pharmacy is told.
 *
 * Every finding travels, not only the blocking ones: a moderate interaction a
 * prescriber reasonably proceeded through is exactly the thing a pharmacist
 * catches with the piece of history the prescriber did not have. What is left
 * behind is the patient-level detail behind each finding — the pharmacy is
 * being told what was considered, not handed the chart it was considered
 * against.
 */
function summarise(check: SafetyCheck, overrideReason: string | null): TransmittedSafetyCheck {
  const flat = (f: Finding) => ({ kind: f.kind, severity: f.severity, message: f.message });
  return {
    allergyStatus: check.allergyStatus,
    clear: check.clear,
    findings: check.findings.map(flat),
    overridden: check.blocking.map(flat),
    overrideReason,
  };
}

export interface PrescribeOptions {
  dispatcher?: PharmacyDispatcher;
  /**
   * The unified worklist a renewal request becomes an item in. Without one,
   * `requestRenewal()` refuses rather than recording a request into a place
   * nobody looks — which is the fax tray this is meant to replace.
   */
  tasks?: TaskStore;
  /**
   * What authorises this deployment to transmit controlled substances
   * electronically. Unset means it may not, and the refusal says so.
   *
   * Deliberately a string an operator has to write rather than a boolean: the
   * value is the licence or programme the site is operating under, and it ends
   * up on the prescription where an audit can read it.
   */
  controlledSubstanceAuthority?: string;
}

export class Prescribing {
  private db: Db;
  private meds: MedicationStore;
  private directory: Directory;
  private dispatcher: PharmacyDispatcher | null;
  private tasks: TaskStore | null;
  private controlledAuthority: string | null;

  constructor(db: Db, meds: MedicationStore, opts: PrescribeOptions = {}) {
    this.db = db;
    this.meds = meds;
    this.directory = new Directory(db);
    this.dispatcher = opts.dispatcher ?? null;
    this.tasks = opts.tasks ?? null;
    this.controlledAuthority = opts.controlledSubstanceAuthority ?? null;
  }

  /**
   * Writes a prescription against a medication statement already on the chart.
   *
   * Takes a statement rather than a drug, so the prescription and the
   * medication list cannot disagree about what was prescribed. The statement is
   * the clinical decision; this is the errand.
   */
  write(input: {
    statementId: string;
    instructions: string;
    by: Actor;
    controlled?: boolean;
    /**
     * The check `MedicationStore.prescribe()` returned, so it can travel with
     * the script. Omitted means the payload says *no check recorded*, which
     * is not the same as clear and must never be read as it.
     */
    safetyCheck?: SafetyCheck;
    /** Why the prescriber signed past a blocking finding, when they did. */
    overrideReason?: string;
  }): PrescriptionRow {
    if (!input.instructions.trim()) {
      refuse("a prescription needs instructions the patient can follow");
    }
    const statement = this.meds.statement(input.statementId);
    if (!statement) refuse(`no medication statement ${input.statementId}`);
    if (statement.status === "entered-in-error") {
      refuse("that statement was entered in error; it cannot be prescribed");
    }
    if (statement.source !== "prescribed") {
      // A patient-reported drug is not a prescription. Transmitting one would
      // be this system inventing a prescriber's decision.
      refuse(
        `that statement is ${statement.source}, not prescribed; only a prescribed statement can become a prescription`
      );
    }

    // Run the check here when the caller did not bring one. Without this the
    // ordinary path — a route that writes a prescription against an existing
    // statement — would transmit "no check recorded" for every script, which
    // is honest and useless: the pharmacist would learn that the field is
    // always empty and stop reading it.
    //
    // `record()` derives an ingredient from the display when none is given, so
    // this is normally always available. The null branch is for a row that
    // arrived without one — a migration, or a database written before the
    // column — and it stays null rather than becoming a clear check.
    const check =
      input.safetyCheck ??
      (statement.ingredient
        ? this.meds.check(statement.patient_id, { ingredient: statement.ingredient, display: statement.display })
        : null);

    const id = randomUUID();
    const now = new Date().toISOString();
    return this.db.transaction(() => {
      this.db.sql
        .prepare(
          `INSERT INTO prescriptions
             (tenant_id, id, statement_id, patient_id, pharmacy_id, status, instructions,
              controlled, controlled_authority, prescriber_id, written_at, safety_summary, created_at)
           VALUES (?, ?, ?, ?, NULL, 'draft', ?, ?, NULL, ?, ?, ?, ?)`
        )
        .run(
          this.db.tenantId,
          id,
          statement.id,
          statement.patient_id,
          input.instructions.trim(),
          input.controlled ? 1 : 0,
          statement.prescriber_id ?? input.by.actorId,
          now,
          check ? JSON.stringify(summarise(check, input.overrideReason ?? null)) : null,
          now
        );
      this.event(id, "written", input.by, `${statement.display}: ${input.instructions.trim()}`);
      return this.get(id)!;
    });
  }

  /**
   * Sends it to a pharmacy.
   *
   * Refuses a second transmission of the same prescription unless it is
   * explicitly replacing a failed one. A pharmacy that receives a duplicate
   * may dispense a duplicate, and for a controlled drug that is a serious
   * adverse event with no error recorded anywhere.
   */
  transmit(prescriptionId: string, pharmacyId: string, by: Actor): PrescriptionRow {
    const row = this.require(prescriptionId);
    if (row.status !== "draft") {
      refuse(
        `${an(row.status)} prescription cannot be transmitted again; ` +
          `a pharmacy receiving it twice may dispense it twice. Use replaceFailed() if the first attempt failed.`
      );
    }
    // The pharmacy has to exist. A prescription sent to a typo is a
    // prescription nobody receives, and the patient discovers it at the
    // counter.
    this.directory.require("organization", pharmacyId);

    if (row.controlled) {
      if (!this.controlledAuthority) {
        refuse(
          "electronic transmission of a controlled substance is separately regulated and this deployment has " +
            "declared no authority for it; print it instead with handOut()"
        );
      }
    }
    if (!this.dispatcher) {
      refuse(
        "no pharmacy channel is configured, so this prescription cannot be transmitted; " +
          "record it as printed with handOut() rather than leaving it looking sent"
      );
    }

    const statement = this.meds.statement(row.statement_id);
    if (!statement) refuse(`the medication statement behind ${prescriptionId} is gone`);

    const now = new Date().toISOString();
    return this.db.transaction(() => {
      let messageId: string;
      try {
        messageId = this.dispatcher!.dispatch(this.payload(row, statement, pharmacyId));
      } catch (err) {
        // A failed dispatch is recorded as failed, not left as a draft. A
        // draft looks like something nobody has got to yet; this is something
        // that was attempted and did not happen, and somebody has to act.
        const reason = err instanceof Error ? err.message : String(err);
        this.db.sql
          .prepare(
            `UPDATE prescriptions SET status = 'failed', pharmacy_id = ?, failure_reason = ?
              WHERE tenant_id = ? AND id = ?`
          )
          .run(pharmacyId, reason, this.db.tenantId, prescriptionId);
        this.event(prescriptionId, "transmission-failed", by, reason);
        return this.get(prescriptionId)!;
      }

      this.db.sql
        .prepare(
          `UPDATE prescriptions
              SET status = 'transmitted', pharmacy_id = ?, transmitted_at = ?, message_id = ?, ack_due_by = ?,
                  dispense_reporting = ?
            WHERE tenant_id = ? AND id = ?`
        )
        .run(
          pharmacyId,
          now,
          messageId,
          new Date(new Date(now).getTime() + ACK_WINDOW_HOURS * 3_600_000).toISOString(),
          // Taken now, not read later: whether this prescription's silence
          // will mean anything depends on what was true when it was sent.
          this.reportsDispenses(pharmacyId) ? 1 : 0,
          this.db.tenantId,
          prescriptionId
        );
      this.event(prescriptionId, "transmitted", by, `to ${pharmacyId} as message ${messageId}`);
      return this.get(prescriptionId)!;
    });
  }

  /**
   * Records that the patient was given it on paper.
   *
   * Not a failure and not a fallback to be ashamed of — it is how most
   * prescriptions in most places still travel. What it is not is
   * indistinguishable from a prescription that was supposed to be transmitted
   * and was not, which is why it is its own status and why nothing waits on an
   * acknowledgement afterwards.
   */
  handOut(prescriptionId: string, by: Actor & { reason?: string }): PrescriptionRow {
    const row = this.require(prescriptionId);
    if (row.status !== "draft" && row.status !== "failed") {
      refuse(`${an(row.status)} prescription cannot be handed out on paper`);
    }
    const handed = this.db.sql
      .prepare(
        `UPDATE prescriptions SET status = 'handed-out'
          WHERE tenant_id = ? AND id = ? AND status IN ('draft', 'failed')`
      )
      .run(this.db.tenantId, prescriptionId);
    if (handed.changes === 0) {
      refuse(`prescription ${prescriptionId} is no longer a draft or a failed transmission`, 409);
    }
    this.event(prescriptionId, "handed-out", by, by.reason ?? "given to the patient on paper");
    return this.get(prescriptionId)!;
  }

  /** The pharmacy confirmed receipt. */
  acknowledge(prescriptionId: string, by: Actor & { detail?: string }): PrescriptionRow {
    const row = this.require(prescriptionId);
    if (row.status !== "transmitted") {
      refuse(`${an(row.status)} prescription cannot be acknowledged`);
    }
    return this.db.transaction(() => {
      // Acknowledgements arrive on connections carrying other traffic, and two
      // for one prescription is a real shape. Conditional on the transmitted
      // state, so the second is refused rather than overwriting the first.
      const acked = this.db.sql
        .prepare(
          `UPDATE prescriptions SET status = 'acknowledged', acknowledged_at = ?, acknowledged_by = ?
            WHERE tenant_id = ? AND id = ? AND status = 'transmitted'`
        )
        .run(new Date().toISOString(), by.actorId, this.db.tenantId, prescriptionId);
      if (acked.changes === 0) refuse(`prescription ${prescriptionId} is no longer awaiting a pharmacy`, 409);
      this.event(prescriptionId, "acknowledged", by, by.detail ?? null);
      return this.get(prescriptionId)!;
    });
  }

  /** The pharmacy rejected it, or the transmission never arrived. */
  fail(prescriptionId: string, by: Actor & { reason: string }): PrescriptionRow {
    if (!by.reason.trim()) refuse("recording a failed prescription needs a reason");
    const row = this.require(prescriptionId);
    if (row.status !== "transmitted") {
      refuse(`${an(row.status)} prescription is not awaiting a pharmacy`);
    }
    return this.db.transaction(() => {
      const failed = this.db.sql
        .prepare(
          `UPDATE prescriptions SET status = 'failed', failure_reason = ?
            WHERE tenant_id = ? AND id = ? AND status = 'transmitted'`
        )
        .run(by.reason.trim(), this.db.tenantId, prescriptionId);
      // A failure racing an acknowledgement must not overwrite it: the
      // pharmacy holding the script is the fact that matters.
      if (failed.changes === 0) refuse(`prescription ${prescriptionId} is no longer awaiting a pharmacy`, 409);
      this.event(prescriptionId, "failed", by, by.reason.trim());
      return this.get(prescriptionId)!;
    });
  }

  /**
   * Replaces a failed prescription with a fresh one.
   *
   * The safe retry, and the only one. It is a new prescription that names the
   * one it replaces, so a pharmacy receiving both can tell they are the same
   * decision — and so a reviewer can see that a retry happened rather than
   * finding two prescriptions and having to work out whether the patient got
   * two lots of the drug.
   */
  replaceFailed(prescriptionId: string, by: Actor & { reason: string }): PrescriptionRow {
    if (!by.reason.trim()) refuse("replacing a prescription needs a reason");
    const failed = this.require(prescriptionId);
    if (failed.status !== "failed") {
      refuse(`only a failed prescription can be replaced; this one is ${failed.status}`);
    }
    const existing = this.db.sql
      .prepare("SELECT id FROM prescriptions WHERE tenant_id = ? AND replaces = ?")
      .get(this.db.tenantId, prescriptionId) as { id: string } | undefined;
    if (existing) refuse(`that prescription has already been replaced by ${existing.id}`);

    const id = randomUUID();
    const now = new Date().toISOString();
    return this.db.transaction(() => {
      this.db.sql
        .prepare(
          `INSERT INTO prescriptions
             (tenant_id, id, statement_id, patient_id, pharmacy_id, status, instructions,
              controlled, controlled_authority, prescriber_id, written_at, replaces, created_at)
           VALUES (?, ?, ?, ?, NULL, 'draft', ?, ?, NULL, ?, ?, ?, ?)`
        )
        .run(
          this.db.tenantId,
          id,
          failed.statement_id,
          failed.patient_id,
          failed.instructions,
          failed.controlled,
          failed.prescriber_id,
          now,
          prescriptionId,
          now
        );
      this.event(id, "written", by, `replaces ${prescriptionId}: ${by.reason.trim()}`);
      this.event(prescriptionId, "replaced", by, `by ${id}: ${by.reason.trim()}`);
      return this.get(id)!;
    });
  }

  /**
   * Withdraws a prescription.
   *
   * A transmitted one leaves `cancellationsOwed()` set until somebody confirms
   * the pharmacy was told, because a cancellation the pharmacy never received
   * is a prescription still standing at the counter — and the patient may
   * collect a drug their clinician has stopped.
   */
  cancel(prescriptionId: string, by: Actor & { reason: string }): PrescriptionRow {
    if (!by.reason.trim()) refuse("cancelling a prescription needs a reason");
    const row = this.require(prescriptionId);
    if (row.status === "cancelled") refuse("that prescription is already cancelled");
    const cancelled = this.db.sql
      .prepare(
        `UPDATE prescriptions SET status = 'cancelled', cancelled_at = ?, cancel_reason = ?
          WHERE tenant_id = ? AND id = ? AND status != 'cancelled'`
      )
      .run(new Date().toISOString(), by.reason.trim(), this.db.tenantId, prescriptionId);
    if (cancelled.changes === 0) refuse(`prescription ${prescriptionId} was cancelled while this was being applied`, 409);
    this.event(prescriptionId, "cancelled", by, by.reason.trim());
    return this.get(prescriptionId)!;
  }

  /** Somebody confirmed the pharmacy knows a transmitted prescription is withdrawn. */
  confirmCancellation(prescriptionId: string, by: Actor & { detail: string }): PrescriptionRow {
    if (!by.detail.trim()) refuse("confirming a cancellation needs to say how the pharmacy was told");
    const row = this.require(prescriptionId);
    if (row.status !== "cancelled") refuse("that prescription is not cancelled");
    this.event(prescriptionId, "cancellation-confirmed", by, by.detail.trim());
    return row;
  }

  get(id: string): PrescriptionRow | undefined {
    return this.db.sql
      .prepare("SELECT * FROM prescriptions WHERE tenant_id = ? AND id = ?")
      .get(this.db.tenantId, id) as unknown as PrescriptionRow | undefined;
  }

  history(id: string): PrescriptionEvent[] {
    return this.db.sql
      .prepare(
        `SELECT seq, prescription_id, at, event, actor_id, actor_kind, detail
           FROM prescription_events WHERE tenant_id = ? AND prescription_id = ? ORDER BY seq`
      )
      .all(this.db.tenantId, id) as unknown as PrescriptionEvent[];
  }

  forPatient(patientId: string): PrescriptionRow[] {
    return this.db.sql
      .prepare("SELECT * FROM prescriptions WHERE tenant_id = ? AND patient_id = ? ORDER BY written_at DESC")
      .all(this.db.tenantId, patientId) as unknown as PrescriptionRow[];
  }

  /**
   * Prescriptions written and never sent anywhere.
   *
   * The queue that makes "not transmitted is a state" mean something. A draft
   * is fine for a minute and wrong after an hour: the patient has left, and
   * they are going to a pharmacy that has nothing waiting for them.
   */
  neverSent(asOf = new Date().toISOString()): PrescriptionRow[] {
    return this.db.sql
      .prepare(
        `SELECT * FROM prescriptions
          WHERE tenant_id = ? AND status = 'draft' AND written_at < ?
          ORDER BY written_at`
      )
      .all(this.db.tenantId, asOf) as unknown as PrescriptionRow[];
  }

  /**
   * Transmitted, and the pharmacy has not said it arrived.
   *
   * "We sent it" is not "they got it", and the gap between them is where a
   * patient stands at a counter while a prescription sits in a dead-letter
   * queue.
   */
  awaitingAcknowledgement(asOf = new Date().toISOString()): PrescriptionRow[] {
    return this.db.sql
      .prepare(
        `SELECT * FROM prescriptions
          WHERE tenant_id = ? AND status = 'transmitted' AND ack_due_by IS NOT NULL AND ack_due_by < ?
          ORDER BY transmitted_at`
      )
      .all(this.db.tenantId, asOf) as unknown as PrescriptionRow[];
  }

  /** Failed transmissions nobody has retried or printed. */
  failed(): PrescriptionRow[] {
    return this.db.sql
      .prepare(
        `SELECT p.* FROM prescriptions p
          WHERE p.tenant_id = ? AND p.status = 'failed'
            AND NOT EXISTS (
              SELECT 1 FROM prescriptions r WHERE r.tenant_id = p.tenant_id AND r.replaces = p.id
            )
          ORDER BY p.written_at`
      )
      .all(this.db.tenantId) as unknown as PrescriptionRow[];
  }

  /**
   * Cancelled after transmission, with nobody having confirmed the pharmacy
   * was told.
   *
   * The most dangerous list here. The chart says stopped, the pharmacy's
   * screen says dispense, and the patient is the one who finds out.
   */
  cancellationsOwed(): PrescriptionRow[] {
    return this.db.sql
      .prepare(
        `SELECT p.* FROM prescriptions p
          WHERE p.tenant_id = ? AND p.status = 'cancelled' AND p.transmitted_at IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM prescription_events e
               WHERE e.tenant_id = p.tenant_id AND e.prescription_id = p.id
                 AND e.event = 'cancellation-confirmed'
            )
          ORDER BY p.cancelled_at`
      )
      .all(this.db.tenantId) as unknown as PrescriptionRow[];
  }

  // ---- what the pharmacy did with it ------------------------------------

  /**
   * Declares whether a pharmacy tells us what it dispensed.
   *
   * This is what makes an absent dispense mean anything. Without it, a
   * prescription with no dispense against it is `unknown`, and it stays
   * unknown however long it sits there.
   */
  declareDispenseReporting(pharmacyId: string, reports: boolean, by: Actor): void {
    this.directory.require("organization", pharmacyId);
    this.db.sql
      .prepare(
        `INSERT INTO pharmacy_dispense_reporting (tenant_id, pharmacy_id, reports, declared_at, declared_by)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(tenant_id, pharmacy_id) DO UPDATE SET
           reports = excluded.reports, declared_at = excluded.declared_at, declared_by = excluded.declared_by`
      )
      .run(this.db.tenantId, pharmacyId, reports ? 1 : 0, new Date().toISOString(), by.actorId);
  }

  /** Whether this pharmacy is declared to report dispenses. */
  reportsDispenses(pharmacyId: string): boolean {
    const row = this.db.sql
      .prepare("SELECT reports FROM pharmacy_dispense_reporting WHERE tenant_id = ? AND pharmacy_id = ?")
      .get(this.db.tenantId, pharmacyId) as { reports: number } | undefined;
    return row?.reports === 1;
  }

  /**
   * Records what the pharmacy did with a prescription.
   *
   * Deliberately permitted against a **cancelled** prescription, and loud
   * when it happens. A cancellation that never reached the pharmacy, or
   * reached it too late, ends exactly here — with a drug dispensed that
   * somebody decided to stop. Refusing to record it would delete the only
   * evidence of the hazard this system tracks cancellations for; the
   * dispense is kept, and the prescription is left owing a phone call.
   */
  recordDispense(
    prescriptionId: string,
    input: {
      outcome: DispenseOutcome;
      dispensedAt: string;
      by: Actor;
      quantity?: string;
      daysSupply?: number;
      sourceMessageId?: string;
      detail?: string;
    }
  ): { dispense: DispenseRow; afterCancellation: boolean } {
    const row = this.require(prescriptionId);
    if (row.status === "draft") {
      // Nothing left the building, so nothing can have been dispensed. This
      // is a mis-keyed prescription id, and guessing which one was meant is
      // how a dispense lands on the wrong patient.
      refuse("a draft prescription has not gone anywhere, so it cannot have been dispensed");
    }
    const at = new Date(input.dispensedAt).getTime();
    if (!Number.isFinite(at)) {
      refuse(`${input.dispensedAt} is not a time this dispense could have happened at`);
    }
    // A pharmacy's clock can be a little ahead of ours; a year cannot. A
    // mistyped year would sort last and make an uncollected prescription read
    // as dispensed, which is the exact misreading this whole module exists to
    // stop — so the tolerance is a day and everything past it is refused.
    if (at > Date.now() + CLOCK_SKEW_HOURS * 3_600_000) {
      refuse(`${input.dispensedAt} is in the future; a dispense cannot have happened yet`);
    }
    if (input.daysSupply !== undefined && (!Number.isInteger(input.daysSupply) || input.daysSupply < 0)) {
      refuse("a days supply is a whole number of days, or absent");
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    const afterCancellation = row.status === "cancelled";
    const dispense = this.db.transaction(() => {
      this.db.sql
        .prepare(
          `INSERT INTO prescription_dispenses
             (tenant_id, id, prescription_id, patient_id, outcome, dispensed_at, quantity, days_supply,
              reported_at, reported_by, source_message_id, detail)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          this.db.tenantId,
          id,
          prescriptionId,
          row.patient_id,
          input.outcome,
          input.dispensedAt,
          input.quantity ?? null,
          input.daysSupply ?? null,
          now,
          input.by.actorId,
          input.sourceMessageId ?? null,
          input.detail ?? null
        );
      this.event(
        prescriptionId,
        afterCancellation ? "dispensed-after-cancellation" : `dispense-${input.outcome}`,
        input.by,
        afterCancellation
          ? `${input.outcome} at ${input.dispensedAt} despite cancellation — the pharmacy acted on a stopped prescription`
          : `${input.outcome} at ${input.dispensedAt}${input.quantity ? `, ${input.quantity}` : ""}`
      );
      return this.dispense(id)!;
    });
    return { dispense, afterCancellation };
  }

  /** One dispense record. */
  dispense(id: string): DispenseRow | undefined {
    return this.db.sql
      .prepare("SELECT * FROM prescription_dispenses WHERE tenant_id = ? AND id = ?")
      .get(this.db.tenantId, id) as unknown as DispenseRow | undefined;
  }

  /** Every dispense against a prescription, oldest first. */
  dispenses(prescriptionId: string): DispenseRow[] {
    return this.db.sql
      .prepare(
        `SELECT * FROM prescription_dispenses
          WHERE tenant_id = ? AND prescription_id = ? ORDER BY dispensed_at, reported_at`
      )
      .all(this.db.tenantId, prescriptionId) as unknown as DispenseRow[];
  }

  /**
   * Whether this prescription reached the patient, as far as anyone can tell.
   *
   * The whole point of this method is the `unknown` branch. A chart that
   * renders "not collected" for a pharmacy that never reports anything is
   * making an accusation out of a silence, and a clinician who learns to
   * ignore it has lost the signal for the pharmacies that do report.
   */
  dispenseState(prescriptionId: string): DispenseState {
    const row = this.require(prescriptionId);
    const records = this.dispenses(prescriptionId);
    const last = records[records.length - 1];
    if (last) {
      const detail =
        row.status === "cancelled"
          ? `${last.outcome} at ${last.dispensed_at}, after this prescription was cancelled`
          : `${last.outcome} at ${last.dispensed_at}`;
      if (last.outcome === "dispensed") return { state: "dispensed", at: last.dispensed_at, detail };
      if (last.outcome === "partially-dispensed") {
        return { state: "partially-dispensed", at: last.dispensed_at, detail };
      }
      return { state: "not-collected", at: last.dispensed_at, detail };
    }
    if (row.status === "draft") {
      return { state: "not-applicable", detail: "not sent anywhere yet" };
    }
    if (row.status === "handed-out") {
      // Paper. The pharmacy that fills it is whichever one the patient walks
      // into, and it has no way to tell us and nothing to tell us about.
      return { state: "not-applicable", detail: "given to the patient on paper; no pharmacy is reporting on it" };
    }
    if (row.status === "failed") {
      return { state: "not-applicable", detail: "the transmission failed; nothing reached a pharmacy" };
    }
    if (row.dispense_reporting === 1) {
      return {
        state: "awaiting",
        detail: "sent to a pharmacy that reports dispenses, and none has been reported yet",
      };
    }
    return {
      state: "unknown",
      detail:
        "this pharmacy does not report dispenses, so whether the patient collected it is not something this system knows",
    };
  }

  /**
   * Prescriptions a patient looks likely not to have collected.
   *
   * Confined to pharmacies that report dispenses, because everywhere else the
   * absence of a record is not evidence. That confinement is the reason this
   * list is worth reading: everything on it is a real silence from somewhere
   * that would have spoken.
   */
  neverCollected(withinDays = 14, asOf = new Date().toISOString()): PrescriptionRow[] {
    const cutoff = new Date(new Date(asOf).getTime() - withinDays * 86_400_000).toISOString();
    return this.db.sql
      .prepare(
        `SELECT p.* FROM prescriptions p
          WHERE p.tenant_id = ?
            AND p.status IN ('transmitted', 'acknowledged')
            AND p.dispense_reporting = 1
            AND p.transmitted_at IS NOT NULL
            AND p.transmitted_at <= ?
            AND NOT EXISTS (
              SELECT 1 FROM prescription_dispenses d
               WHERE d.tenant_id = p.tenant_id AND d.prescription_id = p.id
            )
          ORDER BY p.transmitted_at`
      )
      .all(this.db.tenantId, cutoff) as unknown as PrescriptionRow[];
  }

  /** Dispenses recorded against a prescription that had been cancelled. */
  dispensedAfterCancellation(): Array<{ prescription: PrescriptionRow; dispense: DispenseRow }> {
    const rows = this.db.sql
      .prepare(
        `SELECT d.* FROM prescription_dispenses d
           JOIN prescriptions p ON p.tenant_id = d.tenant_id AND p.id = d.prescription_id
          WHERE d.tenant_id = ? AND p.status = 'cancelled' AND d.outcome != 'not-collected'
          ORDER BY d.dispensed_at`
      )
      .all(this.db.tenantId) as unknown as DispenseRow[];
    return rows.map((d) => ({ prescription: this.require(d.prescription_id), dispense: d }));
  }

  // ---- renewal ----------------------------------------------------------

  /**
   * A pharmacy asks for a repeat, and it becomes work somebody owns.
   *
   * Not a status on the prescription, because a renewal is a new prescribing
   * decision and the old prescription is not what is waiting — a person is.
   * The task cannot be completed without evidence of what was decided, which
   * is what stops "renewed" from meaning "the request stopped being visible".
   */
  requestRenewal(input: {
    prescriptionId: string;
    by: Actor;
    requestedBy?: string;
    note?: string;
    priority?: "routine" | "urgent" | "stat";
    sourceMessageId?: string;
  }): TaskRow {
    if (!this.tasks) {
      refuse("no worklist is wired in, so a renewal request has nowhere to go that anybody would see");
    }
    const row = this.require(input.prescriptionId);
    const statement = this.meds.statement(row.statement_id);
    const drug = statement?.display ?? "a medication";
    if (row.status === "draft") {
      refuse("that prescription has not gone to a pharmacy, so no pharmacy can be asking to renew it");
    }

    const task = this.tasks.create({
      kind: "prescription-renewal",
      title: `Renewal requested: ${drug}`,
      by: input.by,
      patientId: row.patient_id,
      priority: input.priority ?? "routine",
      source: input.requestedBy ? `pharmacy ${input.requestedBy}` : "pharmacy",
      sourceMessageId: input.sourceMessageId,
      // The prescription id ties every renewal of one script together, so the
      // third request in six weeks is visible as a pattern rather than as
      // three unrelated items.
      correlationId: input.prescriptionId,
    });
    this.event(
      input.prescriptionId,
      "renewal-requested",
      input.by,
      `${input.requestedBy ? `${input.requestedBy} ` : ""}asked for a repeat${input.note ? `: ${input.note}` : ""}`
    );
    return task;
  }

  /** Open renewal requests raised against one prescription. */
  renewalsFor(prescriptionId: string): TaskRow[] {
    if (!this.tasks) return [];
    return this.tasks.correlated(prescriptionId).filter((t) => t.kind === "prescription-renewal");
  }

  private payload(row: PrescriptionRow, statement: MedRow, pharmacyId: string): PrescriptionPayload {
    return {
      type: "prescription",
      prescriptionId: row.id,
      patientId: row.patient_id,
      pharmacyId,
      prescriberId: row.prescriber_id,
      medication: {
        code: statement.code,
        codeSystem: statement.code_system,
        display: statement.display,
        dose: statement.dose,
        route: statement.route,
        frequency: statement.frequency,
      },
      instructions: row.instructions,
      controlled: row.controlled === 1,
      writtenAt: row.written_at,
      replaces: row.replaces,
      // Null rather than a manufactured all-clear. A pharmacy reading this
      // has to be able to tell "checked, and here is what it found" from
      // "no check came with this", and only one of those is safe to assume.
      safetyCheck: row.safety_summary ? (JSON.parse(row.safety_summary) as TransmittedSafetyCheck) : null,
    };
  }

  private event(prescriptionId: string, event: string, by: Actor, detail: string | null): void {
    this.db.sql
      .prepare(
        `INSERT INTO prescription_events
           (tenant_id, prescription_id, at, event, actor_id, actor_kind, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(this.db.tenantId, prescriptionId, new Date().toISOString(), event, by.actorId, by.actorKind, detail);
  }

  private require(id: string): PrescriptionRow {
    const row = this.get(id);
    if (!row) refuse(`no prescription ${id}`);
    return row;
  }
}

/**
 * Publishes prescriptions onto a channel, which must exist.
 *
 * Checked per dispatch rather than cached, for the reason the break-glass
 * dispatcher checks: a channel can be removed while the engine runs, and a
 * prescription published to one that no longer exists would sit in
 * `deliveries` with no destination — counted as sent and delivered nowhere.
 */
export class ChannelPharmacyDispatcher implements PharmacyDispatcher {
  private db: Db;
  private channelId: string;

  constructor(db: Db, channelId: string) {
    this.db = db;
    this.channelId = channelId;
  }

  dispatch(payload: PrescriptionPayload): string {
    if (!this.db.getChannel(this.channelId)) {
      throw new Error(`no channel '${this.channelId}' to transmit the prescription to`);
    }
    const message = this.db.insertMessage(
      this.channelId,
      "prescription",
      "application/json",
      JSON.stringify(payload),
      { prescriptionId: payload.prescriptionId, pharmacyId: payload.pharmacyId }
    );
    return message.id;
  }
}
