/**
 * Slots, bookings, and what happens when a patient does not come.
 *
 * Two things carry the weight here, and they are unrelated to each other
 * except that both are ways a schedule quietly fails.
 *
 * ## A slot belongs to one patient, and the database says so
 *
 * The one thing a scheduler must never do is give one slot to two people, and
 * check-then-insert cannot promise that. Between reading "free" and writing
 * "booked" another booking fits, and the window is exactly as wide as the gap
 * between two statements. Under a real clinic — two clerks, a patient portal
 * and an inbound SIU feed all touching the same diary — that window is hit,
 * and the failure is discovered in the waiting room.
 *
 * So the promise is a uniqueness constraint rather than a code path. `book()`
 * still checks, because a clear refusal beats a constraint violation, but the
 * check is a courtesy and the index is the guarantee. Nothing a caller does,
 * including calling concurrently from another process, can produce two live
 * bookings on one seat.
 *
 * Overbooking is expressed by giving a slot capacity, in the open and with a
 * number, rather than by defeating the constraint. Making overbooking
 * impossible is how a scheduler gets routed around, and a clinic overbooking
 * in a paper diary is worse off than one overbooking here.
 *
 * ## A missed appointment is a clinical event
 *
 * Marking a did-not-attend and closing the record is the administrative
 * reading, and for a routine review it is the right one. For the patient who
 * missed the appointment that answers an urgent referral it is a catastrophe
 * with no error attached: the referral shows booked-then-seen-status-unknown,
 * the clinic's list is clear, and nobody is waiting for anything.
 *
 * So `didNotAttend` returns what is owed rather than only recording a status,
 * and `unresolvedNonAttendance()` is the query that stops a missed urgent
 * appointment from being the end of the story.
 */
import { randomUUID } from "node:crypto";
import { an } from "../core/text.ts";
import type { Db } from "../db.ts";
import { Refusal } from "../core/refusal.ts";
import { Directory, type PartyKind, type Resolution } from "../directory/store.ts";

export type SlotStatus = "open" | "blocked";
export type BookingStatus = "booked" | "attended" | "did-not-attend" | "cancelled";
export type Priority = "routine" | "urgent" | "stat";

export interface SlotRow {
  tenant_id: string;
  id: string;
  resource_id: string;
  resource_kind: string;
  service: string;
  starts_at: string;
  ends_at: string;
  capacity: number;
  status: SlotStatus;
  block_reason: string | null;
  /** The travelling-clinic visit that planned this slot, when one did. */
  visit_id: string | null;
  created_at: string;
}

export interface BookingRow {
  tenant_id: string;
  id: string;
  slot_id: string;
  patient_id: string;
  seat: number;
  status: BookingStatus;
  reason: string;
  priority: Priority;
  correlation_id: string | null;
  referral_id: string | null;
  booked_by: string;
  booked_at: string;
  cancelled_by: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  outcome_at: string | null;
  outcome_by: string | null;
  created_at: string;
}

export interface Actor {
  actorId: string;
  actorKind: string;
}

/** Raised when a slot has no seat left. Distinct, so a caller can offer another. */
export class SlotFull extends Refusal {
  readonly slotId: string;
  constructor(slotId: string, capacity: number) {
    super(`slot ${slotId} is full (capacity ${capacity})`, 409);
    this.name = "SlotFull";
    this.slotId = slotId;
  }
}

export const PRIORITY_RANK: Record<Priority, number> = { stat: 0, urgent: 1, routine: 2 };

export class Schedule {
  private db: Db;
  private directory: Directory;

  constructor(db: Db) {
    this.db = db;
    this.directory = new Directory(db);
  }

  /**
   * Who or what a slot's resource actually is.
   *
   * Answers for every slot, including those created before the directory
   * existed, and says plainly when it cannot find the party. A diary that
   * rendered an unregistered resource as a blank would read as "no clinician";
   * one that threw would take the whole diary down for one bad row.
   */
  resolveResource(slot: SlotRow): Resolution {
    const kind: PartyKind = slot.resource_kind === "practitioner" ? "practitioner" : "location";
    return this.directory.resolve(kind, slot.resource_id);
  }

  /**
   * Declares a slot.
   *
   * Capacity above one is deliberate overbooking, which is a real clinical
   * practice and is therefore expressible — with a number somebody chose,
   * rather than by a clerk booking twice into a slot meant for one.
   */
  openSlot(input: {
    resourceId?: string;
    service: string;
    startsAt: string;
    endsAt: string;
    resourceKind?: string;
    capacity?: number;
    /**
     * A directory reference, validated on the way in.
     *
     * The strong form. `resourceId` as a bare string still works and is what
     * every slot written before the directory existed carries — those resolve
     * as unregistered rather than being refused, so a site can adopt a
     * directory without a flag day. Passing `resource` opts into the
     * guarantee: the party has to exist, and a typo is refused here rather
     * than discovered by a clerk staring at a diary for somebody who does not
     * work here.
     */
    resource?: { kind: PartyKind; id: string };
  }): SlotRow {
    if (new Date(input.endsAt) <= new Date(input.startsAt)) {
      throw new Error("a slot must end after it starts");
    }
    if (input.resource) this.directory.require(input.resource.kind, input.resource.id);
    const resourceId = input.resource?.id ?? input.resourceId;
    if (!resourceId) throw new Error("a slot needs a resource: pass resource {kind, id}, or a resourceId string");
    const resourceKind = input.resource?.kind ?? input.resourceKind ?? "practitioner";
    const capacity = input.capacity ?? 1;
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error("capacity must be a positive whole number");
    const id = randomUUID();
    this.db.sql
      .prepare(
        `INSERT INTO schedule_slots
           (tenant_id, id, resource_id, resource_kind, service, starts_at, ends_at, capacity, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`
      )
      .run(
        this.db.tenantId,
        id,
        resourceId,
        resourceKind,
        input.service,
        input.startsAt,
        input.endsAt,
        capacity,
        new Date().toISOString()
      );
    return this.slot(id)!;
  }

  /**
   * Takes a slot out of use without deleting it.
   *
   * Leave, a meeting, a scanner down for service. A slot that exists and must
   * not be booked is different from one that does not exist: deleting it loses
   * the fact that the clinic was supposed to be running, which is what a
   * capacity report is made of.
   */
  blockSlot(slotId: string, reason: string): SlotRow {
    if (!reason.trim()) throw new Error("blocking a slot needs a reason");
    const slot = this.requireSlot(slotId);
    if (this.liveBookings(slotId).length > 0) {
      throw new Error("that slot has a live booking; cancel it first so the patient is told");
    }
    this.db.sql
      .prepare("UPDATE schedule_slots SET status = 'blocked', block_reason = ? WHERE tenant_id = ? AND id = ?")
      .run(reason, this.db.tenantId, slot.id);
    return this.slot(slotId)!;
  }

  /**
   * Books a patient into a slot.
   *
   * The seat search plus insert runs in one transaction, and the unique index
   * is what makes that sufficient: two callers racing for the last seat cannot
   * both succeed, because the second insert violates the constraint rather
   * than finding a stale reading of "free". The `SlotFull` check above it is a
   * courtesy — a clear refusal beats a constraint violation — not the
   * guarantee.
   */
  book(input: {
    slotId: string;
    patientId: string;
    reason: string;
    by: Actor;
    priority?: Priority;
    correlationId?: string;
    referralId?: string;
  }): BookingRow {
    if (!input.reason.trim()) {
      throw new Error("a booking needs a reason; a list that has to be cut cannot be triaged without one");
    }
    return this.db.transaction(() => {
      const slot = this.requireSlot(input.slotId);
      if (slot.status === "blocked") throw new Error(`slot ${slot.id} is blocked: ${slot.block_reason}`);

      const taken = new Set(this.liveBookings(slot.id).map((b) => b.seat));
      let seat = -1;
      for (let i = 0; i < slot.capacity; i++) {
        if (!taken.has(i)) {
          seat = i;
          break;
        }
      }
      if (seat < 0) throw new SlotFull(slot.id, slot.capacity);

      const id = randomUUID();
      const now = new Date().toISOString();
      this.db.sql
        .prepare(
          `INSERT INTO schedule_bookings
             (tenant_id, id, slot_id, patient_id, seat, status, reason, priority,
              correlation_id, referral_id, booked_by, booked_at, created_at)
           VALUES (?, ?, ?, ?, ?, 'booked', ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          this.db.tenantId,
          id,
          slot.id,
          input.patientId,
          seat,
          input.reason,
          input.priority ?? "routine",
          input.correlationId ?? null,
          input.referralId ?? null,
          input.by.actorId,
          now,
          now
        );
      this.event(id, "booked", input.by, `${slot.service} at ${slot.starts_at}`);
      return this.booking(id)!;
    });
  }

  /**
   * Cancels a booking, freeing the seat and keeping the record.
   *
   * The booking is not deleted. A slot freed by deleting its booking loses the
   * fact that somebody cancelled, and a pattern of cancellations is made of
   * exactly those facts — for the clinic, and sometimes for the patient, whose
   * repeated cancellations are a clinical signal rather than an
   * administrative one.
   */
  cancel(bookingId: string, by: Actor & { reason: string }): BookingRow {
    if (!by.reason.trim()) throw new Error("cancelling a booking needs a reason");
    const b = this.requireBooking(bookingId);
    if (b.status !== "booked") throw new Error(`${an(b.status)} booking cannot be cancelled`);
    const now = new Date().toISOString();
    const cancelled = this.db.sql
      .prepare(
        `UPDATE schedule_bookings SET status = 'cancelled', cancelled_by = ?, cancelled_at = ?, cancel_reason = ?
          WHERE tenant_id = ? AND id = ? AND status = 'booked'`
      )
      .run(by.actorId, now, by.reason, this.db.tenantId, bookingId);
    // A booking attended while this cancellation was being applied must not be
    // erased: the patient came, and the seat was not free.
    if (cancelled.changes === 0) {
      throw new Error(`booking ${bookingId} is no longer booked; it changed while this was being applied`);
    }
    this.event(bookingId, "cancelled", by, by.reason);
    return this.booking(bookingId)!;
  }

  /** The patient came. */
  attended(bookingId: string, by: Actor): BookingRow {
    const b = this.requireBooking(bookingId);
    if (b.status !== "booked") throw new Error(`${an(b.status)} booking cannot be marked attended`);
    return this.outcome(bookingId, "attended", by, null);
  }

  /**
   * The patient did not come, and what is now owed.
   *
   * Returns the follow-up rather than only recording a status, because for
   * anything above routine the status is not the end of the story. A patient
   * who misses the appointment answering an urgent referral produces no error
   * anywhere: the referral reads booked, the clinic's list is clear, and
   * nobody is waiting. `followUpRequired` is that gap made explicit, and
   * `unresolvedNonAttendance()` is where it waits until somebody closes it.
   */
  didNotAttend(
    bookingId: string,
    by: Actor
  ): { booking: BookingRow; followUpRequired: boolean; because: string | null } {
    const b = this.requireBooking(bookingId);
    if (b.status !== "booked") throw new Error(`${an(b.status)} booking cannot be marked did-not-attend`);
    const booking = this.outcome(bookingId, "did-not-attend", by, null);
    const followUpRequired = booking.priority !== "routine" || booking.referral_id !== null;
    return {
      booking,
      followUpRequired,
      because: followUpRequired
        ? booking.referral_id
          ? "this appointment answers a referral, which is still open and now has nothing booked against it"
          : `${an(booking.priority)} appointment was missed`
        : null,
    };
  }

  /** Records that somebody has picked a non-attendance up. */
  resolveNonAttendance(bookingId: string, by: Actor & { action: string }): BookingRow {
    if (!by.action.trim()) throw new Error("resolving a missed appointment needs to say what was done");
    const b = this.requireBooking(bookingId);
    if (b.status !== "did-not-attend") throw new Error("that booking was not a non-attendance");
    this.event(bookingId, "dna-resolved", by, by.action);
    return b;
  }

  /**
   * Missed appointments that mattered and that nobody has picked up.
   *
   * The query the rest of the non-attendance handling exists for. Ordered by
   * priority then by how long ago, because a missed urgent appointment gets
   * less recoverable with every week.
   */
  unresolvedNonAttendance(asOf = new Date().toISOString()): BookingRow[] {
    const rows = this.db.sql
      .prepare(
        `SELECT b.* FROM schedule_bookings b
          WHERE b.tenant_id = ? AND b.status = 'did-not-attend'
            AND (b.priority != 'routine' OR b.referral_id IS NOT NULL)
            AND NOT EXISTS (
              SELECT 1 FROM schedule_events e
               WHERE e.tenant_id = ? AND e.booking_id = b.id AND e.event = 'dna-resolved'
            )
            AND b.outcome_at <= ?`
      )
      .all(this.db.tenantId, this.db.tenantId, asOf) as unknown as BookingRow[];
    return rows.sort(
      (a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || (a.outcome_at ?? "").localeCompare(b.outcome_at ?? "")
    );
  }

  // ---- queries -----------------------------------------------------------

  /** Slots with a seat free, in time order. */
  available(q: { service?: string; resourceId?: string; from?: string; to?: string; limit?: number } = {}): SlotRow[] {
    const args: unknown[] = [this.db.tenantId, this.db.tenantId];
    let sql = `SELECT s.* FROM schedule_slots s
                WHERE s.tenant_id = ? AND s.status = 'open'
                  AND s.capacity > (
                    SELECT COUNT(*) FROM schedule_bookings b
                     WHERE b.tenant_id = ? AND b.slot_id = s.id AND b.status != 'cancelled'
                  )`;
    if (q.service) {
      sql += " AND s.service = ?";
      args.push(q.service);
    }
    if (q.resourceId) {
      sql += " AND s.resource_id = ?";
      args.push(q.resourceId);
    }
    if (q.from) {
      sql += " AND s.starts_at >= ?";
      args.push(q.from);
    }
    if (q.to) {
      sql += " AND s.starts_at < ?";
      args.push(q.to);
    }
    sql += ` ORDER BY s.starts_at LIMIT ${Math.min(q.limit ?? 100, 500)}`;
    return this.db.sql.prepare(sql).all(...(args as never[])) as unknown as SlotRow[];
  }

  /**
   * This clinician's booked and attended appointments on a calendar day.
   *
   * The worklist's "today" queue. A diary is every slot, including empty
   * ones; a worklist that listed empty slots would bury the people who are
   * actually coming. Cancelled and did-not-attend stay off it — those have
   * their own lists — and the day is the UTC date of `asOf`, because a
   * server inventing a clinic timezone it was never told would be a
   * quieter kind of wrong.
   */
  today(resourceId: string, asOf = new Date().toISOString()): Array<{ slot: SlotRow; booking: BookingRow }> {
    const day = asOf.slice(0, 10);
    const from = `${day}T00:00:00.000Z`;
    const next = new Date(from);
    next.setUTCDate(next.getUTCDate() + 1);
    const out: Array<{ slot: SlotRow; booking: BookingRow }> = [];
    for (const { slot, bookings } of this.diary(resourceId, from, next.toISOString())) {
      for (const booking of bookings) {
        if (booking.status === "booked" || booking.status === "attended") {
          out.push({ slot, booking });
        }
      }
    }
    return out.sort(
      (a, b) =>
        a.slot.starts_at.localeCompare(b.slot.starts_at) ||
        PRIORITY_RANK[a.booking.priority] - PRIORITY_RANK[b.booking.priority]
    );
  }

  /** A resource's diary for a window, bookings included. */
  diary(resourceId: string, from: string, to: string): Array<{ slot: SlotRow; bookings: BookingRow[] }> {
    const slots = this.db.sql
      .prepare(
        `SELECT * FROM schedule_slots
          WHERE tenant_id = ? AND resource_id = ? AND starts_at >= ? AND starts_at < ?
          ORDER BY starts_at`
      )
      .all(this.db.tenantId, resourceId, from, to) as unknown as SlotRow[];
    return slots.map((slot) => ({ slot, bookings: this.liveBookings(slot.id) }));
  }

  /**
   * Every booking whose appointment falls in a window, across every
   * resource, cancelled ones included — unlike `diary()` and
   * `liveBookings()`, which are for showing a worklist rather than for
   * counting what was cancelled versus what simply never got an outcome
   * recorded. `startsAt` comes from the slot, which a booking does not
   * otherwise carry.
   */
  bookingsBetween(from: string, to: string): Array<BookingRow & { startsAt: string }> {
    return this.db.sql
      .prepare(
        `SELECT b.*, s.starts_at AS startsAt FROM schedule_bookings b
           JOIN schedule_slots s ON s.tenant_id = b.tenant_id AND s.id = b.slot_id
          WHERE b.tenant_id = ? AND s.starts_at >= ? AND s.starts_at < ?
          ORDER BY s.starts_at`
      )
      .all(this.db.tenantId, from, to) as unknown as Array<BookingRow & { startsAt: string }>;
  }

  /** A patient's appointments, newest first. */
  forPatient(patientId: string, opts: { includeCancelled?: boolean } = {}): BookingRow[] {
    return this.db.sql
      .prepare(
        `SELECT * FROM schedule_bookings
          WHERE tenant_id = ? AND patient_id = ?
            ${opts.includeCancelled ? "" : "AND status != 'cancelled'"}
          ORDER BY booked_at DESC`
      )
      .all(this.db.tenantId, patientId) as unknown as BookingRow[];
  }

  /**
   * A patient's appointments with the time and service they need to attend.
   *
   * `forPatient()` predates the patient surface and returns only bookings; a
   * booking without its slot tells the patient they have an appointment and
   * not when it is. The join remains tenant-bound on both sides so a reused
   * slot id at another custodian cannot supply its time.
   */
  appointmentsForPatient(
    patientId: string,
    opts: { includeCancelled?: boolean } = {}
  ): Array<{ booking: BookingRow; slot: SlotRow }> {
    const rows = this.db.sql
      .prepare(
        `SELECT
           b.tenant_id AS b_tenant_id, b.id AS b_id, b.slot_id AS b_slot_id,
           b.patient_id AS b_patient_id, b.seat AS b_seat, b.status AS b_status,
           b.reason AS b_reason, b.priority AS b_priority, b.correlation_id AS b_correlation_id,
           b.referral_id AS b_referral_id, b.booked_by AS b_booked_by, b.booked_at AS b_booked_at,
           b.cancelled_by AS b_cancelled_by, b.cancelled_at AS b_cancelled_at,
           b.cancel_reason AS b_cancel_reason, b.outcome_at AS b_outcome_at,
           b.outcome_by AS b_outcome_by, b.created_at AS b_created_at,
           s.tenant_id AS s_tenant_id, s.id AS s_id, s.resource_id AS s_resource_id,
           s.resource_kind AS s_resource_kind, s.service AS s_service, s.starts_at AS s_starts_at,
           s.ends_at AS s_ends_at, s.capacity AS s_capacity, s.status AS s_status,
           s.block_reason AS s_block_reason, s.visit_id AS s_visit_id, s.created_at AS s_created_at
         FROM schedule_bookings b
         JOIN schedule_slots s ON s.tenant_id = b.tenant_id AND s.id = b.slot_id
        WHERE b.tenant_id = ? AND b.patient_id = ?
          ${opts.includeCancelled ? "" : "AND b.status != 'cancelled'"}
        ORDER BY s.starts_at DESC`
      )
      .all(this.db.tenantId, patientId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      booking: {
        tenant_id: String(r.b_tenant_id),
        id: String(r.b_id),
        slot_id: String(r.b_slot_id),
        patient_id: String(r.b_patient_id),
        seat: Number(r.b_seat),
        status: r.b_status as BookingStatus,
        reason: String(r.b_reason),
        priority: r.b_priority as Priority,
        correlation_id: (r.b_correlation_id as string | null) ?? null,
        referral_id: (r.b_referral_id as string | null) ?? null,
        booked_by: String(r.b_booked_by),
        booked_at: String(r.b_booked_at),
        cancelled_by: (r.b_cancelled_by as string | null) ?? null,
        cancelled_at: (r.b_cancelled_at as string | null) ?? null,
        cancel_reason: (r.b_cancel_reason as string | null) ?? null,
        outcome_at: (r.b_outcome_at as string | null) ?? null,
        outcome_by: (r.b_outcome_by as string | null) ?? null,
        created_at: String(r.b_created_at),
      },
      slot: {
        tenant_id: String(r.s_tenant_id),
        id: String(r.s_id),
        resource_id: String(r.s_resource_id),
        resource_kind: String(r.s_resource_kind),
        service: String(r.s_service),
        starts_at: String(r.s_starts_at),
        ends_at: String(r.s_ends_at),
        capacity: Number(r.s_capacity),
        status: r.s_status as SlotStatus,
        block_reason: (r.s_block_reason as string | null) ?? null,
        visit_id: (r.s_visit_id as string | null) ?? null,
        created_at: String(r.s_created_at),
      },
    }));
  }

  slot(id: string): SlotRow | undefined {
    return this.db.sql
      .prepare("SELECT * FROM schedule_slots WHERE tenant_id = ? AND id = ?")
      .get(this.db.tenantId, id) as unknown as SlotRow | undefined;
  }

  booking(id: string): BookingRow | undefined {
    return this.db.sql
      .prepare("SELECT * FROM schedule_bookings WHERE tenant_id = ? AND id = ?")
      .get(this.db.tenantId, id) as unknown as BookingRow | undefined;
  }

  /** Bookings holding a seat: everything not cancelled. */
  liveBookings(slotId: string): BookingRow[] {
    return this.db.sql
      .prepare(
        "SELECT * FROM schedule_bookings WHERE tenant_id = ? AND slot_id = ? AND status != 'cancelled' ORDER BY seat"
      )
      .all(this.db.tenantId, slotId) as unknown as BookingRow[];
  }

  history(bookingId: string): Array<{ seq: number; at: string; event: string; actor_id: string; detail: string | null }> {
    return this.db.sql
      .prepare("SELECT seq, at, event, actor_id, detail FROM schedule_events WHERE tenant_id = ? AND booking_id = ? ORDER BY seq")
      .all(this.db.tenantId, bookingId) as never;
  }

  private outcome(bookingId: string, status: BookingStatus, by: Actor, detail: string | null): BookingRow {
    const now = new Date().toISOString();
    this.db.sql
      .prepare("UPDATE schedule_bookings SET status = ?, outcome_at = ?, outcome_by = ? WHERE tenant_id = ? AND id = ?")
      .run(status, now, by.actorId, this.db.tenantId, bookingId);
    this.event(bookingId, status, by, detail);
    return this.booking(bookingId)!;
  }

  private event(bookingId: string, event: string, by: Actor, detail: string | null): void {
    this.db.sql
      .prepare(
        `INSERT INTO schedule_events (tenant_id, booking_id, at, event, actor_id, actor_kind, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(this.db.tenantId, bookingId, new Date().toISOString(), event, by.actorId, by.actorKind, detail);
  }

  private requireSlot(id: string): SlotRow {
    const s = this.slot(id);
    if (!s) throw new Error(`no slot ${id}`);
    return s;
  }

  private requireBooking(id: string): BookingRow {
    const b = this.booking(id);
    if (!b) throw new Error(`no booking ${id}`);
    return b;
  }
}
