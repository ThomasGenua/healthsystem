/**
 * An offer nobody answered, accepted months later.
 *
 * `propose` does not move work; `accept` does. Until this, `accept` checked
 * only that the status was still `proposed`, so an offer made in March could
 * be accepted in November — and accepting it **took the item off the
 * proposer's list**. Somebody who offered a follow-up, heard nothing, and
 * dealt with it themselves would find it gone from their inbox because the
 * other person cleared an old notification. Neither of them is watching it
 * after that.
 *
 * Measured before the fix, on an offer backdated 245 days: accepted, owner
 * moved to the accepter, proposer's inbox 0.
 *
 * Lapsing is computed from `proposed_at`, never written. Coverage reverts the
 * same way and for the same reason: a state something has to write is a job
 * that can fail, and a job that fails here leaves March's offer live in
 * November. Arithmetic cannot fail to run.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Db } from "../src/db.ts";
import { Handoffs, PROPOSAL_LIFE_HOURS } from "../src/work/discharge.ts";
import { TaskStore } from "../src/work/tasks.ts";
import { Refusal } from "../src/core/refusal.ts";

const A = "dr-aput";
const B = "dr-beaulieu";
const P = "NT123456";
const by = { actorId: A, actorKind: "practitioner" };
const them = { actorId: B, actorKind: "practitioner" };
const HOUR = 3600_000;

function site(opts: { proposalLifeHours?: number } = {}) {
  const db = new Db(":memory:");
  const handoffs = new Handoffs(db, opts);
  const tasks = new TaskStore(db);
  tasks.useOwnershipRecord(handoffs);
  const newTask = (title = "Chase the biopsy result") =>
    tasks.create({ kind: "result-review", title, by, patientId: P, ownerId: A });
  const task = newTask();
  // One live proposal per subject is an invariant here, so an offer wanting
  // to coexist with another needs a subject of its own.
  const offer = (subjectId = task.id) =>
    handoffs.propose({
      kind: "transfer", subjectKind: "task", subjectId, patientId: P,
      fromId: A, toId: B, reason: "covering my list", by,
    });
  /** Moves an offer into the past, the way waiting would. */
  const age = (id: string, hours: number) =>
    db.sql
      .prepare("UPDATE handoffs SET proposed_at = ? WHERE tenant_id = ? AND id = ?")
      .run(new Date(Date.now() - hours * HOUR).toISOString(), "default", id);
  return { db, handoffs, tasks, taskId: task.id, newTask, offer, age, cleanup: () => db.close() };
}

test("an offer answered the same week is accepted as before", () => {
  const s = site();
  try {
    const h = s.offer();
    s.age(h.id, 24);
    assert.equal(s.handoffs.accept(h.id, them).status, "accepted");
    assert.equal(s.tasks.heldBy(s.taskId).ownerId, B);
  } finally {
    s.cleanup();
  }
});

test("an offer nobody answered cannot be accepted months later", () => {
  // The case that was possible: 245 days old, accepted, and the item left
  // the proposer's inbox.
  const s = site();
  try {
    const h = s.offer();
    s.age(h.id, 245 * 24);
    assert.throws(
      () => s.handoffs.accept(h.id, them),
      (e: unknown) => e instanceof Refusal && e.status === 409 && /lapsed/.test(e.message)
    );
    assert.match(
      (() => {
        try {
          s.handoffs.accept(h.id, them);
          return "";
        } catch (e) {
          return (e as Error).message;
        }
      })(),
      /offer it again if it still stands/,
      "the refusal has to say what to do instead"
    );
  } finally {
    s.cleanup();
  }
});

test("a lapsed offer leaves accountability exactly where it was", () => {
  // The safety property. Lapsing must never move work -- it narrows what can
  // be accepted and nothing else, which is why a default window is safe here
  // where coverage refuses one.
  const s = site();
  try {
    const h = s.offer();
    s.age(h.id, 245 * 24);
    assert.equal(s.tasks.heldBy(s.taskId).ownerId, A, "still the proposer's");
    assert.equal(s.tasks.inbox(A).length, 1, "and still on their list");
    assert.equal(s.tasks.inbox(B).length, 0);
    assert.equal(s.handoffs.accountableFor("task", s.taskId, A).ownerId, A);
  } finally {
    s.cleanup();
  }
});

test("the boundary is the window, to the hour", () => {
  const s = site({ proposalLifeHours: 48 });
  try {
    const fresh = s.offer();
    s.age(fresh.id, 47);
    assert.equal(s.handoffs.lapsed(s.handoffs.get(fresh.id)!), false, "47 hours of a 48-hour window");

    const stale = s.offer(s.newTask("Another one").id);
    s.age(stale.id, 48);
    assert.equal(s.handoffs.lapsed(s.handoffs.get(stale.id)!), true, "48 is up");
  } finally {
    s.cleanup();
  }
});

test("a lapsed offer can still be declined and withdrawn", () => {
  // Accepting is the only answer that moves work, so it is the only one
  // lapsing blocks. Refusing to let anybody close a stale offer would leave
  // the board carrying it forever.
  const s = site();
  try {
    const one = s.offer();
    s.age(one.id, 245 * 24);
    assert.equal(s.handoffs.decline(one.id, { ...them, reason: "never saw this" }).status, "declined");

    const two = s.offer();
    s.age(two.id, 245 * 24);
    assert.equal(s.handoffs.withdraw(two.id, { ...by, reason: "dealt with it myself" }).status, "withdrawn");
  } finally {
    s.cleanup();
  }
});

test("the board is told which offers can no longer be answered", () => {
  // A list that showed both the same way would offer a button that refuses.
  const s = site();
  try {
    const fresh = s.offer();
    const stale = s.offer(s.newTask("A second thing entirely").id);
    s.age(stale.id, 245 * 24);

    const rows = s.handoffs.unaccepted();
    assert.equal(rows.length, 2, "both still need somebody to look at them");
    assert.equal(rows.find((r) => r.id === fresh.id)!.lapsed, false);
    assert.equal(rows.find((r) => r.id === stale.id)!.lapsed, true);
  } finally {
    s.cleanup();
  }
});

test("lapsing is arithmetic, so there is no sweep to fail", () => {
  // Nothing writes a status. The row is still `proposed` afterwards, which
  // is what it is: an offer nobody ever answered.
  const s = site();
  try {
    const h = s.offer();
    s.age(h.id, 245 * 24);
    try {
      s.handoffs.accept(h.id, them);
    } catch {
      /* expected */
    }
    assert.equal(s.handoffs.get(h.id)!.status, "proposed", "no state was written by asking");
    assert.equal(s.handoffs.get(h.id)!.responded_at, null, "and nobody is recorded as having answered");
  } finally {
    s.cleanup();
  }
});

test("a week is the default, and it is generous", () => {
  assert.equal(PROPOSAL_LIFE_HOURS, 168);
  const s = site();
  try {
    const h = s.offer();
    s.age(h.id, 167);
    assert.equal(s.handoffs.lapsed(s.handoffs.get(h.id)!), false, "six days and change is still answerable");
  } finally {
    s.cleanup();
  }
});
