/**
 * One engine per database.
 *
 * Two engines on one file is not an error SQLite reports — it happily permits
 * it — but it is silent duplication: both claim due deliveries, and each
 * one's startup reclaim requeues the other's genuinely in-flight messages, so
 * a clinical message goes out twice. An overlapping deploy or a stray second
 * `npm start` is enough.
 *
 * The lock has to survive the case it exists to protect. A crashed holder
 * must not deadlock the restart that follows it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { hostname } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../src/db.ts";
import { Engine } from "../src/core/engine.ts";
import { until } from "./helpers.ts";
import type { ChannelConfig } from "../src/types.ts";

function tempDb(): { dir: string; path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "northstar-lock-"));
  return { dir, path: join(dir, "northstar.db"), cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) };
}

test("a second engine on the same database refuses to start", async () => {
  const { path, cleanup } = tempDb();
  const first = new Engine({ dbPath: path, tickMs: 100_000 });
  await first.start();
  try {
    const second = new Engine({ dbPath: path, tickMs: 100_000 });
    await assert.rejects(
      () => second.start(),
      (err: Error) => {
        // The message has to tell an operator what to do, not just that
        // something is wrong.
        assert.match(err.message, /another Northstar instance owns this database/);
        assert.match(err.message, new RegExp(`pid ${process.pid}`));
        assert.match(err.message, /duplicate messages/);
        return true;
      }
    );
  } finally {
    await first.stop();
    cleanup();
  }
});

test("stopping a refused engine does not free the claim it lost to", async () => {
  // The refused engine still has an open database handle, so it has to be
  // stoppable. But release is a DELETE, and in-process both engines share a
  // pid and a host — so a release keyed on identity alone would have the
  // loser hand the winner's claim to the next comer. That is the whole lock
  // undone by its own cleanup path.
  const { path, cleanup } = tempDb();
  const first = new Engine({ dbPath: path, tickMs: 100_000 });
  await first.start();
  try {
    const second = new Engine({ dbPath: path, tickMs: 100_000 });
    await assert.rejects(() => second.start());
    await second.stop();

    const held = first.db.sql.prepare("SELECT pid FROM instance_lock WHERE id = 1").get() as
      | { pid: number }
      | undefined;
    assert.equal(held?.pid, process.pid, "the first engine's claim must survive the second's cleanup");

    // And it is still enforced, rather than merely present.
    const third = new Engine({ dbPath: path, tickMs: 100_000 });
    await assert.rejects(() => third.start(), /another Northstar instance owns this database/);
    await third.stop();
  } finally {
    await first.stop();
    cleanup();
  }
});

test("a heartbeat does not refresh a same-pid claim from another host", async () => {
  // Pids are per-machine. On shared storage another host's engine can easily
  // hold the same number, and refreshing its claim would keep this engine
  // locked out for as long as it kept beating — a deadlock that outlives the
  // process it was protecting against.
  const { path, cleanup } = tempDb();
  try {
    const db = new Db(path);
    const stamped = Date.now() - 60_000;
    db.sql
      .prepare(
        `INSERT INTO instance_lock (id, pid, host, acquired_at, heartbeat_at)
         VALUES (1, ?, 'some-other-host', datetime('now'), ?)`
      )
      .run(process.pid, stamped);

    db.heartbeatInstanceLock();
    const row = db.sql.prepare("SELECT heartbeat_at AS h, host FROM instance_lock WHERE id = 1").get() as {
      h: number;
      host: string;
    };
    assert.equal(row.h, stamped, "a claim on another host must not be kept alive from here");

    // Which leaves it stale, so this host can take over as intended.
    assert.equal(db.acquireInstanceLock(20_000).acquired, true);
    db.close();
  } finally {
    cleanup();
  }
});

test("a clean shutdown releases the claim immediately", async () => {
  const { path, cleanup } = tempDb();
  try {
    const first = new Engine({ dbPath: path, tickMs: 100_000 });
    await first.start();
    await first.stop();

    // No waiting: a planned restart must not sit out a staleness window.
    const second = new Engine({ dbPath: path, tickMs: 100_000 });
    await second.start();
    await second.stop();
  } finally {
    cleanup();
  }
});

test("a crashed holder on this host is detected by its pid, with no delay", async () => {
  // The case that matters most: an engine died without releasing anything,
  // and the restart has to work now, not in twenty seconds.
  const { path, cleanup } = tempDb();
  try {
    {
      const db = new Db(path);
      // A claim from a pid that cannot be running.
      db.sql
        .prepare(
          `INSERT INTO instance_lock (id, pid, host, acquired_at, heartbeat_at)
           VALUES (1, ?, ?, datetime('now'), ?)`
        )
        .run(0x7ffffff0, hostname(), Date.now());
      db.close();
    }

    const started = Date.now();
    const engine = new Engine({ dbPath: path, tickMs: 100_000, lockStaleMs: 60_000 });
    await engine.start();
    const took = Date.now() - started;
    await engine.stop();

    assert.ok(took < 5_000, `takeover from a dead pid must be immediate, took ${took}ms`);
  } finally {
    cleanup();
  }
});

test("a claim from another host is honoured until it goes stale", async () => {
  // A pid on a different machine says nothing about whether that process is
  // alive, so the only safe signal is the heartbeat.
  const { path, cleanup } = tempDb();
  try {
    const db = new Db(path);
    const write = (heartbeatAt: number) =>
      db.sql
        .prepare(
          `INSERT INTO instance_lock (id, pid, host, acquired_at, heartbeat_at)
           VALUES (1, ?, 'some-other-host', datetime('now'), ?)
           ON CONFLICT(id) DO UPDATE SET pid = excluded.pid, host = excluded.host, heartbeat_at = excluded.heartbeat_at`
        )
        .run(4242, heartbeatAt);

    write(Date.now());
    assert.equal(db.acquireInstanceLock(20_000).acquired, false, "a fresh remote claim is honoured");

    write(Date.now() - 60_000);
    const stale = db.acquireInstanceLock(20_000);
    assert.equal(stale.acquired, true, "a stale remote claim is taken over");
    db.close();
  } finally {
    cleanup();
  }
});

test("a running engine keeps its own claim fresh", async () => {
  const { path, cleanup } = tempDb();
  // A short window, so the heartbeat has to actually fire to hold the claim.
  const engine = new Engine({ dbPath: path, tickMs: 100_000, lockStaleMs: 4_000 });
  await engine.start();
  try {
    const heartbeat = () =>
      (engine.db.sql.prepare("SELECT heartbeat_at AS h FROM instance_lock WHERE id = 1").get() as { h: number }).h;
    const first = heartbeat();
    await until(() => heartbeat() > first, 8_000);

    // And the claim is still held, rather than having lapsed and been retaken.
    const row = engine.db.sql.prepare("SELECT pid FROM instance_lock WHERE id = 1").get() as { pid: number };
    assert.equal(row.pid, process.pid);
  } finally {
    await engine.stop();
    cleanup();
  }
});

test("without the lock a second instance duplicates a message in flight", async () => {
  // Pins why this is load-bearing rather than restating that it works.
  //
  // The duplication needs two workers: within one engine the in-flight tick
  // guard masks the reclaim, because the same tick marks the row delivered
  // before another can claim it. So this starts a real second engine with the
  // staleness window set to zero — the one way to get past the lock — which
  // is precisely the situation the lock otherwise prevents.
  const received: number[] = [];
  let release: (() => void) | undefined;
  const sink = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      received.push((JSON.parse(Buffer.concat(chunks).toString("utf8")) as { n: number }).n);
      if (received.length === 1) await new Promise<void>((r) => (release = r));
      res.writeHead(200).end();
    });
  });
  await new Promise<void>((r) => sink.listen(0, "127.0.0.1", () => r()));
  const port = (sink.address() as { port: number }).port;

  const { path, cleanup } = tempDb();
  const first = new Engine({ dbPath: path, tickMs: 25 });
  await first.start();
  let second: Engine | undefined;
  try {
    const channel: ChannelConfig = {
      id: "dup",
      name: "dup",
      source: { type: "http", path: "dup" },
      destinations: [
        {
          id: "s",
          type: "http",
          url: `http://127.0.0.1:${port}/in`,
          ordered: true,
          maxAttempts: 20,
          backoffBaseMs: 20,
          timeoutMs: 30_000,
        },
      ],
    };
    await first.addChannel(channel);
    for (let i = 0; i < 3; i++) first.ingest("dup", JSON.stringify({ n: i }), "application/json", "t");

    // Hold the first delivery open, so it is genuinely on the wire.
    await until(() => received.length === 1, 10_000);
    assert.equal(first.db.listDeliveries({ channelId: "dup", state: "inflight" }).length, 1);

    // A second engine that gets past the lock. Its startup reclaim requeues
    // the delivery the first engine is still sending.
    second = new Engine({ dbPath: path, tickMs: 25, lockStaleMs: 0 });
    await second.start();
    await second.addChannel(channel);

    // The duplicate has to arrive while the first request is still held open.
    // That is what makes it a duplicate rather than a retry: the original is
    // demonstrably still on the wire, unresolved, when the copy goes out.
    await until(() => received.filter((n) => n === 0).length === 2, 15_000);
    assert.equal(
      received.filter((n) => n === 0).length,
      2,
      "message 0 goes out twice — exactly what the lock prevents"
    );
  } finally {
    release?.();
    await first.stop().catch(() => {});
    await second?.stop().catch(() => {});
    await new Promise<void>((r) => sink.close(() => r()));
    cleanup();
  }
});
