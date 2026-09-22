/**
 * The clinic as it is right now, for the people running it.
 *
 * `Workspace.worklist()` answers "what does this clinician owe somebody" —
 * results to acknowledge, referrals gone quiet, orders nobody sent. That is
 * a queue of obligations and it is the right shape for a chart-facing view.
 * It is the wrong shape for the front desk, which needs a different question
 * answered: who is here, how long have they been here, which rooms are free,
 * and who has fallen through.
 *
 * ## The one thing this must not do
 *
 * A waiting-room board hangs on a wall. Everybody in the room can read it,
 * including the person's neighbour, their ex-partner, and whoever is waiting
 * for somebody else. A board naming patients is a disclosure to a room, made
 * continuously, to an audience nobody recorded — and it is the most ordinary
 * feature in this file, which is what makes it dangerous.
 *
 * So there are two renderings and one source. `waiting()` is for staff at an
 * authenticated screen and names people. `publicBoard()` is for the wall: a
 * short token the patient was given at the desk, a state, and nothing else.
 * The public shape is built by *construction* rather than by omission — it
 * has no field a name could be put in — because a redaction somebody has to
 * remember is a redaction somebody eventually forgets.
 *
 * ## Why an item is where it is
 *
 * Every ordering here states its reason on the row rather than leaving it to
 * be inferred from the sort. Staff argue about the order of a waiting room,
 * and "it is sorted by how late we are running" is a sentence somebody can
 * agree or disagree with; a list with no stated rule is one they work around.
 *
 * ## What is deliberately not here
 *
 * Intake status needs a pre-visit intake workflow that does not exist yet. A
 * panel built on a workflow that is not there is an empty panel
 * indistinguishable from a quiet day, so it is absent rather than empty.
 *
 * Recently-discharged patients and unaccepted handoffs *were* absent for the
 * same reason and are now here, because the workflow underneath them exists.
 */
import type { BookingRow, SlotRow } from "../schedule/store.ts";
import { ClinicDay } from "../schedule/clinic-day.ts";
import type { EncounterRow } from "../clinical/encounters.ts";
import type { TaskRow } from "../work/tasks.ts";
import type { DischargeItemRow, DischargeRow, HandoffRow } from "../work/discharge.ts";

/**
 * Where somebody is in a visit.
 *
 * Derived rather than stored, from two records that already exist: the
 * booking says they are expected, the encounter says the desk has seen them.
 *
 * `arrived` and `with-clinician` are the same encounter status underneath —
 * the model has one `in-progress` covering both — so this reports `arrived`
 * and says in `progressKnown` that it cannot tell them apart. Inventing the
 * distinction would put "with the doctor" on a board for somebody sitting in
 * the waiting room, which is exactly the number the front desk is being asked
 * about.
 */
export type VisitState = "expected" | "arrived" | "finished" | "did-not-attend";

export interface WaitingRow {
  bookingId: string;
  patientId: string;
  /** The token the patient was handed at the desk. Short, per visit, not a chart number. */
  token: string;
  state: VisitState;
  /** When they were due, so lateness is the reader's arithmetic and not this module's opinion. */
  dueAt: string;
  /** Minutes past the appointment time. Negative before it. */
  waitingMinutes: number;
  resourceId: string | null;
  service: string;
  priority: BookingRow["priority"];
  /** Why this row is where it is in the list. Stated, not inferred. */
  because: string;
  /**
   * False when `arrived` cannot be told apart from `with-clinician`, which is
   * always, until the encounter model grows the distinction.
   */
  progressKnown: boolean;
}

/** The wall-mounted shape. There is no field here a name could go in. */
export interface PublicRow {
  token: string;
  state: VisitState;
  waitingMinutes: number;
}

export interface ResourceRow {
  resourceId: string;
  kind: string;
  /** Slots today, and how many of them are spoken for. */
  slots: number;
  booked: number;
  free: number;
  /** The next slot with a seat, or null when there is none left today. */
  nextFreeAt: string | null;
  because: string;
}

import type { SubmissionRow as IntakeSubmissionRow } from "../patient/intake.ts";

export interface BoardSources {
  schedule: {
    diary(resourceId: string, from: string, to: string): Array<{ slot: SlotRow; bookings: BookingRow[] }>;
    resourcesWithSlots?(from: string, to: string): Array<{ resourceId: string; kind: string }>;
  };
  encounters: {
    forPatient(patientId: string, opts?: { includeCancelled?: boolean; limit?: number }): EncounterRow[];
  };
  tasks: {
    /** Every live task of one kind, owned or not — see TaskStore.openOfKind. */
    openOfKind(kind: "patient-contact", opts?: { limit?: number }): TaskRow[];
    /** Counts across the whole queue — see TaskStore.load. */
    load?(): { open: number; unassigned: number; overdue: number; byKind: Record<string, number> };
  };
  /**
   * Optional, like `resourcesWithSlots`: a deployment that has not wired
   * intake gets no intake panel rather than an empty one, for the reason
   * stated on `attention()` — an empty panel and a quiet day look the same.
   */
  intake?: {
    /** Submitted and not yet reviewed — see IntakeSubmissions.open. */
    open(): IntakeSubmissionRow[];
    /** Which of these appointments already have one — see submittedForAppointments. */
    submittedForAppointments(appointmentIds: string[]): Set<string>;
  };
  discharges: {
    openFollowUps(opts?: { accountableId?: string }): DischargeRow[];
    overdue(olderThanHours: number, asOf?: Date): DischargeRow[];
    items(dischargeId: string): DischargeItemRow[];
  };
  handoffs: {
    // Carries `lapsed`, so a board can distinguish an offer still waiting on
    // an answer from one that can no longer be accepted. Dropping it here
    // would leave the field present at runtime and invisible to every typed
    // caller, which is the same as not having added it.
    unaccepted(opts?: { olderThanHours?: number }, asOf?: Date): Array<HandoffRow & { lapsed: boolean }>;
    activeCoverage(asOf?: Date): HandoffRow[];
  };
}

/**
 * A per-visit token.
 *
 * Derived from the booking id so it is stable for one visit and different for
 * the next, which is what makes it useless to somebody reading the board on
 * two different days. Four characters from a hash rather than a counter: a
 * counter tells the room how many people are ahead of you, which is a fact
 * about somebody else.
 *
 * Not a secret and not trying to be. It is a handle for calling somebody
 * forward without saying their name out loud, which is the job.
 */
export function visitToken(bookingId: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bookingId.length; i++) {
    h ^= bookingId.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  // Ambiguous glyphs left out: a board is read across a room, and 0/O and
  // 1/I/L are the pairs somebody gets wrong from six metres away.
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 4; i++) {
    out += alphabet[h % alphabet.length];
    h = Math.floor(h / alphabet.length) + 7919;
  }
  return out;
}

export interface BoardOptions {
  /**
   * Which instants are "today" at the clinic. Absent means UTC, which is what
   * it was before a clinic could say where it is. See schedule/clinic-day.ts
   * and H-211: for a clinic west of UTC the UTC day is the wrong day for part
   * of every day, and it is the same calendar the worklist uses, so the two
   * cannot disagree about who is expected.
   */
  clinicDay?: ClinicDay;
}

export class ClinicBoard {
  private sources: BoardSources;
  private clinicDay: ClinicDay;

  constructor(sources: BoardSources, options: BoardOptions = {}) {
    this.sources = sources;
    this.clinicDay = options.clinicDay ?? ClinicDay.utc();
  }

  /**
   * Who is expected and who is here, for a screen only staff can see.
   *
   * Ordered by how far past their appointment time somebody is, then by
   * priority — the longest-waiting first, because that is the question the
   * front desk is actually being asked, and because ordering by booking time
   * alone rewards a clinic for running late on the people who arrived early.
   */
  waiting(resourceIds: string[], asOf = new Date()): WaitingRow[] {
    const { from, to } = this.clinicDay.window(asOf);

    const rows: WaitingRow[] = [];
    for (const resourceId of resourceIds) {
      for (const { slot, bookings } of this.sources.schedule.diary(resourceId, from, to)) {
        // `diary()` returns live bookings, so a cancelled one never arrives
        // here. Filtering again would read as a check this makes and is not
        // one; the end-to-end property is asserted in the tests instead.
        for (const booking of bookings) {
          const state = this.stateOf(booking, slot, asOf);
          const waitingMinutes = Math.round((asOf.getTime() - Date.parse(slot.starts_at)) / 60_000);
          rows.push({
            bookingId: booking.id,
            patientId: booking.patient_id,
            token: visitToken(booking.id),
            state,
            dueAt: slot.starts_at,
            waitingMinutes,
            resourceId: slot.resource_id,
            service: slot.service,
            priority: booking.priority,
            because: reasonFor(state, waitingMinutes, booking.priority),
            // Always false today. The encounter model has one in-progress
            // state covering both "sitting in the waiting room" and "in the
            // room with a clinician", and a board that guessed would put the
            // second on the wall for somebody doing the first.
            progressKnown: false,
          });
        }
      }
    }

    return rows.sort(
      (a, b) =>
        rank(a.state) - rank(b.state) ||
        PRIORITY[a.priority] - PRIORITY[b.priority] ||
        b.waitingMinutes - a.waitingMinutes ||
        a.bookingId.localeCompare(b.bookingId)
    );
  }

  /**
   * The same board with nobody's name on it.
   *
   * Built by construction: the returned rows have three fields and none of
   * them can hold an identifier. A version that took the staff rows and
   * deleted the name would be one refactor away from putting it back, and
   * the failure would be silent and continuous — a wall in a room full of
   * people.
   *
   * Finished visits drop off. Somebody who has left does not need to be on a
   * wall, and a token that stays up all afternoon is one somebody can watch
   * to learn how long a particular person was in with a clinician.
   */
  publicBoard(resourceIds: string[], asOf = new Date()): PublicRow[] {
    return this.waiting(resourceIds, asOf)
      .filter((r) => r.state === "expected" || r.state === "arrived")
      .map((r) => ({ token: r.token, state: r.state, waitingMinutes: r.waitingMinutes }));
  }

  /** Rooms and people, how much of today is spoken for, and when the next gap is. */
  resources(resourceIds: string[], asOf = new Date()): ResourceRow[] {
    // The same day waiting() uses. It was still the UTC day after the list
    // beside it learned the clinic's, so one board could show an 18:00
    // patient as expected and not count their slot as spoken for.
    const { from, to } = this.clinicDay.window(asOf);

    const out: ResourceRow[] = [];
    for (const resourceId of resourceIds) {
      const diary = this.sources.schedule.diary(resourceId, from, to);
      let slots = 0;
      let booked = 0;
      let nextFreeAt: string | null = null;
      let kind = "unknown";
      for (const { slot, bookings } of diary) {
        if (slot.status === "blocked") continue;
        kind = slot.resource_kind ?? kind;
        slots += slot.capacity;
        const live = bookings.filter((b) => b.status !== "cancelled").length;
        booked += live;
        const free = slot.capacity - live;
        if (free > 0 && Date.parse(slot.starts_at) >= asOf.getTime() && nextFreeAt === null) {
          nextFreeAt = slot.starts_at;
        }
      }
      const free = Math.max(0, slots - booked);
      out.push({
        resourceId,
        kind,
        slots,
        booked,
        free,
        nextFreeAt,
        because:
          slots === 0
            ? "nothing scheduled today, which is not the same as being free"
            : free === 0
              ? `every one of today's ${slots} seats is taken`
              : `${free} of ${slots} seats open${nextFreeAt ? `, next at ${nextFreeAt.slice(11, 16)}` : ""}`,
      });
    }
    return out.sort((a, b) => b.free - a.free || a.resourceId.localeCompare(b.resourceId));
  }

  /**
   * What has fallen through, and who owns it.
   *
   * Today this is the patients nobody could reach — the follow-up tasks the
   * notice machinery opens when every contact point on file is unverified,
   * unconsented or gone. That queue exists precisely so a patient who cannot
   * be told is a piece of work rather than a silence, and a board is where a
   * clinic looks.
   *
   * Unaccepted handoffs, open follow-ups and who is covering arrived with
   * the discharge and handoff workflow, and intake submissions nobody has
   * read arrived with intake. The rule they were written under still holds
   * and is why the intake panel is conditional: a deployment that has not
   * wired a source gets no panel rather than an empty one, because an empty
   * panel and a quiet day look the same, and only one of them is true.
   */
  attention(opts: { staleAfterHours?: number } = {}, asOf = new Date()): {
    unreachablePatients: { rows: TaskRow[]; because: string };
    intakeAwaitingReview?: { rows: IntakeSubmissionRow[]; because: string };
    unacceptedHandoffs: { rows: Array<HandoffRow & { lapsed: boolean }>; because: string };
    openFollowUps: { rows: Array<DischargeRow & { outstanding: number }>; because: string };
    coveringNow: { rows: HandoffRow[]; because: string };
  } {
    const stale = opts.staleAfterHours;
    const followUps = this.sources.discharges.openFollowUps().map((d) => ({
      ...d,
      outstanding: this.sources.discharges.items(d.id).filter((i) => i.status === "outstanding").length,
    }));
    return {
      unreachablePatients: {
        // Owned or not. A task somebody has picked up but not finished is
        // still a patient nobody has managed to tell.
        rows: this.sources.tasks.openOfKind("patient-contact"),
        because: "every contact point on file was unusable, so nobody has been able to tell this patient",
      },
      unacceptedHandoffs: {
        // The sharpest row on this board. Every one of these is work two
        // people may each believe the other is holding.
        rows: this.sources.handoffs.unaccepted(stale === undefined ? {} : { olderThanHours: stale }, asOf),
        because: "offered and not yet answered, so it still belongs to whoever offered it",
      },
      openFollowUps: {
        rows: followUps,
        because: "the visit is over and something from it is not",
      },
      coveringNow: {
        // Not a problem — a fact. Somebody reading this board needs to know
        // who is actually holding a list today, and coverage is invisible
        // otherwise until the moment it matters.
        rows: this.sources.handoffs.activeCoverage(asOf),
        because: "standing in for somebody, until the date they agreed",
      },
      ...(this.sources.intake
        ? {
            intakeAwaitingReview: {
              // The patient did their part. Somebody sat down before their
              // visit and wrote out what they are taking and what has
              // changed, and until a clinician reads it the visit proceeds
              // on what the chart said last time. Oldest first, because a
              // submission that has waited through the appointment it was
              // for has stopped being preparation.
              rows: this.sources.intake.open(),
              because: "the patient submitted this before their visit and nobody has read it yet",
            },
          }
        : {}),
    };
  }

  /**
   * Who is coming in today and has sent nothing to prepare with.
   *
   * The other half of the intake question, and the half that is about the
   * visit rather than the queue. A clinician meets somebody without the
   * medication list and history they would have had, and at a clinic where
   * this visit is the only one for months that is the difference between a
   * consultation and a guess.
   *
   * Asked per appointment rather than per patient, because an intake is
   * preparation for a visit: a form submitted before the last one says
   * nothing about this one. That is only answerable because the portal now
   * records which appointment a form is for; before it did, every
   * submission was attached to nothing and this panel would have named
   * every patient every day.
   *
   * Absent, not empty, when intake is not wired — the rule the rest of this
   * board works under.
   */
  expectedWithoutIntake(
    resourceIds: string[],
    asOf = new Date()
  ): { rows: WaitingRow[]; because: string } | undefined {
    if (!this.sources.intake) return undefined;
    const expected = this.waiting(resourceIds, asOf).filter((r) => r.state === "expected" || r.state === "arrived");
    const have = this.sources.intake.submittedForAppointments(expected.map((r) => r.bookingId));
    return {
      rows: expected.filter((r) => !have.has(r.bookingId)),
      because: "expected today, and nothing was sent in before the visit to read",
    };
  }

  /**
   * How much work is outstanding, and how much of it belongs to nobody.
   *
   * Counts rather than rows: this answers "is the clinic keeping up" for a
   * board header, and the queues themselves are what you open when it says
   * no. `unassigned` is the number worth reading first — an unowned task is
   * not somebody's backlog, it is work nobody has picked up.
   */
  workload(): { open: number; unassigned: number; overdue: number; byKind: Record<string, number>; because: string } | undefined {
    if (!this.sources.tasks.load) return undefined;
    return {
      ...this.sources.tasks.load(),
      because: "open work across the clinic; unassigned is the count nobody has picked up",
    };
  }

  private stateOf(booking: BookingRow, slot: SlotRow, asOf: Date): VisitState {
    if (booking.status === "did-not-attend") return "did-not-attend";
    const encounters = this.sources.encounters.forPatient(booking.patient_id, { limit: 20 });
    const linked = encounters.find((e) => e.booking_id === booking.id);
    if (linked) {
      if (linked.status === "finished") return "finished";
      if (linked.status === "in-progress") return "arrived";
    }
    if (booking.status === "attended") return "arrived";
    // Still expected. Late is not a state of its own: somebody twenty minutes
    // past their time has not arrived, and calling that anything else would
    // hide them among the people who are here.
    void slot;
    void asOf;
    return "expected";
  }
}

const PRIORITY: Record<BookingRow["priority"], number> = { stat: 0, urgent: 1, routine: 2 };

/** Arrived first: they are in the building and the clinic is holding them up. */
function rank(state: VisitState): number {
  switch (state) {
    case "arrived":
      return 0;
    case "expected":
      return 1;
    case "did-not-attend":
      return 2;
    default:
      return 3;
  }
}

function reasonFor(state: VisitState, waitingMinutes: number, priority: BookingRow["priority"]): string {
  if (state === "finished") return "seen";
  if (state === "did-not-attend") return "did not attend";
  const urgency = priority === "routine" ? "" : `${priority} priority, `;
  if (state === "arrived") {
    return waitingMinutes > 0
      ? `${urgency}here and waiting ${waitingMinutes} minutes past their appointment`
      : `${urgency}here, ${Math.abs(waitingMinutes)} minutes early`;
  }
  return waitingMinutes > 0
    ? `${urgency}expected, ${waitingMinutes} minutes ago`
    : `${urgency}expected in ${Math.abs(waitingMinutes)} minutes`;
}
