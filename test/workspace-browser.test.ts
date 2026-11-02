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
      await b.wait('typeof go === "function"');
      await b.evaluate('go("Arrangements")');
      await b.wait('document.body.innerText.includes("Accessible vehicle needed")');
      assert.ok(await b.evaluate('document.body.innerText.includes("This list is incomplete")'));
      assert.equal(await b.evaluate('document.body.innerText.includes("SECRET ARRANGEMENT")'), false);
      assert.equal(await b.evaluate('!!window.injected || !!document.querySelector(".arrangements img")'), false);
      assert.equal(await b.evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
      if (process.env.NORTHSTAR_WORKSPACE_SCREENSHOTS === 'on') {
        mkdirSync('.pilot-artifacts/workspace', { recursive: true });
        const shot = await b.cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
        writeFileSync(`.pilot-artifacts/workspace/console-${width}.png`, Buffer.from(shot.data, 'base64'));
      }
    }
    tenant.arrangements.confirm(visible.id, { evidence: 'Synthetic phone confirmation', by });
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
      if (process.env.NORTHSTAR_WORKSPACE_SCREENSHOTS === 'on') {
        mkdirSync('.pilot-artifacts/workspace', { recursive: true });
        const shot = await b.cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
        writeFileSync(`.pilot-artifacts/workspace/portal-${width}.png`, Buffer.from(shot.data, 'base64'));
      }
    }
  } finally { await b.close(); await f.close(); }
});
