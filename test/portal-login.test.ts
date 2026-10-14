import { test } from "node:test";
import assert from "node:assert/strict";
import { PortalLogin } from "../src/auth/portal-login.ts";
import { portalFixture, beginLogin, finishLogin } from "./fixtures/portal-oidc.ts";

test("code + PKCE creates an HttpOnly session; existing patient authorization and audit remain authoritative", async () => {
  const f = await portalFixture();
  try {
    const signed = await finishLogin(f.base);
    assert.equal(signed.response.headers.get("location"), "/me");
    assert.ok(signed.info.authenticated);
    assert.match(signed.response.headers.getSetCookie().find(c => c.startsWith("northstar-session="))!, /HttpOnly; SameSite=Lax/);
    assert.ok(!JSON.stringify(signed.info).includes("access_token"));
    assert.equal(signed.session.split("=")[1].split(".").length, 1);
    const get = (path: string) => fetch(`${f.base}${path}`, { headers: { cookie: signed.session } });
    const results = await get("/patient/results?patient=PATIENT-A");
    assert.equal(results.status, 200);
    assert.equal(results.headers.get("cache-control"), "no-store");
    const body = await results.text(); assert.match(body, /4\.1/); assert.ok(!body.includes("SECRET-HELD-VALUE"));
    assert.equal((await get("/patient/results?patient=PATIENT-B")).status, 403);
    assert.equal((await get("/api/channels")).status, 401);
    assert.equal((await get("/fhir/Patient")).status, 401);
    const tenant = f.engine.forTenant("default");
    tenant.patientAccess.revoke(f.grant.id, { ...f.actor, reason: "patient revoked access" });
    assert.equal((await get("/patient/results?patient=PATIENT-A")).status, 403);
  } finally { await f.close(); }
});

test("cookie writes and logout require both the exact origin and session CSRF token", async () => {
  const f = await portalFixture();
  try {
    const signed = await finishLogin(f.base);
    const write = (origin?: string, csrf?: string, path = "/patient/thread-open") => fetch(`${f.base}${path}`, {
      method: "POST", headers: { cookie: signed.session, "content-type": "application/json", ...(origin ? { origin } : {}),
        ...(csrf ? { "x-northstar-csrf": csrf } : {}) }, body: JSON.stringify({ patient: "PATIENT-A", subject: "Follow-up", body: "A question for the clinic" }),
    });
    assert.equal((await write()).status, 403);
    assert.equal((await write("https://attacker.invalid", signed.info.csrf)).status, 403);
    assert.equal((await write(f.base, "wrong")).status, 403);
    const good = await write(f.base, signed.info.csrf);
    assert.ok(good.status < 300, await good.text());
    assert.equal((await write("https://attacker.invalid", signed.info.csrf, "/auth/portal/logout")).status, 403);
    const out = await write(f.base, signed.info.csrf, "/auth/portal/logout");
    assert.equal(out.status, 200); assert.match(out.headers.get("set-cookie")!, /Max-Age=0/);
    assert.equal((await fetch(`${f.base}/patient/authorities`, { headers: { cookie: signed.session } })).status, 401);
  } finally { await f.close(); }
});

for (const attack of ["missing-binding", "wrong-binding", "wrong-state", "duplicate-state", "wrong-issuer", "provider-error", "expired"] as const) {
  test(`login callback refuses ${attack} without exchanging a code`, async t => {
    const f = await portalFixture();
    try {
      const pending = await beginLogin(f.base);
      const url = new URL(pending.callback);
      if (attack === "wrong-state") url.searchParams.set("state", "wrong");
      if (attack === "duplicate-state") url.searchParams.append("state", url.searchParams.get("state")!);
      if (attack === "wrong-issuer") url.searchParams.set("iss", "https://attacker.invalid");
      if (attack === "provider-error") url.searchParams.set("error", "access_denied");
      if (attack === "expired") t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 301_000 });
      const binding = attack === "missing-binding" ? "" : attack === "wrong-binding" ? "northstar-login=wrong" : pending.binding;
      const response = await fetch(url, { redirect: "manual", headers: { cookie: binding } });
      assert.equal(response.headers.get("location"), "/me?signin=failed");
      assert.equal(f.exchanges, 0);
    } finally { t.mock.timers.reset(); await f.close(); }
  });
}

test("authorization callback is single-use and a successful login rotates the session", async () => {
  const f = await portalFixture();
  try {
    const first = await finishLogin(f.base);
    const replay = await fetch(first.callback, { redirect: "manual", headers: { cookie: first.binding } });
    assert.equal(replay.headers.get("location"), "/me?signin=failed"); assert.equal(f.exchanges, 1);
    const second = await beginLogin(f.base);
    const response = await fetch(second.callback, { redirect: "manual", headers: { cookie: `${second.binding}; ${first.session}` } });
    assert.equal(response.headers.get("location"), "/me");
    assert.equal((await fetch(`${f.base}/patient/authorities`, { headers: { cookie: first.session } })).status, 401);
  } finally { await f.close(); }
});

for (const claims of [{ nonce: "wrong" }, { aud: "another-client" }, { sub: "another-patient" }, { exp: null }, { iat: null },
  { aud: ["portal", "other"] }, { azp: "other" }, { at_hash: "wrong" }]) {
  test(`ID token binding refuses ${JSON.stringify(claims)}`, async () => {
    const f = await portalFixture({ idClaims: claims });
    try {
      const signed = await finishLogin(f.base);
      assert.equal(signed.response.headers.get("location"), "/me?signin=failed"); assert.equal(signed.info.authenticated, false);
    } finally { await f.close(); }
  });
}
for (const claims of [{ aud: "another-api" }, { exp: null }, { scope: "system/*.read" }, { sub: "" }]) {
  test(`access token binding refuses ${JSON.stringify(claims)}`, async () => {
    const f = await portalFixture({ accessClaims: claims });
    try { assert.equal((await finishLogin(f.base)).info.authenticated, false); } finally { await f.close(); }
  });
}
for (const options of [{ metadata: { issuer: "https://attacker.invalid" } }, { metadata: { code_challenge_methods_supported: ["plain"] } },
  { metadata: { token_endpoint: "http://attacker.invalid/token" } }]) {
  test(`discovery fails closed for ${JSON.stringify(options)}`, async () => {
    const f = await portalFixture(options);
    try { assert.equal((await fetch(`${f.base}/auth/portal/login`, { redirect: "manual" })).status, 503); }
    finally { await f.close(); }
  });
}
for (const options of [{ tokenError: true }, { tokenRedirect: true }]) {
  test(`provider failure cannot create a session or expose errors: ${JSON.stringify(options)}`, async () => {
    const f = await portalFixture(options);
    try {
      const signed = await finishLogin(f.base);
      assert.equal(signed.info.authenticated, false);
      assert.equal(signed.response.headers.get("location"), "/me?signin=failed");
      assert.ok(!(await signed.response.text()).includes("secret-provider-error"));
    } finally { await f.close(); }
  });
}
test("idle session expiry is enforced before patient authorization", async t => {
  const f = await portalFixture();
  try {
    const signed = await finishLogin(f.base);
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 901_000 });
    assert.equal((await fetch(`${f.base}/patient/authorities`, { headers: { cookie: signed.session } })).status, 401);
  } finally { t.mock.timers.reset(); await f.close(); }
});
test("absolute session expiry applies even while the patient remains active", async t => {
  const f = await portalFixture();
  try {
    const signed = await finishLogin(f.base);
    const initial = Date.now();
    t.mock.timers.enable({ apis: ["Date"], now: initial });
    for (const seconds of [600, 1200, 1800, 2400, 3000]) {
      t.mock.timers.setTime(initial + seconds * 1000);
      assert.equal((await fetch(`${f.base}/patient/authorities`, { headers: { cookie: signed.session } })).status, 200);
    }
    t.mock.timers.setTime(initial + 3601_000);
    assert.equal((await fetch(`${f.base}/patient/authorities`, { headers: { cookie: signed.session } })).status, 401);
  } finally { t.mock.timers.reset(); await f.close(); }
});
test("production configuration refuses HTTP and origin paths", () => {
  const config = { issuer: "https://issuer.example", origin: "https://portal.example", clientId: "portal", clientSecret: "secret", audience: "api", scopes: "openid patient/*.read" };
  assert.doesNotThrow(() => new PortalLogin(config));
  for (const change of [{ origin: "http://localhost" }, { origin: "https://portal.example/path" }, { issuer: "http://issuer.example" },
    { scopes: "openid offline_access" }, { clientSecret: "" }]) assert.throws(() => new PortalLogin({ ...config, ...change }));
});
