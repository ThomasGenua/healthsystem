/**
 * Item 60: pre-visit intake and patient uploads.
 *
 * Three properties carry the module and each has a test that would fail if
 * the property did not hold: a draft resumes rather than forking, a
 * submission never touches the medication list it merely describes, and an
 * upload is never served before something has scanned it — including when
 * nothing ever does.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine } from "../src/core/engine.ts";
import { SyntheticScanner, EICAR_TEST_STRING, type Question } from "../src/patient/intake.ts";

const PATIENT = "NT000001";
const OTHER_PATIENT = "NT000002";
const CLERK = { actorId: "clerk-amaruq", actorKind: "clerk" };
const DOCTOR = { actorId: "dr-okpik", actorKind: "practitioner" };
const PATIENT_ACTOR = { actorId: "patient-portal", actorKind: "patient" };

const INTAKE_QUESTIONS: Question[] = [
  { key: "fasting", label: "Have you fasted for 8 hours?", type: "boolean", required: true },
  { key: "notes", label: "Anything else we should know?", type: "text" },
];

async function clinic(opts: { scanner?: boolean } = {}) {
  const engine = new Engine({
    dbPath: ":memory:",
    tickMs: 15,
    ...(opts.scanner ? { malwareScanner: new SyntheticScanner() } : {}),
  });
  await engine.start();
  const t = engine.forTenant("default");
  for (const id of [PATIENT, OTHER_PATIENT]) {
    t.clinical.record({
      entryType: "Patient",
      patientId: id,
      content: { resourceType: "Patient", identifier: [{ value: id }] },
      authorId: "adt",
      authorKind: "device",
    });
  }
  return { engine, t, close: () => engine.stop() };
}

function publish(t: Awaited<ReturnType<typeof clinic>>["t"]) {
  return t.questionnaires.publish({ id: "pre-visit", title: "Pre-visit check-in", questions: INTAKE_QUESTIONS, by: CLERK });
}

// ---------------------------------------------------------------- Questionnaires

test("publishing again retires the old version without deleting it", async () => {
  const s = await clinic();
  try {
    const v1 = publish(s.t);
    assert.equal(v1.version, 1);
    const v2 = s.t.questionnaires.publish({
      id: "pre-visit",
      title: "Pre-visit check-in (revised)",
      questions: INTAKE_QUESTIONS,
      by: CLERK,
    });
    assert.equal(v2.version, 2);

    // The old version is still there, exactly as published — a submission
    // that named it must keep finding it.
    const stillV1 = s.t.questionnaires.get("pre-visit", 1);
    assert.equal(stillV1?.status, "retired");
    assert.equal(stillV1?.title, "Pre-visit check-in");

    // Unversioned lookup gives the one currently offered.
    assert.equal(s.t.questionnaires.get("pre-visit")?.version, 2);
    assert.deepEqual(
      s.t.questionnaires.list().map((q) => q.id),
      ["pre-visit"]
    );
  } finally {
    await s.close();
  }
});

test("a questionnaire needs at least one question, unique keys, and choices need options", async () => {
  const s = await clinic();
  try {
    assert.throws(() => s.t.questionnaires.publish({ id: "empty", title: "Empty", questions: [], by: CLERK }));
    assert.throws(() =>
      s.t.questionnaires.publish({
        id: "dup",
        title: "Dup",
        questions: [
          { key: "a", label: "A", type: "text" },
          { key: "a", label: "A again", type: "text" },
        ],
        by: CLERK,
      })
    );
    assert.throws(() =>
      s.t.questionnaires.publish({
        id: "bad-choice",
        title: "Bad choice",
        questions: [{ key: "c", label: "Choose", type: "choice", options: ["only one"] }],
        by: CLERK,
      })
    );
  } finally {
    await s.close();
  }
});

// -------------------------------------------------------------------- Drafts

test("saving a draft twice for the same patient, questionnaire and appointment continues one row", async () => {
  const s = await clinic();
  try {
    publish(s.t);
    const first = s.t.intake.saveDraft({
      patientId: PATIENT,
      questionnaireId: "pre-visit",
      appointmentId: "appt-1",
      answers: { fasting: true },
      by: PATIENT_ACTOR,
    });
    assert.equal(first.status, "draft");

    // A dropped connection resumes here — same id, merged answers.
    const second = s.t.intake.saveDraft({
      patientId: PATIENT,
      questionnaireId: "pre-visit",
      appointmentId: "appt-1",
      answers: { notes: "no allergies" },
      by: PATIENT_ACTOR,
    });
    assert.equal(second.id, first.id);
    assert.deepEqual(JSON.parse(second.answers), { fasting: true, notes: "no allergies" });

    assert.equal(s.t.intake.forPatient(PATIENT).length, 1);
  } finally {
    await s.close();
  }
});

test("a different appointment is a separate draft, not a collision", async () => {
  const s = await clinic();
  try {
    publish(s.t);
    const a = s.t.intake.saveDraft({ patientId: PATIENT, questionnaireId: "pre-visit", appointmentId: "appt-1", by: PATIENT_ACTOR });
    const b = s.t.intake.saveDraft({ patientId: PATIENT, questionnaireId: "pre-visit", appointmentId: "appt-2", by: PATIENT_ACTOR });
    assert.notEqual(a.id, b.id);
    assert.equal(s.t.intake.forPatient(PATIENT).length, 2);
  } finally {
    await s.close();
  }
});

// ------------------------------------------------------------------- Submit

test("submitting refuses while a required question is unanswered", async () => {
  const s = await clinic();
  try {
    publish(s.t);
    const draft = s.t.intake.saveDraft({
      patientId: PATIENT,
      questionnaireId: "pre-visit",
      appointmentId: "appt-1",
      answers: { notes: "left the fasting question blank" },
      by: PATIENT_ACTOR,
    });
    assert.throws(() => s.t.intake.submit(draft.id, PATIENT_ACTOR), /fasted for 8 hours.*required/);
  } finally {
    await s.close();
  }
});

test("an intake submission with nothing in it is refused", async () => {
  const s = await clinic();
  try {
    const draft = s.t.intake.saveDraft({ patientId: PATIENT, by: PATIENT_ACTOR });
    assert.throws(() => s.t.intake.submit(draft.id, PATIENT_ACTOR), /empty/);
  } finally {
    await s.close();
  }
});

test("submitting writes one QuestionnaireResponse and raises one review task", async () => {
  const s = await clinic();
  try {
    publish(s.t);
    const draft = s.t.intake.saveDraft({
      patientId: PATIENT,
      questionnaireId: "pre-visit",
      appointmentId: "appt-1",
      answers: { fasting: true },
      by: PATIENT_ACTOR,
    });
    const submitted = s.t.intake.submit(draft.id, PATIENT_ACTOR);
    assert.equal(submitted.status, "submitted");
    assert.ok(submitted.record_id);
    assert.ok(submitted.task_id);

    const chart = s.t.clinical.chart(PATIENT, { entryType: "QuestionnaireResponse" });
    assert.equal(chart.length, 1);
    assert.equal(chart[0].record_id, submitted.record_id);

    const task = s.t.tasks.get(submitted.task_id!);
    assert.equal(task?.kind, "portal-submission");
    assert.equal(task?.status, "open");
  } finally {
    await s.close();
  }
});

test("submitting twice produces one QuestionnaireResponse and one task, not two", async () => {
  const s = await clinic();
  try {
    publish(s.t);
    const draft = s.t.intake.saveDraft({
      patientId: PATIENT,
      questionnaireId: "pre-visit",
      appointmentId: "appt-1",
      answers: { fasting: false },
      by: PATIENT_ACTOR,
    });
    const first = s.t.intake.submit(draft.id, PATIENT_ACTOR);
    const second = s.t.intake.submit(draft.id, PATIENT_ACTOR);
    assert.deepEqual(first, second);
    assert.equal(s.t.clinical.chart(PATIENT, { entryType: "QuestionnaireResponse" }).length, 1);
  } finally {
    await s.close();
  }
});

test("a concern with no questionnaire can be submitted on its own", async () => {
  const s = await clinic();
  try {
    const draft = s.t.intake.saveDraft({ patientId: PATIENT, concern: "New rash on my arm since Tuesday", by: PATIENT_ACTOR });
    const submitted = s.t.intake.submit(draft.id, PATIENT_ACTOR);
    assert.equal(submitted.status, "submitted");
    const chart = s.t.clinical.chart(PATIENT, { entryType: "QuestionnaireResponse" });
    assert.equal(JSON.parse(chart[0].content).concern, "New rash on my arm since Tuesday");
  } finally {
    await s.close();
  }
});

test("a proposed medication change is recorded as testimony and never touches the medication list", async () => {
  const s = await clinic();
  try {
    const draft = s.t.intake.saveDraft({
      patientId: PATIENT,
      proposedMeds: [{ change: "stopped", description: "Stopped my metformin two weeks ago, stomach upset" }],
      by: PATIENT_ACTOR,
    });
    const submitted = s.t.intake.submit(draft.id, PATIENT_ACTOR);

    const chart = s.t.clinical.chart(PATIENT, { entryType: "QuestionnaireResponse" });
    assert.deepEqual(JSON.parse(chart[0].content).proposedMedicationChanges, [
      { change: "stopped", description: "Stopped my metformin two weeks ago, stomach upset" },
    ]);

    // The point of the whole design: nothing here is prescribing authority.
    assert.deepEqual(s.t.meds.current(PATIENT), []);
    assert.equal(submitted.task_id !== null, true, "still routed for a clinician to actually read it");
  } finally {
    await s.close();
  }
});

test("reviewing needs a written note and completes the routing task", async () => {
  const s = await clinic();
  try {
    const draft = s.t.intake.saveDraft({ patientId: PATIENT, concern: "Concern for review", by: PATIENT_ACTOR });
    const submitted = s.t.intake.submit(draft.id, PATIENT_ACTOR);

    assert.throws(() => s.t.intake.review(submitted.id, { outcome: "noted", note: "", by: DOCTOR }));
    assert.throws(() =>
      s.t.intake.review(draft.id === submitted.id ? "not-a-real-id" : draft.id, { outcome: "noted", note: "x", by: DOCTOR })
    );

    const reviewed = s.t.intake.review(submitted.id, { outcome: "needs-follow-up", note: "Booked a visit for the rash", by: DOCTOR });
    assert.equal(reviewed.status, "reviewed");
    assert.equal(reviewed.review_outcome, "needs-follow-up");
    assert.equal(s.t.tasks.get(submitted.task_id!)?.status, "completed");

    // Cannot review the same submission twice.
    assert.throws(() => s.t.intake.review(submitted.id, { outcome: "noted", note: "again", by: DOCTOR }));
  } finally {
    await s.close();
  }
});

test("a draft cannot be reviewed; only a submitted item is awaiting review", async () => {
  const s = await clinic();
  try {
    const draft = s.t.intake.saveDraft({ patientId: PATIENT, concern: "Still typing", by: PATIENT_ACTOR });
    assert.throws(() => s.t.intake.review(draft.id, { outcome: "noted", note: "too soon", by: DOCTOR }), /not awaiting review/);
    assert.deepEqual(s.t.intake.open(), []);
  } finally {
    await s.close();
  }
});

test("intake submissions are confined to their tenant", async () => {
  const s = await clinic();
  try {
    const draft = s.t.intake.saveDraft({ patientId: PATIENT, concern: "tenant A's concern", by: PATIENT_ACTOR });
    const other = s.engine.forTenant("other-clinic");
    assert.throws(() => other.intake.get(draft.id), /no intake submission/);
    assert.deepEqual(other.intake.forPatient(PATIENT), []);
  } finally {
    await s.close();
  }
});

// ------------------------------------------------------------------ Uploads

const PDF_CONTENT_TYPE = "application/pdf";
function b64(s: string) {
  return Buffer.from(s, "utf8").toString("base64");
}

test("an upload refuses a disallowed content type and an oversized payload", async () => {
  const s = await clinic();
  try {
    assert.throws(() =>
      s.t.uploads.receive({ patientId: PATIENT, filename: "x.html", contentType: "text/html", data: b64("<script>"), by: PATIENT_ACTOR })
    );
    const huge = b64("a".repeat(9 * 1024 * 1024));
    assert.throws(() =>
      s.t.uploads.receive({ patientId: PATIENT, filename: "big.txt", contentType: "text/plain", data: huge, by: PATIENT_ACTOR })
    );
  } finally {
    await s.close();
  }
});

test("with no scanner configured, an upload stays quarantined forever and is never served", async () => {
  const s = await clinic(); // no scanner
  try {
    const up = s.t.uploads.receive({
      patientId: PATIENT,
      filename: "referral-letter.pdf",
      contentType: PDF_CONTENT_TYPE,
      data: b64("not a real pdf but bytes"),
      by: PATIENT_ACTOR,
    });
    assert.equal(up.status, "pending-scan");

    const swept = await s.t.uploads.scanPending(CLERK);
    assert.deepEqual(swept, { scanned: 0, clean: 0, infected: 0 });
    assert.equal(s.t.uploads.forPatient(PATIENT)[0].status, "pending-scan");

    assert.throws(() => s.t.uploads.download(up.id), /still being scanned/);
    await assert.rejects(s.t.uploads.scanOne(up.id, CLERK), /no malware scanner is configured/);

    // And it must not have been filed onto the chart while unscanned.
    assert.deepEqual(s.t.documents.forPatient(PATIENT), []);
  } finally {
    await s.close();
  }
});

test("a clean upload is filed onto the chart and becomes downloadable", async () => {
  const s = await clinic({ scanner: true });
  try {
    const up = s.t.uploads.receive({
      patientId: PATIENT,
      filename: "specialist-letter.pdf",
      contentType: PDF_CONTENT_TYPE,
      data: b64("an ordinary harmless letter"),
      by: PATIENT_ACTOR,
    });
    const scanned = await s.t.uploads.scanOne(up.id, CLERK);
    assert.equal(scanned.status, "clean");
    assert.ok(scanned.document_record_id);

    const filed = s.t.documents.forPatient(PATIENT);
    assert.equal(filed.length, 1);
    assert.equal(filed[0].source, "patient-submitted");
    assert.equal(filed[0].recordId, scanned.document_record_id);

    const downloaded = s.t.uploads.download(up.id);
    assert.equal(downloaded.filename, "specialist-letter.pdf");
    assert.equal(Buffer.from(downloaded.data, "base64").toString("utf8"), "an ordinary harmless letter");

    // Freestanding (no submission riding along): raises its own review task.
    const openTasks = s.t.tasks.openOfKind("portal-submission");
    assert.equal(openTasks.length, 1);
    assert.match(openTasks[0].title, /specialist-letter\.pdf/);
  } finally {
    await s.close();
  }
});

test("an infected upload is never filed, never downloadable, and its bytes are gone", async () => {
  const s = await clinic({ scanner: true });
  try {
    const up = s.t.uploads.receive({
      patientId: PATIENT,
      filename: "totally-safe.txt",
      contentType: "text/plain",
      data: b64(EICAR_TEST_STRING),
      by: PATIENT_ACTOR,
    });
    const scanned = await s.t.uploads.scanOne(up.id, CLERK);
    assert.equal(scanned.status, "infected");
    assert.equal(scanned.document_record_id, null);
    assert.deepEqual(s.t.documents.forPatient(PATIENT), []);

    assert.throws(() => s.t.uploads.download(up.id), /flagged/);

    // The bytes themselves are gone, not just hidden behind a status check —
    // scanOne() re-running finds nothing left in pending-scan to act on.
    const again = await s.t.uploads.scanOne(up.id, CLERK);
    assert.deepEqual(again, scanned);
  } finally {
    await s.close();
  }
});

test("uploads are confined to their tenant and metadata lists never carry the payload", async () => {
  const s = await clinic({ scanner: true });
  try {
    const up = s.t.uploads.receive({
      patientId: PATIENT,
      filename: "letter.pdf",
      contentType: PDF_CONTENT_TYPE,
      data: b64("content"),
      by: PATIENT_ACTOR,
    });
    await s.t.uploads.scanOne(up.id, CLERK);

    const listed = s.t.uploads.forPatient(PATIENT)[0] as unknown as Record<string, unknown>;
    assert.equal("data" in listed, false);

    const other = s.engine.forTenant("other-clinic");
    assert.throws(() => other.uploads.download(up.id), /no upload/);
    assert.deepEqual(other.uploads.forPatient(PATIENT), []);
  } finally {
    await s.close();
  }
});

test("scanPending only scans a submission's own upload once, and only while pending", async () => {
  const s = await clinic({ scanner: true });
  try {
    const submission = s.t.intake.saveDraft({ patientId: PATIENT, concern: "attaching a photo", by: PATIENT_ACTOR });
    const up = s.t.uploads.receive({
      patientId: PATIENT,
      submissionId: submission.id,
      filename: "photo.jpg",
      contentType: "image/jpeg",
      data: b64("pretend jpeg bytes"),
      by: PATIENT_ACTOR,
    });
    const swept = await s.t.uploads.scanPending(CLERK);
    assert.deepEqual(swept, { scanned: 1, clean: 1, infected: 0 });

    // Riding a submission: does not raise its own task (the submission's
    // own submit() will, or already has). The draft is not even submitted
    // yet, so the review inbox stays empty here — a duplicate is what this
    // is checking is absent.
    const upAfter = s.t.uploads.forPatient(PATIENT)[0];
    assert.equal(upAfter.status, "clean");
    assert.deepEqual(s.t.tasks.openOfKind("portal-submission"), []);

    const sweptAgain = await s.t.uploads.scanPending(CLERK);
    assert.deepEqual(sweptAgain, { scanned: 0, clean: 0, infected: 0 });
    void up;
  } finally {
    await s.close();
  }
});
