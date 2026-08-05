/** Shared test helpers. */

/**
 * Polls until cond() holds, or throws. Engine work is asynchronous by design:
 * ingest is synchronous but delivery happens later, off the queue worker.
 *
 * The default is the most generous of the per-file defaults this replaced
 * (4s to 15s), so consolidating cannot shorten any test's budget and cannot
 * introduce a flake. Tests that want to fail faster pass an explicit ms.
 */
export async function until(cond: () => boolean, ms = 15_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("condition not reached");
}
