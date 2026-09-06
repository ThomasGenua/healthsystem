/**
 * What is still outstanding when somebody leaves, and who is accountable for
 * it until it is not.
 *
 * ## The list is taken, not requested
 *
 * A discharge form is a list somebody types at the end of a shift, and it
 * records what they remembered. The four things that actually go wrong after
 * a visit are all computable from the chart at the moment the encounter
 * closes:
 *
 *   - a result nobody has acknowledged
 *   - a medication reconciliation nobody finished
 *   - no follow-up appointment, where the disposition implies one
 *   - a referral still open
 *
 * So `open()` takes the snapshot. What a clinician does afterwards is resolve
 * items rather than remember them, and the snapshot survives their resolution
 * — the question asked six months later is what was outstanding when this
 * person went home, and a list that empties itself cannot answer it.
 *
 * ## Proposing a handoff is not completing one
 *
 * "I handed it over" and "somebody has it" are different statements, and only
 * the second is true of a transfer nobody answered. So a handoff is proposed
 * and then accepted, and until it is accepted **the person who proposed it is
 * still accountable**. That is the entire safety property: the failure this
 * exists to prevent is work that belongs to nobody because one person
 * believed they had passed it on and the other never looked.
 *
 * An unaccepted proposal is therefore a queue of its own rather than a gap,
 * and `unaccepted()` is what a board shows.
 *
 * ## Coverage is not a handoff
 *
 * Covering for somebody lends accountability for a window and hands it back.
 * The accountable person stays accountable; somebody else may act. Coverage
 * with no end date is the failure this guards against — the locum who covered
 * a list in March and is still nominally covering it in November — so an end
 * is required and there is no default, for the same reason a delegated
 * patient-access grant needs one: the decision about when it ends is the
 * safeguard, and a library must not make it.
 */
import { randomUUID } from "node:crypto";
import type { Db } from "../db.ts";
import { refuse } from "../core/refusal.ts";

export type DischargeStatus = "open" | "closed";
export type ItemKind = "unacknowledged-result" | "incomplete-reconciliation" | "open-referral" | "no-follow-up";
export type ItemStatus = "outstanding" | "resolved" | "not-needed";
export type HandoffKind = "transfer" | "coverage";
export type HandoffStatus = "proposed" | "accepted" | "declined" | "withdrawn" | "lapsed";

export interface DischargeRow {
  tenant_id: string;
  id: string;
  encounter_id: string;
  patient_id: string;
  disposition: string;
  status: DischargeStatus;
  accountable_id: string;
  accountable_kind: string;
  opened_at: string;
  opened_by: string;
  closed_at: string | null;
  closed_by: string | null;
  closed_outcome: string | null;
}

export interface DischargeItemRow {
  tenant_id: string;
  id: string;
  discharge_id: string;
  kind: ItemKind;
  reference_id: string | null;
  summary: string;
  status: ItemStatus;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution: string | null;
  created_at: string;
}

export interface HandoffRow {
  tenant_id: string;
  id: string;
  kind: HandoffKind;
  subject_kind: string;
  subject_id: string;
  patient_id: string | null;
  from_id: string;
  to_id: string;
  reason: string;
  status: HandoffStatus;
  covers_from: string | null;
  covers_until: string | null;
  proposed_at: string;
  proposed_by: string;
  responded_at: string | null;
  responded_by: string | null;
  response_reason: string | null;
}

export interface Actor {
  actorId: string;
  actorKind: string;
}

/** The chart, as much of it as a discharge needs to look at. */
export interface DischargeSources {
  orders?: {
    unacknowledged(opts?: { responsibleId?: string }): Array<{ id: string; patient_id: string; display: string }>;
  };
  meds?: {
    incompleteReconciliations(): Array<{ id: string; patient_id: string; transition: string }>;
  };
  referrals?: {
    forPatient(patientId: string): Array<{ id: string; status: string; to_service: string | null }>;
  };
  schedule?: {
    forPatient(patientId: string, opts?: { includeCancelled?: boolean }): Array<{ id: string; status: string }>;
  };
}

/**
 * Dispositions that mean somebody went home and should be seen again.
 *
 * Only these produce a `no-follow-up` item. A patient admitted to hospital or
 * transferred to emergency is somebody else's follow-up now, and raising one
 * here would put work on a clinic list for a person who is not in the
 * building — which is how a list stops being read.
 */
const EXPECTS_FOLLOW_UP = new Set(["home", "home-with-follow-up", "discharged"]);

export class Discharges {
  private db: Db;
  private sources: DischargeSources;
  private handoffs: Handoffs | undefined;

  constructor(db: Db, sources: DischargeSources = {}, handoffs?: Handoffs) {
    this.db = db;
    this.sources = sources;
    this.handoffs = handoffs;
  }

  /**
   * Takes the snapshot at the moment a visit closes.
   *
   * Idempotent per encounter, enforced by a unique index rather than by a
   * check: closing a visit twice must not take two snapshots of one moment
   * and leave two lists to reconcile.
   */
  open(input: {
    encounterId: string;
    patientId: string;
    disposition: string;
    accountableId: string;
    accountableKind?: string;
    by: Actor;
  }): { discharge: DischargeRow; items: DischargeItemRow[] } {
    if (!input.accountableId.trim()) {
      refuse("a discharge needs somebody accountable for the follow-up; work owned by nobody is on nobody's list");
    }
    const existing = this.forEncounter(input.encounterId);
    if (existing) return { discharge: existing, items: this.items(existing.id) };

    const id = randomUUID();
    const now = new Date().toISOString();
    return this.db.transaction(() => {
      this.db.sql
        .prepare(
          `INSERT INTO discharges
             (tenant_id, id, encounter_id, patient_id, disposition, status,
              accountable_id, accountable_kind, opened_at, opened_by)
           VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`
        )
        .run(
          this.db.tenantId,
          id,
          input.encounterId,
          input.patientId,
          input.disposition,
          input.accountableId,
          input.accountableKind ?? "practitioner",
          now,
          input.by.actorId
        );
      for (const found of this.outstandingFor(input.patientId, input.disposition)) {
        this.db.sql
          .prepare(
            `INSERT INTO discharge_items
               (tenant_id, id, discharge_id, kind, reference_id, summary, status, created_at)
             VALUES (?, ?, ?, ?, ?, ?, 'outstanding', ?)`
          )
          .run(this.db.tenantId, randomUUID(), id, found.kind, found.referenceId ?? null, found.summary, now);
      }
      return { discharge: this.get(id)!, items: this.items(id) };
    });
  }

  /**
   * What the chart says is loose, right now.
   *
   * Exposed so a clinician can see the list before closing the visit rather
   * than after, which is the only moment they can still do something about
   * it while the patient is in front of them.
   */
  outstandingFor(
    patientId: string,
    disposition: string
  ): Array<{ kind: ItemKind; referenceId?: string; summary: string }> {
    const out: Array<{ kind: ItemKind; referenceId?: string; summary: string }> = [];
    const { orders, meds, referrals, schedule } = this.sources;

    for (const r of orders?.unacknowledged() ?? []) {
      if (r.patient_id !== patientId) continue;
      out.push({ kind: "unacknowledged-result", referenceId: r.id, summary: `${r.display} has not been acknowledged` });
    }
    for (const r of meds?.incompleteReconciliations() ?? []) {
      if (r.patient_id !== patientId) continue;
      out.push({
        kind: "incomplete-reconciliation",
        referenceId: r.id,
        summary: `the ${r.transition} medication reconciliation was not finished`,
      });
    }
    for (const r of referrals?.forPatient(patientId) ?? []) {
      if (r.status === "completed" || r.status === "cancelled" || r.status === "declined") continue;
      out.push({ kind: "open-referral", referenceId: r.id, summary: `referral to ${r.to_service ?? "a service"} is still open` });
    }

    // Only where the disposition implies one. A patient admitted to hospital
    // is somebody else's follow-up, and putting them on a clinic list is how
    // the list stops being read.
    if (EXPECTS_FOLLOW_UP.has(disposition.trim().toLowerCase())) {
      const booked = (schedule?.forPatient(patientId) ?? []).filter((b) => b.status === "booked");
      if (booked.length === 0) {
        out.push({ kind: "no-follow-up", summary: "no follow-up appointment is booked" });
      }
    }
    return out;
  }

  /** Marks one loose end dealt with, or deliberately not needed. */
  resolve(itemId: string, input: { status: Exclude<ItemStatus, "outstanding">; resolution: string; by: Actor }): DischargeItemRow {
    const row = this.item(itemId);
    if (!row) refuse(`no discharge item ${itemId}`, 404);
    if (!input.resolution.trim()) {
      // Same rule as completing a task. An item closed with an empty hand is
      // indistinguishable afterwards from one abandoned.
      refuse("say what was done, or why it was not needed; an item closed with nothing to show for it reads as abandoned");
    }
    const done = this.db.sql
      .prepare(
        `UPDATE discharge_items SET status = ?, resolved_at = ?, resolved_by = ?, resolution = ?
          WHERE tenant_id = ? AND id = ? AND status = 'outstanding'`
      )
      .run(input.status, new Date().toISOString(), input.by.actorId, input.resolution.trim(), this.db.tenantId, itemId);
    if (done.changes === 0) refuse("that item has already been resolved", 409);
    return this.item(itemId)!;
  }

  /**
   * Closes the follow-up.
   *
   * Refused while anything is outstanding. A discharge that could be closed
   * over an unread result would be a button that makes the list go away,
   * which is worse than no list: it produces a record saying the follow-up
   * was completed.
   */
  close(dischargeId: string, input: { outcome: string; by: Actor }): DischargeRow {
    const row = this.require(dischargeId);
    if (row.status === "closed") refuse("that discharge follow-up is already closed", 409);
    if (!input.outcome.trim()) refuse("closing a discharge needs an outcome");
    const outstanding = this.items(dischargeId).filter((i) => i.status === "outstanding");
    if (outstanding.length > 0) {
      refuse(
        `${outstanding.length} item(s) are still outstanding: ${outstanding.map((i) => i.summary).join("; ")}`,
        409
      );
    }
    this.db.sql
      .prepare(
        `UPDATE discharges SET status = 'closed', closed_at = ?, closed_by = ?, closed_outcome = ?
          WHERE tenant_id = ? AND id = ? AND status = 'open'`
      )
      .run(new Date().toISOString(), input.by.actorId, input.outcome.trim(), this.db.tenantId, dischargeId);
    return this.get(dischargeId)!;
  }

  get(id: string): DischargeRow | undefined {
    return this.db.sql
      .prepare("SELECT * FROM discharges WHERE tenant_id = ? AND id = ?")
      .get(this.db.tenantId, id) as unknown as DischargeRow | undefined;
  }

  private require(id: string): DischargeRow {
    const row = this.get(id);
    if (!row) refuse(`no discharge ${id}`, 404);
    return row;
  }

  forEncounter(encounterId: string): DischargeRow | undefined {
    return this.db.sql
      .prepare("SELECT * FROM discharges WHERE tenant_id = ? AND encounter_id = ?")
      .get(this.db.tenantId, encounterId) as unknown as DischargeRow | undefined;
  }

  items(dischargeId: string): DischargeItemRow[] {
    return this.db.sql
      .prepare("SELECT * FROM discharge_items WHERE tenant_id = ? AND discharge_id = ? ORDER BY created_at, kind")
      .all(this.db.tenantId, dischargeId) as unknown as DischargeItemRow[];
  }

  item(id: string): DischargeItemRow | undefined {
    return this.db.sql
      .prepare("SELECT * FROM discharge_items WHERE tenant_id = ? AND id = ?")
      .get(this.db.tenantId, id) as unknown as DischargeItemRow | undefined;
  }

  /**
   * Discharges whose follow-up is still open, longest-waiting first.
   *
   * This is the "recently discharged" view an operations board owes, and the
   * ordering is the point: the one nobody has touched since Tuesday is the
   * one at the top.
   */
  openFollowUps(opts: { accountableId?: string; asOf?: Date } = {}): DischargeRow[] {
    const rows = this.db.sql
      .prepare("SELECT * FROM discharges WHERE tenant_id = ? AND status = 'open' ORDER BY opened_at")
      .all(this.db.tenantId) as unknown as DischargeRow[];
    if (!opts.accountableId) return rows;
    // Through the handoff record, not the column. accountable_id is who this
    // started with; an accepted transfer or a running coverage is what
    // decides whose list it is on today.
    const overrides = this.handoffs?.effectiveOwners("discharge", opts.asOf) ?? new Map();
    return rows.filter((r) => (overrides.get(r.id)?.ownerId ?? r.accountable_id) === opts.accountableId);
  }

  /** Who is answerable for one discharge right now, and how it came to be them. */
  accountableFor(dischargeId: string, asOf = new Date()) {
    const row = this.require(dischargeId);
    if (!this.handoffs) return { ownerId: row.accountable_id, via: "original" as const, handoffId: null };
    return this.handoffs.accountableFor("discharge", dischargeId, row.accountable_id, asOf);
  }

  /** Open follow-ups untouched for longer than a clinic is comfortable with. */
  overdue(olderThanHours: number, asOf = new Date()): DischargeRow[] {
    const cutoff = new Date(asOf.getTime() - olderThanHours * 3600_000).toISOString();
    return this.openFollowUps().filter((r) => r.opened_at <= cutoff);
  }
}

/**
 * Transfers of accountability, and the acceptance that completes one.
 *
 * Kept beside discharges because that is where the need is sharpest, but the
 * subject is deliberately generic: a discharge follow-up, a task, a referral
 * — anything one person can be accountable for is something they can try to
 * hand to somebody else.
 */
export class Handoffs {
  private db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /**
   * Offers work to somebody. Does not move it.
   *
   * Until this is accepted the proposer is still accountable, and
   * `unaccepted()` shows it. A system where proposing were enough would let
   * one person believe they had passed something on while the other never
   * looked — which is the exact failure this whole module exists for.
   */
  propose(input: {
    kind: HandoffKind;
    subjectKind: string;
    subjectId: string;
    patientId?: string;
    fromId: string;
    toId: string;
    reason: string;
    coversFrom?: string;
    coversUntil?: string;
    by: Actor;
  }): HandoffRow {
    if (!input.reason.trim()) refuse("a handoff needs a reason the person receiving it can read");
    if (input.fromId === input.toId) refuse("that hands the work to the person who already has it");

    if (input.kind === "coverage") {
      // No default, for the same reason a delegated patient grant has none:
      // when it ends is the safeguard, and a locum who covered a list in
      // March must not still be covering it in November because a library
      // picked a number.
      if (!input.coversUntil) {
        refuse("coverage needs an end date; cover with no end is how somebody keeps a list they stopped watching");
      }
      if (Date.parse(input.coversUntil) <= Date.now()) refuse("that coverage has already ended");
      if (input.coversFrom && Date.parse(input.coversFrom) >= Date.parse(input.coversUntil)) {
        refuse("coverage cannot end before it starts");
      }
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    try {
      this.db.sql
        .prepare(
          `INSERT INTO handoffs
             (tenant_id, id, kind, subject_kind, subject_id, patient_id, from_id, to_id, reason,
              status, covers_from, covers_until, proposed_at, proposed_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?, ?, ?)`
        )
        .run(
          this.db.tenantId,
          id,
          input.kind,
          input.subjectKind,
          input.subjectId,
          input.patientId ?? null,
          input.fromId,
          input.toId,
          input.reason.trim(),
          input.coversFrom ?? null,
          input.coversUntil ?? null,
          now,
          input.by.actorId
        );
    } catch (err) {
      // The partial unique index. Two people each offered the same work can
      // each accept it, and each believe the other did not.
      if (String(err).includes("UNIQUE")) {
        refuse("that work has already been offered to somebody and is waiting on their answer", 409);
      }
      throw err;
    }
    return this.get(id)!;
  }

  /** Taking it on. Only the person it was offered to may. */
  accept(id: string, by: Actor): HandoffRow {
    const row = this.require(id);
    if (row.status !== "proposed") refuse(`that handoff is already ${row.status}`, 409);
    if (by.actorId !== row.to_id) {
      refuse("only the person a handoff was offered to can accept it", 403);
    }
    return this.respond(id, "accepted", by, null);
  }

  /**
   * Refusing it, with a reason.
   *
   * The work goes back to whoever had it, which is where it has been all
   * along. A decline is not a failure state — it is the system working, and
   * the alternative is somebody accepting a list they cannot cover.
   */
  decline(id: string, by: Actor & { reason: string }): HandoffRow {
    const row = this.require(id);
    if (row.status !== "proposed") refuse(`that handoff is already ${row.status}`, 409);
    if (by.actorId !== row.to_id) refuse("only the person a handoff was offered to can decline it", 403);
    if (!by.reason.trim()) refuse("declining a handoff needs a reason the proposer can act on");
    return this.respond(id, "declined", by, by.reason.trim());
  }

  /** Taking the offer back, which only the proposer may do. */
  withdraw(id: string, by: Actor & { reason: string }): HandoffRow {
    const row = this.require(id);
    if (row.status !== "proposed") refuse(`that handoff is already ${row.status}`, 409);
    if (by.actorId !== row.from_id) refuse("only the person who offered a handoff can withdraw it", 403);
    if (!by.reason.trim()) refuse("withdrawing a handoff needs a reason");
    return this.respond(id, "withdrawn", by, by.reason.trim());
  }

  /**
   * Who is accountable for something right now.
   *
   * The question this module exists to answer, and it is answered from the
   * record rather than from a column somebody has to remember to update.
   * An accepted transfer moves it. Accepted coverage moves it only inside its
   * window, and hands it back afterwards without anybody doing anything —
   * which is what makes coverage safe to grant.
   */
  accountableFor(
    subjectKind: string,
    subjectId: string,
    originalOwner: string,
    asOf = new Date()
  ): { ownerId: string; via: "original" | "transfer" | "coverage"; handoffId: string | null; covering?: string } {
    const rows = this.db.sql
      .prepare(
        `SELECT * FROM handoffs
          WHERE tenant_id = ? AND subject_kind = ? AND subject_id = ? AND status = 'accepted'
          ORDER BY responded_at`
      )
      .all(this.db.tenantId, subjectKind, subjectId) as unknown as HandoffRow[];

    let owner = originalOwner;
    let via: "original" | "transfer" | "coverage" = "original";
    let handoffId: string | null = null;
    for (const row of rows) {
      if (row.kind === "transfer") {
        owner = row.to_id;
        via = "transfer";
        handoffId = row.id;
      }
    }
    // Coverage sits on top of whoever holds it, and only while it is running.
    const now = asOf.toISOString();
    const live = rows.find(
      (r) =>
        r.kind === "coverage" &&
        (!r.covers_from || r.covers_from <= now) &&
        r.covers_until !== null &&
        r.covers_until > now
    );
    if (live) {
      return { ownerId: live.to_id, via: "coverage", handoffId: live.id, covering: owner };
    }
    return { ownerId: owner, via, handoffId };
  }

  /**
   * Who holds each subject of one kind, where that is not who originally did.
   *
   * The bulk form of `accountableFor()`, for a store that has to answer "is
   * this mine" about a list rather than about one row. It returns only the
   * subjects a handoff actually moves — a declined offer, a withdrawn one and
   * a lapsed coverage all contribute nothing, so a subject absent from this
   * map is one whose owner column is still the truth.
   *
   * That absence is what makes coverage revert without a job: when the window
   * closes the subject simply stops appearing here, and the store falls back
   * to the column it always had. A design that wrote the coverer into the
   * owner column on accept would need a sweep to write it back, and a sweep
   * that does not run leaves a locum owning a list they stopped watching in
   * March.
   */
  effectiveOwners(
    subjectKind: string,
    asOf = new Date()
  ): Map<string, { ownerId: string; via: "transfer" | "coverage"; covering?: string }> {
    const rows = this.db.sql
      .prepare(
        `SELECT * FROM handoffs
          WHERE tenant_id = ? AND subject_kind = ? AND status = 'accepted'
          ORDER BY responded_at`
      )
      .all(this.db.tenantId, subjectKind) as unknown as HandoffRow[];

    const transferred = new Map<string, string>();
    for (const row of rows) {
      if (row.kind === "transfer") transferred.set(row.subject_id, row.to_id);
    }

    const now = asOf.toISOString();
    const out = new Map<string, { ownerId: string; via: "transfer" | "coverage"; covering?: string }>();
    for (const [subjectId, ownerId] of transferred) out.set(subjectId, { ownerId, via: "transfer" });
    for (const row of rows) {
      if (row.kind !== "coverage") continue;
      if (row.covers_from && row.covers_from > now) continue;
      if (row.covers_until === null || row.covers_until <= now) continue;
      // On top of whoever holds it, which may be a transferee rather than the
      // person the coverage names as its source.
      out.set(row.subject_id, {
        ownerId: row.to_id,
        via: "coverage",
        covering: transferred.get(row.subject_id) ?? row.from_id,
      });
    }
    return out;
  }

  /**
   * Offers nobody has answered.
   *
   * The queue an operations board shows. Every row here is work two people
   * may each believe the other has.
   */
  unaccepted(opts: { olderThanHours?: number } = {}, asOf = new Date()): HandoffRow[] {
    const rows = this.db.sql
      .prepare("SELECT * FROM handoffs WHERE tenant_id = ? AND status = 'proposed' ORDER BY proposed_at")
      .all(this.db.tenantId) as unknown as HandoffRow[];
    if (opts.olderThanHours === undefined) return rows;
    const cutoff = new Date(asOf.getTime() - opts.olderThanHours * 3600_000).toISOString();
    return rows.filter((r) => r.proposed_at <= cutoff);
  }

  /** Coverage that is running right now, so a board can say who is standing in. */
  activeCoverage(asOf = new Date()): HandoffRow[] {
    const now = asOf.toISOString();
    return this.db.sql
      .prepare(
        `SELECT * FROM handoffs
          WHERE tenant_id = ? AND kind = 'coverage' AND status = 'accepted'
            AND (covers_from IS NULL OR covers_from <= ?) AND covers_until > ?
          ORDER BY covers_until`
      )
      .all(this.db.tenantId, now, now) as unknown as HandoffRow[];
  }

  /** Every offer and answer about one thing, so reassignment is a record and not a guess. */
  forSubject(subjectKind: string, subjectId: string): HandoffRow[] {
    return this.db.sql
      .prepare(
        `SELECT * FROM handoffs WHERE tenant_id = ? AND subject_kind = ? AND subject_id = ?
          ORDER BY proposed_at`
      )
      .all(this.db.tenantId, subjectKind, subjectId) as unknown as HandoffRow[];
  }

  get(id: string): HandoffRow | undefined {
    return this.db.sql
      .prepare("SELECT * FROM handoffs WHERE tenant_id = ? AND id = ?")
      .get(this.db.tenantId, id) as unknown as HandoffRow | undefined;
  }

  private require(id: string): HandoffRow {
    const row = this.get(id);
    if (!row) refuse(`no handoff ${id}`, 404);
    return row;
  }

  private respond(id: string, status: HandoffStatus, by: Actor, reason: string | null): HandoffRow {
    const done = this.db.sql
      .prepare(
        `UPDATE handoffs SET status = ?, responded_at = ?, responded_by = ?, response_reason = ?
          WHERE tenant_id = ? AND id = ? AND status = 'proposed'`
      )
      .run(status, new Date().toISOString(), by.actorId, reason, this.db.tenantId, id);
    // Two people answering one offer at once: the second finds nothing to
    // change and is told so rather than overwriting the first.
    if (done.changes === 0) refuse("that handoff was answered while this was being decided", 409);
    return this.get(id)!;
  }
}
