/**
 * The laboratory interface end to end, over the wire it will actually arrive on.
 *
 * The unit tests drive `LabIntake` directly. This drives MLLP → pipeline →
 * durable delivery → the order loop, because the guarantee being claimed is
 * that an AA acknowledgement means the result is filed against the order and
 * owed to a clinician, and that guarantee lives in the wiring rather than in
 * any one module.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine } from "../src/core/engine.ts";
import { mllpSend } from "../src/hl7/mllp.ts";
import { until } from "./helpers.ts";
import type { LabProfile } from "../src/orders/hl7.ts";

const P = "NT123456";
const GP = { actorId: "dr-tetso", actorKind: "practitioner" };
const FEED = { authorId: "adt-feed", authorKind: "device" };

const PROFILE: LabProfile = {
  id: "test-lab",
  name: "Test laboratory",
  patientAssigningAuthority: "JHN",
  timezoneOffset: "-05:00",
};

async function clinic() {
  const engine = new Engine({ dbPath: ":memory:", tickMs: 15 });
  engine.registerLabProfile(PROFILE);
  await engine.start();
  const t = engine.forTenant("default");
  t.clinical.record({
    entryType: "Patient",
    patientId: P,
    content: {
      resourceType: "Patient",
      identifier: [{ system: "urn:jhn", value: P }],
      name: [{ family: "Beaulieu", given: ["Marie"], use: "official" }],
      birthDate: "1984-03-17",
    },
    ...FEED,
  });
  await engine.addChannel({
    id: "lab-in",
    name: "Laboratory results",
    source: { type: "mllp", port: 0 },
    pipeline: [
      { type: "filter.hl7Type", allow: ["ORU^R01"] },
      { type: "split.hl7Group", segment: "OBR" },
    ],
    destinations: [{ id: "orders", type: "labresults", profile: "test-lab", ordered: true }],
  });
  return { engine, t, port: engine.mllpPort("lab-in")! };
}

function oru(placer: string, opts: { value?: string; status?: string; flag?: string; control?: string; filler?: string } = {}) {
  const { value = "4.1", status = "F", flag = "N", control = "MSG-1", filler = "ACC-9001" } = opts;
  return [
    `MSH|^~\\&|LABAPP|STANTON|PORTAGE|GNWT|20260824104500||ORU^R01|${control}|P|2.5.1`,
    `PID|1||${P}^^^JHN^MR||Beaulieu^Marie||19840317|F`,
    `ORC|RE|${placer}|${filler}`,
    `OBR|1|${placer}|${filler}|CHEM^Chemistry panel|||20260824103000`,
    `OBX|1|NM|2823-3^Potassium^LN|1|${value}|mmol/L|3.5-5.1|${flag}|||${status}|||20260824103000`,
  ].join("\r");
}

test("an ORU over MLLP closes the order and lands on the clinician's worklist", async () => {
  const { engine, t, port } = await clinic();
  try {
    const order = t.orders.create({
      patientId: P,
      category: "lab",
      code: "2823-3",
      display: "Potassium",
      indication: "Electrolyte check",
      by: GP,
    });
    t.orders.place(order.id, { ...GP, responsibleId: "dr-tetso", expectedBy: "2026-08-24T00:00:00Z" });

    const ack = await mllpSend("127.0.0.1", port, oru(order.id, { value: "7.1", flag: "HH" }), 5000);
    assert.match(ack, /MSA\|AA/, "an AA means it is durably queued");

    await until(() => t.orders.get(order.id)!.status === "completed");
    const filed = t.orders.resultsFor(order.id);
    assert.equal(filed.length, 1);
    assert.equal(filed[0].value, "7.1");
    assert.equal(filed[0].abnormal_flag, "critical-high");
    assert.equal(filed[0].source_system, "test-lab");
    assert.ok(filed[0].source_message_id, "the message that produced it is on the row");
    // Observed time was read with the profile's declared offset.
    assert.equal(filed[0].observed_at, "2026-08-24T15:30:00.000Z");
    assert.equal(filed[0].timezone_assumed, 0);

    // The point of filing rather than mapping: it is on somebody's list.
    const worklist = t.workspace.worklist("dr-tetso");
    assert.equal(worklist.unacknowledgedResults.items.length, 1);
    assert.equal(worklist.unacknowledgedResults.items[0].value, "7.1");
    assert.equal(worklist.ordersAwaitingResult.items.length, 0, "and off the overdue list");

    // The delivery ack records what the interface actually did.
    const delivered = engine.db.listDeliveries({ channelId: "lab-in" });
    assert.equal(delivered.length, 1);
    assert.match(delivered[0].ack ?? "", /filed/);
  } finally {
    await engine.stop();
  }
});

test("a retransmission over the wire does not duplicate the result", async () => {
  const { engine, t, port } = await clinic();
  try {
    const order = t.orders.create({
      patientId: P,
      category: "lab",
      code: "2823-3",
      display: "Potassium",
      indication: "Check",
      by: GP,
    });
    t.orders.place(order.id, { ...GP, responsibleId: "dr-tetso" });

    await mllpSend("127.0.0.1", port, oru(order.id), 5000);
    await until(() => t.orders.resultsFor(order.id).length === 1);

    await mllpSend("127.0.0.1", port, oru(order.id, { control: "MSG-REPEAT" }), 5000);
    // Waiting on the ack rather than on the row: the delivery row exists as
    // soon as it is queued, so counting rows would race the worker that fills
    // it in and this test would pass on an empty ack.
    await until(() => engine.db.listDeliveries({ channelId: "lab-in" }).filter((d) => d.ack).length === 2);
    assert.equal(t.orders.resultsFor(order.id).length, 1, "still one result");

    const acks = engine.db.listDeliveries({ channelId: "lab-in" }).map((d) => d.ack ?? "");
    assert.ok(acks.some((a) => /unchanged/.test(a)), `the ack says it was a resend, got ${JSON.stringify(acks)}`);
  } finally {
    await engine.stop();
  }
});

test("a result nobody can identify is held, and the message is still acknowledged", async () => {
  // The laboratory has done nothing wrong, so refusing the message would make
  // it retry forever and eventually dead-letter. It is accepted, and the work
  // of identifying the patient becomes a queue.
  const { engine, t, port } = await clinic();
  try {
    const raw = oru("", { control: "MSG-UNKNOWN" }).replace(`${P}^^^JHN^MR`, "NT-NOBODY^^^JHN^MR");
    const ack = await mllpSend("127.0.0.1", port, raw, 5000);
    assert.match(ack, /MSA\|AA/);

    await until(() => t.labIntake.heldForIdentity().length === 1);
    assert.equal(t.orders.unmatched().length, 0, "nothing was filed against a guess");
    const acks = engine.db.listDeliveries({ channelId: "lab-in" }).map((d) => d.ack ?? "");
    assert.ok(acks.some((a) => /unidentified held/.test(a)), `got ${JSON.stringify(acks)}`);
  } finally {
    await engine.stop();
  }
});

test("a destination naming a laboratory profile that does not exist fails loudly", async () => {
  // Falling back to the generic reading would tell a site its vendor interface
  // was working.
  const engine = new Engine({ dbPath: ":memory:", tickMs: 15 });
  await engine.start();
  try {
    await engine.addChannel({
      id: "lab-typo",
      name: "Laboratory with a mistyped profile",
      source: { type: "mllp", port: 0 },
      pipeline: [{ type: "filter.hl7Type", allow: ["ORU^R01"] }],
      destinations: [{ id: "orders", type: "labresults", profile: "dynacare", maxAttempts: 1 }],
    });
    const t = engine.forTenant("default");
    t.clinical.record({
      entryType: "Patient",
      patientId: P,
      content: { resourceType: "Patient", identifier: [{ system: "urn:jhn", value: P }], name: [{ family: "Beaulieu" }] },
      ...FEED,
    });

    await mllpSend("127.0.0.1", engine.mllpPort("lab-typo")!, oru(""), 5000);
    await until(() => engine.db.listDeliveries({ channelId: "lab-typo", state: "dead" }).length === 1);
    const dead = engine.db.listDeliveries({ channelId: "lab-typo", state: "dead" })[0];
    assert.match(dead.last_error ?? "", /unknown laboratory profile 'dynacare'/);
  } finally {
    await engine.stop();
  }
});

test("a labresults destination cannot be configured behind a mapping step", async () => {
  // The payload after a mapping is JSON, so the destination would refuse every
  // message — a whole feed dead-lettering for a reason that is visible at
  // configuration time and invisible at three in the morning.
  const engine = new Engine({ dbPath: ":memory:", tickMs: 15 });
  await engine.start();
  try {
    await assert.rejects(
      () =>
        engine.addChannel({
          id: "lab-mapped",
          name: "Laboratory behind a mapping",
          source: { type: "mllp", port: 0 },
          pipeline: [{ type: "transform.mapping", mapping: "oru-observation" }],
          destinations: [{ id: "orders", type: "labresults" }],
        }),
      /cannot follow a transform.mapping step/
    );
  } finally {
    await engine.stop();
  }
});

test("registering a laboratory profile refuses one with no id or name", async () => {
  const engine = new Engine({ dbPath: ":memory:", tickMs: 15 });
  try {
    assert.throws(() => engine.registerLabProfile({ id: "", name: "x" } as LabProfile), /needs an id/);
    assert.throws(() => engine.registerLabProfile({ id: "x", name: "" } as LabProfile), /needs a name/);
  } finally {
    await engine.stop();
  }
});
