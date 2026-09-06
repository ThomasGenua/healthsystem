/**
 * A care-gap cohort turned into a worked list, with a memory of who has
 * already been called about it.
 *
 * ## What a campaign is
 *
 * `create()` snapshots `Registry.gaps()` against a published, versioned
 * `EligibilityRule` at one moment, and that snapshot — what the gap said,
 * not a live re-read of it — is what a staff member works from. A patient
 * whose result comes back the day after the list was built is not silently
 * removed from somebody's afternoon; `recheckEligibility()` exists
 * precisely so that question is asked once more, deliberately, right
 * before the call is actually made.
 *
 * ## Duplicate outreach is prevented by the schema, not by a check here
 *
 * `idx_outreach_open_once` is a partial unique index on
 * (patient, eligibility_rule_id) while an item is open. Two campaigns run
 * a week apart against the same rule cannot both hand the same patient to
 * two different staff members — the second `create()` finds the patient
 * already on an open item and leaves them there rather than adding a
 * second row a database constraint would then refuse anyway.
 *
 * ## Contact preferences are not a courtesy checked after the fact
 *
 * `recordAttempt()` refuses to record an attempt if `PatientContacts` says
 * the patient is not reachable right now — no verified contact, or quiet
 * hours in effect — the same honesty item 59 already built for a
 * notification. Outreach is not exempt from what a notification already
 * has to respect.
 */
import { randomUUID } from "node:crypto";
import type { Db } from "../db.ts";
import { refuse } from "../core/refusal.ts";
import { Registry } from "./registry.ts";
import type { EligibilityRules } from "./eligibility.ts";

export interface Actor {
  actorId: string;
  actorKind: string;
}

/** The minimal shape this needs from PatientContacts and Schedule — see discharge.ts for the same loose coupling. */
export interface OutreachSources {
  contacts?: { reachable(patientId: string, asOf?: Date): Array<{ reachable: boolean; because?: unknown }> };
  schedule?: { booking(id: string): { patient_id: string } | undefined };
}

export type OutreachStatus = "pending" | "attempted" | "responded" | "booked" | "completed" | "excluded" | "unreachable";
export const ATTEMPT_OUTCOMES = ["no-answer", "left-message", "spoke-with-patient", "wrong-number", "declined"] as const;
export type AttemptOutcome = (typeof ATTEMPT_OUTCOMES)[number];

/** Attempts after which an unresponsive item is surfaced as unreachable, not silently left pending. */
const UNREACHABLE_AFTER_ATTEMPTS = 3;

export interface CampaignRow {
  tenant_id: string;
  id: string;
  name: string;
  eligibility_rule_id: string;
  eligibility_rule_version: number;
  status: "active" | "closed";
  created_by: string;
  created_at: string;
  closed_at: string | null;
}

export interface ItemRow {
  tenant_id: string;
  id: string;
  campaign_id: string;
  patient_id: string;
  eligibility_rule_id: string;
  eligible_last_done: string | null;
  eligible_overdue_days: number | null;
  status: OutreachStatus;
  assigned_to: string | null;
  booking_id: string | null;
  excluded_reason: string | null;
  excluded_by: string | null;
  excluded_at: string | null;
  completed_at: string | null;
  completed_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface AttemptRow {
  tenant_id: string;
  id: string;
  item_id: string;
  attempted_by: string;
  attempted_at: string;
  channel: string;
  outcome: AttemptOutcome;
  note: string | null;
}

const OPEN: readonly OutreachStatus[] = ["pending", "attempted", "responded", "booked", "unreachable"];

export class OutreachCampaigns {
  private db: Db;
  private registry: Registry;
  private eligibility: EligibilityRules;
  private sources: OutreachSources;

  constructor(db: Db, eligibility: EligibilityRules, sources: OutreachSources = {}) {
    this.db = db;
    this.registry = new Registry(db);
    this.eligibility = eligibility;
    this.sources = sources;
  }

  /** Every campaign this tenant has run, newest first — active and closed alike, so a manager can review either. */
  list(): CampaignRow[] {
    return this.db.sql
      .prepare("SELECT * FROM outreach_campaigns WHERE tenant_id = ? ORDER BY created_at DESC")
      .all(this.db.tenantId) as unknown as CampaignRow[];
  }

  private requireCampaign(id: string): CampaignRow {
    const row = this.db.sql
      .prepare("SELECT * FROM outreach_campaigns WHERE tenant_id = ? AND id = ?")
      .get(this.db.tenantId, id) as CampaignRow | undefined;
    if (!row) refuse(`no outreach campaign ${id}`, 404);
    return row;
  }

  requireItem(id: string): ItemRow {
    const row = this.db.sql.prepare("SELECT * FROM outreach_items WHERE tenant_id = ? AND id = ?").get(this.db.tenantId, id) as
      | ItemRow
      | undefined;
    if (!row) refuse(`no outreach item ${id}`, 404);
    return row;
  }

  /**
   * Builds a campaign from a published eligibility rule's current care
   * gap, at this moment. A patient already on an open item for this same
   * rule — from this campaign or an earlier one — is not added twice; the
   * schema's own unique index is the actual guarantee, this is just why
   * that patient does not appear in the list `create()` returns.
   */
  create(input: { eligibilityRuleId: string; version?: number; name: string; by: Actor }): { campaign: CampaignRow; items: ItemRow[] } {
    if (!input.name.trim()) refuse("a campaign needs a name");
    const rule = this.eligibility.get(input.eligibilityRuleId, input.version);
    if (!rule) refuse(`no eligibility rule ${input.eligibilityRuleId}${input.version ? ` version ${input.version}` : ""}`);

    return this.db.transaction(() => {
      const now = new Date().toISOString();
      const campaignId = randomUUID();
      this.db.sql
        .prepare(
          `INSERT INTO outreach_campaigns (tenant_id, id, name, eligibility_rule_id, eligibility_rule_version, status, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`
        )
        .run(this.db.tenantId, campaignId, input.name.trim(), rule.id, rule.version, input.by.actorId, now);

      const { gaps } = this.registry.gaps(rule.cohort, rule.gap, now);
      const items: ItemRow[] = [];
      for (const gap of gaps) {
        const id = randomUUID();
        try {
          this.db.sql
            .prepare(
              `INSERT INTO outreach_items
                 (tenant_id, id, campaign_id, patient_id, eligibility_rule_id, eligible_last_done, eligible_overdue_days,
                  status, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
            )
            .run(this.db.tenantId, id, campaignId, gap.patientId, rule.id, gap.lastDone, gap.overdueSinceDays, now, now);
        } catch (err) {
          // The partial unique index: this patient is already on an open
          // item for this rule from another campaign. Not an error — the
          // whole point of the index — so this patient is simply not
          // added again, and the campaign proceeds with everyone else.
          if (String(err).includes("UNIQUE")) continue;
          throw err;
        }
        items.push(this.requireItem(id));
      }
      return { campaign: this.requireCampaign(campaignId), items };
    });
  }

  forCampaign(campaignId: string): ItemRow[] {
    this.requireCampaign(campaignId);
    return this.db.sql
      .prepare("SELECT * FROM outreach_items WHERE tenant_id = ? AND campaign_id = ? ORDER BY created_at")
      .all(this.db.tenantId, campaignId) as unknown as ItemRow[];
  }

  close(campaignId: string, by: Actor): CampaignRow {
    const campaign = this.requireCampaign(campaignId);
    if (campaign.status !== "active") refuse(`campaign ${campaignId} is already ${campaign.status}`);
    const now = new Date().toISOString();
    this.db.sql
      .prepare("UPDATE outreach_campaigns SET status = 'closed', closed_at = ? WHERE tenant_id = ? AND id = ? AND status = 'active'")
      .run(now, this.db.tenantId, campaignId);
    void by;
    return this.requireCampaign(campaignId);
  }

  assign(itemId: string, staffId: string, by: Actor): ItemRow {
    const item = this.requireItem(itemId);
    if (!OPEN.includes(item.status)) refuse(`a ${item.status} item cannot be reassigned`);
    if (!staffId.trim()) refuse("assignment needs a staff member");
    this.db.sql
      .prepare("UPDATE outreach_items SET assigned_to = ?, updated_at = ? WHERE tenant_id = ? AND id = ?")
      .run(staffId, new Date().toISOString(), this.db.tenantId, itemId);
    void by;
    return this.requireItem(itemId);
  }

  /**
   * Whether this item's patient is still eligible right now, re-read from
   * the chart rather than trusted from the snapshot the list was built
   * from. Called deliberately, immediately before a contact attempt — not
   * automatically, because a list that silently shrank between review and
   * calling would be indistinguishable from one nobody worked.
   */
  recheckEligibility(itemId: string): { stillEligible: boolean; reason?: string } {
    const item = this.requireItem(itemId);
    const rule = this.eligibility.get(item.eligibility_rule_id);
    if (!rule) return { stillEligible: false, reason: "the eligibility rule has been retired with no successor" };
    const { gaps } = this.registry.gaps(rule.cohort, rule.gap);
    const stillGapped = gaps.some((g) => g.patientId === item.patient_id);
    return stillGapped ? { stillEligible: true } : { stillEligible: false, reason: "the gap this item was raised for has since been closed" };
  }

  /**
   * Refuses if PatientContacts says this patient is not reachable right
   * now — no verified contact, or quiet hours — the same check a
   * notification already has to pass.
   */
  private assertReachable(patientId: string): void {
    if (!this.sources.contacts) return; // Not wired in; recorded as asserted, the same as an unvalidatable link elsewhere.
    const rows = this.sources.contacts.reachable(patientId);
    if (rows.length > 0 && !rows.some((r) => r.reachable)) {
      refuse("this patient has no reachable contact right now (no verified method, or quiet hours are in effect)", 409);
    }
  }

  recordAttempt(itemId: string, input: { channel: string; outcome: AttemptOutcome; note?: string; by: Actor }): { item: ItemRow; attempt: AttemptRow } {
    if (!(ATTEMPT_OUTCOMES as readonly string[]).includes(input.outcome)) {
      refuse(`unknown attempt outcome ${input.outcome}; expected one of ${ATTEMPT_OUTCOMES.join(", ")}`);
    }
    const item = this.requireItem(itemId);
    if (item.status === "completed" || item.status === "excluded") {
      refuse(`a ${item.status} item cannot take a new contact attempt`);
    }
    this.assertReachable(item.patient_id);

    return this.db.transaction(() => {
      const now = new Date().toISOString();
      const attemptId = randomUUID();
      this.db.sql
        .prepare(
          `INSERT INTO outreach_attempts (tenant_id, id, item_id, attempted_by, attempted_at, channel, outcome, note)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(this.db.tenantId, attemptId, itemId, input.by.actorId, now, input.channel, input.outcome, input.note?.trim() || null);

      const attemptCount = (
        this.db.sql.prepare("SELECT COUNT(*) AS n FROM outreach_attempts WHERE tenant_id = ? AND item_id = ?").get(this.db.tenantId, itemId) as {
          n: number;
        }
      ).n;

      const nextStatus: OutreachStatus =
        input.outcome === "spoke-with-patient"
          ? "responded"
          : attemptCount >= UNREACHABLE_AFTER_ATTEMPTS
            ? "unreachable"
            : "attempted";

      // Never moves an item backward: a fourth failed attempt on an
      // already-booked item does not un-book it.
      if (item.status === "pending" || item.status === "attempted" || item.status === "unreachable") {
        this.db.sql
          .prepare("UPDATE outreach_items SET status = ?, updated_at = ? WHERE tenant_id = ? AND id = ?")
          .run(nextStatus, now, this.db.tenantId, itemId);
      }
      return { item: this.requireItem(itemId), attempt: this.db.sql.prepare("SELECT * FROM outreach_attempts WHERE tenant_id = ? AND id = ?").get(this.db.tenantId, attemptId) as unknown as AttemptRow };
    });
  }

  attemptsFor(itemId: string): AttemptRow[] {
    this.requireItem(itemId);
    return this.db.sql
      .prepare("SELECT * FROM outreach_attempts WHERE tenant_id = ? AND item_id = ? ORDER BY attempted_at")
      .all(this.db.tenantId, itemId) as unknown as AttemptRow[];
  }

  /** A booked appointment, validated against Schedule when one is wired in. */
  linkBooking(itemId: string, bookingId: string, by: Actor): ItemRow {
    const item = this.requireItem(itemId);
    if (item.status === "completed" || item.status === "excluded") refuse(`a ${item.status} item cannot be linked to a booking`);
    if (this.sources.schedule) {
      const booking = this.sources.schedule.booking(bookingId);
      if (!booking) refuse(`no booking ${bookingId}`);
      if (booking.patient_id !== item.patient_id) refuse("that booking is for a different patient than this outreach item");
    }
    this.db.sql
      .prepare("UPDATE outreach_items SET status = 'booked', booking_id = ?, updated_at = ? WHERE tenant_id = ? AND id = ?")
      .run(bookingId, new Date().toISOString(), this.db.tenantId, itemId);
    void by;
    return this.requireItem(itemId);
  }

  /** The visit actually happened. Needs a booking on file — completion is not a status somebody picks instead of booking one. */
  complete(itemId: string, by: Actor): ItemRow {
    const item = this.requireItem(itemId);
    if (item.status !== "booked") refuse(`only a booked item can be completed, not ${item.status}`);
    const now = new Date().toISOString();
    this.db.sql
      .prepare("UPDATE outreach_items SET status = 'completed', completed_at = ?, completed_by = ?, updated_at = ? WHERE tenant_id = ? AND id = ?")
      .run(now, by.actorId, now, this.db.tenantId, itemId);
    return this.requireItem(itemId);
  }

  exclude(itemId: string, input: { reason: string; by: Actor }): ItemRow {
    const item = this.requireItem(itemId);
    if (item.status === "completed" || item.status === "excluded") refuse(`a ${item.status} item cannot be excluded`);
    if (!input.reason.trim()) refuse("excluding an outreach item needs a written reason");
    const now = new Date().toISOString();
    this.db.sql
      .prepare(
        "UPDATE outreach_items SET status = 'excluded', excluded_reason = ?, excluded_by = ?, excluded_at = ?, updated_at = ? WHERE tenant_id = ? AND id = ?"
      )
      .run(input.reason.trim(), input.by.actorId, now, now, this.db.tenantId, itemId);
    return this.requireItem(itemId);
  }

  /** Attempted the maximum number of times, with no response and nobody has excluded or booked them. */
  unreachable(campaignId: string): ItemRow[] {
    return this.forCampaign(campaignId).filter((i) => i.status === "unreachable");
  }
}
