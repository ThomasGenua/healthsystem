/**
 * The third silence, and the earliest one.
 *
 * `orders.test.ts` opens on two silences: an order placed and never resulted,
 * and a result reported and never read. There is one before both of them, and
 * it is the one nothing in this system was saying.
 *
 * An order placed here has not been sent anywhere. `place()` writes
 * `status = 'placed'` and records an event; nothing hands the requisition to a
 * laboratory, because until an outbound interface exists there is nothing to
 * hand it to. The chart then shows "placed". The worklist shows it awaiting a
 * result. `awaitingResult()` will eventually list it as overdue, which reads
 * as a slow laboratory. The laboratory has never heard of it.
 *
 * That is worse than the dispense silence it resembles. A prescription with no
 * dispense record may still have been collected — the pharmacy may simply not
 * report. Here *we* are the sender, so the absence is not ambiguous and not
 * somebody else's: it is ours, and it is knowable. These tests pin that it is
 * known, and that only an acknowledgement from the far end is allowed to mean
 * a laboratory holds the order.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../src/db.ts";
import { OrderStore } from "../src/orders/store.ts";

const P = "NT123456";
const GP = { actorId: "dr-tetso", actorKind: "practitioner" };
const CLERK = { actorId: "clerk-amos", actorKind: "practitioner" };

function site(): { db: Db; orders: OrderStore; place: () => string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "northstar-tx-"));
  const db = new Db(join(dir, "northstar.db"));
  const orders = new OrderStore(db);
  return {
    db,
    orders,
    /** An ordinary placed lab order, which is where the problem starts. */
    place: () => {
      const o = orders.create({
        patientId: P,
        category: "lab",
        code: "2823-3",
        display: "Potassium",
        indication: "On spironolactone",
        by: GP,
      });
      orders.place(o.id, { ...GP, responsibleId: "dr-tetso" });
      return o.id;
    },
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}

test("an order at a site that has declared nothing does not read as awaiting a laboratory", () => {
  // The state every existing deployment is in. Before this, the only thing the
  // record said about such an order was "placed".
  const s = site();
  try {
    const id = s.place();
    const state = s.orders.transmissionState(id);
    assert.equal(state.state, "not-declared");
    assert.match(state.detail, /nobody has declared whether lab orders leave this site/);
    assert.match(state.detail, /never going anywhere/);
  } finally {
    s.cleanup();
  }
});

test("a site that orders on paper says so, and its orders stop looking like a stalled queue", () => {
  // "We do not transmit" is a real answer and a common one. It needs to be
  // distinguishable from "we transmit and this one is stuck", because the two
  // call for completely different actions.
  const s = site();
  try {
    s.orders.declareOrderRouting(
      "lab",
      { transmits: false, detail: "requisitions are printed and go with the specimen" },
      CLERK
    );
    const state = s.orders.transmissionState(s.place());
    assert.equal(state.state, "no-route");
    assert.match(state.detail, /printed and go with the specimen/);
    assert.match(state.detail, /outside this system/);
  } finally {
    s.cleanup();
  }
});

test("with a route declared, an unsent order says no laboratory holds it", () => {
  const s = site();
  try {
    s.orders.declareOrderRouting(
      "lab",
      { transmits: true, destination: "Stanton Laboratory", detail: "MLLP over the site VPN", connection: {
        host: "lab.example",
        port: 6661,
        sendingApplication: "NORTHSTAR",
        sendingFacility: "GNWT",
        receivingApplication: "LABAPP",
        receivingFacility: "STANTON",
        timezoneOffset: "-06:00",
        profileId: "stanton",
      } },
      CLERK
    );
    const state = s.orders.transmissionState(s.place());
    assert.equal(state.state, "not-sent");
    assert.match(state.detail, /Stanton Laboratory/);
    assert.match(state.detail, /No laboratory holds it/);
  } finally {
    s.cleanup();
  }
});

test("sent is not received, and says so in those words", () => {
  // The distinction the whole model turns on. A message written to a socket
  // has left; nothing yet says it arrived, was parsed, or was accepted.
  const s = site();
  try {
    const id = s.place();
    s.orders.recordTransmission(
      id,
      { outcome: "sent", destination: "Stanton Laboratory", controlId: "MSG-1", detail: "OML written to the queue" },
      CLERK
    );
    const state = s.orders.transmissionState(id);
    assert.equal(state.state, "sent");
    assert.match(state.detail, /Sent is not received/);
    assert.match(state.detail, /no acknowledgement has come back/);
  } finally {
    s.cleanup();
  }
});

test("only an acknowledgement means a laboratory holds the order", () => {
  const s = site();
  try {
    const id = s.place();
    s.orders.recordTransmission(id, { outcome: "sent", destination: "Stanton", detail: "sent" }, CLERK);
    s.orders.recordTransmission(
      id,
      { outcome: "acknowledged", destination: "Stanton", controlId: "MSG-1", detail: "AA" },
      CLERK
    );
    assert.equal(s.orders.transmissionState(id).state, "acknowledged");
    assert.deepEqual(s.orders.notWithFiller(), [], "and it drops off the list of orders nobody has");
  } finally {
    s.cleanup();
  }
});

test("a rejected order is not with them, and says what has to happen", () => {
  // An AR is the laboratory saying it could not accept this requisition. The
  // dangerous reading is that something was sent, so something is in progress.
  const s = site();
  try {
    const id = s.place();
    s.orders.recordTransmission(
      id,
      { outcome: "rejected", destination: "Stanton", detail: "AR: unknown ordering provider" },
      CLERK
    );
    const state = s.orders.transmissionState(id);
    assert.equal(state.state, "rejected");
    assert.match(state.detail, /not with them/);
    assert.match(state.detail, /correcting and resending/);
    assert.equal(s.orders.notWithFiller().length, 1);
  } finally {
    s.cleanup();
  }
});

test("a transport failure is treated as not sent, not as sent-and-waiting", () => {
  const s = site();
  try {
    const id = s.place();
    s.orders.recordTransmission(
      id,
      { outcome: "failed", destination: "Stanton", detail: "connection refused after 5 retries" },
      CLERK
    );
    const state = s.orders.transmissionState(id);
    assert.equal(state.state, "failed");
    assert.match(state.detail, /treat it as not sent/);
  } finally {
    s.cleanup();
  }
});

test("a corrected resend supersedes the rejection, and the rejection stays on the record", () => {
  // Appended, never updated, for the reason results are. A retry that
  // overwrote the first attempt would erase the fact that this laboratory once
  // refused this requisition — which is exactly the history somebody needs
  // when a specimen turns up against an order the lab does not hold.
  const s = site();
  try {
    const id = s.place();
    s.orders.recordTransmission(id, { outcome: "rejected", destination: "Stanton", detail: "AR: bad provider" }, CLERK);
    s.orders.recordTransmission(id, { outcome: "sent", destination: "Stanton", detail: "resent, provider fixed" }, CLERK);
    s.orders.recordTransmission(id, { outcome: "acknowledged", destination: "Stanton", detail: "AA" }, CLERK);

    assert.equal(s.orders.transmissionState(id).state, "acknowledged");
    const history = s.orders.transmissions(id);
    assert.deepEqual(history.map((t) => t.outcome), ["rejected", "sent", "acknowledged"]);
    assert.match(history[0].detail, /AR: bad provider/, "the refusal is still there to be found");
  } finally {
    s.cleanup();
  }
});

test("on a site with no interface, every open order is an order nobody has", () => {
  // The uncomfortable answer, and the correct one. A list that came back empty
  // here would be the same lie the chart was telling.
  const s = site();
  try {
    const a = s.place();
    const b = s.place();
    const missing = s.orders.notWithFiller();
    assert.deepEqual(missing.map((o) => o.id).sort(), [a, b].sort());
    for (const o of missing) assert.equal(o.transmission.state, "not-declared");
  } finally {
    s.cleanup();
  }
});

test("a draft order is not on the list, because nobody has claimed it was placed", () => {
  const s = site();
  try {
    s.orders.create({
      patientId: P,
      category: "lab",
      code: "2823-3",
      display: "Potassium",
      indication: "baseline",
      by: GP,
    });
    assert.deepEqual(s.orders.notWithFiller(), [], "a draft makes no claim to have been sent");
  } finally {
    s.cleanup();
  }
});

test("the chart cannot render an order without its transmission state", () => {
  // The state rides on the row rather than being a second call a caller has to
  // know to make. Every screen would otherwise have to remember to ask, and a
  // guarantee that depends on remembering holds until one screen forgets.
  const s = site();
  try {
    const id = s.place();
    const rows = s.orders.forPatient(P);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, id);
    assert.equal(rows[0].status, "placed", "the old field still says what it always said");
    assert.equal(rows[0].transmission.state, "not-declared", "and the new one says what that leaves out");
  } finally {
    s.cleanup();
  }
});

test("a declaration that transmits nowhere, or explains nothing, is refused", () => {
  // Both halves matter. A route with no destination cannot be acted on, and
  // "we do not transmit" with no reason is indistinguishable from nobody
  // having got round to it — which is the state this replaces.
  const s = site();
  try {
    assert.throws(
      () => s.orders.declareOrderRouting("lab", { transmits: true, detail: "MLLP" }, CLERK),
      /needs a destination/
    );
    assert.throws(
      () => s.orders.declareOrderRouting("lab", { transmits: false, detail: "  " }, CLERK),
      /needs a detail/
    );
  } finally {
    s.cleanup();
  }
});

test("routing is declared per category, so imaging is not answered by the lab's arrangement", () => {
  const s = site();
  try {
    s.orders.declareOrderRouting(
      "lab",
      { transmits: true, destination: "Stanton Laboratory", detail: "MLLP", connection: {
        host: "lab.example",
        port: 6661,
        sendingApplication: "NORTHSTAR",
        sendingFacility: "GNWT",
        receivingApplication: "LABAPP",
        receivingFacility: "STANTON",
        timezoneOffset: "-06:00",
        profileId: "stanton",
      } },
      CLERK
    );
    const imaging = s.orders.create({
      patientId: P,
      category: "imaging",
      code: "36643-5",
      display: "Chest X-ray",
      indication: "Cough",
      by: GP,
    });
    s.orders.place(imaging.id, { ...GP, responsibleId: "dr-tetso" });

    assert.equal(s.orders.transmissionState(s.place()).state, "not-sent", "the lab route is declared");
    assert.equal(
      s.orders.transmissionState(imaging.id).state,
      "not-declared",
      "and says nothing about imaging"
    );
  } finally {
    s.cleanup();
  }
});

test("a transmission against an order that does not exist is refused", () => {
  const s = site();
  try {
    assert.throws(
      () => s.orders.recordTransmission("no-such-order", { outcome: "sent", destination: "X", detail: "y" }, CLERK),
      /no order no-such-order/
    );
  } finally {
    s.cleanup();
  }
});

test("attempts keep their insertion order even when they land in the same millisecond", () => {
  // Found as a flake, and it was not a test problem. Ordering by timestamp
  // with a tiebreak on the row id meant two attempts written in the same
  // millisecond — a send and the acknowledgement answering it, which is the
  // ordinary case on a fast link — were ordered by whichever random uuid
  // happened to sort last. Half the time that reported a rejected order as
  // acknowledged: the exact inversion this whole mechanism exists to prevent.
  //
  // Ordering is by an autoincrementing sequence, so it is insertion order and
  // nothing else. Twenty in a tight loop is well inside one millisecond.
  const s = site();
  try {
    const id = s.place();
    const written = [];
    for (let i = 0; i < 20; i++) {
      const outcome = i === 19 ? "acknowledged" : "sent";
      s.orders.recordTransmission(id, { outcome, destination: "Stanton", detail: `attempt ${i}` }, CLERK);
      written.push(`attempt ${i}`);
    }
    const seen = s.orders.transmissions(id);
    assert.deepEqual(seen.map((t) => t.detail), written, "insertion order, not uuid order");
    assert.equal(s.orders.transmissionState(id).state, "acknowledged", "the last one written is the one that counts");

    const stamps = new Set(seen.map((t) => t.at));
    assert.ok(stamps.size < seen.length, "the run really did share timestamps, or this proves nothing");
  } finally {
    s.cleanup();
  }
});

test("a site that prints its requisitions is not chased forever", () => {
  // The difference between a list and wallpaper. A site that has declared it
  // does not transmit has answered the question — the requisition travels on
  // paper with the specimen — so there is nothing outstanding about those
  // orders. Listing every one of them forever would make this list wrong so
  // often that nobody would read it, which is the same failure the dispense
  // declaration exists to avoid.
  //
  // An *undeclared* site is the opposite case, and stays on the list: nobody
  // has said, so every order is a real question.
  const s = site();
  try {
    s.orders.declareOrderRouting(
      "lab",
      { transmits: false, detail: "requisitions are printed and go with the specimen" },
      CLERK
    );
    s.place();
    assert.deepEqual(s.orders.notWithFiller(), [], "a declared paper process is not an outstanding question");

    // Same order, same site, with the declaration withdrawn: back on the list.
    s.orders.declareOrderRouting(
      "lab",
      { transmits: true, destination: "Stanton", detail: "MLLP", connection: {
        host: "lab.example",
        port: 6661,
        sendingApplication: "NORTHSTAR",
        sendingFacility: "GNWT",
        receivingApplication: "LABAPP",
        receivingFacility: "STANTON",
        timezoneOffset: "-06:00",
        profileId: "stanton",
      } },
      CLERK
    );
    assert.equal(s.orders.notWithFiller().length, 1, "a route that exists and has not carried it is a question");
  } finally {
    s.cleanup();
  }
});

test("a route that says it transmits and cannot is refused when it is declared", () => {
  // Checked at declaration, not at send. A route that promises to carry orders
  // and has no endpoint is a promise the record makes on a site's behalf, and
  // the moment it is discovered should not be the moment a specimen is sitting
  // in a fridge waiting for a requisition that was never going anywhere.
  const s = site();
  try {
    assert.throws(
      () => s.orders.declareOrderRouting("lab", { transmits: true, destination: "X", detail: "MLLP" }, CLERK),
      /needs a connection/
    );

    const partial = {
      host: "lab.example",
      port: 6661,
      sendingApplication: "NORTHSTAR",
      sendingFacility: "GNWT",
      receivingApplication: "LABAPP",
      receivingFacility: "STANTON",
      timezoneOffset: "-06:00",
      profileId: "stanton",
    };
    for (const [field, broken] of [
      ["host", { ...partial, host: "  " }],
      ["port", { ...partial, port: 0 }],
      ["port", { ...partial, port: 70000 }],
      ["receivingFacility", { ...partial, receivingFacility: "" }],
      ["profileId", { ...partial, profileId: "" }],
      // Declared, never inferred, for the same reason the builder requires it:
      // a server in one zone sending for a clinic in another is ordinary here.
      ["timezoneOffset", { ...partial, timezoneOffset: "MST" }],
    ] as const) {
      assert.throws(
        () =>
          s.orders.declareOrderRouting(
            "lab",
            { transmits: true, destination: "X", detail: "MLLP", connection: broken },
            CLERK
          ),
        new RegExp(field),
        `${field} should stop the declaration`
      );
    }
  } finally {
    s.cleanup();
  }
});

test("a site that does not transmit needs no connection", () => {
  // The requirement attaches to the promise, not to every declaration. A
  // paper-requisition site has nothing to put in an endpoint and should not be
  // made to invent one.
  const s = site();
  try {
    s.orders.declareOrderRouting("lab", { transmits: false, detail: "printed with the specimen" }, CLERK);
    const declared = s.orders.orderRouting("lab");
    assert.equal(declared?.transmits, false);
    assert.equal(declared?.endpoint_host, null, "and nothing is invented to fill the column");
  } finally {
    s.cleanup();
  }
});

test("the declared connection is what comes back, so a sender reads it rather than guessing", () => {
  const s = site();
  try {
    s.orders.declareOrderRouting(
      "lab",
      {
        transmits: true,
        destination: "Stanton Laboratory",
        detail: "MLLP over the site VPN",
        connection: {
          host: "lab.example",
          port: 6661,
          sendingApplication: "NORTHSTAR",
          sendingFacility: "GNWT",
          receivingApplication: "LABAPP",
          receivingFacility: "STANTON",
          timezoneOffset: "-06:00",
          profileId: "stanton",
        },
      },
      CLERK
    );
    const r = s.orders.orderRouting("lab")!;
    assert.equal(r.endpoint_host, "lab.example");
    assert.equal(r.endpoint_port, 6661);
    assert.equal(r.receiving_application, "LABAPP");
    assert.equal(r.timezone_offset, "-06:00");
    assert.equal(r.profile_id, "stanton");
  } finally {
    s.cleanup();
  }
});
