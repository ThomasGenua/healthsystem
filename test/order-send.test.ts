/**
 * Handing an order over, and every way that can look like success.
 *
 * The transmission model is only worth having if the thing that drives it is
 * as careful as the model is. Each test here is a step that can fail while
 * looking like it worked: a transport that throws after the bytes left, a
 * reply that is not an acknowledgement, and — the one implementations skip —
 * an acknowledgement that is perfectly positive and is answering somebody
 * else's message.
 *
 * The second half is the mirror. `cancel()` sets an order to cancelled here.
 * A laboratory that acknowledged it still holds the requisition, so the
 * specimen is still collected and a result comes back for a test the chart
 * says nobody wanted — against a patient who may have been told it was called
 * off.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../src/db.ts";
import { OrderStore } from "../src/orders/store.ts";
import { ClinicalRecord } from "../src/clinical/record.ts";
import { sendOrder, sendOrderCancellation, type SendDeps } from "../src/orders/send.ts";
import { interpretAck, type OmlContext } from "../src/orders/outbound.ts";
import type { LabProfile } from "../src/orders/hl7.ts";

const P = "NT123456";
const GP = { actorId: "dr-tetso", actorKind: "practitioner" };
const TARGET = { host: "lab.example", port: 6661 };

const PROFILE: LabProfile = {
  id: "stanton",
  name: "Stanton Laboratory",
  patientAssigningAuthority: "JHN",
  defaultCodeSystem: "LN",
};

const CTX: OmlContext = {
  sendingApplication: "NORTHSTAR",
  sendingFacility: "GNWT",
  receivingApplication: "LABAPP",
  receivingFacility: "STANTON",
  timezoneOffset: "-06:00",
  orderingProvider: { id: "1234", family: "Tetso", given: "John" },
  now: "2026-08-27T15:30:00.000Z",
};

/** An MLLP far end that answers however the test tells it to. */
function replying(reply: (sent: string) => string | Promise<string>) {
  const seen: string[] = [];
  return {
    seen,
    transport: async (_t: unknown, message: string) => {
      seen.push(message);
      return reply(message);
    },
  };
}

function controlIdOf(message: string): string {
  return message.split("\r")[0].split("|")[9];
}

function ack(code: string, controlId: string, text = ""): string {
  return `MSH|^~\\&|LABAPP|STANTON|NORTHSTAR|GNWT|20260827153000||ACK|A1|P|2.5.1\rMSA|${code}|${controlId}|${text}\r`;
}

function site(reply: (sent: string) => string | Promise<string>) {
  const dir = mkdtempSync(join(tmpdir(), "northstar-send-"));
  const db = new Db(join(dir, "northstar.db"));
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
      identifier: [{ system: "JHN", value: P }],
    },
    authorId: "reg",
    authorKind: "system",
    source: "test",
  });
  orders.declareOrderRouting(
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
    GP
  );
  const far = replying(reply);
  const deps: SendDeps = { orders, patients: clinical.patientIndex, profile: PROFILE, transport: far.transport };
  return {
    db,
    orders,
    deps,
    far,
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
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/* ------------------------------------------------------- acknowledgement --- */

test("a positive acknowledgement for our message is the only thing that means they have it", async () => {
  const s = site((sent) => ack("AA", controlIdOf(sent)));
  try {
    const id = s.place();
    const out = await sendOrder(s.deps, id, TARGET, CTX, GP);
    assert.equal(out.sent, true);
    assert.equal(s.orders.transmissionState(id).state, "acknowledged");
    assert.deepEqual(s.orders.notWithFiller(), []);
  } finally {
    s.cleanup();
  }
});

test("an acknowledgement answering a different message does not acknowledge this one", async () => {
  // The field implementations skip. MSA-1 alone says *an* acknowledgement was
  // positive; only MSA-2 says it was about this message. Acknowledgements
  // arrive on connections carrying other traffic, engines resend, and a slow
  // far end answers a previous message after this one went out.
  const s = site(() => ack("AA", "SOMEBODY-ELSE"));
  try {
    const id = s.place();
    const out = await sendOrder(s.deps, id, TARGET, CTX, GP);
    assert.equal(out.sent, false);
    assert.match(out.reason, /answered message SOMEBODY-ELSE/);
    assert.equal(s.orders.transmissionState(id).state, "failed", "not acknowledged, on a perfectly positive AA");
    assert.equal(s.orders.notWithFiller().length, 1, "and it stays on the list of orders nobody has");
  } finally {
    s.cleanup();
  }
});

test("a rejection is recorded as a rejection, not as sent-and-waiting", async () => {
  const s = site((sent) => ack("AR", controlIdOf(sent), "unknown ordering provider"));
  try {
    const id = s.place();
    const out = await sendOrder(s.deps, id, TARGET, CTX, GP);
    assert.equal(out.sent, false);
    const state = s.orders.transmissionState(id);
    assert.equal(state.state, "rejected");
    assert.match(state.detail, /unknown ordering provider/);
    assert.match(state.detail, /correcting and resending/);
  } finally {
    s.cleanup();
  }
});

test("a transport that throws leaves the order reading as not sent", async () => {
  const s = site(() => {
    throw new Error("ECONNREFUSED");
  });
  try {
    const id = s.place();
    const out = await sendOrder(s.deps, id, TARGET, CTX, GP);
    assert.equal(out.sent, false);
    const state = s.orders.transmissionState(id);
    assert.equal(state.state, "failed");
    assert.match(state.detail, /treat it as not sent/);
  } finally {
    s.cleanup();
  }
});

test("the attempt is recorded before the send, so a crash mid-flight does not read as never sent", async () => {
  // A process that died between the socket write and the database write would
  // otherwise leave an order reading as never sent while a laboratory holds
  // it, and a clinician resending produces two requisitions for one specimen.
  const s = site(() => {
    throw new Error("killed mid-flight");
  });
  try {
    const id = s.place();
    await sendOrder(s.deps, id, TARGET, CTX, GP);
    const attempts = s.orders.transmissions(id, "order");
    assert.equal(attempts[0].outcome, "sent", "the send was written down before it was attempted");
    assert.equal(attempts[1].outcome, "failed");
  } finally {
    s.cleanup();
  }
});

test("a reply that is not an acknowledgement is not read as one", async () => {
  const s = site(() => "MSH|^~\\&|LABAPP|STANTON|NORTHSTAR|GNWT|20260827||ORU^R01|X|P|2.5.1\r");
  try {
    const id = s.place();
    const out = await sendOrder(s.deps, id, TARGET, CTX, GP);
    assert.equal(out.sent, false);
    assert.match(out.reason, /no MSA segment/);
  } finally {
    s.cleanup();
  }
});

test("an unrecognised acknowledgement code is not assumed positive", () => {
  const v = interpretAck(ack("ZZ", "MSG-1"), "MSG-1");
  assert.equal(v.outcome, "failed");
  assert.match(v.detail, /not a code it may assume is positive/);
});

test("a commit accept says so, because it is not application acceptance", () => {
  const v = interpretAck(ack("CA", "MSG-1"), "MSG-1");
  assert.equal(v.outcome, "acknowledged");
  assert.match(v.detail, /commit accept/);
});

test("nothing coming back is not an acknowledgement", () => {
  const v = interpretAck("", "MSG-1");
  assert.equal(v.outcome, "failed");
  assert.match(v.detail, /Treat the order as not sent/);
});

test("an undeclared route sends nothing rather than sending against a guess", async () => {
  const s = site((sent) => ack("AA", controlIdOf(sent)));
  try {
    const imaging = s.orders.create({
      patientId: P,
      category: "imaging",
      code: "36643-5",
      display: "Chest X-ray",
      indication: "Cough",
      by: GP,
    });
    s.orders.place(imaging.id, { ...GP, responsibleId: "dr-tetso" });
    const out = await sendOrder(s.deps, imaging.id, TARGET, CTX, GP);
    assert.equal(out.sent, false);
    assert.match(out.reason, /not declared to leave this site/);
    assert.equal(s.far.seen.length, 0, "nothing reached the transport");
  } finally {
    s.cleanup();
  }
});

test("a message that will not build records no attempt at all", async () => {
  // "We tried and the line was down" and "we never had enough to send" are
  // different conversations, and a failed row would tell the first story.
  const s = site((sent) => ack("AA", controlIdOf(sent)));
  try {
    const id = s.place();
    const out = await sendOrder(s.deps, id, TARGET, { ...CTX, timezoneOffset: "" }, GP);
    assert.equal(out.sent, false);
    assert.ok(out.missing?.includes("timezoneOffset"));
    assert.deepEqual(s.orders.transmissions(id), [], "no attempt, because nothing was attempted");
    assert.equal(s.far.seen.length, 0);
  } finally {
    s.cleanup();
  }
});

/* ------------------------------------------------------------ withdrawal --- */

test("an order cancelled here that a laboratory acknowledged is flagged until they are told", async () => {
  // The mirror of notWithFiller, and the more urgent list. There the record
  // claimed a laboratory had something it did not; here a laboratory has
  // something the record says it does not, and the specimen is still due.
  const s = site((sent) => ack("AA", controlIdOf(sent)));
  try {
    const id = s.place();
    await sendOrder(s.deps, id, TARGET, CTX, GP);
    s.orders.cancel(id, { ...GP, reason: "patient declined" });

    const outstanding = s.orders.cancelledButStillWithFiller();
    assert.equal(outstanding.length, 1);
    assert.equal(outstanding[0].id, id);
    assert.match(outstanding[0].cancellation.detail, /still hold the requisition/);
    assert.match(outstanding[0].cancellation.detail, /still due to be collected/);
  } finally {
    s.cleanup();
  }
});

test("sending the cancellation clears it, and the message is a CA for the same requisition", async () => {
  const s = site((sent) => ack("AA", controlIdOf(sent)));
  try {
    const id = s.place();
    await sendOrder(s.deps, id, TARGET, CTX, GP);
    s.orders.cancel(id, { ...GP, reason: "patient declined" });
    const out = await sendOrderCancellation(s.deps, id, TARGET, CTX, GP);

    assert.equal(out.sent, true);
    assert.equal(s.orders.cancellationState(id).state, "acknowledged");
    assert.deepEqual(s.orders.cancelledButStillWithFiller(), []);

    const cancelMsg = s.far.seen[1];
    const orc = cancelMsg.split("\r").find((l) => l.startsWith("ORC"))!.split("|");
    assert.equal(orc[1], "CA", "ORC-1 CA");
    assert.equal(orc[2], id, "naming the same requisition, or it cancels nothing");
  } finally {
    s.cleanup();
  }
});

test("a cancellation nobody acknowledged leaves the order still with them", async () => {
  let first = true;
  const s = site((sent) => {
    if (first) {
      first = false;
      return ack("AA", controlIdOf(sent));
    }
    return ack("AR", controlIdOf(sent), "order already collected");
  });
  try {
    const id = s.place();
    await sendOrder(s.deps, id, TARGET, CTX, GP);
    s.orders.cancel(id, { ...GP, reason: "patient declined" });
    const out = await sendOrderCancellation(s.deps, id, TARGET, CTX, GP);

    assert.equal(out.sent, false);
    const state = s.orders.cancellationState(id);
    assert.equal(state.state, "rejected");
    assert.match(state.detail, /They still hold the order/);
    assert.equal(s.orders.cancelledButStillWithFiller().length, 1, "and it stays on the list");
  } finally {
    s.cleanup();
  }
});

test("an order no laboratory ever had needs no cancellation, and says so", async () => {
  const s = site((sent) => ack("AA", controlIdOf(sent)));
  try {
    const id = s.place();
    s.orders.cancel(id, { ...GP, reason: "ordered in error" });
    const state = s.orders.cancellationState(id);
    assert.equal(state.state, "not-sent");
    assert.match(state.detail, /none is needed/);
    assert.deepEqual(s.orders.cancelledButStillWithFiller(), [], "nothing to chase");
  } finally {
    s.cleanup();
  }
});

test("a cancellation is refused for an order nobody cancelled", async () => {
  // Sending CA for a live order would stop a test somebody is waiting for.
  const s = site((sent) => ack("AA", controlIdOf(sent)));
  try {
    const id = s.place();
    await sendOrder(s.deps, id, TARGET, CTX, GP);
    const out = await sendOrderCancellation(s.deps, id, TARGET, CTX, GP);
    assert.equal(out.sent, false);
    assert.match(out.reason, /not cancelled/);
    assert.match(out.reason, /stop a test somebody is waiting for/);
    assert.equal(s.far.seen.length, 1, "only the original order reached the transport");
  } finally {
    s.cleanup();
  }
});
