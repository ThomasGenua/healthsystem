/**
 * Asking the clinic for a copy of a record, or for a correction to it, in a
 * real browser.
 *
 * The store refuses a correction request that does not say what should be
 * corrected, and rightly: "please fix my record" is not something a clinic
 * can act on. The portal's form never asked. It sent the kind and the free
 * text and nothing else, so every "Correct my record" a patient sent through
 * it was refused — and because the store said no with a plain error, the
 * router answered 500 and the patient read "internal error". Nothing caught
 * it, because no test had ever sent a request through the screen.
 *
 * Each test asserts what the patient sees and what the clinic is then given
 * to act on, not a status code.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { portalFixture } from "./fixtures/portal-oidc.ts";
import { browserSkip, launchBrowser } from "./fixtures/browser.ts";

const SKIP = browserSkip();

/** Sign in and land on the requests screen. */
async function onRequests(f: Awaited<ReturnType<typeof portalFixture>>) {
  const b = await launchBrowser();
  await b.navigate(`${f.base}/me`);
  await b.wait("!!document.querySelector('a[href=\"/auth/portal/login\"]')");
  await b.evaluate("document.querySelector('a[href=\"/auth/portal/login\"]').click()");
  await b.wait("document.getElementById('whoName').textContent === 'PATIENT-A'");
  await b.evaluate("document.querySelector('a[href=\"#/requests\"]').click()");
  await b.wait("!!document.getElementById('kind')");
  return b;
}

/** Pick a kind the way a mouse or a keyboard does: set it, and let the screen hear the change. */
const choose = (kind: "access" | "correction") =>
  `(() => { const s = document.getElementById('kind'); s.value = '${kind}'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`;

/**
 * Whether the "what should be corrected" field is there to be seen, and must
 * be filled in. Seen means laid out on the page, not merely missing a
 * `hidden` attribute that a stylesheet could override.
 */
const targetState = `(() => {
  const input = document.getElementById('target');
  return input ? { shown: input.getClientRects().length > 0, required: input.required } : null;
})()`;

test("browser requests: a patient can ask for a correction, and the clinic is told what to correct", {
  timeout: 90_000, skip: SKIP,
}, async () => {
  const f = await portalFixture();
  const b = await onRequests(f);
  try {
    await b.evaluate(choose("correction"));
    assert.deepEqual(await b.evaluate(targetState), { shown: true, required: true },
      "a correction has to say what is wrong, so the screen asks");
    assert.equal(await b.evaluate("document.querySelector('label[for=\"target\"]').textContent"), "What should be corrected",
      "and the field is labelled, so a screen reader can say what it is for");

    await b.evaluate("document.getElementById('target').value = 'Date of birth'");
    await b.evaluate("document.getElementById('detail').value = 'It is 1961, not 1916'");
    await b.evaluate("document.getElementById('kind').form.requestSubmit()");
    await b.wait("document.getElementById('live').textContent.startsWith('Sent.') || !!document.querySelector('.err[data-form-error]')");
    assert.equal(await b.evaluate("document.querySelector('.err[data-form-error]')?.textContent ?? null"), null,
      "the request went in without a complaint");

    const rows = f.engine.forTenant("default").patientAccess.requestsFor("PATIENT-A");
    assert.deepEqual(rows.map((r) => [r.kind, r.target, r.detail]), [["correction", "Date of birth", "It is 1961, not 1916"]],
      "the clinic is told what to correct and why");
    assert.ok(rows[0].task_id, "and it is on the clinic's list");
  } finally { await b.close(); await f.close(); }
});

test("browser requests: a request for a copy asks nothing more, and carries no target", {
  timeout: 90_000, skip: SKIP,
}, async () => {
  const f = await portalFixture();
  const b = await onRequests(f);
  try {
    // "See my record" is the first choice and what the form opens on.
    assert.equal(await b.evaluate("document.getElementById('kind').value"), "access");
    assert.deepEqual(await b.evaluate(targetState), { shown: false, required: false },
      "a copy of the record needs no 'what is wrong'");

    // Changing your mind both ways leaves it as it was — including when
    // something was typed into the field before the patient changed it back.
    // A hidden field's leftovers are not part of a request for a copy.
    await b.evaluate(choose("correction"));
    await b.evaluate("document.getElementById('target').value = 'my allergies'");
    await b.evaluate(choose("access"));
    assert.deepEqual(await b.evaluate(targetState), { shown: false, required: false });

    await b.evaluate("document.getElementById('detail').value = 'My immunization record, please'");
    await b.evaluate("document.getElementById('kind').form.requestSubmit()");
    await b.wait("document.getElementById('live').textContent.startsWith('Sent.') || !!document.querySelector('.err[data-form-error]')");

    const rows = f.engine.forTenant("default").patientAccess.requestsFor("PATIENT-A");
    assert.deepEqual(rows.map((r) => [r.kind, r.target]), [["access", null]], "absent, not an empty string");
  } finally { await b.close(); await f.close(); }
});

test("browser requests: a correction the clinic cannot take says why in the form, and keeps what was typed", {
  timeout: 90_000, skip: SKIP,
}, async () => {
  const f = await portalFixture();
  const b = await onRequests(f);
  try {
    await b.evaluate(choose("correction"));
    // Spaces get past the browser's own "required" check; the server is
    // where they are refused, and the refusal is what this is about.
    await b.evaluate("document.getElementById('target').value = '   '");
    await b.evaluate("document.getElementById('detail').value = 'It is 1961, not 1916'");
    await b.evaluate("document.getElementById('kind').form.requestSubmit()");
    await b.wait("!!document.querySelector('.err[data-form-error]')");

    assert.equal(
      await b.evaluate("document.querySelector('.err[data-form-error]').textContent"),
      "a correction request needs to identify what should be corrected",
      "the reason, not 'internal error'"
    );
    assert.equal(await b.evaluate("document.getElementById('detail').value"), "It is 1961, not 1916", "and nothing typed was lost");
    assert.deepEqual(f.engine.forTenant("default").patientAccess.requestsFor("PATIENT-A"), []);
  } finally { await b.close(); await f.close(); }
});

test("browser requests: the correction field is in French when the patient asks for French", {
  timeout: 90_000, skip: SKIP,
}, async () => {
  const f = await portalFixture();
  const b = await onRequests(f);
  try {
    await b.evaluate("document.getElementById('lang').value='fr'; document.getElementById('lang').dispatchEvent(new Event('change'))");
    await b.wait("document.documentElement.lang === 'fr'");
    await b.evaluate("document.querySelector('a[href=\"#/requests\"]').click()");
    await b.wait("document.body.innerText.includes('Faire une demande')");
    await b.evaluate(choose("correction"));
    assert.equal(await b.evaluate("document.querySelector('label[for=\"target\"]').textContent"), "Que faut-il corriger");
    // A key missing from COPY.fr renders as the key itself.
    assert.ok(!/\brequestTarget\b/.test(String(await b.evaluate("document.body.innerText"))), "no untranslated key on a French screen");
  } finally { await b.close(); await f.close(); }
});
