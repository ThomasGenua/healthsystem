/**
 * The pre-visit intake screen, in a real browser.
 *
 * PRs #106-108 built "which visit is this form for" across a server store, an
 * HTTP route and a screen, and the only end-to-end evidence was a store test.
 * The screen is where the choice is actually made, and three of the four ways
 * it can be wrong are invisible from the server: a selector that preselects
 * the wrong visit, a draft that follows the patient from one appointment to
 * another, and an appointment that disappears underneath a form somebody is
 * halfway through filling in.
 *
 * Each test asserts what a patient would see and what the clinic would then
 * read off the board, not that a request returned 200 -- which is what #107
 * was about: every test on that route asserted a status code, and 200 is what
 * a broken payload returns too.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { portalFixture, seedIntake } from "./fixtures/portal-oidc.ts";
import { browserSkip, launchBrowser } from "./fixtures/browser.ts";

const SKIP = browserSkip();

/** Sign in and land on the intake screen, with whatever was seeded in place. */
async function onIntake(f: Awaited<ReturnType<typeof portalFixture>>) {
  const b = await launchBrowser();
  await b.navigate(`${f.base}/me`);
  await b.wait("!!document.querySelector('a[href=\"/auth/portal/login\"]')");
  await b.evaluate("document.querySelector('a[href=\"/auth/portal/login\"]').click()");
  await b.wait("document.getElementById('whoName').textContent === 'PATIENT-A'");
  await b.evaluate("document.querySelector('a[href=\"#/intake\"]').click()");
  await b.wait("document.body.innerText.includes('Pre-visit check-in')");
  return b;
}

test("browser intake: no upcoming visit offers no choice, and what is sent covers no appointment", {
  timeout: 90_000, skip: SKIP,
}, async () => {
  const f = await portalFixture();
  seedIntake(f.engine, { patientId: "PATIENT-A", hoursAhead: [] });
  const b = await onIntake(f);
  try {
    // Absent, not an empty dropdown: a selector with nothing in it reads as
    // "we lost your appointments", which is a different thing to say.
    assert.equal(await b.evaluate("!!document.getElementById('intake-visit')"), false,
      "with nothing booked there is no visit to attach a form to, so no selector");

    await b.evaluate("document.getElementById('q-fasting').value='true'");
    await b.evaluate("document.querySelector('button[type=submit]').click()");
    await b.wait("document.body.innerText.includes('Submitted')");

    const t = f.engine.forTenant("default");
    const rows = t.intake.forPatient("PATIENT-A");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].appointment_id, null, "nothing was chosen, so nothing is claimed");
    assert.equal(rows[0].status, "submitted");
    // Null is not a wildcard. A form attached to no visit prepares no visit.
    assert.equal(t.intake.submittedForAppointments(["anything-at-all"]).size, 0);
  } finally { await b.close(); await f.close(); }
});

test("browser intake: exactly one upcoming visit is preselected and carried onto the submission", {
  timeout: 90_000, skip: SKIP,
}, async () => {
  const f = await portalFixture();
  const seeded = seedIntake(f.engine, { patientId: "PATIENT-A", hoursAhead: [48] });
  const b = await onIntake(f);
  try {
    await b.wait("!!document.getElementById('intake-visit')");
    assert.equal(await b.evaluate("document.getElementById('intake-visit').value"), seeded.appointmentIds[0],
      "one visit is the only thing it could be for, so choosing it cannot be got wrong");

    await b.evaluate("document.getElementById('q-fasting').value='true'");
    await b.evaluate("document.querySelector('button[type=submit]').click()");
    await b.wait("document.body.innerText.includes('Submitted')");

    const t = f.engine.forTenant("default");
    assert.deepEqual(
      [...t.intake.submittedForAppointments(seeded.appointmentIds)],
      [seeded.appointmentIds[0]],
      "the clinic board must be able to see this visit as prepared"
    );
  } finally { await b.close(); await f.close(); }
});

test("browser intake: several upcoming visits are all offered, soonest first, and none is guessed", {
  timeout: 90_000, skip: SKIP,
}, async () => {
  const f = await portalFixture();
  // Seeded out of order on purpose: the screen sorts, the fixture does not.
  const seeded = seedIntake(f.engine, { patientId: "PATIENT-A", hoursAhead: [720, 24, 168] });
  const [far, soon, middle] = seeded.appointmentIds;
  const b = await onIntake(f);
  try {
    await b.wait("!!document.getElementById('intake-visit')");
    assert.equal(await b.evaluate("document.getElementById('intake-visit').value"), "",
      "with more than one visit there is a choice to get wrong, so nothing is preselected");
    assert.deepEqual(
      await b.evaluate("Array.from(document.getElementById('intake-visit').options).map(o => o.value)"),
      ["", soon, middle, far],
      "soonest first, after the honest 'not for a particular visit'"
    );
    // Every option says when and what, because a bare identifier is not a
    // thing a patient can choose between -- the em-dash bug of #107.
    const labels = await b.evaluate("Array.from(document.getElementById('intake-visit').options).slice(1).map(o => o.textContent)");
    for (const label of labels as string[]) {
      assert.ok(!label.includes("—") || label.length > 5, `option reads as a date and service, got ${JSON.stringify(label)}`);
      assert.match(label, /\d/, "an option a patient can pick between has a date in it");
    }
  } finally { await b.close(); await f.close(); }
});

test("browser intake: a draft for one visit is not the draft for another", {
  timeout: 90_000, skip: SKIP,
}, async () => {
  const f = await portalFixture();
  const seeded = seedIntake(f.engine, { patientId: "PATIENT-A", hoursAhead: [24, 168] });
  const [thursday, nextMonth] = seeded.appointmentIds;
  const b = await onIntake(f);
  try {
    await b.wait("!!document.getElementById('intake-visit')");
    // Thursday: fasted, with a note.
    await b.evaluate(`document.getElementById('intake-visit').value=${JSON.stringify(thursday)}; document.getElementById('intake-visit').dispatchEvent(new Event('change'))`);
    await b.wait("document.getElementById('intake-visit').value === " + JSON.stringify(thursday) + " && !!document.getElementById('q-fasting')");
    await b.evaluate("document.getElementById('q-fasting').value='true'; document.getElementById('q-notes').value='for Thursday'");
    await b.evaluate("Array.from(document.querySelectorAll('button')).find(x => x.textContent.includes('Save')).click()");
    await b.wait("document.getElementById('live').textContent.startsWith('Saved.')");

    // Next month: a different answer entirely.
    await b.evaluate(`document.getElementById('intake-visit').value=${JSON.stringify(nextMonth)}; document.getElementById('intake-visit').dispatchEvent(new Event('change'))`);
    await b.wait("document.getElementById('intake-visit').value === " + JSON.stringify(nextMonth));
    // The second visit's form starts empty rather than inheriting Thursday's.
    assert.equal(await b.evaluate("document.getElementById('q-notes').value"), "",
      "switching visit must not carry the other visit's answers across");
    await b.evaluate("document.getElementById('q-fasting').value='false'; document.getElementById('q-notes').value='for next month'");
    await b.evaluate("Array.from(document.querySelectorAll('button')).find(x => x.textContent.includes('Save')).click()");
    await b.wait("document.getElementById('live').textContent.startsWith('Saved.')");

    const t = f.engine.forTenant("default");
    const drafts = t.intake.forPatient("PATIENT-A").filter((r) => r.status === "draft");
    assert.equal(drafts.length, 2, "two visits prepared for is two drafts, not one overwritten twice");
    const byVisit = new Map(drafts.map((d) => [d.appointment_id, JSON.parse(d.answers).notes]));
    assert.equal(byVisit.get(thursday), "for Thursday");
    assert.equal(byVisit.get(nextMonth), "for next month");

    // Going back shows Thursday's answers again, not the last thing typed.
    await b.evaluate(`document.getElementById('intake-visit').value=${JSON.stringify(thursday)}; document.getElementById('intake-visit').dispatchEvent(new Event('change'))`);
    await b.wait("document.getElementById('q-notes').value === 'for Thursday'");
  } finally { await b.close(); await f.close(); }
});

test("browser intake: a form sent in for no visit leaves every visit unprepared", {
  timeout: 90_000, skip: SKIP,
}, async () => {
  const f = await portalFixture();
  const seeded = seedIntake(f.engine, { patientId: "PATIENT-A", hoursAhead: [24, 168] });
  const b = await onIntake(f);
  try {
    await b.wait("!!document.getElementById('intake-visit')");
    // "Not for a particular visit" is the default with a choice to make, and
    // the screen says out loud what that means.
    assert.equal(await b.evaluate("document.getElementById('intake-visit').value"), "");
    assert.ok(String(await b.evaluate("document.body.innerText")).includes("not be attached to an appointment"),
      "a patient choosing no visit is told what that costs");

    await b.evaluate("document.getElementById('q-fasting').value='true'");
    await b.evaluate("document.querySelector('button[type=submit]').click()");
    await b.wait("document.body.innerText.includes('Submitted')");

    const t = f.engine.forTenant("default");
    assert.equal(t.intake.submittedForAppointments(seeded.appointmentIds).size, 0,
      "an unattached form must never mark an appointment prepared");
  } finally { await b.close(); await f.close(); }
});

test("browser intake: a visit cancelled underneath the patient is refused, and their answers survive the refusal", {
  timeout: 90_000, skip: SKIP,
}, async () => {
  const f = await portalFixture();
  const seeded = seedIntake(f.engine, { patientId: "PATIENT-A", hoursAhead: [24] });
  const t = f.engine.forTenant("default");
  const b = await onIntake(f);
  try {
    await b.wait("!!document.getElementById('intake-visit')");
    await b.evaluate("document.getElementById('q-fasting').value='true'; document.getElementById('q-notes').value='typed before the clinic cancelled'");

    // The clinic cancels while the form is open. The tab knows nothing.
    t.schedule.cancel(seeded.appointmentIds[0], { ...f.actor, reason: "clinic cancelled the list" });

    await b.evaluate("Array.from(document.querySelectorAll('button')).find(x => x.textContent.includes('Save')).click()");
    await b.wait("!!document.querySelector('.err[data-form-error]')");
    assert.match(
      String(await b.evaluate("document.querySelector('.err[data-form-error]').textContent")),
      /cancelled/i,
      "the patient is told why, not just that something went wrong"
    );

    // The refusal is the point, and so is what survives it: a patient who
    // typed three paragraphs must not find the box empty afterwards. Until
    // this change the failure path called showError(), which replaces the
    // whole view -- every answer gone, and a retry button that navigated to
    // Messages from whatever screen you were on.
    assert.equal(await b.evaluate("document.getElementById('q-notes').value"), "typed before the clinic cancelled",
      "a save that fails must leave the answers on the screen");
    assert.equal(await b.evaluate("document.getElementById('q-fasting').value"), "true");
    assert.equal(t.intake.forPatient("PATIENT-A").length, 0, "nothing half-written was stored");

    // Reloading the screen drops the stale visit rather than keeping a
    // selection nothing can be attached to.
    await b.evaluate("document.querySelector('a[href=\"#/results\"]').click()");
    await b.wait("!document.body.innerText.includes('Pre-visit check-in')");
    await b.evaluate("document.querySelector('a[href=\"#/intake\"]').click()");
    await b.wait("document.body.innerText.includes('Pre-visit check-in')");
    assert.equal(await b.evaluate("!!document.getElementById('intake-visit')"), false,
      "the cancelled visit is gone, and it was the only one");
  } finally { await b.close(); await f.close(); }
});

test("browser intake: the screen is in French when the patient asks for French, and reachable by keyboard", {
  timeout: 90_000, skip: SKIP,
}, async () => {
  const f = await portalFixture();
  seedIntake(f.engine, { patientId: "PATIENT-A", hoursAhead: [24, 168] });
  const b = await onIntake(f);
  try {
    await b.wait("!!document.getElementById('intake-visit')");
    assert.ok(String(await b.evaluate("document.body.innerText")).includes("These forms are for:"));

    await b.evaluate("document.getElementById('lang').value='fr'; document.getElementById('lang').dispatchEvent(new Event('change'))");
    await b.wait("document.documentElement.lang === 'fr'");
    await b.evaluate("document.querySelector('a[href=\"#/intake\"]').click()");
    await b.wait("document.body.innerText.includes('Ces formulaires sont pour')");
    const french = String(await b.evaluate("document.body.innerText"));
    assert.ok(french.includes("Pas pour une visite en particulier"), "the no-visit option is translated too");
    assert.ok(!french.includes("These forms are for:"), "no English left behind on a French screen");
    // A key that is missing from COPY.fr renders as the key itself, which is
    // the one failure mode a language toggle has.
    assert.ok(!/\bintake(ForVisit|NoVisit|NoVisitNote)\b/.test(french), "an untranslated key must not reach the screen");

    // The selector is a labelled form control, so it is in the tab order and
    // a screen reader can say what it is for.
    assert.equal(await b.evaluate("document.getElementById('intake-visit').tabIndex >= 0"), true);
    assert.equal(
      await b.evaluate("!!document.querySelector('label[for=\"intake-visit\"]')"), true,
      "the visit selector has a label pointing at it"
    );
    await b.evaluate("document.getElementById('intake-visit').focus()");
    assert.equal(await b.evaluate("document.activeElement.id"), "intake-visit");
    // Changing it from the keyboard is the same path as changing it by mouse.
    await b.evaluate("const s=document.getElementById('intake-visit'); s.selectedIndex=1; s.dispatchEvent(new Event('change'))");
    await b.wait("document.getElementById('intake-visit').selectedIndex === 1");
  } finally { await b.close(); await f.close(); }
});

test("browser intake: a second tab cannot turn one visit's form into two chart documents", {
  timeout: 90_000, skip: SKIP,
}, async () => {
  const f = await portalFixture();
  const seeded = seedIntake(f.engine, { patientId: "PATIENT-A", hoursAhead: [24] });
  const t = f.engine.forTenant("default");
  const b = await onIntake(f);
  try {
    await b.wait("!!document.getElementById('intake-visit')");
    await b.evaluate("document.getElementById('q-fasting').value='true'; document.getElementById('q-notes').value='sent from the first tab'");
    await b.evaluate("document.querySelector('button[type=submit]').click()");
    await b.wait("document.body.innerText.includes('Submitted')");

    // The second tab was rendered before the first one submitted, so it
    // holds no draft id and would open a new one. Replayed through the
    // page's own api() helper, because that is the request a real second
    // tab makes -- a bare fetch() is missing the CSRF header and is refused
    // at 403 before any of this is reached, which would prove the wrong
    // thing.
    const replay = await b.evaluate(`api('/patient/intake/draft', {method:'POST', body: JSON.stringify({
      patient: 'PATIENT-A', questionnaireId: 'pre-visit', appointmentId: ${JSON.stringify(seeded.appointmentIds[0])},
      answers: { fasting: false, notes: 'the stale tab' }
    })}).then(() => 'accepted', e => e.message)`);
    assert.match(String(replay), /already sent in/,
      "a form already sent in for this visit is not silently sent again");

    assert.equal(t.clinical.chart("PATIENT-A", { entryType: "QuestionnaireResponse" }).length, 1,
      "one conversation, one QuestionnaireResponse");
    const submissions = t.intake.forPatient("PATIENT-A");
    assert.equal(submissions.length, 1);
    assert.equal(JSON.parse(submissions[0].answers).notes, "sent from the first tab",
      "the stale tab's older answers must not overwrite what was actually sent");
  } finally { await b.close(); await f.close(); }
});

test("browser intake: a document too large to send does not take the questionnaire with it", {
  timeout: 90_000, skip: SKIP,
}, async () => {
  // The upload card shares the intake screen. Its size check used to call
  // showError(), which replaces the whole view -- so picking a phone photo
  // over the limit destroyed every unsaved answer typed above it.
  const f = await portalFixture();
  seedIntake(f.engine, { patientId: "PATIENT-A", hoursAhead: [24] });
  const b = await onIntake(f);
  try {
    await b.wait("!!document.getElementById('q-notes') && !!document.getElementById('upload-file')");
    await b.evaluate("document.getElementById('q-notes').value='typed, not yet saved'");

    // Nine megabytes, over the eight the portal allows, built in the page so
    // nothing is written to disk.
    await b.evaluate(`(() => {
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array(9 * 1024 * 1024)], 'pill-bottle.jpg', { type: 'image/jpeg' }));
      const input = document.getElementById('upload-file');
      input.files = dt.files;
      input.form.requestSubmit();
    })()`);
    await b.wait("!!document.getElementById('upload-file').form.querySelector('.err[data-form-error]')");

    assert.equal(await b.evaluate("document.getElementById('q-notes').value"), "typed, not yet saved",
      "a refused upload must not cost the patient their answers");
    assert.match(
      String(await b.evaluate("document.getElementById('upload-file').form.querySelector('.err[data-form-error]').textContent")),
      /8 MB|8 Mo/,
      "the refusal says what the limit is, in the form it applies to"
    );
    assert.equal(f.engine.forTenant("default").uploads.forPatient("PATIENT-A").length, 0, "nothing was sent");
  } finally { await b.close(); await f.close(); }
});

test("browser intake: switching visit asks before it throws away unsaved answers", {
  timeout: 90_000, skip: SKIP,
}, async () => {
  // Switching visit re-renders every form from what is saved for the visit
  // chosen, and used to discard anything typed and not saved without a word.
  const f = await portalFixture();
  const seeded = seedIntake(f.engine, { patientId: "PATIENT-A", hoursAhead: [24, 168] });
  const [thursday, nextMonth] = seeded.appointmentIds;
  const b = await onIntake(f);
  const choose = (id: string) =>
    b.evaluate(`(() => { const s = document.getElementById('intake-visit'); s.value = ${JSON.stringify(id)}; s.dispatchEvent(new Event('change')); })()`);
  try {
    await b.wait("!!document.getElementById('intake-visit')");
    await choose(thursday!);
    await b.wait(`document.getElementById('intake-visit').value === ${JSON.stringify(thursday)} && !!document.getElementById('q-notes')`);

    // Nothing typed yet: switching needs no question.
    await choose(nextMonth!);
    await b.wait(`document.getElementById('intake-visit').value === ${JSON.stringify(nextMonth)}`);
    await choose(thursday!);
    await b.wait(`document.getElementById('intake-visit').value === ${JSON.stringify(thursday)} && !!document.getElementById('q-notes')`);

    // Typed, not saved. The patient is asked, and says no.
    await b.evaluate("(() => { const n=document.getElementById('q-notes'); n.value='typed for Thursday, not saved'; n.dispatchEvent(new Event('input', {bubbles:true})); })()");
    const refused = b.nextDialog(false);
    const switching = choose(nextMonth!);
    assert.match(await refused, /not saved/, "the patient is told what switching would cost");
    await switching;
    assert.equal(await b.evaluate("document.getElementById('intake-visit').value"), thursday,
      "Cancel leaves the selector on the visit the answers belong to");
    assert.equal(await b.evaluate("document.getElementById('q-notes').value"), "typed for Thursday, not saved",
      "and every answer where it was");

    // Saved, then switching needs no question -- nothing would be lost.
    await b.evaluate("Array.from(document.querySelectorAll('button')).find(x => x.textContent.includes('Save')).click()");
    await b.wait("document.getElementById('live').textContent.startsWith('Saved.')");
    await choose(nextMonth!);
    await b.wait(`document.getElementById('intake-visit').value === ${JSON.stringify(nextMonth)}`);
    assert.equal(await b.evaluate("document.getElementById('q-notes').value"), "", "next month's form starts empty");

    // Typed again and this time the patient accepts the loss knowingly.
    await b.evaluate("(() => { const n=document.getElementById('q-notes'); n.value='abandoned on purpose'; n.dispatchEvent(new Event('input', {bubbles:true})); })()");
    const accepted = b.nextDialog(true);
    const leaving = choose(thursday!);
    await accepted;
    await leaving;
    await b.wait(`document.getElementById('intake-visit').value === ${JSON.stringify(thursday)} && document.getElementById('q-notes').value === 'typed for Thursday, not saved'`);
  } finally { await b.close(); await f.close(); }
});
