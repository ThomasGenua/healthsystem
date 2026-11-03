import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine } from "../src/core/engine.ts";
import { AdminAccounts } from "../src/auth/admin-accounts.ts";
import { AuthGate } from "../src/auth/gate.ts";
import { startApi } from "../src/api/admin.ts";

const EMAIL = "operator@example.test", PASSWORD = "A-test-password-123";
async function boot() {
  const engine = new Engine({ dbPath: ":memory:" });
  await engine.start();
  const accounts = new AdminAccounts(engine.db.sql);
  accounts.create(EMAIL, PASSWORD);
  const gate = new AuthGate({ keys: engine.keys, tenants: engine.db, adminAccounts: accounts });
  const api = await startApi(engine, 0, "127.0.0.1", { auth: gate, adminAccounts: accounts });
  const base = `http://127.0.0.1:${api.port}`;
  const login = () => fetch(base + "/auth/admin/login", { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }) });
  return { engine, accounts, base, login, close: async () => { await api.close(); await engine.stop(); } };
}

test("admin sign-in, key setup, CSRF, logout, and old API keys work together", async () => {
  const x = await boot();
  try {
    assert.equal((await fetch(x.base + "/api/keys")).status, 401);
    const r = await x.login();
    assert.equal(r.status, 200);
    const cookie = r.headers.get("set-cookie")!;
    assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/);
    const credential = cookie.split(";")[0];
    const status = await r.json() as { csrf: string; activeKeys: number };
    assert.equal(status.activeKeys, 0);
    assert.equal((await fetch(x.base + "/api/keys", { headers: { cookie: credential } })).status, 200);
    const issue = (headers: Record<string,string>) => fetch(x.base + "/api/keys", { method: "POST", headers: { cookie: credential, "content-type": "application/json", ...headers }, body: JSON.stringify({ name: "test", scopes: ["admin"] }) });
    assert.equal((await issue({})).status, 403);
    assert.equal((await issue({ authorization: "Basic malformed" })).status, 403);
    assert.equal((await issue({ "x-csrf-token": status.csrf, origin: "https://evil.example" })).status, 403);
    const issued = await issue({ "x-csrf-token": status.csrf, origin: x.base });
    assert.equal(issued.status, 201);
    const key = (await issued.json() as { key: string }).key;
    assert.match(key, /^ptg_/);
    const s = await (await fetch(x.base + "/auth/admin/session", { headers: { cookie: credential } })).json() as { activeKeys: number };
    assert.equal(s.activeKeys, 1);
    const list = await (await fetch(x.base + "/api/keys", { headers: { authorization: "Bearer " + key } })).json() as Array<Record<string,unknown>>;
    assert.equal(list.length, 1); assert.equal(list[0].hash, undefined); assert.equal(list[0].key, undefined);
    assert.equal((await fetch(x.base + "/patient/authorities", { headers: { cookie: credential } })).status, 403);
    const logout = await fetch(x.base + "/auth/admin/logout", { method: "POST", headers: { cookie: credential, "x-csrf-token": status.csrf, origin: x.base } });
    assert.equal(logout.status, 200);
    assert.equal((await fetch(x.base + "/api/keys", { headers: { cookie: credential } })).status, 401);
    assert.equal((await fetch(x.base + "/api/keys", { headers: { authorization: "Bearer " + key } })).status, 200);
    const user = x.engine.db.sql.prepare("SELECT * FROM admin_users").get()!;
    assert.notEqual(user.password_hash, PASSWORD); assert.equal(user.password, undefined);
  } finally { await x.close(); }
});

test("sessions expire and disabled administrator accounts lose access", async () => {
  const x = await boot();
  try {
    const first = await x.login(), cookie = first.headers.get("set-cookie")!.split(";")[0];
    x.engine.db.sql.prepare("UPDATE admin_sessions SET expires_at=0").run();
    assert.equal((await fetch(x.base + "/api/keys", { headers: { cookie } })).status, 401);
    const second = await x.login(), next = second.headers.get("set-cookie")!.split(";")[0];
    x.engine.db.sql.prepare("UPDATE admin_users SET active=0").run();
    assert.equal((await fetch(x.base + "/api/keys", { headers: { cookie: next } })).status, 401);
  } finally { await x.close(); }
});

test("public pages contain no credentials and receive CSP; login is rate limited", async () => {
  const x = await boot();
  try {
    for (const path of ["/", "/login", "/privacy", "/terms", "/contact"]) {
      const r = await fetch(x.base + path); assert.equal(r.status, 200);
      assert.match(r.headers.get("content-security-policy")!, /script-src 'nonce-/);
      const html = await r.text(); assert.ok(!html.includes(PASSWORD));
    }
    const badOrigin = await fetch(x.base + "/auth/admin/login", { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example" }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }) });
    assert.equal(badOrigin.status, 403);
    for (let i = 0; i < 10; i++) {
      const r = await fetch(x.base + "/auth/admin/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: EMAIL, password: "wrong" }) });
      assert.equal(r.status, 401);
    }
    assert.equal((await x.login()).status, 429);
  } finally { await x.close(); }
});

test("administrator sessions and key setup stay inside the stored tenant", async () => {
  const x = await boot();
  try {
    x.engine.db.createTenant("second", "Second clinic");
    x.accounts.create("second@example.test", PASSWORD, "second");
    x.engine.keys.issue("default-admin", ["admin"]);
    const r = await fetch(x.base + "/auth/admin/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "second@example.test", password: PASSWORD }) });
    assert.equal(r.status, 200);
    const setup = await r.json() as { activeKeys: number };
    assert.equal(setup.activeKeys, 0, "another tenant's key does not complete setup");
    const cookie = r.headers.get("set-cookie")!.split(";")[0];
    const list = await (await fetch(x.base + "/api/keys", { headers: { cookie, "x-tenant-id": "default" } })).json();
    assert.deepEqual(list, []);
    x.engine.db.sql.prepare("UPDATE tenants SET status='suspended' WHERE id='second'").run();
    assert.equal((await fetch(x.base + "/api/keys", { headers: { cookie } })).status, 403);
  } finally { await x.close(); }
});


test("legacy admin sessions survive the rebrand and logout revokes both cookie names", async () => {
  const x = await boot();
  try {
    const first = await x.login();
    const old = first.headers.get("set-cookie")!.split(";")[0].replace("healthsystems_admin=", "northstar_admin=");
    const oldStatus = await first.json() as { csrf: string };
    assert.equal((await fetch(x.base + "/api/keys", { headers: { cookie: old } })).status, 200);
    const second = await x.login();
    const current = second.headers.get("set-cookie")!.split(";")[0];
    assert.match(current, /^healthsystems_admin=/);
    const metrics = await (await fetch(x.base + "/metrics", { headers: { cookie: current } })).text();
    for (const prefix of ["healthsystems", "northstar", "portage"]) assert.match(metrics, new RegExp(`^${prefix}_channels 0$`, "m"));
    const status = await second.json() as { csrf: string };
    const combined = current + "; " + old;
    assert.equal((await fetch(x.base + "/auth/admin/logout", { method: "POST", headers: { cookie: combined, origin: x.base, "x-csrf-token": oldStatus.csrf } })).status, 403);
    const logout = await fetch(x.base + "/auth/admin/logout", { method: "POST", headers: { cookie: combined, origin: x.base, "x-csrf-token": status.csrf } });
    assert.equal(logout.status, 200);
    assert.match(logout.headers.get("set-cookie")!, /northstar_admin=;/);
    assert.match(logout.headers.get("set-cookie")!, /healthsystems_admin=;/);
    for (const cookie of [old, current]) assert.equal((await fetch(x.base + "/api/keys", { headers: { cookie } })).status, 401);
  } finally { await x.close(); }
});
