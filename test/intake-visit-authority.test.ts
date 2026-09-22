/**
 * Who may say which visit an intake form is for, and what happens when two
 * of them say it at once.
 *
 * `appointment_id` is not decoration. `IntakeSubmissions.submittedForAppointments()`
 * reads that column alone to answer the clinic board's question -- which of
 * today's patients sent something in to read -- so whoever can write it can
 * decide, for anybody, whether they appear on the "coming in unprepared"
 * panel. The portal only ever *offers* a patient their own upcoming visits,
 * and a screen that offers the right choices is not an authorisation
 * boundary: these go through the real HTTP surface with a real token and
 * name ids the screen would never have shown.
 *
 * Same harness as intake-api.test.ts. What is new is a schedule, because a
 * visit now has to exist before a form can claim to prepare for it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Engine } from "../src/core/engine.ts";
import { startApi } from "../src/api/admin.ts";
import { AuthGate } from "../src/auth/gate.ts";
import { JwtVerifier } from "../src/auth/jwt.ts";
import { DevIdentityProvider } from "../src/auth/dev-idp.ts";

const AUDIENCE = "northstar-test";
const PATIENT = "NT123456";
const OTHER = "NT999999";
const CLERK = { actorId: "clerk", actorKind: "practitioner" };
const RESOURCE = "dr-okpik";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const addr = probe.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      probe.close(() => (port ? resolve(port) : reject(new Error("no port"))));
    });
  });
}

async function boot() {
  const engine = new Engine({ dbPath: ":memory:", tickMs: 15, orderDispatchIntervalMs: 0 });
  await engine.start();
  const t = engine.forTenant("default");
  for (const id of [PATIENT, OTHER]) {
    t.clinical.record({
      entryType: "Patient", patientId: id,
      content: { resourceType: "Patient", identifier: [{ value: id }] },
      authorId: "adt", authorKind: "device",
    });
  }
  t.questionnaires.publish({
    id: "pre-visit", title: "Pre-visit check-in",
    questions: [{ key: "fasting", label: "Have you fasted?", type: "boolean", required: true }],
    by: CLERK,
  });
  const port = await freePort();
  const issuer = `http://127.0.0.1:${port}/dev-idp`;
  const idp = new DevIdentityProvider({
    issuer, audience: AUDIENCE,
    liveSubjects: () => engine.forTenant("default").patientAccess.liveSubjects().map((s) => ({ ...s, tenantId: "default" })),
  });
  const api = await startApi(engine, port, "127.0.0.1", {
    auth: new AuthGate({
      keys: engine.keys,
      jwt: new JwtVerifier({ issuer, audience: AUDIENCE, jwksUri: `${issuer}/.well-known/jwks.json` }),
      tenants: engine.db,
    }),
    devIdp: idp,
  });
  const base = `http://127.0.0.1:${api.port}`;
  /** A real appointment, in whichever tenant is asked for. */
  const book = (patientId: string, hour: number, tenantId = "default") => {
    const scope = engine.forTenant(tenantId);
    const slot = scope.schedule.openSlot({
      resourceId: RESOURCE, resourceKind: "practitioner", service: "Family practice",
      startsAt: `2026-03-04T${String(hour).padStart(2, "0")}:00:00.000Z`,
      endsAt: `2026-03-04T${String(hour).padStart(2, "0")}:30:00.000Z`,
    });
    return scope.schedule.book({ slotId: slot.id, patientId, reason: "Follow-up", by: CLERK }).id;
  };
  return {
    engine, t, base, book,
    asOf: new Date("2026-03-04T08:30:00.000Z"),
    async signIn(subject: string): Promise<string> {
      const res = await fetch(`${base}/dev-idp/token`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ subject }),
      });
      const body = (await res.json()) as { access_token?: string; error?: string };
      if (!res.ok) throw new Error(body.error ?? `sign-in failed: ${res.status}`);
      return body.access_token!;
    },
    get: (token: string, path: string) => fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } }),
    post: (token: string, path: string, body: unknown) =>
      fetch(`${base}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    close: async () => { await api.close(); await engine.stop(); },
  };
}

// ------------------------------------------------- whose visit is it anyway

test("a form cannot claim another patient's appointment, and that patient stays unprepared", async () => {
  const s = await boot();
  try {
    s.t.patientAccess.grantSelf(PATIENT, "urn:dev:marie", CLERK);
    const token = await s.signIn("urn:dev:marie");
    const theirs = s.book(OTHER, 9);
    s.book(PATIENT, 10);

    const res = await s.post(token, "/patient/intake/draft", {
      patient: PATIENT, questionnaireId: "pre-visit", appointmentId: theirs, answers: { fasting: true },
    });
    assert.equal(res.status, 404, "an appointment that is not this patient's is not an appointment they can name");
    assert.equal(s.t.intake.forPatient(PATIENT).length, 0, "and nothing was written on the way to refusing");

    // The whole reason this matters: the other patient must still be on the
    // list of people arriving with nothing sent in. A clinician who believes
    // a history was submitted stops looking for one.
    const panel = s.t.board.expectedWithoutIntake([RESOURCE], s.asOf)!;
    assert.ok(panel.rows.some((r) => r.bookingId === theirs),
      "somebody else's form must never mark this patient's visit prepared");
  } finally { await s.close(); }
});

test("an appointment id from another tenant is not an appointment", async () => {
  const s = await boot();
  try {
    const other = s.engine.forTenant("other-clinic");
    other.clinical.record({ entryType: "Patient", patientId: PATIENT,
      content: { resourceType: "Patient" }, authorId: "adt", authorKind: "device" });
    const foreign = s.book(PATIENT, 9, "other-clinic");

    s.t.patientAccess.grantSelf(PATIENT, "urn:dev:marie", CLERK);
    const token = await s.signIn("urn:dev:marie");
    // Same patient identifier at both custodians, which is the case that
    // makes this worth asserting rather than assuming.
    const res = await s.post(token, "/patient/intake/draft", {
      patient: PATIENT, questionnaireId: "pre-visit", appointmentId: foreign, answers: { fasting: true },
    });
    assert.equal(res.status, 404);
    assert.equal(other.board.expectedWithoutIntake([RESOURCE], s.asOf)!.rows.length, 1,
      "the other custodian's board is untouched");
  } finally { await s.close(); }
});

test("an appointment nobody ever booked is refused in the same words as somebody else's", async () => {
  const s = await boot();
  try {
    s.t.patientAccess.grantSelf(PATIENT, "urn:dev:marie", CLERK);
    const token = await s.signIn("urn:dev:marie");
    const theirs = s.book(OTHER, 9);

    const invented = await s.post(token, "/patient/intake/draft",
      { patient: PATIENT, questionnaireId: "pre-visit", appointmentId: "00000000-0000-4000-8000-000000000000" });
    const somebodyElses = await s.post(token, "/patient/intake/draft",
      { patient: PATIENT, questionnaireId: "pre-visit", appointmentId: theirs });

    assert.equal(invented.status, somebodyElses.status);
    // Same shape of message, so an authenticated patient cannot use this
    // boundary to ask which identifiers exist. The id differs; the sentence
    // around it does not.
    const shape = (text: string) => text.replace(/[0-9a-f-]{36}/gi, "<id>");
    assert.equal(shape(await invented.text()), shape(await somebodyElses.text()));
  } finally { await s.close(); }
});

test("a cancelled appointment cannot be prepared for, and a stale tab is told why", async () => {
  const s = await boot();
  try {
    s.t.patientAccess.grantSelf(PATIENT, "urn:dev:marie", CLERK);
    const token = await s.signIn("urn:dev:marie");
    const visit = s.book(PATIENT, 9);
    s.t.schedule.cancel(visit, { ...CLERK, reason: "clinic cancelled the list" });

    const res = await s.post(token, "/patient/intake/draft",
      { patient: PATIENT, questionnaireId: "pre-visit", appointmentId: visit, answers: { fasting: true } });
    assert.equal(res.status, 409);
    assert.match(((await res.json()) as { error: string }).error, /cancelled/,
      "a patient whose visit was cancelled underneath them is told that, not 'bad request'");
  } finally { await s.close(); }
});

test("an appointment that has already started can still be prepared for", async () => {
  // Deliberately not refused. Somebody filling the form in the waiting room
  // at 09:05 for a 09:00 appointment is the ordinary case, and a clock this
  // close to the boundary is the wrong thing to refuse a medication list
  // over. The portal offers only future visits; that is a presentation
  // choice and the server does not promote it to a rule.
  const s = await boot();
  try {
    s.t.patientAccess.grantSelf(PATIENT, "urn:dev:marie", CLERK);
    const token = await s.signIn("urn:dev:marie");
    const visit = s.book(PATIENT, 9); // 2026-03-04, long past
    const res = await s.post(token, "/patient/intake/draft",
      { patient: PATIENT, questionnaireId: "pre-visit", appointmentId: visit, answers: { fasting: true } });
    assert.equal(res.status, 201);
  } finally { await s.close(); }
});

// ---------------------------------------------------------- caregiver scope

test("a caregiver with intake but not appointments can still only name this patient's visits", async () => {
  const s = await boot();
  try {
    s.t.patientAccess.grantSelf(PATIENT, "urn:dev:marie", CLERK);
    s.t.patientAccess.grantProxy({
      patientId: PATIENT, subjectId: "urn:dev:helper", relationship: "representative",
      permissions: ["intake"], purpose: "helps with forms",
      expiresAt: new Date(Date.now() + 86400_000).toISOString(), by: CLERK,
    });
    const helper = await s.signIn("urn:dev:helper");
    const mine = s.book(PATIENT, 9);
    const theirs = s.book(OTHER, 10);

    // Intake authority is not appointment authority: the helper cannot list
    // the visits, which is why the portal shows them no selector.
    assert.equal((await s.get(helper, `/patient/appointments?patient=${PATIENT}`)).status, 403,
      "the intake permission must not quietly widen into the appointments one");

    // They can still attach to a visit of the patient they help, because the
    // server checks the booking rather than the screen that offered it.
    assert.equal((await s.post(helper, "/patient/intake/draft",
      { patient: PATIENT, questionnaireId: "pre-visit", appointmentId: mine, answers: { fasting: true } })).status, 201);
    // And not to anybody else's, whatever they were granted.
    assert.equal((await s.post(helper, "/patient/intake/draft",
      { patient: PATIENT, questionnaireId: "pre-visit", appointmentId: theirs })).status, 404);
  } finally { await s.close(); }
});

test("revoking a caregiver's grant stops the next mutation, including one mid-form", async () => {
  const s = await boot();
  try {
    s.t.patientAccess.grantSelf(PATIENT, "urn:dev:marie", CLERK);
    const grant = s.t.patientAccess.grantProxy({
      patientId: PATIENT, subjectId: "urn:dev:helper", relationship: "representative",
      permissions: ["intake", "appointments"], purpose: "helps with forms",
      expiresAt: new Date(Date.now() + 86400_000).toISOString(), by: CLERK,
    });
    const helper = await s.signIn("urn:dev:helper");
    const visit = s.book(PATIENT, 9);
    const draft = (await (await s.post(helper, "/patient/intake/draft",
      { patient: PATIENT, questionnaireId: "pre-visit", appointmentId: visit, answers: { fasting: true } })).json()) as { id: string };

    s.t.patientAccess.revoke(grant.id, { ...CLERK, reason: "family asked for it to end" });

    // Every mutation, not only the first one. A half-finished form is
    // exactly when a grant gets withdrawn.
    assert.equal((await s.post(helper, "/patient/intake/draft",
      { patient: PATIENT, questionnaireId: "pre-visit", appointmentId: visit, answers: { fasting: false } })).status, 403);
    assert.equal((await s.post(helper, "/patient/intake/submit", { id: draft.id })).status, 403);
    assert.equal(s.t.intake.get(draft.id).status, "draft", "nothing was submitted by a revoked caregiver");
  } finally { await s.close(); }
});

// --------------------------------------------------------------- one visit,
// ------------------------------------------------------------ one submission

test("two tabs for one visit produce one chart document and one review task", async () => {
  const s = await boot();
  try {
    s.t.patientAccess.grantSelf(PATIENT, "urn:dev:marie", CLERK);
    const token = await s.signIn("urn:dev:marie");
    const visit = s.book(PATIENT, 9);

    const first = (await (await s.post(token, "/patient/intake/draft",
      { patient: PATIENT, questionnaireId: "pre-visit", appointmentId: visit, answers: { fasting: true } })).json()) as { id: string };
    assert.equal((await s.post(token, "/patient/intake/submit", { id: first.id })).status, 200);

    // The second tab rendered before the first submitted, so it carries no
    // draft id and asks for a new one -- with the answers it had when it
    // was painted, which are now the older ones.
    const stale = await s.post(token, "/patient/intake/draft",
      { patient: PATIENT, questionnaireId: "pre-visit", appointmentId: visit, answers: { fasting: false } });
    assert.equal(stale.status, 409);
    assert.match(((await stale.json()) as { error: string }).error, /already sent in/);

    assert.equal(s.t.clinical.chart(PATIENT, { entryType: "QuestionnaireResponse" }).length, 1);
    assert.equal(s.t.tasks.openOfKind("portal-submission" as never, { limit: 50 }).length, 1);
    const rows = s.t.intake.forPatient(PATIENT);
    assert.equal(rows.length, 1);
    assert.equal(JSON.parse(rows[0].answers).fasting, true, "the stale tab must not overwrite what was sent");
  } finally { await s.close(); }
});

test("a double-click on submit is one submission, and so is a retry after a lost reply", async () => {
  const s = await boot();
  try {
    s.t.patientAccess.grantSelf(PATIENT, "urn:dev:marie", CLERK);
    const token = await s.signIn("urn:dev:marie");
    const visit = s.book(PATIENT, 9);
    const draft = (await (await s.post(token, "/patient/intake/draft",
      { patient: PATIENT, questionnaireId: "pre-visit", appointmentId: visit, answers: { fasting: true } })).json()) as { id: string };

    // Both in flight at once, which is what a double-click actually is --
    // not one call after another.
    const [a, b] = await Promise.all([
      s.post(token, "/patient/intake/submit", { id: draft.id }),
      s.post(token, "/patient/intake/submit", { id: draft.id }),
    ]);
    assert.deepEqual([a.status, b.status], [200, 200]);
    assert.deepEqual(await a.json(), await b.json(), "both callers are told the same outcome");
    // And once more, long after, the way a client retries when the reply
    // never arrived.
    assert.equal((await s.post(token, "/patient/intake/submit", { id: draft.id })).status, 200);

    assert.equal(s.t.clinical.chart(PATIENT, { entryType: "QuestionnaireResponse" }).length, 1);
    assert.equal(s.t.tasks.openOfKind("portal-submission" as never, { limit: 50 }).length, 1);
  } finally { await s.close(); }
});

test("concurrent saves of one draft keep one row and lose no answers", async () => {
  const s = await boot();
  try {
    s.t.patientAccess.grantSelf(PATIENT, "urn:dev:marie", CLERK);
    const token = await s.signIn("urn:dev:marie");
    const visit = s.book(PATIENT, 9);
    const body = (answers: Record<string, unknown>) =>
      ({ patient: PATIENT, questionnaireId: "pre-visit", appointmentId: visit, answers });

    await Promise.all([
      s.post(token, "/patient/intake/draft", body({ fasting: true })),
      s.post(token, "/patient/intake/draft", body({ fasting: true })),
      s.post(token, "/patient/intake/draft", body({ fasting: true })),
    ]);
    const rows = s.t.intake.forPatient(PATIENT);
    assert.equal(rows.length, 1, "an autosave that fires three times is one draft");
  } finally { await s.close(); }
});

test("submitted and reviewed stay distinct, and a review cannot happen twice", async () => {
  const s = await boot();
  try {
    s.t.patientAccess.grantSelf(PATIENT, "urn:dev:marie", CLERK);
    const token = await s.signIn("urn:dev:marie");
    const visit = s.book(PATIENT, 9);
    const draft = (await (await s.post(token, "/patient/intake/draft",
      { patient: PATIENT, questionnaireId: "pre-visit", appointmentId: visit, answers: { fasting: true } })).json()) as { id: string };
    await s.post(token, "/patient/intake/submit", { id: draft.id });

    assert.equal(s.t.intake.get(draft.id).status, "submitted");
    assert.equal(s.t.board.attention().intakeAwaitingReview!.rows.length, 1);
    // Prepared is about the visit, and stays true once a clinician has read
    // it -- the question is "did anything arrive", not "is it still unread".
    assert.equal(s.t.intake.submittedForAppointments([visit]).size, 1);

    s.t.intake.review(draft.id, { outcome: "noted", note: "read before clinic", by: CLERK });
    assert.equal(s.t.intake.get(draft.id).status, "reviewed");
    assert.equal(s.t.board.attention().intakeAwaitingReview!.rows.length, 0, "a read submission leaves the queue");
    assert.equal(s.t.intake.submittedForAppointments([visit]).size, 1, "and the visit is still prepared");
    assert.throws(() => s.t.intake.review(draft.id, { outcome: "accepted", note: "again", by: CLERK }),
      /is reviewed, not awaiting review/);
  } finally { await s.close(); }
});

test("a refused save stores nothing at all, so the next attempt starts clean", async () => {
  const s = await boot();
  try {
    s.t.patientAccess.grantSelf(PATIENT, "urn:dev:marie", CLERK);
    const token = await s.signIn("urn:dev:marie");
    const theirs = s.book(OTHER, 9);
    const mine = s.book(PATIENT, 10);

    assert.equal((await s.post(token, "/patient/intake/draft",
      { patient: PATIENT, questionnaireId: "pre-visit", appointmentId: theirs, answers: { fasting: true } })).status, 404);
    assert.equal(s.t.intake.forPatient(PATIENT).length, 0, "a refusal is not a half-written row");

    const ok = await s.post(token, "/patient/intake/draft",
      { patient: PATIENT, questionnaireId: "pre-visit", appointmentId: mine, answers: { fasting: true } });
    assert.equal(ok.status, 201);
    assert.equal(s.t.intake.forPatient(PATIENT).length, 1);
  } finally { await s.close(); }
});

test("the questionnaire a patient is offered arrives as questions, not as a string of them", async () => {
  // #107's lesson, on the next route along: every test here asserted a
  // status code, and 200 is what a broken payload returns too. The screen
  // does `for (const q of form.questions)`, and for...of over a JSON string
  // iterates characters -- a two-question form rendered as a hundred and
  // sixty nameless text boxes and could not be submitted at all.
  const s = await boot();
  try {
    s.t.patientAccess.grantSelf(PATIENT, "urn:dev:marie", CLERK);
    const token = await s.signIn("urn:dev:marie");
    const body = (await (await s.get(token, "/patient/questionnaires")).json()) as {
      questionnaires: Array<Record<string, unknown>>;
    };
    const form = body.questionnaires[0]!;
    assert.ok(Array.isArray(form.questions), "questions is a list the screen can iterate");
    assert.deepEqual((form.questions as Array<{ key: string }>).map((q) => q.key), ["fasting"]);
    // Narrowed on the way out, for the reason /patient/appointments was:
    // a patient is offered a form, not the clinic's row behind it.
    for (const key of ["tenant_id", "published_by", "published_at", "status"]) {
      assert.equal(key in form, false, `${key} is clinic bookkeeping and has no business on this payload`);
    }
  } finally { await s.close(); }
});

test("a visit that moves takes the form somebody sent for it", async () => {
  // The booking keeps its identity when a travelling clinic is rescheduled --
  // `rescheduleVisit()` shifts the slot times and leaves the booking row
  // alone -- so an intake attached to it follows the visit rather than being
  // orphaned on a date nobody is attending. Asserted rather than assumed,
  // because it is the difference between a patient who prepared showing as
  // prepared and one who prepared showing as unprepared on the new day.
  const s = await boot();
  try {
    s.t.patientAccess.grantSelf(PATIENT, "urn:dev:marie", CLERK);
    const token = await s.signIn("urn:dev:marie");
    const { slots } = s.t.clinics.planVisit({
      resourceId: RESOURCE, service: "Family practice", community: "Fort Smith",
      days: [{ date: "2026-03-04", from: "09:00", to: "10:00" }], slotMinutes: 30, by: CLERK,
    });
    const booking = s.t.schedule.book({ slotId: slots[0]!.id, patientId: PATIENT, reason: "Follow-up", by: CLERK });

    const draft = (await (await s.post(token, "/patient/intake/draft",
      { patient: PATIENT, questionnaireId: "pre-visit", appointmentId: booking.id, answers: { fasting: true } })).json()) as { id: string };
    await s.post(token, "/patient/intake/submit", { id: draft.id });

    const visitId = s.t.schedule.slot(slots[0]!.id)!.visit_id!;
    s.t.clinics.rescheduleVisit(visitId, { toFirstDay: "2026-03-11", by: CLERK, reason: "plane delayed a week" });

    assert.equal(s.t.schedule.booking(booking.id)?.status, "booked", "the booking survives the move");
    assert.equal(s.t.intake.submittedForAppointments([booking.id]).size, 1,
      "and the preparation moves with it");
    assert.deepEqual(
      s.t.board.expectedWithoutIntake([RESOURCE], new Date("2026-03-11T08:30:00.000Z"))!.rows,
      [],
      "on the new day this patient is not somebody who sent nothing in"
    );
  } finally { await s.close(); }
});
