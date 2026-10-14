/**
 * Item 65: the logistics around a travelling-clinic visit — who owns each
 * one, and the two ways to reach "confirmed" that both require evidence
 * rather than a status somebody picked.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../src/db.ts";
import { Clinics } from "../src/schedule/clinics.ts";
import { TaskStore } from "../src/work/tasks.ts";
import { Arrangements, SyntheticExternalCoordinator, SYNTHETIC_CONFIRM_MARKER } from "../src/schedule/arrangements.ts";

const GP = { actorId: "dr-tetso", actorKind: "practitioner" };
const CLERK = { actorId: "clerk-amaruq", actorKind: "clerk" };

function clinic() {
  const dir = mkdtempSync(join(tmpdir(), "northstar-arrangements-"));
  const db = new Db(join(dir, "northstar.db"));
  const clinics = new Clinics(db);
  const tasks = new TaskStore(db);
  return {
    db,
    clinics,
    tasks,
    arrangements: new Arrangements(db, clinics, tasks),
    arrangementsExt: new Arrangements(db, clinics, tasks, new SyntheticExternalCoordinator()),
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}

function planVisit(c: ReturnType<typeof clinic>, overrides: Partial<{ community: string; startsOn: string }> = {}) {
  return c.clinics.planVisit({
    resourceId: "dr-tetso",
    service: "Diabetes follow-up",
    community: overrides.community ?? "Fort Smith",
    days: [{ date: overrides.startsOn ?? "2026-09-15", from: "09:00", to: "12:00" }],
    slotMinutes: 30,
    by: GP,
  }).visit;
}

// ------------------------------------------------------------ request()

test("an arrangement needs a known kind, a written detail, and a real, live visit", () => {
  const c = clinic();
  try {
    const visit = planVisit(c);
    assert.throws(
      () => c.arrangements.request({ visitId: visit.id, kind: "helicopter" as never, detail: "x", by: GP }),
      /unknown arrangement kind/
    );
    assert.throws(() => c.arrangements.request({ visitId: visit.id, kind: "transport", detail: "  ", by: GP }), /written detail/);
    assert.throws(() => c.arrangements.request({ visitId: "no-such-visit", kind: "transport", detail: "van", by: GP }), /no visit/);

    const cancelled = planVisit(c, { startsOn: "2026-10-01" });
    c.clinics.cancelVisit(cancelled.id, { ...GP, reason: "weather" });
    assert.throws(
      () => c.arrangements.request({ visitId: cancelled.id, kind: "transport", detail: "van", by: GP }),
      /cancelled; there is nothing left to arrange/
    );
  } finally {
    c.cleanup();
  }
});

test("a requested arrangement starts needed, owned by nobody, confirmed by nothing", () => {
  const c = clinic();
  try {
    const visit = planVisit(c);
    const a = c.arrangements.request({ visitId: visit.id, patientId: "NT000001", kind: "interpreter", detail: "South Slavey interpreter for the whole visit", by: GP });
    assert.equal(a.status, "needed");
    assert.equal(a.owner_id, null);
    assert.equal(a.confirmed_at, null);
    assert.equal(a.confirmation_evidence, null);
    assert.equal(a.patient_id, "NT000001");
  } finally {
    c.cleanup();
  }
});

// ------------------------------------------------------------- assign()

test("assigning needs an owner, and a cancelled arrangement cannot be assigned", () => {
  const c = clinic();
  try {
    const visit = planVisit(c);
    const a = c.arrangements.request({ visitId: visit.id, kind: "transport", detail: "boat from Fort Resolution", by: GP });
    assert.throws(() => c.arrangements.assign(a.id, "  ", CLERK), /somebody to own it/);
    const assigned = c.arrangements.assign(a.id, "clerk-amaruq", CLERK);
    assert.equal(assigned.owner_id, "clerk-amaruq");

    const cancelled = c.arrangements.cancel(a.id, { reason: "patient no longer attending", by: CLERK });
    assert.throws(() => c.arrangements.assign(cancelled.id, "somebody-else", CLERK), /cancelled arrangement cannot be assigned/);
  } finally {
    c.cleanup();
  }
});

// ------------------------------------------------------------- confirm()

test("confirming needs written evidence; a status is not evidence", () => {
  const c = clinic();
  try {
    const visit = planVisit(c);
    const a = c.arrangements.request({ visitId: visit.id, kind: "accommodation", detail: "one room, night before an early clinic", by: GP });
    assert.throws(() => c.arrangements.confirm(a.id, { evidence: "  ", by: CLERK }), /written evidence/);

    const confirmed = c.arrangements.confirm(a.id, { evidence: "spoke with the lodge, room 4 held under the patient's name", by: CLERK });
    assert.equal(confirmed.status, "confirmed");
    assert.equal(confirmed.confirmed_by, "clerk-amaruq");
    assert.match(confirmed.confirmation_evidence!, /room 4 held/);
    assert.ok(confirmed.confirmed_at);

    assert.throws(() => c.arrangements.confirm(a.id, { evidence: "again", by: CLERK }), /already confirmed/);
  } finally {
    c.cleanup();
  }
});

test("a cancelled arrangement cannot be confirmed", () => {
  const c = clinic();
  try {
    const visit = planVisit(c);
    const a = c.arrangements.request({ visitId: visit.id, kind: "escort", detail: "adult child travelling with an elder patient", by: GP });
    const cancelled = c.arrangements.cancel(a.id, { reason: "patient cancelled the visit", by: CLERK });
    assert.throws(() => c.arrangements.confirm(cancelled.id, { evidence: "x", by: CLERK }), /cancelled arrangement cannot be confirmed/);
  } finally {
    c.cleanup();
  }
});

// ------------------------------------------------------------- cancel()

test("cancelling needs a written reason, and a cancelled arrangement cannot be cancelled again", () => {
  const c = clinic();
  try {
    const visit = planVisit(c);
    const a = c.arrangements.request({ visitId: visit.id, kind: "equipment", detail: "portable ultrasound flown in with the clinician", by: GP });
    assert.throws(() => c.arrangements.cancel(a.id, { reason: " ", by: CLERK }), /written reason/);
    const cancelled = c.arrangements.cancel(a.id, { reason: "clinic no longer needs it this visit", by: CLERK });
    assert.equal(cancelled.status, "cancelled");
    assert.throws(() => c.arrangements.cancel(a.id, { reason: "again", by: CLERK }), /already cancelled/);
  } finally {
    c.cleanup();
  }
});

test("a confirmed arrangement can still be cancelled, with a reason", () => {
  const c = clinic();
  try {
    const visit = planVisit(c);
    const a = c.arrangements.request({ visitId: visit.id, kind: "transport", detail: "van from the airstrip", by: GP });
    c.arrangements.confirm(a.id, { evidence: "operator confirmed by radio", by: CLERK });
    const cancelled = c.arrangements.cancel(a.id, { reason: "patient found their own ride", by: CLERK });
    assert.equal(cancelled.status, "cancelled");
  } finally {
    c.cleanup();
  }
});

// ------------------------------------------------------- requestExternally()

test("requestExternally refuses when no external coordinator is configured", async () => {
  const c = clinic();
  try {
    const visit = planVisit(c);
    const a = c.arrangements.request({ visitId: visit.id, kind: "transport", detail: "van", by: GP });
    await assert.rejects(() => c.arrangements.requestExternally(a.id, CLERK), /no external coordinator is configured/);
  } finally {
    c.cleanup();
  }
});

test("an external request that is not immediately confirmed becomes requested, not confirmed", async () => {
  const c = clinic();
  try {
    const visit = planVisit(c);
    const a = c.arrangementsExt.request({ visitId: visit.id, kind: "interpreter", detail: "Tłı̨chǫ interpreter, ordinary request", by: GP });
    const after = await c.arrangementsExt.requestExternally(a.id, CLERK);
    assert.equal(after.status, "requested", "a request sent is not the same as a request granted");
    assert.ok(after.external_reference, "even an unconfirmed request carries a reference to follow up on");
    assert.equal(after.confirmation_evidence, null);
  } finally {
    c.cleanup();
  }
});

test("an external system that confirms immediately produces a confirmation with its own reference as evidence", async () => {
  const c = clinic();
  try {
    const visit = planVisit(c);
    const a = c.arrangementsExt.request({
      visitId: visit.id,
      kind: "accommodation",
      detail: `one room, ${SYNTHETIC_CONFIRM_MARKER}`,
      by: GP,
    });
    const after = await c.arrangementsExt.requestExternally(a.id, CLERK);
    assert.equal(after.status, "confirmed");
    assert.ok(after.external_reference);
    assert.match(after.confirmation_evidence!, /confirmed/);
    assert.ok(after.confirmed_at);
  } finally {
    c.cleanup();
  }
});

test("a request left pending externally can still be confirmed manually later", async () => {
  const c = clinic();
  try {
    const visit = planVisit(c);
    const a = c.arrangementsExt.request({ visitId: visit.id, kind: "transport", detail: "boat, ordinary request", by: GP });
    const pending = await c.arrangementsExt.requestExternally(a.id, CLERK);
    assert.equal(pending.status, "requested");
    const confirmed = c.arrangementsExt.confirm(a.id, { evidence: "operator called back and confirmed by phone", by: CLERK });
    assert.equal(confirmed.status, "confirmed");
    assert.ok(confirmed.external_reference, "the earlier reference is not lost by confirming manually afterward");
  } finally {
    c.cleanup();
  }
});

test("an external coordinator that answers with no reference is refused, not treated as evidence", async () => {
  const c = clinic();
  const blank = new Arrangements(c.db, c.clinics, c.tasks, {
    request: () => ({ reference: "  ", confirmed: true }),
  });
  try {
    const visit = planVisit(c);
    const a = blank.request({ visitId: visit.id, kind: "transport", detail: "van", by: GP });
    await assert.rejects(() => blank.requestExternally(a.id, CLERK), /no reference/);
    assert.equal(blank.get(a.id)!.status, "needed", "an unusable answer does not move the arrangement forward");
  } finally {
    c.cleanup();
  }
});

test("requestExternally refuses on a cancelled or already-confirmed arrangement", async () => {
  const c = clinic();
  try {
    const visit = planVisit(c);
    const cancelledOne = c.arrangementsExt.request({ visitId: visit.id, kind: "transport", detail: "van", by: GP });
    c.arrangementsExt.cancel(cancelledOne.id, { reason: "no longer needed", by: CLERK });
    await assert.rejects(() => c.arrangementsExt.requestExternally(cancelledOne.id, CLERK), /cancelled arrangement cannot be requested/);

    const confirmedOne = c.arrangementsExt.request({ visitId: visit.id, kind: "transport", detail: "van two", by: GP });
    c.arrangementsExt.confirm(confirmedOne.id, { evidence: "confirmed by phone", by: CLERK });
    await assert.rejects(() => c.arrangementsExt.requestExternally(confirmedOne.id, CLERK), /already confirmed/);
  } finally {
    c.cleanup();
  }
});

// ------------------------------------------------------------ listings

test("forVisit, forPatient and unconfirmed each answer a different question", () => {
  const c = clinic();
  try {
    const visit = planVisit(c);
    const other = planVisit(c, { startsOn: "2026-11-01" });
    const needed = c.arrangements.request({ visitId: visit.id, patientId: "NT000001", kind: "transport", detail: "van", by: GP });
    const confirmed = c.arrangements.request({ visitId: visit.id, patientId: "NT000001", kind: "interpreter", detail: "interpreter", by: GP });
    c.arrangements.confirm(confirmed.id, { evidence: "confirmed by phone", by: CLERK });
    const onOtherVisit = c.arrangements.request({ visitId: other.id, patientId: "NT000002", kind: "transport", detail: "van elsewhere", by: GP });

    assert.deepEqual(c.arrangements.forVisit(visit.id).map((a) => a.id).sort(), [needed.id, confirmed.id].sort());
    assert.deepEqual(c.arrangements.forPatient("NT000001").map((a) => a.id).sort(), [needed.id, confirmed.id].sort());
    // unconfirmed() is tenant-wide by design — the logistics board's queue,
    // not one visit's — so the other visit's still-needed arrangement is in
    // it too; only the confirmed one on either visit is excluded.
    assert.deepEqual(c.arrangements.unconfirmed().map((a) => a.id).sort(), [needed.id, onOtherVisit.id].sort());
  } finally {
    c.cleanup();
  }
});

// --------------------------------------------------- reviewAfterVisitChange

test("a visit change raises one reassignment task per live arrangement, and excludes cancelled ones", () => {
  const c = clinic();
  try {
    const visit = planVisit(c);
    const needed = c.arrangements.request({ visitId: visit.id, patientId: "NT000001", kind: "transport", detail: "van", by: GP });
    const confirmedOne = c.arrangements.request({ visitId: visit.id, patientId: "NT000002", kind: "interpreter", detail: "interpreter", by: GP });
    c.arrangements.confirm(confirmedOne.id, { evidence: "confirmed by phone", by: CLERK });
    const cancelledOne = c.arrangements.request({ visitId: visit.id, kind: "equipment", detail: "no longer relevant", by: GP });
    c.arrangements.cancel(cancelledOne.id, { reason: "not needed", by: CLERK });

    const raised = c.arrangements.reviewAfterVisitChange(visit.id, { reason: "visit moved a week later", by: GP });
    assert.equal(raised.length, 2, "the cancelled arrangement does not get a task; the confirmed one still does");
    assert.deepEqual(
      raised.map((t) => t.correlation_id).sort(),
      [needed.id, confirmedOne.id].sort(),
      "each task is traceable back to the arrangement it is about"
    );
    for (const t of raised) {
      assert.equal(t.kind, "arrangement");
      assert.equal(t.priority, "urgent");
      assert.match(t.title, /visit moved a week later/);
    }
    assert.deepEqual(
      raised.map((t) => t.patient_id).sort(),
      ["NT000001", "NT000002"].sort()
    );
  } finally {
    c.cleanup();
  }
});

test("reviewAfterVisitChange needs a reason, and a visit with nothing arranged raises nothing", () => {
  const c = clinic();
  try {
    const visit = planVisit(c);
    assert.throws(() => c.arrangements.reviewAfterVisitChange(visit.id, { reason: " ", by: GP }), /needs a reason/);
    assert.deepEqual(c.arrangements.reviewAfterVisitChange(visit.id, { reason: "cancelled", by: GP }), []);
  } finally {
    c.cleanup();
  }
});

test("a visit cancellation is exactly the kind of change that gets its arrangements reviewed", () => {
  const c = clinic();
  try {
    const visit = planVisit(c);
    const a = c.arrangements.request({ visitId: visit.id, kind: "transport", detail: "van", by: GP });
    c.clinics.cancelVisit(visit.id, { ...GP, reason: "weather" });
    const raised = c.arrangements.reviewAfterVisitChange(visit.id, { reason: "visit cancelled: weather", by: GP });
    assert.equal(raised.length, 1);
    assert.equal(raised[0].correlation_id, a.id);
  } finally {
    c.cleanup();
  }
});

// -------------------------------------------------------------- tenancy

test("arrangements are confined to their tenant", () => {
  const c = clinic();
  try {
    const visit = planVisit(c);
    const a = c.arrangements.request({ visitId: visit.id, kind: "transport", detail: "van", by: GP });

    const otherDb = c.db.forTenant("second-clinic");
    const otherClinics = new Clinics(otherDb);
    const otherTasks = new TaskStore(otherDb);
    const otherArrangements = new Arrangements(otherDb, otherClinics, otherTasks);
    assert.equal(otherArrangements.get(a.id), undefined);
    assert.deepEqual(otherArrangements.forVisit(visit.id), []);
  } finally {
    c.cleanup();
  }
});
