/**
 * Reaching a patient, and the five ways that is not the same as telling them.
 *
 * The engine could already publish a notice onto a channel. What it had no
 * way to do was say *where* — `patient_index` carries a phone and an email
 * copied out of an ADT feed, which is what a sending system believes, not an
 * address this clinic checked and this patient agreed to. Sending to
 * demographics is how a result notice reaches the number a clerk mistyped
 * four years ago.
 *
 * So these pin two things. That nothing goes out without a named person
 * having checked the address and the patient having agreed to it — separate
 * facts, separately recorded, both required. And that every optimistic
 * shortcut between "we handed it to a gateway" and "they know" is refused:
 * provider-accepted is not delivered, unknown is not delivered, a viewed
 * notice is not a delivered one, and none of them is told.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine } from "../src/core/engine.ts";
import { Db } from "../src/db.ts";
import { PatientContacts } from "../src/patient/contacts.ts";
import { PatientNotices, noticeBody } from "../src/patient/notice.ts";
import type { ChannelConfig } from "../src/types.ts";

const PATIENT = "NT000001";
const CLERK = { actorId: "clerk-avery" };

function store(): { db: Db; contacts: PatientContacts; close: () => void } {
  const db = new Db(":memory:");
  return { db, contacts: new PatientContacts(db), close: () => db.close() };
}

/** An address a clerk checked and a patient agreed to. Both, or it is unusable. */
function usable(contacts: PatientContacts, over: Partial<Parameters<PatientContacts["add"]>[0]> = {}) {
  const c = contacts.add({ patientId: PATIENT, channel: "sms", value: "+15550100", ...over });
  contacts.verify(c.id, { method: "health card seen in person at reception", by: CLERK });
  return contacts.recordConsent(c.id, { consent: "given", by: CLERK });
}

test("an address nobody checked and nobody agreed to cannot be sent to", () => {
  const s = store();
  try {
    const c = s.contacts.add({ patientId: PATIENT, channel: "sms", value: "+15550100" });
    assert.equal(c.consent, "unasked", "nobody has been asked yet, which is not a refusal");
    assert.equal(c.verified_at, null);
    assert.equal(s.contacts.reachability(c).because, "not-verified");

    // Verification alone is not permission.
    const verified = s.contacts.verify(c.id, { method: "health card seen in person at reception", by: CLERK });
    assert.equal(verified.verification_method, "health card seen in person at reception");
    assert.equal(s.contacts.reachability(verified).because, "consent-not-given");

    // And consent alone would have been consent to text whoever holds it, so
    // the order is enforced rather than assumed.
    const fresh = s.contacts.add({ patientId: PATIENT, channel: "email", value: "sunniva@example.invalid" });
    assert.throws(
      () => s.contacts.recordConsent(fresh.id, { consent: "given", by: CLERK }),
      /check the address belongs to this patient/
    );

    assert.equal(s.contacts.reachability(usable(s.contacts, { value: "+15550199" })).reachable, true);
  } finally {
    s.close();
  }
});

test("verifying an address means writing down how, not pressing a button", () => {
  const s = store();
  try {
    const c = s.contacts.add({ patientId: PATIENT, channel: "sms", value: "+15550100" });
    assert.throws(() => s.contacts.verify(c.id, { method: "verified", by: CLERK }), /at least 12 characters/);
    assert.throws(() => s.contacts.verify(c.id, { method: "  ok  ", by: CLERK }), /at least 12 characters/);
    assert.equal(s.contacts.get(c.id)!.verified_at, null, "and nothing was recorded");
  } finally {
    s.close();
  }
});

test("withdrawing consent stops the sending and keeps the row", () => {
  const s = store();
  try {
    const c = usable(s.contacts);
    assert.equal(s.contacts.reachability(c).reachable, true);

    const withdrawn = s.contacts.recordConsent(c.id, { consent: "withdrawn", by: { actorId: "urn:demo:sunniva" } });
    assert.equal(s.contacts.reachability(withdrawn).because, "consent-withdrawn");
    // Kept, not deleted: an address somebody asked us to stop using has to
    // stay visible, or the next clerk adds it again off the same feed.
    assert.equal(s.contacts.forPatient(PATIENT).length, 1);
    assert.equal(s.contacts.get(c.id)!.consent_by, "urn:demo:sunniva");
  } finally {
    s.close();
  }
});

test("quiet hours need the zone they are in, and are not guessed", () => {
  const s = store();
  try {
    assert.throws(
      () =>
        s.contacts.add({
          patientId: PATIENT,
          channel: "sms",
          value: "+15550101",
          quietHours: { from: "21:00", to: "07:00", timezone: "  " },
        }),
      /need the timezone/
    );
    assert.throws(
      () =>
        s.contacts.add({
          patientId: PATIENT,
          channel: "sms",
          value: "+15550102",
          quietHours: { from: "21:00", to: "07:00", timezone: "Mars/Olympus" },
        }),
      /not a timezone/
    );
    assert.throws(
      () =>
        s.contacts.add({
          patientId: PATIENT,
          channel: "sms",
          value: "+15550103",
          quietHours: { from: "9pm", to: "7am", timezone: "America/Iqaluit" },
        }),
      /HH:MM/
    );
  } finally {
    s.close();
  }
});

test("a quiet window that wraps midnight is inside at night, not at noon", () => {
  // Getting this backwards sends the text at 3am and suppresses it at
  // lunchtime, which looks exactly like the feature working.
  const s = store();
  try {
    const c = usable(s.contacts, {
      value: "+15550104",
      quietHours: { from: "21:00", to: "07:00", timezone: "America/Toronto" },
    });

    const at = (iso: string) => s.contacts.reachability(c, new Date(iso));
    // 02:00 and 23:00 in Toronto are inside; 12:00 and 08:00 are not.
    assert.equal(at("2026-01-15T07:00:00Z").because, "quiet-hours", "02:00 local");
    assert.equal(at("2026-01-16T04:00:00Z").because, "quiet-hours", "23:00 local");
    assert.equal(at("2026-01-15T17:00:00Z").reachable, true, "12:00 local");
    assert.equal(at("2026-01-15T13:00:00Z").reachable, true, "08:00 local");

    // And it says when it opens, so a caller holds rather than drops.
    const held = at("2026-01-15T07:00:00Z");
    assert.ok(held.until, "quiet hours must say when they end");
    assert.ok(new Date(held.until!).getTime() > Date.parse("2026-01-15T07:00:00Z"));
  } finally {
    s.close();
  }
});

test("one custodian's contacts are not another's, and one address is on file once", () => {
  const db = new Db(":memory:");
  try {
    const north = new PatientContacts(db.forTenant("default"));
    const south = new PatientContacts(db.forTenant("south"));
    db.createTenant("south", "south", "south");

    north.add({ patientId: PATIENT, channel: "sms", value: "+15550100" });
    assert.equal(north.forPatient(PATIENT).length, 1);
    assert.deepEqual(south.forPatient(PATIENT), [], "the southern site holds no number for this chart");

    // Two active rows for one address would be two texts about one result.
    assert.throws(
      () => north.add({ patientId: PATIENT, channel: "sms", value: "+15550100" }),
      /already an active sms contact/
    );
    // Retiring it frees the address to be added again, which is the ordinary
    // case of somebody getting their old number back.
    const [existing] = north.forPatient(PATIENT);
    north.retire(existing.id, { reason: "number no longer in service", by: CLERK });
    assert.equal(north.reachability(north.get(existing.id)!).because, "retired");
    assert.doesNotThrow(() => north.add({ patientId: PATIENT, channel: "sms", value: "+15550100" }));
  } finally {
    db.close();
  }
});

/* ------------------------------------------------------------------------ */

const CHANNEL: ChannelConfig = {
  id: "patient-notices",
  name: "patient notices",
  source: { type: "filedrop", dir: "/nowhere", pollMs: 3_600_000 },
  destinations: [{ id: "sms-gateway", type: "http", url: "http://127.0.0.1:1/send" }],
};

async function engineWithChannel() {
  const engine = new Engine({ dbPath: ":memory:", tickMs: 15, breakGlassNoticeChannel: "patient-notices" });
  await engine.start();
  engine.db.upsertChannel(CHANNEL.id, CHANNEL.name, true, JSON.stringify(CHANNEL));
  const t = engine.forTenant("default");
  return { engine, t, close: () => engine.stop() };
}

test("handing a notice to a gateway is not delivering it", async () => {
  const s = await engineWithChannel();
  try {
    const contact = usable(s.t.contacts);
    const notice = s.t.notices.queue({ patientId: PATIENT, kind: "result-released", summary: "A result was released" });

    const report = s.t.notices.deliver(notice.id, { contacts: s.t.contacts, tasks: s.t.tasks });
    assert.equal(report.attempted.length, 1);
    const [attempt] = report.attempted;
    assert.equal(attempt.contact_id, contact.id);

    // The queue took it. That is the whole of what has happened, and the
    // state says so rather than claiming the phone rang.
    assert.equal(attempt.state, "provider-accepted");
    assert.equal(attempt.delivered_at, null, "nothing has said it arrived");
    assert.ok(attempt.accepted_at);
    assert.ok(attempt.message_id, "and it went out on the durable queue, not a side channel");

    // Only a receipt reaches delivered.
    const receipted = s.t.notices.recordReceipt(attempt.id, { state: "delivered", reference: "sms-9931" });
    assert.equal(receipted.state, "delivered");
    assert.ok(receipted.delivered_at);
    assert.equal(receipted.provider_reference, "sms-9931");
  } finally {
    await s.close();
  }
});

test("a receipt nobody can read is unknown, and unknown is not delivered", async () => {
  const s = await engineWithChannel();
  try {
    usable(s.t.contacts);
    const notice = s.t.notices.queue({ patientId: PATIENT, kind: "result-released", summary: "A result was released" });
    const [attempt] = s.t.notices.deliver(notice.id, { contacts: s.t.contacts, tasks: s.t.tasks }).attempted;

    const unknown = s.t.notices.recordReceipt(attempt.id, {
      state: "unknown",
      detail: "gateway reported status 'PENDING_CARRIER'",
    });
    assert.equal(unknown.state, "unknown");
    assert.equal(unknown.delivered_at, null);
    assert.equal(unknown.failed_at, null, "it did not fail either; nobody knows");

    // And it lands on the chase list beside the outright failures, because
    // neither means the patient was reached.
    assert.deepEqual(
      s.t.notices.followUp().map((r) => r.state),
      ["unknown"]
    );
  } finally {
    await s.close();
  }
});

test("a provider cannot report on an attempt nobody handed it", async () => {
  const s = await engineWithChannel();
  try {
    usable(s.t.contacts, { quietHours: { from: "00:00", to: "23:59", timezone: "America/Toronto" } });
    const notice = s.t.notices.queue({ patientId: PATIENT, kind: "result-released", summary: "A result was released" });
    const [held] = s.t.notices.deliver(notice.id, { contacts: s.t.contacts, tasks: s.t.tasks }).attempted;

    assert.equal(held.state, "queued");
    assert.ok(held.held_until, "quiet hours hold rather than drop");
    assert.equal(held.message_id, null, "and nothing has gone out");
    assert.throws(
      () => s.t.notices.recordReceipt(held.id, { state: "delivered" }),
      /not been handed to a provider/
    );
  } finally {
    await s.close();
  }
});

test("consent withdrawn during quiet hours is not escaped by the hold", async () => {
  const s = await engineWithChannel();
  try {
    const contact = usable(s.t.contacts, {
      quietHours: { from: "21:00", to: "07:00", timezone: "America/Toronto" },
    });
    const night = new Date("2026-01-15T07:00:00Z"); // 02:00 local
    const morning = new Date("2026-01-15T14:00:00Z"); // 09:00 local
    const notice = s.t.notices.queue({ patientId: PATIENT, kind: "result-released", summary: "A result was released" });
    const [held] = s.t.notices.deliver(notice.id, { contacts: s.t.contacts, tasks: s.t.tasks }, night).attempted;
    assert.equal(held.state, "queued");

    // The patient withdraws while it is waiting for morning.
    s.t.contacts.recordConsent(contact.id, { consent: "withdrawn", by: { actorId: "urn:demo:sunniva" } });

    const released = s.t.notices.releaseHeld({ contacts: s.t.contacts }, morning);
    assert.equal(released.length, 1);
    assert.equal(released[0].state, "failed", "a hold must not become a way past a withdrawal");
    assert.match(released[0].detail ?? "", /consent-withdrawn/);
    assert.equal(released[0].message_id, null, "and nothing was sent");
  } finally {
    await s.close();
  }
});

test("a held notice goes out when the window closes", async () => {
  const s = await engineWithChannel();
  try {
    usable(s.t.contacts, { quietHours: { from: "21:00", to: "07:00", timezone: "America/Toronto" } });
    const notice = s.t.notices.queue({ patientId: PATIENT, kind: "result-released", summary: "A result was released" });
    s.t.notices.deliver(notice.id, { contacts: s.t.contacts, tasks: s.t.tasks }, new Date("2026-01-15T07:00:00Z"));

    // Still night: nothing moves.
    assert.deepEqual(s.t.notices.releaseHeld({ contacts: s.t.contacts }, new Date("2026-01-15T08:00:00Z")), []);

    const sent = s.t.notices.releaseHeld({ contacts: s.t.contacts }, new Date("2026-01-15T14:00:00Z"));
    assert.equal(sent.length, 1);
    assert.equal(sent[0].state, "provider-accepted");
    assert.equal(sent[0].held_until, null);
  } finally {
    await s.close();
  }
});

test("a patient nobody can reach becomes somebody's job", async () => {
  const s = await engineWithChannel();
  try {
    // On file, but unusable: never verified.
    const unusable = s.t.contacts.add({ patientId: PATIENT, channel: "sms", value: "+15550100" });
    const notice = s.t.notices.queue({ patientId: PATIENT, kind: "result-released", summary: "A result was released" });

    const report = s.t.notices.deliver(notice.id, { contacts: s.t.contacts, tasks: s.t.tasks });
    assert.deepEqual(report.attempted, []);
    assert.deepEqual(report.skipped, [{ contactId: unusable.id, channel: "sms", because: "not-verified" }]);
    assert.ok(report.followUpTaskId, "somebody has to own reaching this patient");

    const task = s.t.tasks.get(report.followUpTaskId!)!;
    assert.equal(task.kind, "patient-contact");
    assert.equal(task.patient_id, PATIENT);
    assert.match(task.title, /could not be notified: .*not-verified/);
    // On the unassigned queue, which is a list somebody is responsible for
    // rather than a row nobody is looking at.
    assert.ok(s.t.tasks.unassigned().some((x) => x.id === task.id));
    assert.equal(s.t.notices.get(notice.id)!.follow_up_task_id, task.id);
  } finally {
    await s.close();
  }
});

test("one notice reaches one address once, however many times it is sent", async () => {
  const s = await engineWithChannel();
  try {
    usable(s.t.contacts);
    const notice = s.t.notices.queue({ patientId: PATIENT, kind: "result-released", summary: "A result was released" });

    const first = s.t.notices.deliver(notice.id, { contacts: s.t.contacts, tasks: s.t.tasks });
    const second = s.t.notices.deliver(notice.id, { contacts: s.t.contacts, tasks: s.t.tasks });

    assert.equal(first.attempted.length, 1);
    assert.equal(second.attempted.length, 1);
    assert.equal(first.attempted[0].id, second.attempted[0].id, "the same attempt, not a second text");
    assert.equal(s.t.notices.deliveriesFor(notice.id).length, 1);
  } finally {
    await s.close();
  }
});

test("nothing clinical leaves the building", async () => {
  const s = await engineWithChannel();
  try {
    usable(s.t.contacts);
    const notice = s.t.notices.queue({
      patientId: PATIENT,
      kind: "result-released",
      summary: "Your potassium result has been released",
    });
    const [attempt] = s.t.notices.deliver(notice.id, { contacts: s.t.contacts, tasks: s.t.tasks }).attempted;

    const message = s.t.db.getMessage(attempt.message_id!)!;
    const raw = message.raw;
    // Not the summary, not the kind, not the chart, not what it is about.
    // "You have a new result" on a lock screen tells a bystander this person
    // had a test, which is clinical information arriving through the feature
    // meant to send none.
    assert.ok(!raw.includes("potassium"), `the outbound message named the result: ${raw}`);
    assert.ok(!raw.toLowerCase().includes("result"), `the outbound message named the kind: ${raw}`);
    assert.ok(!raw.includes(PATIENT), `the outbound message named the chart: ${raw}`);
    assert.ok(!raw.includes(notice.id));
    // What it does carry: an address and words that say to sign in.
    assert.ok(raw.includes("+15550100"));
    assert.match(raw, /Sign in/i);
  } finally {
    await s.close();
  }
});

test("the words say there is something to see, in the language on file", () => {
  assert.match(noticeBody("en-CA", "Northern Clinic"), /^Northern Clinic has an update/);
  assert.match(noticeBody("fr-CA", "Northern Clinic"), /a une mise a jour/);
  // Unstated is both, not English. A notice in a language somebody does not
  // read is a notice that was not sent.
  const unstated = noticeBody(null, "Northern Clinic");
  assert.match(unstated, /has an update/);
  assert.match(unstated, /mise a jour/);
  for (const lang of ["en", "fr", null]) {
    const body = noticeBody(lang, "Northern Clinic");
    assert.ok(!/result|résultat|appointment/i.test(body), `the body says something clinical: ${body}`);
  }
});

test("reading it in the portal is a different fact from every delivery state", async () => {
  const s = await engineWithChannel();
  try {
    usable(s.t.contacts);
    const notice = s.t.notices.queue({ patientId: PATIENT, kind: "result-released", summary: "A result was released" });
    const [attempt] = s.t.notices.deliver(notice.id, { contacts: s.t.contacts, tasks: s.t.tasks }).attempted;
    s.t.notices.recordReceipt(attempt.id, { state: "unknown", detail: "carrier never reported" });

    const viewed = s.t.notices.markViewed(notice.id);
    assert.ok(viewed.viewed_at);
    // The strongest evidence available — a person signed in and looked — and
    // it deliberately changes nothing else. The gateway's opinion is about a
    // phone; this is about a patient.
    assert.equal(s.t.notices.delivery(attempt.id)!.state, "unknown");
    assert.equal(viewed.status, "dispatched", "viewing is not telling");
    assert.equal(viewed.told_at, null);

    // And told stays a human writing it down.
    const told = s.t.notices.markTold(notice.id, { actorId: "clerk-avery" });
    assert.equal(told.status, "told");
    assert.ok(told.viewed_at, "which does not erase that they had already read it");
  } finally {
    await s.close();
  }
});

test("with no channel to send through, the attempt fails rather than pretending", async () => {
  const engine = new Engine({ dbPath: ":memory:", tickMs: 15 });
  await engine.start();
  try {
    const t = engine.forTenant("default");
    usable(t.contacts);
    const notice = t.notices.queue({ patientId: PATIENT, kind: "result-released", summary: "A result was released" });
    const [attempt] = t.notices.deliver(notice.id, { contacts: t.contacts, tasks: t.tasks }).attempted;
    assert.equal(attempt.state, "failed");
    assert.match(attempt.detail ?? "", /no notice channel configured/);
    assert.deepEqual(
      t.notices.followUp().map((r) => r.id),
      [attempt.id]
    );
  } finally {
    await engine.stop();
  }
});

test("a long silence from the gateway is chased only where a deployment says so", async () => {
  const s = await engineWithChannel();
  try {
    usable(s.t.contacts);
    const notice = s.t.notices.queue({ patientId: PATIENT, kind: "result-released", summary: "A result was released" });
    const [attempt] = s.t.notices.deliver(notice.id, { contacts: s.t.contacts, tasks: s.t.tasks }).attempted;
    assert.equal(attempt.state, "provider-accepted");

    // Without a threshold, an accepted attempt is not a finding: a deployment
    // with no receipt path would otherwise have every notice on its chase
    // list forever, which is the same as having no chase list.
    assert.deepEqual(s.t.notices.followUp(), []);

    // With one, silence past it is.
    const later = new Date(Date.now() + 3 * 3600_000);
    const chased = s.t.notices.followUp({ acceptedSilentForMs: 2 * 3600_000 }, later);
    assert.deepEqual(chased.map((r) => r.id), [attempt.id]);
  } finally {
    await s.close();
  }
});
