/** Real Chromium journey against the ordinary OIDC client, API, and clinical stores. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { portalFixture } from "./fixtures/portal-oidc.ts";

const chrome = [process.env.NORTHSTAR_TEST_CHROME,
  "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
].find((p): p is string => !!p && existsSync(p));

test("browser: clinic login, held result, message delivery, scoped caregiver chart, revocation and logout", {
  timeout: 90_000,
  skip: !chrome && !process.env.NORTHSTAR_REQUIRE_BROWSER ? "Chromium not installed; set NORTHSTAR_TEST_CHROME" : false,
}, async () => {
  assert.ok(chrome, "CI requires a real Chromium browser");
  const f = await portalFixture();
  const profile = mkdtempSync(join(tmpdir(), "northstar-portal-browser-"));
  const child = spawn(chrome, ["--headless=new", "--remote-debugging-port=0", "--no-sandbox", "--disable-gpu",
    "--disable-dev-shm-usage", "--no-first-run", "--no-default-browser-check", `--user-data-dir=${profile}`, "about:blank"],
    { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  let ws: WebSocket | undefined;
  let seq = 0;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  try {
    const endpoint = await new Promise<string>((resolve, reject) => {
      let output = "";
      const timeout = setTimeout(() => reject(new Error(`Chromium did not start: ${output.slice(-1500)}`)), 20_000);
      child.once("error", err => { clearTimeout(timeout); reject(err); });
      child.stderr!.on("data", chunk => {
        output += chunk.toString();
        const match = /ws:\/\/[^\s]+/.exec(output);
        if (match) { clearTimeout(timeout); resolve(match[0]); }
      });
    });
    ws = new WebSocket(endpoint);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("DevTools connection timed out")), 10_000);
      ws!.onopen = () => { clearTimeout(timeout); resolve(); };
      ws!.onerror = () => { clearTimeout(timeout); reject(new Error("DevTools connection failed")); };
    });
    ws.onmessage = event => {
      const msg = JSON.parse(String(event.data));
      const request = pending.get(msg.id);
      if (!request) return;
      pending.delete(msg.id); clearTimeout(request.timer);
      if (msg.error) request.reject(new Error(JSON.stringify(msg.error))); else request.resolve(msg.result);
    };
    const cdp = (method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> => new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`DevTools timeout: ${method}`)); }, 10_000);
      pending.set(id, { resolve, reject, timer });
      ws!.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
    const target = await cdp("Target.createTarget", { url: "about:blank" });
    const attached = await cdp("Target.attachToTarget", { targetId: target.targetId, flatten: true });
    const session = attached.sessionId;
    const evaluate = async (expression: string) => {
      const result = await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, session);
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    const wait = async (expression: string) => {
      const start = Date.now();
      while (Date.now() - start < 15_000) {
        try { if (await evaluate(expression)) return; } catch { /* navigation changes execution context */ }
        await new Promise(r => setTimeout(r, 75));
      }
      throw new Error(`Browser condition failed: ${expression}\n${await evaluate("document.body.innerText")}`);
    };
    await cdp("Page.enable", {}, session);
    await cdp("Runtime.enable", {}, session);
    await cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }, session);
    await cdp("Page.navigate", { url: `${f.base}/me` }, session);
    await wait("!!document.querySelector('a[href=\"/auth/portal/login\"]')");
    assert.equal(await evaluate("!!document.getElementById('tok')"), false, "production UI must not ask patients for access tokens");
    await evaluate("document.querySelector('a[href=\"/auth/portal/login\"]').click()");
    await wait("document.getElementById('whoName').textContent === 'PATIENT-A' && document.body.innerText.includes('4.1')");
    assert.equal(await evaluate("document.body.innerText.includes('SECRET-HELD-VALUE')"), false);
    assert.equal(await evaluate("sessionStorage.getItem('ns.token')"), null);
    assert.equal(await evaluate("document.cookie.includes('northstar-session')"), false, "session must be HttpOnly");
    assert.equal(await evaluate("location.search + location.hash"), "");
    await evaluate("document.querySelector('a[href=\"#/messages\"]').click()");
    await wait("!!document.getElementById('subj')");
    await evaluate("document.getElementById('subj').value='Browser follow-up'; document.getElementById('body').value='Please call about my appointment'; document.getElementById('subj').form.requestSubmit()");
    await wait("Array.from(document.querySelectorAll('#view button.link')).some(b => b.textContent === 'Browser follow-up')");
    const tenant = f.engine.forTenant("default");
    const threads = tenant.messaging.forPatient("PATIENT-A");
    assert.equal(threads.length, 1);
    assert.equal(tenant.messaging.messages(threads[0].id)[0].body, "Please call about my appointment");

    const proxy = tenant.patientAccess.grantProxy({ patientId: "PATIENT-B", subjectId: "synthetic-patient", relationship: "representative",
      permissions: ["appointments"], purpose: "transport to appointments", expiresAt: new Date(Date.now() + 86400_000).toISOString(), by: f.actor });
    await cdp("Page.navigate", { url: `${f.base}/me` }, session);
    await wait("Array.from(document.querySelectorAll('#view button')).some(b => b.textContent === 'PATIENT-B')");
    await evaluate("Array.from(document.querySelectorAll('#view button')).find(b => b.textContent === 'PATIENT-A').click()");
    await wait("document.body.innerText.includes('4.1')");
    // Delay parsing a real HTTP response, then switch charts. An older response
    // must not paint patient A's results under patient B's identity banner.
    await evaluate("window.originalFetch=window.fetch; window.fetch=async (...args)=>{const r=await window.originalFetch(...args); if(String(args[0]).includes('/patient/results?patient=PATIENT-A')){const parse=r.json.bind(r); r.json=async()=>{const body=await parse(); window.responseHeld=true; await new Promise(resolve=>window.releaseResponse=resolve); return body;};} return r;}");
    await evaluate("document.querySelector('a[href=\"#/messages\"]').click()");
    await wait("!!document.getElementById('subj')");
    await evaluate("document.querySelector('a[href=\"#/results\"]').click()");
    await wait("window.responseHeld === true");
    await evaluate("document.getElementById('switch').click()");
    await wait("Array.from(document.querySelectorAll('#view button')).some(b => b.textContent === 'PATIENT-B')");
    await evaluate("Array.from(document.querySelectorAll('#view button')).find(b => b.textContent === 'PATIENT-B').click()");
    await wait("document.getElementById('whoName').textContent === 'PATIENT-B' && !document.getElementById('nav').hidden");
    assert.equal(await evaluate("!!document.querySelector('a[href=\"#/results\"]')"), false);
    await evaluate("window.releaseResponse(); window.fetch=window.originalFetch; new Promise(r=>setTimeout(r,200))");
    assert.equal(await evaluate("document.body.innerText.includes('4.1')"), false, "late response from another chart must be discarded");
    const denied = await evaluate("fetch('/patient/results?patient=PATIENT-A-does-not-exist').then(r=>r.status)");
    assert.equal(denied, 403);
    tenant.patientAccess.revoke(proxy.id, { ...f.actor, reason: "caregiver access withdrawn" });
    await cdp("Page.reload", {}, session);
    await wait("document.getElementById('whoName').textContent === 'PATIENT-A' && document.body.innerText.includes('4.1')");
    await evaluate("document.getElementById('signout').click()");
    await wait("!!document.querySelector('a[href=\"/auth/portal/login\"]')");
    assert.equal(await evaluate("fetch('/patient/authorities').then(r=>r.status)"), 401);
    assert.equal(await evaluate("document.body.innerText.includes('4.1')"), false);
  } finally {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: ++seq, method: "Browser.close" }));
    await Promise.race([new Promise<void>(r => child.once("exit", () => r())), new Promise<void>(r => setTimeout(r, 3000))]);
    for (const req of pending.values()) { clearTimeout(req.timer); req.reject(new Error("browser closing")); }
    ws?.close();
    if (child.exitCode === null) child.kill();
    await f.close();
    // Only this test's freshly allocated profile, never the user's browser profile.
    assert.ok(resolve(profile).startsWith(resolve(tmpdir()) + "/") || resolve(profile).startsWith(resolve(tmpdir()) + "\\"));
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
    catch { console.warn(`Temporary browser profile retained: ${profile}`); }
  }
});
