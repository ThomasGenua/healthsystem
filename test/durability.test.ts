/**
 * The durability guarantee, tested rather than assumed.
 *
 * An MLLP AA means the message is on disk. If the engine ever answers AA when
 * the write did not happen, the sender believes the message is safe and drops
 * it — silent clinical data loss, and the worst outcome this system has.
 *
 * scripts/diskfulltest.ts runs the real version against a genuinely full
 * filesystem. These are the parts that run anywhere.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../src/db.ts";
import { Engine } from "../src/core/engine.ts";
import { mllpSend } from "../src/hl7/mllp.ts";
import type { ChannelConfig } from "../src/types.ts";

const adt = (n: number) =>
  [
    `MSH|^~\\&|WOLF|YKPCC|PORTAGE|GNWT|20260805120000||ADT^A04^ADT_A01|D${n}|P|2.5.1`,
    `PID|1||NT${700000 + n}^^^NWT^JHN||Durable^Test^${n}||19900101|F`,
    "PV1|1|O",
  ].join("\r") + "\r";

const channel: ChannelConfig = {
  id: "durable",
  name: "durability",
  source: { type: "mllp", port: 0 },
  destinations: [{ id: "facade", type: "fhirstore", ordered: true }],
};

test("every commit is flushed to disk, so an AA survives power loss", () => {
  // WAL with synchronous=NORMAL does not fsync on commit: a process crash is
  // survivable but a power cut can lose recent transactions. Community sites
  // lose power, and an AA has already promised the message is safe. FULL is
  // what makes that promise true, and it is what the ingest rate buys —
  // pinned here so it cannot be quietly traded away for throughput.
  const dir = mkdtempSync(join(tmpdir(), "northstar-sync-"));
  try {
    const db = new Db(join(dir, "northstar.db"));
    const journal = db.sql.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    const sync = db.sql.prepare("PRAGMA synchronous").get() as { synchronous: number };
    assert.equal(journal.journal_mode, "wal");
    assert.equal(sync.synchronous, 2, "synchronous must be FULL (2), not NORMAL (1) or OFF (0)");
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed write is answered with AE, never AA", async () => {
  // The property that matters: if the store cannot accept the message, the
  // sender must be told. Forcing the failure at the SQL layer exercises the
  // same path a full disk does — ingest throws, and the MLLP handler has to
  // turn that into a negative acknowledgement rather than a positive one.
  const dir = mkdtempSync(join(tmpdir(), "northstar-fail-"));
  const engine = new Engine({ dbPath: join(dir, "northstar.db"), tickMs: 100_000 });
  await engine.start();
  try {
    await engine.addChannel(channel);
    const port = engine.mllpPort("durable")!;

    assert.match(await mllpSend("127.0.0.1", port, adt(0), 5_000), /MSA\|AA/, "a healthy write is acknowledged");
    assert.equal(engine.db.listMessages({ channelId: "durable" }).length, 1);

    // Storage is now unavailable.
    engine.db.sql.close();

    for (let i = 1; i <= 5; i++) {
      const ack = await mllpSend("127.0.0.1", port, adt(i), 5_000).catch(() => "");
      assert.ok(
        !/MSA\|AA/.test(ack),
        `message ${i} was acknowledged AA although it could not be stored — the sender would drop it`
      );
      if (ack) assert.match(ack, /MSA\|AE/, "an unstorable message must be refused explicitly");
    }
  } finally {
    // The engine's own close would throw on the already-closed handle.
    try {
      await engine.stop();
    } catch {
      /* expected: storage was pulled out from under it */
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("only messages that were acknowledged are actually stored", async () => {
  // The converse of the above: nothing may be persisted that the sender was
  // told had failed, or a retry would duplicate it.
  const dir = mkdtempSync(join(tmpdir(), "northstar-acked-"));
  const engine = new Engine({ dbPath: join(dir, "northstar.db"), tickMs: 100_000 });
  await engine.start();
  try {
    await engine.addChannel({
      ...channel,
      pipeline: [{ type: "filter.hl7Type", allow: ["ADT^A04"] }],
    });
    const port = engine.mllpPort("durable")!;

    let acked = 0;
    for (let i = 0; i < 5; i++) {
      if (/MSA\|AA/.test(await mllpSend("127.0.0.1", port, adt(i), 5_000))) acked++;
    }

    // A message the pipeline rejects is still stored, with its error, because
    // an operator needs to see what arrived — but it is answered AE, so the
    // count of stored-and-deliverable rows is what must match.
    const processed = engine.db.listMessages({ channelId: "durable", status: "processed" }).length;
    assert.equal(acked, 5);
    assert.equal(processed, acked, "every AA corresponds to a stored, processed message");

    // And each one produced a delivery, so an AA really does mean queued.
    assert.equal(engine.db.listDeliveries({ channelId: "durable" }).length, acked);
    assert.equal(engine.db.verifyChain("durable").ok, true);
  } finally {
    await engine.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a rejected message leaves the chain intact for the ones that follow", async () => {
  const dir = mkdtempSync(join(tmpdir(), "northstar-chain-"));
  const engine = new Engine({ dbPath: join(dir, "northstar.db"), tickMs: 100_000 });
  await engine.start();
  try {
    await engine.addChannel({
      ...channel,
      pipeline: [{ type: "transform.mapping", mapping: "missing-mapping" }],
    });
    const port = engine.mllpPort("durable")!;

    // Alternate good and hostile input; the hostile ones fail the pipeline.
    await mllpSend("127.0.0.1", port, adt(1), 5_000).catch(() => "");
    await mllpSend("127.0.0.1", port, "MSH|^~\\&|garbage", 5_000).catch(() => "");
    await mllpSend("127.0.0.1", port, adt(2), 5_000).catch(() => "");

    const chain = engine.db.verifyChain("durable");
    assert.equal(chain.ok, true, "failures are recorded on the chain like anything else");
    assert.ok(chain.checked >= 2);
  } finally {
    await engine.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a nested transaction joins the outer one rather than starting a second", () => {
  // Composite operations are built from atomic ones — redirecting a referral
  // closes one and creates another, and each of those is itself atomic. SQLite
  // refuses a second BEGIN outright, so without this the composite either
  // crashes or has to be written non-atomically, and a half-applied composite
  // is precisely the state these stores exist to prevent.
  const dir = mkdtempSync(join(tmpdir(), "northstar-tx-"));
  try {
    const db = new Db(join(dir, "northstar.db"));
    db.upsertChannel("c", "c", true, "{}");

    const out = db.transaction(() => {
      db.insertMessage("c", "test", "text/plain", "outer");
      return db.transaction(() => {
        db.insertMessage("c", "test", "text/plain", "inner");
        return "done";
      });
    });
    assert.equal(out, "done");
    assert.equal(db.listMessages({ channelId: "c" }).length, 2);

    // A throw anywhere inside rolls back everything, since only the outermost
    // call commits. A partially applied composite would be worse than a
    // failed one: it looks like success.
    assert.throws(() =>
      db.transaction(() => {
        db.insertMessage("c", "test", "text/plain", "outer-2");
        db.transaction(() => {
          db.insertMessage("c", "test", "text/plain", "inner-2");
          throw new Error("something went wrong deep inside");
        });
      })
    );
    assert.equal(db.listMessages({ channelId: "c" }).length, 2, "neither write survives");
    assert.equal(db.verifyChain("c").ok, true, "and the chain is not left mid-extension");

    // And the connection is usable afterwards, rather than stuck in a
    // transaction nobody closed.
    db.insertMessage("c", "test", "text/plain", "after");
    assert.equal(db.listMessages({ channelId: "c" }).length, 3);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
