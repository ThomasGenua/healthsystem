/**
 * Results that cannot be read by nobody.
 *
 * Section 4 is about two silences. An order placed and never resulted is the
 * lab never reporting. A result reported and never read is the report arriving
 * and landing on no one. Both end with a clinician believing the question was
 * answered, and neither raises an error.
 *
 * The test this file is built around is the corrected result. Laboratories
 * correct values, and a correction can turn a number nobody needed to act on
 * into one somebody urgently does. If acknowledgement attaches to the order,
 * or to a result identity a correction reuses, the corrected value inherits
 * the sign-off given to the value it replaced — and the chart then shows a
 * potassium of 7.1 marked reviewed by a clinician who never saw it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../src/db.ts";
import { OrderStore } from "../src/orders/store.ts";

function lab(): { db: Db; orders: OrderStore; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "northstar-orders-"));
  const db = new Db(join(dir, "northstar.db"));
  return {
    db,
    orders: new OrderStore(db),
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}

const GP = { actorId: "dr-tetso", actorKind: "practitioner" };
const RESIDENT = { actorId: "dr-hale", actorKind: "practitioner" };
const ANALYSER = "stanton-lab-analyser-3";

const PAST = "2020-01-01T00:00:00Z";
const FUTURE = "2099-01-01T00:00:00Z";

const POTASSIUM = {
  patientId: "NT123456",
  category: "lab" as const,
  code: "2823-3",
  codeSystem: "http://loinc.org",
  display: "Potassium [Moles/volume] in Serum or Plasma",
  indication: "On spironolactone, six-week electrolyte check",
  by: GP,
};

function placedOrder(orders: OrderStore, responsibleId = "dr-tetso", expectedBy?: string) {
  const o = orders.create(POTASSIUM);
  return orders.place(o.id, { ...GP, responsibleId, ...(expectedBy ? { expectedBy } : {}) });
}

function normalPotassium(orderId?: string) {
  return {
    patientId: "NT123456",
    code: "2823-3",
    display: "Potassium",
    value: "4.1",
    unit: "mmol/L",
    referenceRange: "3.5-5.0",
    reportedBy: ANALYSER,
    ...(orderId ? { orderId } : {}),
  };
}

test("a corrected result does not inherit the acknowledgement of the value it replaced", () => {
  // The failure this module exists to prevent. A normal potassium is read and
  // signed off. The lab reruns the specimen and it is 7.1 — a value somebody
  // has to act on within the hour. If the sign-off carried over, the chart
  // would show a critical result marked reviewed and nobody would ever have
  // seen it.
  const { orders, cleanup } = lab();
  try {
    const order = placedOrder(orders);
    const first = orders.report(normalPotassium(order.id));
    orders.acknowledge(first.id, { ...GP, action: "Normal, no change to spironolactone" });
    assert.equal(orders.unacknowledged().length, 0, "the normal value was genuinely read");

    const corrected = orders.correct(first.id, {
      value: "7.1",
      abnormalFlag: "critical-high",
      reportedBy: ANALYSER,
    });

    assert.equal(corrected.acknowledged_at, null, "the correction arrives unread");
    assert.equal(corrected.acknowledged_by, null);
    assert.equal(corrected.supersedes, first.id);

    const queue = orders.unacknowledged();
    assert.equal(queue.length, 1, "and it is back on somebody's list");
    assert.equal(queue[0].id, corrected.id);
    assert.equal(queue[0].value, "7.1");

    // The old row keeps its acknowledgement, because that part is true: that
    // clinician did read that value. What is false is that anyone read this one.
    assert.equal(orders.result(first.id)!.acknowledged_by, "dr-tetso");
  } finally {
    cleanup();
  }
});

test("a critical value is on a different clock from a routine one", () => {
  // A panic value and a normal one on the same queue, sorted by arrival, is
  // how the critical potassium ends up under forty unremarkable ones.
  const { orders, cleanup } = lab();
  try {
    const routine = placedOrder(orders);
    orders.report({ ...normalPotassium(routine.id), reportedAt: "2026-01-01T09:00:00Z" });

    const urgent = orders.create({ ...POTASSIUM, code: "6299-2", display: "Urea" });
    orders.place(urgent.id, { ...GP, responsibleId: "dr-tetso" });
    const critical = orders.report({
      patientId: "NT123456",
      orderId: urgent.id,
      code: "6299-2",
      display: "Urea",
      value: "42.0",
      unit: "mmol/L",
      abnormalFlag: "critical-high",
      reportedBy: ANALYSER,
      reportedAt: "2026-01-01T11:00:00Z",
    });

    const queue = orders.unacknowledged();
    assert.equal(queue[0].id, critical.id, "most abnormal first, not most recent");
    assert.equal(queue[1].value, "4.1");

    // An hour for a panic value, three days for a normal one.
    assert.equal(orders.result(critical.id)!.ack_due_by, "2026-01-01T12:00:00.000Z");
    assert.equal(queue[1].ack_due_by, "2026-01-04T09:00:00.000Z");

    // And overdue is a query, so an alert is a threshold on a number.
    const overdue = orders.unacknowledged({ overdueAsOf: "2026-01-01T13:00:00Z" });
    assert.deepEqual(overdue.map((r) => r.id), [critical.id], "only the panic value is late yet");
  } finally {
    cleanup();
  }
});

test("acknowledging says what was done, not merely that a screen was seen", () => {
  const { orders, cleanup } = lab();
  try {
    const order = placedOrder(orders);
    const r = orders.report(normalPotassium(order.id));

    assert.throws(() => orders.acknowledge(r.id, { ...GP, action: "" }), /needs to say what was done/);
    assert.throws(() => orders.acknowledge(r.id, { ...GP, action: "  " }), /needs to say what was done/);
    assert.equal(orders.unacknowledged().length, 1, "and the refusal left it on the list");

    const done = orders.acknowledge(r.id, { ...GP, action: "Patient telephoned, attending this afternoon" });
    assert.equal(done.acknowledged_by, "dr-tetso");
    assert.match(done.acknowledgement_action!, /telephoned/);
    assert.throws(() => orders.acknowledge(r.id, { ...RESIDENT, action: "again" }), /already been acknowledged/);
  } finally {
    cleanup();
  }
});

test("a superseded result cannot be signed off, so the queue cannot be cleared with a stale number", () => {
  // Otherwise the obvious mistake clears the list: the clinician sees the
  // older row, acknowledges it, and the current value stays unread while the
  // inbox reports nothing outstanding.
  const { orders, cleanup } = lab();
  try {
    const order = placedOrder(orders);
    const first = orders.report(normalPotassium(order.id));
    const corrected = orders.correct(first.id, { value: "7.1", abnormalFlag: "critical-high", reportedBy: ANALYSER });

    assert.throws(
      () => orders.acknowledge(first.id, { ...GP, action: "looks fine" }),
      new RegExp(`corrected; acknowledge ${corrected.id}`)
    );
    assert.equal(orders.unacknowledged().length, 1, "the current value is still owed a reader");
    assert.equal(orders.unacknowledged()[0].id, corrected.id);
  } finally {
    cleanup();
  }
});

test("a corrected result is not corrected twice from the same version", () => {
  const { orders, cleanup } = lab();
  try {
    const order = placedOrder(orders);
    const first = orders.report(normalPotassium(order.id));
    orders.correct(first.id, { value: "7.1", abnormalFlag: "critical-high", reportedBy: ANALYSER });

    assert.throws(() => orders.correct(first.id, { value: "6.0", reportedBy: ANALYSER }), /already been corrected/);
  } finally {
    cleanup();
  }
});

test("every version of a result stays readable, in order", () => {
  // "What did the chart say when the decision was made" is the question a
  // review asks, and the answer has to include the number that was wrong.
  const { orders, cleanup } = lab();
  try {
    const order = placedOrder(orders);
    const first = orders.report(normalPotassium(order.id));
    const second = orders.correct(first.id, { value: "7.1", abnormalFlag: "critical-high", reportedBy: ANALYSER });
    const third = orders.correct(second.id, { value: "6.8", abnormalFlag: "critical-high", reportedBy: ANALYSER });

    const chain = orders.resultHistory(second.id);
    assert.deepEqual(chain.map((r) => r.value), ["4.1", "7.1", "6.8"], "reachable from any version");
    assert.deepEqual(orders.resultHistory(first.id).map((r) => r.value), ["4.1", "7.1", "6.8"]);
    assert.equal(orders.unacknowledged().length, 1);
    assert.equal(orders.unacknowledged()[0].id, third.id, "only the current one is owed a reader");
  } finally {
    cleanup();
  }
});

test("a result with no order is kept and queued, not refused", () => {
  // From another facility, or against an order placed on paper. Refusing it
  // would lose a real result about a real patient.
  const { orders, cleanup } = lab();
  try {
    const loose = orders.report(normalPotassium());
    assert.equal(loose.order_id, null);
    assert.deepEqual(orders.unmatched().map((r) => r.id), [loose.id]);
    assert.equal(orders.unacknowledged().length, 1, "and it still needs reading");

    const order = placedOrder(orders);
    const matched = orders.match(loose.id, order.id, GP);
    assert.equal(matched.order_id, order.id);
    assert.equal(orders.unmatched().length, 0);
    assert.throws(() => orders.match(loose.id, order.id, GP), /already filed against/);
  } finally {
    cleanup();
  }
});

test("a result is never filed against another patient's order", () => {
  // The one mismatch never worth resolving automatically. A result on the
  // wrong chart is the harm the whole module is about.
  const { orders, cleanup } = lab();
  try {
    const mine = placedOrder(orders);
    // The refusal names the identifier the caller supplied and refuses to
    // name the one they did not. Somebody filing onto the wrong chart must
    // not learn whose chart it is from the error that stopped them, and the
    // trail row — which holds PHI by design — carries both.
    assert.throws(
      () => orders.report({ ...normalPotassium(mine.id), patientId: "NT999" }),
      (err: Error) =>
        /result is for NT999 but order .* is for a different patient/.test(err.message) &&
        !err.message.includes("NT123456")
    );
    assert.equal(orders.resultsFor(mine.id).length, 0, "and nothing was written");

    const loose = orders.report({ ...normalPotassium(), patientId: "NT999" });
    assert.throws(
      () => orders.match(loose.id, mine.id, GP),
      (err: Error) => /result is for NT999 but order/.test(err.message) && !err.message.includes("NT123456")
    );
  } finally {
    cleanup();
  }
});

test("an order placed and never resulted is the other silence", () => {
  // Harder to notice than an unread result, because nothing arrives at all.
  const { orders, cleanup } = lab();
  try {
    const late = placedOrder(orders, "dr-tetso", PAST);
    const pending = placedOrder(orders, "dr-tetso", FUTURE);
    const answered = placedOrder(orders, "dr-tetso", PAST);
    orders.report(normalPotassium(answered.id));

    assert.deepEqual(orders.awaitingResult().map((o) => o.id), [late.id], "past due and nothing came back");
    assert.equal(orders.get(pending.id)!.status, "placed");
    assert.equal(orders.get(answered.id)!.status, "completed", "a final result answers the order");
    assert.equal(
      orders.unacknowledged().length,
      1,
      "but completing the order does not mean anybody read the result"
    );
  } finally {
    cleanup();
  }
});

test("a preliminary result starts no acknowledgement clock and leaves the order open", () => {
  const { orders, cleanup } = lab();
  try {
    const order = placedOrder(orders, "dr-tetso", PAST);
    const prelim = orders.report({ ...normalPotassium(order.id), resultStatus: "preliminary", value: "4.0" });

    assert.equal(prelim.ack_due_by, null, "not yet something to sign off");
    assert.equal(orders.get(order.id)!.status, "placed", "the question is not answered yet");
    assert.deepEqual(orders.awaitingResult().map((o) => o.id), [order.id]);

    orders.report(normalPotassium(order.id));
    assert.equal(orders.get(order.id)!.status, "completed");
    assert.equal(orders.awaitingResult().length, 0);
  } finally {
    cleanup();
  }
});

test("responsibility for reading a result moves with the person, and to a person", () => {
  // Residents rotate. A result routed to whoever typed the order three weeks
  // ago goes to an inbox nobody opens.
  const { orders, cleanup } = lab();
  try {
    const o = orders.create(POTASSIUM);
    assert.throws(() => orders.place(o.id, { ...GP, responsibleId: "" }), /needs somebody responsible/);
    orders.place(o.id, { ...RESIDENT, responsibleId: "dr-hale" });
    orders.report(normalPotassium(o.id));

    assert.equal(orders.unacknowledged({ responsibleId: "dr-hale" }).length, 1);
    assert.equal(orders.unacknowledged({ responsibleId: "dr-tetso" }).length, 0);

    assert.throws(() => orders.handover(o.id, "", { ...GP, reason: "rotation" }), /somebody to hand over to/);
    assert.throws(() => orders.handover(o.id, "dr-tetso", { ...GP, reason: "" }), /needs a reason/);

    orders.handover(o.id, "dr-tetso", { ...GP, reason: "dr-hale rotated off internal medicine" });
    assert.equal(orders.unacknowledged({ responsibleId: "dr-tetso" }).length, 1, "it follows the responsibility");
    assert.equal(orders.unacknowledged({ responsibleId: "dr-hale" }).length, 0);
    assert.match(orders.history(o.id).at(-1)!.detail ?? "", /dr-hale to dr-tetso: dr-hale rotated off/);
  } finally {
    cleanup();
  }
});

test("an order needs an indication, and a cancellation needs a reason", () => {
  const { orders, cleanup } = lab();
  try {
    assert.throws(() => orders.create({ ...POTASSIUM, indication: "" }), /needs an indication/);
    assert.throws(() => orders.create({ ...POTASSIUM, indication: "   " }), /needs an indication/);

    const o = placedOrder(orders);
    assert.throws(() => orders.cancel(o.id, { ...GP, reason: "" }), /needs a reason/);
    assert.equal(orders.get(o.id)!.status, "placed", "the refusal left it open");

    orders.cancel(o.id, { ...GP, reason: "patient declined the blood test" });
    assert.equal(orders.get(o.id)!.status, "cancelled");
    assert.throws(() => orders.cancel(o.id, { ...GP, reason: "again" }), /already cancelled/);
    assert.equal(orders.awaitingResult(FUTURE).length, 0, "and a cancelled order is not chased");
  } finally {
    cleanup();
  }
});

test("the whole path is on the record, with who moved it", () => {
  const { orders, cleanup } = lab();
  try {
    const o = orders.create(POTASSIUM);
    orders.place(o.id, { ...GP, responsibleId: "dr-tetso" });
    orders.start(o.id, { actorId: "stanton-lab", actorKind: "organization" }, "specimen received");
    const r = orders.report(normalPotassium(o.id));
    orders.acknowledge(r.id, { ...GP, action: "Normal, continue current dose" });

    assert.deepEqual(
      orders.history(o.id).map((e) => e.event),
      ["created", "placed", "in-progress", "result-reported", "completed", "result-acknowledged"]
    );
    const ack = orders.history(o.id).at(-1)!;
    assert.equal(ack.actor_id, "dr-tetso");
    assert.match(ack.detail ?? "", /continue current dose/);
    assert.equal(orders.history(o.id)[3].actor_id, ANALYSER, "the analyser reported; a person acknowledged");
  } finally {
    cleanup();
  }
});

test("transitions out of order are refused rather than silently accepted", () => {
  const { orders, cleanup } = lab();
  try {
    const o = orders.create(POTASSIUM);
    assert.throws(() => orders.start(o.id, GP), /a draft order cannot be started/);
    orders.place(o.id, { ...GP, responsibleId: "dr-tetso" });
    assert.throws(() => orders.place(o.id, { ...GP, responsibleId: "dr-hale" }), /cannot be placed again/);
    assert.throws(() => orders.acknowledge("no-such-result", { ...GP, action: "x" }), /no result/);
  } finally {
    cleanup();
  }
});

test("orders and results are confined to their tenant", () => {
  const dir = mkdtempSync(join(tmpdir(), "northstar-orders-iso-"));
  const root = new Db(join(dir, "northstar.db"));
  try {
    root.createTenant("north", "Northern Health");
    root.createTenant("south", "Southern Health");
    const north = new OrderStore(root.forTenant("north"));
    const south = new OrderStore(root.forTenant("south"));

    // The same health number at two custodians: a province issues it, so this
    // is the normal case rather than an edge one.
    const n = north.create(POTASSIUM);
    north.place(n.id, { ...GP, responsibleId: "dr-tetso", expectedBy: PAST });
    const nr = north.report({ ...normalPotassium(n.id), value: "7.1", abnormalFlag: "critical-high" });
    south.create(POTASSIUM);

    assert.equal(north.unacknowledged().length, 1);
    assert.equal(south.unacknowledged().length, 0, "one custodian's unread result is not another's");
    assert.equal(south.awaitingResult().length, 0);
    assert.equal(south.result(nr.id), undefined);
    assert.equal(south.get(n.id), undefined);
    assert.throws(() => south.acknowledge(nr.id, { ...GP, action: "reaching" }), /no result/);
    assert.equal(north.unmatched().length, 0);
  } finally {
    root.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
