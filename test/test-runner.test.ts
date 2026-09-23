/**
 * That a test run reports every result it produced, and cannot hang.
 *
 * `npm test` used `--test-force-exit`, which calls `process.exit()` the moment
 * a file's last test finishes. Each file runs in its own process and sends its
 * results over a pipe; pipe writes are asynchronous on Linux, and what was
 * still queued was lost. test/score-boundaries.test.ts, 97 tests, reported
 * 43, 46, 55, 30, 30, 32, 97, 66, 53 and 63 across ten runs. A failing test
 * in the lost part still failed the run — the exit code was set first — but
 * usually without saying which. It also hid a real bug: Engine.stop() closed
 * the database under a poll still in flight (see test/shutdown.test.ts).
 *
 * The flag is gone. Each file now finishes on its own, and
 * test/exit-watchdog.ts fails any file still alive a grace period after its
 * last test, naming what holds it open — so a test that fails with a listener
 * open, which is why #84 added the flag, still cannot hang the run.
 *
 * Neither the flag nor the watchdog could end a test that never finishes,
 * because both act after a file's last test. `--test-timeout` does, and caps
 * each file as well as each test, since each file runs as one test of the
 * run. Five minutes: over six times the slowest test in the suite (46 s, the
 * admin-console XSS check) and more than twice the whole suite's wall time,
 * against GitHub's default of six hours for a job that hangs.
 *
 * These run the real runner, with the real `test` script's own flags, against
 * small fixture files named `*.fixture.ts` so the suite never collects them.
 * Each nested run has a hard deadline of its own: a guard that could hang the
 * suite it is guarding would be no guard.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const script = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { scripts: { test: string } }).scripts.test;

/** The node flags the `test` script passes, without `node` itself or the file glob. */
function scriptFlags(overrides: Record<string, string> = {}): string[] {
  const tokens = script.match(/"[^"]*"|\S+/g) ?? [];
  assert.equal(tokens[0], "node", `the test script is expected to start with node: ${script}`);
  const flags = tokens.slice(1).filter((t) => !t.includes("*")).map((t) => t.replace(/^"|"$/g, ""));
  // Replaces a `--flag=value` in place, so a test can shorten the timeout
  // without running with anything but the script's own flags otherwise.
  return flags.map((f) => {
    const name = f.split("=")[0]!;
    return name in overrides ? `${name}=${overrides[name]}` : f;
  });
}

interface Run { code: number | null; output: string; ms: number; killed: boolean }

/** Runs one fixture file through the runner the way `npm test` would. */
function runFixture(name: string, env: Record<string, string> = {}, deadlineMs = 30_000, overrides: Record<string, string> = {}): Promise<Run> {
  // The test context variables tell a node process it is a child of the
  // runner, and would make this nested run answer in the parent's private
  // format instead of TAP.
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("NODE_TEST")));
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...scriptFlags(overrides), "--test-reporter=tap", `test/fixtures/runner/${name}.fixture.ts`], {
      cwd: ROOT, env: { ...inherited, ...env }, stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (d) => { output += d; });
    child.stderr.on("data", (d) => { output += d; });
    let killed = false;
    const deadline = setTimeout(() => { killed = true; child.kill("SIGKILL"); }, deadlineMs);
    child.on("close", (code) => {
      clearTimeout(deadline);
      resolve({ code, output, ms: Date.now() - started, killed });
    });
  });
}

const count = (output: string, field: string) => Number(new RegExp(`^# ${field} (\\d+)`, "m").exec(output)?.[1] ?? NaN);

test("the test script lets each file finish on its own, with a watchdog instead of a forced exit", () => {
  assert.equal(script.includes("--test-force-exit"), false,
    "--test-force-exit loses the tail of each file's results; see the header of this file before putting it back");
  assert.ok(scriptFlags().includes("./test/exit-watchdog.ts"),
    "without the watchdog, a test that fails with a listener open hangs the whole run (#84)");
  const timeout = Number(/--test-timeout=(\d+)/.exec(script)?.[1]);
  assert.ok(timeout >= 60_000 && timeout <= 3_600_000,
    `a test that never finishes must fail the run, within minutes rather than hours; the script sets ${String(timeout)}`);
});

test("every result a file produces is reported, however many and however fast", async () => {
  // Five runs, because the loss was intermittent: one run could come back
  // whole by luck, and under the old flag almost none did.
  for (let i = 0; i < 5; i++) {
    const run = await runFixture("many");
    assert.equal(run.killed, false, "the run finished on its own");
    assert.equal(run.code, 0);
    assert.equal(count(run.output, "tests"), 200, `run ${i + 1} reported ${count(run.output, "tests")} of 200 results`);
    assert.equal(count(run.output, "pass"), 200);
  }
});

test("a test that fails with its listener still open fails the run promptly, and says what and why", async () => {
  const run = await runFixture("leak", { NORTHSTAR_TEST_EXIT_GRACE_MS: "1500" });
  assert.equal(run.killed, false, `the run hung until its deadline (${run.ms}ms): the watchdog did not end it`);
  assert.notEqual(run.code, 0, "a failing test fails the run");
  assert.ok(run.ms < 15_000, `ended after ${run.ms}ms`);
  assert.match(run.output, /DELIBERATE: fails before the listener is closed/, "the assertion that failed is reported, by name");
  assert.match(run.output, /Holding it open: [^\n]*TCPServerWrap/, "and the listener it left open is named");
});

test("a file that closes what it opened exits on its own, and the watchdog says nothing", async () => {
  const run = await runFixture("clean", { NORTHSTAR_TEST_EXIT_GRACE_MS: "1500" });
  assert.equal(run.killed, false);
  assert.equal(run.code, 0);
  assert.equal(count(run.output, "pass"), 1);
  assert.doesNotMatch(run.output, /Holding it open/, "the watchdog's own timer must never be what holds a file open");
});

test("a test that never finishes fails the run instead of hanging it", async () => {
  // The script's own flags, with the timeout shortened so this does not
  // take five minutes: what is being proven is that the flag ends it.
  const run = await runFixture("stuck", {}, 30_000, { "--test-timeout": "1500" });
  assert.equal(run.killed, false, `the run hung until its deadline (${run.ms}ms)`);
  assert.notEqual(run.code, 0);
  assert.ok(run.ms < 15_000, `ended after ${run.ms}ms`);
  assert.match(run.output, /timed out after 1500ms/, "and says it timed out, rather than just stopping");
});
