/**
 * An id named at the patient boundary gets one answer, whether the record
 * exists or not.
 *
 * Five portal routes take the id of a record rather than of a patient: a
 * message thread (to read or to reply to), a visit's after-visit summary, an
 * intake form being sent in, and an uploaded file. They read whose chart the
 * record is on off the record itself. They used to answer 404 when it was
 * missing and 403 when it was somebody else's, and to decide that before
 * anybody's authority was checked — so any patient signed in to the portal
 * could find out whether an id existed by asking for it. Nothing in the
 * record was disclosed and the ids are random, so it was a small leak, but it
 * was across the one line this API exists to hold, and an id copied from a
 * shared screen, a forwarded link or a screenshot is exactly what somebody
 * would ask about.
 *
 * What is held here: a stranger asking for a real record and anyone asking
 * for a missing one get the same status and the same bytes; the owner still
 * gets theirs; the stranger changes nothing; and the trail, which the caller
 * cannot read, still says which case it was.
 *
 * The same rule one level down, where a patient acting on their own chart
 * names something inside it — the form an upload goes with, the delegate to
 * revoke: "there is no such thing" and "that is somebody else's" are one
 * answer. Same harness as intake-visit-authority.test.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { Engine } from "../src/core/engine.ts";
import { startApi } from "../src/api/admin.ts";
import { AuthGate } from "../src/auth/gate.ts";
import { JwtVerifier } from "../src/auth/jwt.ts";
import { DevIdentityProvider } from "../src/auth/dev-idp.ts";
import { SyntheticScanner, Uploads } from "../src/patient/intake.ts";

const AUDIENCE = "northstar-test";
const PATIENT = "NT123456";
const OTHER = "NT999999";
const CLERK = { actorId: "clerk", actorKind: "practitioner" };
const GP = { actorId: "dr-tetso", actorKind: "practitioner" };
const NOT_AUTHORIZED = JSON.stringify({ error: "not authorized for this patient resource" });
const tomorrow = () => new Date(Date.now() + 86_400_000).toISOString();

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
  const engine = new Engine({ dbPath: ":memory:", tickMs: 15, orderDispatchIntervalMs: 0, malwareScanner: new SyntheticScanner() });
  await engine.start();
  const t = engine.forTenant("default");
  for (const id of [PATIENT, OTHER]) {
    t.clinical.record({
      entryType: "Patient", patientId: id,
      content: { resourceType: "Patient", identifier: [{ value: id }] },
      authorId: "adt", authorKind: "device",
    });
  }
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
  return {
    engine, t, base,
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

type Harness = Awaited<ReturnType<typeof boot>>;

/** Everything a caller can see of an answer: the status, the type, and the exact bytes. */
async function answer(res: Response): Promise<{ status: number; type: string | null; body: string }> {
  return { status: res.status, type: res.headers.get("content-type"), body: await res.text() };
}

/**
 * One of each record a portal route names by id, all on PATIENT's chart and
 * all made the way the portal makes them where the portal can.
 */
async function records(s: Harness, owner: string) {
  const opened = (await (await s.post(owner, "/patient/thread-open", {
    patient: PATIENT, subject: "Refill", body: "Could I have a refill of my inhaler?",
  })).json()) as { thread: { id: string } };
  const encounter = s.t.encounters.open({
    patientId: PATIENT, class: "in-person", reason: "Asthma review", by: GP, arrived: true,
  });
  const draft = (await (await s.post(owner, "/patient/intake/draft", {
    patient: PATIENT, concern: "Wheezing at night since the cold snap",
  })).json()) as { id: string };
  const upload = (await (await s.post(owner, "/patient/upload", {
    patient: PATIENT, filename: "inhaler-label.txt", contentType: "text/plain",
    data: Buffer.from("Salbutamol 100 mcg").toString("base64"),
  })).json()) as { id: string };
  await s.t.uploads.scanOne(upload.id, CLERK);
  return { thread: opened.thread.id, encounter: encounter.id, draft: draft.id, upload: upload.id };
}

// ------------------------------------------------ record-level routes

const ROUTES: Array<{
  name: string;
  of: "thread" | "encounter" | "draft" | "upload";
  ask: (s: Harness, token: string, id: string) => Promise<Response>;
  /** What the owner gets for their own record, so the gate is known to let somebody through. */
  owner: number;
}> = [
  { name: "reading a message thread", of: "thread", owner: 200,
    ask: (s, token, id) => s.get(token, `/patient/thread?id=${id}`) },
  { name: "replying to a message thread", of: "thread", owner: 200,
    ask: (s, token, id) => s.post(token, "/patient/thread-reply", { id, body: "Me again." }) },
  { name: "reading an after-visit summary", of: "encounter", owner: 200,
    ask: (s, token, id) => s.get(token, `/patient/after-visit-summary?encounter=${id}`) },
  { name: "sending in an intake form", of: "draft", owner: 200,
    ask: (s, token, id) => s.post(token, "/patient/intake/submit", { id }) },
  { name: "downloading an upload", of: "upload", owner: 200,
    ask: (s, token, id) => s.get(token, `/patient/upload?id=${id}`) },
];

// One test rather than one per route, so the hazard log can cite it by name.
// Every assertion names the route it failed on.
test("record ids: a stranger's real id and a missing id get the same answer on every route that names a record", async () => {
  const s = await boot();
  try {
    s.t.patientAccess.grantSelf(PATIENT, "urn:dev:marie", CLERK);
    s.t.patientAccess.grantSelf(OTHER, "urn:dev:stranger", CLERK);
    const owner = await s.signIn("urn:dev:marie");
    const stranger = await s.signIn("urn:dev:stranger");
    const made = await records(s, owner);
    const messageCounts = () => s.t.messaging.forPatient(PATIENT).map((th) => s.t.messaging.messages(th.id).length);

    for (const route of ROUTES) {
      const real = made[route.of];
      const messagesBefore = messageCounts();

      const theirs = await answer(await route.ask(s, stranger, real));
      const nowhere = await answer(await route.ask(s, stranger, randomUUID()));
      const ownTypo = await answer(await route.ask(s, owner, randomUUID()));

      assert.equal(theirs.status, 403, `${route.name}: somebody else's record`);
      assert.equal(theirs.body, NOT_AUTHORIZED, `${route.name}: somebody else's record`);
      assert.deepEqual(nowhere, theirs, `${route.name}: a missing record must read exactly like somebody else's`);
      assert.deepEqual(ownTypo, theirs, `${route.name}: the owner's missing id too, so their answer is no oracle either`);

      // Nothing the stranger did landed.
      assert.deepEqual(messageCounts(), messagesBefore, `${route.name}: a refused request wrote a message`);
      if (route.of === "draft") assert.equal(s.t.intake.find(real)!.status, "draft", `${route.name}: a refused submit sent the form`);

      // And the gate is a gate, not a wall: the owner gets their record.
      assert.equal((await route.ask(s, owner, real)).status, route.owner, `${route.name}: the owner's own record`);
    }

    // It is the answer the rest of the boundary already gives: to a chart
    // with no grant, to a patient id that does not exist, and to a grant on
    // the chart that lacks the permission.
    const refused = await answer(await s.get(stranger, `/patient/thread?id=${made.thread}`));
    assert.deepEqual(await answer(await s.get(stranger, `/patient/summary?patient=${PATIENT}`)), refused, "a chart with no grant");
    assert.deepEqual(await answer(await s.get(stranger, "/patient/summary?patient=NT000000")), refused, "a patient id that does not exist");
    s.t.patientAccess.grantProxy({
      patientId: PATIENT, subjectId: "urn:dev:driver", relationship: "representative",
      permissions: ["appointments"], purpose: "drives to visits", expiresAt: tomorrow(), by: CLERK,
    });
    const driver = await s.signIn("urn:dev:driver");
    assert.deepEqual(await answer(await s.get(driver, `/patient/thread?id=${made.thread}`)), refused, "a grant without the permission");
  } finally {
    await s.close();
  }
});

test("record ids: the trail still tells a missing record from somebody else's", async () => {
  const s = await boot();
  try {
    s.t.patientAccess.grantSelf(PATIENT, "urn:dev:marie", CLERK);
    s.t.patientAccess.grantSelf(OTHER, "urn:dev:stranger", CLERK);
    const owner = await s.signIn("urn:dev:marie");
    const stranger = await s.signIn("urn:dev:stranger");
    const { thread } = await records(s, owner);
    const missing = randomUUID();

    await s.get(stranger, `/patient/thread?id=${thread}`);
    await s.get(stranger, `/patient/thread?id=${missing}`);

    const trail = s.t.audit.list({ limit: 500 }).filter((r) => r.path === "/patient/thread");
    // The real one: refused against the patient whose thread it is, which is
    // what a privacy officer searching that chart will find.
    assert.ok(
      trail.some((r) => r.patient === PATIENT && r.outcome === 4 && r.detail === "no live patient authority"),
      "the attempt on a real record is on the trail, against the patient it belongs to"
    );
    // The missing one: refused too, and saying why.
    const nowhere = trail.filter((r) => r.detail === `no message thread ${missing}`);
    assert.equal(nowhere.length, 1, "the attempt on a missing record is on the trail as well");
    assert.equal(nowhere[0].outcome, 4);
    assert.equal(nowhere[0].patient, null, "and names no patient, because there is none");

    // The patient's own access log, which they can read, shows the attempt
    // on their thread by an account with no grant.
    const seen = s.t.patientAccess.accessLog(PATIENT).filter((r) => r.subject_id === "urn:dev:stranger");
    assert.deepEqual(
      seen.map((r) => [r.action, r.relationship, r.outcome]),
      [["view-message-thread", "none", "refused"]]
    );
  } finally {
    await s.close();
  }
});

// ------------------------------------------------ ids named inside a chart

test("record ids: an upload can only say it goes with one of the patient's own forms", async () => {
  const s = await boot();
  try {
    s.t.patientAccess.grantSelf(PATIENT, "urn:dev:marie", CLERK);
    const owner = await s.signIn("urn:dev:marie");
    const ownForm = (await (await s.post(owner, "/patient/intake/draft", { patient: PATIENT, concern: "A rash" })).json()) as { id: string };
    const theirForm = s.t.intake.saveDraft({ patientId: OTHER, concern: "Knee pain", by: { actorId: "urn:dev:other", actorKind: "patient" } });
    const send = (submissionId: string) =>
      s.post(owner, "/patient/upload", {
        patient: PATIENT, submissionId, filename: "rash.txt", contentType: "text/plain",
        data: Buffer.from("photo, in words").toString("base64"),
      });

    const madeUp = randomUUID();
    const refusedMadeUp = await answer(await send(madeUp));
    const refusedTheirs = await answer(await send(theirForm.id));
    assert.equal(refusedMadeUp.status, 404);
    assert.equal(JSON.parse(refusedMadeUp.body).error, `no intake submission ${madeUp} for this patient`);
    assert.deepEqual(
      { ...refusedTheirs, body: refusedTheirs.body.replace(theirForm.id, "<id>") },
      { ...refusedMadeUp, body: refusedMadeUp.body.replace(madeUp, "<id>") },
      "a made-up form and another patient's form are one answer"
    );
    assert.equal(s.t.uploads.forPatient(PATIENT).length, 0, "and neither refusal stored a file");

    // The patient's own form is still fine to name.
    const accepted = await send(ownForm.id);
    assert.equal(accepted.status, 201);
    assert.deepEqual(s.t.uploads.forPatient(PATIENT).map((u) => u.submission_id), [ownForm.id]);
  } finally {
    await s.close();
  }
});

test("record ids: an upload store with no forms to check against refuses to link one", async () => {
  const s = await boot();
  try {
    const form = s.t.intake.saveDraft({ patientId: PATIENT, concern: "A rash", by: { actorId: "urn:dev:marie", actorKind: "patient" } });
    const unwired = new Uploads(s.t.db, s.t.documents);
    assert.throws(
      () => unwired.receive({
        patientId: PATIENT, submissionId: form.id, filename: "rash.txt", contentType: "text/plain",
        data: Buffer.from("photo, in words").toString("base64"), by: { actorId: "urn:dev:marie", actorKind: "patient" },
      }),
      /no intake store is wired/
    );
    assert.equal(s.t.uploads.forPatient(PATIENT).length, 0);
  } finally {
    await s.close();
  }
});

test("record ids: revoking something that is not this chart's delegate is one refusal, not a fault", async () => {
  const s = await boot();
  try {
    const self = s.t.patientAccess.grantSelf(PATIENT, "urn:dev:marie", CLERK);
    const proxy = { relationship: "representative" as const, permissions: ["appointments" as const], purpose: "drives to visits", expiresAt: tomorrow(), by: CLERK };
    const ours = s.t.patientAccess.grantProxy({ patientId: PATIENT, subjectId: "urn:dev:helper", ...proxy });
    const theirs = s.t.patientAccess.grantProxy({ patientId: OTHER, subjectId: "urn:dev:other-helper", ...proxy });
    const owner = await s.signIn("urn:dev:marie");
    const revoke = (authority: string) =>
      s.post(owner, "/patient/delegate-revoke", { patient: PATIENT, authority, reason: "no longer needed" });

    const missing = randomUUID();
    const answers = [
      [missing, await answer(await revoke(missing))],
      [theirs.id, await answer(await revoke(theirs.id))],
      [self.id, await answer(await revoke(self.id))],
    ] as const;
    for (const [id, got] of answers) {
      // Before: 500 "internal error", a fault in the log, a serious trail row.
      assert.equal(got.status, 404, `${id}: a refusal, not a fault`);
      assert.equal(JSON.parse(got.body).error, `no delegated authority ${id} for this patient`);
    }
    const [first, ...rest] = answers.map(([id, got]) => ({ ...got, body: got.body.replace(id, "<id>") }));
    for (const other of rest) assert.deepEqual(other, first, "one answer for missing, another chart's and the patient's own");

    assert.ok(s.t.patientAccess.may("urn:dev:other-helper", OTHER), "another chart's delegate is untouched");
    assert.ok(s.t.patientAccess.may("urn:dev:marie", PATIENT), "and so is the patient's own access");
    const trail = s.t.audit.list({ limit: 500 }).filter((r) => r.path === "/patient/delegate-revoke");
    assert.deepEqual(trail.map((r) => r.outcome), [4, 4, 4], "refused, not failed");

    // The chart's real delegate can still be revoked.
    assert.equal((await revoke(ours.id)).status, 200);
    assert.equal(s.t.patientAccess.may("urn:dev:helper", PATIENT), undefined);
  } finally {
    await s.close();
  }
});

test("record ids: a caregiver grant that carries 'delegates' anyway is refused, not failed", async () => {
  const s = await boot();
  try {
    s.t.patientAccess.grantSelf(PATIENT, "urn:dev:marie", CLERK);
    const helper = s.t.patientAccess.grantProxy({
      patientId: PATIENT, subjectId: "urn:dev:helper", relationship: "representative",
      permissions: ["appointments"], purpose: "drives to visits", expiresAt: tomorrow(), by: CLERK,
    });
    const other = s.t.patientAccess.grantProxy({
      patientId: PATIENT, subjectId: "urn:dev:sister", relationship: "representative",
      permissions: ["appointments"], purpose: "books visits", expiresAt: tomorrow(), by: CLERK,
    });
    // grantProxy() refuses "delegates"; an older or imported row need not
    // have gone through it.
    s.t.db.sql
      .prepare("UPDATE patient_authority SET permissions = ? WHERE tenant_id = ? AND id = ?")
      .run(JSON.stringify(["appointments", "delegates"]), s.t.db.tenantId, helper.id);
    const token = await s.signIn("urn:dev:helper");

    const review = await answer(await s.get(token, `/patient/delegates?patient=${PATIENT}`));
    assert.equal(review.status, 403);
    assert.equal(JSON.parse(review.body).error, "only the patient may review delegated access");
    const revoke = await answer(await s.post(token, "/patient/delegate-revoke", { patient: PATIENT, authority: other.id, reason: "x" }));
    assert.equal(revoke.status, 403);
    assert.equal(JSON.parse(revoke.body).error, "only the patient may revoke delegated access");
    assert.ok(s.t.patientAccess.may("urn:dev:sister", PATIENT), "and nothing was revoked");
  } finally {
    await s.close();
  }
});
