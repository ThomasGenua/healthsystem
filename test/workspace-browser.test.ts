import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { Engine } from '../src/core/engine.ts';
import { startApi } from '../src/api/admin.ts';
import { portalFixture } from './fixtures/portal-oidc.ts';
import { browserSkip, launchBrowser } from './fixtures/browser.ts';

test('arrangements workspace distinguishes outstanding, withheld, failed and empty data', { skip: browserSkip(), timeout: 90_000 }, async () => {
  const engine = new Engine({ dbPath: ':memory:', tickMs: 15 });
  await engine.start();
  const api = await startApi(engine, 0, '127.0.0.1');
  const b = await launchBrowser();
  try {
    const tenant = engine.forTenant('default');
    const by = { actorId: 'test-clerk', actorKind: 'practitioner' };
    const visit = tenant.clinics.planVisit({ resourceId: 'test-doctor', service: 'Clinic', community: 'Test community', days: [{ date: '2026-12-01', from: '09:00', to: '12:00' }], slotMinutes: 30, by }).visit;
    const visible = tenant.arrangements.request({ visitId: visit.id, patientId: 'PATIENT-A', kind: 'transport', detail: '<img src=x onerror="window.injected=true"> Accessible vehicle needed', by });
    tenant.arrangements.request({ visitId: visit.id, patientId: 'PRIVATE-PATIENT', kind: 'interpreter', detail: 'SECRET ARRANGEMENT', by });
    tenant.consent.record({ patientId: 'PRIVATE-PATIENT', kind: 'withhold-all', by });
    const confirmed = tenant.arrangements.request({ visitId: visit.id, kind: 'equipment', detail: 'Already arranged', by });
    tenant.arrangements.confirm(confirmed.id, { evidence: 'Synthetic confirmation', by });
    const base = `http://127.0.0.1:${api.port}`;
    const result = await (await fetch(base + '/api/clinical/arrangements-outstanding')).json() as any;
    assert.equal(result.rows.length, 1); assert.equal(result.withheldCount, 1);
    assert.ok(!JSON.stringify(result).includes('PRIVATE-PATIENT'));
    for (const width of [1440, 390]) {
      await b.cdp('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: width === 390 });
      await b.navigate(base + '/ui');
      await b.wait('document.documentElement.dataset.workspaceReady === "yes"');
      await b.evaluate('go("Arrangements")');
      await b.wait('document.body.innerText.includes("Accessible vehicle needed")');
      assert.ok(await b.evaluate('document.body.innerText.includes("This list is incomplete")'));
      assert.equal(await b.evaluate('document.body.innerText.includes("SECRET ARRANGEMENT")'), false);
      assert.equal(await b.evaluate('!!window.injected || !!document.querySelector(".arrangements img")'), false);
      assert.equal(await b.evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
      if (process.env.HEALTHSYSTEMS_WORKSPACE_SCREENSHOTS === 'on') {
        mkdirSync('.pilot-artifacts/workspace', { recursive: true });
        const shot = await b.cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
        writeFileSync(`.pilot-artifacts/workspace/console-${width}.png`, Buffer.from(shot.data, 'base64'));
      }
    }
    await b.evaluate(`{document.querySelector('.arrangements details').open=true;const form=document.querySelector('form[data-operation=assign]');form.elements.value.value='nurse-2';form.requestSubmit()}`);
    await b.wait("document.body.innerText.includes('Responsibility assigned.')");
    assert.equal(tenant.arrangements.get(visible.id)!.owner_id, 'nurse-2');
    if (process.env.HEALTHSYSTEMS_WORKSPACE_SCREENSHOTS === 'on') {
      const shot = await b.cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      writeFileSync('.pilot-artifacts/workspace/arrangement-actions.png', Buffer.from(shot.data, 'base64'));
    }
    await b.evaluate(`{window.originalFetch=window.fetch;window.fetch=async()=>new Response(JSON.stringify({error:'Synthetic save outage'}),{status:503});const form=document.querySelector('form[data-operation=confirm]');form.elements.value.value='Confirmed by synthetic transport desk';form.requestSubmit()}`);
    await b.wait("document.body.innerText.includes('Synthetic save outage')");
    assert.equal(await b.evaluate("document.querySelector('form[data-operation=confirm]').elements.value.value"), 'Confirmed by synthetic transport desk');
    assert.equal(tenant.arrangements.get(visible.id)!.status, 'needed');
    await b.evaluate(`{window.posts=0;window.fetch=(...args)=>{if(args[1]?.method==='POST')window.posts++;return window.originalFetch(...args)};const form=document.querySelector('form[data-operation=confirm]');form.requestSubmit();form.requestSubmit()}`);
    await b.wait("document.body.innerText.includes('Confirmation saved.')");
    assert.equal(await b.evaluate('window.posts'), 1, 'a double submit issues one mutation');
    assert.equal(tenant.arrangements.get(visible.id)!.confirmation_evidence, 'Confirmed by synthetic transport desk');
    assert.equal(await b.evaluate("document.querySelector('[data-arrangement-count]').dataset.arrangementCount"), '0');
    await b.evaluate('window.fetch=window.originalFetch;go("Clinic board")');
    await b.wait("document.body.innerText.includes('Some items are withheld. This count is incomplete.')");
    assert.ok(await b.evaluate("document.body.innerText.includes('0 visible')"));
    assert.equal(await b.evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
    const cancel = tenant.arrangements.request({ visitId: visit.id, patientId: 'PATIENT-A', kind: 'escort', detail: 'Cancel this synthetic support', by });
    await b.evaluate("document.querySelector('[data-tab=Arrangements]').click()");
    await b.wait("document.body.innerText.includes('Cancel this synthetic support')");
    await b.evaluate(`{document.querySelector('.arrangements details').open=true;const form=document.querySelector('form[data-operation=cancel]');form.elements.value.value='Patient has made other arrangements';form.requestSubmit()}`);
    await b.wait("document.body.innerText.includes('Cancellation saved.')");
    assert.equal(tenant.arrangements.get(cancel.id)!.cancelled_reason, 'Patient has made other arrangements');
    await b.evaluate('render()');
    await b.wait('document.body.innerText.includes("No visible outstanding arrangements")');
    assert.ok(await b.evaluate('document.body.innerText.includes("This list is incomplete")'));
    await b.evaluate('window.originalFetch=window.fetch;window.fetch=async()=>new Response(JSON.stringify({error:"Synthetic outage"}),{status:503})');
    await b.evaluate('render()');
    await b.wait('document.querySelector("[role=alert]")?.textContent.includes("Synthetic outage")');
    assert.equal(await b.evaluate('document.body.innerText.includes("No visible outstanding arrangements")'), false);
    await b.evaluate('window.fetch=window.originalFetch;document.querySelector("[data-act=render]").click()');
    await b.wait('document.body.innerText.includes("No visible outstanding arrangements")');
  } finally { await b.close(); await api.close(); await engine.stop(); }
});

test('refreshed portal fits both languages and protects the staff queue', { skip: browserSkip(), timeout: 90_000 }, async () => {
  const f = await portalFixture(); const b = await launchBrowser();
  try {
    assert.equal((await fetch(f.base + '/api/clinical/arrangements-outstanding')).status, 401);
    await b.navigate(f.base + '/me');
    await b.wait('!!document.querySelector("a[href=\\"/auth/portal/login\\"]")');
    await b.evaluate('document.querySelector("a[href=\\"/auth/portal/login\\"]").click()');
    await b.wait('document.getElementById("whoName").textContent === "PATIENT-A"');
    assert.equal(await b.evaluate('fetch("/api/clinical/arrangements-outstanding").then(r=>r.status)'), 401);
    for (const width of [1440, 390]) {
      await b.cdp('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: width === 390 });
      for (const language of ['en', 'fr']) {
        await b.evaluate(`document.getElementById('lang').value='${language}';document.getElementById('lang').dispatchEvent(new Event('change'))`);
        await b.wait(`document.documentElement.lang === '${language}'`);
        assert.equal(await b.evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
      }
      if (process.env.HEALTHSYSTEMS_WORKSPACE_SCREENSHOTS === 'on') {
        mkdirSync('.pilot-artifacts/workspace', { recursive: true });
        const shot = await b.cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
        writeFileSync(`.pilot-artifacts/workspace/portal-${width}.png`, Buffer.from(shot.data, 'base64'));
      }
    }
  } finally { await b.close(); await f.close(); }
});
