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
 * `--test-force-exit` in the `test` script is the fix, because it holds for
 * tests nobody has written yet: the runner reports what happened and exits
 * rather than waiting on a handle whose owner has already failed.
 *
 * What that flag costs is the one thing a hang was good for — it was also
 * how a genuine leak in shutdown would have announced itself. So the signal
 * is kept here as an assertion instead, which is the better shape anyway:
 * a leak now names itself in one test rather than stopping the whole run
 * somewhere unrelated.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine } from "../src/core/engine.ts";
import { startApi } from "../src/api/admin.ts";
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
