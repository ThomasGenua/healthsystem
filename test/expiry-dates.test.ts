/**
 * An expiry is a date the clock can compare, or it is refused.
 *
 * A caregiver's access, an API key and a result hold all end at a stored
 * time, compared as text against the clock: `expires_at > ?`. That is right
 * only when both sides are in one form, and the stored side was whatever the
 * caller typed. "December 31, 2027" sorts after every ISO timestamp, so a
 * grant written that way was still live in 2030 — H-30's delegated access
 * that never ends, reached by typing the date out in words. "next year" is
 * NaN to `new Date()`, NaN is never "already past", and so it was accepted.
 * "12/31/2027" sorts before every timestamp, so that grant never began. A
 * time with an offset ended hours early.
 *
 * What is held here: only a calendar date or a time with its zone is
 * accepted, and it is stored in the one canonical UTC form; a row stored
 * before this that is not a date is treated as expired, not honoured
 * forever; and boot counts those rows so somebody can re-record them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine } from "../src/core/engine.ts";
import { Refusal } from "../src/core/refusal.ts";
import { instant, unreadableExpiries, unreadableExpiryWarnings } from "../src/core/instant.ts";

const P = "NT123456";
const CLERK = { actorId: "registration-desk", actorKind: "practitioner" };
const GP = { actorId: "dr-tetso", actorKind: "practitioner" };
const PROXY = {
  patientId: P,
  relationship: "parent-guardian" as const,
  permissions: ["appointments" as const],
  purpose: "parent of a minor",
  by: CLERK,
};

async function clinic() {
  const engine = new Engine({ dbPath: ":memory:", tickMs: 15, orderDispatchIntervalMs: 0 });
  await engine.start();
  return { engine, t: engine.forTenant("default"), close: () => engine.stop() };
}

function refused(fn: () => unknown, what: string): Refusal {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof Refusal, `${what}: thrown as ${(err as Error)?.constructor?.name}, not a refusal`);
    assert.equal(err.status, 400, `${what}: status`);
    return err;
  }
  assert.fail(`${what}: accepted`);
}

test("expiries: a calendar date or a time with its zone, stored in the one form the clock compares", () => {
  assert.equal(instant("2027-12-31", "an expiry"), "2027-12-31T00:00:00.000Z", "a date is midnight UTC, as the text comparison always read it");
  assert.equal(instant("2027-12-31T17:00:00-07:00", "an expiry"), "2028-01-01T00:00:00.000Z");
  assert.equal(instant("2027-12-31T17:00Z", "an expiry"), "2027-12-31T17:00:00.000Z");
  assert.equal(instant("2027-12-31T17:00:00.5+05:30", "an expiry"), "2027-12-31T11:30:00.500Z");
  assert.equal(instant("2028-02-29", "an expiry"), "2028-02-29T00:00:00.000Z", "a leap day that exists");

  for (const [value, why] of [
    ["December 31, 2027", "words sort after every timestamp: never lapses"],
    ["next year", "not a date at all"],
    ["12/31/2027", "sorts before every timestamp: never begins"],
    ["01/02/2027", "a different day in Toronto and in Texas"],
    ["2027-12-31T17:00", "no zone: a different instant on every server"],
    ["2027-02-29", "a day that does not exist, which new Date() turns into 1 March"],
    ["2027-02-30", "turned into 2 March"],
    ["2027-13-01", "no thirteenth month"],
    ["2027-12-31T24:00:00Z", "hour 24, turned into the next day"],
    ["", "nothing"],
  ] as const) {
    const err = refused(() => instant(value, "an expiry"), `${JSON.stringify(value)} (${why})`);
    assert.match(err.message, /^an expiry has to be a date like 2027-12-31, or a time with its zone/);
  }
  refused(() => instant(1735689600000, "an expiry"), "a number");
  refused(() => instant(null, "an expiry"), "null");
});

test("expiries: a caregiver grant written out in words is refused, not granted forever", async () => {
  const s = await clinic();
  try {
    // Before: stored as typed, and still live in 2030.
    for (const expiresAt of ["December 31, 2027", "next year", "12/31/2027"]) {
      refused(() => s.t.patientAccess.grantProxy({ ...PROXY, subjectId: `urn:dev:${expiresAt}`, expiresAt }), expiresAt);
    }
    assert.deepEqual(s.t.patientAccess.whoCanSee(P), [], "none of them was granted");

    // A time with an offset ends at that instant — not hours early, as the
    // text comparison against a UTC clock had it.
    const grant = s.t.patientAccess.grantProxy({ ...PROXY, subjectId: "urn:dev:parent", expiresAt: "2099-06-30T17:00:00-07:00" });
    assert.equal(grant.expires_at, "2099-07-01T00:00:00.000Z");
    assert.ok(s.t.patientAccess.may("urn:dev:parent", P, "2099-06-30T23:59:59.999Z"), "live up to the minute it was set to end");
    assert.equal(s.t.patientAccess.may("urn:dev:parent", P, "2099-07-01T00:00:00.000Z"), undefined, "and not a moment after");
  } finally {
    await s.close();
  }
});

test("expiries: a grant or key already stored with an end that is not a date is expired, and boot says so", async () => {
  const s = await clinic();
  try {
    // Rows as the old code wrote them: exactly what was typed.
    const words = s.t.patientAccess.grantProxy({ ...PROXY, subjectId: "urn:dev:words", expiresAt: "2099-12-31" });
    const dateOnly = s.t.patientAccess.grantProxy({ ...PROXY, subjectId: "urn:dev:date-only", expiresAt: "2099-12-31" });
    const key = s.engine.keys.issue("legacy integration", ["read"]);
    const setExpiry = (table: string, id: string, value: string) =>
      s.engine.db.sql.prepare(`UPDATE ${table} SET expires_at = ? WHERE id = ?`).run(value, id);
    setExpiry("patient_authority", words.id, "December 31, 2027");
    setExpiry("patient_authority", dateOnly.id, "2099-12-31");
    setExpiry("api_keys", key.id, "next year");

    // Not honoured on any path that asks whether access is live.
    const access = s.t.patientAccess;
    assert.equal(access.may("urn:dev:words", P), undefined, "may()");
    assert.deepEqual(access.forSubject("urn:dev:words"), [], "forSubject()");
    assert.ok(access.liveSubjects().some((l) => l.subject === "urn:dev:date-only"), "liveSubjects() lists the live grant…");
    assert.ok(!access.liveSubjects().some((l) => l.subject === "urn:dev:words"), "…and not the one that is not a date; it decides who can sign in");
    assert.ok(!access.whoCanSee(P).some((g) => g.id === words.id), "whoCanSee()");
    assert.equal(s.engine.keys.verify(key.key), null, "and the key no longer opens anything");
    assert.equal(s.engine.db.countActiveApiKeys(), 0, "nor is it counted as an active credential");

    // A date written the way a correct caller always wrote it is untouched.
    assert.ok(access.may("urn:dev:date-only", P), "a stored calendar date still compares as it always did");

    // And boot names what stopped working, so it is a list and not a mystery.
    assert.deepEqual(unreadableExpiries(s.engine.db), [{ tenant: "default", grants: 1, keys: 1 }]);
    const warnings = unreadableExpiryWarnings(s.engine.db);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /^WARNING: tenant default has 1 caregiver grant\(s\) and 1 API key\(s\) whose expiry is not a date/);
    // A revoked grant is not counted: it is not access either way.
    access.revoke(words.id, { ...CLERK, reason: "re-recorded with a date" });
    assert.deepEqual(unreadableExpiries(s.engine.db), [{ tenant: "default", grants: 0, keys: 1 }]);
  } finally {
    await s.close();
  }
});

test("expiries: an API key with an expiry that is not a date is refused, not issued forever", async () => {
  const s = await clinic();
  try {
    refused(() => s.engine.keys.issue("integration", ["read"], { expiresAt: "next year" }), "next year");
    refused(() => s.engine.keys.issue("integration", ["read"], { expiresAt: "December 31, 2027" }), "words");
    assert.ok(!s.engine.keys.list().some((k) => k.name === "integration"), "no key was issued");

    const issued = s.engine.keys.issue("integration", ["read"], { expiresAt: "2099-12-31T17:00:00-07:00" });
    assert.equal(issued.expiresAt, "2100-01-01T00:00:00.000Z", "the caller is shown the end that will be enforced");
    assert.ok(s.engine.keys.verify(issued.key));
  } finally {
    await s.close();
  }
});

test("expiries: an enrolment's expiry is read at the desk, not weeks later at attestation", async () => {
  const s = await clinic();
  try {
    const ask = (expiresAt: string) =>
      s.t.enrolment.request({ ...PROXY, subjectId: "urn:dev:parent", expiresAt });
    refused(() => ask("December 31, 2027"), "words");
    const past = refused(() => ask("2020-01-01"), "an end already gone");
    assert.equal(past.message, "that expiry is already past");
    assert.deepEqual(s.t.enrolment.list({ patientId: P }), [], "no request a clerk could never attest was left pending");

    const pending = ask("2099-12-31");
    assert.equal(pending.expires_at, "2099-12-31T00:00:00.000Z");
    const attested = s.t.enrolment.attest(pending.id, { method: "photo ID checked against the chart at the desk", by: CLERK });
    assert.equal(s.t.patientAccess.authority(attested.authority_id!)!.expires_at, "2099-12-31T00:00:00.000Z");
  } finally {
    await s.close();
  }
});

test("expiries: a result hold's release date is read the same way", async () => {
  const s = await clinic();
  try {
    const o = s.t.orders.create({ patientId: P, category: "lab", code: "2823-3", display: "Potassium", indication: "Electrolyte check", by: GP });
    s.t.orders.place(o.id, { ...GP, responsibleId: "dr-tetso" });
    const r = s.t.orders.report({ patientId: P, orderId: o.id, code: "2823-3", display: "Potassium", value: "4.1", reportedBy: "analyser" });
    const hold = { resultId: r.id, category: "clinician-will-discuss" as const, by: GP, reason: "appointment Thursday" };
    refused(() => s.t.patientAccess.hold({ ...hold, releaseAt: "next Thursday" }), "words");
    s.t.patientAccess.hold({ ...hold, releaseAt: "2099-06-30T17:00:00-07:00" });
    assert.deepEqual(s.t.patientAccess.activeHolds().map((h) => h.release_at), ["2099-07-01T00:00:00.000Z"]);
  } finally {
    await s.close();
  }
});
