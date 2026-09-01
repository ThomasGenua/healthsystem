import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Db, DEFAULT_TENANT } from "../src/db.ts";
import { DeliveryWorker } from "../src/core/queue.ts";
import type { HttpDestinationConfig } from "../src/types.ts";

function collector(handler: (path: string, body: string) => number) {
  const bodies: Array<{ path: string; body: string }> = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const status = handler(req.url ?? "/", body);
      if (status < 400) bodies.push({ path: req.url ?? "/", body });
      res.writeHead(status, { "content-type": "text/plain" });
      res.end(status < 400 ? "OK" : "boom");
    });
  });
  return new Promise<{ port: number; bodies: typeof bodies; close: () => Promise<void> }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        port,
        bodies,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

function seedChannel(db: Db, id: string): void {
  db.upsertChannel(id, id, true, "{}");
}

async function drain(worker: DeliveryWorker, db: Db, until: () => boolean, ticks = 400): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await worker.tick();
    if (until()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("drain timed out: " + JSON.stringify(db.stats()));
}

test("retries with backoff then delivers", async () => {
  const db = new Db(":memory:");
  seedChannel(db, "ch");
  let failures = 2;
  const c = await collector(() => (failures-- > 0 ? 503 : 200));
  const worker = new DeliveryWorker(db, 10);
  const dest: HttpDestinationConfig = {
    id: "d1",
    type: "http",
    url: `http://127.0.0.1:${c.port}/x`,
    maxAttempts: 5,
    backoffBaseMs: 5,
    backoffCapMs: 20,
  };
  worker.registerDestination(DEFAULT_TENANT, "ch", dest, 0);

  const msg = db.insertMessage("ch", "test", "text/plain", "payload-1");
  const id = db.enqueueDelivery({
    messageId: msg.id,
    channelId: "ch",
    destinationId: "d1",
    seq: msg.seq,
    ordered: false,
    skipOnDead: false,
    maxAttempts: 5,
    payload: "payload-1",
    contentType: "text/plain",
  });

  await drain(worker, db, () => db.getDelivery(id)?.state === "delivered");
  const row = db.getDelivery(id)!;
  assert.equal(row.state, "delivered");
  assert.equal(row.attempts, 3);
  assert.equal(c.bodies.length, 1);
  await c.close();
  db.close();
});

test("dead-letters after max attempts and replay recovers", async () => {
  const db = new Db(":memory:");
  seedChannel(db, "ch");
  let broken = true;
  const c = await collector(() => (broken ? 500 : 200));
  const worker = new DeliveryWorker(db, 10);
  worker.registerDestination(DEFAULT_TENANT, "ch",
    { id: "d1", type: "http", url: `http://127.0.0.1:${c.port}/x`, maxAttempts: 2, backoffBaseMs: 5, backoffCapMs: 10 },
    0
  );
  const msg = db.insertMessage("ch", "test", "text/plain", "payload-dead");
  const id = db.enqueueDelivery({
    messageId: msg.id,
    channelId: "ch",
    destinationId: "d1",
    seq: msg.seq,
    ordered: false,
    skipOnDead: false,
    maxAttempts: 2,
    payload: "payload-dead",
    contentType: "text/plain",
  });

  await drain(worker, db, () => db.getDelivery(id)?.state === "dead");
  assert.equal(db.getDelivery(id)!.attempts, 2);
  assert.match(db.getDelivery(id)!.last_error ?? "", /HTTP 500/);

  broken = false;
  assert.deepEqual(db.replayDelivery(id), { ok: true });
  await drain(worker, db, () => db.getDelivery(id)?.state === "delivered");
  assert.equal(c.bodies.length, 1);
  await c.close();
  db.close();
});

test("ordered destination holds later messages behind a failing head", async () => {
  const db = new Db(":memory:");
  seedChannel(db, "ch");
  let firstFailures = 2;
  const c = await collector((_p, body) => {
    if (body === "m1" && firstFailures-- > 0) return 503;
    return 200;
  });
  const worker = new DeliveryWorker(db, 10);
  worker.registerDestination(DEFAULT_TENANT, "ch",
    { id: "d1", type: "http", url: `http://127.0.0.1:${c.port}/x`, maxAttempts: 6, backoffBaseMs: 5, backoffCapMs: 15, ordered: true },
    0
  );

  const ids: string[] = [];
  for (const p of ["m1", "m2", "m3"]) {
    const msg = db.insertMessage("ch", "test", "text/plain", p);
    ids.push(
      db.enqueueDelivery({
        messageId: msg.id,
        channelId: "ch",
        destinationId: "d1",
        seq: msg.seq,
        ordered: true,
        skipOnDead: false,
        maxAttempts: 6,
        payload: p,
        contentType: "text/plain",
      })
    );
  }

  await drain(worker, db, () => ids.every((i) => db.getDelivery(i)?.state === "delivered"));
  assert.deepEqual(
    c.bodies.map((b) => b.body),
    ["m1", "m2", "m3"]
  );
  await c.close();
  db.close();
});

test("ordered flow blocks on a dead head until discarded", async () => {
  const db = new Db(":memory:");
  seedChannel(db, "ch");
  const c = await collector((_p, body) => (body === "bad" ? 500 : 200));
  const worker = new DeliveryWorker(db, 10);
  worker.registerDestination(DEFAULT_TENANT, "ch",
    { id: "d1", type: "http", url: `http://127.0.0.1:${c.port}/x`, maxAttempts: 2, backoffBaseMs: 5, backoffCapMs: 10, ordered: true },
    0
  );

  const bad = db.insertMessage("ch", "test", "text/plain", "bad");
  const badId = db.enqueueDelivery({
    messageId: bad.id,
    channelId: "ch",
    destinationId: "d1",
    seq: bad.seq,
    ordered: true,
    skipOnDead: false,
    maxAttempts: 2,
    payload: "bad",
    contentType: "text/plain",
  });
  const good = db.insertMessage("ch", "test", "text/plain", "good");
  const goodId = db.enqueueDelivery({
    messageId: good.id,
    channelId: "ch",
    destinationId: "d1",
    seq: good.seq,
    ordered: true,
    skipOnDead: false,
    maxAttempts: 2,
    payload: "good",
    contentType: "text/plain",
  });

  await drain(worker, db, () => db.getDelivery(badId)?.state === "dead");
  for (let i = 0; i < 10; i++) await worker.tick();
  assert.equal(db.getDelivery(goodId)!.state, "queued");
  assert.equal(c.bodies.length, 0);

  assert.equal(db.discardDelivery(badId), true);
  await drain(worker, db, () => db.getDelivery(goodId)?.state === "delivered");
  assert.deepEqual(c.bodies.map((b) => b.body), ["good"]);
  await c.close();
  db.close();
});

test("hash chain verifies and detects tampering", () => {
  const db = new Db(":memory:");
  seedChannel(db, "ch");
  db.insertMessage("ch", "test", "text/plain", "one");
  db.insertMessage("ch", "test", "text/plain", "two");
  db.insertMessage("ch", "test", "text/plain", "three");
  const clean = db.verifyChain("ch");
  assert.deepEqual(
    { ok: clean.ok, checked: clean.checked, payloadsChecked: clean.payloadsChecked, redacted: clean.redacted },
    { ok: true, checked: 3, payloadsChecked: 3, redacted: 0 }
  );
  assert.equal(clean.tip, db.getChannel("ch")!.last_hash, "a clean walk reports the tip it arrived at");

  db.sql.prepare("UPDATE messages SET raw = 'tampered' WHERE raw = 'two'").run();
  const v = db.verifyChain("ch");
  assert.equal(v.ok, false);
  assert.equal(v.checked, 1);
  // The payload digest recorded at ingest is what catches this: the chain
  // links still line up, but the row no longer matches what it committed to.
  assert.equal(v.payloadsChecked, 1);
  db.close();
});

test("a message the far end refused is not retried, and does not hold the queue behind it", async () => {
  // The distinction the retry loop was missing. A malformed message rejected
  // with 400 does not become acceptable by being sent again — the same bytes
  // get the same answer — so retrying it costs the attempt budget, delays the
  // dead letter a human has to look at, and, on an ordered destination, holds
  // up every message queued behind it for the whole backoff schedule.
  //
  // Those later messages are somebody's results arriving late because of a
  // message that could never have been delivered at all.
  const db = new Db(":memory:");
  seedChannel(db, "ch");
  let attemptsOnBad = 0;
  const c = await collector((_p, body) => {
    if (body === "bad") {
      attemptsOnBad++;
      return 400;
    }
    return 200;
  });
  const worker = new DeliveryWorker(db, 10);
  worker.registerDestination(DEFAULT_TENANT, "ch",
    { id: "d1", type: "http", url: `http://127.0.0.1:${c.port}/x`, maxAttempts: 6, backoffBaseMs: 5, backoffCapMs: 15, ordered: true, skipOnDead: true },
    0
  );

  const ids: string[] = [];
  for (const p of ["bad", "good1", "good2"]) {
    const msg = db.insertMessage("ch", "test", "text/plain", p);
    ids.push(
      db.enqueueDelivery({
        messageId: msg.id,
        channelId: "ch",
        destinationId: "d1",
        seq: msg.seq,
        ordered: true,
        skipOnDead: true,
        maxAttempts: 6,
        payload: p,
        contentType: "text/plain",
      })
    );
  }

  try {
    await drain(worker, db, () => ids.slice(1).every((i) => db.getDelivery(i)?.state === "delivered"));

    assert.equal(attemptsOnBad, 1, "sent once, not six times");
    const dead = db.getDelivery(ids[0])!;
    assert.equal(dead.state, "dead");
    assert.match(dead.last_error ?? "", /HTTP 400/);
    assert.match(
      dead.last_error ?? "",
      /not retried: the same message would be refused again/,
      "a dead letter with one attempt on it otherwise reads as a retry loop that failed to run"
    );
    assert.deepEqual(c.bodies.map((b) => b.body), ["good1", "good2"], "and the queue behind it moved");
  } finally {
    // Closed in finally because a drain that times out throws, and a leaked
    // listening server keeps the runner alive: the regression would hang CI
    // rather than failing it, which is a worse outcome than the bug.
    await c.close();
    db.close();
  }
});

test("a server error is still retried, because that is what retries are for", async () => {
  // The other half. 5xx, a refused connection, a timeout: the message may well
  // be fine and the far end is not. Treating those as permanent would throw
  // away a message that a retry would have delivered.
  const db = new Db(":memory:");
  seedChannel(db, "ch");
  let failures = 2;
  const c = await collector((_p, body) => (body === "m1" && failures-- > 0 ? 503 : 200));
  const worker = new DeliveryWorker(db, 10);
  worker.registerDestination(DEFAULT_TENANT, "ch",
    { id: "d1", type: "http", url: `http://127.0.0.1:${c.port}/x`, maxAttempts: 6, backoffBaseMs: 5, backoffCapMs: 15 },
    0
  );
  const msg = db.insertMessage("ch", "test", "text/plain", "m1");
  const id = db.enqueueDelivery({
    messageId: msg.id,
    channelId: "ch",
    destinationId: "d1",
    seq: msg.seq,
    ordered: false,
    skipOnDead: false,
    maxAttempts: 6,
    payload: "m1",
    contentType: "text/plain",
  });

  try {
    await drain(worker, db, () => db.getDelivery(id)?.state === "delivered");
    assert.equal(db.getDelivery(id)!.state, "delivered", "it took three goes and got there");
  } finally {
    await c.close();
    db.close();
  }
});

test("the two statuses that ask to be retried are retried", async () => {
  // 408 and 429 are 4xx and are not statements about the message: one says the
  // far end gave up waiting, the other says to come back later. Reading them
  // as permanent would discard a message over a rate limit.
  for (const status of [408, 429]) {
    const db = new Db(":memory:");
    seedChannel(db, "ch");
    let failures = 1;
    const c = await collector(() => (failures-- > 0 ? status : 200));
    const worker = new DeliveryWorker(db, 10);
    worker.registerDestination(DEFAULT_TENANT, "ch",
      { id: "d1", type: "http", url: `http://127.0.0.1:${c.port}/x`, maxAttempts: 4, backoffBaseMs: 5, backoffCapMs: 15 },
      0
    );
    const msg = db.insertMessage("ch", "test", "text/plain", "m1");
    const id = db.enqueueDelivery({
      messageId: msg.id,
      channelId: "ch",
      destinationId: "d1",
      seq: msg.seq,
      ordered: false,
      skipOnDead: false,
      maxAttempts: 4,
      payload: "m1",
      contentType: "text/plain",
    });
    try {
      await drain(worker, db, () => db.getDelivery(id)?.state === "delivered");
      assert.equal(db.getDelivery(id)!.state, "delivered", `${status} should be retried`);
    } finally {
      await c.close();
      db.close();
    }
  }
});
