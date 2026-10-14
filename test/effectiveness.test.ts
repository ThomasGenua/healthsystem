/**
 * Item 67: whether the workflows this codebase built actually help, over a
 * stated window — six metrics, each honest about what it does not know
 * rather than folding "not yet" or "cannot tell" into success.
 *
 * Every metric here is a pure function over a narrow source interface, so
 * these tests use plain in-memory fixtures rather than a database: the
 * numerator/denominator/exclusion logic is what is under test, not the SQL
 * that feeds it (the six new store query methods it is built on are exact
 * date-range selects, exercised for real by the API route tests).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  timeToClinicianReview,
  unresolvedFollowUp,
  referralCompletion,
  notificationFailures,
  missedAppointments,
  staffTaskBurden,
} from "../src/population/effectiveness.ts";

const FROM = "2026-08-01T00:00:00.000Z";
const TO = "2026-08-31T00:00:00.000Z";
const ASOF = "2026-09-01T00:00:00.000Z";

// ---------------------------------------------------- timeToClinicianReview

test("time to clinician review: reviewed within target counts, late or pending does not, and there is never an unknown", () => {
  const source = {
    submittedBetween: () => [
      { id: "s1", patient_id: "P1", status: "reviewed", submitted_at: "2026-08-10T00:00:00Z", reviewed_at: "2026-08-10T12:00:00Z" }, // 12h, within 24h
      { id: "s2", patient_id: "P2", status: "reviewed", submitted_at: "2026-08-10T00:00:00Z", reviewed_at: "2026-08-12T00:00:00Z" }, // 48h, late
      { id: "s3", patient_id: "P3", status: "submitted", submitted_at: "2026-08-10T00:00:00Z", reviewed_at: null }, // still pending
    ],
  };
  const r = timeToClinicianReview(source, { from: FROM, to: TO, target: { withinHours: 24 } }, ASOF);
  assert.equal(r.denominator, 3);
  assert.equal(r.numerator, 1);
  assert.equal(r.rate, 1 / 3);
  assert.deepEqual(r.unclassified, [], "no submission's status is ever ambiguous");
  assert.equal(r.complete, true);
});

test("time to clinician review: exactly at the target boundary counts; a review that has not happened yet as of asOf does not", () => {
  const source = {
    submittedBetween: () => [
      { id: "s1", patient_id: "P1", status: "reviewed", submitted_at: "2026-08-10T00:00:00Z", reviewed_at: "2026-08-11T00:00:00Z" }, // exactly 24h
      // Reviewed only an hour after submission — well within target — but
      // that review is dated after asOf, a clock skew or a bad fixture, and
      // must not be credited before, from this report's own point of view,
      // it has happened.
      { id: "s2", patient_id: "P2", status: "reviewed", submitted_at: "2026-09-01T12:00:00Z", reviewed_at: "2026-09-01T13:00:00Z" },
    ],
  };
  const r = timeToClinicianReview(source, { from: FROM, to: TO, target: { withinHours: 24 } }, ASOF);
  assert.equal(r.numerator, 1, "only s1 counts; s2's review has not happened yet as of asOf");
});

test("time to clinician review needs a positive target and a sane window", () => {
  const source = { submittedBetween: () => [] };
  assert.throws(() => timeToClinicianReview(source, { from: FROM, to: TO, target: { withinHours: 0 } }), /positive number/);
  assert.throws(() => timeToClinicianReview(source, { from: TO, to: FROM, target: { withinHours: 24 } }), /to must not be before from/);
});

// ---------------------------------------------------------- unresolvedFollowUp

test("unresolved follow-up: not-needed is excluded, resolved counts, outstanding does not", () => {
  const source = {
    itemsRaisedBetween: () => [
      { id: "i1", patientId: "P1", status: "resolved" },
      { id: "i2", patientId: "P2", status: "outstanding" },
      { id: "i3", patientId: "P3", status: "outstanding" },
      { id: "i4", patientId: "P4", status: "not-needed" },
    ],
  };
  const r = unresolvedFollowUp(source, { from: FROM, to: TO }, ASOF);
  assert.equal(r.denominator, 3, "not-needed is excluded from scope entirely");
  assert.equal(r.numerator, 1, "one resolved of the three still in scope");
  assert.deepEqual(r.unclassified, []);
});

// ---------------------------------------------------------- referralCompletion

test("referral completion: declined and cancelled are excluded, closed counts, reported alone does not", () => {
  const source = {
    sentBetween: () => [
      { id: "r1", patient_id: "P1", status: "closed" },
      { id: "r2", patient_id: "P2", status: "reported" },
      { id: "r3", patient_id: "P3", status: "reported" },
      { id: "r4", patient_id: "P4", status: "declined" },
      { id: "r5", patient_id: "P5", status: "cancelled" },
      { id: "r6", patient_id: "P6", status: "sent" },
    ],
  };
  const r = referralCompletion(source, { from: FROM, to: TO }, ASOF);
  assert.equal(r.denominator, 4, "declined and cancelled are a different, deliberate outcome, not left in flight");
  assert.equal(r.numerator, 1, "only closed is a recorded outcome; reported alone keeps the clock running");
  assert.deepEqual(r.unclassified, []);
});

// ------------------------------------------------------- notificationFailures

test("notification failures: queued is not yet attempted, failed counts, unknown and provider-accepted are preserved as unclassified", () => {
  const source = {
    deliveriesBetween: () => [
      { id: "d1", state: "delivered" },
      { id: "d2", state: "delivered" },
      { id: "d3", state: "failed" },
      { id: "d4", state: "unknown" },
      { id: "d5", state: "provider-accepted" },
      { id: "d6", state: "queued" },
    ],
  };
  const r = notificationFailures(source, { from: FROM, to: TO }, ASOF);
  assert.equal(r.denominator, 5, "queued was never actually attempted");
  assert.equal(r.numerator, 1);
  assert.equal(r.unclassified.length, 2);
  assert.deepEqual(
    r.unclassified.map((u) => u.id).sort(),
    ["d4", "d5"]
  );
  const byId = Object.fromEntries(r.unclassified.map((u) => [u.id, u.reason]));
  assert.match(byId["d4"], /could not be mapped|receipt/);
  assert.match(byId["d5"], /no delivery receipt has confirmed/);
});

test("notification failures: too much unclassified withholds the rate rather than guessing", () => {
  const source = {
    deliveriesBetween: () => [
      { id: "d1", state: "failed" },
      { id: "d2", state: "unknown" },
      { id: "d3", state: "unknown" },
    ],
  };
  const r = notificationFailures(source, { from: FROM, to: TO }, ASOF);
  assert.equal(r.rate, null, "2 of 3 unclassified is far past the fifth this system tolerates");
  assert.equal(r.complete, false);
});

// -------------------------------------------------------- missedAppointments

test("missed appointments: cancelled is excluded, did-not-attend counts, a past appointment with no outcome is unclassified", () => {
  const source = {
    bookingsBetween: () => [
      { id: "b1", patient_id: "P1", status: "attended", startsAt: "2026-08-15T10:00:00Z" },
      { id: "b2", patient_id: "P2", status: "did-not-attend", startsAt: "2026-08-15T10:00:00Z" },
      { id: "b3", patient_id: "P3", status: "cancelled", startsAt: "2026-08-15T10:00:00Z" },
      { id: "b4", patient_id: "P4", status: "booked", startsAt: "2026-08-15T10:00:00Z" }, // over two weeks before asOf
      { id: "b5", patient_id: "P5", status: "booked", startsAt: "2026-08-31T23:00:00Z" }, // one hour before asOf
      { id: "b6", patient_id: "P6", status: "did-not-attend", startsAt: "2026-08-16T10:00:00Z" },
      { id: "b7", patient_id: "P7", status: "booked", startsAt: "2026-08-31T00:00:00Z" }, // exactly the grace period before asOf
    ],
  };
  const r = missedAppointments(source, { from: FROM, to: TO, outcomeGraceHours: 24 }, ASOF);
  assert.equal(r.denominator, 6, "the cancelled booking is a deliberate outcome, not a miss");
  assert.equal(r.numerator, 2, "b2 and b6 are the two did-not-attend bookings");
  assert.deepEqual(r.unclassified.map((u) => u.id), ["b4"], "b5 and b7 are still within their grace period; only b4 is over it");
});

test("missed appointments needs a positive grace period", () => {
  const source = { bookingsBetween: () => [] };
  assert.throws(() => missedAppointments(source, { from: FROM, to: TO, outcomeGraceHours: -1 }, ASOF), /positive number/);
});

// -------------------------------------------------------------- staffTaskBurden

test("staff task burden: cancelled is excluded, completed counts, and a named owner filters to their own work", () => {
  const source = {
    createdBetween: () => [
      { id: "t1", patient_id: "P1", status: "completed", owner_id: "clerk-a" },
      { id: "t2", patient_id: "P2", status: "open", owner_id: "clerk-a" },
      { id: "t3", patient_id: null, status: "cancelled", owner_id: "clerk-a" },
      { id: "t4", patient_id: "P3", status: "completed", owner_id: "clerk-b" },
    ],
  };
  const tenantWide = staffTaskBurden(source, { from: FROM, to: TO }, ASOF);
  assert.equal(tenantWide.denominator, 3, "the cancelled task is a decision not to do it, not a failure to");
  assert.equal(tenantWide.numerator, 2);

  const forClerkA = staffTaskBurden(source, { from: FROM, to: TO, ownerId: "clerk-a" }, ASOF);
  assert.equal(forClerkA.denominator, 2);
  assert.equal(forClerkA.numerator, 1);
  assert.match(forClerkA.name, /clerk-a/);
});

// -------------------------------------------------------------- shared build()

test("an empty denominator says there is nothing to report, not a rate of zero", () => {
  const r = unresolvedFollowUp({ itemsRaisedBetween: () => [] }, { from: FROM, to: TO }, ASOF);
  assert.equal(r.denominator, 0);
  assert.equal(r.rate, null);
  assert.match(r.caveat ?? "", /nothing to report/);
});
