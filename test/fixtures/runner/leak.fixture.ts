/**
 * #84's scenario: a test that fails before it closes what it opened, so the
 * listener stays open and the process has nothing telling it to exit.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

test("a test before it passes", () => {
  assert.ok(true);
});

test("fails before closing its listener", async () => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  assert.equal(1, 2, "DELIBERATE: fails before the listener is closed");
  server.close();
});
