/**
 * Replaying a delivery whose payload retention already took.
 *
 * The states replay accepts — dead, delivered, discarded — are exactly the
 * states redaction empties, so the two features meet on the same rows. Without
 * a check between them, an operator clicking replay in the admin UI sends the
 * literal string `[redacted]` to a downstream clinical system, which has no
 * way to tell it from content. Failing loudly is the only safe answer: the
 * payload is genuinely gone, and the operator is entitled to be told that
 * rather than to have something plausible sent on their behalf.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../src/core/engine.ts";
import { startApi } from "../src/api/admin.ts";
import { until } from "./helpers.ts";

async function sink(): Promise<{ port: number; got: string[]; close: () => Promise<void> }> {
  const got: string[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      got.push(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(200).end("ok");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return {
    port: (server.address() as { port: number }).port,
    got,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

test("a redacted delivery is refused, and no tombstone reaches the remote", async () => {
  const s = await sink();
  const dir = mkdtempSync(join(tmpdir(), "portage-replay-"));
  const engine = new Engine({ dbPath: join(dir, "portage.db"), tickMs: 25 });
  await engine.start();
  try {
    await engine.addChannel({
      id: "r",
      name: "r",
      source: { type: "http", path: "r" },
      destinations: [
        {
          id: "s",
          type: "http",
          url: `http://127.0.0.1:${s.port}/in`,
          ordered: false,
          maxAttempts: 3,
          backoffBaseMs: 10,
          timeoutMs: 2_000,
        },
      ],
    });
    engine.ingest("r", JSON.stringify({ family: "Beaulieu" }), "application/fhir+json", "test");
    // Wait for the delivery to be settled, not merely for the sink to have
    // seen the request. The remote receives it before the engine records the
    // outcome, so a wait on the sink can leave the row inflight — and
    // redaction skips inflight rows by design, which made this pass locally
    // and fail on a differently-timed machine.
    await until(() => engine.db.listDeliveries({ channelId: "r", state: "delivered" }).length === 1);

    engine.db.redactBefore("2099-01-01T00:00:00Z");
    const id = engine.db.listDeliveries({ channelId: "r" })[0].id;
    assert.equal(engine.db.getDelivery(id)!.payload, "[redacted]");

    const replay = engine.db.replayDelivery(id);
    assert.equal(replay.ok, false);
    assert.match(
      (replay as { reason: string }).reason,
      /redacted .* under the retention policy/,
      "the operator has to be told why, not just that it failed"
    );

    // And the refusal has to be real, not merely reported: give the worker
    // ample ticks to pick anything up.
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(s.got.length, 1, "nothing more may go out");
    assert.equal(engine.db.getDelivery(id)!.state, "delivered", "and the row is left as it was");
  } finally {
    await engine.stop();
    await s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unredacted delivery still replays, so the refusal is narrow", async () => {
  // The guard must not cost the feature it sits in front of.
  const s = await sink();
  const dir = mkdtempSync(join(tmpdir(), "portage-replay-ok-"));
  const engine = new Engine({ dbPath: join(dir, "portage.db"), tickMs: 25 });
  await engine.start();
  try {
    await engine.addChannel({
      id: "r",
      name: "r",
      source: { type: "http", path: "r" },
      destinations: [
        {
          id: "s",
          type: "http",
          url: `http://127.0.0.1:${s.port}/in`,
          ordered: false,
          maxAttempts: 3,
          backoffBaseMs: 10,
          timeoutMs: 2_000,
        },
      ],
    });
    engine.ingest("r", "still here", "text/plain", "test");
    // Settled, not just received: replay refuses an inflight row, correctly.
    await until(() => engine.db.listDeliveries({ channelId: "r", state: "delivered" }).length === 1);

    const id = engine.db.listDeliveries({ channelId: "r" })[0].id;
    assert.deepEqual(engine.db.replayDelivery(id), { ok: true });
    await until(() => s.got.length === 2);
    assert.deepEqual(s.got, ["still here", "still here"]);
  } finally {
    await engine.stop();
    await s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the admin API returns the reason rather than a generic conflict", async () => {
  const dir = mkdtempSync(join(tmpdir(), "portage-replay-api-"));
  const engine = new Engine({ dbPath: join(dir, "portage.db"), tickMs: 100_000 });
  await engine.start();
  const api = await startApi(engine, 0, "127.0.0.1");
  try {
    engine.db.upsertChannel("c", "c", true, "{}");
    const msg = engine.db.insertMessage("c", "test", "text/plain", "Beaulieu");
    engine.db.enqueueDelivery({
      messageId: msg.id,
      channelId: "c",
      destinationId: "d",
      seq: msg.seq,
      ordered: false,
      skipOnDead: false,
      maxAttempts: 1,
      payload: "Beaulieu",
      contentType: "text/plain",
    });
    const id = engine.db.listDeliveries({ channelId: "c" })[0].id;
    engine.db.markInflight(id);
    engine.db.markDelivered(id, "ok");
    engine.db.redactBefore("2099-01-01T00:00:00Z");

    const res = await fetch(`http://127.0.0.1:${api.port}/api/deliveries/${id}/replay`, { method: "POST" });
    assert.equal(res.status, 409);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /retention policy/);

    // A delivery that is simply not there reads differently, so the two are
    // distinguishable from the outside.
    const missing = await fetch(
      `http://127.0.0.1:${api.port}/api/deliveries/00000000-0000-0000-0000-000000000000/replay`,
      { method: "POST" }
    );
    assert.equal(missing.status, 409);
    assert.match(((await missing.json()) as { error: string }).error, /no such delivery/);
  } finally {
    await api.close();
    await engine.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
