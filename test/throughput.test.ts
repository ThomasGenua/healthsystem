/**
 * Throughput properties of ordered delivery.
 *
 * These are correctness tests wearing performance clothing. An ordered
 * destination used to release exactly one message per timer tick, because
 * every later candidate was blocked by its predecessor still being queued.
 * Nothing was wrong with the result — order held, nothing was lost — but the
 * drain rate was capped at 1/tickMs regardless of how fast the far end
 * answered, so a backlog from a satellite outage took hours instead of
 * minutes. The whole point of the engine is surviving that outage and then
 * catching up.
 *
 * The tests below are written against ticks rather than wall-clock time, so
 * they assert the property rather than the speed of the machine running them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Engine } from "../src/core/engine.ts";
import { until } from "./helpers.ts";
import type { ChannelConfig } from "../src/types.ts";

/** A sink that records arrival order and can be made to fail. */
async function sink(): Promise<{
  port: number;
  received: string[];
  failNext: (n: number) => void;
  close: () => Promise<void>;
}> {
  const received: string[] = [];
  let failures = 0;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      if (failures > 0) {
        failures--;
        res.writeHead(503).end();
        return;
      }
      received.push(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(200).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return {
    port: (server.address() as { port: number }).port,
    received,
    failNext: (n: number) => {
      failures = n;
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const channel = (id: string, port: number, extra: Record<string, unknown> = {}): ChannelConfig => ({
  id,
  name: id,
  source: { type: "http", path: id },
  destinations: [
    {
      id: "remote",
      type: "http",
      url: `http://127.0.0.1:${port}/in`,
      ordered: true,
      maxAttempts: 5,
      backoffBaseMs: 5,
      backoffCapMs: 20,
      timeoutMs: 2_000,
      ...extra,
    },
  ],
});

/** The timer is effectively off, so every tick in these tests is deliberate. */
function engineWithManualTicks(): Engine {
  return new Engine({ dbPath: ":memory:", tickMs: 1_000_000 });
}

test("one tick drains an ordered backlog, rather than one message per tick", async () => {
  const s = await sink();
  const engine = engineWithManualTicks();
  await engine.start();
  try {
    await engine.addChannel(channel("burst", s.port));
    for (let i = 0; i < 50; i++) engine.ingest("burst", JSON.stringify({ n: i }), "application/json", "test");

    // This is the assertion that would have failed before: a single pass used
    // to deliver exactly one message.
    const sent = await engine.worker.tick();
    assert.equal(sent, 50, `one pass should drain the backlog, sent ${sent}`);
    assert.equal(s.received.length, 50);
    assert.equal(engine.db.listDeliveries({ channelId: "burst", state: "delivered" }).length, 50);
  } finally {
    await engine.stop();
    await s.close();
  }
});

test("draining fast does not reorder", async () => {
  const s = await sink();
  const engine = engineWithManualTicks();
  await engine.start();
  try {
    await engine.addChannel(channel("ordered-burst", s.port));
    for (let i = 0; i < 200; i++) engine.ingest("ordered-burst", JSON.stringify({ n: i }), "application/json", "test");

    await engine.worker.tick();
    assert.equal(s.received.length, 200);

    const order = s.received.map((b) => (JSON.parse(b) as { n: number }).n);
    assert.deepEqual(
      order,
      Array.from({ length: 200 }, (_, i) => i),
      "strict arrival order must survive the faster drain"
    );
  } finally {
    await engine.stop();
    await s.close();
  }
});

test("a failure stops that key's drain, so nothing overtakes it", async () => {
  const s = await sink();
  const engine = engineWithManualTicks();
  await engine.start();
  try {
    await engine.addChannel(channel("blocked", s.port));
    for (let i = 0; i < 10; i++) engine.ingest("blocked", JSON.stringify({ n: i }), "application/json", "test");

    // The head fails once. The drain must stop there rather than moving on.
    s.failNext(1);
    await engine.worker.tick();

    assert.equal(s.received.length, 0, "nothing may pass a message that has not been delivered");
    assert.equal(engine.db.listDeliveries({ channelId: "blocked", state: "delivered" }).length, 0);

    // Once the backoff elapses the whole backlog goes, still in order. The
    // failed head returns to 'queued' immediately but is not due until its
    // backoff passes, so tick until it moves rather than assuming one pass.
    const deadline = Date.now() + 5_000;
    while (s.received.length < 10 && Date.now() < deadline) {
      await engine.worker.tick();
      if (s.received.length < 10) await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(s.received.length, 10);
    assert.deepEqual(
      s.received.map((b) => (JSON.parse(b) as { n: number }).n),
      Array.from({ length: 10 }, (_, i) => i)
    );
  } finally {
    await engine.stop();
    await s.close();
  }
});

test("independent channels drain in the same pass instead of queueing behind each other", async () => {
  const a = await sink();
  const b = await sink();
  const engine = engineWithManualTicks();
  await engine.start();
  try {
    await engine.addChannel(channel("feed-a", a.port));
    await engine.addChannel(channel("feed-b", b.port));
    for (let i = 0; i < 25; i++) {
      engine.ingest("feed-a", JSON.stringify({ n: i }), "application/json", "test");
      engine.ingest("feed-b", JSON.stringify({ n: i }), "application/json", "test");
    }

    await engine.worker.tick();
    assert.equal(a.received.length, 25, "feed A drained");
    assert.equal(b.received.length, 25, "feed B drained in the same pass");
  } finally {
    await engine.stop();
    await a.close();
    await b.close();
  }
});

test("one busy channel cannot starve another", async () => {
  // drainLimit bounds how much a single key may send per pass, so a channel
  // with an enormous backlog does not hold the pass open indefinitely.
  const busy = await sink();
  const quiet = await sink();
  const engine = new Engine({ dbPath: ":memory:", tickMs: 1_000_000 });
  await engine.start();
  try {
    await engine.addChannel(channel("busy", busy.port));
    await engine.addChannel(channel("quiet", quiet.port));
    for (let i = 0; i < 40; i++) engine.ingest("busy", JSON.stringify({ n: i }), "application/json", "test");
    engine.ingest("quiet", JSON.stringify({ n: 0 }), "application/json", "test");

    await engine.worker.tick();
    assert.equal(quiet.received.length, 1, "the quiet channel is served in the same pass as the busy one");
    assert.equal(busy.received.length, 40);
  } finally {
    await engine.stop();
    await busy.close();
    await quiet.close();
  }
});

test("ingest commits atomically: a pipeline error leaves no half-written message", async () => {
  // The transaction that made ingest faster also made it atomic. A message,
  // its steps and its deliveries are one commit, so a failure cannot leave a
  // stored message that will never be delivered and that nothing retries.
  const engine = engineWithManualTicks();
  await engine.start();
  try {
    await engine.addChannel({
      id: "atomic",
      name: "atomic",
      source: { type: "http", path: "atomic" },
      pipeline: [{ type: "transform.mapping", mapping: "no-such-mapping" }],
      destinations: [{ id: "facade", type: "fhirstore", ordered: true }],
    });

    const result = engine.ingest("atomic", "MSH|^~\\&|X", "x-application/hl7-v2+er7", "test");
    assert.equal(result.status, "error");

    // The failure is recorded — the error path commits, it does not roll back,
    // because an operator needs to see what arrived and why it failed.
    const rows = engine.db.listMessages({ channelId: "atomic" });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "error");
    assert.match(rows[0].error ?? "", /no-such-mapping/);

    // But nothing was enqueued, so there is no delivery in limbo.
    assert.equal(engine.db.listDeliveries({ channelId: "atomic" }).length, 0);
    assert.equal(engine.db.verifyChain("atomic").ok, true);
  } finally {
    await engine.stop();
  }
});
