import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine } from "../src/core/engine.ts";
import { AdminAccounts } from "../src/auth/admin-accounts.ts";
import { AuthGate } from "../src/auth/gate.ts";
import { startApi } from "../src/api/admin.ts";
import { browserSkip, launchBrowser } from "./fixtures/browser.ts";

async function fixture() {
  const engine = new Engine({ dbPath: ":memory:", tickMs: 100000 });
  await engine.start();
  const accounts = new AdminAccounts(engine.db.sql);
  accounts.create("browser-admin@example.test", "Synthetic-password-123");
  const api = await startApi(engine, 0, "127.0.0.1", {
    auth: new AuthGate({ keys: engine.keys, tenants: engine.db, adminAccounts: accounts }),
    adminAccounts: accounts, rateLimit: { enabled: false },
  });
  return { engine, base: `http://127.0.0.1:${api.port}`, close: async () => { await api.close(); await engine.stop(); } };
}

test("admin journey: sign-in, key generation, five menus, mobile workspace and logout", { skip: browserSkip(), timeout: 90000 }, async () => {
  const f = await fixture(), b = await launchBrowser();
  try {
    await b.navigate(f.base + "/ui");
    await b.wait("location.pathname === '/login' && !!document.getElementById('login-form')");
    await b.evaluate(`{const f=document.getElementById('login-form');f.email.value='browser-admin@example.test';f.password.value='wrong';f.requestSubmit()}`);
    await b.wait("document.getElementById('feedback').textContent.includes('incorrect')");
    await b.evaluate(`{const f=document.getElementById('login-form');f.password.value='Synthetic-password-123';f.requestSubmit()}`);
    await b.wait("!!document.getElementById('setup-generate')");
    assert.equal(await b.evaluate("document.getElementById('continue-workspace').disabled"), true);
    assert.equal(await b.evaluate("document.body.innerText.includes('browser-admin@example.test')"), false);
    await b.evaluate("document.getElementById('setup-generate').click()");
    await b.wait("!!document.getElementById('generated-secret')");
    const key = await b.evaluate("document.getElementById('generated-secret').textContent");
    assert.match(key, /^ptg_/);
    assert.equal((await fetch(f.base + "/fhir/Patient", { headers: { authorization: "Bearer " + key } })).status, 200);
    assert.equal((await fetch(f.base + "/api/keys", { headers: { authorization: "Bearer " + key } })).status, 403);
    assert.equal(f.engine.keys.list().length, 1);
    await b.evaluate("document.getElementById('continue-workspace').click()");
    await b.wait("document.documentElement.dataset.workspaceReady === 'yes' && document.body.innerText.includes('System overview')");
    assert.equal(await b.evaluate("document.querySelectorAll('#nav>details').length"), 5);
    for (const width of [1440, 390]) {
      await b.cdp("Emulation.setDeviceMetricsOverride", { width, height: 1000, deviceScaleFactor: 1, mobile: width === 390 });
      assert.equal(await b.evaluate("document.documentElement.scrollWidth <= innerWidth"), true);
      await b.evaluate("document.querySelector('#nav>details:last-child').open=true;document.querySelector('[data-tab=\"API keys\"]').click()");
      await b.wait("document.body.innerText.includes('Issued keys')");
      assert.equal(await b.evaluate("document.body.innerText.includes('browser-admin@example.test')"), false);
      assert.equal(await b.evaluate("document.documentElement.scrollWidth <= innerWidth"), true);
      await b.evaluate("go('Dashboard')");
      await b.wait("document.body.innerText.includes('System overview')");
    }
    await b.reload();
    await b.wait("document.documentElement.dataset.workspaceReady === 'yes'");
    await b.evaluate("document.getElementById('sign-out').click()");
    await b.wait("location.pathname === '/login'");
    assert.equal(await b.evaluate("fetch('/api/keys').then(r=>r.status)"), 401);
  } finally { await b.close(); await f.close(); }
});

test("public contact journey keeps addresses out of text and HTML and prefills email on demand", { skip: browserSkip(), timeout: 90000 }, async () => {
  const f = await fixture(), b = await launchBrowser();
  try {
    const emailPattern = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
    for (const path of ["/", "/contact", "/privacy", "/terms", "/login"]) {
      await b.navigate(f.base + path);
      await b.wait("!!document.querySelector('h1')");
      assert.doesNotMatch(await b.evaluate("document.body.innerText"), emailPattern);
      assert.match(await b.evaluate("document.title"), /HealthSystem/);
      assert.match(await b.evaluate("document.body.innerText"), /HealthSystem/);
      assert.doesNotMatch(await b.evaluate("document.body.innerText"), /northstar|HealthSystems/i);
      for (const width of [1440, 390]) {
        await b.cdp("Emulation.setDeviceMetricsOverride", { width, height: 1000, deviceScaleFactor: 1, mobile: width === 390 });
        assert.equal(await b.evaluate("document.documentElement.scrollWidth <= innerWidth"), true, `${path} fits at ${width}`);
      }
      const html = await (await fetch(f.base + path)).text();
      assert.doesNotMatch(html, emailPattern);
      assert.ok(!html.includes("mailto:"));
    }
    await b.navigate(f.base + "/contact");
    const buttons = await b.evaluate("Array.from(document.querySelectorAll('a[href^=\"/contact/email\"]')).map(a=>({text:a.textContent,href:a.getAttribute('href')}))") as Array<{text:string;href:string}>;
    assert.equal(buttons.length, 3);
    for (const button of buttons) {
      assert.ok(button.text.trim());
      const r = await fetch(f.base + button.href, { redirect: "manual" });
      assert.equal(r.status, 303);
      assert.match(r.headers.get("location")!, /^mailto:[^?]+\?subject=HealthSystem%20/);
      assert.equal(r.headers.get("cache-control"), "no-store");
      assert.equal(r.headers.get("x-robots-tag"), "noindex, nofollow");
    }
    assert.equal((await fetch(f.base + "/contact/email?topic=https://evil.example", { redirect: "manual" })).status, 400);
  } finally { await b.close(); await f.close(); }
});


for (const oldBrand of ["healthsystems", "northstar"]) test(`existing ${oldBrand} browser API keys migrate to HealthSystem and sign-out clears legacy credentials`, { skip: browserSkip(), timeout: 90000 }, async () => {
  const f = await fixture(), b = await launchBrowser();
  try {
    const issued = f.engine.keys.issue("migration-admin", ["admin"]);
    await b.navigate(f.base + "/login");
    await b.evaluate(`localStorage.setItem('${oldBrand}.apikey',${JSON.stringify(issued.key)})`);
    await b.navigate(f.base + "/ui");
    await b.wait("document.documentElement.dataset.workspaceReady === 'yes'");
    assert.equal(await b.evaluate("localStorage.getItem('healthsystem.apikey')"), issued.key);
    assert.equal(await b.evaluate(`localStorage.getItem('${oldBrand}.apikey')`), null);
    assert.match(await b.evaluate("document.title"), /HealthSystem/);
    assert.doesNotMatch(await b.evaluate("document.body.innerText"), /northstar|HealthSystems/i);
    await b.evaluate(`localStorage.setItem('northstar.apikey',${JSON.stringify(issued.key)});localStorage.setItem('portage.apikey',${JSON.stringify(issued.key)})`);
    await b.evaluate("document.getElementById('sign-out').click()");
    await b.wait("location.pathname === '/login'");
    assert.equal(await b.evaluate("['healthsystem.','healthsystems.','northstar.','portage.'].every(p=>localStorage.getItem(p+'apikey')===null)"), true);
    await b.navigate(f.base + "/ui");
    await b.wait("location.pathname === '/login'");
  } finally { await b.close(); await f.close(); }
});
