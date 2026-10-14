/**
 * Deciding when the sweep runs, and who it runs for.
 *
 * `dispatch.ts` sends every sendable order once, and `order-dispatch.test.ts`
 * pins that. What is left is the wiring, and the wiring is where the three
 * questions live that a function nobody calls never has to answer: how often,
 * for which custodians, and out of which door.
 *
 * Two of the answers are safety properties rather than preferences.
 *
 * A reading station runs a whole engine over a restored copy of the primary's
 * database. Every channel in that copy is flipped off at fill time so the
 * station does not become a second engine sending the primary's feeds (H-39).
 * If the sweep ignored that flag it would resend every placed order in the
 * snapshot, from a machine that is not the record and cannot tell it has
 * already happened — H-164 with no way to notice.
 *
 * And a route names its laboratory as a label a human wrote, while a channel
 * names its destinations as queue identifiers. Nothing maps one to the other,
 * which is invisible with one laboratory and a coin toss with two. A
 * requisition delivered to the wrong laboratory is worse than one delivered
 * late, so the ambiguity is refused rather than resolved by guessing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer as createTcpServer } from "node:net";
import { Db } from "../src/db.ts";
import { Engine } from "../src/core/engine.ts";
import { until } from "./helpers.ts";
import { OrderStore } from "../src/orders/store.ts";
import { ClinicalRecord } from "../src/clinical/record.ts";
import {
  DEFAULT_INTERVAL_MS,
  OrderDispatchSweeper,
  labOrderDoor,
  resolveInterval,
  type SweepDeps,
} from "../src/orders/sweep.ts";
import type { LabProfile } from "../src/orders/hl7.ts";

const P = "NT123456";
const GP = { actorId: "dr-tetso", actorKind: "practitioner" };

const PROFILE: LabProfile = {
  id: "stanton",
  name: "Stanton Laboratory",
  patientAssigningAuthority: "JHN",
  defaultCodeSystem: "LN",
};

const CONNECTION = {
  host: "lab.example",
  port: 6661,
  sendingApplication: "NORTHSTAR",
  sendingFacility: "GNWT",
  receivingApplication: "LABAPP",
  receivingFacility: "STANTON",
  timezoneOffset: "-06:00",
  profileId: "stanton",
};

function labOrderChannel(id: string, destId: string, enabled = true): [string, string, boolean, string] {
  return [
    id,
    id,
    enabled,
    JSON.stringify({
      id,
      name: id,
      source: { type: "http", path: `/${id}` },
      destinations: [{ id: destId, type: "lab-order", host: "lab.example", port: 6661 }],
    }),
  ];
}

/** A site with one custodian, one laboratory route and one door out. */
function site(opts: { channels?: Array<[string, string, boolean, string]>; tenants?: string[] } = {}) {
  const db = new Db(":memory:");
  for (const c of opts.channels ?? [labOrderChannel("orders-out", "stanton-lab")]) db.upsertChannel(...c);

  const stores = new Map<string, { db: Db; orders: OrderStore; clinical: ClinicalRecord }>();
  const forTenant = (id: string) => {
    let s = stores.get(id);
    if (!s) {
      const tdb = db.forTenant(id);
      s = { db: tdb, orders: new OrderStore(tdb), clinical: new ClinicalRecord(tdb) };
      stores.set(id, s);
    }
    return s;
  };

  const setUpTenant = (id: string): void => {
    const s = forTenant(id);
    s.clinical.record({
      entryType: "Patient",
      patientId: P,
      content: {
        resourceType: "Patient",
        id: P,
        birthDate: "1984-03-17",
        name: [{ family: "Beaulieu", given: ["Marie"] }],
        identifier: [{ system: "JHN", value: P }],
      },
      authorId: "reg",
      authorKind: "system",
      source: "test",
    });
    s.orders.declareOrderRouting(
      "lab",
      { transmits: true, destination: "Stanton Laboratory", detail: "MLLP", connection: CONNECTION },
      GP
    );
  };
  for (const t of opts.tenants ?? ["default"]) setUpTenant(t);

  const deps: SweepDeps = {
    db,
    forTenant: (id) => {
      const s = forTenant(id);
      return { db: s.db, orders: s.orders, patients: s.clinical.patientIndex };
    },
    profiles: (id) => (id === "stanton" ? PROFILE : undefined),
  };

  return {
    db,
    deps,
    orders: (tenant = "default") => forTenant(tenant).orders,
    place: (tenant = "default") => {
      const o = forTenant(tenant).orders.create({
        patientId: P,
        category: "lab",
        code: "2823-3",
        display: "Potassium",
        indication: "On spironolactone",
        by: GP,
      });
      forTenant(tenant).orders.place(o.id, { ...GP, responsibleId: "dr-tetso" });
      return o.id;
    },
    queued: (channelId = "orders-out") => db.listDeliveries({ channelId }),
    cleanup: () => db.close(),
  };
}

// --- how often -------------------------------------------------------------

test("the cadence is a minute unless a site says otherwise", () => {
  assert.equal(resolveInterval({}), DEFAULT_INTERVAL_MS);
  assert.equal(DEFAULT_INTERVAL_MS, 60_000, "measured against how fast a patient walks to the draw station");
  assert.equal(resolveInterval({ NORTHSTAR_ORDER_DISPATCH_INTERVAL_MS: "5000" }), 5_000);
  // The rename left every legacy spelling working, and this one is no
  // exception: an operator's existing environment must not silently change
  // how often their orders leave.
  assert.equal(resolveInterval({ PORTAGE_ORDER_DISPATCH_INTERVAL_MS: "5000" }), 5_000);
});

test("turning automatic send off is a declaration, not an omission", () => {
  // A site that wants a human to press send should be able to say so, and
  // saying so should look different from never having configured anything.
  assert.equal(resolveInterval({ NORTHSTAR_ORDER_DISPATCH_INTERVAL_MS: "0" }), 0);
  const s = site();
  try {
    const sweeper = new OrderDispatchSweeper(s.deps, 0);
    assert.equal(sweeper.enabled, false);
    const id = s.place();
    sweeper.start();
    assert.equal(s.queued().length, 0, "nothing left the building");
    assert.equal(s.orders().transmissionState(id).state, "not-sent");
    sweeper.stop();
  } finally {
    s.cleanup();
  }
});

test("a cadence that is not a number is refused rather than treated as absent", () => {
  // Falling back to the default would mean a typo in an operator's
  // environment silently turned automatic send back on.
  assert.throws(
    () => resolveInterval({ NORTHSTAR_ORDER_DISPATCH_INTERVAL_MS: "every minute" }),
    /non-negative number of milliseconds/
  );
  assert.throws(() => resolveInterval({ NORTHSTAR_ORDER_DISPATCH_INTERVAL_MS: "-1" }), /non-negative/);
  assert.equal(resolveInterval({ NORTHSTAR_ORDER_DISPATCH_INTERVAL_MS: "" }), DEFAULT_INTERVAL_MS);
});

test("the sweep runs at start rather than waiting out the first interval", () => {
  // An instance that was down overnight must not sit on yesterday's orders
  // until a minute has elapsed.
  const s = site();
  try {
    const id = s.place();
    const sweeper = new OrderDispatchSweeper(s.deps, 3_600_000);
    sweeper.start();
    try {
      assert.deepEqual(sweeper.last?.enqueued, [id]);
      assert.equal(s.queued().length, 1);
    } finally {
      sweeper.stop();
    }
  } finally {
    s.cleanup();
  }
});

test("the timer does not hold the process open", () => {
  // A sweep that kept the event loop alive would turn a clean shutdown into
  // a hang, and a test run into a timeout.
  const s = site();
  try {
    const sweeper = new OrderDispatchSweeper(s.deps, 60_000);
    sweeper.start();
    try {
      assert.equal(sweeper.enabled, true);
      assert.equal(sweeper["timer"]?.hasRef(), false, "the interval is unref'd");
    } finally {
      sweeper.stop();
    }
  } finally {
    s.cleanup();
  }
});

// --- for which custodians --------------------------------------------------

test("a suspended custodian's orders stop leaving the building", () => {
  // Their credentials already stop working at the gate. Transmitting their
  // orders would disclose a patient's details to a laboratory on behalf of
  // somebody who no longer holds the relationship that justified holding them.
  const s = site();
  try {
    const id = s.place();
    s.db.sql.prepare("UPDATE tenants SET status = 'suspended' WHERE id = ?").run("default");

    const sweeper = new OrderDispatchSweeper(s.deps, 60_000);
    const pass = sweeper.run();
    assert.equal(pass.tenants, 0);
    assert.deepEqual(pass.enqueued, []);
    assert.equal(s.queued().length, 0);
    assert.equal(s.orders().transmissionState(id).state, "not-sent");
  } finally {
    s.cleanup();
  }
});

test("one custodian's sweep does not carry another's orders", () => {
  const s = site({ tenants: ["default", "beaufort"] });
  try {
    s.db.sql
      .prepare("INSERT INTO tenants (id, name, status) VALUES (?, ?, 'active')")
      .run("beaufort", "Beaufort Delta");
    // Channels are per-tenant rows too, so the second custodian needs its own
    // door out rather than borrowing the first's.
    s.db.forTenant("beaufort").upsertChannel(...labOrderChannel("orders-out", "stanton-lab"));

    const mine = s.place("default");
    const theirs = s.place("beaufort");

    const pass = new OrderDispatchSweeper(s.deps, 60_000).run();
    assert.deepEqual(pass.enqueued.sort(), [mine, theirs].sort(), "each custodian's own orders went");
    for (const [tenant, id] of [["default", mine], ["beaufort", theirs]] as const) {
      assert.equal(s.orders(tenant).transmissionState(id).state, "sent");
    }
  } finally {
    s.cleanup();
  }
});

// --- out of which door -----------------------------------------------------

test("a reading station does not resend the snapshot it is reading", () => {
  // The station's engine runs over a restored copy with every channel
  // flipped off (H-39). If the sweep ignored that flag it would resend every
  // placed order in the snapshot, from a node that is not the record.
  const s = site({ channels: [labOrderChannel("orders-out", "stanton-lab", false)] });
  try {
    const id = s.place();
    assert.equal(labOrderDoor(s.db), undefined, "a disabled channel is not a door");

    const pass = new OrderDispatchSweeper(s.deps, 60_000).run();
    assert.deepEqual(pass.enqueued, []);
    assert.equal(s.queued().length, 0);
    assert.equal(s.orders().transmissionState(id).state, "not-sent", "still the primary's job");
  } finally {
    s.cleanup();
  }
});

test("a site with no lab-order destination sweeps nothing and says nothing", () => {
  // Not every deployment sends orders anywhere. That is a configuration, not
  // a problem, and a warning every minute about it would bury a real one.
  const s = site({
    channels: [["inbound", "Inbound results", true, JSON.stringify({ id: "inbound", name: "Inbound", destinations: [] })]],
  });
  try {
    s.place();
    const pass = new OrderDispatchSweeper(s.deps, 60_000).run();
    assert.deepEqual(pass.enqueued, []);
    assert.deepEqual(pass.skipped, [], "silence, because there is nothing to fix");
  } finally {
    s.cleanup();
  }
});

test("two laboratories are refused rather than guessed between", () => {
  // A route says "Stanton Laboratory"; a channel says "stanton-lab". Nothing
  // maps one to the other, so with two doors the sweep cannot tell which
  // laboratory a route means -- and a requisition at the wrong laboratory is
  // worse than one that is late.
  const s = site({
    channels: [labOrderChannel("orders-out", "stanton-lab"), labOrderChannel("orders-out-2", "dynacare")],
  });
  try {
    const id = s.place();
    const door = labOrderDoor(s.db);
    assert.ok(door && "reason" in door, "the ambiguity is named, not resolved");

    const pass = new OrderDispatchSweeper(s.deps, 60_000).run();
    assert.deepEqual(pass.enqueued, []);
    assert.equal(pass.skipped.length, 1);
    assert.match(pass.skipped[0].reason, /2 lab-order destinations/);
    assert.match(pass.skipped[0].reason, /order-send/, "and says how to send in the meantime");
    assert.equal(s.orders().transmissionState(id).state, "not-sent");
  } finally {
    s.cleanup();
  }
});

/** Captures console.warn for the duration of one function. */
function warnings(fn: () => void): string[] {
  const said: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => said.push(args.join(" "));
  try {
    fn();
  } finally {
    console.warn = original;
  }
  return said;
}

test("a misconfiguration is reported when it starts, not once a minute forever", () => {
  // A misconfiguration does not fix itself between passes. Saying it every
  // time puts the same line in the log 1,440 times a day for as long as it
  // takes somebody to change it -- which is not emphasis, it is how a log
  // stops being read and how the line that mattered gets scrolled past.
  const s = site({
    channels: [labOrderChannel("orders-out", "stanton-lab"), labOrderChannel("orders-out-2", "dynacare")],
  });
  try {
    const sweeper = new OrderDispatchSweeper(s.deps, 60_000);
    const first = warnings(() => sweeper.start());
    try {
      assert.equal(first.length, 1, "said once when it starts");
      assert.match(first[0], /2 lab-order destinations/);

      const later = warnings(() => {
        sweeper["safeRun"]();
        sweeper["safeRun"]();
        sweeper["safeRun"]();
      });
      assert.deepEqual(later, [], "and not again while nothing has changed");
    } finally {
      sweeper.stop();
    }
  } finally {
    s.cleanup();
  }
});

test("an operator who fixes the configuration is told it took", () => {
  // Inferring success from a warning that stopped appearing is not being
  // told. It is noticing an absence, which is the thing nobody notices.
  const s = site({
    channels: [labOrderChannel("orders-out", "stanton-lab"), labOrderChannel("orders-out-2", "dynacare")],
  });
  try {
    const sweeper = new OrderDispatchSweeper(s.deps, 60_000);
    warnings(() => sweeper.start());
    sweeper.stop();

    // The operator removes the second door.
    s.db.sql.prepare("DELETE FROM channels WHERE tenant_id = ? AND id = ?").run("default", "orders-out-2");

    const said = warnings(() => sweeper["safeRun"]());
    assert.equal(said.length, 1);
    assert.match(said[0], /resolved; orders are being swept again/);

    assert.deepEqual(warnings(() => sweeper["safeRun"]()), [], "and then it goes quiet again");
  } finally {
    s.cleanup();
  }
});

test("a refusal that changes into a different refusal is reported again", () => {
  // Two doors becoming three is new information about the same tenant, and
  // reporting only the first would leave the log describing a configuration
  // that no longer exists.
  const s = site({
    channels: [labOrderChannel("orders-out", "stanton-lab"), labOrderChannel("orders-out-2", "dynacare")],
  });
  try {
    const sweeper = new OrderDispatchSweeper(s.deps, 60_000);
    const first = warnings(() => sweeper.start());
    sweeper.stop();
    assert.match(first[0], /2 lab-order destinations/);

    s.db.upsertChannel(...labOrderChannel("orders-out-3", "lifelabs"));
    const said = warnings(() => sweeper["safeRun"]());
    assert.equal(said.length, 1);
    assert.match(said[0], /3 lab-order destinations/);
  } finally {
    s.cleanup();
  }
});

test("a channel whose configuration will not parse does not stop the sweep", () => {
  // One unreadable row must not take every other order with it.
  const s = site({ channels: [["broken", "Broken", true, "{not json"], labOrderChannel("orders-out", "stanton-lab")] });
  try {
    const id = s.place();
    const pass = new OrderDispatchSweeper(s.deps, 60_000).run();
    assert.deepEqual(pass.enqueued, [id]);
  } finally {
    s.cleanup();
  }
});

// --- the pass itself -------------------------------------------------------

test("a pass that throws does not take the engine down with it", () => {
  const s = site();
  try {
    const sweeper = new OrderDispatchSweeper(
      { ...s.deps, forTenant: () => { throw new Error("store went away"); } },
      60_000
    );
    // start() runs a pass immediately; it must return rather than propagate.
    assert.doesNotThrow(() => sweeper.start());
    sweeper.stop();
  } finally {
    s.cleanup();
  }
});

test("an order nobody can build is reported by the sweep, not swallowed", () => {
  // "Nothing to send" and "one order nobody can send" must not look the same
  // from outside; the second is the one somebody has to act on.
  const s = site();
  try {
    const id = s.place();
    // A route pointing at a laboratory profile nobody loaded.
    const sweeper = new OrderDispatchSweeper({ ...s.deps, profiles: () => undefined }, 60_000);
    const pass = sweeper.run();
    assert.deepEqual(pass.enqueued, []);
    assert.equal(pass.unbuildable.length, 1);
    assert.equal(pass.unbuildable[0].order, id);
    assert.match(pass.unbuildable[0].reason, /profile/);
  } finally {
    s.cleanup();
  }
});

test("starting twice does not sweep twice as often", () => {
  const s = site();
  try {
    const sweeper = new OrderDispatchSweeper(s.deps, 60_000);
    sweeper.start();
    const first = sweeper["timer"];
    sweeper.start();
    assert.equal(sweeper["timer"], first, "the second start is a no-op, not a second timer");
    sweeper.stop();
  } finally {
    s.cleanup();
  }
});

// --- the whole path, on a real engine --------------------------------------

/**
 * A laboratory that answers.
 *
 * Small enough to be honest about what it proves: MLLP framing, one message
 * in, one acknowledgement out, correlated by the control id it was sent.
 */
function laboratory(reply: (received: string, controlId: string) => string) {
  const seen: string[] = [];
  const server = createTcpServer((socket) => {
    let buf = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf(0x1c);
      if (end === -1) return;
      const message = buf.subarray(buf.indexOf(0x0b) + 1, end).toString("utf8");
      buf = buf.subarray(end + 2);
      seen.push(message);
      const controlId = message.split("\r")[0].split("|")[9] ?? "";
      const ack = reply(message, controlId);
      socket.write(Buffer.concat([Buffer.from([0x0b]), Buffer.from(ack, "utf8"), Buffer.from([0x1c, 0x0d])]));
    });
  });
  return {
    seen,
    listen: (port = 0) =>
      new Promise<number>((resolve) => {
        server.listen(port, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
      }),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

function ackFor(controlId: string, code = "AA"): string {
  return `MSH|^~\\&|LABAPP|STANTON|NORTHSTAR|GNWT|20260902120000||ACK^O21|ACK-1|P|2.5.1\rMSA|${code}|${controlId}`;
}

/** Places one order on a started engine with a lab-order door out. */
async function siteWithLaboratory(
  port: number,
  opts: { dispatchMs?: number; maxAttempts?: number; backoffMs?: number } = {}
) {
  const engine = new Engine({
    dbPath: ":memory:",
    tickMs: 15,
    ...(opts.dispatchMs === undefined ? {} : { orderDispatchIntervalMs: opts.dispatchMs }),
  });
  engine.registerLabProfile(PROFILE);
  const t = engine.forTenant("default");
  t.clinical.record({
    entryType: "Patient",
    patientId: P,
    content: {
      resourceType: "Patient",
      id: P,
      birthDate: "1984-03-17",
      name: [{ family: "Beaulieu", given: ["Marie"] }],
      identifier: [{ system: "JHN", value: P }],
    },
    authorId: "reg",
    authorKind: "system",
    source: "test",
  });
  t.orders.declareOrderRouting(
    "lab",
    {
      transmits: true,
      destination: "Stanton Laboratory",
      detail: "MLLP to Stanton",
      connection: { ...CONNECTION, port },
    },
    GP
  );
  const order = t.orders.create({
    patientId: P,
    category: "lab",
    code: "2823-3",
    display: "Potassium",
    indication: "On spironolactone",
    by: GP,
  });
  t.orders.place(order.id, { ...GP, responsibleId: "dr-tetso" });

  // Written straight to the channel row rather than through addChannel so the
  // door exists *before* start(), which is the case that matters: the sweep's
  // first pass happens during start, and it must not enqueue against a
  // destination the worker has not registered yet.
  engine.db.upsertChannel(
    "orders-out",
    "Outbound orders",
    true,
    JSON.stringify({
      id: "orders-out",
      name: "Outbound orders",
      source: { type: "http", path: "/orders-out" },
      destinations: [
        {
          id: "stanton-lab",
          type: "lab-order",
          host: "127.0.0.1",
          port,
          maxAttempts: opts.maxAttempts ?? 2,
          ...(opts.backoffMs === undefined
            ? {}
            : { backoffBaseMs: opts.backoffMs, backoffCapMs: opts.backoffMs, timeoutMs: 200 }),
        },
      ],
    })
  );
  return { engine, orders: t.orders, orderId: order.id };
}

test("an order placed in clinic reaches the laboratory with nobody pressing send", async () => {
  // The whole point, end to end: place, sweep, queue, MLLP, acknowledgement,
  // recorded back on the order. Each half of this is tested on its own; this
  // is the seam between them, which is where a working feature is usually
  // not one.
  const lab = laboratory((_msg, controlId) => ackFor(controlId));
  const port = await lab.listen();
  const { engine, orders, orderId } = await siteWithLaboratory(port, { dispatchMs: 50 });
  await engine.start();
  try {
    await until(() => orders.transmissionState(orderId).state === "acknowledged");

    assert.equal(lab.seen.length, 1, "one requisition, not two");
    assert.match(lab.seen[0], /^MSH\|/);
    assert.match(lab.seen[0], /OML\^O21/, "an order message");
    assert.ok(lab.seen[0].includes(orderId), "carrying the placer order number a result will come back on");

    const state = orders.transmissionState(orderId);
    assert.equal(state.state, "acknowledged");
  } finally {
    await engine.stop();
    await lab.close();
  }
});

test("an order's history reads sent then acknowledged, with nothing spurious in between", async () => {
  // What a clinician opens is the list of attempts, so anything written there
  // that did not happen to their patient's requisition is noise in the one
  // place that has to stay readable. The engine sweeps once during start(),
  // before the queue has necessarily settled, and this pins that the resulting
  // history is exactly two entries -- not a transient failure and a recovery.
  const lab = laboratory((_msg, controlId) => ackFor(controlId));
  const port = await lab.listen();
  const { engine, orders, orderId } = await siteWithLaboratory(port, { dispatchMs: 3_600_000 });
  await engine.start();
  try {
    // One pass only, at start, an hour before the next one.
    await until(() => orders.transmissionState(orderId).state === "acknowledged");
    assert.deepEqual(
      orders.transmissions(orderId).map((t) => t.outcome),
      ["sent", "acknowledged"],
      "sent then acknowledged, with no failure in between"
    );
  } finally {
    await engine.stop();
    await lab.close();
  }
});

test("a laboratory that refuses the requisition is not asked again", async () => {
  // An AR is an answer. Resending gets an identical refusal and writes a
  // fresh one onto the chart each pass, burying the one somebody must read.
  const lab = laboratory((_msg, controlId) => ackFor(controlId, "AR"));
  const port = await lab.listen();
  const { engine, orders, orderId } = await siteWithLaboratory(port, { dispatchMs: 50 });
  await engine.start();
  try {
    await until(() => orders.transmissionState(orderId).state === "rejected");
    // Long enough for several sweeps at 50ms to have run.
    await until(() => engine.db.listDeliveries({ channelId: "orders-out", state: "dead" }).length === 1);

    assert.equal(lab.seen.length, 1, "refused once, not once per sweep");
    assert.equal(orders.transmissionState(orderId).state, "rejected");
  } finally {
    await engine.stop();
    await lab.close();
  }
});

test("stopping the engine stops the sweep", async () => {
  const lab = laboratory((_msg, controlId) => ackFor(controlId));
  const port = await lab.listen();
  const { engine } = await siteWithLaboratory(port, { dispatchMs: 50 });
  await engine.start();
  try {
    await engine.stop();
    assert.equal(engine.orderDispatch["timer"], null, "no timer left running past shutdown");
  } finally {
    await lab.close();
  }
});

test("a cancellation reaches the laboratory on the same clock the order did", async () => {
  // The asymmetry that would otherwise be silent: orders leave on their own,
  // and withdrawals of them do not. A clinician sees the order cancelled in
  // the chart, the patient is told it is called off, and the laboratory keeps
  // the requisition and collects the specimen.
  const lab = laboratory((_msg, controlId) => ackFor(controlId));
  const port = await lab.listen();
  const { engine, orders, orderId } = await siteWithLaboratory(port, { dispatchMs: 50 });
  await engine.start();
  try {
    await until(() => orders.transmissionState(orderId).state === "acknowledged");

    orders.cancel(orderId, { ...GP, reason: "patient declined the test" });
    await until(() => orders.cancellationState(orderId).state === "acknowledged");

    assert.equal(lab.seen.length, 2, "the order, then its withdrawal");
    assert.match(lab.seen[1], /\rORC\|CA\|/, "ORC-1 CA");
    assert.ok(lab.seen[1].includes(orderId), "against the placer order number they were given");
    assert.equal(
      orders.cancelledButStillWithFiller().length,
      0,
      "and it is off the list of requisitions somebody else still holds"
    );
  } finally {
    await engine.stop();
    await lab.close();
  }
});

test("an order cancelled before any laboratory had it is not chased", async () => {
  // Nothing to withdraw. A cancel for a requisition nobody was sent earns an
  // application reject and a line on the chart about a message that should
  // never have been built.
  const lab = laboratory((_msg, controlId) => ackFor(controlId));
  const port = await lab.listen();
  // An hour between passes, so the order is still unsent when it is cancelled.
  const { engine, orders, orderId } = await siteWithLaboratory(port, { dispatchMs: 3_600_000 });
  orders.cancel(orderId, { ...GP, reason: "wrong patient" });
  await engine.start();
  try {
    await until(() => engine.orderDispatch.last !== null);
    assert.deepEqual(engine.orderDispatch.last?.enqueued, []);
    assert.equal(lab.seen.length, 0, "nothing was sent, so there is nothing to withdraw");
  } finally {
    await engine.stop();
    await lab.close();
  }
});

// --- the link that is not there ------------------------------------------

/**
 * A free port, learned by binding one and letting it go.
 *
 * A test that needs the link *down* has to configure the route before
 * anything is listening, which means knowing the number in advance.
 */
async function freePort(): Promise<number> {
  const probe = createTcpServer();
  const port = await new Promise<number>((r) => {
    probe.listen(0, "127.0.0.1", () => r((probe.address() as { port: number }).port));
  });
  await new Promise<void>((r) => probe.close(() => r()));
  return port;
}

test("a sweep that runs all through an outage still sends one requisition", async () => {
  // The scenario this product is for. The sweep does not know the link is
  // down -- it runs on a clock, and the clock does not stop for weather. If
  // it and the queue disagreed about whether an order had gone, every pass
  // during an outage would add another requisition for one specimen.
  const port = await freePort();
  const { engine, orders, orderId } = await siteWithLaboratory(port, {
    dispatchMs: 50,
    maxAttempts: 500,
    backoffMs: 30,
  });
  await engine.start();
  const lab = laboratory((_msg, controlId) => ackFor(controlId));
  try {
    // Nothing is listening. Let the sweep run many times over.
    await until(() => (engine.db.listDeliveries({ channelId: "orders-out" })[0]?.attempts ?? 0) >= 5);
    const queued = engine.db.listDeliveries({ channelId: "orders-out" });
    assert.equal(queued.length, 1, "many passes, one requisition");
    assert.ok(queued[0].attempts >= 5, "and it really was trying");

    await lab.listen(port);
    await until(() => orders.transmissionState(orderId).state === "acknowledged");
    assert.equal(lab.seen.length, 1, "the laboratory got it once, when the link came back");
  } finally {
    await engine.stop();
    await lab.close();
  }
});

test("an order cancelled during an outage is withdrawn once the laboratory has it", async () => {
  // The subtle one, and the reason it is worth a test rather than an
  // argument. While the link is down the order reads `failed` -- the queue
  // has it and cannot deliver it -- so the withdrawal is *not* sent, because
  // nothing can be withdrawn from a laboratory that has nothing.
  //
  // But the requisition is still in the queue and will be delivered. So the
  // withdrawal has to follow it, without anybody intervening, the moment the
  // order genuinely lands. Two ways to get this wrong: sweep withdrawals for
  // `failed` orders too, and a laboratory is told to cancel something it was
  // never sent; or stop watching once the order leaves `not-sent`, and the
  // withdrawal is stranded and the specimen is collected.
  const port = await freePort();
  const { engine, orders, orderId } = await siteWithLaboratory(port, {
    dispatchMs: 50,
    maxAttempts: 500,
    backoffMs: 30,
  });
  await engine.start();
  const lab = laboratory((_msg, controlId) => ackFor(controlId));
  try {
    await until(() => orders.transmissionState(orderId).state === "failed");
    orders.cancel(orderId, { ...GP, reason: "patient declined the test" });

    // Sweeps keep running against a laboratory that has nothing.
    await until(() => (engine.db.listDeliveries({ channelId: "orders-out" })[0]?.attempts ?? 0) >= 5);
    assert.equal(orders.cancellationsNotSent().length, 0, "nothing to withdraw from a laboratory with nothing");
    assert.equal(orders.cancellationState(orderId).state, "not-sent");

    await lab.listen(port);
    await until(() => orders.cancellationState(orderId).state === "acknowledged");

    assert.equal(lab.seen.length, 2, "the requisition, then its withdrawal");
    assert.match(lab.seen[0], /\rORC\|NW\|/, "the order first");
    assert.match(lab.seen[1], /\rORC\|CA\|/, "the withdrawal second, never the other way round");
    assert.ok(lab.seen[1].includes(orderId), "naming the order it withdraws");
  } finally {
    await engine.stop();
    await lab.close();
  }
});
