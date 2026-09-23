/**
 * A test that never finishes: it waits on something that never arrives,
 * while a timer keeps the process alive. Neither `--test-force-exit` nor the
 * exit watchdog can end this, because both act after a file's last test
 * finishes and this one never does. Only a per-test timeout can.
 */
import { test } from "node:test";

test("waits on an answer that never comes", async () => {
  const keepAlive = setInterval(() => {}, 1_000);
  try {
    await new Promise(() => {});
  } finally {
    clearInterval(keepAlive);
  }
});
