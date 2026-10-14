/**
 * That a failing test fails, rather than hanging.
 *
 * A test that opens an engine or an HTTP listener and closes it at the end
 * of its body never reaches the close when an assertion above it throws. The
 * listener stays open, the runner's event loop never empties, and the run
 * does not finish. On CI that is a job timeout — six hours, no summary, no
 * assertion text — where a red X naming the failing line should have been.
 *
 * Measured before this was fixed, with one deliberate `assert.equal(1, 2)`
 * added to a test in `test/e2e.test.ts` that closes without `try/finally`:
 *
 *     $ timeout 90 node --test test/e2e.test.ts
 *     real  1m30.009s
 *     exit=124        # killed by the timeout; no "# fail" line at all
 *
 * #84 fixed it with `--test-force-exit`, which held for tests nobody had
 * written yet. It also lost results — the tail of a file's output, often the
 * line saying which test failed — and hid the in-flight poll bug below, so it
 * has been replaced by test/exit-watchdog.ts: each file finishes on its own,
 * and one still alive a grace period after its last test fails, naming what
 * holds it open. The property #84 wanted still holds for tests nobody has
 * written yet; see test/test-runner.test.ts, which proves both halves.
 *
 * The engine and API assertions below stay, because they are the better
 * shape for the two leaks that matter most: a leak in shutdown names itself
 * in one test rather than failing whichever file happened to start an
 * engine.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine } from "../src/core/engine.ts";
import { startApi } from "../src/api/admin.ts";
import { until } from "./helpers.ts";
import type { ChannelConfig } from "../src/types.ts";
import { AuthGate } from "../src/auth/gate.ts";

/** Active handles by kind, ignoring whatever the runner itself is holding. */
function handles(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const kind of process.getActiveResourcesInfo()) counts[kind] = (counts[kind] ?? 0) + 1;
  return counts;
}

/**
 * Lets libuv finish releasing what has been closed.
 *
 * `server.close()` calls back once the server has stopped accepting, which
 * is a tick or two before the handle itself is gone -- measured at exactly
 * two immediate ticks for a listener with no connections. Ten is margin, and
 * it costs nothing: a handle that is genuinely leaked is still there after
 * ten thousand, so waiting cannot turn a real leak into a pass.
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
}

/** What `b` holds that `a` did not. */
function extra(a: Record<string, number>, b: Record<string, number>): Record<string, number> {
  const diff: Record<string, number> = {};
  for (const [kind, n] of Object.entries(b)) {
    const grew = n - (a[kind] ?? 0);
    if (grew > 0) diff[kind] = grew;
  }
  return diff;
}

test("an engine that has been stopped is holding nothing open", async () => {
  // Every timer the engine starts -- the delivery worker, the retention
  // sweep, the order dispatch sweep, the instance-lock heartbeat, each
  // channel's own -- has to be cleared by stop(). One that is not would
  // keep a process alive after a clean shutdown, and would have shown up
  // before as the whole suite hanging rather than as this line.
  const before = handles();
  const engine = new Engine({ dbPath: ":memory:", tickMs: 15 });
  await engine.start();
  await engine.stop();
  await settle();
  assert.deepEqual(extra(before, handles()), {}, "stop() left something running");
});

test("an API listener that has been closed is holding nothing open", async () => {
  const before = handles();
  const engine = new Engine({ dbPath: ":memory:", tickMs: 15 });
  await engine.start();
  const api = await startApi(engine, 0, "127.0.0.1", { auth: new AuthGate({ keys: engine.keys }) });
  await api.close();
  await engine.stop();
  await settle();
  assert.deepEqual(extra(before, handles()), {}, "close() left a socket or a timer behind");
});

// ------------------------------------------------ polls still in flight at stop

/**
 * A source poll waiting on its far end when stop() runs.
 *
 * Clearing a poll's timer does not cancel the await inside it. stop() used to
 * close the database straight after, so when the far end finally answered —
 * here, a refused connection — the poll's failure path wrote to a closed
 * handle and threw from inside the net that catches poll errors: an unhandled
 * rejection after an ordinary shutdown. `--test-force-exit` hid it by killing
 * the process first; found by taking that flag away. The connector here is a
 * fake whose connect settles when the test says, so the race is exact rather
 * than a matter of load.
 */
const sqlChannel = (id: string): ChannelConfig => ({
  id,
  name: id,
  source: {
    type: "sqlpoll",
    driver: "postgres",
    dsn: "postgres://nobody@far.example.invalid/none",
    query: "SELECT * FROM results WHERE id > ? ORDER BY id",
    cursorColumn: "id",
    pollMs: 20,
  },
  destinations: [{ id: "facade", type: "fhirstore", ordered: true }],
});

/** A connect that answers only when told to. */
function pendingConnect() {
  let refuse!: (err: Error) => void;
  let called = false;
  const factory = () => {
    called = true;
    return new Promise<never>((_, reject) => { refuse = reject; });
  };
  return { factory, refuse: (err: Error) => refuse(err), get called() { return called; } };
}

/** Collects unhandled rejections for the length of a test. */
function watchRejections() {
  const seen: unknown[] = [];
  const onRejection = (reason: unknown) => seen.push(reason);
  process.on("unhandledRejection", onRejection);
  return { seen, stop: () => process.off("unhandledRejection", onRejection) };
}

const tick = () => new Promise<void>((r) => setImmediate(r));

test("stop() lets a poll that is waiting on its source finish before the database closes", async () => {
  const far = pendingConnect();
  const rejections = watchRejections();
  const engine = new Engine({ dbPath: ":memory:", tickMs: 15, orderDispatchIntervalMs: 0, connectors: { sql: far.factory } });
  try {
    await engine.start();
    await engine.addChannel(sqlChannel("sql-late"));
    await until(() => far.called);
    // Several more ticks while the connect hangs. Each finds a poll already
    // running and returns at once — and must not be mistaken for the poll
    // stop() has to wait for. A first version of this fix tracked the latest
    // call, which was always one of these.
    await new Promise((r) => setTimeout(r, 150));

    let stopped = false;
    const stopping = engine.stop().then(() => { stopped = true; });
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(stopped, false, "stop() waits for the poll rather than closing the database under it");

    far.refuse(new Error("connect ECONNREFUSED"));
    await stopping;
    await tick();
    await tick();
    assert.deepEqual(rejections.seen, [], "a refused connection during shutdown is recorded, not thrown into the void");
  } finally {
    rejections.stop();
  }
});

test("stop() does not wait forever on a source that never answers, and a late answer is dropped quietly", async () => {
  const far = pendingConnect();
  const rejections = watchRejections();
  const engine = new Engine({
    dbPath: ":memory:", tickMs: 15, orderDispatchIntervalMs: 0, stopInflightMs: 100, connectors: { sql: far.factory },
  });
  try {
    await engine.start();
    await engine.addChannel(sqlChannel("sql-silent"));
    await until(() => far.called);

    // A host that swallows the connect can take minutes to time out.
    // Shutdown waits a bounded time and then closes regardless.
    const started = Date.now();
    await engine.stop();
    assert.ok(Date.now() - started < 2_000, `stop() returned after ${Date.now() - started}ms, not the host's timeout`);

    // The answer arrives after the database is gone. There is nothing to
    // record it into, and nothing is lost by not trying: a failed read never
    // moved the cursor, so the next start reads from the same place.
    far.refuse(new Error("connect ETIMEDOUT"));
    await tick();
    await tick();
    assert.deepEqual(rejections.seen, [], "an answer after shutdown must not become an unhandled rejection");
  } finally {
    rejections.stop();
  }
});
