/**
 * Where a patient has agreed to be reached, and on what terms.
 *
 * The engine has been able to publish a notice onto a channel for some time.
 * What it has never had is anywhere to send one: `patient_index` carries a
 * phone and an email copied out of an ADT feed, which is demographics — what
 * a sending system believes — and not the same thing as an address this
 * clinic has checked and this patient has agreed to.
 *
 * Sending to demographics is how a result notice reaches the number a
 * registration clerk mistyped four years ago, or the ex-partner whose phone
 * is still on the file. So nothing here is usable until two separate people
 * have done two separate things:
 *
 *   - **Verification** is a named clerk writing down how they checked that
 *     this address belongs to this patient. Same shape as clinic-attested
 *     enrolment, and for the same reason: identity is established by a person
 *     who is accountable for it, not by a field arriving on a feed.
 *   - **Consent** is the patient agreeing to be contacted here. Recorded
 *     separately, because it answers a different question. A verified number
 *     nobody asked about is `unasked`, and consent recorded against a number
 *     nobody checked is consent to text a stranger.
 *
 * Both, or nothing goes out. `reachable()` is the only way to find a contact
 * to send to, and it applies both plus withdrawal, retirement and quiet
 * hours in one place, so a caller cannot assemble a send by reading the
 * table itself.
 *
 * ## What a notice may say
 *
 * Nothing clinical, ever — that rule lives in `notice.ts` and predates this
 * (H-116). Contacts do not change it. A phone number is a place a fact can
 * be announced; it is not a place a result can be read.
 *
 * ## Language
 *
 * Nullable, and null means unstated rather than English. A notice sent in a
 * language somebody does not read is a notice that was not sent, and it
 * would be indistinguishable from a deliberate choice if this column had a
 * default.
 */
import { randomUUID } from "node:crypto";
import type { Db } from "../db.ts";
import { refuse } from "../core/refusal.ts";

export type ContactChannel = "sms" | "email";
export type ConsentState = "unasked" | "given" | "withdrawn";
export type ContactStatus = "active" | "retired";

export interface ContactRow {
  tenant_id: string;
  id: string;
  patient_id: string;
  channel: ContactChannel;
  value: string;
  language: string | null;
  verified_at: string | null;
  verified_by: string | null;
  verification_method: string | null;
  consent: ConsentState;
  consent_at: string | null;
  consent_by: string | null;
  quiet_from: string | null;
  quiet_to: string | null;
  timezone: string | null;
  status: ContactStatus;
  retired_at: string | null;
  retired_reason: string | null;
  created_at: string;
}

/** Why a contact cannot be sent to right now. Never a bare false. */
export type Unreachable =
  | "not-verified"
  | "consent-not-given"
  | "consent-withdrawn"
  | "retired"
  | "quiet-hours";

export interface Reachability {
  contact: ContactRow;
  reachable: boolean;
  /** Present when it is not. The caller reports this rather than inventing one. */
  because?: Unreachable;
  /** When quiet hours end, so a caller can hold rather than drop. */
  until?: string;
}

const CHANNELS: ContactChannel[] = ["sms", "email"];
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * How much a clerk has to write about checking an address.
 *
 * The same twelve characters clinic-attested enrolment asks for, and for the
 * same reason: "verified" is not a method, and a field somebody can satisfy
 * by pressing a key records nothing.
 */
const MIN_METHOD = 12;

export class PatientContacts {
  private db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /**
   * Records an address. Unverified, unconsented, and therefore unusable.
   *
   * Deliberately two more steps from here to a notice. Adding an address is
   * clerical; being allowed to send to it is not.
   */
  add(input: {
    patientId: string;
    channel: ContactChannel;
    value: string;
    language?: string;
    quietHours?: { from: string; to: string; timezone: string };
  }): ContactRow {
    if (!CHANNELS.includes(input.channel)) {
      refuse(`unknown contact channel ${input.channel}; expected one of ${CHANNELS.join(", ")}`);
    }
    const value = input.value.trim();
    if (!value) refuse("a contact point needs an address");

    const quiet = input.quietHours;
    if (quiet) {
      if (!HHMM.test(quiet.from) || !HHMM.test(quiet.to)) {
        refuse("quiet hours are HH:MM in 24-hour time");
      }
      // A zone is not optional and there is no default. 21:00 is a different
      // instant in Iqaluit and in Vancouver, and a clinic that serves both
      // would be texting somebody at four in the morning to satisfy a column
      // this module filled in for them.
      if (!quiet.timezone.trim()) {
        refuse("quiet hours need the timezone they are in; without one they cannot be evaluated at all");
      }
      if (!zoneIsReal(quiet.timezone)) {
        refuse(`${quiet.timezone} is not a timezone this system can resolve`);
      }
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    try {
      this.db.sql
        .prepare(
          `INSERT INTO patient_contacts
             (tenant_id, id, patient_id, channel, value, language,
              quiet_from, quiet_to, timezone, consent, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'unasked', 'active', ?)`
        )
        .run(
          this.db.tenantId,
          id,
          input.patientId,
          input.channel,
          value,
          input.language?.trim() || null,
          quiet?.from ?? null,
          quiet?.to ?? null,
          quiet?.timezone.trim() ?? null,
          now
        );
    } catch (err) {
      // The partial unique index. Two active rows holding one number would be
      // two notices to one phone, which reads as the clinic having lost track.
      if (String(err).includes("UNIQUE")) {
        refuse(`${value} is already an active ${input.channel} contact for this patient`, 409);
      }
      throw err;
    }
    return this.get(id)!;
  }

  /**
   * A named person writing down how they checked this address is the
   * patient's.
   *
   * Not a code sent to the number: that proves somebody holds the phone, and
   * this repository has no way to send one yet, so claiming that check would
   * be claiming a control that does not exist. What it records is what a
   * clinic actually does — a clerk who saw a health card and a person.
   */
  verify(id: string, input: { method: string; by: { actorId: string } }): ContactRow {
    const row = this.require(id);
    if (row.status !== "active") refuse("a retired contact cannot be verified", 409);
    const method = input.method.trim();
    if (method.length < MIN_METHOD) {
      refuse(
        `say how this address was checked, in at least ${MIN_METHOD} characters. ` +
          `"verified" is not a method, and a notice sent to an address nobody checked reaches whoever holds it`
      );
    }
    this.db.sql
      .prepare(
        `UPDATE patient_contacts SET verified_at = ?, verified_by = ?, verification_method = ?
          WHERE tenant_id = ? AND id = ? AND status = 'active'`
      )
      .run(new Date().toISOString(), input.by.actorId, method, this.db.tenantId, id);
    return this.get(id)!;
  }

  /**
   * The patient's answer about being contacted here.
   *
   * `given` and `withdrawn` are both decisions and both recorded. Withdrawal
   * is not a delete: a contact somebody asked to stop using has to stay
   * visible, or the next clerk adds it again from the same demographics feed.
   */
  recordConsent(id: string, input: { consent: Exclude<ConsentState, "unasked">; by: { actorId: string } }): ContactRow {
    const row = this.require(id);
    if (input.consent !== "given" && input.consent !== "withdrawn") {
      refuse("consent is given or withdrawn; unasked is the state before anybody asked");
    }
    if (input.consent === "given" && !row.verified_at) {
      // Order matters. Consent to an unchecked address is consent to contact
      // whoever actually holds it.
      refuse("check the address belongs to this patient before recording their consent to use it", 409);
    }
    this.db.sql
      .prepare(
        `UPDATE patient_contacts SET consent = ?, consent_at = ?, consent_by = ?
          WHERE tenant_id = ? AND id = ?`
      )
      .run(input.consent, new Date().toISOString(), input.by.actorId, this.db.tenantId, id);
    return this.get(id)!;
  }

  /** Takes an address out of use, with a reason, keeping the row. */
  retire(id: string, input: { reason: string; by: { actorId: string } }): ContactRow {
    this.require(id);
    if (!input.reason.trim()) refuse("retiring a contact needs a reason");
    const done = this.db.sql
      .prepare(
        `UPDATE patient_contacts SET status = 'retired', retired_at = ?, retired_reason = ?
          WHERE tenant_id = ? AND id = ? AND status = 'active'`
      )
      .run(new Date().toISOString(), `${input.reason.trim()} (${input.by.actorId})`, this.db.tenantId, id);
    if (done.changes === 0) refuse("that contact is already retired", 409);
    return this.get(id)!;
  }

  get(id: string): ContactRow | undefined {
    return this.db.sql
      .prepare("SELECT * FROM patient_contacts WHERE tenant_id = ? AND id = ?")
      .get(this.db.tenantId, id) as unknown as ContactRow | undefined;
  }

  private require(id: string): ContactRow {
    const row = this.get(id);
    if (!row) refuse(`no contact point ${id}`, 404);
    return row;
  }

  /** Every contact on file for a patient, usable or not, so a clerk can see why not. */
  forPatient(patientId: string, opts: { includeRetired?: boolean } = {}): ContactRow[] {
    const rows = this.db.sql
      .prepare(
        "SELECT * FROM patient_contacts WHERE tenant_id = ? AND patient_id = ? ORDER BY channel, created_at"
      )
      .all(this.db.tenantId, patientId) as unknown as ContactRow[];
    return opts.includeRetired ? rows : rows.filter((r) => r.status === "active");
  }

  /**
   * Whether one contact can be sent to right now, and why not when it cannot.
   *
   * The single place all five conditions are applied. A caller that assembled
   * its own send by reading the table would be a second implementation of
   * this rule, and the second one is where a notice goes to a withdrawn
   * number.
   */
  reachability(contact: ContactRow, asOf = new Date()): Reachability {
    if (contact.status !== "active") return { contact, reachable: false, because: "retired" };
    if (!contact.verified_at) return { contact, reachable: false, because: "not-verified" };
    if (contact.consent === "withdrawn") return { contact, reachable: false, because: "consent-withdrawn" };
    if (contact.consent !== "given") return { contact, reachable: false, because: "consent-not-given" };

    const quiet = quietUntil(contact, asOf);
    if (quiet) return { contact, reachable: false, because: "quiet-hours", until: quiet };
    return { contact, reachable: true };
  }

  /** Every contact a notice may go to, with the refused ones and their reasons. */
  reachable(patientId: string, asOf = new Date()): Reachability[] {
    return this.forPatient(patientId, { includeRetired: true }).map((c) => this.reachability(c, asOf));
  }
}

/** Whether a zone name resolves, without trusting that it does. */
function zoneIsReal(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/**
 * When quiet hours end, or null when they are not in force.
 *
 * The window is read in the contact's own zone, and a window that wraps
 * midnight — 21:00 to 07:00, which is the ordinary shape — is inside when the
 * time is after the start *or* before the end. Getting that backwards sends
 * the text at 3am and suppresses it at noon, which is the failure that looks
 * like the feature working.
 */
function quietUntil(contact: ContactRow, asOf: Date): string | null {
  const { quiet_from: from, quiet_to: to, timezone } = contact;
  if (!from || !to || !timezone) return null;

  const local = localMinutes(asOf, timezone);
  if (local === null) return null;
  const start = minutesOf(from);
  const end = minutesOf(to);
  if (start === null || end === null) return null;

  const wraps = start > end;
  const inside = wraps ? local >= start || local < end : local >= start && local < end;
  if (!inside) return null;

  // How long until the window closes, in real minutes from now, so the answer
  // survives the zone arithmetic rather than being recomputed by the caller.
  const minutesLeft = local < end ? end - local : 24 * 60 - local + end;
  return new Date(asOf.getTime() + minutesLeft * 60_000).toISOString();
}

function minutesOf(hhmm: string): number | null {
  const m = HHMM.exec(hhmm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** The wall-clock minute in a named zone, via the formatter rather than an offset table. */
function localMinutes(at: Date, timezone: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(at);
    const hour = parts.find((p) => p.type === "hour")?.value;
    const minute = parts.find((p) => p.type === "minute")?.value;
    if (hour === undefined || minute === undefined) return null;
    // "24" appears at midnight in some ICU versions.
    return (Number(hour) % 24) * 60 + Number(minute);
  } catch {
    return null;
  }
}
