/**
 * Recovery from an unclean shutdown.
 *
 * The engine's central promise is that an acknowledgement means the message is
 * durably queued and a restart resumes exactly where it stopped. Every other
 * test runs in memory and shuts down gracefully, which exercises neither half.
 *
 * These use a real database file and a second Engine over the same file to
 * stand in for a restart. scripts/crashtest.ts does the heavier version with
 * real processes and SIGKILL; this is the part fast enough to run in CI.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../src/db.ts";
import { Engine } from "../src/core/engine.ts";
import { until } from "./helpers.ts";
import type { ChannelConfig } from "../src/types.ts";

const channel = (port: number): ChannelConfig => ({
  id: "recover",
  name: "recovery",
  source: { type: "http", path: "recover" },
  destinations: [
    {
      id: "sink",
      type: "http",
      url: `http://127.0.0.1:${port}/in`,
      ordered: true,
      maxAttempts: 20,
      backoffBaseMs: 5,
      backoffCapMs: 50,
      timeoutMs: 1_000,
    },
  ],
});

async function sink(): Promise<{ port: number; received: number[]; close: () => Promise<void> }> {
  const received: number[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      try {
        received.push((JSON.parse(Buffer.concat(chunks).toString("utf8")) as { n: number }).n);
      } catch {
        /* ignore */
      }
      res.writeHead(200).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return {
    port: (server.address() as { port: number }).port,
    received,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

test("a delivery left in flight by a crash is requeued, not abandoned", async () => {
  // The failure this prevents is silent and permanent: nothing ever claims an
  // inflight row, and an ordered destination treats it as blocking, so one
  // orphan stops the whole feed. A hard kill mid-send is enough to cause it.
  const dir = mkdtempSync(join(tmpdir(), "northstar-recover-"));
  const s = await sink();
  const dbPath = join(dir, "northstar.db");

  try {
    // Write a queue, then simulate dying mid-send by marking one inflight and
    // dropping the engine without ever recording an outcome.
    {
      const engine = new Engine({ dbPath, tickMs: 1_000_000 });
      await engine.start();
      await engine.addChannel(channel(s.port));
      for (let i = 0; i < 10; i++) engine.ingest("recover", JSON.stringify({ n: i }), "application/json", "test");

      const head = engine.db.listDeliveries({ channelId: "recover" }).reverse()[0];
      engine.db.markInflight(head.id);
      await engine.stop();
    }

    // What a crash leaves behind.
    {
      const check = new Db(dbPath, { readOnly: true });
      const stuck = check.sql.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE state = 'inflight'").get() as {
        n: number;
      };
      check.close();
      assert.equal(stuck.n, 1, "the setup must leave exactly one orphaned delivery");
    }

    // Restart. The orphan must come back to the queue.
    const engine = new Engine({ dbPath, tickMs: 15 });
    await engine.start();
    try {
      assert.equal(
        engine.db.listDeliveries({ channelId: "recover", state: "inflight" }).length,
        0,
        "no delivery may still be marked in flight after a restart"
      );

      await until(() => s.received.length === 10, 15_000);
      assert.deepEqual(
        s.received,
        Array.from({ length: 10 }, (_, i) => i),
        "the whole backlog drains, in order, after recovery"
      );
      assert.equal(engine.db.verifyChain("recover").ok, true);
    } finally {
      await engine.stop();
    }
  } finally {
    await s.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("without recovery the channel would be wedged, so the reclaim is load-bearing", async () => {
  // Pins why the previous test matters rather than restating that it passes:
  // an inflight row blocks every ordered message behind it, permanently.
  const dir = mkdtempSync(join(tmpdir(), "northstar-wedge-"));
  const s = await sink();
  const dbPath = join(dir, "northstar.db");

  try {
    const engine = new Engine({ dbPath, tickMs: 15 });
    await engine.start();
    try {
      await engine.addChannel(channel(s.port));
      for (let i = 0; i < 5; i++) engine.ingest("recover", JSON.stringify({ n: i }), "application/json", "test");

      // Wedge the head while the engine is running — no restart, so nothing
      // reclaims it.
      const head = engine.db.listDeliveries({ channelId: "recover" }).reverse()[0];
      engine.db.markInflight(head.id);

      await new Promise((r) => setTimeout(r, 400));
      assert.equal(s.received.length, 0, "an inflight head blocks everything behind it");
      assert.equal(engine.db.listDeliveries({ channelId: "recover", state: "queued" }).length, 4);
    } finally {
      await engine.stop();
    }
  } finally {
    await s.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("reclaim counts the interrupted attempt and says why", async () => {
  const dir = mkdtempSync(join(tmpdir(), "northstar-reclaim-"));
  const dbPath = join(dir, "northstar.db");
  try {
    const db = new Db(dbPath);
    db.upsertChannel("c", "c", true, "{}");
    const msg = db.insertMessage("c", "test", "text/plain", "one");
    db.enqueueDelivery({
      messageId: msg.id,
      channelId: "c",
      destinationId: "d",
      seq: msg.seq,
      ordered: true,
      skipOnDead: false,
      maxAttempts: 8,
      payload: "one",
      contentType: "text/plain",
    });
    const row = db.listDeliveries({ channelId: "c" })[0];
    db.markInflight(row.id);
    const inflight = db.getDelivery(row.id)!;
    assert.equal(inflight.attempts, 1, "marking inflight counts the attempt");

    assert.equal(db.reclaimInflight(), 1);
    const back = db.getDelivery(row.id)!;
    assert.equal(back.state, "queued");
    assert.equal(back.attempts, 1, "the interrupted attempt stays counted, so a poison message still dead-letters");
    assert.match(back.last_error ?? "", /interrupted by restart/);

    // Nothing to do on a clean database.
    assert.equal(db.reclaimInflight(), 0);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("a restart resumes a partly drained queue without losing or reordering", async () => {
  const dir = mkdtempSync(join(tmpdir(), "northstar-resume-"));
  const s = await sink();
  const dbPath = join(dir, "northstar.db");

  try {
    {
      const engine = new Engine({ dbPath, tickMs: 15 });
      await engine.start();
      await engine.addChannel(channel(s.port));
      for (let i = 0; i < 30; i++) engine.ingest("recover", JSON.stringify({ n: i }), "application/json", "test");
      // Stop partway through, mid-drain.
      await until(() => s.received.length >= 5, 15_000);
      await engine.stop();
    }
    const delivered = s.received.length;
    assert.ok(delivered < 30, "the point is to stop before it finished");

    // A second engine over the same file picks up exactly where it stopped:
    // the channel comes back from the database, not from any in-memory state.
    const engine = new Engine({ dbPath, tickMs: 15 });
    await engine.start();
    try {
      await until(() => s.received.length === 30, 20_000);
      assert.deepEqual(
        s.received,
        Array.from({ length: 30 }, (_, i) => i),
        "no loss, no duplicates and no reordering across the restart"
      );
      assert.equal(engine.db.verifyChain("recover").ok, true);
    } finally {
      await engine.stop();
    }
  } finally {
    await s.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
