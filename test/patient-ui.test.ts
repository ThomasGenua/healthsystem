/**
 * The patient application at /me.
 *
 * This used to be chrome that loaded no chart, and these tests were written
 * about the chrome. What they actually pin survived it becoming an
 * application, which is why they are unchanged apart from this note: the page
 * is served without credentials, it carries its limits in both languages, it
 * has the landmarks a screen reader needs, and it enrols nobody. A portal
 * that quietly dropped "there is no identity-proofing" on the day it started
 * showing results would be the version worth catching.
 *
 * Still not a certified portal. Chart access is /patient/* plus OAuth, and an
 * unauthenticated GET here must not be audited as a reach for a patient
 * record. The application itself is tested in test/portal.test.ts.
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
    assert.match(html, /does not enrol anyone/);
    assert.equal(
      engine.forTenant("default").audit.list({ limit: 10 }).length,
      before,
      "/me is chrome, not a patient-data access"
    );
  } finally {
    await close();
  }
});

test("GET /me still does not enrol anyone", async () => {
  // Opening the shell, or guessing /patient/enrol, must not bind a subject.
  // Clinic attestation is a clerk writing a method, not a page on the internet
  // naming a chart (H-52).
  const { engine, base, close } = await boot();
  try {
    const html = await (await fetch(`${base}/me`)).text();
    assert.match(html, /does not enrol anyone/);
    assert.match(html, /identity-proofing/);
    assert.match(html, /WCAG/);
    assert.equal(engine.forTenant("default").enrolment.list().length, 0);

    const guessed = await fetch(`${base}/patient/enrol`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ patient: "NT123456", subject: "anyone" }),
    });
    assert.notEqual(guessed.status, 200);
    assert.notEqual(guessed.status, 201);
    assert.ok(guessed.status === 401 || guessed.status === 403 || guessed.status === 404);
    assert.equal(engine.forTenant("default").enrolment.list().length, 0);
    assert.equal(engine.forTenant("default").patientAccess.whoCanSee("NT123456").length, 0);
  } finally {
    await close();
  }
});
