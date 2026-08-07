/**
 * A Portage engine in its own process, so a test can kill it outright.
 *
 * Used by scripts/crashtest.ts. Ingests a batch of messages against a real
 * database file and delivers them to a sink, then stays up. The parent kills
 * it with SIGKILL — no shutdown hook, no flush — and starts it again against
 * the same file, which is the only way to test what a real crash does to the
 * durability guarantee.
 */
import { Engine } from "../src/core/engine.ts";
import type { ChannelConfig } from "../src/types.ts";

const dbPath = process.env.CRASH_DB!;
const sinkPort = Number(process.env.CRASH_SINK);
const ingestCount = Number(process.env.CRASH_INGEST ?? "0");
const startAt = Number(process.env.CRASH_START ?? "0");

async function main(): Promise<void> {
  const engine = new Engine({ dbPath, tickMs: 25 });
  await engine.start();

  const channel: ChannelConfig = {
    id: "crash",
    name: "crash test",
    source: { type: "http", path: "crash" },
    destinations: [
      {
        id: "sink",
        type: "http",
        url: `http://127.0.0.1:${sinkPort}/in`,
        ordered: true,
        maxAttempts: 50,
        backoffBaseMs: 20,
        backoffCapMs: 200,
        timeoutMs: 2_000,
      },
    ],
  };
  if (!engine.getChannelConfig("crash")) await engine.addChannel(channel);

  for (let i = 0; i < ingestCount; i++) {
    engine.ingest("crash", JSON.stringify({ n: startAt + i }), "application/json", "crash");
  }

  console.log(`ready ingested=${ingestCount}`);
  // Stay up and keep draining until killed. No shutdown handler on purpose.
  setInterval(() => {}, 1 << 30);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
