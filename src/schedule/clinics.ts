/**
 * Travelling clinics: a visit planned as one thing, and the waitlist for when
 * the plane does not fly.
 *
 * A specialist flies into a community for two days a month. Before this, that
 * was twenty hand-created slots, re-created by hand every month, cancellable
 * only one at a time — so when weather cancelled the visit, twenty bookings
 * were cancelled with no record of the common cause, and who got the seats at
 * the next visit was decided in somebody's head or on paper beside the phone.
 *
 * ## The visit
 *
 * A visit is a block of slots for one resource, at one place, over a span of
 * days, created in one call and moved or cancelled as a unit. The slots it
 * generates are ordinary rows: `book()` books them, the partial unique index
 * guards them, the diary lists them, and nothing downstream has to know
 * visits exist. Recurrence is deliberately not a cron pattern — a northern
 * clinic's calendar is a plane schedule, which is concrete dates — so a visit
 * is planned for the days it will actually happen, and "the same as last
 * time" is `repeatVisit()`.
 *
 * ## The waitlist, and its ordering
 *
 * Who waits longer is a clinical outcome, so the ordering is stated policy
 * rather than an accident of insertion order:
 *
 *   1. clinical priority (stat, then urgent, then routine),
 *   2. then how long they have waited, from when they first asked —
 *      being bumped does not reset it,
 *   3. then how many times a cancelled visit has already bumped them.
 *
 * Cancelling a visit moves its booked patients onto the waitlist itself,
 * with the bump counted. A patient bumped three times is visible, the way a
 * referral loop that never closes is visible, and for the same reason.
 *
 * ## An offer is an action with an outcome
 *
 * A seat is offered to a specific waiting patient and the offer resolves as
 * accepted, declined, or unreachable — never a silent assignment. Unreachable
 * is a real outcome in a community with one phone line and is recorded as
 * itself: collapsing it into "declined" punishes people for where they live.
 * The offer records where the seat is, in words, because "next available"
 * across communities is not useful if it means a seat 900 km away and nobody
 * said so.
 */
import { randomUUID } from "node:crypto";
import type { Db } from "../db.ts";
import { Refusal } from "../core/refusal.ts";
import { Schedule, PRIORITY_RANK, SlotFull, type Actor, type BookingRow, type Priority, type SlotRow } from "./store.ts";

export type VisitStatus = "planned" | "cancelled";
export type WaitlistStatus = "waiting" | "offered" | "booked" | "removed";
/**
 * `lapsed` is never asked for — it is recorded when acceptance failed because
 * the seat was taken while the offer was out. The patient did nothing, and an
 * offer closed as declined-or-unreachable when they said yes would be a lie
 * with their name on it.
 */
export type OfferOutcome = "accepted" | "declined" | "unreachable" | "lapsed";

export interface VisitRow {
  tenant_id: string;
  id: string;
  resource_id: string;
  resource_kind: string;
  service: string;
  community: string;
  starts_on: string;
  ends_on: string;
  status: VisitStatus;
  cancelled_at: string | null;
  cancelled_by: string | null;
  cancel_reason: string | null;
  created_by: string;
  created_at: string;
}

export interface WaitlistRow {
  tenant_id: string;
  id: string;
  service: string;
  patient_id: string;
  priority: Priority;
  reason: string;
  community: string | null;
  referral_id: string | null;
  status: WaitlistStatus;
  bump_count: number;
  added_by: string;
  added_at: string;
  removed_at: string | null;
  removed_by: string | null;
  removed_reason: string | null;
  created_at: string;
}

export interface OfferRow {
  /** Ledger order: the sequence offers were made in, whatever the clock says. */
  seq: number;
  tenant_id: string;
  id: string;
  waitlist_id: string;
  slot_id: string;
  place: string;
  made_by: string;
  made_at: string;
  outcome: OfferOutcome | null;
  outcome_at: string | null;
  outcome_by: string | null;
  note: string | null;
}

/** One day of a visit's pattern: local times within that day. */
export interface VisitDay {
  /** The calendar date, as YYYY-MM-DD. */
  date: string;
  /** First slot's start, as HH:MM (UTC — the engine invents no timezone). */
  from: string;
  /** No slot starts at or after this, as HH:MM. */
  to: string;
}

export class Clinics {
  private db: Db;
  private schedule: Schedule;

  constructor(db: Db) {
    this.db = db;
    this.schedule = new Schedule(db);
  }

  // ---- visits ------------------------------------------------------------

  /**
   * Plans a visit: the block of slots, created as one thing.
   *
   * Days are concrete dates rather than a recurrence rule, because the
   * northern calendar this exists for is a plane schedule. The slots come
   * back as ordinary rows — bookable, guarded by the unique index, listed in
   * the diary — with only `visit_id` saying where they came from.
   */
  planVisit(input: {
    resourceId: string;
    resourceKind?: string;
    service: string;
    community: string;
    days: VisitDay[];
    slotMinutes: number;
    capacity?: number;
    by: Actor;
  }): { visit: VisitRow; slots: SlotRow[] } {
    if (input.days.length === 0) throw new Error("a visit needs at least one day");
    if (!input.community.trim()) {
      throw new Error("a visit needs a community: an offer cannot be honest about where the seat is otherwise");
    }
    if (!Number.isInteger(input.slotMinutes) || input.slotMinutes < 5) {
      throw new Error("slotMinutes must be a whole number of at least 5");
    }
    const days = [...input.days].sort((a, b) => a.date.localeCompare(b.date));
    return this.db.transaction(() => {
      const id = randomUUID();
      const now = new Date().toISOString();
      this.db.sql
        .prepare(
          `INSERT INTO schedule_visits
             (tenant_id, id, resource_id, resource_kind, service, community, starts_on, ends_on,
              status, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'planned', ?, ?)`
        )
        .run(
          this.db.tenantId,
          id,
          input.resourceId,
          input.resourceKind ?? "practitioner",
          input.service,
          input.community,
          days[0].date,
          days[days.length - 1].date,
          input.by.actorId,
          now
        );

      const slots: SlotRow[] = [];
      for (const day of days) {
        for (const startsAt of dayStarts(day, input.slotMinutes)) {
          const endsAt = new Date(new Date(startsAt).getTime() + input.slotMinutes * 60_000).toISOString();
          const slot = this.schedule.openSlot({
            resourceId: input.resourceId,
            resourceKind: input.resourceKind ?? "practitioner",
            service: input.service,
            startsAt,
            endsAt,
            ...(input.capacity ? { capacity: input.capacity } : {}),
          });
          this.db.sql
            .prepare("UPDATE schedule_slots SET visit_id = ? WHERE tenant_id = ? AND id = ?")
            .run(id, this.db.tenantId, slot.id);
          slots.push({ ...slot, visit_id: id } as SlotRow);
        }
      }
      return { visit: this.visit(id)!, slots };
    });
  }

  /**
   * Plans the next visit as a copy of a previous one, shifted to new dates.
   *
   * "The same as last time" is the operation a monthly clinic actually
   * performs, and re-deriving twenty slots by hand every month is how the
   * pattern quietly drifts. The day *pattern* is copied — spacing between
   * days, hours within each day, slot length, capacity — anchored on the new
   * first day.
   */
  repeatVisit(visitId: string, input: { firstDay: string; by: Actor }): { visit: VisitRow; slots: SlotRow[] } {
    const prior = this.requireVisit(visitId);
    const priorSlots = this.slotsOf(visitId);
    if (priorSlots.length === 0) throw new Error("that visit has no slots to repeat");

    const slotMinutes = Math.round(
      (new Date(priorSlots[0].ends_at).getTime() - new Date(priorSlots[0].starts_at).getTime()) / 60_000
    );
    const baseDay = new Date(`${prior.starts_on}T00:00:00.000Z`).getTime();
    const anchor = new Date(`${input.firstDay}T00:00:00.000Z`).getTime();
    if (Number.isNaN(anchor)) throw new Error("firstDay must be a date, as YYYY-MM-DD");

    // Rebuild the day pattern from what actually ran, not from what was asked
    // for: the previous plan may have been edited slot by slot, and the copy
    // should carry the edits.
    const byDay = new Map<string, SlotRow[]>();
    for (const s of priorSlots) {
      const day = s.starts_at.slice(0, 10);
      byDay.set(day, [...(byDay.get(day) ?? []), s]);
    }
    const days: VisitDay[] = [...byDay.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([day, slots]) => {
        const starts = slots.map((s) => s.starts_at).sort();
        const offsetDays = Math.round((new Date(`${day}T00:00:00.000Z`).getTime() - baseDay) / 86_400_000);
        const newDate = new Date(anchor + offsetDays * 86_400_000).toISOString().slice(0, 10);
        const last = starts[starts.length - 1];
        return {
          date: newDate,
          from: starts[0].slice(11, 16),
          // `to` excludes the boundary, so the last slot's start must sit
          // inside it: one minute past reproduces exactly the slots that ran.
          to: plusOneMinute(last.slice(11, 16)),
        };
      });

    return this.planVisit({
      resourceId: prior.resource_id,
      resourceKind: prior.resource_kind,
      service: prior.service,
      community: prior.community,
      days,
      slotMinutes,
      capacity: priorSlots[0].capacity,
      by: input.by,
    });
  }

  /**
   * Cancels a visit as one act, and says what happened to every booking.
   *
   * The weather case. Each booked patient's booking is cancelled with the
   * common cause on it, and the patient lands on the waitlist for the service
   * with the bump counted — an existing waiting entry is bumped rather than
   * duplicated, and keeps its original added_at, so being bumped never costs
   * a patient their place in the queue. The visit's unbooked slots are
   * blocked rather than deleted: the clinic that was supposed to run is what
   * a capacity report is made of.
   */
  cancelVisit(
    visitId: string,
    by: Actor & { reason: string }
  ): { visit: VisitRow; bumped: Array<{ booking: BookingRow; waitlistId: string; bumpCount: number }> } {
    if (!by.reason.trim()) throw new Error("cancelling a visit needs a reason");
    return this.db.transaction(() => {
      const visit = this.requireVisit(visitId);
      if (visit.status === "cancelled") throw new Error("that visit is already cancelled");

      // Every live booking is cancelled, but the bump is counted per patient:
      // a patient holding two seats on the visit lost one visit, not two, and
      // the stated policy counts cancelled visits. Their strongest booking is
      // the one that carries priority and referral onto the waitlist.
      const cancelledByPatient = new Map<string, BookingRow[]>();
      for (const slot of this.slotsOf(visitId)) {
        for (const b of this.schedule.liveBookings(slot.id)) {
          const cancelled = this.schedule.cancel(b.id, {
            ...by,
            reason: `visit cancelled: ${by.reason}`,
          });
          cancelledByPatient.set(cancelled.patient_id, [
            ...(cancelledByPatient.get(cancelled.patient_id) ?? []),
            cancelled,
          ]);
        }
        if (slot.status === "open") {
          this.schedule.blockSlot(slot.id, `visit cancelled: ${by.reason}`);
        }
      }
      const bumped: Array<{ booking: BookingRow; waitlistId: string; bumpCount: number }> = [];
      for (const bookings of cancelledByPatient.values()) {
        const strongest = [...bookings].sort(
          (a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
        )[0];
        const entry = this.bumpOntoWaitlist(strongest, visit, by);
        for (const booking of bookings) {
          bumped.push({ booking, waitlistId: entry.id, bumpCount: entry.bump_count });
        }
      }

      this.db.sql
        .prepare(
          `UPDATE schedule_visits SET status = 'cancelled', cancelled_at = ?, cancelled_by = ?, cancel_reason = ?
            WHERE tenant_id = ? AND id = ?`
        )
        .run(new Date().toISOString(), by.actorId, by.reason, this.db.tenantId, visitId);
      return { visit: this.visit(visitId)!, bumped };
    });
  }

  /**
   * Moves a whole visit, bookings intact, and returns who has to be told.
   *
   * The plane comes Thursday instead of Tuesday. Every slot shifts by the
   * same amount, every booking stays on its seat, and every affected patient
   * comes back in the result — with an event on the booking — because a
   * rescheduled appointment nobody was told about is a did-not-attend the
   * clinic caused.
   */
  rescheduleVisit(
    visitId: string,
    input: { toFirstDay: string; by: Actor; reason: string }
  ): { visit: VisitRow; toTell: BookingRow[] } {
    if (!input.reason.trim()) throw new Error("moving a visit needs a reason; twenty patients will be told it");
    return this.db.transaction(() => {
      const visit = this.requireVisit(visitId);
      if (visit.status === "cancelled") throw new Error("a cancelled visit cannot be moved; plan a new one");
      const anchor = new Date(`${input.toFirstDay}T00:00:00.000Z`).getTime();
      if (Number.isNaN(anchor)) throw new Error("toFirstDay must be a date, as YYYY-MM-DD");
      const deltaMs = anchor - new Date(`${visit.starts_on}T00:00:00.000Z`).getTime();

      const toTell: BookingRow[] = [];
      for (const slot of this.slotsOf(visitId)) {
        const startsAt = new Date(new Date(slot.starts_at).getTime() + deltaMs).toISOString();
        const endsAt = new Date(new Date(slot.ends_at).getTime() + deltaMs).toISOString();
        this.db.sql
          .prepare("UPDATE schedule_slots SET starts_at = ?, ends_at = ? WHERE tenant_id = ? AND id = ?")
          .run(startsAt, endsAt, this.db.tenantId, slot.id);
        for (const b of this.schedule.liveBookings(slot.id)) {
          this.db.sql
            .prepare(
              `INSERT INTO schedule_events (tenant_id, booking_id, at, event, actor_id, actor_kind, detail)
               VALUES (?, ?, ?, 'visit-rescheduled', ?, ?, ?)`
            )
            .run(
              this.db.tenantId,
              b.id,
              new Date().toISOString(),
              input.by.actorId,
              input.by.actorKind,
              `moved to ${startsAt}: ${input.reason}`
            );
          toTell.push(this.schedule.booking(b.id)!);
        }
      }

      const shiftDay = (d: string): string => new Date(new Date(`${d}T00:00:00.000Z`).getTime() + deltaMs).toISOString().slice(0, 10);
      this.db.sql
        .prepare("UPDATE schedule_visits SET starts_on = ?, ends_on = ? WHERE tenant_id = ? AND id = ?")
        .run(shiftDay(visit.starts_on), shiftDay(visit.ends_on), this.db.tenantId, visitId);
      return { visit: this.visit(visitId)!, toTell };
    });
  }

  visit(id: string): VisitRow | undefined {
    return this.db.sql
      .prepare("SELECT * FROM schedule_visits WHERE tenant_id = ? AND id = ?")
      .get(this.db.tenantId, id) as unknown as VisitRow | undefined;
  }

  visits(opts: { service?: string; from?: string; includeCancelled?: boolean } = {}): VisitRow[] {
    const args: unknown[] = [this.db.tenantId];
    let sql = "SELECT * FROM schedule_visits WHERE tenant_id = ?";
    if (!opts.includeCancelled) sql += " AND status != 'cancelled'";
    if (opts.service) {
      sql += " AND service = ?";
      args.push(opts.service);
    }
    if (opts.from) {
      sql += " AND ends_on >= ?";
      args.push(opts.from);
    }
    sql += " ORDER BY starts_on";
    return this.db.sql.prepare(sql).all(...(args as never[])) as unknown as VisitRow[];
  }

  slotsOf(visitId: string): SlotRow[] {
    return this.db.sql
      .prepare("SELECT * FROM schedule_slots WHERE tenant_id = ? AND visit_id = ? ORDER BY starts_at")
      .all(this.db.tenantId, visitId) as unknown as SlotRow[];
  }

  // ---- the waitlist ------------------------------------------------------

  addToWaitlist(input: {
    service: string;
    patientId: string;
    reason: string;
    by: Actor;
    priority?: Priority;
    community?: string;
    referralId?: string;
  }): WaitlistRow {
    if (!input.reason.trim()) throw new Error("a waitlist entry needs a reason; a list that has to be cut cannot be triaged without one");
    const existing = this.liveEntryFor(input.patientId, input.service);
    if (existing) {
      throw new Error(`this patient is already ${existing.status} on the ${input.service} waitlist (${existing.id})`);
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.sql
      .prepare(
        `INSERT INTO schedule_waitlist
           (tenant_id, id, service, patient_id, priority, reason, community, referral_id,
            status, bump_count, added_by, added_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'waiting', 0, ?, ?, ?)`
      )
      .run(
        this.db.tenantId,
        id,
        input.service,
        input.patientId,
        input.priority ?? "routine",
        input.reason,
        input.community ?? null,
        input.referralId ?? null,
        input.by.actorId,
        now,
        now
      );
    return this.entry(id)!;
  }

  /**
   * Who is waiting, in the order the seats should be offered.
   *
   * The ordering is the policy in the module docstring — priority, then
   * waited-longest from first asking, then most-bumped — and it lives in one
   * place on purpose: an ordering assembled ad hoc at each call site is how a
   * policy nobody agreed to gets invented by accident.
   */
  waitlist(service: string): WaitlistRow[] {
    const rows = this.db.sql
      .prepare(
        `SELECT * FROM schedule_waitlist
          WHERE tenant_id = ? AND service = ? AND status IN ('waiting', 'offered')`
      )
      .all(this.db.tenantId, service) as unknown as WaitlistRow[];
    return rows.sort(
      (a, b) =>
        PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
        a.added_at.localeCompare(b.added_at) ||
        b.bump_count - a.bump_count ||
        // Arbitrary but stable, so a full tie renders the same list twice.
        a.id.localeCompare(b.id)
    );
  }

  removeFromWaitlist(id: string, by: Actor & { reason: string }): WaitlistRow {
    if (!by.reason.trim()) throw new Error("removing somebody from a waitlist needs a reason");
    return this.db.transaction(() => {
      const entry = this.requireEntry(id);
      if (entry.status === "booked" || entry.status === "removed") {
        throw new Error(`a ${entry.status} entry cannot be removed`);
      }
      // An open offer does not survive the entry it was made against. Left
      // open, resolving it later would write the entry back to 'waiting' or
      // book a patient somebody removed — resurrection by paperwork. Lapsed
      // is the honest closing: the offer ended through no act of the patient.
      this.db.sql
        .prepare(
          `UPDATE schedule_offers SET outcome = 'lapsed', outcome_at = ?, outcome_by = ?, note = ?
            WHERE tenant_id = ? AND waitlist_id = ? AND outcome IS NULL`
        )
        .run(new Date().toISOString(), by.actorId, `removed from the waitlist: ${by.reason}`, this.db.tenantId, id);
      this.db.sql
        .prepare(
          `UPDATE schedule_waitlist SET status = 'removed', removed_at = ?, removed_by = ?, removed_reason = ?
            WHERE tenant_id = ? AND id = ?`
        )
        .run(new Date().toISOString(), by.actorId, by.reason, this.db.tenantId, id);
      return this.entry(id)!;
    });
  }

  entry(id: string): WaitlistRow | undefined {
    return this.db.sql
      .prepare("SELECT * FROM schedule_waitlist WHERE tenant_id = ? AND id = ?")
      .get(this.db.tenantId, id) as unknown as WaitlistRow | undefined;
  }

  // ---- offers ------------------------------------------------------------

  /**
   * Offers one seat to one waiting patient.
   *
   * The offer names where the seat is. When the entry records the patient's
   * community and the seat is somewhere else, the place says both — the
   * conversation about travel belongs before acceptance, not at the airport.
   */
  offerSeat(input: { waitlistId: string; slotId: string; by: Actor }): OfferRow {
    return this.db.transaction(() => {
      const entry = this.requireEntry(input.waitlistId);
      if (entry.status !== "waiting") {
        throw new Error(
          entry.status === "offered"
            ? "this patient already has an offer out; resolve it first"
            : `a ${entry.status} entry cannot be offered a seat`
        );
      }
      const slot = this.schedule.slot(input.slotId);
      if (!slot) throw new Error(`no slot ${input.slotId}`);
      if (slot.status === "blocked") throw new Error("that slot is blocked");
      // The queue being cleared must be the queue for these seats. Offering a
      // cardiology wait a dermatology slot empties the wrong list against the
      // wrong capacity, and both lists then lie about how long they are.
      if (slot.service !== entry.service) {
        throw new Error(
          `that seat is for ${slot.service}; this patient is waiting for ${entry.service}`
        );
      }
      if (this.schedule.liveBookings(slot.id).length >= slot.capacity) {
        throw new Error("that slot has no seat free");
      }

      const visit = slot.visit_id ? this.visit(slot.visit_id) : undefined;
      const where = visit ? `${visit.community}` : slot.resource_id;
      const place =
        entry.community && visit && entry.community !== visit.community
          ? `${where} — patient is in ${entry.community}`
          : where;

      const id = randomUUID();
      this.db.sql
        .prepare(
          `INSERT INTO schedule_offers (tenant_id, id, waitlist_id, slot_id, place, made_by, made_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(this.db.tenantId, id, entry.id, slot.id, place, input.by.actorId, new Date().toISOString());
      this.db.sql
        .prepare("UPDATE schedule_waitlist SET status = 'offered' WHERE tenant_id = ? AND id = ?")
        .run(this.db.tenantId, entry.id);
      return this.offer(id)!;
    });
  }

  /**
   * What came of an offer.
   *
   * Accepted books the seat then and there — through `book()`, so the unique
   * index still guards it, and a seat taken while the offer was out surfaces
   * as the refusal it is rather than a double booking. Declined and
   * unreachable both return the patient to the queue with their place kept,
   * and are recorded as the different facts they are.
   */
  resolveOffer(
    offerId: string,
    input: { outcome: "accepted" | "declined" | "unreachable"; by: Actor; note?: string }
  ): { offer: OfferRow; booking?: BookingRow } {
    const result = this.db.transaction(() => {
      const offer = this.requireOffer(offerId);
      if (offer.outcome) throw new Error(`that offer was already ${offer.outcome}`);
      const entry = this.requireEntry(offer.waitlist_id);
      // Backstops against resurrection by paperwork. Removal closes open
      // offers itself, so reaching either of these means a path nobody
      // predicted — and the safe answer is still to refuse rather than to
      // write a removed patient back into the queue or book them twice.
      if (entry.status === "removed") {
        throw new Refusal("this patient was removed from the waitlist; the offer cannot be resolved", 409);
      }
      if (input.outcome === "accepted" && entry.status === "booked") {
        throw new Refusal("this patient was already booked through an earlier offer", 409);
      }

      let booking: BookingRow | undefined;
      let outcome: OfferOutcome = input.outcome;
      let note = input.note ?? null;
      let refused: Refusal | undefined;
      if (input.outcome === "accepted") {
        // A seat on a visit that was cancelled while the offer was out is the
        // same event as a seat somebody else took: the offer lapses, the
        // patient keeps their place, and the operator mid-phone-call is told
        // the yes did not stick. Without this, acceptance hits the generic
        // blocked-slot error, the transaction rolls back, and the entry is
        // wedged in 'offered' — the exact wedge the lapsed path exists to
        // close, reached by the other door.
        const seat = this.schedule.slot(offer.slot_id);
        if (seat && seat.status === "blocked") {
          refused = new Refusal(`that seat is no longer available: ${seat.block_reason ?? "the slot was blocked"}`, 409);
          outcome = "lapsed";
          note = `seat was withdrawn while the offer was out: ${seat.block_reason ?? "slot blocked"}`;
        } else {
          try {
            booking = this.schedule.book({
              slotId: offer.slot_id,
              patientId: entry.patient_id,
              reason: entry.reason,
              by: input.by,
              priority: entry.priority,
              ...(entry.referral_id ? { referralId: entry.referral_id } : {}),
            });
          } catch (err) {
            if (!(err instanceof SlotFull)) throw err;
            refused = err;
            outcome = "lapsed";
            note = "seat was taken while the offer was out";
          }
        }
      }
      // 'offered' is the only state this resolution owns. A bump can have
      // already returned the entry to 'waiting' with the offer still out, and
      // a decline recorded afterwards must not overwrite what the bump did.
      this.db.sql
        .prepare(
          booking
            ? "UPDATE schedule_waitlist SET status = 'booked' WHERE tenant_id = ? AND id = ?"
            : "UPDATE schedule_waitlist SET status = 'waiting' WHERE tenant_id = ? AND id = ? AND status = 'offered'"
        )
        .run(this.db.tenantId, entry.id);
      this.db.sql
        .prepare(
          `UPDATE schedule_offers SET outcome = ?, outcome_at = ?, outcome_by = ?, note = ?
            WHERE tenant_id = ? AND id = ?`
        )
        .run(outcome, new Date().toISOString(), input.by.actorId, note, this.db.tenantId, offerId);
      return { offer: this.offer(offerId)!, ...(booking ? { booking } : {}), refused };
    });
    if (result.refused) throw result.refused;
    const { refused: _refused, ...out } = result;
    return out;
  }

  offer(id: string): OfferRow | undefined {
    return this.db.sql
      .prepare("SELECT * FROM schedule_offers WHERE tenant_id = ? AND id = ?")
      .get(this.db.tenantId, id) as unknown as OfferRow | undefined;
  }

  /**
   * Every offer ever made against one waitlist entry, in the order they were
   * made. By the ledger, not the clock: two offers in one millisecond share a
   * `made_at`, and a history that presents events in an order the sort
   * happened to pick is the accident this module exists to refuse.
   */
  offersFor(waitlistId: string): OfferRow[] {
    return this.db.sql
      .prepare("SELECT * FROM schedule_offers WHERE tenant_id = ? AND waitlist_id = ? ORDER BY seq")
      .all(this.db.tenantId, waitlistId) as unknown as OfferRow[];
  }

  // ---- internals ---------------------------------------------------------

  private bumpOntoWaitlist(booking: BookingRow, visit: VisitRow, by: Actor): WaitlistRow {
    // A booked entry whose seat has just been taken back is the same wait,
    // resumed — not a new person joining the queue. Reviving it is what keeps
    // the bump count and the original added_at on one row, which is the whole
    // point of both.
    const existing =
      this.liveEntryFor(booking.patient_id, visit.service) ?? this.bookedEntryFor(booking.patient_id, visit.service);
    if (existing) {
      // Their place in the queue is their original added_at; the bump is
      // counted, never the clock reset. An offered entry goes back to waiting
      // — the seat that was offered may be on the visit being cancelled.
      this.db.sql
        .prepare(
          `UPDATE schedule_waitlist SET bump_count = bump_count + 1, status = 'waiting'
            WHERE tenant_id = ? AND id = ?`
        )
        .run(this.db.tenantId, existing.id);
      return this.entry(existing.id)!;
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.sql
      .prepare(
        `INSERT INTO schedule_waitlist
           (tenant_id, id, service, patient_id, priority, reason, community, referral_id,
            status, bump_count, added_by, added_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 'waiting', 1, ?, ?, ?)`
      )
      .run(
        this.db.tenantId,
        id,
        visit.service,
        booking.patient_id,
        booking.priority,
        booking.reason,
        booking.referral_id,
        by.actorId,
        // Their wait started when they booked, not when the weather turned.
        booking.booked_at,
        now
      );
    return this.entry(id)!;
  }

  private bookedEntryFor(patientId: string, service: string): WaitlistRow | undefined {
    return this.db.sql
      .prepare(
        `SELECT * FROM schedule_waitlist
          WHERE tenant_id = ? AND patient_id = ? AND service = ? AND status = 'booked'
          ORDER BY added_at DESC LIMIT 1`
      )
      .get(this.db.tenantId, patientId, service) as unknown as WaitlistRow | undefined;
  }

  private liveEntryFor(patientId: string, service: string): WaitlistRow | undefined {
    return this.db.sql
      .prepare(
        `SELECT * FROM schedule_waitlist
          WHERE tenant_id = ? AND patient_id = ? AND service = ? AND status IN ('waiting', 'offered')`
      )
      .get(this.db.tenantId, patientId, service) as unknown as WaitlistRow | undefined;
  }

  private requireVisit(id: string): VisitRow {
    const v = this.visit(id);
    if (!v) throw new Refusal(`no visit ${id}`, 404);
    return v;
  }

  private requireEntry(id: string): WaitlistRow {
    const e = this.entry(id);
    if (!e) throw new Refusal(`no waitlist entry ${id}`, 404);
    return e;
  }

  private requireOffer(id: string): OfferRow {
    const o = this.offer(id);
    if (!o) throw new Refusal(`no offer ${id}`, 404);
    return o;
  }
}

/** Slot start times for one day of a visit, as ISO instants. */
function dayStarts(day: VisitDay, slotMinutes: number): string[] {
  const from = new Date(`${day.date}T${day.from}:00.000Z`).getTime();
  const to = new Date(`${day.date}T${day.to}:00.000Z`).getTime();
  if (Number.isNaN(from) || Number.isNaN(to)) {
    throw new Error(`day ${day.date} has an unreadable window (${day.from}–${day.to})`);
  }
  if (to <= from) throw new Error(`day ${day.date} ends before it starts (${day.from}–${day.to})`);
  const out: string[] = [];
  for (let t = from; t < to; t += slotMinutes * 60_000) {
    out.push(new Date(t).toISOString());
  }
  return out;
}

function plusOneMinute(hhmm: string): string {
  const d = new Date(`2000-01-01T${hhmm}:00.000Z`);
  d.setUTCMinutes(d.getUTCMinutes() + 1);
  return d.toISOString().slice(11, 16);
}
