/**
 * The visit, and everything that happened inside it.
 *
 * Orders, medication statements, reconciliations and clinical notes have all
 * carried an `encounter_id` since they were written, and no table owned one.
 * The column referred to something the system could not describe: "what
 * happened at this visit" had no answer except a time-window guess across four
 * stores, a discharge summary had nothing to summarise, and an encounter-scoped
 * medication reconciliation recorded an identifier that pointed nowhere.
 *
 * Two design positions worth stating, because both were choices:
 *
 * **A visit is not a document about a visit.** The append-only clinical record
 * already accepts an `Encounter` entry, and that is the right home for a
 * narrative somebody wrote. It is the wrong home for the relationships — which
 * orders belong to this visit, who was present, whether it is still open —
 * because those are queried, not read, and re-deriving them from entries on
 * every read is how a chart gets slow and a worklist gets wrong. So this owns
 * the visit and the record owns the writing about it, the same way
 * `patient_index` sits alongside `clinical_entries`.
 *
 * **An encounter that started cannot be cancelled.** Only a planned one can.
 * Once a patient has been seen, the visit happened, and a status that could
 * erase it would erase the fact that they attended. A patient who walks out is
 * a *disposition* — `left-without-being-seen` — on a finished encounter, which
 * keeps both facts: they came, and nobody saw them. Cancelling would keep
 * neither.
 */
import { randomUUID } from "node:crypto";
import type { Db } from "../db.ts";
import { an } from "../core/text.ts";

/** How the patient was seen. Not where — a home visit and a clinic visit
 * examine different things, and a chart that cannot tell them apart overstates
 * what was looked at. */
export type EncounterClass = "in-person" | "virtual" | "telephone" | "home-visit";

export type EncounterStatus = "planned" | "in-progress" | "finished" | "cancelled";

const CLASSES: readonly EncounterClass[] = ["in-person", "virtual", "telephone", "home-visit"];

/** Nothing may be added to a visit in these states, and they never change again. */
const TERMINAL: readonly EncounterStatus[] = ["finished", "cancelled"];

export interface Actor {
  actorId: string;
  actorKind: string;
}

export interface EncounterRow {
  tenant_id: string;
  id: string;
  patient_id: string;
  class: EncounterClass;
  status: EncounterStatus;
  reason: string;
  location: string | null;
  booking_id: string | null;
  started_at: string | null;
  ended_at: string | null;
  disposition: string | null;
  opened_by: string;
  created_at: string;
  updated_at: string;
}

export interface ParticipantRow {
  tenant_id: string;
  encounter_id: string;
  participant_id: string;
  participant_kind: string;
  role: string;
  joined_at: string;
}

export interface EncounterEvent {
  seq: number;
  at: string;
  event: string;
  actor_id: string;
  actor_kind: string;
  from_status: string | null;
  to_status: string | null;
  detail: string | null;
}

/**
 * Thrown when clinical content names an encounter it may not belong to.
 *
 * A distinct type so the HTTP layer can map it to something better than a
 * generic 400 once #26 lands, and so a caller can tell "that visit is not this
 * patient's" from "that visit does not exist" without parsing a string.
 */
export class EncounterMismatch extends Error {}

export class Encounters {
  private db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /**
   * Opens a visit.
   *
   * `planned` by default because most visits are booked before they happen,
   * and a walk-in passes `arrived: true` to start in progress. The reason is
   * required for the same purpose a referral's indication is: a visit with no
   * stated reason cannot be triaged, summarised, or later understood by
   * somebody reading the chart cold.
   */
  open(input: {
    patientId: string;
    class: EncounterClass;
    reason: string;
    by: Actor;
    location?: string;
    bookingId?: string;
    arrived?: boolean;
    startsAt?: string;
  }): EncounterRow {
    if (!CLASSES.includes(input.class)) {
      throw new Error(`unknown encounter class ${input.class}; expected one of ${CLASSES.join(", ")}`);
    }
    if (!input.reason.trim()) throw new Error("an encounter needs a reason for the visit");

    const id = randomUUID();
    const now = new Date().toISOString();
    const status: EncounterStatus = input.arrived ? "in-progress" : "planned";
    this.db.sql
      .prepare(
        `INSERT INTO encounters
           (tenant_id, id, patient_id, class, status, reason, location, booking_id,
            started_at, ended_at, disposition, opened_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`
      )
      .run(
        this.db.tenantId,
        id,
        input.patientId,
        input.class,
        status,
        input.reason,
        input.location ?? null,
        input.bookingId ?? null,
        input.arrived ? (input.startsAt ?? now) : null,
        input.by.actorId,
        now,
        now
      );
    this.event(id, "opened", input.by, { toStatus: status, detail: input.reason });
    // The person who opened it was there. Recorded rather than assumed, so a
    // visit always has at least one participant and "who saw this patient" is
    // never an empty answer that looks like nobody did.
    this.addParticipant(id, { participantId: input.by.actorId, participantKind: input.by.actorKind, role: "opener" });
    return this.get(id)!;
  }

  /** The patient arrived and the visit is under way. */
  arrive(encounterId: string, by: Actor, at?: string): EncounterRow {
    const e = this.require(encounterId);
    if (e.status !== "planned") throw new Error(`${an(e.status)} encounter cannot be marked as arrived`);
    const now = new Date().toISOString();
    this.db.sql
      .prepare("UPDATE encounters SET status = 'in-progress', started_at = ?, updated_at = ? WHERE tenant_id = ? AND id = ?")
      .run(at ?? now, now, this.db.tenantId, encounterId);
    this.event(encounterId, "arrived", by, { fromStatus: e.status, toStatus: "in-progress" });
    return this.get(encounterId)!;
  }

  /**
   * Ends the visit, with what was decided.
   *
   * The disposition is required and is not derived from the status. "Finished"
   * says the visit ended; it says nothing about whether the patient went home,
   * was admitted, was sent to emergency, or left before being seen — and those
   * are the four things a later reader most needs to know. A visit that ends
   * with no recorded decision is the clinical equivalent of a section that
   * renders empty because it failed to load.
   */
  close(encounterId: string, by: Actor & { disposition: string }): EncounterRow {
    const e = this.require(encounterId);
    if (e.status !== "in-progress") {
      throw new Error(`${an(e.status)} encounter cannot be closed; only one in progress can`);
    }
    if (!by.disposition.trim()) throw new Error("closing an encounter needs a disposition saying what was decided");
    const now = new Date().toISOString();
    this.db.sql
      .prepare(
        `UPDATE encounters SET status = 'finished', ended_at = ?, disposition = ?, updated_at = ?
          WHERE tenant_id = ? AND id = ?`
      )
      .run(now, by.disposition, now, this.db.tenantId, encounterId);
    this.event(encounterId, "closed", by, { fromStatus: e.status, toStatus: "finished", detail: by.disposition });
    return this.get(encounterId)!;
  }

  /**
   * Cancels a visit that never started.
   *
   * Deliberately refused once a visit is in progress. See the note at the top
   * of this module: a patient who was seen and then left is a disposition, not
   * a cancellation, and cancelling would erase that they attended at all.
   */
  cancel(encounterId: string, by: Actor & { reason: string }): EncounterRow {
    const e = this.require(encounterId);
    if (e.status !== "planned") {
      throw new Error(
        `${an(e.status)} encounter cannot be cancelled; a visit that started happened, so close it with a disposition instead`
      );
    }
    if (!by.reason.trim()) throw new Error("cancelling an encounter needs a reason");
    const now = new Date().toISOString();
    this.db.sql
      .prepare("UPDATE encounters SET status = 'cancelled', ended_at = ?, updated_at = ? WHERE tenant_id = ? AND id = ?")
      .run(now, now, this.db.tenantId, encounterId);
    this.event(encounterId, "cancelled", by, { fromStatus: e.status, toStatus: "cancelled", detail: by.reason });
    return this.get(encounterId)!;
  }

  /** Records that somebody was present, and as what. Idempotent per role. */
  addParticipant(
    encounterId: string,
    who: { participantId: string; participantKind: string; role: string }
  ): ParticipantRow {
    if (!who.role.trim()) throw new Error("a participant needs a role");
    this.db.sql
      .prepare(
        `INSERT INTO encounter_participants
           (tenant_id, encounter_id, participant_id, participant_kind, role, joined_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(tenant_id, encounter_id, participant_id, role) DO NOTHING`
      )
      .run(
        this.db.tenantId,
        encounterId,
        who.participantId,
        who.participantKind,
        who.role,
        new Date().toISOString()
      );
    return this.participants(encounterId).find((p) => p.participant_id === who.participantId && p.role === who.role)!;
  }

  /**
   * Checks that clinical content may name this encounter, and returns it.
   *
   * The guard that turns `encounter_id` from a string a caller happened to
   * pass into a reference that means something. Three refusals, and the second
   * is the one that matters: attaching one patient's order to another
   * patient's visit is how a chart acquires somebody else's results.
   *
   * A `finished` encounter still accepts content, because results come back
   * after the patient has gone home and refusing them would be worse than
   * useless. A `cancelled` one does not: it never happened, so nothing can
   * have happened during it.
   */
  validateFor(encounterId: string, patientId: string): EncounterRow {
    const e = this.get(encounterId);
    if (!e) throw new EncounterMismatch(`no encounter ${encounterId}`);
    if (e.patient_id !== patientId) {
      throw new EncounterMismatch(`encounter ${encounterId} belongs to a different patient`);
    }
    if (e.status === "cancelled") {
      throw new EncounterMismatch(`encounter ${encounterId} was cancelled, so nothing can belong to it`);
    }
    return e;
  }

  get(encounterId: string): EncounterRow | undefined {
    return this.db.sql
      .prepare("SELECT * FROM encounters WHERE tenant_id = ? AND id = ?")
      .get(this.db.tenantId, encounterId) as unknown as EncounterRow | undefined;
  }

  /** A patient's visits, most recent first. Planned ones sort first, since
   * they are the ones somebody still has to do something about. */
  forPatient(patientId: string, opts: { includeCancelled?: boolean; limit?: number } = {}): EncounterRow[] {
    const rows = this.db.sql
      .prepare(
        `SELECT * FROM encounters
          WHERE tenant_id = ? AND patient_id = ?${opts.includeCancelled ? "" : " AND status != 'cancelled'"}
          ORDER BY COALESCE(started_at, created_at) DESC
          LIMIT ?`
      )
      .all(this.db.tenantId, patientId, opts.limit ?? 100) as unknown as EncounterRow[];
    return rows;
  }

  /**
   * Visits still open, oldest first.
   *
   * The worklist that stops a visit staying open forever. An encounter left in
   * progress is not merely untidy: everything filed against it inherits its
   * ambiguity, and a discharge summary cannot be produced for a visit that has
   * not ended.
   */
  stillOpen(opts: { olderThanHours?: number; asOf?: string } = {}): EncounterRow[] {
    const asOf = opts.asOf ?? new Date().toISOString();
    const rows = this.db.sql
      .prepare(
        `SELECT * FROM encounters WHERE tenant_id = ? AND status IN ('planned', 'in-progress')
          ORDER BY COALESCE(started_at, created_at) ASC`
      )
      .all(this.db.tenantId) as unknown as EncounterRow[];
    if (opts.olderThanHours === undefined) return rows;
    const cutoff = new Date(new Date(asOf).getTime() - opts.olderThanHours * 3_600_000).toISOString();
    return rows.filter((r) => (r.started_at ?? r.created_at) < cutoff);
  }

  participants(encounterId: string): ParticipantRow[] {
    return this.db.sql
      .prepare("SELECT * FROM encounter_participants WHERE tenant_id = ? AND encounter_id = ? ORDER BY joined_at")
      .all(this.db.tenantId, encounterId) as unknown as ParticipantRow[];
  }

  history(encounterId: string): EncounterEvent[] {
    return this.db.sql
      .prepare(
        `SELECT seq, at, event, actor_id, actor_kind, from_status, to_status, detail
           FROM encounter_events WHERE tenant_id = ? AND encounter_id = ? ORDER BY seq`
      )
      .all(this.db.tenantId, encounterId) as unknown as EncounterEvent[];
  }

  private require(encounterId: string): EncounterRow {
    const e = this.get(encounterId);
    if (!e) throw new Error(`no encounter ${encounterId}`);
    return e;
  }

  private event(
    encounterId: string,
    event: string,
    by: Actor,
    extra: { fromStatus?: string; toStatus?: string; detail?: string }
  ): void {
    this.db.sql
      .prepare(
        `INSERT INTO encounter_events
           (tenant_id, encounter_id, at, event, actor_id, actor_kind, from_status, to_status, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        this.db.tenantId,
        encounterId,
        new Date().toISOString(),
        event,
        by.actorId,
        by.actorKind,
        extra.fromStatus ?? null,
        extra.toStatus ?? null,
        extra.detail ?? null
      );
  }
}

/** Exported so the terminal set is stated once. */
export { TERMINAL as ENCOUNTER_TERMINAL_STATUSES };
