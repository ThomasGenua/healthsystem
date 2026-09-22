/** Real Chromium journey against the ordinary OIDC client, API, and clinical stores. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { portalFixture } from "./fixtures/portal-oidc.ts";
import { browserSkip, launchBrowser } from "./fixtures/browser.ts";

test("browser: clinic login, held result, message delivery, scoped caregiver chart, revocation and logout", {
  timeout: 90_000,
  skip: browserSkip(),
}, async () => {
  const f = await portalFixture();
  const b = await launchBrowser();
  const { evaluate, wait } = b;
  try {
    await b.navigate(`${f.base}/me`);
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
    await b.navigate(`${f.base}/me`);
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
    await b.reload();
    await wait("document.getElementById('whoName').textContent === 'PATIENT-A' && document.body.innerText.includes('4.1')");
    await evaluate("document.getElementById('signout').click()");
    await wait("!!document.querySelector('a[href=\"/auth/portal/login\"]')");
    assert.equal(await evaluate("fetch('/patient/authorities').then(r=>r.status)"), 401);
    assert.equal(await evaluate("document.body.innerText.includes('4.1')"), false);
  } finally {
    await b.close();
    await f.close();
  }
});
