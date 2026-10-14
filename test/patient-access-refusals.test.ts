/**
 * A "no" from patient access is a refusal the caller can read, not a fault.
 *
 * `PatientAccess` said every no with `throw new Error`, so the router's net
 * mapped each one as a fault: 500 "internal error", a fault line in the log,
 * and an audit row marked a serious failure. That covered a patient asking
 * for a correction without saying what to correct, a clerk typing an expiry
 * that has already passed, a caregiver being given a permission caregivers
 * cannot hold, and somebody answering a patient request that was already
 * answered. None of those is the server breaking, and a 5xx tells a client
 * to retry a request that will be refused identically every time.
 *
 * What is held here: every refusal in the store is a `Refusal` with a status
 * that says what kind of no it is — 400 for the request, 404 for an id that
 * is not there, 409 for a state that has moved on — and its words are
 * unchanged. The routes that reach them, on both sides of the boundary,
 * answer with those words. One thing is deliberately left a fault: a
 * store built without the review inbox it needs, which is wiring, not a
 * caller's mistake, and belongs in the operator's log.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../src/db.ts";
import { OrderStore } from "../src/orders/store.ts";
import { PatientAccess } from "../src/patient/access.ts";
import { TaskStore } from "../src/work/tasks.ts";
import { Refusal } from "../src/core/refusal.ts";
import { Engine } from "../src/core/engine.ts";
import { startApi } from "../src/api/admin.ts";
import { AuthGate } from "../src/auth/gate.ts";
import { JwtVerifier } from "../src/auth/jwt.ts";
import { DevIdentityProvider } from "../src/auth/dev-idp.ts";

const P = "NT123456";
const GP = { actorId: "dr-tetso", actorKind: "practitioner" };
const CLERK = { actorId: "registration-desk", actorKind: "practitioner" };
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();
const PROXY = {
  patientId: P,
  subjectId: "urn:dev:helper",
  relationship: "representative" as const,
  permissions: ["appointments" as const],
  purpose: "drives to visits",
  expiresAt: inDays(30),
  by: CLERK,
};

function store() {
  const dir = mkdtempSync(join(tmpdir(), "northstar-par-"));
  const db = new Db(join(dir, "northstar.db"));
  const orders = new OrderStore(db);
  const tasks = new TaskStore(db);
  return {
    db, orders, tasks,
    pa: new PatientAccess(db, orders, tasks),
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}

function aResult(orders: OrderStore) {
  const o = orders.create({ patientId: P, category: "lab", code: "2823-3", display: "Potassium", indication: "Electrolyte check", by: GP });
  orders.place(o.id, { ...GP, responsibleId: "dr-tetso" });
  return orders.report({ patientId: P, orderId: o.id, code: "2823-3", display: "Potassium", value: "4.1", reportedBy: "analyser" });
}

/** The thrown error, so its class and status can be looked at. */
function refusalOf(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  assert.fail("expected a refusal, and nothing was thrown");
}

function assertRefused(fn: () => unknown, status: number, words: RegExp, what: string): void {
  const err = refusalOf(fn);
  assert.ok(err instanceof Refusal, `${what}: thrown as ${(err as Error)?.constructor?.name}, which the router answers as a fault`);
  assert.equal(err.status, status, `${what}: status`);
  assert.match(err.message, words, `${what}: words`);
}

// ------------------------------------------------------------ the store

test("patient access: every no in the store is a refusal with a status, in unchanged words", () => {
  const { pa, orders, cleanup } = store();
  try {
    // Grants.
    assertRefused(() => pa.grantProxy({ ...PROXY, expiresAt: "" }), 400, /needs an expiry/, "a grant with no expiry");
    assertRefused(() => pa.grantProxy({ ...PROXY, expiresAt: inDays(-1) }), 400, /^that expiry is already past$/, "a grant that has already ended");
    assertRefused(() => pa.grantProxy({ ...PROXY, purpose: "  " }), 400, /needs a purpose/, "a grant with no purpose");
    assertRefused(() => pa.grantProxy({ ...PROXY, permissions: [] }), 400, /at least one explicit permission/, "a grant with no permissions");
    assertRefused(
      () => pa.grantProxy({ ...PROXY, permissions: ["appointments", "delegates"] as never }),
      400, /^proxy permission not allowed: delegates$/, "a caregiver given what a caregiver cannot hold"
    );

    // Revocation.
    const grant = pa.grantProxy(PROXY);
    assertRefused(() => pa.revoke(grant.id, { ...CLERK, reason: " " }), 400, /needs a reason/, "a revocation with no reason");
    assertRefused(() => pa.revoke("no-such-grant", { ...CLERK, reason: "moved away" }), 404, /^no authority no-such-grant$/, "revoking a grant that is not there");
    pa.revoke(grant.id, { ...CLERK, reason: "moved away" });
    assertRefused(() => pa.revoke(grant.id, { ...CLERK, reason: "again" }), 409, /already revoked/, "revoking twice");

    // Result holds.
    const result = aResult(orders);
    const hold = { resultId: result.id, category: "clinician-will-discuss" as const, releaseAt: inDays(3), by: GP, reason: "appointment Thursday" };
    assertRefused(() => pa.hold({ ...hold, reason: " " }), 400, /needs a reason/, "a hold with no reason");
    assertRefused(() => pa.hold({ ...hold, releaseAt: "" }), 400, /needs an end/, "a hold with no end");
    assertRefused(() => pa.hold({ ...hold, releaseAt: inDays(-1) }), 400, /already past/, "a hold that has already ended");
    assertRefused(() => pa.hold({ ...hold, resultId: "no-such-result" }), 404, /^no result no-such-result$/, "holding a result that is not there");

    // Patient requests.
    const asked = { patientId: P, kind: "access" as const, detail: "my immunization record", by: { subjectId: "urn:dev:marie", relationship: "self" as const } };
    assertRefused(() => pa.submitRequest({ ...asked, kind: "complaint" as never }), 400, /must be access or correction/, "a request of no known kind");
    assertRefused(() => pa.submitRequest({ ...asked, detail: "  " }), 400, /needs detail/, "a request with no detail");
    assertRefused(() => pa.submitRequest({ ...asked, kind: "correction" }), 400, /identify what should be corrected/, "a correction naming nothing");

    const first = pa.submitRequest(asked);
    assertRefused(() => pa.completeRequest(first.id, { ...CLERK, outcome: " " }), 400, /needs to say what was provided/, "completing with no outcome");
    assertRefused(() => pa.completeRequest("no-such-request", { ...CLERK, outcome: "sent" }), 404, /^no patient request no-such-request$/, "completing a request that is not there");
    pa.completeRequest(first.id, { ...CLERK, outcome: "record sent by secure email" });
    assertRefused(() => pa.completeRequest(first.id, { ...CLERK, outcome: "sent again" }), 409, /already completed/, "completing twice");

    const second = pa.submitRequest(asked);
    assertRefused(() => pa.declineRequest(second.id, { ...CLERK, reason: " " }), 400, /needs a reason/, "declining with no reason");
    assertRefused(() => pa.declineRequest("no-such-request", { ...CLERK, reason: "duplicate" }), 404, /^no patient request no-such-request$/, "declining a request that is not there");
    pa.declineRequest(second.id, { ...CLERK, reason: "duplicate of an earlier request" });
    assertRefused(() => pa.declineRequest(second.id, { ...CLERK, reason: "again" }), 409, /already declined/, "declining twice");
  } finally {
    cleanup();
  }
});

test("patient access: a request answered while another answer was being written is a conflict, not a fault", () => {
  // The guard inside the write, for two people answering one request at
  // once. Driven deterministically: the review inbox's own step marks the
  // request answered, which is exactly the window the guard watches.
  for (const answer of ["complete", "decline"] as const) {
    const { db, pa, tasks, cleanup } = store();
    try {
      const request = pa.submitRequest({ patientId: P, kind: "access", detail: "my results", by: { subjectId: "urn:dev:marie", relationship: "self" } });
      const answeredElsewhere = () =>
        db.sql.prepare("UPDATE patient_requests SET status = 'completed' WHERE id = ?").run(request.id);
      const complete = tasks.complete.bind(tasks);
      const cancel = tasks.cancel.bind(tasks);
      tasks.complete = ((...args: Parameters<typeof complete>) => (answeredElsewhere(), complete(...args))) as typeof tasks.complete;
      tasks.cancel = ((...args: Parameters<typeof cancel>) => (answeredElsewhere(), cancel(...args))) as typeof tasks.cancel;
      assertRefused(
        () => answer === "complete"
          ? pa.completeRequest(request.id, { ...CLERK, outcome: "record sent" })
          : pa.declineRequest(request.id, { ...CLERK, reason: "duplicate of an earlier request" }),
        409, /answered while this was being applied/, `${answer} racing another answer`
      );
      assert.equal(pa.request(request.id)!.status, "submitted", `${answer}: rolled back, nothing half-written`);
    } finally {
      cleanup();
    }
  }
});

test("patient access: a store built without its review inbox is a fault, because that is wiring", () => {
  const { db, orders, pa, cleanup } = store();
  try {
    const unwired = new PatientAccess(db, orders);
    const asked = { patientId: P, kind: "access" as const, detail: "my results", by: { subjectId: "urn:dev:marie", relationship: "self" as const } };
    const request = pa.submitRequest(asked);
    for (const [what, fn] of [
      ["submit", () => unwired.submitRequest(asked)],
      ["complete", () => unwired.completeRequest(request.id, { ...CLERK, outcome: "sent" })],
      ["decline", () => unwired.declineRequest(request.id, { ...CLERK, reason: "duplicate" })],
    ] as const) {
      const err = refusalOf(fn);
      assert.ok(err instanceof Error && !(err instanceof Refusal), `${what}: a missing inbox must reach the operator's log as a fault`);
      assert.match((err as Error).message, /inbox is not configured/);
    }
  } finally {
    cleanup();
  }
});

// ------------------------------------------------------------ over HTTP

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
  t.clinical.record({
    entryType: "Patient", patientId: P,
    content: { resourceType: "Patient", identifier: [{ value: P }] },
    authorId: "adt", authorKind: "device",
  });
  const staff = engine.keys.issue("front-desk", ["admin"]).key;
  const port = await freePort();
  const issuer = `http://127.0.0.1:${port}/dev-idp`;
  const idp = new DevIdentityProvider({
    issuer, audience: "northstar-test",
    liveSubjects: () => engine.forTenant("default").patientAccess.liveSubjects().map((s) => ({ ...s, tenantId: "default" })),
  });
  const api = await startApi(engine, port, "127.0.0.1", {
    auth: new AuthGate({
      keys: engine.keys,
      jwt: new JwtVerifier({ issuer, audience: "northstar-test", jwksUri: `${issuer}/.well-known/jwks.json` }),
      tenants: engine.db,
    }),
    devIdp: idp,
  });
  const base = `http://127.0.0.1:${api.port}`;
  const post = (token: string, path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return {
    engine, t, staff, post,
    async signIn(subject: string): Promise<string> {
      const res = await fetch(`${base}/dev-idp/token`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ subject }),
      });
      const body = (await res.json()) as { access_token?: string; error?: string };
      if (!res.ok) throw new Error(body.error ?? `sign-in failed: ${res.status}`);
      return body.access_token!;
    },
    close: async () => { await api.close(); await engine.stop(); },
  };
}

/** A refusal over HTTP: its status, its own words, and no fault id — a fault id is what a 500 carries. */
async function assertAnswered(res: Response, status: number, error: string, what: string): Promise<void> {
  const body = (await res.json()) as { error?: string; faultId?: string };
  assert.deepEqual({ status: res.status, body }, { status, body: { error } }, what);
}

test("patient access: a patient's request that cannot be taken says why, and is not a fault", async () => {
  const s = await boot();
  try {
    s.t.patientAccess.grantSelf(P, "urn:dev:marie", CLERK);
    const token = await s.signIn("urn:dev:marie");
    const ask = (body: Record<string, unknown>) => s.post(token, "/patient/request", { patient: P, ...body });

    // Before: 500 {"error":"internal error","faultId":"…"} for each of these.
    await assertAnswered(await ask({ kind: "correction", detail: "my birth date is wrong" }), 400,
      "a correction request needs to identify what should be corrected", "a correction naming nothing");
    await assertAnswered(await ask({ kind: "access", detail: "   " }), 400, "a patient request needs detail", "a request of only spaces");
    await assertAnswered(await ask({ kind: "complaint", detail: "the wait" }), 400,
      "a patient request must be access or correction", "a request of no known kind");

    assert.deepEqual(s.t.patientAccess.requestsFor(P), [], "nothing was filed on the way to refusing");
    const trail = s.t.audit.list({ limit: 500 }).filter((r) => r.path === "/patient/request");
    assert.deepEqual(trail.map((r) => r.outcome), [4, 4, 4], "refused, not failed");
    // And the patient's own access log says refused, in the request's words.
    assert.ok(
      s.t.patientAccess.accessLog(P).some((r) => r.action === "submit-patient-request" && r.outcome === "refused" &&
        r.detail === "a correction request needs to identify what should be corrected")
    );

    // A good request still goes in.
    assert.equal((await ask({ kind: "correction", target: "date of birth", detail: "it is 1961, not 1916" })).status, 201);
  } finally {
    await s.close();
  }
});

test("patient access: a patient revoking a caregiver with no reason, or twice, is told so", async () => {
  const s = await boot();
  try {
    s.t.patientAccess.grantSelf(P, "urn:dev:marie", CLERK);
    const helper = s.t.patientAccess.grantProxy(PROXY);
    const token = await s.signIn("urn:dev:marie");
    const revoke = (reason: string) => s.post(token, "/patient/delegate-revoke", { patient: P, authority: helper.id, reason });

    await assertAnswered(await revoke("   "), 400, "revoking access needs a reason", "a reason of only spaces");
    assert.equal((await revoke("we moved")).status, 200);
    await assertAnswered(await revoke("we moved"), 409, "that access is already revoked", "revoking twice");
  } finally {
    await s.close();
  }
});

test("patient access: the clinic's own mistakes on grants and requests are refusals, not faults", async () => {
  const s = await boot();
  try {
    const grantInPerson = (overrides: Record<string, unknown>) =>
      s.post(s.staff, "/api/clinical/authority-proxy", {
        patient: P, subject: "urn:dev:helper", relationship: "representative",
        expiresAt: inDays(30), permissions: ["appointments"], purpose: "drives to visits",
        method: "photo ID checked at the front desk against the chart", ...overrides,
      });

    // A typo in the expiry, and a permission a caregiver cannot hold. The
    // enrolment request in front of the grant does not check either, so
    // both used to surface as 500 at the moment of attesting.
    await assertAnswered(await grantInPerson({ expiresAt: inDays(-1) }), 400, "that expiry is already past", "an expiry already gone");
    await assertAnswered(await grantInPerson({ permissions: ["appointments", "delegates"] }), 400,
      "proxy permission not allowed: delegates", "a caregiver given what a caregiver cannot hold");
    assert.equal(s.t.patientAccess.may("urn:dev:helper", P), undefined, "no access was granted");
    assert.deepEqual(s.t.enrolment.list({ patientId: P }), [], "and no half-made enrolment was left behind");

    // Revoking twice.
    assert.equal((await grantInPerson({})).status, 200);
    const grant = s.t.patientAccess.may("urn:dev:helper", P)!;
    const revoke = () => s.post(s.staff, "/api/clinical/authority-revoke", { authority: grant.id, reason: "family asked" });
    assert.equal((await revoke()).status, 200);
    await assertAnswered(await revoke(), 409, "that access is already revoked", "revoking twice");

    // Answering a request that has already been answered.
    const request = s.t.patientAccess.submitRequest({
      patientId: P, kind: "access", detail: "my immunization record", by: { subjectId: "urn:dev:marie", relationship: "self" },
    });
    const answer = (path: string, body: Record<string, unknown>) => s.post(s.staff, path, { request: request.id, ...body });
    await assertAnswered(await answer("/api/clinical/patient-request-complete", { outcome: "   " }), 400,
      "completing a patient request needs to say what was provided or corrected", "an outcome of only spaces");
    assert.equal((await answer("/api/clinical/patient-request-decline", { reason: "duplicate of an earlier request" })).status, 200);
    await assertAnswered(await answer("/api/clinical/patient-request-complete", { outcome: "record sent" }), 409,
      "that patient request is already declined", "completing a declined request");
  } finally {
    await s.close();
  }
});
