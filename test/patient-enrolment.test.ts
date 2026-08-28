/**
 * Clinic-attested enrolment, and the notices that follow it.
 *
 * Binding an OAuth subject to a chart used to be `grantSelf` with nothing on
 * the record saying how the clerk knew the person in front of them was the
 * patient. A grant with no attestation is how a chart ends up readable by the
 * wrong account, for years, with nobody having done anything that looks like
 * a mistake.
 *
 * This is not identity-proofing, not ONE ID, and not a portal enrolment form.
 * A named person writes, in their own words, how they checked. Twelve
 * characters, same bar as breaking glass. A pending row is not authority.
 * GET /me does not enrol anyone. Dispatching a notice is not telling.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../src/db.ts";
import { Engine } from "../src/core/engine.ts";
import { OrderStore } from "../src/orders/store.ts";
import { TaskStore } from "../src/work/tasks.ts";
import { PatientAccess } from "../src/patient/access.ts";
import { PatientEnrolment } from "../src/patient/enrolment.ts";
import { PatientNotices, type PatientNoticePayload } from "../src/patient/notice.ts";

const P = "NT123456";
const CLERK = { actorId: "registration-desk", actorKind: "practitioner" };
const METHOD = "photo ID and health card matched at the desk";
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();

const CHANNEL = JSON.stringify({
  id: "patient-notices",
  name: "Patient notices",
  source: { type: "http", path: "notices" },
  destinations: [],
});

function clinic(channelId: string | null = null) {
  const dir = mkdtempSync(join(tmpdir(), "northstar-enrol-"));
  const db = new Db(join(dir, "northstar.db"));
  if (channelId) db.upsertChannel(channelId, "Patient notices", true, CHANNEL);
  const orders = new OrderStore(db);
  const tasks = new TaskStore(db);
  const access = new PatientAccess(db, orders, tasks);
  const notices = new PatientNotices(db, channelId);
  const enrolment = new PatientEnrolment(db, access, notices);
  return {
    db,
    access,
    notices,
    enrolment,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("enrolment does not bind a subject without attestation", () => {
  // A pending row is a clerk's note that someone presented. Treating it as
  // a grant is how a chart becomes readable by an account nobody checked.
  const { access, enrolment, cleanup } = clinic();
  try {
    const pending = enrolment.request({
      patientId: P,
      subjectId: "patient-marie",
      relationship: "self",
      by: CLERK,
    });
    assert.equal(pending.status, "pending");
    assert.equal(pending.method, null);
    assert.equal(pending.authority_id, null);
    assert.equal(access.may("patient-marie", P), undefined, "pending is not authority");
    assert.equal(enrolment.pending().length, 1);
    assert.equal(access.whoCanSee(P).length, 0);
  } finally {
    cleanup();
  }
});

test("attesting enrolment needs a written method of verification, not a word", () => {
  const { access, enrolment, cleanup } = clinic();
  try {
    const pending = enrolment.request({
      patientId: P,
      subjectId: "patient-marie",
      relationship: "self",
      by: CLERK,
    });
    assert.throws(
      () => enrolment.attest(pending.id, { method: "in person", by: CLERK }),
      /written method of verification, not a word/
    );
    assert.throws(
      () => enrolment.attestInPerson({
        patientId: P,
        subjectId: "someone-else",
        relationship: "self",
        method: "ok",
        by: CLERK,
      }),
      /written method of verification, not a word/
    );
    assert.equal(access.may("patient-marie", P), undefined, "the refusal left the subject unbound");
    assert.equal(enrolment.get(pending.id)!.status, "pending");
  } finally {
    cleanup();
  }
});

test("declining enrolment needs a written reason", () => {
  const { access, enrolment, cleanup } = clinic();
  try {
    const pending = enrolment.request({
      patientId: P,
      subjectId: "patient-marie",
      relationship: "self",
      by: CLERK,
    });
    assert.throws(
      () => enrolment.decline(pending.id, { reason: "no", by: CLERK }),
      /written reason, not a word/
    );
    assert.equal(enrolment.get(pending.id)!.status, "pending");

    const declined = enrolment.decline(pending.id, {
      reason: "could not confirm identity from the documents presented",
      by: CLERK,
    });
    assert.equal(declined.status, "declined");
    assert.match(declined.decline_reason!, /could not confirm/);
    assert.equal(access.may("patient-marie", P), undefined, "a decline is not a grant");
  } finally {
    cleanup();
  }
});

test("attesting enrolment binds the oauth subject and records who checked", () => {
  const { access, enrolment, notices, cleanup } = clinic();
  try {
    const pending = enrolment.request({
      patientId: P,
      subjectId: "patient-marie",
      relationship: "self",
      by: CLERK,
    });
    const done = enrolment.attest(pending.id, { method: METHOD, by: CLERK });
    assert.equal(done.status, "attested");
    assert.equal(done.method, METHOD);
    assert.equal(done.attested_by, CLERK.actorId);
    assert.ok(done.authority_id);
    assert.ok(access.may("patient-marie", P), "the grant the boundary already uses");
    assert.equal(access.authority(done.authority_id!)!.subject_id, "patient-marie");

    const notice = notices.list({ patientId: P }).find((n) => n.kind === "enrolment-attested");
    assert.ok(notice, "the patient is owed a notice that enrolment happened");
    assert.match(notice!.summary, /attested your identity/);
    assert.ok(!notice!.summary.includes("potassium"), "the notice is the fact, not the chart");
  } finally {
    cleanup();
  }
});

test("a proxy enrolment still needs an expiry", () => {
  const { enrolment, access, cleanup } = clinic();
  try {
    assert.throws(
      () =>
        enrolment.request({
          patientId: P,
          subjectId: "parent-1",
          relationship: "parent-guardian",
          by: CLERK,
        }),
      /delegated enrolment needs an expiry/
    );
    assert.throws(
      () =>
        enrolment.attestInPerson({
          patientId: P,
          subjectId: "parent-1",
          relationship: "parent-guardian",
          method: METHOD,
          by: CLERK,
          purpose: "parent of a minor",
          permissions: ["appointments"],
        }),
      /delegated enrolment needs an expiry/
    );
    assert.equal(access.whoCanSee(P).length, 0, "and nothing was written");

    const done = enrolment.attestInPerson({
      patientId: P,
      subjectId: "parent-1",
      relationship: "parent-guardian",
      method: METHOD,
      by: CLERK,
      purpose: "parent of a minor",
      permissions: ["appointments"],
      expiresAt: inDays(400),
    });
    assert.equal(done.status, "attested");
    assert.ok(access.may("parent-1", P));
    assert.ok(access.authority(done.authority_id!)!.expires_at);
  } finally {
    cleanup();
  }
});

test("one custodian cannot attest enrolment for another's patient", async () => {
  const engine = new Engine({ dbPath: ":memory:", tickMs: 15 });
  await engine.start();
  try {
    engine.db.createTenant("north", "Northern Health");
    engine.db.createTenant("south", "Southern Health");
    const north = engine.forTenant("north");
    const south = engine.forTenant("south");
    const pending = north.enrolment.request({
      patientId: P,
      subjectId: "patient-marie",
      relationship: "self",
      by: CLERK,
    });
    assert.equal(south.enrolment.get(pending.id), undefined);
    assert.equal(south.enrolment.list().length, 0);
    assert.throws(
      () => south.enrolment.attest(pending.id, { method: METHOD, by: CLERK }),
      /no enrolment/
    );
    assert.equal(north.enrolment.get(pending.id)!.status, "pending");
    assert.equal(north.patientAccess.may("patient-marie", P), undefined);
    assert.equal(south.patientAccess.may("patient-marie", P), undefined);
  } finally {
    await engine.stop();
  }
});

test("a patient notice is published as fact, not the record", () => {
  const { db, notices, cleanup } = clinic("patient-notices");
  try {
    const notice = notices.queue({
      patientId: P,
      kind: "result-released",
      aboutId: "result-1",
      summary: "A laboratory result is now available in your record. Reference result-1.",
    });
    assert.equal(notice.status, "dispatched");
    const raw = db.getMessage(notice.message_id!)!.raw;
    assert.ok(!raw.includes("5.9"), "a result value has no field to sit in");
    assert.ok(!raw.toLowerCase().includes("potassium"));
    const payload = JSON.parse(raw) as PatientNoticePayload;
    assert.deepEqual(Object.keys(payload).sort(), [
      "aboutId",
      "kind",
      "noticeId",
      "patientId",
      "summary",
      "type",
    ]);
    assert.equal(payload.type, "patient-notice");
    assert.equal(payload.kind, "result-released");
    assert.equal(payload.patientId, P);
    assert.equal(payload.summary, notice.summary);
  } finally {
    cleanup();
  }
});

test("dispatching a patient notice does not mark the patient told", () => {
  const { notices, cleanup } = clinic("patient-notices");
  try {
    const notice = notices.queue({
      patientId: P,
      kind: "enrolment-attested",
      summary: "Your clinic has attested your identity and bound this account to your chart.",
    });
    assert.equal(notice.status, "dispatched");
    assert.ok(notice.dispatched_at);
    assert.equal(notice.told_at, null, "sent is not told");
    assert.equal(notices.untold().length, 1);
    assert.equal(notices.undelivered().length, 0);

    const again = notices.dispatch(notice.id);
    assert.equal(again.dispatched_at, notice.dispatched_at, "a second dispatch is not a second send");
    assert.equal(again.told_at, null);

    const told = notices.markTold(notice.id, { actorId: CLERK.actorId });
    assert.equal(told.status, "told");
    assert.ok(told.told_at);
    assert.equal(told.told_by, CLERK.actorId);
    assert.equal(notices.untold().length, 0);
  } finally {
    cleanup();
  }
});

test("a patient notice that cannot be sent is a visible failure, not a silent one", () => {
  const { notices, cleanup } = clinic();
  try {
    const notice = notices.queue({
      patientId: P,
      kind: "request-completed",
      summary: "Your access request was completed. Reference req-1.",
    });
    assert.equal(notice.status, "failed", "no channel is a failed send, not a quiet skip");
    assert.ok(notice.error);
    assert.equal(notice.dispatched_at, null);
    assert.equal(notice.told_at, null);
    assert.equal(notices.undelivered().length, 1);
    assert.equal(notices.untold().length, 1);
  } finally {
    cleanup();
  }
});
