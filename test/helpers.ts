/** Shared test helpers. */

/** Polls until cond() holds, or throws. Engine work is asynchronous by design. */
export async function until(cond: () => boolean, ms = 6000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("condition not reached");
}
