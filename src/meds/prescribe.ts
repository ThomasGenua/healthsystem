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
 * Portage does not know how to talk to a pharmacy network and should not
 * pretend to. A transmission is published onto a channel the deployment
 * configures, and the delivery machinery carries it — ordered, retried,
 * dead-lettered — exactly like every other clinical message. What comes back
 * is an acknowledgement somebody or something records. Until then the
 * prescription is *outstanding*, and `awaitingAcknowledgement()` is the list
 * that stops "we sent it" from being the end of the story.
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
import type { MedicationStore, MedRow } from "./store.ts";

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
}

export interface PrescribeOptions {
  dispatcher?: PharmacyDispatcher;
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
  private controlledAuthority: string | null;

  constructor(db: Db, meds: MedicationStore, opts: PrescribeOptions = {}) {
    this.db = db;
    this.meds = meds;
    this.directory = new Directory(db);
    this.dispatcher = opts.dispatcher ?? null;
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

    const id = randomUUID();
    const now = new Date().toISOString();
    return this.db.transaction(() => {
      this.db.sql
        .prepare(
          `INSERT INTO prescriptions
             (tenant_id, id, statement_id, patient_id, pharmacy_id, status, instructions,
              controlled, controlled_authority, prescriber_id, written_at, created_at)
           VALUES (?, ?, ?, ?, NULL, 'draft', ?, ?, NULL, ?, ?, ?)`
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
              SET status = 'transmitted', pharmacy_id = ?, transmitted_at = ?, message_id = ?, ack_due_by = ?
            WHERE tenant_id = ? AND id = ?`
        )
        .run(
          pharmacyId,
          now,
          messageId,
          new Date(new Date(now).getTime() + ACK_WINDOW_HOURS * 3_600_000).toISOString(),
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
    this.db.sql
      .prepare("UPDATE prescriptions SET status = 'handed-out' WHERE tenant_id = ? AND id = ?")
      .run(this.db.tenantId, prescriptionId);
    this.event(prescriptionId, "handed-out", by, by.reason ?? "given to the patient on paper");
    return this.get(prescriptionId)!;
  }

  /** The pharmacy confirmed receipt. */
  acknowledge(prescriptionId: string, by: Actor & { detail?: string }): PrescriptionRow {
    const row = this.require(prescriptionId);
    if (row.status !== "transmitted") {
      refuse(`${an(row.status)} prescription cannot be acknowledged`);
    }
    this.db.sql
      .prepare(
        `UPDATE prescriptions SET status = 'acknowledged', acknowledged_at = ?, acknowledged_by = ?
          WHERE tenant_id = ? AND id = ?`
      )
      .run(new Date().toISOString(), by.actorId, this.db.tenantId, prescriptionId);
    this.event(prescriptionId, "acknowledged", by, by.detail ?? null);
    return this.get(prescriptionId)!;
  }

  /** The pharmacy rejected it, or the transmission never arrived. */
  fail(prescriptionId: string, by: Actor & { reason: string }): PrescriptionRow {
    if (!by.reason.trim()) refuse("recording a failed prescription needs a reason");
    const row = this.require(prescriptionId);
    if (row.status !== "transmitted") {
      refuse(`${an(row.status)} prescription is not awaiting a pharmacy`);
    }
    this.db.sql
      .prepare("UPDATE prescriptions SET status = 'failed', failure_reason = ? WHERE tenant_id = ? AND id = ?")
      .run(by.reason.trim(), this.db.tenantId, prescriptionId);
    this.event(prescriptionId, "failed", by, by.reason.trim());
    return this.get(prescriptionId)!;
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
    this.db.sql
      .prepare(
        `UPDATE prescriptions SET status = 'cancelled', cancelled_at = ?, cancel_reason = ?
          WHERE tenant_id = ? AND id = ?`
      )
      .run(new Date().toISOString(), by.reason.trim(), this.db.tenantId, prescriptionId);
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
