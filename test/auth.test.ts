import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { Engine } from "../src/core/engine.ts";
import { startApi } from "../src/api/admin.ts";
import { AuthGate } from "../src/auth/gate.ts";
import { JwtVerifier } from "../src/auth/jwt.ts";
import { requiredScope, scopesFromSmart } from "../src/auth/scopes.ts";

test("route scope map: public routes, admin surface, and read/write split", () => {
  assert.equal(requiredScope("GET", "/"), null);
  assert.equal(requiredScope("GET", "/ui"), null);
  assert.equal(requiredScope("GET", "/me"), null);
  assert.equal(requiredScope("GET", "/api/health"), null);
  assert.equal(requiredScope("GET", "/fhir/metadata"), null);

  assert.equal(requiredScope("GET", "/api/channels"), "admin");
  assert.equal(requiredScope("POST", "/api/channels"), "admin");
  assert.equal(requiredScope("GET", "/api/keys"), "admin");

  assert.equal(requiredScope("GET", "/fhir/Patient"), "read");
  assert.equal(requiredScope("GET", "/fhir/Patient/abc"), "read");
  assert.equal(requiredScope("POST", "/fhir/Patient"), "write");
  assert.equal(requiredScope("POST", "/ingest/lab"), "write");
  assert.equal(requiredScope("GET", "/patient/summary"), "patient");
  assert.equal(requiredScope("POST", "/patient/thread-open"), "patient");

  // Subscriptions are administration, not clinical traffic, in every verb.
  // This line previously read `write`, which is what a feed is given — so the
  // credential a lab uses to push results in could register a rest-hook of
  // its own and receive the facade's contents. The assertion held the hole
  // open rather than finding it.
  assert.equal(requiredScope("GET", "/fhir/Subscription"), "admin");
  assert.equal(requiredScope("POST", "/fhir/Subscription"), "admin");
  assert.equal(requiredScope("DELETE", "/fhir/Subscription/x"), "admin");
  assert.equal(requiredScope("GET", "/fhir/AuditEvent"), "admin");

  // An unrecognised path must default closed, not open.
  assert.equal(requiredScope("GET", "/something-new"), "admin");
});

test("SMART scopes translate, and admin implies read and write", () => {
  const read = scopesFromSmart(["system/Patient.read"]);
  assert.ok(read.has("read"));
  assert.ok(!read.has("write"));
  assert.ok(!read.has("admin"));

  // SMART v2 verb syntax.
  const v2 = scopesFromSmart(["system/Observation.rs"]);
  assert.ok(v2.has("read"));
  assert.ok(!v2.has("write"));

  const cud = scopesFromSmart(["system/Patient.cud"]);
  assert.ok(cud.has("write"));
  assert.ok(!cud.has("read"));

  const star = scopesFromSmart(["system/*.*"]);
  assert.ok(star.has("read") && star.has("write"));
  assert.ok(!star.has("admin"));

  const admin = scopesFromSmart(["portage/admin"]);
  assert.ok(admin.has("admin") && admin.has("read") && admin.has("write"));
  assert.ok(!admin.has("patient"), "an operator is not the patient");

  const patient = scopesFromSmart(["patient/*.rs"]);
  assert.ok(patient.has("patient"));
  assert.ok(!patient.has("read"), "patient context must never become read of the whole FHIR facade");
  assert.ok(!patient.has("write"));

  assert.equal(scopesFromSmart(["openid", "profile", "nonsense"]).size, 0);
});

test("api key gate: 401 without credentials, 403 without scope, 200 with", async () => {
  const engine = new Engine({ dbPath: ":memory:", tickMs: 15 });
  await engine.start();

  const readOnly = engine.keys.issue("reader", ["read"]);
  const operator = engine.keys.issue("operator", ["admin"]);

  const api = await startApi(engine, 0, "127.0.0.1", { auth: new AuthGate({ keys: engine.keys }) });
  const base = `http://127.0.0.1:${api.port}`;

  // Public routes stay reachable with no credentials at all.
  assert.equal((await fetch(`${base}/api/health`)).status, 200);
  assert.equal((await fetch(`${base}/fhir/metadata`)).status, 200);
  assert.equal((await fetch(`${base}/`)).status, 200);

  const bare = await fetch(`${base}/api/channels`);
  assert.equal(bare.status, 401);
  assert.match(bare.headers.get("www-authenticate") ?? "", /Bearer/);

  assert.equal((await fetch(`${base}/api/channels`, { headers: { authorization: "Bearer ptg_wrong" } })).status, 401);

  // A read key reaches the facade but not the admin surface.
  const denied = await fetch(`${base}/api/channels`, { headers: { authorization: `Bearer ${readOnly.key}` } });
  assert.equal(denied.status, 403);
  assert.match(((await denied.json()) as { error: string }).error, /scope 'admin' required/);

  assert.equal(
    (await fetch(`${base}/fhir/Patient`, { headers: { authorization: `Bearer ${readOnly.key}` } })).status,
    200
  );
  // ...and cannot write.
  assert.equal(
    (
      await fetch(`${base}/fhir/Patient`, {
        method: "POST",
        headers: { authorization: `Bearer ${readOnly.key}`, "content-type": "application/fhir+json" },
        body: JSON.stringify({ resourceType: "Patient" }),
      })
    ).status,
    403
  );

  // The operator key works, and X-API-Key is accepted alongside Bearer.
  assert.equal(
    (await fetch(`${base}/api/channels`, { headers: { authorization: `Bearer ${operator.key}` } })).status,
    200
  );
  assert.equal((await fetch(`${base}/api/channels`, { headers: { "x-api-key": operator.key } })).status, 200);

  // admin implies write.
  assert.equal(
    (await fetch(`${base}/ingest/nothing-here`, { method: "POST", headers: { "x-api-key": operator.key }, body: "x" }))
      .status,
    404
  );

  await api.close();
  await engine.stop();
});

test("keys are stored hashed, revocation takes effect immediately", async () => {
  const engine = new Engine({ dbPath: ":memory:", tickMs: 15 });
  await engine.start();

  const issued = engine.keys.issue("temp", ["admin"]);
  assert.match(issued.key, /^ptg_/);

  // The plaintext key must not be recoverable from storage.
  const stored = engine.db.listApiKeys();
  assert.equal(stored.length, 1);
  assert.notEqual(stored[0].hash, issued.key);
  assert.ok(!JSON.stringify(engine.keys.list()).includes(issued.key));

  assert.ok(engine.keys.verify(issued.key));
  assert.equal(engine.keys.verify("ptg_not-a-real-key"), null);
  assert.throws(
    () => engine.keys.issue("not-a-person", ["patient"]),
    /requires an OAuth identity/,
    "a copied service secret cannot be minted as a patient's identity"
  );

  assert.equal(engine.keys.revoke(issued.id), true);
  assert.equal(engine.keys.verify(issued.key), null, "a revoked key must stop working at once");
  assert.equal(engine.keys.revoke(issued.id), false, "revoking twice is not a change");

  await engine.stop();
});

test("gate with no scheme configured is inert, so embedding startApi stays open by choice", async () => {
  const gate = new AuthGate();
  assert.equal(gate.enabled, false);
  const outcome = await gate.check("GET", "/api/channels", {});
  assert.equal(outcome.ok, true);
});

/* ------------------------------- OAuth 2.0 ------------------------------- */

/** Mints an RS256 JWT and serves the matching JWKS, standing in for an IdP. */
async function fakeIdp(): Promise<{
  issuer: string;
  sign(claims: Record<string, unknown>): string;
  close(): Promise<void>;
  jwksHits(): number;
}> {
  // generateKeyPairSync returns KeyObjects when no encoding is given, so they
  // feed straight into sign()/export() with no PEM round trip.
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "test-key", alg: "RS256", use: "sig" };
  let hits = 0;

  const server = createServer((req, res) => {
    if (req.url === "/.well-known/openid-configuration") {
      const body = JSON.stringify({ issuer, jwks_uri: `${issuer}/jwks` });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(body);
      return;
    }
    if (req.url === "/jwks") {
      hits++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    res.writeHead(404).end();
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const issuer = `http://127.0.0.1:${port}`;

  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

  return {
    issuer,
    sign(claims) {
      const header = b64({ alg: "RS256", kid: "test-key", typ: "JWT" });
      const payload = b64({ iss: issuer, exp: Math.floor(Date.now() / 1000) + 300, ...claims });
      const sig = cryptoSign("sha256", Buffer.from(`${header}.${payload}`), privateKey);
      return `${header}.${payload}.${sig.toString("base64url")}`;
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
    jwksHits: () => hits,
  };
}

test("oauth bearer tokens: discovery, signature, claims, and scope mapping", async () => {
  const idp = await fakeIdp();
  const verifier = new JwtVerifier({ issuer: idp.issuer, audience: "portage" });

  const good = idp.sign({ sub: "svc-lab", aud: "portage", scope: "system/Patient.read system/Patient.write" });
  const v = await verifier.verify(good);
  assert.equal(v.subject, "svc-lab");
  assert.ok(v.scopes.has("read") && v.scopes.has("write"));
  assert.ok(!v.scopes.has("admin"));

  // The JWKS is cached: a second token does not refetch.
  const before = idp.jwksHits();
  await verifier.verify(idp.sign({ sub: "svc-lab", aud: "portage", scope: "system/Patient.read" }));
  assert.equal(idp.jwksHits(), before, "JWKS should be served from cache");

  await assert.rejects(
    () => verifier.verify(idp.sign({ sub: "x", aud: "someone-else", scope: "system/Patient.read" })),
    /audience mismatch/
  );
  await assert.rejects(
    () => verifier.verify(idp.sign({ sub: "x", aud: "portage", exp: Math.floor(Date.now() / 1000) - 3600 })),
    /token expired/
  );
  await assert.rejects(
    () => new JwtVerifier({ issuer: "http://elsewhere.invalid", jwksUri: `${idp.issuer}/jwks` }).verify(good),
    /issuer mismatch/
  );

  // A tampered payload must fail the signature check, not merely the claims.
  const [h, , s] = good.split(".");
  const forged = Buffer.from(JSON.stringify({ iss: idp.issuer, aud: "portage", sub: "attacker", scope: "portage/admin", exp: Math.floor(Date.now() / 1000) + 300 })).toString("base64url");
  await assert.rejects(() => verifier.verify(`${h}.${forged}.${s}`), /signature verification failed/);

  // alg:none must never reach a key.
  const noneHeader = Buffer.from(JSON.stringify({ alg: "none", kid: "test-key" })).toString("base64url");
  await assert.rejects(() => verifier.verify(`${noneHeader}.${forged}.`), /malformed token|unsupported alg/);

  await idp.close();
});

test("oauth end to end through the API gate", async () => {
  const idp = await fakeIdp();
  const engine = new Engine({ dbPath: ":memory:", tickMs: 15 });
  await engine.start();

  const gate = new AuthGate({ jwt: new JwtVerifier({ issuer: idp.issuer, audience: "portage" }) });
  const api = await startApi(engine, 0, "127.0.0.1", { auth: gate });
  const base = `http://127.0.0.1:${api.port}`;

  const readToken = idp.sign({ sub: "consumer", aud: "portage", scope: "system/Patient.read" });
  const adminToken = idp.sign({ sub: "operator", aud: "portage", scope: "portage/admin" });

  assert.equal((await fetch(`${base}/api/channels`)).status, 401);
  assert.equal(
    (await fetch(`${base}/fhir/Patient`, { headers: { authorization: `Bearer ${readToken}` } })).status,
    200
  );
  assert.equal(
    (await fetch(`${base}/api/channels`, { headers: { authorization: `Bearer ${readToken}` } })).status,
    403
  );
  assert.equal(
    (await fetch(`${base}/api/channels`, { headers: { authorization: `Bearer ${adminToken}` } })).status,
    200
  );

  await api.close();
  await engine.stop();
  await idp.close();
});
