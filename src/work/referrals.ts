/**
 * Referrals, as a loop rather than a message.
 *
 * Section 9 asks for closed-loop completion reporting, and the failure it
 * guards against is silence. A referral sent to a service that never
 * acknowledged it looks exactly like one proceeding normally. So does one
 * accepted eight months ago and never reported back. Nobody did anything
 * wrong, no error was raised, and the patient was not seen — which is how
 * referral loops actually fail, and why "we sent it" is not a defence.
 *
 * So the design is not a state machine with a send button on it. It is an
 * expectation of when the next thing should happen, carried on the referral
 * and reset at every transition, and a query that returns everything past its
 * expectation. `stalled()` is the point of this module; the rest is
 * bookkeeping that makes it meaningful.
 *
 * Two further refusals, both for the same reason as the inbox's:
 *
 *   Sending requires the documents the receiving service said it needs. A
 *   referral triaged as incomplete is one that goes round again with the
 *   patient waiting through both circuits.
 *
 *   Closing requires an outcome. A referral closed with nothing recorded is
 *   indistinguishable, afterwards, from one abandoned.
 */
import { randomUUID } from "node:crypto";
import { an } from "../core/text.ts";
import type { Db } from "../db.ts";
import { Directory } from "../directory/store.ts";

export type ReferralStatus =
  | "draft"
  | "sent"
  | "acknowledged"
  | "accepted"
  | "declined"
  | "booked"
  | "seen"
  | "reported"
  | "closed"
  | "cancelled";

export type ReferralPriority = "routine" | "urgent" | "emergent";

/** Nothing further is owed on these. Everything else is still in flight. */
const TERMINAL: ReferralStatus[] = ["closed", "declined", "cancelled"];

export interface ReferralRow {
  tenant_id: string;
  id: string;
  patient_id: string;
  status: ReferralStatus;
  priority: ReferralPriority;
  from_service: string;
  to_service: string;
  to_service_id: string | null;
  /** 1 = declared external, 0 = a directory service, NULL = nobody said. */
  to_external: number | null;
  indication: string;
  required_documents: string | null;
  attached_documents: string | null;
  expected_by: string | null;
  appointment_at: string | null;
  outcome: string | null;
  correlation_id: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export interface ReferralEvent {
  seq: number;
  referral_id: string;
  at: string;
  event: string;
  actor_id: string;
  actor_kind: string;
  from_status: string | null;
  to_status: string | null;
  detail: string | null;
}

export interface Actor {
  actorId: string;
  actorKind: string;
}

function list(json: string | null): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/**
 * What a referral is addressed to, three-valued on purpose.
 *
 * `known` is a service in the directory. `external` is a deliberate referral
 * out to somewhere Northstar does not hold — ordinary, and stated rather than
 * inferred. `unverified` is free text nobody checked, which is the state every
 * referral written before the directory existed is in.
 *
 * Keeping the third apart from the second is the whole point. Collapsing them
 * would make a typo indistinguishable from a southern hospital, which is how a
 * referral goes nowhere while looking as though it went somewhere.
 */
export type ReferralTarget =
  | { kind: "known"; serviceId: string; display: string; active: boolean }
  | { kind: "external"; display: string }
  | { kind: "unverified"; display: string };

export class ReferralStore {
  private db: Db;
  private directory: Directory;

  constructor(db: Db) {
    this.db = db;
    this.directory = new Directory(db);
  }

  /** Who this referral is actually addressed to. See `ReferralTarget`. */
  target(referral: ReferralRow): ReferralTarget {
    if (referral.to_service_id) {
      const r = this.directory.resolve("service", referral.to_service_id);
      return r.known
        ? { kind: "known", serviceId: r.id, display: r.display, active: r.active }
        : // The service was validated when the referral was written, so this
          // means the row was removed rather than retired. Reported as
          // unverified rather than invented, because the honest answer is that
          // the directory no longer backs this reference.
          { kind: "unverified", display: referral.to_service };
    }
    if (referral.to_external === 1) return { kind: "external", display: referral.to_service };
    return { kind: "unverified", display: referral.to_service };
  }

  /** Starts a referral. A draft is not yet owed anything by anyone. */
  create(input: {
    patientId: string;
    fromService: string;
    toService: string;
    indication: string;
    by: Actor;
    priority?: ReferralPriority;
    requiredDocuments?: string[];
    correlationId?: string;
    /**
     * The directory service this is addressed to, validated on the way in.
     *
     * Mutually exclusive with `external`. Passing neither is still accepted
     * and means nobody said which — see `target()`.
     */
    toServiceId?: string;
    /**
     * Declares that this goes somewhere Northstar does not hold.
     *
     * A referral out to a southern hospital is ordinary and must not be
     * refused for being unknown. What it must not be is *indistinguishable*
     * from a typo, so it is stated rather than inferred from the target not
     * resolving.
     */
    external?: boolean;
  }): ReferralRow {
    if (input.toServiceId && input.external) {
      throw new Error("a referral is either to a service in the directory or explicitly external, not both");
    }
    if (input.toServiceId) this.directory.require("service", input.toServiceId);
    if (!input.indication.trim()) {
      // A receiving service triages on the indication. Without one the
      // referral cannot be prioritised, so it waits at routine regardless of
      // why it was actually sent.
      throw new Error("a referral needs a clinical indication, or it cannot be triaged");
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    return this.db.transaction(() => {
      this.db.sql
        .prepare(
          `INSERT INTO referrals
             (tenant_id, id, patient_id, status, priority, from_service, to_service, to_service_id,
              to_external, indication, required_documents, correlation_id, created_at, updated_at)
           VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          this.db.tenantId,
          id,
          input.patientId,
          input.priority ?? "routine",
          input.fromService,
          input.toService,
          input.toServiceId ?? null,
          input.external ? 1 : input.toServiceId ? 0 : null,
          input.indication,
          JSON.stringify(input.requiredDocuments ?? []),
          input.correlationId ?? `ref-${id}`,
          now,
          now
        );
      this.event(id, "created", input.by, { toStatus: "draft", detail: input.indication });
      return this.get(id)!;
    });
  }

  attach(referralId: string, document: string, by: Actor): ReferralRow {
    const r = this.require(referralId);
    const attached = [...new Set([...list(r.attached_documents), document])];
    return this.db.transaction(() => {
      this.db.sql
        .prepare("UPDATE referrals SET attached_documents = ?, updated_at = ? WHERE tenant_id = ? AND id = ?")
        .run(JSON.stringify(attached), new Date().toISOString(), this.db.tenantId, referralId);
      this.event(referralId, "document-attached", by, { detail: document });
      return this.get(referralId)!;
    });
  }

  /**
   * Sends it, and starts the clock.
   *
   * `respondBy` is what makes the loop closable. Without an expectation there
   * is no such thing as late, and without late there is no stalled list — a
   * referral simply sits, indefinitely, looking exactly like one in progress.
   */
  send(referralId: string, by: Actor & { respondBy: string }): ReferralRow {
    const r = this.require(referralId);
    if (r.status !== "draft") throw new Error(`${an(r.status)} referral cannot be sent again`);

    const missing = list(r.required_documents).filter((d) => !list(r.attached_documents).includes(d));
    if (missing.length) {
      // Refused rather than sent and rejected later. A referral triaged as
      // incomplete goes round again with the patient waiting through both
      // circuits, which is the wait nobody counts.
      throw new Error(`missing required document(s): ${missing.join(", ")}`);
    }
    return this.transition(referralId, "sent", by, { expectedBy: by.respondBy });
  }

  /** The receiving service confirms it arrived. */
  acknowledge(referralId: string, by: Actor & { triageBy: string }): ReferralRow {
    const r = this.require(referralId);
    if (r.status !== "sent") throw new Error(`only a sent referral can be acknowledged, not ${an(r.status)} one`);
    return this.transition(referralId, "acknowledged", by, { expectedBy: by.triageBy });
  }

  /**
   * The triage decision.
   *
   * Accepting sets the wait for an appointment; declining is terminal and
   * requires a reason, because a declined referral the sender never sees the
   * reason for is one they will send again.
   */
  triage(
    referralId: string,
    decision: { accept: true; bookBy: string; priority?: ReferralPriority } | { accept: false; reason: string },
    by: Actor
  ): ReferralRow {
    const r = this.require(referralId);
    if (r.status !== "sent" && r.status !== "acknowledged") {
      throw new Error(`${an(r.status)} referral is past triage`);
    }
    if (!decision.accept) {
      if (!decision.reason.trim()) throw new Error("declining a referral needs a reason the sender can act on");
      return this.transition(referralId, "declined", by, { detail: decision.reason, closing: true });
    }
    return this.db.transaction(() => {
      if (decision.priority) {
        this.db.sql
          .prepare("UPDATE referrals SET priority = ? WHERE tenant_id = ? AND id = ?")
          .run(decision.priority, this.db.tenantId, referralId);
      }
      return this.transition(referralId, "accepted", by, { expectedBy: decision.bookBy });
    });
  }

  /** An appointment exists. The expectation becomes the appointment itself. */
  book(referralId: string, appointmentAt: string, by: Actor): ReferralRow {
    const r = this.require(referralId);
    if (r.status !== "accepted") throw new Error(`${an(r.status)} referral cannot be booked`);
    return this.db.transaction(() => {
      this.db.sql
        .prepare("UPDATE referrals SET appointment_at = ? WHERE tenant_id = ? AND id = ?")
        .run(appointmentAt, this.db.tenantId, referralId);
      return this.transition(referralId, "booked", by, { expectedBy: appointmentAt, detail: appointmentAt });
    });
  }

  /** The patient attended. A report is now owed. */
  seen(referralId: string, by: Actor & { reportBy: string }): ReferralRow {
    const r = this.require(referralId);
    if (r.status !== "booked") throw new Error(`${an(r.status)} referral cannot be marked seen`);
    return this.transition(referralId, "seen", by, { expectedBy: by.reportBy });
  }

  /** The consultation report came back. */
  report(referralId: string, by: Actor & { reference: string }): ReferralRow {
    const r = this.require(referralId);
    if (TERMINAL.includes(r.status)) throw new Error(`${an(r.status)} referral cannot receive a report`);
    return this.transition(referralId, "reported", by, { detail: by.reference });
  }

  /**
   * Closes the loop.
   *
   * An outcome is required for the same reason the inbox requires evidence: a
   * referral closed with nothing recorded is indistinguishable afterwards from
   * one abandoned, and the difference is the whole question.
   */
  close(referralId: string, by: Actor & { outcome: string }): ReferralRow {
    if (!by.outcome.trim()) throw new Error("closing a referral needs an outcome");
    const r = this.require(referralId);
    if (TERMINAL.includes(r.status)) throw new Error(`this referral is already ${r.status}`);
    return this.db.transaction(() => {
      this.db.sql
        .prepare("UPDATE referrals SET outcome = ? WHERE tenant_id = ? AND id = ?")
        .run(by.outcome, this.db.tenantId, referralId);
      return this.transition(referralId, "closed", by, { detail: by.outcome, closing: true });
    });
  }

  cancel(referralId: string, by: Actor & { reason: string }): ReferralRow {
    if (!by.reason.trim()) throw new Error("cancelling a referral needs a reason");
    const r = this.require(referralId);
    if (TERMINAL.includes(r.status)) throw new Error(`this referral is already ${r.status}`);
    return this.transition(referralId, "cancelled", by, { detail: by.reason, closing: true });
  }

  /**
   * Sends it somewhere else, keeping the loop.
   *
   * A new referral with the same correlation id rather than a fresh one, so
   * the time the patient has already waited stays attached to the question
   * being asked. Redirecting by cancelling and starting again resets the clock
   * and loses exactly the history that shows how long this has taken.
   */
  redirect(referralId: string, toService: string, by: Actor & { reason: string; respondBy: string }): ReferralRow {
    if (!by.reason.trim()) throw new Error("redirecting a referral needs a reason");
    const original = this.require(referralId);
    if (TERMINAL.includes(original.status)) throw new Error(`${an(original.status)} referral cannot be redirected`);

    return this.db.transaction(() => {
      this.transition(referralId, "closed", by, { detail: `redirected to ${toService}: ${by.reason}`, closing: true });
      this.db.sql
        .prepare("UPDATE referrals SET outcome = ? WHERE tenant_id = ? AND id = ?")
        .run(`redirected to ${toService}`, this.db.tenantId, referralId);

      const next = this.create({
        patientId: original.patient_id,
        fromService: original.from_service,
        toService,
        indication: original.indication,
        by,
        priority: original.priority,
        requiredDocuments: list(original.required_documents),
        correlationId: original.correlation_id,
      });
      // Documents already gathered travel with it: making a clinic re-attach
      // the same imaging is how a redirect adds a week.
      for (const doc of list(original.attached_documents)) this.attach(next.id, doc, by);
      return this.send(next.id, { ...by, respondBy: by.respondBy });
    });
  }

  /**
   * Referrals past the point where something should have happened.
   *
   * The load-bearing query. Everything else here exists so that this one
   * returns the right rows: a referral nobody acknowledged, a triage that
   * never came, an appointment that passed with no report. Ordered by how
   * long they have been waiting, because that is the order they should be
   * chased in.
   */
  stalled(asOf = new Date().toISOString()): ReferralRow[] {
    const rows = this.db.sql
      .prepare(
        `SELECT * FROM referrals
          WHERE tenant_id = ? AND status NOT IN ('closed', 'declined', 'cancelled')
            AND expected_by IS NOT NULL AND expected_by < ?`
      )
      .all(this.db.tenantId, asOf) as unknown as ReferralRow[];
    return rows.sort((a, b) => (a.expected_by ?? "").localeCompare(b.expected_by ?? ""));
  }

  /** Everything still in flight, whether or not it is late yet. */
  open(): ReferralRow[] {
    return this.db.sql
      .prepare(
        `SELECT * FROM referrals WHERE tenant_id = ? AND status NOT IN ('closed', 'declined', 'cancelled')
          ORDER BY created_at`
      )
      .all(this.db.tenantId) as unknown as ReferralRow[];
  }

  get(referralId: string): ReferralRow | undefined {
    return this.db.sql
      .prepare("SELECT * FROM referrals WHERE tenant_id = ? AND id = ?")
      .get(this.db.tenantId, referralId) as unknown as ReferralRow | undefined;
  }

  forPatient(patientId: string): ReferralRow[] {
    return this.db.sql
      .prepare("SELECT * FROM referrals WHERE tenant_id = ? AND patient_id = ? ORDER BY created_at DESC")
      .all(this.db.tenantId, patientId) as unknown as ReferralRow[];
  }

  /** Every referral in one loop, including the ones it was redirected to. */
  loop(correlationId: string): ReferralRow[] {
    return this.db.sql
      .prepare("SELECT * FROM referrals WHERE tenant_id = ? AND correlation_id = ? ORDER BY created_at")
      .all(this.db.tenantId, correlationId) as unknown as ReferralRow[];
  }

  history(referralId: string): ReferralEvent[] {
    return this.db.sql
      .prepare("SELECT * FROM referral_events WHERE tenant_id = ? AND referral_id = ? ORDER BY seq")
      .all(this.db.tenantId, referralId) as unknown as ReferralEvent[];
  }

  /**
   * How long a loop has been open, across redirects.
   *
   * Measured from the first referral in the correlation, which is what the
   * patient experienced. Measuring from the current one would restart the
   * count every time a service passed them on, and the resulting wait-time
   * report would say the system was performing well.
   */
  waitDays(correlationId: string, asOf = new Date().toISOString()): number | null {
    const chain = this.loop(correlationId);
    if (!chain.length) return null;
    const start = new Date(chain[0].created_at).getTime();
    const last = chain[chain.length - 1];
    const end = new Date(TERMINAL.includes(last.status) && last.closed_at ? last.closed_at : asOf).getTime();
    return Math.max(0, Math.round((end - start) / 86_400_000));
  }

  private transition(
    referralId: string,
    to: ReferralStatus,
    by: Actor,
    extra: { expectedBy?: string; detail?: string; closing?: boolean }
  ): ReferralRow {
    const from = this.require(referralId).status;
    const now = new Date().toISOString();
    this.db.sql
      .prepare(
        `UPDATE referrals SET status = ?, expected_by = ?, updated_at = ?, closed_at = ?
          WHERE tenant_id = ? AND id = ?`
      )
      .run(to, extra.expectedBy ?? null, now, extra.closing ? now : null, this.db.tenantId, referralId);
    this.event(referralId, to, by, { fromStatus: from, toStatus: to, ...(extra.detail ? { detail: extra.detail } : {}) });
    return this.get(referralId)!;
  }

  private event(
    referralId: string,
    event: string,
    by: Actor,
    extra: { fromStatus?: string; toStatus?: string; detail?: string }
  ): void {
    this.db.sql
      .prepare(
        `INSERT INTO referral_events (tenant_id, referral_id, at, event, actor_id, actor_kind, from_status, to_status, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        this.db.tenantId,
        referralId,
        new Date().toISOString(),
        event,
        by.actorId,
        by.actorKind,
        extra.fromStatus ?? null,
        extra.toStatus ?? null,
        extra.detail ?? null
      );
  }

  private require(referralId: string): ReferralRow {
    const r = this.get(referralId);
    if (!r) throw new Error(`no referral ${referralId}`);
    return r;
  }
}
