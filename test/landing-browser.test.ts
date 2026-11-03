import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { portalFixture } from "./fixtures/portal-oidc.ts";
import { browserSkip, launchBrowser } from "./fixtures/browser.ts";

test("landing: public, bilingual, responsive and separate from chart access", { timeout: 90_000, skip: browserSkip() }, async () => {
  const f = await portalFixture();
  const b = await launchBrowser();
  try {
    for (const width of [1440, 390]) {
      await b.cdp("Emulation.setDeviceMetricsOverride", { width, height: 1000, deviceScaleFactor: 1, mobile: width === 390 });
      await b.navigate(f.base + "/");
      await b.wait("document.querySelector('h1')?.textContent.includes('Care moves.')");
      assert.equal(await b.evaluate("document.documentElement.scrollWidth <= innerWidth"), true, "no horizontal overflow");
      assert.equal(await b.evaluate("document.body.innerText.includes('PATIENT-A')"), false);
      assert.equal(await b.evaluate("document.querySelectorAll('h1').length"), 1);
      assert.ok(await b.evaluate("!!document.querySelector('a[href=\"/me\"]') && !!document.querySelector('a[href=\"/ui\"]')"));
      assert.deepEqual(await b.evaluate("performance.getEntriesByType('resource').filter(r => /\\/patient\\/|\\/api\\//.test(r.name)).map(r => r.name)"), [], "public landing does not fetch clinical APIs");
      if (process.env.HEALTHSYSTEM_LANDING_SCREENSHOTS === "on") {
        await b.evaluate("Promise.all(document.getAnimations().map(animation => animation.finished))");
        const dir = join(process.cwd(), ".pilot-artifacts", "landing");
        mkdirSync(dir, { recursive: true });
        const shot = await b.cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
        writeFileSync(join(dir, `landing-${width}.png`), Buffer.from(shot.data, "base64"));
      }
      await b.evaluate("document.getElementById('language').click()");
      assert.equal(await b.evaluate("document.documentElement.lang"), "fr");
      assert.ok(await b.evaluate("document.querySelector('h1').textContent.includes('Les soins avancent.')"));
      assert.equal(await b.evaluate("document.documentElement.scrollWidth <= innerWidth"), true, "French also fits");
      await b.evaluate("document.querySelector('.skip').focus()");
      assert.equal(await b.evaluate("document.activeElement.className"), "skip");
      await b.cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
      assert.equal(await b.evaluate("getComputedStyle(document.querySelector('.flow-card')).animationName"), "none");
    }
    assert.equal((await fetch(f.base + "/patient/authorities")).status, 401);
    await b.navigate(f.base + "/#Channels");
    await b.wait("location.pathname === '/login'");
    assert.equal(await b.evaluate("location.hash"), "#Channels", "legacy console bookmarks retain their fragment");
    assert.equal((await fetch(f.base + "/api/channels")).status, 401);
    const ui = await (await fetch(f.base + "/ui")).text();
    assert.ok(ui.includes("<title>HealthSystem</title>"), "clinical console is retained at /ui");
  } finally { await b.close(); await f.close(); }
});
