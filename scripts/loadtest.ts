/**
 * Drives a large volume of messages through the engine and reports where the
 * time goes.
 *
 *   node scripts/loadtest.ts [--messages 10000] [--tick 50] [--batch 100]
 *
 * Not a benchmark for its own sake. Everything in the test suite runs on a
 * handful of messages, which exercises correctness but says nothing about the
 * shapes that only appear at volume — a query that is linear in the message
 * count, an index that is not used, a queue that cannot drain faster than it
 * fills. A community site can generate tens of thousands of messages a day,
 * and a territorial hub aggregates several of them.
 *
 * Reports ingest throughput, drain rate, and the cost of the operations an
 * operator actually invokes against a large database.
 */
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { Engine } from "../src/core/engine.ts";
import { startApi } from "../src/api/admin.ts";
import type { ChannelConfig, MappingDoc } from "../src/types.ts";

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? Number(process.argv[i + 1]) : fallback;
}

const MESSAGES = arg("messages", 10_000);
const TICK = arg("tick", 50);
const BATCH = arg("batch", 100);

const MAPPING = JSON.parse(
  readFileSync(new URL("../mappings/adt-patient.json", import.meta.url), "utf8")
) as MappingDoc;

/** A distinct patient per message, so the facade does not collapse them into one. */
function adt(n: number): string {
  return (
    [
      `MSH|^~\\&|WOLF|YKPCC|PORTAGE|GNWT|20260805120000||ADT^A04^ADT_A01|L${String(n).padStart(7, "0")}|P|2.5.1`,
      `PID|1||NT${String(500000 + n)}^^^NWT^JHN||Load^Test^${n}||19900101|F`,
      "PV1|1|O",
    ].join("\r") + "\r"
  );
}

const ms = (started: number): number => Date.now() - started;
const rate = (n: number, elapsed: number): string => `${Math.round((n / elapsed) * 1000).toLocaleString()}/s`;

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "portage-load-"));
  const dbPath = join(dir, "portage.db");
  const engine = new Engine({ dbPath, tickMs: TICK });
  engine.registerMapping(MAPPING);
  await engine.start();

  const channel: ChannelConfig = {
    id: "load",
    name: "load test",
    source: { type: "http", path: "load" },
    pipeline: [
      { type: "filter.hl7Type", allow: ["ADT^A04"] },
      { type: "transform.mapping", mapping: "adt-patient" },
    ],
    destinations: [{ id: "facade", type: "fhirstore", ordered: true }],
  };
  await engine.addChannel(channel);

  console.log(`Portage load test: ${MESSAGES.toLocaleString()} messages, tick ${TICK}ms, batch ${BATCH}\n`);

  /* ------------------------------- ingest -------------------------------- */

  const ingestStart = Date.now();
  for (let i = 0; i < MESSAGES; i++) {
    engine.ingest("load", adt(i), "x-application/hl7-v2+er7", "load");
    if ((i + 1) % 5_000 === 0) {
      console.log(`  ingested ${(i + 1).toLocaleString()} (${rate(i + 1, ms(ingestStart))})`);
    }
  }
  const ingestMs = ms(ingestStart);
  console.log(`\ningest:  ${MESSAGES.toLocaleString()} in ${ingestMs}ms  ${rate(MESSAGES, ingestMs)}`);

  /* -------------------------------- drain -------------------------------- */

  const drainStart = Date.now();
  let delivered = 0;
  let lastReport = Date.now();
  while (delivered < MESSAGES) {
    delivered = (engine.db.stats() as { deliveries: Record<string, number> }).deliveries.delivered ?? 0;
    if (Date.now() - lastReport > 5_000) {
      console.log(`  delivered ${delivered.toLocaleString()} (${rate(delivered, ms(drainStart))})`);
      lastReport = Date.now();
    }
    if (ms(drainStart) > 10 * 60_000) {
      console.log(`  ABANDONED: only ${delivered.toLocaleString()} delivered after 10 minutes`);
      break;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  const drainMs = ms(drainStart);
  console.log(`drain:   ${delivered.toLocaleString()} in ${drainMs}ms  ${rate(delivered, drainMs)}`);

  /* -------------------- operations against a big database ---------------- */

  console.log("\noperator actions against the resulting database:");
  const timed = async (label: string, fn: () => unknown | Promise<unknown>): Promise<void> => {
    const t = Date.now();
    const out = await fn();
    const summary = typeof out === "string" ? ` ${out}` : "";
    console.log(`  ${label.padEnd(34)} ${String(ms(t)).padStart(6)}ms${summary}`);
  };

  const api = await startApi(engine, 0, "127.0.0.1", { rateLimit: { enabled: false } });
  const base = `http://127.0.0.1:${api.port}`;

  await timed("GET /api/health", async () => {
    await (await fetch(`${base}/api/health`)).json();
  });
  await timed("GET /metrics", async () => {
    await (await fetch(`${base}/metrics`)).text();
  });
  await timed("GET /api/messages?limit=50", async () => {
    await (await fetch(`${base}/api/messages?limit=50`)).json();
  });
  await timed("GET /fhir/Patient?identifier=...", async () => {
    await (await fetch(`${base}/fhir/Patient?identifier=NT500042`)).json();
  });
  await timed("GET /api/history?hours=24", async () => {
    await (await fetch(`${base}/api/history?hours=24`)).json();
  });
  await timed("chain verify (whole channel)", () => {
    const v = engine.db.verifyChain("load");
    return `ok=${v.ok} checked=${v.checked.toLocaleString()}`;
  });
  await timed("audit chain verify", () => {
    const v = engine.audit.verifyChain();
    return `ok=${v.ok} checked=${v.checked.toLocaleString()}`;
  });
  await timed("backup + verify", async () => {
    const { takeBackup } = await import("../src/core/backup.ts");
    const r = await takeBackup(engine.db, { dir: join(dir, "backups") });
    return `${(r.bytes / 1024 / 1024).toFixed(1)} MB`;
  });

  const bytes = statSync(dbPath).size;
  console.log(`\ndatabase: ${(bytes / 1024 / 1024).toFixed(1)} MB for ${MESSAGES.toLocaleString()} messages ` +
    `(${Math.round(bytes / MESSAGES)} bytes each)`);
  console.log(`heap:     ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(0)} MB`);

  await api.close();
  await engine.stop();
  rmSync(dir, { recursive: true, force: true });
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
