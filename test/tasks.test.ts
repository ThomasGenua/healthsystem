/**
 * Work that cannot disappear between people.
 *
 * Section 8 asks for exactly one guarantee, and it is not a feature: clinically
 * important work must not be lost between people or organizations. Work is
 * rarely lost by deletion. It is lost by being handed to somebody who has
 * left, closed with nothing to show for it, or owned by nobody — which means it
 * is on nobody's list and is therefore invisible in the way that matters.
 *
 * So these tests try to lose a task, in each of the ways a real clinic loses
 * one, and require it to stay findable.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../src/db.ts";
import { TaskStore } from "../src/work/tasks.ts";

function desk(): { db: Db; tasks: TaskStore; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "northstar-tasks-"));
  const db = new Db(join(dir, "northstar.db"));
  return {
    db,
    tasks: new TaskStore(db),
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const NURSE = { actorId: "rn-lafferty", actorKind: "practitioner" };
const DOCTOR = { actorId: "dr-tetso", actorKind: "practitioner" };
const FEED = { actorId: "lab-interface", actorKind: "device" };

const RESULT = {
  kind: "result-review" as const,
  title: "Potassium 6.8 mmol/L",
  patientId: "NT123456",
  priority: "stat" as const,
  by: FEED,
  source: "Dynacare ORU",
  sourceMessageId: "msg-7",
};

test("a released item lands in a queue someone can see, not in nothing", () => {
  // The commonest way work is lost: it stops belonging to anyone. Absence is
  // invisible, so unowned has to be a list.
  const { tasks, cleanup } = desk();
  try {
    const t = tasks.create({ ...RESULT, ownerId: "dr-tetso" });
    assert.equal(tasks.inbox("dr-tetso").length, 1);
    assert.equal(tasks.unassigned().length, 0);

    tasks.release(t.id, { ...DOCTOR, reason: "off service from today" });

    assert.equal(tasks.inbox("dr-tetso").length, 0, "it has left their list");
    assert.deepEqual(
      tasks.unassigned().map((x) => x.id),
      [t.id],
      "and it is on the one that exists so nothing belongs to nobody"
    );
    assert.equal(tasks.load().unassigned, 1);
  } finally {
    cleanup();
  }
});

test("an item created with no owner is visible from the moment it arrives", () => {
  // A result arriving overnight belongs to nobody until someone picks it up.
  // That is normal, and it must not mean invisible.
  const { tasks, cleanup } = desk();
  try {
    tasks.create(RESULT);
    assert.equal(tasks.unassigned().length, 1);
    assert.equal(tasks.forPatient("NT123456").length, 1, "and it shows on the chart as outstanding");
  } finally {
    cleanup();
  }
});

test("reassignment records both ends, so who had it is answerable later", () => {
  // An owner column knows who has it now. "Who had this when it went wrong"
  // is the question actually asked, and only the history can answer it.
  const { tasks, cleanup } = desk();
  try {
    const t = tasks.create({ ...RESULT, ownerId: "rn-lafferty" });
    tasks.assign(t.id, "dr-tetso", { ...NURSE, reason: "needs a prescriber" });
    tasks.assign(t.id, "dr-hale", { ...DOCTOR, reason: "handover at 1900" });

    const history = tasks.history(t.id);
    assert.deepEqual(
      history.map((e) => e.event),
      ["created", "reassigned", "reassigned"]
    );
    assert.equal(history[1].from_owner, "rn-lafferty");
    assert.equal(history[1].to_owner, "dr-tetso");
    assert.equal(history[2].from_owner, "dr-tetso");
    assert.equal(history[2].to_owner, "dr-hale");
    assert.match(history[2].detail ?? "", /handover at 1900/);
    assert.equal(history[1].actor_id, "rn-lafferty", "and who moved it, not just where it went");
  } finally {
    cleanup();
  }
});

test("completing an item requires evidence of what was done", () => {
  // The distinction a review of a missed diagnosis turns on: "the result was
  // acknowledged" versus "the result was marked acknowledged".
  const { tasks, cleanup } = desk();
  try {
    const t = tasks.create({ ...RESULT, ownerId: "dr-tetso" });
    assert.throws(() => tasks.complete(t.id, { ...DOCTOR, evidence: "   " }), /needs evidence/);
    assert.equal(tasks.get(t.id)!.status, "open", "and a refused completion leaves it open");

    tasks.complete(t.id, { ...DOCTOR, evidence: "Patient called, repeat drawn, note ab12cd" });
    const closed = tasks.get(t.id)!;
    assert.equal(closed.status, "completed");
    assert.ok(closed.closed_at);
    assert.match(tasks.history(t.id).at(-1)!.evidence ?? "", /repeat drawn/);
  } finally {
    cleanup();
  }
});

test("cancelling is not completing, and both are recorded with a reason", () => {
  // "We decided not to" and "we did it" are different answers to an audit,
  // and only one of them is aftercare.
  const { tasks, cleanup } = desk();
  try {
    const t = tasks.create({ ...RESULT, ownerId: "dr-tetso" });
    assert.throws(() => tasks.cancel(t.id, { ...DOCTOR, reason: "" }), /needs a reason/);

    tasks.cancel(t.id, { ...DOCTOR, reason: "duplicate of the 0300 result" });
    assert.equal(tasks.get(t.id)!.status, "cancelled");
    assert.match(tasks.history(t.id).at(-1)!.detail ?? "", /duplicate of the 0300/);

    assert.throws(() => tasks.complete(t.id, { ...DOCTOR, evidence: "done" }), /cancelled task cannot be completed/);
  } finally {
    cleanup();
  }
});

test("nothing is ever removed: a closed item is still there, and can be reopened", () => {
  const { db, tasks, cleanup } = desk();
  try {
    const t = tasks.create({ ...RESULT, ownerId: "dr-tetso" });
    tasks.complete(t.id, { ...DOCTOR, evidence: "acknowledged" });

    const count = db.sql.prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number };
    assert.equal(count.n, 1, "closing is a status, not a delete");

    tasks.reopen(t.id, { ...NURSE, reason: "result amended by the lab" });
    assert.equal(tasks.get(t.id)!.status, "open");
    assert.equal(tasks.get(t.id)!.closed_at, null);
    assert.deepEqual(
      tasks.history(t.id).map((e) => e.event),
      ["created", "completed", "reopened"],
      "and the whole path is on the record"
    );
  } finally {
    cleanup();
  }
});

test("a closed item cannot be quietly reassigned to look open", () => {
  const { tasks, cleanup } = desk();
  try {
    const t = tasks.create({ ...RESULT, ownerId: "dr-tetso" });
    tasks.complete(t.id, { ...DOCTOR, evidence: "acknowledged" });
    assert.throws(() => tasks.assign(t.id, "dr-hale", DOCTOR), /completed task cannot be reassigned/);
  } finally {
    cleanup();
  }
});

test("an inbox is ordered by urgency and deadline, not by arrival", () => {
  // The mechanism by which a critical result is missed with nobody doing
  // anything wrong: it arrives first and forty routine items arrive after it.
  const { tasks, cleanup } = desk();
  try {
    tasks.create({ kind: "message", title: "routine, no deadline", by: NURSE, ownerId: "dr-tetso" });
    tasks.create({
      kind: "form",
      title: "routine, due soon",
      by: NURSE,
      ownerId: "dr-tetso",
      dueAt: "2026-08-06T00:00:00Z",
    });
    tasks.create({ kind: "referral", title: "urgent", by: NURSE, ownerId: "dr-tetso", priority: "urgent" });
    tasks.create({ ...RESULT, ownerId: "dr-tetso" });

    assert.deepEqual(
      tasks.inbox("dr-tetso").map((t) => t.title),
      ["Potassium 6.8 mmol/L", "urgent", "routine, due soon", "routine, no deadline"]
    );
  } finally {
    cleanup();
  }
});

test("escalation raises priority and says who decided", () => {
  const { tasks, cleanup } = desk();
  try {
    const t = tasks.create({ kind: "referral", title: "ortho referral", by: NURSE, ownerId: "dr-tetso" });
    tasks.escalate(t.id, "urgent", { ...NURSE, reason: "six weeks with no triage response" });

    assert.equal(tasks.get(t.id)!.priority, "urgent");
    const last = tasks.history(t.id).at(-1)!;
    assert.equal(last.event, "escalated");
    assert.match(last.detail ?? "", /routine to urgent: six weeks/);
    assert.equal(last.actor_id, "rn-lafferty");
  } finally {
    cleanup();
  }
});

test("overdue work surfaces regardless of who holds it", () => {
  const { tasks, cleanup } = desk();
  try {
    tasks.create({ kind: "form", title: "past due, owned", by: NURSE, ownerId: "dr-tetso", dueAt: "2020-01-01T00:00:00Z" });
    tasks.create({ kind: "form", title: "past due, unowned", by: NURSE, dueAt: "2019-01-01T00:00:00Z" });
    tasks.create({ kind: "form", title: "not due", by: NURSE, ownerId: "dr-tetso", dueAt: "2099-01-01T00:00:00Z" });

    assert.deepEqual(
      tasks.overdue().map((t) => t.title),
      ["past due, unowned", "past due, owned"],
      "most overdue first, and an unowned one is not excused"
    );
    assert.equal(tasks.load().overdue, 2);
  } finally {
    cleanup();
  }
});

test("a loop is recognisable across items by its correlation id", () => {
  // A referral raised here and the consult report that answers it later are
  // two items and one question. Without this, closing the loop is manual.
  const { tasks, cleanup } = desk();
  try {
    const ref = tasks.create({
      kind: "referral",
      title: "ortho referral",
      by: NURSE,
      patientId: "NT123456",
      correlationId: "ref-991",
    });
    const reply = tasks.create({
      kind: "document",
      title: "consult report received",
      by: FEED,
      patientId: "NT123456",
      correlationId: "ref-991",
    });

    assert.deepEqual(
      tasks.correlated("ref-991").map((t) => t.id),
      [ref.id, reply.id]
    );
  } finally {
    cleanup();
  }
});

test("provenance ties an item back to the message that raised it", () => {
  const { tasks, cleanup } = desk();
  try {
    const t = tasks.create(RESULT);
    assert.equal(t.source, "Dynacare ORU");
    assert.equal(t.source_message_id, "msg-7");
    assert.equal(tasks.history(t.id)[0].actor_kind, "device", "raised by an interface, not by a person");
  } finally {
    cleanup();
  }
});

test("inboxes are confined to their tenant", () => {
  const dir = mkdtempSync(join(tmpdir(), "northstar-tasks-iso-"));
  const root = new Db(join(dir, "northstar.db"));
  try {
    root.createTenant("north", "Northern Health");
    root.createTenant("south", "Southern Health");
    const north = new TaskStore(root.forTenant("north"));
    const south = new TaskStore(root.forTenant("south"));

    // The same clinician name and the same patient number at both, which is
    // the normal case: people locum, and health numbers are provincial.
    const n = north.create({ ...RESULT, ownerId: "dr-tetso" });
    south.create({ ...RESULT, title: "Sodium 128", ownerId: "dr-tetso" });

    assert.deepEqual(north.inbox("dr-tetso").map((t) => t.title), ["Potassium 6.8 mmol/L"]);
    assert.deepEqual(south.inbox("dr-tetso").map((t) => t.title), ["Sodium 128"]);
    assert.equal(north.forPatient("NT123456").length, 1);
    assert.equal(south.get(n.id), undefined, "and an item id from one custodian is not addressable from the other");
    assert.throws(() => south.complete(n.id, { ...DOCTOR, evidence: "reaching" }), /no task/);
  } finally {
    root.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
