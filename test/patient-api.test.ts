/**
 * The patient API is a separate identity boundary, not a smaller clinician API.
 *
 * The dangerous failure is a SMART `patient/*.read` token becoming the
 * existing `read` scope: that token could then query every Patient on the FHIR
 * facade. These tests use a real signed JWT and the real HTTP gate. They prove
 * that the token reaches only /patient/*, that its subject still needs a live
 * authority grant, and that a proxy permission for appointments does not
 * quietly become permission to read results or message bodies.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { Engine } from "../src/core/engine.ts";
import { startApi } from "../src/api/admin.ts";
import { AuthGate } from "../src/auth/gate.ts";
import { JwtVerifier } from "../src/auth/jwt.ts";

const P = "NT123456";
const OTHER = "NT999999";
const GP = { actorId: "dr-tetso", actorKind: "practitioner" };
const FEED = { authorId: "adt-feed", authorKind: "device" };
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();

async function fakeIdp(): Promise<{
  issuer: string;
  sign(subject: string, scope?: string): string;
  close(): Promise<void>;
}> {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "patient-key", alg: "RS256", use: "sig" };
  let issuer = "";
  const server = createServer((req, res) => {
    if (req.url === "/.well-known/openid-configuration") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ issuer, jwks_uri: `${issuer}/jwks` }));
    }
    if (req.url === "/jwks") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ keys: [jwk] }));
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  issuer = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return {
    issuer,
    sign(subject, scope = "patient/*.cruds") {
      const header = b64({ alg: "RS256", kid: "patient-key", typ: "JWT" });
      const payload = b64({
        iss: issuer,
        aud: "northstar-patient",
        sub: subject,
        scope,
        exp: Math.floor(Date.now() / 1000) + 300,
      });
      const signature = cryptoSign("sha256", Buffer.from(`${header}.${payload}`), privateKey);
      return `${header}.${payload}.${signature.toString("base64url")}`;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function boot() {
  const idp = await fakeIdp();
  const engine = new Engine({ dbPath: ":memory:", tickMs: 15 });
  await engine.start();
  const tenant = engine.forTenant("default");

  for (const [id, family] of [
    [P, "Beaulieu"],
    [OTHER, "Other"],
  ] as const) {
    tenant.clinical.record({
      entryType: "Patient",
      patientId: id,
      content: {
        resourceType: "Patient",
        identifier: [{ system: "urn:jhn", value: id }],
        name: [{ family, given: ["Marie"], use: "official" }],
        birthDate: "1984-03-17",
      },
      ...FEED,
    });
  }
  tenant.directory.addPractitioner({ id: "dr-tetso", family: "Tetso", given: "Jean" });
  tenant.careTeam.assign({ patientId: P, practitionerId: "dr-tetso", role: "primary", by: { actorId: "ops" } });
  tenant.meds.recordNoKnownAllergies(P, GP);
  tenant.meds.record({
    patientId: P,
    code: "860975",
    display: "Metformin 500 mg tablet",
    ingredient: "metformin",
    source: "prescribed",
    adherence: "taking",
    by: GP,
  });
  const order = tenant.orders.create({
    patientId: P,
    category: "lab",
    code: "6051-5",
    display: "Biopsy report",
    indication: "Mass",
    by: GP,
  });
  tenant.orders.place(order.id, { ...GP, responsibleId: "dr-tetso" });
  const result = tenant.orders.report({
    patientId: P,
    orderId: order.id,
    code: "6051-5",
    display: "Biopsy report",
    value: "Adenocarcinoma",
    reportedBy: "pathology",
  });
  tenant.patientAccess.hold({
    resultId: result.id,
    category: "clinician-will-discuss",
    releaseAt: inDays(3),
    by: GP,
    reason: "appointment booked",
  });
  const slot = tenant.schedule.openSlot({
    resourceId: "dr-tetso",
    service: "Results review",
    startsAt: inDays(2),
    endsAt: new Date(Date.now() + 2 * 86_400_000 + 30 * 60_000).toISOString(),
  });
  tenant.schedule.book({ slotId: slot.id, patientId: P, reason: "Discuss results", by: GP });

  tenant.patientAccess.grantSelf(P, "patient-marie", { actorId: "registration", actorKind: "practitioner" });
  tenant.patientAccess.grantProxy({
    patientId: P,
    subjectId: "proxy-appointments",
    relationship: "representative",
    expiresAt: inDays(30),
    permissions: ["appointments"],
    purpose: "book and attend appointments",
    by: { actorId: "registration", actorKind: "practitioner" },
  });
  tenant.patientAccess.grantProxy({
    patientId: P,
    subjectId: "expired-parent",
    relationship: "parent-guardian",
    expiresAt: inDays(1),
    permissions: ["summary"],
    purpose: "care of a minor",
    by: { actorId: "registration", actorKind: "practitioner" },
  });
  // Move it into the past without changing any status. Authority is checked
  // against the clock, not against a sweep.
  tenant.db.sql
    .prepare("UPDATE patient_authority SET expires_at = ? WHERE tenant_id = ? AND subject_id = ?")
    .run(inDays(-1), "default", "expired-parent");

  const gate = new AuthGate({
    jwt: new JwtVerifier({ issuer: idp.issuer, audience: "northstar-patient" }),
  });
  const api = await startApi(engine, 0, "127.0.0.1", { auth: gate });
  const base = `http://127.0.0.1:${api.port}`;
  const request = (subject: string, path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${idp.sign(subject)}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
    });
  return {
    engine,
    tenant,
    request,
    token: (subject: string, scope?: string) => idp.sign(subject, scope),
    base,
    close: async () => {
      await api.close();
      await engine.stop();
      await idp.close();
    },
  };
}

test("patient SMART scope cannot read the general FHIR facade", async () => {
  const s = await boot();
  try {
    const token = s.token("patient-marie");
    assert.equal(
      (await fetch(`${s.base}/fhir/Patient`, { headers: { authorization: `Bearer ${token}` } })).status,
      403,
      "patient context is not system read"
    );
    assert.equal((await s.request("patient-marie", "/patient/authorities")).status, 200);

    const systemRead = s.token("consumer", "system/Patient.read");
    assert.equal(
      (await fetch(`${s.base}/patient/summary?patient=${P}`, { headers: { authorization: `Bearer ${systemRead}` } }))
        .status,
      403,
      "system read is not patient identity either"
    );
  } finally {
    await s.close();
  }
});

test("authentication-off mode never turns anonymous into a patient", async () => {
  const engine = new Engine({ dbPath: ":memory:", tickMs: 15 });
  await engine.start();
  engine
    .forTenant("default")
    .patientAccess.grantSelf(P, "anonymous", { actorId: "registration", actorKind: "practitioner" });
  const api = await startApi(engine, 0, "127.0.0.1");
  try {
    const res = await fetch(`http://127.0.0.1:${api.port}/patient/summary?patient=${P}`);
    assert.equal(res.status, 403);
    assert.match(((await res.json()) as { error: string }).error, /OAuth identity/);
  } finally {
    await api.close();
    await engine.stop();
  }
});

test("an OAuth subject still needs a live authority for the named chart", async () => {
  const s = await boot();
  try {
    assert.equal((await s.request("patient-marie", `/patient/summary?patient=${P}`)).status, 200);
    assert.equal((await s.request("patient-marie", `/patient/summary?patient=${OTHER}`)).status, 403);
    assert.equal((await s.request("stranger", `/patient/summary?patient=${P}`)).status, 403);
    assert.equal((await s.request("expired-parent", `/patient/summary?patient=${P}`)).status, 403);

    const refused = s.tenant.patientAccess.accessLog(OTHER)[0];
    assert.equal(refused.subject_id, "patient-marie");
    assert.equal(refused.relationship, "none");
    assert.equal(refused.outcome, "refused");
    assert.equal(s.tenant.audit.list({ patient: OTHER, limit: 10 })[0].outcome, 4);
  } finally {
    await s.close();
  }
});

test("a proxy permission stays narrow", async () => {
  const s = await boot();
  try {
    const appointments = await s.request("proxy-appointments", `/patient/appointments?patient=${P}`);
    assert.equal(appointments.status, 200);
    const rows = (await appointments.json()) as Array<{ slot: { service: string } }>;
    assert.equal(rows[0].slot.service, "Results review");

    assert.equal((await s.request("proxy-appointments", `/patient/results?patient=${P}`)).status, 403);
    assert.equal((await s.request("proxy-appointments", `/patient/summary?patient=${P}`)).status, 403);
    assert.equal((await s.request("proxy-appointments", `/patient/threads?patient=${P}`)).status, 403);
    assert.equal((await s.request("proxy-appointments", `/patient/delegates?patient=${P}`)).status, 403);
  } finally {
    await s.close();
  }
});

test("held results are visible as held and do not leak their value", async () => {
  const s = await boot();
  try {
    const res = await s.request("patient-marie", `/patient/results?patient=${P}`);
    assert.equal(res.status, 200);
    const rows = (await res.json()) as Array<{ display: string; value?: string; held?: { because: string } }>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].display, "Biopsy report");
    assert.equal(rows[0].value, undefined);
    assert.match(rows[0].held?.because ?? "", /clinician will discuss/i);
    assert.ok(!JSON.stringify(rows).includes("Adenocarcinoma"));
  } finally {
    await s.close();
  }
});

test("the patient summary is patient-safe, not the clinician workspace", async () => {
  const s = await boot();
  try {
    s.tenant.tasks.create({
      kind: "administrative",
      title: "INTERNAL: investigate possible duplicate chart",
      patientId: P,
      ownerId: "dr-tetso",
      by: GP,
    });
    const res = await s.request("patient-marie", `/patient/summary?patient=${P}`);
    assert.equal(res.status, 200);
    const body = JSON.stringify(await res.json());
    assert.ok(body.includes("Beaulieu"));
    assert.ok(body.includes("Metformin"));
    assert.ok(!body.includes("Adenocarcinoma"), "held and unacknowledged result values are not in the summary");
    assert.ok(!body.includes("INTERNAL:"), "internal tasks are not a patient chart section");
  } finally {
    await s.close();
  }
});

test("patient messages derive the speaker from the grant, not the request body", async () => {
  const s = await boot();
  try {
    const opened = await s.request("patient-marie", "/patient/thread-open", {
      method: "POST",
      body: JSON.stringify({
        patient: P,
        subject: "Renewal",
        body: "Please renew metformin.",
        authorKind: "practitioner",
      }),
    });
    assert.equal(opened.status, 201);
    const value = (await opened.json()) as { thread: { id: string }; message: { author_id: string; author_kind: string } };
    assert.equal(value.message.author_id, "patient-marie");
    assert.equal(value.message.author_kind, "patient", "the caller cannot claim to be a practitioner");

    const thread = await s.request("patient-marie", `/patient/thread?id=${value.thread.id}`);
    assert.equal(thread.status, 200);
    assert.equal(((await thread.json()) as { messages: unknown[] }).messages.length, 1);
  } finally {
    await s.close();
  }
});

test("correction requests create clinic work and remain visible to the patient", async () => {
  const s = await boot();
  try {
    const submitted = await s.request("patient-marie", "/patient/request", {
      method: "POST",
      body: JSON.stringify({
        patient: P,
        kind: "correction",
        target: "Medication list",
        detail: "Metformin dose should be 1000 mg at supper.",
      }),
    });
    assert.equal(submitted.status, 201);
    const request = (await submitted.json()) as { id: string; task_id: string };
    assert.equal(s.tenant.tasks.get(request.task_id)?.kind, "privacy-request");
    assert.equal(s.tenant.tasks.get(request.task_id)?.owner_id, null, "unowned privacy work is a queue");

    const list = await s.request("patient-marie", `/patient/requests?patient=${P}`);
    assert.equal(list.status, 200);
    assert.equal(((await list.json()) as Array<{ id: string }>)[0].id, request.id);
  } finally {
    await s.close();
  }
});

test("the patient can review and revoke a proxy, and a proxy cannot manage other proxies", async () => {
  const s = await boot();
  try {
    const delegates = await s.request("patient-marie", `/patient/delegates?patient=${P}`);
    assert.equal(delegates.status, 200);
    const rows = (await delegates.json()) as Array<{ id: string; relationship: string; permissions: string[] }>;
    const proxy = rows.find((r) => r.relationship === "representative");
    assert.ok(proxy);
    assert.deepEqual(proxy.permissions, ["appointments"]);

    assert.equal((await s.request("proxy-appointments", `/patient/delegates?patient=${P}`)).status, 403);
    const revoked = await s.request("patient-marie", "/patient/delegate-revoke", {
      method: "POST",
      body: JSON.stringify({ patient: P, authority: proxy.id, reason: "I no longer need this representative" }),
    });
    assert.equal(revoked.status, 200);
    assert.equal((await s.request("proxy-appointments", `/patient/appointments?patient=${P}`)).status, 403);
  } finally {
    await s.close();
  }
});

test("every patient-scoped route goes through the authority-and-permission helper", () => {
  const source = readFileSync(new URL("../src/api/admin.ts", import.meta.url), "utf8");
  const start = source.indexOf('if (path === "/patient" || path.startsWith("/patient/"))');
  const end = source.indexOf('if (path === "/api/channels"', start);
  const block = source.slice(start, end);
  const paths = [...new Set([...block.matchAll(/path === "(\/patient\/[a-z-]+)"/g)].map((m) => m[1]))];
  assert.ok(paths.length >= 10, `expected the patient routes, got ${paths.length}`);

  for (const path of paths.filter((p) => p !== "/patient/authorities")) {
    const at = block.indexOf(`path === "${path}"`);
    const next = block.indexOf('path === "/patient/', at + path.length);
    const body = block.slice(at, next < 0 ? undefined : next);
    assert.match(body, /\bpatientPhi\(/, `${path} can serve a chart without checking its live authority grant`);
  }
});
