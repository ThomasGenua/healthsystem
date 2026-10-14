/**
 * A patient question that can vanish is not messaging.
 *
 * Closing without a reason, deleting the body, or leaving a thread owned by
 * nobody are the three ways a renewal request is lost without anyone doing
 * anything wrong. These pin the refusals that make those silences visible.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../src/db.ts";
import { Directory } from "../src/directory/store.ts";
import { CareTeam } from "../src/clinical/careteam.ts";
import { PatientMessaging } from "../src/patient/messaging.ts";
import { Refusal } from "../src/core/refusal.ts";

function clinic() {
  const dir = mkdtempSync(join(tmpdir(), "northstar-msg-"));
  const db = new Db(join(dir, "northstar.db"));
  new Directory(db).addPractitioner({ id: "dr-tetso", family: "Tetso", given: "Jean" });
  new CareTeam(db).assign({
    patientId: "NT123456",
    practitionerId: "dr-tetso",
    role: "primary",
    by: { actorId: "ops" },
  });
  return {
    db,
    msg: new PatientMessaging(db),
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}

const P = "NT123456";
const CLERK = { actorId: "clerk-anne", actorKind: "practitioner" };
const GP = { actorId: "dr-tetso", actorKind: "practitioner" };

test("a patient message lands on the primary's inbox, not as unowned silence", () => {
  const { msg, cleanup } = clinic();
  try {
    const { thread, message } = msg.open({
      patientId: P,
      subject: "Renewal — metformin",
      body: "Please renew my metformin, last fill was six weeks ago.",
      authorKind: "patient",
      by: { actorId: P, actorKind: "patient" },
    });
    assert.equal(thread.status, "awaiting-clinic");
    assert.equal(thread.owner_id, "dr-tetso", "the MRP is who owes the reply");
    assert.equal(message.author_kind, "patient");
    assert.equal(msg.inbox("dr-tetso").length, 1);
    assert.equal(msg.unassigned().length, 0);
  } finally {
    cleanup();
  }
});

test("a subject without a body, or a body without a subject, is refused", () => {
  const { msg, cleanup } = clinic();
  try {
    assert.throws(
      () => msg.open({ patientId: P, subject: "Renewal", body: "  ", authorKind: "patient", by: CLERK }),
      Refusal
    );
    assert.throws(
      () => msg.open({ patientId: P, subject: "  ", body: "Please renew", authorKind: "patient", by: CLERK }),
      Refusal
    );
  } finally {
    cleanup();
  }
});

test("closing a thread the patient is still waiting on needs to say what was done", () => {
  const { msg, cleanup } = clinic();
  try {
    const { thread } = msg.open({
      patientId: P,
      subject: "Potassium result",
      body: "What does 5.2 mean?",
      authorKind: "patient",
      by: { actorId: P, actorKind: "patient" },
    });
    assert.throws(() => msg.close(thread.id, { ...GP, reason: "done" }), Refusal);
    const closed = msg.close(thread.id, {
      ...GP,
      reason: "phoned the patient; explained the potassium is acceptable; no written reply",
    });
    assert.equal(closed.status, "closed");
    assert.match(closed.close_reason ?? "", /phoned/);
    assert.equal(msg.inbox("dr-tetso").length, 0);
    assert.equal(msg.forPatient(P, { includeClosed: true }).length, 1);
    assert.equal(msg.forPatient(P).length, 0, "a closed thread is not outstanding work");
  } finally {
    cleanup();
  }
});

test("a reply on a closed thread is refused so the close is not silently undone", () => {
  const { msg, cleanup } = clinic();
  try {
    const { thread } = msg.open({
      patientId: P,
      subject: "Hours",
      body: "Are you open Saturday?",
      authorKind: "clerk",
      by: CLERK,
    });
    msg.reply(thread.id, { body: "Yes, 9 to 12.", authorKind: "practitioner", by: GP });
    msg.close(thread.id, { ...GP, reason: "answered; no follow-up needed" });
    assert.throws(() => msg.reply(thread.id, { body: "thanks", authorKind: "patient", by: { actorId: P, actorKind: "patient" } }), Refusal);
    const reopened = msg.reopen(thread.id, { ...GP, reason: "patient called back" });
    assert.equal(reopened.status, "awaiting-patient");
    const again = msg.reply(thread.id, {
      body: "Can I book?",
      authorKind: "patient",
      by: { actorId: P, actorKind: "patient" },
    });
    assert.equal(again.author_kind, "patient");
    assert.equal(msg.get(thread.id)?.status, "awaiting-clinic");
  } finally {
    cleanup();
  }
});

test("an unowned patient message is a list, not a missing inbox", () => {
  const dir = mkdtempSync(join(tmpdir(), "northstar-msg-none-"));
  const db = new Db(join(dir, "northstar.db"));
  try {
    const msg = new PatientMessaging(db);
    msg.open({
      patientId: "NT-other",
      subject: "Question",
      body: "Do I need fasting bloods?",
      authorKind: "patient",
      by: { actorId: "NT-other", actorKind: "patient" },
    });
    assert.equal(msg.unassigned().length, 1);
    assert.equal(msg.inbox("dr-tetso").length, 0);
    const id = msg.unassigned()[0].id;
    msg.assign(id, "dr-tetso", { ...CLERK, reason: "picked up from the unowned queue" });
    assert.equal(msg.unassigned().length, 0);
    assert.equal(msg.inbox("dr-tetso")[0].id, id);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("urgent threads sort ahead of routine, oldest first inside a priority", () => {
  const { msg, cleanup } = clinic();
  try {
    msg.open({
      patientId: P,
      subject: "Routine refill",
      body: "When you can.",
      authorKind: "patient",
      priority: "routine",
      by: { actorId: P, actorKind: "patient" },
    });
    const urgent = msg.open({
      patientId: P,
      subject: "Chest pain question",
      body: "Should I go in?",
      authorKind: "patient",
      priority: "urgent",
      by: { actorId: P, actorKind: "patient" },
    });
    const inbox = msg.inbox("dr-tetso");
    assert.equal(inbox[0].id, urgent.thread.id);
    assert.equal(inbox[0].priority, "urgent");
  } finally {
    cleanup();
  }
});

test("one custodian cannot read another's threads", () => {
  const dir = mkdtempSync(join(tmpdir(), "northstar-msg-iso-"));
  const root = new Db(join(dir, "northstar.db"));
  try {
    root.createTenant("north", "Northern Health");
    root.createTenant("south", "Southern Health");
    const north = new PatientMessaging(root.forTenant("north"));
    const south = new PatientMessaging(root.forTenant("south"));
    north.open({
      patientId: P,
      subject: "Private",
      body: "About the biopsy.",
      authorKind: "patient",
      by: { actorId: P, actorKind: "patient" },
    });
    assert.equal(north.forPatient(P).length, 1);
    assert.equal(south.forPatient(P).length, 0);
    assert.equal(south.unassigned().length, 0);
  } finally {
    root.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
