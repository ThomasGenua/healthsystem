/**
 * The patient HTML shell at /me.
 *
 * Not a certified portal. This page is chrome: language, landmarks, an honest
 * banner. Chart access is /patient/* plus OAuth. An unauthenticated GET must
 * not be audited as a reach for a patient record.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine } from "../src/core/engine.ts";
import { startApi } from "../src/api/admin.ts";
import { AuthGate } from "../src/auth/gate.ts";
import { requiredScope } from "../src/auth/scopes.ts";

async function boot() {
  const engine = new Engine({ dbPath: ":memory:", tickMs: 15 });
  await engine.start();
  const api = await startApi(engine, 0, "127.0.0.1", { auth: new AuthGate({ keys: engine.keys }) });
  return {
    engine,
    base: `http://127.0.0.1:${api.port}`,
    close: async () => {
      await api.close();
      await engine.stop();
    },
  };
}

test("GET /me serves the patient shell without credentials", async () => {
  const { engine, base, close } = await boot();
  try {
    assert.equal(requiredScope("GET", "/me"), null);
    assert.equal(requiredScope("POST", "/me"), "admin", "only GET is public");
    const before = engine.forTenant("default").audit.list({ limit: 10 }).length;
    const res = await fetch(`${base}/me`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    const html = await res.text();
    assert.match(html, /lang="en"/);
    assert.match(html, /Skip to main content/);
    assert.match(html, /<main id="main"/);
    assert.match(html, /aria-live="polite"/);
    assert.match(html, /for="lang"/);
    assert.match(html, /This is not a certified patient portal/);
    assert.match(html, /Ceci n’est pas un portail patient certifié|Ceci n'est pas un portail patient certifié/);
    assert.match(html, /identity-proofing/);
    assert.match(html, /WCAG/);
    assert.match(html, /\/patient\//);
    assert.equal(
      engine.forTenant("default").audit.list({ limit: 10 }).length,
      before,
      "/me is chrome, not a patient-data access"
    );
  } finally {
    await close();
  }
});
