/**
 * The clinical platform over HTTP, and the trail it must leave.
 *
 * Section 18 wants every access to patient data on an audit trail. The stores
 * built for sections 1 through 9 were libraries — nothing reached them over a
 * network, so nothing went unrecorded. Exposing them is the moment that
 * changes, and an audit guarantee that depends on each new route remembering
 * to call `audit()` is one that holds until the fiftieth route.
 *
 * So the load-bearing test is the last one. It reads the routing source,
 * extracts every clinical path, drives each, and fails if any of them serves
 * patient data without leaving a row. A route added tomorrow with no trail
 * does not quietly work — it breaks the build.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Engine } from "../src/core/engine.ts";
import { startApi } from "../src/api/admin.ts";
import { AuthGate } from "../src/auth/gate.ts";
import type { AuditRow } from "../src/audit/store.ts";

const P = "NT123456";
const GP = { actorId: "dr-tetso", actorKind: "practitioner" };
const GP_AUTHOR = { authorId: "dr-tetso", authorKind: "practitioner" };

async function boot() {
  // A pharmacy channel, so the prescription routes exercise the transmit path
  // rather than the refusal a deployment without one gets.
  const engine = new Engine({ dbPath: ":memory:", tickMs: 15, pharmacyChannel: "pharmacy-out" });
  await engine.start();
  engine.db.upsertChannel(
    "pharmacy-out",
    "Pharmacy transmissions",
    true,
    JSON.stringify({
      id: "pharmacy-out",
      name: "Pharmacy transmissions",
      source: { type: "http", path: "pharmacy-out" },
      destinations: [{ id: "pharmacy", type: "http", url: "http://127.0.0.1:1/pharmacy" }],
    })
  );
  const adminKey = engine.keys.issue("ops", ["admin"]);
  const admin = adminKey.key;
  const reader = engine.keys.issue("consumer", ["read"]).key;
  const api = await startApi(engine, 0, "127.0.0.1", { auth: new AuthGate({ keys: engine.keys }) });
  const base = `http://127.0.0.1:${api.port}`;

  const t = engine.forTenant("default");
  t.clinical.record({
    entryType: "Patient",
    patientId: P,
    content: {
      resourceType: "Patient",
      identifier: [{ system: "urn:jhn", value: P }],
      name: [{ family: "Beaulieu", given: ["Marie"], use: "official" }],
      birthDate: "1984-03-17",
    },
    authorId: "adt-feed",
    authorKind: "device",
  });
  t.meds.recordAllergy({ patientId: P, display: "Penicillin", ingredient: "penicillin", criticality: "high", by: GP });
  t.meds.record({
    patientId: P,
    code: "860975",
    display: "Metformin 500mg",
    ingredient: "metformin",
    source: "prescribed",
    adherence: "taking",
    by: GP,
  });
  const order = t.orders.create({
    patientId: P,
    category: "lab",
    code: "2823-3",
    display: "Potassium",
    indication: "Electrolyte check",
    by: GP,
  });
  t.orders.place(order.id, { ...GP, responsibleId: "dr-tetso" });
  t.orders.report({
    patientId: P,
    orderId: order.id,
    code: "2823-3",
    display: "Potassium",
    value: "7.1",
    abnormalFlag: "critical-high",
    reportedBy: "analyser",
  });
  const ref = t.referrals.create({
    patientId: P,
    fromService: "Primary Care",
    toService: "Nephrology",
    indication: "Rising potassium",
    by: GP,
  });
  t.referrals.send(ref.id, { ...GP, respondBy: "2020-01-01T00:00:00Z" });
  t.tasks.create({ kind: "result-review", title: "Review potassium", by: GP, patientId: P, ownerId: "dr-tetso" });
  const note = t.notes.draft({ patientId: P, noteType: "SOAP", sections: { plan: "Repeat" }, author: GP_AUTHOR });
  t.notes.sign(note.record_id, GP_AUTHOR);
  t.directory.addPractitioner({ id: "dr-tetso", family: "Tetso", given: "Jean" });
  t.immunizations.record({
    patientId: P,
    vaccine: "MMR",
    occurrenceAt: "2010-06-01T00:00:00Z",
    by: GP_AUTHOR,
  });
  t.vitals.record({
    patientId: P,
    kind: "heart-rate",
    value: 72,
    unit: "/min",
    takenAt: "2026-08-24T10:00:00Z",
    by: GP_AUTHOR,
  });
  t.careTeam.assign({ patientId: P, practitionerId: "dr-tetso", role: "primary", by: { actorId: "ops" } });
  t.coverage.record({ patientId: P, plan: "NIHB", eligibility: "eligible", by: { actorId: "ops" } });

  return {
    engine,
    base,
    admin,
    adminId: adminKey.id,
    reader,
    get: (p: string, key = admin) => fetch(`${base}${p}`, { headers: { authorization: `Bearer ${key}` } }),
    trail: () => engine.forTenant("default").audit.list({ limit: 500 }) as AuditRow[],
    close: async () => {
      await api.close();
      await engine.stop();
    },
  };
}

test("the assembled chart is served, and the read is on the trail", async () => {
  const s = await boot();
  try {
    const before = s.trail().length;
    const res = await s.get(`/api/clinical/chart?patient=${P}`);
    assert.equal(res.status, 200);
    const chart = (await res.json()) as { allergyStatus: string; medications: { items: unknown[] }; complete: boolean };

    assert.equal(chart.allergyStatus, "documented");
    assert.equal(chart.medications.items.length, 1);
    assert.equal(chart.complete, true);

    const rows = s.trail();
    assert.equal(rows.length, before + 1, "one read, one row");
    assert.equal(rows[0].patient, P, "and it names who was looked at");
    assert.equal(rows[0].action, "R");
    assert.equal(rows[0].principal_id, s.adminId, "the credential that looked, not a label");
    assert.equal(rows[0].path, "/api/clinical/chart");
  } finally {
    await s.close();
  }
});

test("a search that finds nobody is still an access", async () => {
  // "Who did you look for" is a question a privacy review asks, and a
  // fruitless search for a well-known name is exactly the one it asks about.
  const s = await boot();
  try {
    const before = s.trail().length;
    const res = await s.get("/api/clinical/patients?family=Trudeau");
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { rows: [], withheldCount: 0 });

    const rows = s.trail();
    assert.equal(rows.length, before + 1, "nothing found, and the looking is recorded");
    assert.equal(rows[0].resource_type, "Patient");
    assert.equal(rows[0].count, 0);
  } finally {
    await s.close();
  }
});

test("the allergy endpoint carries the three-valued status, not a bare list", async () => {
  const s = await boot();
  try {
    const res = await s.get(`/api/clinical/allergies?patient=${P}`);
    const body = (await res.json()) as { status: string; allergies: unknown[] };
    assert.equal(body.status, "documented");
    assert.equal(body.allergies.length, 1);

    const other = await s.get("/api/clinical/allergies?patient=NT999");
    const none = (await other.json()) as { status: string; allergies: unknown[] };
    assert.equal(none.allergies.length, 0);
    assert.equal(none.status, "never-asked", "an empty list is not an answer, and the wire says so");
  } finally {
    await s.close();
  }
});

test("the safety check runs over the wire and is audited as a read of the patient", async () => {
  const s = await boot();
  try {
    const before = s.trail().length;
    const res = await fetch(`${s.base}/api/clinical/safety-check`, {
      method: "POST",
      headers: { authorization: `Bearer ${s.admin}`, "content-type": "application/json" },
      body: JSON.stringify({ patient: P, ingredient: "amoxicillin", display: "Amoxicillin 500mg" }),
    });
    assert.equal(res.status, 200);
    const check = (await res.json()) as { clear: boolean; blocking: Array<{ kind: string; severity: string }> };
    assert.equal(check.clear, false);
    assert.equal(check.blocking[0].kind, "allergy");
    assert.equal(check.blocking[0].severity, "contraindicated");

    const rows = s.trail();
    assert.equal(rows.length, before + 1);
    assert.equal(rows[0].patient, P, "consulting a patient's allergies is reading their record");
    assert.match(rows[0].detail ?? "", /safety check: amoxicillin/);
  } finally {
    await s.close();
  }
});

test("the clinical routes need admin, and a refused reach is itself recorded", async () => {
  const s = await boot();
  try {
    const before = s.trail().length;
    const res = await s.get(`/api/clinical/chart?patient=${P}`, s.reader);
    assert.equal(res.status, 403, "a facade read scope is not a licence to open charts");

    const rows = s.trail();
    assert.equal(rows.length, before + 1, "a rejected reach for a patient record is what a trail exists to show");
    assert.notEqual(rows[0].outcome, 0);

    const anon = await fetch(`${s.base}/api/clinical/chart?patient=${P}`);
    assert.equal(anon.status, 401);
  } finally {
    await s.close();
  }
});

test("one custodian's clinical API cannot reach another's charts", async () => {
  const engine = new Engine({ dbPath: ":memory:", tickMs: 15 });
  await engine.start();
  engine.db.createTenant("north", "Northern Health");
  engine.db.createTenant("south", "Southern Health");
  const north = engine.forTenant("north");
  north.meds.recordAllergy({
    patientId: P,
    display: "Penicillin",
    ingredient: "penicillin",
    criticality: "high",
    by: GP,
  });
  const southKey = engine.forTenant("south").keys.issue("south-ops", ["admin"]).key;
  const api = await startApi(engine, 0, "127.0.0.1", { auth: new AuthGate({ keys: engine.keys }) });
  try {
    const res = await fetch(`http://127.0.0.1:${api.port}/api/clinical/allergies?patient=${P}`, {
      headers: { authorization: `Bearer ${southKey}` },
    });
    const body = (await res.json()) as { status: string; allergies: unknown[] };
    assert.equal(body.allergies.length, 0);
    assert.equal(body.status, "never-asked", "not 'documented' — the allergy is the north's");

    // And the attempt is on the south's trail, not the north's.
    assert.equal(engine.forTenant("south").audit.list({ limit: 10 })[0].patient, P);
    assert.equal(engine.forTenant("north").audit.count(), 0);
  } finally {
    await api.close();
    await engine.stop();
  }
});

test("every clinical route leaves an audit row, including ones added later", async () => {
  // The load-bearing test. An audit guarantee that depends on each new route
  // remembering to call audit() is one that holds until somebody forgets, and
  // the forgetting is invisible — the route works, the data is served, and
  // nothing says the trail is short.
  //
  // So the routes are discovered by reading the source rather than listed
  // here. A path added to admin.ts is a path this drives, and if it answers
  // 200 without recording anything, this fails.
  const source = readFileSync(new URL("../src/api/admin.ts", import.meta.url), "utf8");
  // The character class admits "/" so a route nested under a subpath is
  // found too. It did not, once, and a route added as
  // /api/clinical/encounter/arrive would have been exempt from this whole
  // guarantee by virtue of its name.
  const paths = [...new Set([...source.matchAll(/path === "(\/api\/clinical\/[a-z/-]+)"/g)].map((m) => m[1]))];
  assert.ok(paths.length >= 16, `expected the clinical routes to be found by scanning, got ${paths.length}`);

  const s = await boot();
  try {
    // An override for the two routes that drain the break-glass queues to act
    // on. Made here rather than listed as a literal because their bodies name
    // a row that has to exist.
    // An unacknowledged result for the acknowledge route to act on. The
    // fixture's own critical potassium is used by other cases here, so this is
    // a second one rather than a shared one — a route that only passes because
    // another test has not run yet is not a route anything has driven.
    const forAck = s.engine.forTenant("default").orders.create({
      patientId: P,
      category: "lab",
      code: "2823-3",
      display: "Potassium (repeat)",
      indication: "Recheck",
      by: GP,
    });
    s.engine.forTenant("default").orders.place(forAck.id, { ...GP, responsibleId: "dr-tetso" });
    const pending = s.engine.forTenant("default").orders.report({
      patientId: P,
      orderId: forAck.id,
      code: "2823-3",
      display: "Potassium (repeat)",
      value: "5.2",
      reportedBy: "analyser",
    });

    // A visit for the encounter routes to read and act on, and a second one
    // left planned so the cancel route has something it is allowed to cancel:
    // an encounter that started refuses cancellation on purpose.
    const visit = s.engine.forTenant("default").encounters.open({
      patientId: P,
      class: "in-person",
      reason: "Knee review",
      by: { actorId: "dr-tetso", actorKind: "practitioner" },
      arrived: true,
    });
    const planned = s.engine.forTenant("default").encounters.open({
      patientId: P,
      class: "telephone",
      reason: "Medication review",
      by: { actorId: "dr-tetso", actorKind: "practitioner" },
    });
    // A third, because the arrive route runs before the cancel route and
    // starts `planned` — after which cancelling it is refused, correctly. A
    // route that only passes because of the order these happen to run in is
    // exactly what this test exists to catch.
    const toCancel = s.engine.forTenant("default").encounters.open({
      patientId: P,
      class: "telephone",
      reason: "Repeat prescription",
      by: { actorId: "dr-tetso", actorKind: "practitioner" },
    });
    const slot = s.engine.forTenant("default").schedule.openSlot({
      resourceId: "dr-tetso",
      service: "GP review",
      startsAt: "2026-09-01T10:00:00Z",
      endsAt: "2026-09-01T10:30:00Z",
    });
    const membership = s.engine.forTenant("default").careTeam.assign({
      patientId: P,
      practitionerId: "dr-tetso",
      role: "allied",
      by: { actorId: "ops" },
    });
    const messaging = s.engine.forTenant("default").messaging;
    const thread = messaging.open({
      patientId: P,
      subject: "Seen on the chart",
      body: "Thank you.",
      authorKind: "clerk",
      by: GP,
    }).thread;
    const toReply = messaging.open({
      patientId: P,
      subject: "Renewal",
      body: "Please renew metformin.",
      authorKind: "patient",
      by: { actorId: P, actorKind: "patient" },
    }).thread;
    const toClose = messaging.open({
      patientId: P,
      subject: "Question already answered",
      body: "Clinic note for the file.",
      authorKind: "clerk",
      by: GP,
    }).thread;
    const toReopen = messaging.open({
      patientId: P,
      subject: "Closed then reopened",
      body: "Clinic note.",
      authorKind: "clerk",
      by: GP,
    }).thread;
    messaging.close(toReopen.id, { ...GP, reason: "finished for now; no further message" });
    const toAssign = messaging.open({
      patientId: "NT-msg",
      subject: "Unowned",
      body: "Do I need fasting bloods?",
      authorKind: "patient",
      by: { actorId: "NT-msg", actorKind: "patient" },
    }).thread;
    const patientAccess = s.engine.forTenant("default").patientAccess;
    const authorityToRevoke = patientAccess.grantProxy({
      patientId: P,
      subjectId: "proxy-old",
      relationship: "representative",
      expiresAt: "2027-08-24T00:00:00Z",
      permissions: ["appointments"],
      purpose: "book appointments",
      by: GP,
    });
    const requestToComplete = patientAccess.submitRequest({
      patientId: P,
      kind: "access",
      detail: "Please provide a copy of my chart.",
      by: { subjectId: P, relationship: "self" },
    });
    const requestToDecline = patientAccess.submitRequest({
      patientId: P,
      kind: "correction",
      target: "Medication list",
      detail: "Please correct the historical medication.",
      by: { subjectId: P, relationship: "self" },
    });
    // A laboratory result whose patient the interface could not identify, so
    // the route that resolves one has something real to act on.
    s.engine.forTenant("default").labIntake.ingest(
      [
        "MSH|^~\\&|LABAPP|STANTON|PORTAGE|GNWT|20260824104500||ORU^R01|MSG-HELD|P|2.5.1",
        "PID|1||NT-UNKNOWN^^^JHN^MR||Unknown^Person||19840317|F",
        "ORC|RE||ACC-HELD-1",
        "OBR|1||ACC-HELD-1|CHEM^Chemistry panel|||20260824103000",
        "OBX|1|NM|2823-3^Potassium^LN|1|4.2|mmol/L|3.5-5.1|N|||F|||20260824103000",
      ].join("\r")
    );
    const heldResult = s.engine.forTenant("default").labIntake.heldForIdentity()[0];

    // Prescriptions, one row per route so no route depends on what another did
    // to it first. The engine was booted with a pharmacy channel, so the
    // transmit path is the real one rather than the refusal.
    const rx = s.engine.forTenant("default").prescribing;
    s.engine.forTenant("default").directory.addOrganization({ id: "yk-pharmacy", name: "Yellowknife Pharmacy" });
    const statement = s.engine.forTenant("default").meds.record({
      patientId: P,
      code: "860975",
      display: "Metformin 500mg tablet",
      ingredient: "metformin",
      source: "prescribed",
      adherence: "taking",
      by: GP,
    });
    const writeRx = (): string => rx.write({ statementId: statement.id, instructions: "One twice daily", by: GP }).id;
    const rxToTransmit = writeRx();
    const rxToHandOut = writeRx();
    const rxToCancel = writeRx();
    const rxToAcknowledge = writeRx();
    rx.transmit(rxToAcknowledge, "yk-pharmacy", GP);
    const rxToFail = writeRx();
    rx.transmit(rxToFail, "yk-pharmacy", GP);
    const rxToReplace = writeRx();
    rx.transmit(rxToReplace, "yk-pharmacy", GP);
    rx.fail(rxToReplace, { ...GP, reason: "pharmacy rejected it" });
    const rxToConfirm = writeRx();
    rx.transmit(rxToConfirm, "yk-pharmacy", GP);
    rx.cancel(rxToConfirm, { ...GP, reason: "started on insulin instead" });

    // Migration runs, one per route that changes a run's state.
    const migration = s.engine.forTenant("default").migration;
    const migrationRun = migration.begin({ sourceSystem: "legacy-emr", mode: "trial", by: { actorId: "ops" } });
    const migrationToClose = migration.begin({ sourceSystem: "legacy-emr", mode: "trial", by: { actorId: "ops" } });
    const migrationToRollBack = migration.begin({
      sourceSystem: "legacy-emr",
      mode: "trial",
      by: { actorId: "ops" },
    });

    // Travelling-clinic fixtures, one per route so no route depends on what
    // another did to it first. Distinct services keep the waitlist's
    // one-live-entry-per-patient rule out of the way.
    const clinics = s.engine.forTenant("default").clinics;
    const clinicBy = { actorId: "clerk", actorKind: "staff" as const };
    const DAY = { from: "16:00", to: "18:00" };
    const tcRepeat = clinics.planVisit({
      resourceId: "dr-tetso", service: "TC repeat", community: "Fort Smith",
      days: [{ date: "2027-03-02", ...DAY }], slotMinutes: 30, by: clinicBy,
    });
    const tcCancel = clinics.planVisit({
      resourceId: "dr-tetso", service: "TC cancel", community: "Fort Smith",
      days: [{ date: "2027-03-09", ...DAY }], slotMinutes: 30, by: clinicBy,
    });
    const tcMove = clinics.planVisit({
      resourceId: "dr-tetso", service: "TC move", community: "Fort Smith",
      days: [{ date: "2027-03-16", ...DAY }], slotMinutes: 30, by: clinicBy,
    });
    const wlOffer = clinics.addToWaitlist({
      service: "TC offer", patientId: P, reason: "Knee review", by: clinicBy,
    });
    const tcOffer = clinics.planVisit({
      resourceId: "dr-tetso", service: "TC offer", community: "Fort Smith",
      days: [{ date: "2027-03-31", ...DAY }], slotMinutes: 30, by: clinicBy,
    });
    const wlRemove = clinics.addToWaitlist({
      service: "TC remove", patientId: P, reason: "Knee review", by: clinicBy,
    });
    const wlResolve = clinics.addToWaitlist({
      service: "TC resolve", patientId: P, reason: "Knee review", by: clinicBy,
    });
    // Its own visit, because a seat must be for the service the patient is
    // waiting for — the cross-service shortcut this fixture used to take is
    // now refused on purpose.
    const tcResolve = clinics.planVisit({
      resourceId: "dr-tetso", service: "TC resolve", community: "Fort Smith",
      days: [{ date: "2027-03-30", ...DAY }], slotMinutes: 30, by: clinicBy,
    });
    const offerOut = clinics.offerSeat({
      waitlistId: wlResolve.id, slotId: tcResolve.slots[0].id, by: clinicBy,
    });

    const standing = s.engine.forTenant("default").consent.breakGlass({
      patientId: P,
      by: { actorId: "dr-hale", actorKind: "practitioner" },
      reason: "unresponsive on arrival, no collateral history, need the allergy list",
    });

    // Arguments good enough for each route to do real work. A route that
    // needs one not listed here 400s, which this treats as a failure rather
    // than a pass — an untested route is the thing being guarded against.
    const args: Record<string, string> = {
      "/api/clinical/chart": `?patient=${P}`,
      "/api/clinical/worklist": "?clinician=dr-tetso",
      "/api/clinical/patients": "?family=Beaulieu",
      "/api/clinical/medications": `?patient=${P}`,
      "/api/clinical/allergies": `?patient=${P}`,
      "/api/clinical/results": "",
      "/api/clinical/orders": `?patient=${P}`,
      "/api/clinical/referrals": "",
      "/api/clinical/tasks": "?owner=dr-tetso",
      "/api/clinical/notes": `?patient=${P}`,
      "/api/clinical/appointments": `?patient=${P}`,
      "/api/clinical/missed": "",
      "/api/clinical/directives": `?patient=${P}`,
      "/api/clinical/safety-check": "POST",
      "/api/clinical/break-glass": "POST",
      "/api/clinical/acknowledge": "POST",
      "/api/clinical/break-glass-notified": "POST",
      "/api/clinical/break-glass-review": "POST",
      "/api/clinical/break-glass-dispatch": "POST",
      "/api/clinical/gaps": "POST",
      "/api/clinical/measure": "POST",
      "/api/clinical/visits": "?service=TC%20repeat",
      "/api/clinical/visit-plan": "POST",
      "/api/clinical/visit-repeat": "POST",
      "/api/clinical/visit-cancel": "POST",
      "/api/clinical/visit-reschedule": "POST",
      "/api/clinical/waitlist": "?service=TC%20offer",
      "/api/clinical/waitlist-add": "POST",
      "/api/clinical/waitlist-remove": "POST",
      "/api/clinical/offer": "POST",
      "/api/clinical/offer-resolve": "POST",
      "/api/clinical/encounters": `?patient=${P}`,
      "/api/clinical/encounter": `?id=${visit.id}`,
      "/api/clinical/encounters-open": "",
      "/api/clinical/encounter-open": "POST",
      "/api/clinical/encounter-arrive": "POST",
      "/api/clinical/encounter-close": "POST",
      "/api/clinical/encounter-cancel": "POST",
      "/api/clinical/book": "POST",
      "/api/clinical/immunizations": `?patient=${P}`,
      "/api/clinical/vitals": `?patient=${P}`,
      "/api/clinical/care-team": `?patient=${P}`,
      "/api/clinical/coverage": `?patient=${P}`,
      "/api/clinical/immunization-record": "POST",
      "/api/clinical/vital-record": "POST",
      "/api/clinical/care-team-assign": "POST",
      "/api/clinical/care-team-retire": "POST",
      "/api/clinical/coverage-record": "POST",
      "/api/clinical/threads": `?patient=${P}`,
      "/api/clinical/thread": `?id=${thread.id}`,
      "/api/clinical/messages-awaiting": "?clinician=dr-tetso",
      "/api/clinical/thread-open": "POST",
      "/api/clinical/thread-reply": "POST",
      "/api/clinical/thread-close": "POST",
      "/api/clinical/thread-reopen": "POST",
      "/api/clinical/thread-assign": "POST",
      "/api/clinical/authorities": `?patient=${P}`,
      "/api/clinical/authority-self": "POST",
      "/api/clinical/authority-proxy": "POST",
      "/api/clinical/authority-revoke": "POST",
      "/api/clinical/patient-requests": "",
      "/api/clinical/patient-request-complete": "POST",
      "/api/clinical/patient-request-decline": "POST",
      "/api/clinical/lab-held": "",
      "/api/clinical/lab-reconcile": "",
      "/api/clinical/lab-resolve": "POST",
      "/api/clinical/prescriptions": `?patient=${P}`,
      "/api/clinical/prescription-chase": "",
      "/api/clinical/prescribe": "POST",
      "/api/clinical/prescription-transmit": "POST",
      "/api/clinical/prescription-handout": "POST",
      "/api/clinical/prescription-acknowledge": "POST",
      "/api/clinical/prescription-fail": "POST",
      "/api/clinical/prescription-replace": "POST",
      "/api/clinical/prescription-cancel": "POST",
      "/api/clinical/prescription-cancel-confirm": "POST",
      "/api/clinical/migrations": "",
      "/api/clinical/migration-report": `?run=${migrationRun.id}`,
      "/api/clinical/migration-rejects": `?run=${migrationRun.id}`,
      "/api/clinical/migration-sample": `?run=${migrationRun.id}`,
      "/api/clinical/migration-begin": "POST",
      "/api/clinical/migration-declare": "POST",
      "/api/clinical/migration-load": "POST",
      "/api/clinical/migration-complete": "POST",
      "/api/clinical/migration-rollback": "POST",
    };

    /** The body each POST route needs to do real work. */
    const bodies: Record<string, unknown> = {
      "/api/clinical/safety-check": { patient: P, ingredient: "amoxicillin" },
      "/api/clinical/break-glass": {
        patient: P,
        reason: "unconscious, no collateral history, need allergy status before induction",
      },
      "/api/clinical/acknowledge": { result: pending.id, action: "phoned the ward; potassium repeated urgently" },
      "/api/clinical/break-glass-notified": { override: standing.id },
      "/api/clinical/break-glass-review": { override: standing.id, outcome: "appropriate; ED attendance confirmed" },
      // No dispatcher is configured in this harness, so this exercises the
      // "nothing to send with" path — which still has to audit, because a
      // notice that was not sent is exactly the event an operator needs on the
      // trail.
      "/api/clinical/break-glass-dispatch": { override: standing.id },
      "/api/clinical/gaps": {
        cohort: { id: "dm", name: "Diabetes", conditionCodes: ["diabetes"] },
        gap: { id: "hba1c", name: "HbA1c yearly", withinDays: 365, satisfiedByResultCodes: ["4548-4"] },
      },
      "/api/clinical/measure": {
        cohort: { id: "dm", name: "Diabetes", conditionCodes: ["diabetes"] },
        measure: { id: "hba1c-8", name: "HbA1c under 8", withinDays: 365, target: { code: "4548-4", below: 8 } },
      },
      "/api/clinical/visit-plan": {
        resourceId: "dr-tetso",
        service: "TC plan",
        community: "Fort Smith",
        days: [{ date: "2027-04-06", from: "16:00", to: "17:00" }],
        slotMinutes: 30,
      },
      "/api/clinical/visit-repeat": { visit: tcRepeat.visit.id, firstDay: "2027-04-13" },
      "/api/clinical/visit-cancel": { visit: tcCancel.visit.id, reason: "runway closed" },
      "/api/clinical/visit-reschedule": { visit: tcMove.visit.id, toFirstDay: "2027-03-23", reason: "plane delayed a week" },
      "/api/clinical/waitlist-add": { service: "TC add", patient: P, reason: "Knee review" },
      "/api/clinical/waitlist-remove": { entry: wlRemove.id, reason: "seen elsewhere" },
      "/api/clinical/offer": { entry: wlOffer.id, slot: tcOffer.slots[0].id },
      "/api/clinical/offer-resolve": { offer: offerOut.id, outcome: "declined" },
      "/api/clinical/encounter-open": { patient: P, class: "in-person", reason: "Sore throat" },
      // One row each, so no route depends on what another did to it first.
      "/api/clinical/encounter-arrive": { id: planned.id },
      "/api/clinical/encounter-close": { id: visit.id, disposition: "home with advice" },
      "/api/clinical/encounter-cancel": { id: toCancel.id, reason: "rebooked" },
      "/api/clinical/book": { slot: slot.id, patient: P, reason: "Follow-up" },
      "/api/clinical/immunization-record": {
        patient: P,
        vaccine: "Influenza",
        occurrenceAt: "2025-10-01T00:00:00Z",
      },
      "/api/clinical/vital-record": {
        patient: P,
        kind: "heart-rate",
        value: 72,
        unit: "/min",
        takenAt: "2026-08-24T10:00:00Z",
      },
      "/api/clinical/care-team-assign": { patient: P, practitioner: "dr-tetso", role: "covering" },
      "/api/clinical/care-team-retire": { id: membership.id },
      "/api/clinical/coverage-record": { patient: P, plan: "NIHB", eligibility: "eligible" },
      "/api/clinical/thread-open": {
        patient: P,
        subject: "Hours",
        body: "Are you open Saturday?",
        authorKind: "clerk",
      },
      "/api/clinical/thread-reply": {
        id: toReply.id,
        body: "Yes — we can renew for 90 days.",
        authorKind: "practitioner",
      },
      "/api/clinical/thread-close": {
        id: toClose.id,
        reason: "answered by phone; no further message needed",
      },
      "/api/clinical/thread-reopen": { id: toReopen.id, reason: "patient called back with a new question" },
      "/api/clinical/thread-assign": { id: toAssign.id, owner: "dr-tetso", reason: "picked up from the unowned queue" },
      "/api/clinical/authority-self": { patient: P, subject: "patient-oauth-subject" },
      "/api/clinical/authority-proxy": {
        patient: P,
        subject: "proxy-oauth-subject",
        relationship: "representative",
        expiresAt: "2027-08-24T00:00:00Z",
        permissions: ["appointments", "messages"],
        purpose: "book appointments and exchange messages",
      },
      "/api/clinical/authority-revoke": { authority: authorityToRevoke.id, reason: "patient withdrew access" },
      "/api/clinical/patient-request-complete": {
        request: requestToComplete.id,
        outcome: "encrypted chart export provided to the patient",
      },
      "/api/clinical/patient-request-decline": {
        request: requestToDecline.id,
        reason: "the historical entry is accurate; explanation sent to the patient",
      },
      "/api/clinical/lab-resolve": { hold: heldResult.id, patient: P },
      "/api/clinical/prescribe": { statement: statement.id, instructions: "One tablet twice daily with food" },
      "/api/clinical/prescription-transmit": { prescription: rxToTransmit, pharmacy: "yk-pharmacy" },
      "/api/clinical/prescription-handout": { prescription: rxToHandOut, reason: "printed for the patient" },
      "/api/clinical/prescription-acknowledge": { prescription: rxToAcknowledge, detail: "pharmacy reference 8812" },
      "/api/clinical/prescription-fail": { prescription: rxToFail, reason: "pharmacy rejected: unknown patient" },
      "/api/clinical/prescription-replace": { prescription: rxToReplace, reason: "sending to the usual pharmacy" },
      "/api/clinical/prescription-cancel": { prescription: rxToCancel, reason: "changed the plan" },
      "/api/clinical/prescription-cancel-confirm": {
        prescription: rxToConfirm,
        detail: "telephoned the pharmacist, who withdrew it",
      },
      "/api/clinical/migration-begin": { source: "legacy-emr", mode: "trial" },
      "/api/clinical/migration-declare": { run: migrationRun.id, recordType: "condition", sourceCount: 1 },
      "/api/clinical/migration-load": {
        run: migrationRun.id,
        records: [
          {
            sourceId: "CO-API-1",
            recordType: "condition",
            sourcePatientId: P,
            content: { code: { text: "Migrated problem" } },
          },
        ],
      },
      // Separate runs, so no route depends on the state another left behind.
      "/api/clinical/migration-complete": { run: migrationToClose.id, acceptGapsBecause: "trial run, counts not declared" },
      "/api/clinical/migration-rollback": { run: migrationToRollBack.id, reason: "trial finished" },
    };

    const unlisted = paths.filter((p) => !(p in args));
    assert.deepEqual(unlisted, [], "a clinical route with no case here is one nothing has driven");

    for (const p of paths) {
      const before = s.trail().length;
      const res =
        args[p] === "POST"
          ? await fetch(`${s.base}${p}`, {
              method: "POST",
              headers: { authorization: `Bearer ${s.admin}`, "content-type": "application/json" },
              body: JSON.stringify(bodies[p]),
            })
          : await s.get(`${p}${args[p]}`);

      assert.ok(res.ok, `${p} did not serve: ${res.status} ${await res.text()}`);
      assert.equal(s.trail().length, before + 1, `${p} served patient data without leaving an audit row`);
      const row = s.trail()[0];
      assert.equal(row.path, p);
      assert.ok(row.resource_type, `${p} recorded no resource type`);
    }
  } finally {
    await s.close();
  }
});

test("a patient directive stops the chart at the API, and the refusal is on the trail", () => {
  // A lockbox the chart API ignores is worse than no lockbox, because the
  // system now claims to honour patient directives. This is what makes the
  // claim true: the check is inside phi(), so it covers every route that
  // names a patient rather than the ones somebody remembered.
  return (async () => {
    const s = await boot();
    try {
      const t = s.engine.forTenant("default");
      t.consent.record({
        patientId: P,
        kind: "withhold-all",
        by: { actorId: "privacy-office", actorKind: "practitioner" },
        reason: "patient asked",
      });

      const before = s.trail().length;
      const res = await s.get(`/api/clinical/chart?patient=${P}`);
      assert.equal(res.status, 403);
      const body = (await res.json()) as { error: string; breakGlass: string };
      assert.match(body.error, /withheld by a patient directive/);
      assert.ok(!body.error.includes("patient asked"), "the caller learns that, not why");
      assert.match(body.breakGlass, /break-glass/, "and is told how to declare an emergency");

      const row = s.trail()[0];
      assert.equal(s.trail().length, before + 1, "a directive that stopped somebody is what a privacy office wants to see");
      assert.equal(row.patient, P);
      assert.notEqual(row.outcome, 0);
      assert.match(row.detail ?? "", /withheld by patient directive/);

      // Every patient-scoped route, not just the chart.
      for (const p of ["medications", "allergies", "orders", "notes", "appointments", "immunizations", "vitals", "care-team", "coverage", "threads"]) {
        assert.equal((await s.get(`/api/clinical/${p}?patient=${P}`)).status, 403, `${p} honoured the directive`);
      }
    } finally {
      await s.close();
    }
  })();
});

test("declaring an emergency opens the record, and everything about it is recorded", () => {
  return (async () => {
    const s = await boot();
    try {
      const t = s.engine.forTenant("default");
      t.consent.record({ patientId: P, kind: "withhold-all", by: { actorId: "privacy-office", actorKind: "practitioner" } });
      assert.equal((await s.get(`/api/clinical/chart?patient=${P}`)).status, 403);

      // A word is not a reason, over the wire as much as in the store.
      const thin = await fetch(`${s.base}/api/clinical/break-glass`, {
        method: "POST",
        headers: { authorization: `Bearer ${s.admin}`, "content-type": "application/json" },
        body: JSON.stringify({ patient: P, reason: "emergency" }),
      });
      assert.equal(thin.status, 400);
      assert.equal((await s.get(`/api/clinical/chart?patient=${P}`)).status, 403, "and it opened nothing");

      const declared = await fetch(`${s.base}/api/clinical/break-glass`, {
        method: "POST",
        headers: { authorization: `Bearer ${s.admin}`, "content-type": "application/json" },
        body: JSON.stringify({
          patient: P,
          reason: "unconscious, no collateral history, need allergy status before induction",
        }),
      });
      assert.equal(declared.status, 201);

      const opened = await s.get(`/api/clinical/chart?patient=${P}`);
      assert.equal(opened.status, 200, "the lockbox is survivable, which is the point of it being one");

      // Declared, reasoned, queued for notification, queued for review.
      const pending = t.consent.pendingReview();
      assert.equal(pending.length, 1);
      assert.match(pending[0].reason, /before induction/);
      assert.equal(pending[0].subject_id, s.adminId);
      assert.equal(t.consent.pendingNotification().length, 1, "and the patient has not been told yet");

      // The declaration is on the trail before anything was read under it.
      const trail = t.audit.list({ limit: 50 });
      const declaration = trail.find((r) => (r.detail ?? "").startsWith("break-glass declared"));
      assert.ok(declaration, "declaring is itself an event, not just a precondition");
      assert.equal(declaration.patient, P);
    } finally {
      await s.close();
    }
  })();
});

test("a patient can always see the directives standing on their own record", () => {
  // Deliberately outside the withholding check. Refusing to show somebody the
  // directive that stopped them leaves them unable to tell a lockbox from an
  // empty chart, which is the ambiguity the whole design refuses elsewhere.
  return (async () => {
    const s = await boot();
    try {
      const t = s.engine.forTenant("default");
      t.consent.record({
        patientId: P,
        kind: "withhold-from-provider",
        targetId: s.adminId,
        by: { actorId: "privacy-office", actorKind: "practitioner" },
      });

      assert.equal((await s.get(`/api/clinical/chart?patient=${P}`)).status, 403);
      const res = await s.get(`/api/clinical/directives?patient=${P}`);
      assert.equal(res.status, 200, "the directive itself is visible to the person it withholds from");
      const rows = (await res.json()) as Array<{ kind: string }>;
      assert.equal(rows.length, 1);
      assert.equal(rows[0].kind, "withhold-from-provider");
    } finally {
      await s.close();
    }
  })();
});

test("every patient-scoped clinical route consults the directive check", () => {
  // The structural half. phi() is where the check lives, so a route that
  // serves one patient's data without going through phi() has bypassed it —
  // and would work, and serve the record, and say nothing.
  const source = readFileSync(new URL("../src/api/admin.ts", import.meta.url), "utf8");
  const clinical = source.slice(source.indexOf('path.startsWith("/api/clinical/")'));
  const end = clinical.indexOf('return send(res, 404, { error: "not found" });');
  const block = clinical.slice(0, end);

  // Routes that require a patient, found by reading the guard each one uses.
  const patientScoped = [...block.matchAll(/path === "(\/api\/clinical\/[a-z-]+)"[\s\S]{0,200}?patient required/g)].map(
    (m) => m[1]
  );
  assert.ok(patientScoped.length >= 6, `expected patient-scoped routes to be found, got ${patientScoped.length}`);

  for (const route of patientScoped) {
    const i = block.indexOf(`path === "${route}"`);
    const next = block.indexOf('if (path === "', i + 10);
    const body = block.slice(i, next === -1 ? undefined : next);
    assert.ok(
      /\bphi\(/.test(body) || /consent\./.test(body),
      `${route} serves one patient's data without going through phi() or consulting consent directly`
    );
  }
});

test("a directive keeps a patient off a worklist, and the list says it is short", () => {
  // The hole the single-patient check leaves. Refusing a whole worklist
  // because one patient on it has a directive would take a clinician's day
  // away, so withheld rows are omitted — but not silently.
  //
  // A short list that looks complete is what this system refuses everywhere,
  // and here it is worse than usual: a result withheld from the clinician
  // responsible for reading it is a result now owed to nobody, which is the
  // exact silence the orders module exists to prevent. The count is reported
  // so somebody can act on it; who they are is not, which is what the
  // directive asked for.
  return (async () => {
    const s = await boot();
    try {
      const t = s.engine.forTenant("default");

      // A second patient with an unread result, so the list has two rows.
      const other = t.orders.create({
        patientId: "NT-other",
        category: "lab",
        code: "2823-3",
        display: "Potassium",
        indication: "Check",
        by: GP,
      });
      t.orders.place(other.id, { ...GP, responsibleId: "dr-tetso" });
      t.orders.report({
        patientId: "NT-other",
        orderId: other.id,
        code: "2823-3",
        display: "Potassium",
        value: "4.0",
        reportedBy: "analyser",
      });

      const before = (await (await s.get("/api/clinical/results")).json()) as { rows: unknown[]; withheldCount: number };
      assert.equal(before.rows.length, 2);
      assert.equal(before.withheldCount, 0);

      t.consent.record({
        patientId: P,
        kind: "withhold-all",
        by: { actorId: "privacy-office", actorKind: "practitioner" },
      });

      const after = (await (await s.get("/api/clinical/results")).json()) as {
        rows: Array<{ patient_id: string }>;
        withheldCount: number;
      };
      assert.equal(after.rows.length, 1, "the withheld patient is off the list");
      assert.equal(after.rows[0].patient_id, "NT-other");
      assert.equal(after.withheldCount, 1, "and the list does not pretend to be whole");
      assert.ok(!JSON.stringify(after).includes(P), "without naming who, which is what the directive asked for");

      // The same on every list that spans patients.
      for (const p of ["referrals", "missed"]) {
        const body = (await (await s.get(`/api/clinical/${p}`)).json()) as { withheldCount: number };
        assert.equal(typeof body.withheldCount, "number", `${p} does not report what it dropped`);
      }
      const tasks = (await (await s.get("/api/clinical/tasks?owner=dr-tetso")).json()) as {
        rows: unknown[];
        withheldCount: number;
      };
      assert.equal(tasks.withheldCount, 1);
      assert.equal(tasks.rows.length, 0);

      // And a search does not surface them either.
      const found = (await (await s.get("/api/clinical/patients?family=Beaulieu")).json()) as {
        rows: unknown[];
        withheldCount: number;
      };
      assert.equal(found.rows.length, 0);
      assert.equal(found.withheldCount, 1);
    } finally {
      await s.close();
    }
  })();
});

test("a directive narrowed to some entry types withholds that section, not the whole chart", () => {
  // Where this landed after two goes at it, and the two wrong answers are
  // worth keeping visible because each looked right at the time.
  //
  // Originally `mayRead()` honoured `scope` only when told which entry type
  // was being read, and `phi()` never tells it — a chart is not one type — so
  // every scoped directive evaluated to "does not apply" and the patient's
  // locked counselling note was served with a 200. The fix for that refused
  // any read that could not name its type, which was safe and far blunter
  // than the patient asked for: they locked one section and lost the chart.
  //
  // The honest answer is that "may they read the chart" has no yes-or-no. The
  // chart drops the locked section and says so; a route that serves exactly
  // the locked type refuses, because there is nothing left for it to serve.
  return (async () => {
    const s = await boot();
    try {
      const t = s.engine.forTenant("default");
      t.clinical.record({
        entryType: "DocumentReference",
        patientId: P,
        content: { resourceType: "DocumentReference", description: "COUNSELLING SUMMARY" },
        ...GP_AUTHOR,
      });
      t.consent.record({
        patientId: P,
        kind: "withhold-all",
        scope: ["DocumentReference"],
        by: { actorId: "privacy-office", actorKind: "practitioner" },
        reason: "counselling notes only",
      });

      const res = await s.get(`/api/clinical/chart?patient=${P}`);
      assert.equal(res.status, 200, "one locked section does not take the clinician's chart away");
      const chart = (await res.json()) as {
        complete: boolean;
        omissions: string[];
        recentNotes: { items: unknown[]; complete: boolean; incomplete?: { reason: string; detail?: string } };
        allergies: { complete: boolean };
      };

      assert.equal(chart.recentNotes.items.length, 0);
      assert.equal(chart.recentNotes.incomplete?.reason, "withheld", "not 'unavailable' — nothing failed");
      assert.match(chart.recentNotes.incomplete!.detail!, /break glass/, "and the way through is named");
      assert.equal(chart.complete, false, "a chart missing what the patient locked is not the whole chart");
      assert.ok(
        chart.omissions.some((o) => /Recent notes/.test(o)),
        `the omission is on the summary itself, got ${JSON.stringify(chart.omissions)}`
      );

      // And nothing of the withheld section leaks: not the content, and not
      // the count, which would tell a reader the patient has counselling notes
      // — most of what the lockbox was hiding.
      const body = JSON.stringify(chart);
      assert.ok(!body.includes("COUNSELLING SUMMARY"), "the withheld content is not in the response");

      // The sections the patient did not lock are untouched.
      assert.equal(chart.allergies.complete, true, "a lockbox on one section is not a lockbox on the rest");

      // A route that serves exactly the withheld type has nothing left to
      // serve, so it refuses — and names the way through.
      const notes = await s.get(`/api/clinical/notes?patient=${P}`);
      assert.equal(notes.status, 403);
      const refusal = (await notes.json()) as { error: string; breakGlass: string };
      assert.match(refusal.error, /withheld by a patient directive/);
      assert.equal(refusal.breakGlass, "POST /api/clinical/break-glass");

      // A route serving a type the patient did not lock is not affected.
      assert.equal((await s.get(`/api/clinical/allergies?patient=${P}`)).status, 200);
      assert.equal((await s.get(`/api/clinical/medications?patient=${P}`)).status, 200);
    } finally {
      await s.close();
    }
  })();
});

test("acknowledging a result is a clinical act, and a corrected one cannot be signed off", () => {
  // The write the clinician surface needs, and the two refusals that make it
  // worth having as a write rather than a flag.
  //
  // A queue that empties on a click teaches a ward that the queue is the work.
  // And the superseded case is the hazard §4 is built around: a potassium of
  // 7.1 corrected to 4.0, with the chart showing the 7.1 marked reviewed by a
  // clinician who never saw either.
  return (async () => {
    const s = await boot();
    try {
      const t = s.engine.forTenant("default");
      const order = t.orders.create({
        patientId: P,
        category: "lab",
        code: "2823-3",
        display: "Potassium",
        indication: "Recheck",
        by: GP,
      });
      t.orders.place(order.id, { ...GP, responsibleId: "dr-tetso" });
      const first = t.orders.report({
        patientId: P,
        orderId: order.id,
        code: "2823-3",
        display: "Potassium",
        value: "7.1",
        abnormalFlag: "critical-high",
        reportedBy: "analyser",
      });

      const post = (body: unknown) =>
        fetch(`${s.base}/api/clinical/acknowledge`, {
          method: "POST",
          headers: { authorization: `Bearer ${s.admin}`, "content-type": "application/json" },
          body: JSON.stringify(body),
        });

      // Saying nothing about what was done is refused by the store, and the
      // reason reaches the caller rather than becoming a bare 400.
      const empty = await post({ result: first.id, action: "   " });
      assert.equal(empty.status, 400);
      assert.match(((await empty.json()) as { error: string }).error, /say what was done about it/);

      const ok = await post({ result: first.id, action: "phoned the ward, potassium repeated urgently" });
      assert.equal(ok.status, 200);
      assert.ok(((await ok.json()) as { acknowledged_at: string }).acknowledged_at);

      // On the trail as a write, not a read.
      const row = s.trail()[0];
      assert.equal(row.action, "U");
      assert.equal(row.patient, P);
      assert.match(row.detail ?? "", /result acknowledged: phoned the ward/);

      // Acknowledging it twice is refused: the second clinician would be
      // recording an action nobody took against a result already signed off.
      const twice = await post({ result: first.id, action: "looked again" });
      assert.equal(twice.status, 400);
      assert.match(((await twice.json()) as { error: string }).error, /already been acknowledged/);

      // And the hazard §4 is built around. A second, unread result is
      // corrected before anybody signs it off; signing off the superseded one
      // would leave the chart showing a value marked reviewed by somebody who
      // never saw the number that replaced it.
      const unread = t.orders.report({
        patientId: P,
        orderId: order.id,
        code: "2823-3",
        display: "Potassium",
        value: "6.8",
        abnormalFlag: "critical-high",
        reportedBy: "analyser",
      });
      const corrected = t.orders.correct(unread.id, { value: "4.0", reportedBy: "analyser" });
      const stale = await post({ result: unread.id, action: "acting on the high one" });
      assert.equal(stale.status, 400);
      const why = ((await stale.json()) as { error: string }).error;
      assert.match(why, /was corrected/);
      assert.match(why, new RegExp(corrected.id), "and it names the one to read instead");
      assert.equal(t.orders.result(unread.id)!.acknowledged_at, null);
    } finally {
      await s.close();
    }
  })();
});

test("a result belonging to a withheld patient cannot be acknowledged either", () => {
  // Acknowledging a result is reading it: you cannot say what you did about a
  // value you were not allowed to see. A write route that skipped the
  // directive check would be the hole the structural test cannot see, because
  // it only drives routes and this one would answer 200.
  return (async () => {
    const s = await boot();
    try {
      const t = s.engine.forTenant("default");
      const order = t.orders.create({
        patientId: P,
        category: "lab",
        code: "2823-3",
        display: "Potassium",
        indication: "Recheck",
        by: GP,
      });
      t.orders.place(order.id, { ...GP, responsibleId: "dr-tetso" });
      const r = t.orders.report({
        patientId: P,
        orderId: order.id,
        code: "2823-3",
        display: "Potassium",
        value: "5.5",
        reportedBy: "analyser",
      });
      t.consent.record({
        patientId: P,
        kind: "withhold-all",
        by: { actorId: "privacy-office", actorKind: "practitioner" },
      });

      const res = await fetch(`${s.base}/api/clinical/acknowledge`, {
        method: "POST",
        headers: { authorization: `Bearer ${s.admin}`, "content-type": "application/json" },
        body: JSON.stringify({ result: r.id, action: "trying anyway" }),
      });
      assert.equal(res.status, 403);
      assert.equal(t.orders.result(r.id)!.acknowledged_at, null, "and nothing was written");
      assert.equal(s.trail()[0].outcome, 4, "the refusal is on the trail");
    } finally {
      await s.close();
    }
  })();
});

test("a partly withheld read says so on the audit trail", () => {
  // A directive that did something is exactly what a privacy office wants to
  // see, and a 200 that quietly dropped a section is otherwise indistinguishable
  // from a 200 that had nothing to drop.
  return (async () => {
    const s = await boot();
    try {
      s.engine.forTenant("default").consent.record({
        patientId: P,
        kind: "withhold-all",
        scope: ["DocumentReference"],
        by: { actorId: "privacy-office", actorKind: "practitioner" },
      });

      assert.equal((await s.get(`/api/clinical/chart?patient=${P}`)).status, 200);
      const row = s.trail()[0];
      assert.equal(row.outcome, 0, "the read succeeded");
      assert.match(row.detail ?? "", /withheld by patient directive: DocumentReference/);
      // The types, never the content — the narrowest thing that makes the row
      // useful to somebody reviewing it.
      assert.ok(!/COUNSELLING/i.test(row.detail ?? ""));
    } finally {
      await s.close();
    }
  })();
});

test("an unscoped directive still refuses the whole chart", () => {
  // The other half of the same decision. A directive that names no entry types
  // withholds the record, and there is no honest partial answer to give.
  return (async () => {
    const s = await boot();
    try {
      s.engine.forTenant("default").consent.record({
        patientId: P,
        kind: "withhold-all",
        by: { actorId: "privacy-office", actorKind: "practitioner" },
      });
      const res = await s.get(`/api/clinical/chart?patient=${P}`);
      assert.equal(res.status, 403);
      assert.match(((await res.json()) as { error: string }).error, /withheld by a patient directive/);
    } finally {
      await s.close();
    }
  })();
});

test("a directive withholding from an organization is not defeated by a caller that names none", () => {
  // `withhold-from-organization` matched on an organizationId that no
  // Principal carries and nothing passed, so `undefined === "yk-clinic"` was
  // false on every request and the directive was enforced by nothing at all —
  // while GET /api/clinical/directives went on reporting it as active to the
  // patient. Recorded, reported, unenforced: the exact shape this system
  // refuses everywhere else.
  //
  // Until organization identity reaches the auth layer, a caller that cannot
  // say it is outside the withheld organization is treated as possibly inside
  // it.
  return (async () => {
    const s = await boot();
    try {
      s.engine.forTenant("default").consent.record({
        patientId: P,
        kind: "withhold-from-organization",
        targetId: "yk-clinic",
        by: { actorId: "privacy-office", actorKind: "practitioner" },
      });

      const res = await s.get(`/api/clinical/chart?patient=${P}`);
      assert.equal(res.status, 403);

      // And the refusal is on the trail like any other access.
      const row = s.trail()[0];
      assert.equal(row.outcome, 4);
      assert.match(row.detail ?? "", /withheld by patient directive/);
    } finally {
      await s.close();
    }
  })();
});

test("what breaking glass owes is visible, and can be discharged, over HTTP", () => {
  // The queues existed and nothing could read them. `pendingNotification()`
  // and `pendingReview()` returned the right rows to a caller that had a
  // ConsentDirectives instance in hand, which over HTTP is nobody. A queue no
  // operator can see is a statistic, and the argument for the lockbox being
  // survivable rests entirely on it not being one.
  return (async () => {
    const s = await boot();
    try {
      const t = s.engine.forTenant("default");
      t.consent.record({
        patientId: P,
        kind: "withhold-all",
        by: { actorId: "privacy-office", actorKind: "practitioner" },
      });

      const declared = await fetch(`${s.base}/api/clinical/break-glass`, {
        method: "POST",
        headers: { authorization: `Bearer ${s.admin}`, "content-type": "application/json" },
        body: JSON.stringify({ patient: P, reason: "unresponsive in ED, need the allergy list before induction" }),
      });
      assert.equal(declared.status, 201);
      const override = (await declared.json()) as { id: string };

      const queues = (await (await s.get("/api/clinical/break-glass")).json()) as {
        awaitingNotification: Array<{ id: string }>;
        awaitingReview: Array<{ id: string }>;
      };
      assert.deepEqual(queues.awaitingNotification.map((r) => r.id), [override.id], "the patient has not been told");
      assert.deepEqual(queues.awaitingReview.map((r) => r.id), [override.id], "and nobody has looked at it");

      const post = (path: string, body: unknown) =>
        fetch(`${s.base}${path}`, {
          method: "POST",
          headers: { authorization: `Bearer ${s.admin}`, "content-type": "application/json" },
          body: JSON.stringify(body),
        });

      assert.equal((await post("/api/clinical/break-glass-review", { override: override.id })).status, 400);
      assert.equal((await post("/api/clinical/break-glass-notified", { override: override.id })).status, 200);
      assert.equal(
        (await post("/api/clinical/break-glass-review", { override: override.id, outcome: "appropriate" })).status,
        200
      );

      const after = (await (await s.get("/api/clinical/break-glass")).json()) as {
        awaitingNotification: unknown[];
        awaitingReview: unknown[];
      };
      assert.equal(after.awaitingNotification.length, 0);
      assert.equal(after.awaitingReview.length, 0);

      // And the patient's own view of who opened their record.
      const theirs = (await (await s.get(`/api/clinical/break-glass?patient=${P}`)).json()) as {
        overrides: Array<{ reason: string }>;
      };
      assert.equal(theirs.overrides.length, 1);
      assert.match(theirs.overrides[0].reason, /before induction/);
    } finally {
      await s.close();
    }
  })();
});

test("a task about nobody in particular is not withheld by anyone's directive", () => {
  // A directive is about a patient. An administrative task with no patient on
  // it is not about anybody, and dropping it would be the filter overreaching.
  return (async () => {
    const s = await boot();
    try {
      const t = s.engine.forTenant("default");
      t.tasks.create({ kind: "administrative", title: "Reconcile the fax log", by: GP, ownerId: "dr-tetso" });
      t.consent.record({
        patientId: P,
        kind: "withhold-all",
        by: { actorId: "privacy-office", actorKind: "practitioner" },
      });

      const body = (await (await s.get("/api/clinical/tasks?owner=dr-tetso")).json()) as {
        rows: Array<{ title: string }>;
        withheldCount: number;
      };
      assert.equal(body.rows.length, 1);
      assert.equal(body.rows[0].title, "Reconcile the fax log");
      assert.equal(body.withheldCount, 1, "the patient-bearing one was withheld, this one was not");
    } finally {
      await s.close();
    }
  })();
});
