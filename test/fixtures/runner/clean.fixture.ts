/** Opens a listener and closes it in `finally`, as every test should. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

test("closes what it opened", async () => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    assert.ok(server.listening);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
