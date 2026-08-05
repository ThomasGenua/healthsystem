import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Engine } from "../src/core/engine.ts";
import { mllpSend } from "../src/hl7/mllp.ts";
import { startMeridianSim } from "../demo/meridian-sim.ts";
import { startSatLink } from "../demo/satlink.ts";
import { createServer as createTcpServer, connect as connectTcp } from "node:net";
import type { ChannelConfig, MappingDoc } from "../src/types.ts";

const MAPPING = JSON.parse(
  readFileSync(new URL("../mappings/adt-patient.json", import.meta.url), "utf8")
) as MappingDoc;

const adt = (n: number) =>
  [
    `MSH|^~\\&|WOLF|YKPCC|PORTAGE|GNWT|20260805120000||ADT^A04^ADT_A01|T${String(n).padStart(4, "0")}|P|2.5.1`,
    `PID|1||NT${String(800000 + n)}^^^NWT^JHN||Link^Test^${n}||19900101|F`,
    "PV1|1|O",
  ].join("\r") + "\r";

async function until(cond: () => boolean, ms = 15_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("condition not reached");
}

function delivered(engine: Engine): number {
  const s = engine.db.stats() as { deliveries?: Record<string, number> };
  return s.deliveries?.delivered ?? 0;
}

test("outage on the link loses nothing and preserves strict order", async () => {
  const meridian = await startMeridianSim(0);
  const link = await startSatLink({
    listenPort: 0,
    targetHost: "127.0.0.1",
    targetPort: meridian.port,
    latencyMs: 5,
    jitterMs: 5,
  });

  const engine = new Engine({ dbPath: ":memory:", tickMs: 15 });
  engine.registerMapping(MAPPING);
  await engine.start();
  const channel: ChannelConfig = {
    id: "demo-link-test",
    name: "link test",
    source: { type: "mllp", port: 0 },
    pipeline: [
      { type: "filter.hl7Type", allow: ["ADT^A04"] },
      { type: "transform.mapping", mapping: "adt-patient" },
    ],
    destinations: [
      {
        id: "meridian",
        type: "http",
        url: `http://127.0.0.1:${link.port}/fhir/Patient`,
        ordered: true,
        maxAttempts: 60,
        backoffBaseMs: 40,
        backoffCapMs: 150,
        timeoutMs: 1500,
      },
    ],
  };
  await engine.addChannel(channel);
  const port = engine.mllpPort("demo-link-test")!;

  // Healthy: three through, confirmed on both ends before the link drops.
  for (let n = 1; n <= 3; n++) {
    const ack = await mllpSend("127.0.0.1", port, adt(n), 3000);
    assert.match(ack, /MSA\|AA/);
  }
  await until(() => meridian.received.length === 3);
  await until(() => delivered(engine) === 3);

  // Outage: four more are acked but go nowhere.
  link.setOutage(true);
  for (let n = 4; n <= 7; n++) {
    const ack = await mllpSend("127.0.0.1", port, adt(n), 3000);
    assert.match(ack, /MSA\|AA/, "AA must still be issued during the outage");
  }
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(meridian.received.length, 3, "nothing crosses a dead link");
  const stats = engine.db.stats() as { deliveries?: Record<string, number> };
  assert.ok((stats.deliveries?.queued ?? 0) >= 1, "queue holds the backlog");

  // Restore: everything drains in strict arrival order, no duplicates.
  link.setOutage(false);
  await until(() => meridian.received.length === 7, 20_000);
  const ids = meridian.received.map((r) => r.identifier);
  assert.deepEqual(
    ids,
    [1, 2, 3, 4, 5, 6, 7].map((n) => `NT${800000 + n}`),
    "strict arrival order after restore"
  );
  assert.equal(new Set(ids).size, 7, "no duplicates");
  assert.equal(engine.db.verifyChain("demo-link-test").ok, true);

  await engine.stop();
  await link.close();
  await meridian.close();
});

test("a lossy, bandwidth-shaped link still delivers everything in order", async () => {
  const meridian = await startMeridianSim(0);
  const link = await startSatLink({
    listenPort: 0,
    targetHost: "127.0.0.1",
    targetPort: meridian.port,
    latencyMs: 5,
    jitterMs: 15,
    // Heavy loss and a narrow uplink. Loss surfaces as retransmission delay,
    // never as discarded bytes: this proxy sits above TCP, where dropping a
    // chunk would truncate the stream in a way a real link never does.
    packetLossPct: 25,
    bandwidthKbps: 64,
    rtoMs: 20,
  });

  const engine = new Engine({ dbPath: ":memory:", tickMs: 15 });
  engine.registerMapping(MAPPING);
  await engine.start();
  await engine.addChannel({
    id: "demo-lossy",
    name: "lossy link",
    source: { type: "mllp", port: 0 },
    pipeline: [
      { type: "filter.hl7Type", allow: ["ADT^A04"] },
      { type: "transform.mapping", mapping: "adt-patient" },
    ],
    destinations: [
      {
        id: "meridian",
        type: "http",
        url: `http://127.0.0.1:${link.port}/fhir/Patient`,
        ordered: true,
        maxAttempts: 60,
        backoffBaseMs: 40,
        backoffCapMs: 200,
        timeoutMs: 5000,
      },
    ],
  });
  const port = engine.mllpPort("demo-lossy")!;

  try {
    for (let n = 1; n <= 6; n++) {
      assert.match(await mllpSend("127.0.0.1", port, adt(n), 5000), /MSA\|AA/);
    }

    await until(() => meridian.received.length === 6, 30_000);

    const ids = meridian.received.map((r) => r.identifier);
    assert.deepEqual(
      ids,
      [1, 2, 3, 4, 5, 6].map((n) => `NT${800000 + n}`),
      "order survives loss and shaping"
    );
    assert.equal(new Set(ids).size, 6, "no duplicates");
    assert.equal(engine.db.verifyChain("demo-lossy").ok, true);

    // The impairment has to have actually engaged, or this test proves nothing.
    assert.ok(link.stats().retransmits > 0, "25% loss over six messages must cause retransmissions");
  } finally {
    await engine.stop();
    await link.close();
    await meridian.close();
  }
});

test("bandwidth shaping slows delivery in proportion to the configured rate", async () => {
  const meridian = await startMeridianSim(0);
  const payload = "x".repeat(20_000);

  const timeThrough = async (bandwidthKbps: number): Promise<number> => {
    const link = await startSatLink({
      listenPort: 0,
      targetHost: "127.0.0.1",
      targetPort: meridian.port,
      bandwidthKbps,
    });
    const before = meridian.received.length;
    const started = Date.now();
    await fetch(`http://127.0.0.1:${link.port}/fhir/Patient`, {
      method: "POST",
      headers: { "content-type": "application/fhir+json" },
      body: JSON.stringify({ resourceType: "Patient", identifier: [{ system: "s", value: "bw" }], note: payload }),
    });
    await until(() => meridian.received.length > before, 30_000);
    const elapsed = Date.now() - started;
    await link.close();
    return elapsed;
  };

  try {
    // 20KB at 256kbps is ~640ms of serialisation; unshaped is near-instant.
    const shaped = await timeThrough(256);
    const unshaped = await timeThrough(0);
    assert.ok(shaped > 300, `256kbps should take real time, took ${shaped}ms`);
    assert.ok(shaped > unshaped * 2, `shaped ${shaped}ms should clearly exceed unshaped ${unshaped}ms`);
  } finally {
    await meridian.close();
  }
});

test("delivery stays ordered under jitter that would otherwise reorder chunks", async () => {
  // Jitter is drawn per chunk. Without a monotonic delivery clock a later
  // chunk can be scheduled ahead of an earlier one and reorder the stream —
  // something TCP never does, and which would silently corrupt an HL7 or HTTP
  // body. Many small chunks spaced by 1ms against 150ms of jitter make the
  // reordering near-certain if the clock is not enforced.
  const chunks = 120;
  let received = "";
  const sink = createTcpServer((sock) => {
    sock.on("data", (d: Buffer) => {
      received += d.toString("utf8");
    });
  });
  await new Promise<void>((r) => sink.listen(0, "127.0.0.1", () => r()));
  const sinkPort = (sink.address() as { port: number }).port;

  const link = await startSatLink({
    listenPort: 0,
    targetHost: "127.0.0.1",
    targetPort: sinkPort,
    latencyMs: 5,
    jitterMs: 150,
  });

  try {
    const client = connectTcp(link.port, "127.0.0.1");
    await new Promise<void>((r) => client.on("connect", () => r()));

    const expected = Array.from({ length: chunks }, (_, i) => `<${String(i).padStart(4, "0")}>`);
    for (const chunk of expected) {
      client.write(chunk);
      await new Promise((r) => setTimeout(r, 1));
    }

    await until(() => received.length >= expected.join("").length, 30_000);
    client.destroy();

    assert.equal(received, expected.join(""), "chunks must arrive in the order they were written");
  } finally {
    await link.close();
    await new Promise<void>((r) => sink.close(() => r()));
  }
});
