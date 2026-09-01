/**
 * Handing placed orders to the queue, exactly once.
 *
 * The transmission model made "nobody has sent this" visible; the send route
 * made one order sendable by asking. This is what sends them without anybody
 * asking, and the interesting property is not that it sends — it is that it
 * cannot send twice.
 *
 * The sweep decides what to send by asking which orders read as `not-sent`.
 * Enqueueing one and recording that handover are two writes, and a process
 * that died between them would leave an order on the queue still reading as
 * never sent. The next sweep enqueues it again — and that is not a duplicate
 * message, it is two requisitions for one specimen: two collections booked,
 * or a patient drawn twice, or a result reported against an order the
 * clinician cannot find.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Db, DEFAULT_TENANT } from "../src/db.ts";
import { OrderStore } from "../src/orders/store.ts";
import { ClinicalRecord } from "../src/clinical/record.ts";
import { dispatchPlacedOrders, type DispatchDeps } from "../src/orders/dispatch.ts";
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

function site(opts: { profile?: LabProfile | undefined; identifiers?: Array<{ system: string; value: string }> } = {}) {
  const db = new Db(":memory:");
  db.upsertChannel("orders-out", "Outbound orders", true, "{}");
  const orders = new OrderStore(db);
  const clinical = new ClinicalRecord(db);
  clinical.record({
    entryType: "Patient",
    patientId: P,
    content: {
      resourceType: "Patient",
      id: P,
      birthDate: "1984-03-17",
      name: [{ family: "Beaulieu", given: ["Marie"] }],
      identifier: opts.identifiers ?? [{ system: "JHN", value: P }],
    },
    authorId: "reg",
    authorKind: "system",
    source: "test",
  });
  orders.declareOrderRouting(
    "lab",
    { transmits: true, destination: "Stanton Laboratory", detail: "MLLP", connection: CONNECTION },
    GP
  );
  const profile = "profile" in opts ? opts.profile : PROFILE;
  const deps: DispatchDeps = {
    db,
    orders,
    patients: clinical.patientIndex,
    profiles: (id) => (id === "stanton" ? profile : undefined),
    channelId: "orders-out",
    destinationId: "lab",
  };
  return {
    db,
    orders,
    deps,
    place: (code = "2823-3", display = "Potassium") => {
      const o = orders.create({
        patientId: P,
        category: "lab",
        code,
        display,
        indication: "On spironolactone",
        by: GP,
      });
      orders.place(o.id, { ...GP, responsibleId: "dr-tetso" });
      return o.id;
    },
    queued: () => db.listDeliveries({ channelId: "orders-out" }),
    cleanup: () => db.close(),
  };
}

test("a placed order is handed to the queue and stops reading as unsent", () => {
  const s = site();
  try {
    const id = s.place();
    assert.equal(s.orders.transmissionState(id).state, "not-sent");

    const out = dispatchPlacedOrders(s.deps);
    assert.deepEqual(out.enqueued, [id]);
    assert.equal(s.queued().length, 1, "one delivery on the ordinary queue");
    const state = s.orders.transmissionState(id);
    assert.equal(state.state, "sent");
    assert.match(state.detail, /handed to the outbound queue/);
    assert.match(state.detail, /Sent is not received/, "and still does not claim they have it");
  } finally {
    s.cleanup();
  }
});

test("sweeping twice does not send the same requisition twice", () => {
  // The property the whole thing turns on. Two requisitions for one specimen
  // is two collections booked, or a patient drawn twice.
  const s = site();
  try {
    const id = s.place();
    assert.deepEqual(dispatchPlacedOrders(s.deps).enqueued, [id]);
    assert.deepEqual(dispatchPlacedOrders(s.deps).enqueued, [], "the second pass finds nothing to do");
    assert.equal(s.queued().length, 1);
  } finally {
    s.cleanup();
  }
});

test("the enqueue and the record commit together or not at all", () => {
  // The crash this transaction exists for. If the delivery row survived and
  // the transmission record did not, the order would still read as never sent
  // and the next sweep would enqueue a second requisition for the same
  // specimen. Forcing the second write to throw proves neither lands.
  const s = site();
  try {
    const id = s.place();
    const original = s.orders.recordTransmission.bind(s.orders);
    (s.orders as unknown as { recordTransmission: unknown }).recordTransmission = () => {
      throw new Error("killed between the queue and the record");
    };

    assert.throws(() => dispatchPlacedOrders(s.deps), /killed between the queue and the record/);

    (s.orders as unknown as { recordTransmission: unknown }).recordTransmission = original;
    assert.equal(s.queued().length, 0, "no delivery survived the failed record");
    assert.equal(s.orders.transmissionState(id).state, "not-sent", "and the order is untouched");

    // And it is still sendable: the failure left nothing half-done.
    assert.deepEqual(dispatchPlacedOrders(s.deps).enqueued, [id]);
    assert.equal(s.queued().length, 1);
  } finally {
    s.cleanup();
  }
});

test("an order that cannot be built is reported, not enqueued to fail", () => {
  // A patient with no identifier under the laboratory's authority. Enqueueing
  // it would put a message on the queue that can only dead-letter; leaving it
  // keeps it on the "no laboratory has this" list with its reason, where
  // somebody can act on it.
  const s = site({ identifiers: [{ system: "LOCAL-MRN", value: "88213" }] });
  try {
    const id = s.place();
    const out = dispatchPlacedOrders(s.deps);
    assert.deepEqual(out.enqueued, []);
    assert.equal(out.unbuildable.length, 1);
    assert.equal(out.unbuildable[0].order, id);
    assert.ok(out.unbuildable[0].missing.some((m) => /identifier under JHN/.test(m)));
    assert.equal(s.queued().length, 0);
    assert.equal(s.orders.transmissionState(id).state, "not-sent", "still visible as unsent");
  } finally {
    s.cleanup();
  }
});

test("an order that could not be built this morning goes out this afternoon", () => {
  // The sweep runs again, so a missing answer recorded later needs no
  // intervention to get the order moving.
  const withAoe: LabProfile = {
    ...PROFILE,
    askAtOrderEntry: { "2345-7": [{ code: "1558-6", text: "Fasting status", required: true }] },
  };
  const s = site({ profile: withAoe });
  try {
    const id = s.place("2345-7", "Glucose");
    assert.equal(dispatchPlacedOrders(s.deps).unbuildable.length, 1, "no fasting answer yet");
    assert.equal(s.queued().length, 0);

    // The answer arrives on the profile's terms via the send context; here it
    // is the order becoming buildable that matters, so drop the requirement.
    s.deps.profiles = (i) => (i === "stanton" ? PROFILE : undefined);
    assert.deepEqual(dispatchPlacedOrders(s.deps).enqueued, [id], "and now it goes");
  } finally {
    s.cleanup();
  }
});

test("a route with no loaded profile reports rather than guessing", () => {
  const s = site({ profile: undefined });
  try {
    s.place();
    const out = dispatchPlacedOrders(s.deps);
    assert.deepEqual(out.enqueued, []);
    assert.match(out.unbuildable[0].reason, /built against a guess/);
  } finally {
    s.cleanup();
  }
});

test("a site that does not transmit has nothing swept", () => {
  const s = site();
  try {
    s.orders.declareOrderRouting("lab", { transmits: false, detail: "printed with the specimen" }, GP);
    s.place();
    assert.deepEqual(dispatchPlacedOrders(s.deps).enqueued, []);
    assert.equal(s.queued().length, 0);
  } finally {
    s.cleanup();
  }
});

test("a rejected order is not quietly resent behind the clinician's back", () => {
  // rejected and failed are answers somebody has to read. Sweeping them up
  // again would resend a requisition the laboratory has already refused, and
  // write a fresh refusal onto the chart each pass.
  const s = site();
  try {
    const id = s.place();
    s.orders.recordTransmission(
      id,
      { outcome: "rejected", destination: "Stanton Laboratory", detail: "AR: unknown ordering provider" },
      GP
    );
    assert.deepEqual(dispatchPlacedOrders(s.deps).enqueued, []);
    assert.equal(s.queued().length, 0);
    assert.equal(s.orders.transmissionState(id).state, "rejected", "still there to be dealt with");
  } finally {
    s.cleanup();
  }
});

test("the delivery knows which order it answers for, without reading the requisition", () => {
  // Two identifiers, doing different jobs, and it is worth being exact about
  // which is which.
  //
  // The order id *is* on the wire, as the placer order number in ORC-2 and
  // OBR-2 — that is the whole mechanism by which a result finds its order, and
  // taking it out would break the round trip. What the metadata adds is the
  // control id: MSA-2 echoes it, and the delivery needs it to know that the
  // acknowledgement coming back answers this message rather than another.
  //
  // Keeping both in metadata means the worker never has to parse the
  // requisition it is carrying to find out what to record.
  const s = site();
  try {
    const id = s.place();
    dispatchPlacedOrders(s.deps);
    const delivery = s.queued()[0];
    const message = s.db.getMessage(delivery.message_id)!;
    const meta = JSON.parse(message.meta!) as { orderId: string; controlId: string; kind: string };

    assert.equal(meta.orderId, id);
    assert.equal(meta.kind, "order");
    assert.ok(meta.controlId);
    assert.ok(delivery.payload.includes(id), "the placer order number is the order id, so a result can come home");
    assert.ok(delivery.payload.includes(meta.controlId), "and the control id is what MSA-2 will echo");
    assert.notEqual(meta.controlId, id, "they are different identifiers doing different jobs");
  } finally {
    s.cleanup();
  }
});
