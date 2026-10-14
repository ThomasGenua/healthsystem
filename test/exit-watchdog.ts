/**
 * Loaded into every test file's process by the `test` script, in place of
 * `--test-force-exit`.
 *
 * #84 added that flag because a test that opens a listener and closes it at
 * the end of its body never reaches the close when an assertion above it
 * throws: the handle stays open, the process never exits, and the run hangs
 * with no summary. The flag fixed that by calling `process.exit()` the moment
 * a file's last test finished.
 *
 * It also threw away results. A test file runs in its own process and sends
 * its results to the runner over a pipe, and on Linux a pipe write is
 * asynchronous: whatever was still queued when `process.exit()` ran was lost.
 * Measured on test/score-boundaries.test.ts, whose 97 tests reported as 43,
 * 46, 55, 30, 30, 32, 97, 66, 53 and 63 across ten runs — on Node 22 and on
 * Node 24, whose runner does the same thing (test.js, `config.forceExit`). A
 * failing test in the lost part still failed the run, because the exit code
 * was set first, but usually without saying which test or why.
 *
 * So the process is allowed to finish on its own, which is when the runner
 * has actually delivered every result, and this is the guard against it
 * never finishing: if it is still alive a grace period after its last test,
 * something is holding it open. This says what — the resource types Node
 * reports as keeping it alive — and fails the file. A leak that used to hang
 * the run, and that the flag then silently cut short, now names itself.
 *
 * The timer is unref'd, so it never holds the process open itself, and the
 * message goes out with a synchronous write, because the asynchronous one is
 * exactly what gets lost at `process.exit()`.
 */
import { after } from "node:test";
import { writeSync } from "node:fs";

/**
 * Ten seconds. Measured across the whole suite, the slowest file to exit on
 * its own after its last test took 92 ms on Node 22 and 57 ms on Node 24 —
 * once the browser tests stopped leaving a fixed three- and five-second
 * teardown timer running, which had been holding them open for exactly that
 * long. Overridable so the tests of this file need not wait ten seconds.
 */
const graceMs = Number(process.env.NORTHSTAR_TEST_EXIT_GRACE_MS ?? 10_000);

after(() => {
  setTimeout(() => {
    const holding = process.getActiveResourcesInfo().join(", ") || "nothing Node can name";
    writeSync(
      2,
      `\n${process.argv[1] ?? "a test file"} was still running ${graceMs / 1000}s after its last test finished. ` +
        `Holding it open: ${holding}. Close what the test opened in a finally block or an after() hook.\n`
    );
    process.exit(1);
  }, graceMs).unref();
});
