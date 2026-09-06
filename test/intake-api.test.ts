/**
 * The patient-facing HTTP surface for item 60, through a real token.
 *
 * Same shape as portal.test.ts: a token minted by the development identity
 * provider, fetched as JWKS over HTTP by the ordinary JwtVerifier, arriving
 * at the ordinary /patient/* boundary. What is new here is the "intake"
 * permission — a caregiver with "appointments" only must not reach it, and
 * one explicitly granted it must, exactly the way every other permission on
 * this boundary already works.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Engine } from "../src/core/engine.ts";
import { startApi } from "../src/api/admin.ts";
import { AuthGate } from "../src/auth/gate.ts";
import { JwtVerifier } from "../src/auth/jwt.ts";
import { DevIdentityProvider } from "../src/auth/dev-idp.ts";
import { SyntheticScanner, EICAR_TEST_STRING } from "../src/patient/intake.ts";

const AUDIENCE = "northstar-test";
const PATIENT = "NT123456";
const OTHER = "NT999999";
const CLERK = { actorId: "clerk", actorKind: "practitioner" };

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

async function boot(opts: { scanner?: boolean } = {}) {
  const engine = new Engine({
    dbPath: ":memory:",
    tickMs: 15,
    ...(opts.scanner ? { malwareScanner: new SyntheticScanner() } : {}),
  });
  await engine.start();
  const t = engine.forTenant("default");
  for (const id of [PATIENT, OTHER]) {
    t.clinical.record({
      entryType: "Patient",
      patientId: id,
      content: { resourceType: "Patient", identifier: [{ value: id }] },
      authorId: "adt",
      authorKind: "device",
    });
  }
  t.questionnaires.publish({
    id: "pre-visit",
    title: "Pre-visit check-in",
    questions: [{ key: "fasting", label: "Have you fasted?", type: "boolean", required: true }],
    by: CLERK,
  });

  const port = await freePort();
  const issuer = `http://127.0.0.1:${port}/dev-idp`;
  const idp = new DevIdentityProvider({
    issuer,
    audience: AUDIENCE,
    liveSubjects: () => engine.forTenant("default").patientAccess.liveSubjects().map((s) => ({ ...s, tenantId: "default" })),
  });
  const jwt = new JwtVerifier({ issuer, audience: AUDIENCE, jwksUri: `${issuer}/.well-known/jwks.json` });
  const api = await startApi(engine, port, "127.0.0.1", {
    auth: new AuthGate({ keys: engine.keys, jwt, tenants: engine.db }),
    devIdp: idp,
  });
  const base = `http://127.0.0.1:${api.port}`;

  return {
    engine,
    t,
    base,
    async signIn(subject: string): Promise<string> {
      const res = await fetch(`${base}/dev-idp/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
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
    close: async () => {
      await api.close();
      await engine.stop();
    },
  };
}

test("a patient drafts, saves, and submits a pre-visit questionnaire through the real boundary", async () => {
  const s = await boot();
  try {
    s.t.patientAccess.grantSelf(PATIENT, "urn:dev:marie", CLERK);
    const token = await s.signIn("urn:dev:marie");

    const forms = (await (await s.get(token, "/patient/questionnaires")).json()) as {
      questionnaires: { id: string; version: number }[];
    };
    assert.deepEqual(forms.questionnaires.map((q) => q.id), ["pre-visit"]);

    const draft = await s.post(token, "/patient/intake/draft", {
      patient: PATIENT,
      questionnaireId: "pre-visit",
      answers: { fasting: true },
    });
    assert.equal(draft.status, 201);
    const saved = (await draft.json()) as { id: string; status: string };
    assert.equal(saved.status, "draft");

    const submitted = await s.post(token, "/patient/intake/submit", { id: saved.id });
    assert.equal(submitted.status, 200);
    const body = (await submitted.json()) as { status: string; record_id: string };
    assert.equal(body.status, "submitted");

    const chart = s.t.clinical.chart(PATIENT, { entryType: "QuestionnaireResponse" });
    assert.equal(chart.length, 1);
    assert.equal(JSON.parse(chart[0].content).item.fasting, true);
    assert.equal(chart[0].author_kind, "patient");
  } finally {
    await s.close();
  }
});

test("submitting the same draft twice over HTTP is one submission, not two", async () => {
  const s = await boot();
  try {
    s.t.patientAccess.grantSelf(PATIENT, "urn:dev:marie", CLERK);
    const token = await s.signIn("urn:dev:marie");
    const draft = (await (
      await s.post(token, "/patient/intake/draft", { patient: PATIENT, concern: "Recurring headaches" })
    ).json()) as { id: string };

    const first = await (await s.post(token, "/patient/intake/submit", { id: draft.id })).json();
    const second = await (await s.post(token, "/patient/intake/submit", { id: draft.id })).json();
    assert.deepEqual(first, second);
    assert.equal(s.t.clinical.chart(PATIENT, { entryType: "QuestionnaireResponse" }).length, 1);
  } finally {
    await s.close();
  }
});

test("a caregiver without the intake permission is refused; one with it can draft on the patient's behalf", async () => {
  const s = await boot();
  try {
    s.t.patientAccess.grantSelf(PATIENT, "urn:dev:marie", CLERK);
    s.t.patientAccess.grantProxy({
      patientId: PATIENT,
      subjectId: "urn:dev:no-intake",
      relationship: "representative",
      expiresAt: new Date(Date.now() + 30 * 86400_000).toISOString(),
      permissions: ["appointments"],
      purpose: "driving to appointments",
      by: CLERK,
    });
    s.t.patientAccess.grantProxy({
      patientId: PATIENT,
      subjectId: "urn:dev:with-intake",
      relationship: "representative",
      expiresAt: new Date(Date.now() + 30 * 86400_000).toISOString(),
      permissions: ["appointments", "intake"],
      purpose: "manages pre-visit paperwork for a parent",
      by: CLERK,
    });

    const noIntake = await s.signIn("urn:dev:no-intake");
    assert.equal((await s.get(noIntake, `/patient/intake?patient=${PATIENT}`)).status, 403);
    assert.equal((await s.post(noIntake, "/patient/intake/draft", { patient: PATIENT, concern: "x" })).status, 403);
    assert.equal(
      (
        await s.post(noIntake, "/patient/upload", {
          patient: PATIENT,
          filename: "x.pdf",
          contentType: "application/pdf",
          data: Buffer.from("x").toString("base64"),
        })
      ).status,
      403
    );

    const withIntake = await s.signIn("urn:dev:with-intake");
    const draft = await s.post(withIntake, "/patient/intake/draft", { patient: PATIENT, concern: "On behalf of my father" });
    assert.equal(draft.status, 201);
    const body = (await draft.json()) as { started_by: string };
    assert.equal(body.started_by, "urn:dev:with-intake");
  } finally {
    await s.close();
  }
});

test("revoking a caregiver's grant takes the intake permission with it on the next request", async () => {
  const s = await boot();
  try {
    s.t.patientAccess.grantSelf(PATIENT, "urn:dev:marie", CLERK);
    const grant = s.t.patientAccess.grantProxy({
      patientId: PATIENT,
      subjectId: "urn:dev:sam",
      relationship: "representative",
      expiresAt: new Date(Date.now() + 30 * 86400_000).toISOString(),
      permissions: ["appointments", "intake"],
      purpose: "helps with paperwork",
      by: CLERK,
    });
    const token = await s.signIn("urn:dev:sam");
    assert.equal((await s.get(token, `/patient/intake?patient=${PATIENT}`)).status, 200);

    s.t.patientAccess.revoke(grant.id, { actorId: CLERK.actorId, actorKind: CLERK.actorKind, reason: "no longer needed" });
    assert.equal((await s.get(token, `/patient/intake?patient=${PATIENT}`)).status, 403);
  } finally {
    await s.close();
  }
});

test("a patient cannot draft, submit, or review intake for a chart they hold no authority on", async () => {
  const s = await boot();
  try {
    s.t.patientAccess.grantSelf(PATIENT, "urn:dev:marie", CLERK);
    const token = await s.signIn("urn:dev:marie");
    assert.equal((await s.get(token, `/patient/intake?patient=${OTHER}`)).status, 403);
    assert.equal((await s.post(token, "/patient/intake/draft", { patient: OTHER, concern: "not mine to submit" })).status, 403);
  } finally {
    await s.close();
  }
});

test("uploading, listing, and downloading a file all go through the same authority check", async () => {
  const s = await boot({ scanner: true });
  try {
    s.t.patientAccess.grantSelf(PATIENT, "urn:dev:marie", CLERK);
    const token = await s.signIn("urn:dev:marie");
    const data = Buffer.from("a specialist letter, in bytes").toString("base64");

    const uploaded = await s.post(token, "/patient/upload", {
      patient: PATIENT,
      filename: "letter.pdf",
      contentType: "application/pdf",
      data,
    });
    assert.equal(uploaded.status, 201);
    const row = (await uploaded.json()) as { id: string; status: string };
    assert.equal(row.status, "pending-scan");

    const listed = (await (await s.get(token, `/patient/uploads?patient=${PATIENT}`)).json()) as Array<Record<string, unknown>>;
    assert.equal(listed.length, 1);
    assert.equal("data" in listed[0], false, "a list must never carry the payload");

    // Not downloadable yet — nothing has scanned it.
    assert.equal((await s.get(token, `/patient/upload?id=${row.id}`)).status, 409);

    await s.t.uploads.scanOne(row.id, CLERK);
    const downloaded = await s.get(token, `/patient/upload?id=${row.id}`);
    assert.equal(downloaded.status, 200);
    const body = (await downloaded.json()) as { data: string; filename: string };
    assert.equal(Buffer.from(body.data, "base64").toString("utf8"), "a specialist letter, in bytes");

    // And another patient's authority cannot reach this one's upload.
    const otherToken = await (async () => {
      s.t.patientAccess.grantSelf(OTHER, "urn:dev:other", CLERK);
      return s.signIn("urn:dev:other");
    })();
    assert.equal((await s.get(otherToken, `/patient/upload?id=${row.id}`)).status, 403);
  } finally {
    await s.close();
  }
});

test("an infected upload never becomes downloadable to the patient who sent it", async () => {
  const s = await boot({ scanner: true });
  try {
    s.t.patientAccess.grantSelf(PATIENT, "urn:dev:marie", CLERK);
    const token = await s.signIn("urn:dev:marie");
    const uploaded = await s.post(token, "/patient/upload", {
      patient: PATIENT,
      filename: "totally-fine.txt",
      contentType: "text/plain",
      data: Buffer.from(EICAR_TEST_STRING).toString("base64"),
    });
    const row = (await uploaded.json()) as { id: string };
    await s.t.uploads.scanOne(row.id, CLERK);
    assert.equal((await s.get(token, `/patient/upload?id=${row.id}`)).status, 403);
  } finally {
    await s.close();
  }
});

test("the clinic reviews a submission and the caregiver-scoped intake for one tenant never crosses to another", async () => {
  const s = await boot();
  try {
    s.t.patientAccess.grantSelf(PATIENT, "urn:dev:marie", CLERK);
    const token = await s.signIn("urn:dev:marie");
    const draft = (await (
      await s.post(token, "/patient/intake/draft", { patient: PATIENT, concern: "Something to raise before my visit" })
    ).json()) as { id: string };
    const submitted = (await (await s.post(token, "/patient/intake/submit", { id: draft.id })).json()) as { id: string };

    // Cross-tenant: a second engine's store has no idea this submission exists.
    const other = s.engine.forTenant("second-clinic");
    assert.throws(() => other.intake.get(submitted.id));

    const reviewed = s.t.intake.review(submitted.id, { outcome: "noted", note: "Discussed at the visit", by: CLERK });
    assert.equal(reviewed.status, "reviewed");
  } finally {
    await s.close();
  }
});
