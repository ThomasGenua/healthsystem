/**
 * Item 64: a care-gap cohort turned into a worked list, and the two
 * properties that keep a list from becoming a second, ungoverned copy of
 * clinical judgement — a versioned rule behind every campaign, and no
 * patient called twice about the same gap because two campaigns both
 * happened to name them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../src/db.ts";
import { ClinicalRecord } from "../src/clinical/record.ts";
import { OrderStore } from "../src/orders/store.ts";
import { Schedule } from "../src/schedule/store.ts";
import { PatientContacts } from "../src/patient/contacts.ts";
import { EligibilityRules } from "../src/population/eligibility.ts";
import { OutreachCampaigns } from "../src/population/outreach.ts";
import type { CohortRule, CareGapRule } from "../src/population/registry.ts";

const GP = { actorId: "dr-tetso", actorKind: "practitioner" };
const GP_AUTHOR = { authorId: "dr-tetso", authorKind: "practitioner" };
const STAFF = { actorId: "clerk-amaruq", actorKind: "clerk" };
const NOW = "2026-06-01T00:00:00Z";

const DIABETES: CohortRule = { id: "dm", name: "Diabetes register", conditionCodes: ["diabetes"] };
const HBA1C_GAP: CareGapRule = { id: "hba1c", name: "HbA1c overdue", withinDays: 365, satisfiedByResultCodes: ["4548-4"] };

function clinic() {
  const dir = mkdtempSync(join(tmpdir(), "northstar-outreach-"));
  const db = new Db(join(dir, "northstar.db"));
  const record = new ClinicalRecord(db);
  const orders = new OrderStore(db);
  const schedule = new Schedule(db);
  const contacts = new PatientContacts(db);
  const eligibility = new EligibilityRules(db);
  return {
    db,
    record,
    orders,
    schedule,
    contacts,
    eligibility,
    outreach: new OutreachCampaigns(db, eligibility, { contacts, schedule }),
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}

function diabetic(c: ReturnType<typeof clinic>, id: string) {
  c.record.record({
    entryType: "Patient",
    patientId: id,
    content: { resourceType: "Patient", identifier: [{ value: id }] },
    authorId: "adt",
    authorKind: "device",
  });
  c.record.record({
    entryType: "Condition",
    patientId: id,
    content: { resourceType: "Condition", code: { text: "Type 2 diabetes mellitus" } },
    ...GP_AUTHOR,
  });
  return id;
}

function publishRule(c: ReturnType<typeof clinic>) {
  return c.eligibility.publish({ id: "dm-hba1c-overdue", name: "Diabetics overdue an HbA1c", cohort: DIABETES, gap: HBA1C_GAP, by: GP });
}

// ---------------------------------------------------------- EligibilityRules

test("publishing again retires the old version, and a campaign built from it still finds the original", () => {
  const c = clinic();
  try {
    const v1 = publishRule(c);
    assert.equal(v1.version, 1);
    const v2 = c.eligibility.publish({ id: "dm-hba1c-overdue", name: "Diabetics overdue an HbA1c (revised)", cohort: DIABETES, gap: HBA1C_GAP, by: GP });
    assert.equal(v2.version, 2);

    const stillV1 = c.eligibility.get("dm-hba1c-overdue", 1);
    assert.equal(stillV1?.status, "retired");
    assert.equal(stillV1?.name, "Diabetics overdue an HbA1c");
    assert.equal(c.eligibility.get("dm-hba1c-overdue")?.version, 2);
    assert.deepEqual(c.eligibility.list().map((r) => r.id), ["dm-hba1c-overdue"]);
  } finally {
    c.cleanup();
  }
});

test("an eligibility rule needs a positive care-gap window", () => {
  const c = clinic();
  try {
    assert.throws(() => c.eligibility.publish({ id: "bad", name: "Bad", cohort: DIABETES, gap: { ...HBA1C_GAP, withinDays: 0 }, by: GP }));
    assert.throws(() => c.eligibility.publish({ id: "bad2", name: "Bad2", cohort: DIABETES, gap: { ...HBA1C_GAP, withinDays: -5 }, by: GP }));
  } finally {
    c.cleanup();
  }
});

test("an eligibility rule needs an id and a name", () => {
  const c = clinic();
  try {
    assert.throws(() => c.eligibility.publish({ id: "  ", name: "Bad", cohort: DIABETES, gap: HBA1C_GAP, by: GP }), /needs an id/);
    assert.throws(() => c.eligibility.publish({ id: "bad", name: "  ", cohort: DIABETES, gap: HBA1C_GAP, by: GP }), /needs a name/);
  } finally {
    c.cleanup();
  }
});

// ------------------------------------------------------------- OutreachCampaigns

test("a campaign snapshots the current care gap, and only the current one", () => {
  const c = clinic();
  try {
    const rule = publishRule(c);
    diabetic(c, "NT000001"); // never tested
    diabetic(c, "NT000002"); // tested last year, within the window
    c.orders.report({ patientId: "NT000002", code: "4548-4", display: "HbA1c", value: "7.1", unit: "%", observedAt: NOW, reportedBy: "lab" });
    // NT000003 has a chart, but no diabetes condition — not in the cohort at all.
    c.record.record({
      entryType: "Patient",
      patientId: "NT000003",
      content: { resourceType: "Patient", identifier: [{ value: "NT000003" }] },
      authorId: "adt",
      authorKind: "device",
    });
    c.record.record({
      entryType: "Condition",
      patientId: "NT000003",
      content: { resourceType: "Condition", code: { text: "Seasonal allergic rhinitis" } },
      ...GP_AUTHOR,
    });
    c.record.record({ entryType: "Patient", patientId: "NT000004", content: { resourceType: "Patient" }, authorId: "adt", authorKind: "device" });

    const { campaign, items } = c.outreach.create({ eligibilityRuleId: rule.id, name: "Spring HbA1c push", by: STAFF });
    assert.equal(campaign.eligibility_rule_version, rule.version);
    assert.deepEqual(
      items.map((i) => i.patient_id).sort(),
      ["NT000001"]
    );
    assert.equal(items[0].status, "pending");
    assert.equal(items[0].eligible_last_done, null);
  } finally {
    c.cleanup();
  }
});

test("a campaign against an unpublished rule is refused, not built empty", () => {
  const c = clinic();
  try {
    assert.throws(() => c.outreach.create({ eligibilityRuleId: "no-such-rule", name: "x", by: STAFF }), /no eligibility rule/);
  } finally {
    c.cleanup();
  }
});

test("a campaign needs a name", () => {
  const c = clinic();
  try {
    const rule = publishRule(c);
    assert.throws(() => c.outreach.create({ eligibilityRuleId: rule.id, name: "  ", by: STAFF }), /needs a name/);
  } finally {
    c.cleanup();
  }
});

test("a second campaign for the same rule does not call a patient already on an open item twice", () => {
  const c = clinic();
  try {
    const rule = publishRule(c);
    diabetic(c, "NT000001");
    const first = c.outreach.create({ eligibilityRuleId: rule.id, name: "First push", by: STAFF });
    assert.equal(first.items.length, 1);

    const second = c.outreach.create({ eligibilityRuleId: rule.id, name: "Second push, same rule", by: STAFF });
    assert.deepEqual(second.items, [], "the patient is still on the first campaign's open item");

    // And once the first item is closed out, a fresh campaign can pick the patient back up.
    c.outreach.exclude(first.items[0].id, { reason: "patient is now followed at a different clinic", by: STAFF });
    const third = c.outreach.create({ eligibilityRuleId: rule.id, name: "Third push", by: STAFF });
    assert.equal(third.items.length, 1);
  } finally {
    c.cleanup();
  }
});

test("assignment, a contact attempt, and progress toward completion", () => {
  const c = clinic();
  try {
    const rule = publishRule(c);
    diabetic(c, "NT000001");
    const { items } = c.outreach.create({ eligibilityRuleId: rule.id, name: "Push", by: STAFF });
    const item = items[0];

    assert.throws(() => c.outreach.assign(item.id, "  ", STAFF), /needs a staff member/);
    const assigned = c.outreach.assign(item.id, "clerk-amaruq", STAFF);
    assert.equal(assigned.assigned_to, "clerk-amaruq");

    const { item: afterAttempt } = c.outreach.recordAttempt(item.id, { channel: "phone", outcome: "no-answer", by: STAFF });
    assert.equal(afterAttempt.status, "attempted");
    assert.equal(c.outreach.attemptsFor(item.id).length, 1);

    const { item: responded } = c.outreach.recordAttempt(item.id, { channel: "phone", outcome: "spoke-with-patient", by: STAFF });
    assert.equal(responded.status, "responded");

    const slot = c.schedule.openSlot({ resourceId: "dr-tetso", service: "Diabetes follow-up", startsAt: "2026-07-01T10:00:00Z", endsAt: "2026-07-01T10:30:00Z" });
    const booking = c.schedule.book({ slotId: slot.id, patientId: "NT000001", reason: "HbA1c follow-up", by: GP });
    const booked = c.outreach.linkBooking(item.id, booking.id, STAFF);
    assert.equal(booked.status, "booked");
    assert.equal(booked.booking_id, booking.id);

    assert.throws(() => c.outreach.linkBooking(item.id, "no-such-booking", STAFF), /no booking/);

    const completed = c.outreach.complete(item.id, STAFF);
    assert.equal(completed.status, "completed");
    assert.ok(completed.completed_at);
  } finally {
    c.cleanup();
  }
});

test("completion needs a booking on file; skipping straight to completed is refused", () => {
  const c = clinic();
  try {
    const rule = publishRule(c);
    diabetic(c, "NT000001");
    const { items } = c.outreach.create({ eligibilityRuleId: rule.id, name: "Push", by: STAFF });
    assert.throws(() => c.outreach.complete(items[0].id, STAFF), /only a booked item can be completed/);
  } finally {
    c.cleanup();
  }
});

test("linking a booking made for a different patient is refused", () => {
  const c = clinic();
  try {
    const rule = publishRule(c);
    diabetic(c, "NT000001");
    diabetic(c, "NT000002");
    const { items } = c.outreach.create({ eligibilityRuleId: rule.id, name: "Push", by: STAFF });
    const item = items.find((i) => i.patient_id === "NT000001")!;

    const slot = c.schedule.openSlot({ resourceId: "dr-tetso", service: "Diabetes follow-up", startsAt: "2026-07-01T10:00:00Z", endsAt: "2026-07-01T10:30:00Z" });
    const booking = c.schedule.book({ slotId: slot.id, patientId: "NT000002", reason: "Unrelated visit", by: GP });

    assert.throws(() => c.outreach.linkBooking(item.id, booking.id, STAFF), /different patient/);
  } finally {
    c.cleanup();
  }
});

test("a completed item cannot be reassigned or relinked to another booking", () => {
  const c = clinic();
  try {
    const rule = publishRule(c);
    diabetic(c, "NT000001");
    const { items } = c.outreach.create({ eligibilityRuleId: rule.id, name: "Push", by: STAFF });
    const item = items[0];
    const slot = c.schedule.openSlot({ resourceId: "dr-tetso", service: "Diabetes follow-up", startsAt: "2026-07-01T10:00:00Z", endsAt: "2026-07-01T10:30:00Z" });
    const booking = c.schedule.book({ slotId: slot.id, patientId: "NT000001", reason: "HbA1c follow-up", by: GP });
    c.outreach.linkBooking(item.id, booking.id, STAFF);
    c.outreach.complete(item.id, STAFF);

    assert.throws(() => c.outreach.assign(item.id, "clerk-amaruq", STAFF), /cannot be reassigned/);

    const slot2 = c.schedule.openSlot({ resourceId: "dr-tetso", service: "Diabetes follow-up", startsAt: "2026-08-01T10:00:00Z", endsAt: "2026-08-01T10:30:00Z" });
    const booking2 = c.schedule.book({ slotId: slot2.id, patientId: "NT000001", reason: "Another follow-up", by: GP });
    assert.throws(() => c.outreach.linkBooking(item.id, booking2.id, STAFF), /completed item cannot be linked/);
  } finally {
    c.cleanup();
  }
});

test("listing campaigns shows both active and closed, newest first", () => {
  const c = clinic();
  try {
    const rule = publishRule(c);
    diabetic(c, "NT000001");
    diabetic(c, "NT000002");
    const { campaign: first } = c.outreach.create({ eligibilityRuleId: rule.id, name: "First push", by: STAFF });
    c.outreach.exclude(c.outreach.forCampaign(first.id)[0].id, { reason: "moved clinics", by: STAFF });
    const { campaign: second } = c.outreach.create({ eligibilityRuleId: rule.id, name: "Second push", by: STAFF });
    c.outreach.close(first.id, STAFF);

    const listed = c.outreach.list();
    assert.deepEqual(listed.map((row) => row.id), [second.id, first.id]);
    assert.equal(listed.find((row) => row.id === first.id)?.status, "closed");
    assert.equal(listed.find((row) => row.id === second.id)?.status, "active");
  } finally {
    c.cleanup();
  }
});

test("closing a campaign is one-way", () => {
  const c = clinic();
  try {
    const rule = publishRule(c);
    diabetic(c, "NT000001");
    const { campaign } = c.outreach.create({ eligibilityRuleId: rule.id, name: "Push", by: STAFF });

    const closed = c.outreach.close(campaign.id, STAFF);
    assert.equal(closed.status, "closed");
    assert.ok(closed.closed_at);
    assert.throws(() => c.outreach.close(campaign.id, STAFF), /already closed/);
  } finally {
    c.cleanup();
  }
});

test("three unanswered attempts surface the item as unreachable, not silently pending", () => {
  const c = clinic();
  try {
    const rule = publishRule(c);
    diabetic(c, "NT000001");
    const { items } = c.outreach.create({ eligibilityRuleId: rule.id, name: "Push", by: STAFF });
    const item = items[0];

    for (let i = 0; i < 2; i++) c.outreach.recordAttempt(item.id, { channel: "phone", outcome: "no-answer", by: STAFF });
    assert.equal(c.outreach.requireItem(item.id).status, "attempted");
    const { item: third } = c.outreach.recordAttempt(item.id, { channel: "phone", outcome: "no-answer", by: STAFF });
    assert.equal(third.status, "unreachable");

    assert.deepEqual(
      c.outreach.unreachable(item.campaign_id).map((i) => i.id),
      [item.id]
    );
  } finally {
    c.cleanup();
  }
});

test("an item marked unreachable is not a dead end; a later attempt that connects still moves it forward", () => {
  const c = clinic();
  try {
    const rule = publishRule(c);
    diabetic(c, "NT000001");
    const { items } = c.outreach.create({ eligibilityRuleId: rule.id, name: "Push", by: STAFF });
    const item = items[0];

    for (let i = 0; i < 3; i++) c.outreach.recordAttempt(item.id, { channel: "phone", outcome: "no-answer", by: STAFF });
    assert.equal(c.outreach.requireItem(item.id).status, "unreachable");

    const { item: reached } = c.outreach.recordAttempt(item.id, { channel: "phone", outcome: "spoke-with-patient", by: STAFF });
    assert.equal(reached.status, "responded", "unreachable is a worklist signal, not a status nothing can move on from");
  } finally {
    c.cleanup();
  }
});

test("recordAttempt refuses an outcome outside the known set", () => {
  const c = clinic();
  try {
    const rule = publishRule(c);
    diabetic(c, "NT000001");
    const { items } = c.outreach.create({ eligibilityRuleId: rule.id, name: "Push", by: STAFF });
    assert.throws(
      () => c.outreach.recordAttempt(items[0].id, { channel: "phone", outcome: "voicemail-full" as never, by: STAFF }),
      /unknown attempt outcome/
    );
  } finally {
    c.cleanup();
  }
});

test("a fourth attempt after a response does not undo the response", () => {
  const c = clinic();
  try {
    const rule = publishRule(c);
    diabetic(c, "NT000001");
    const { items } = c.outreach.create({ eligibilityRuleId: rule.id, name: "Push", by: STAFF });
    const item = items[0];

    c.outreach.recordAttempt(item.id, { channel: "phone", outcome: "spoke-with-patient", by: STAFF });
    // A courtesy reminder call after the patient already agreed to come in.
    const { item: after } = c.outreach.recordAttempt(item.id, { channel: "phone", outcome: "no-answer", by: STAFF });
    assert.equal(after.status, "responded", "already responded; a later call attempt does not revert that");
  } finally {
    c.cleanup();
  }
});

test("excluding needs a written reason, and a completed or excluded item cannot be excluded again", () => {
  const c = clinic();
  try {
    const rule = publishRule(c);
    diabetic(c, "NT000001");
    const { items } = c.outreach.create({ eligibilityRuleId: rule.id, name: "Push", by: STAFF });
    const item = items[0];

    assert.throws(() => c.outreach.exclude(item.id, { reason: "", by: STAFF }), /written reason/);
    const excluded = c.outreach.exclude(item.id, { reason: "patient is deceased", by: STAFF });
    assert.equal(excluded.status, "excluded");
    assert.throws(() => c.outreach.exclude(item.id, { reason: "again", by: STAFF }), /cannot be excluded/);
    assert.throws(() => c.outreach.recordAttempt(item.id, { channel: "phone", outcome: "no-answer", by: STAFF }), /cannot take a new contact attempt/);
  } finally {
    c.cleanup();
  }
});

test("recordAttempt refuses when the patient has no reachable contact right now", () => {
  const c = clinic();
  try {
    const rule = publishRule(c);
    diabetic(c, "NT000001");
    const phone = c.contacts.add({ patientId: "NT000001", channel: "sms", value: "+18675550100" });
    // Never verified, and never consented — not reachable.
    const { items } = c.outreach.create({ eligibilityRuleId: rule.id, name: "Push", by: STAFF });

    assert.throws(() => c.outreach.recordAttempt(items[0].id, { channel: "sms", outcome: "no-answer", by: STAFF }), /no reachable contact/);

    c.contacts.verify(phone.id, { method: "confirmed by phone at registration", by: { actorId: "clerk" } });
    c.contacts.recordConsent(phone.id, { consent: "given", by: { actorId: "clerk" } });
    const { item } = c.outreach.recordAttempt(items[0].id, { channel: "sms", outcome: "no-answer", by: STAFF });
    assert.equal(item.status, "attempted");
  } finally {
    c.cleanup();
  }
});

test("recheckEligibility says the gap has closed once the patient has a recent result, without changing the snapshot", () => {
  const c = clinic();
  try {
    const rule = publishRule(c);
    diabetic(c, "NT000001");
    const { items } = c.outreach.create({ eligibilityRuleId: rule.id, name: "Push", by: STAFF });
    const item = items[0];

    assert.equal(c.outreach.recheckEligibility(item.id).stillEligible, true);

    c.orders.report({ patientId: "NT000001", code: "4548-4", display: "HbA1c", value: "7.0", unit: "%", reportedBy: "lab" });
    const recheck = c.outreach.recheckEligibility(item.id);
    assert.equal(recheck.stillEligible, false);
    assert.match(recheck.reason!, /gap.*closed/);

    // The original snapshot on the item itself is untouched — recheck is a
    // question asked, not a silent rewrite of the list.
    assert.equal(c.outreach.requireItem(item.id).eligible_last_done, null);
  } finally {
    c.cleanup();
  }
});

test("outreach campaigns, items and rules are confined to their tenant", () => {
  const c = clinic();
  try {
    const rule = publishRule(c);
    diabetic(c, "NT000001");
    const { campaign } = c.outreach.create({ eligibilityRuleId: rule.id, name: "Push", by: STAFF });

    const other = c.db.forTenant("second-clinic");
    const otherEligibility = new EligibilityRules(other);
    const otherOutreach = new OutreachCampaigns(other, otherEligibility);
    assert.equal(otherEligibility.get(rule.id), undefined);
    assert.throws(() => otherOutreach.forCampaign(campaign.id), /no outreach campaign/);
  } finally {
    c.cleanup();
  }
});
