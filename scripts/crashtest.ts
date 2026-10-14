/**
 * Kills a running engine mid-delivery and checks the guarantee holds.
 *
 *   node scripts/crashtest.ts [--messages 300] [--kills 3]
 *
 * The README promises that an acknowledgement means the message is durably
 * queued and that a restart resumes exactly where it stopped. Every test in
 * the suite runs against an in-memory database and shuts down gracefully,
 * which exercises neither half of that. This runs a real engine in a real
 * process against a real file, SIGKILLs it partway through draining, starts it
 * again, and checks that nothing is lost and order is preserved.
 *
 * Not "exactly once": a crash between the remote receiving a message and the
 * result being committed is genuinely ambiguous, and redelivering is the only
 * safe answer. At most one message per ordering key can be in that state, so
 * a crash duplicates at most one — which the content-addressed FHIR facade
 * absorbs as a no-op.
 *
 * SIGKILL rather than SIGTERM deliberately: the interesting case is the one
 * with no chance to clean up — power loss at a community site, an OOM kill, a
 * container stopped hard during a deploy.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Db } from "../src/db.ts";

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? Number(process.argv[i + 1]) : fallback;
}

const MESSAGES = arg("messages", 300);
const KILLS = arg("kills", 3);
const CHILD = fileURLToPath(new URL("./crash-child.ts", import.meta.url));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "northstar-crash-"));
  const dbPath = join(dir, "northstar.db");

  /** Records arrival order. Lives in the parent, so it survives every kill. */
  const received: number[] = [];
  const sink = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      try {
        received.push((JSON.parse(Buffer.concat(chunks).toString("utf8")) as { n: number }).n);
      } catch {
        /* ignore anything unparseable */
      }
      res.writeHead(200).end();
    });
  });
  await new Promise<void>((r) => sink.listen(0, "127.0.0.1", () => r()));
  const sinkPort = (sink.address() as { port: number }).port;

  const startChild = (ingest: number, startAt: number): Promise<ChildProcess> =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [CHILD], {
        env: {
          ...process.env,
          CRASH_DB: dbPath,
          CRASH_SINK: String(sinkPort),
          CRASH_INGEST: String(ingest),
          CRASH_START: String(startAt),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout?.on("data", (b: Buffer) => {
        if (b.toString().includes("ready")) resolve(child);
      });
      child.stderr?.on("data", (b: Buffer) => {
        const s = b.toString();
        if (!s.includes("ExperimentalWarning") && !s.includes("trace-warnings")) process.stderr.write(`  child: ${s}`);
      });
    });

  console.log(`crash test: ${MESSAGES} messages, ${KILLS} hard kills\n`);

  let child = await startChild(MESSAGES, 0);
  console.log(`  ingested ${MESSAGES}, draining...`);

  for (let k = 0; k < KILLS; k++) {
    // Let some through, then pull the plug mid-flight.
    const before = received.length;
    const deadline = Date.now() + 15_000;
    while (received.length < before + Math.floor(MESSAGES / (KILLS + 2)) && Date.now() < deadline) {
      await sleep(20);
    }
    child.kill("SIGKILL");
    await new Promise<void>((r) => child.on("exit", () => r()));
    console.log(`  kill ${k + 1}: SIGKILL at ${received.length}/${MESSAGES} delivered`);

    // What a crash leaves behind, before anything restarts.
    const inspect = new Db(dbPath, { readOnly: true });
    const stuck = inspect.sql
      .prepare("SELECT COUNT(*) AS n FROM deliveries WHERE state = 'inflight'")
      .get() as { n: number };
    inspect.close();
    if (stuck.n > 0) console.log(`    left ${stuck.n} delivery(ies) in flight`);

    await sleep(100);
    child = await startChild(0, 0);
  }

  console.log("\n  waiting for the backlog to finish...");
  const deadline = Date.now() + 60_000;
  let stalledFor = 0;
  let last = received.length;
  while (received.length < MESSAGES && Date.now() < deadline) {
    await sleep(250);
    if (received.length === last) stalledFor += 250;
    else {
      stalledFor = 0;
      last = received.length;
    }
    if (stalledFor >= 15_000) {
      console.log(`  STALLED: no progress for 15s at ${received.length}/${MESSAGES}`);
      break;
    }
  }

  child.kill("SIGKILL");
  await new Promise<void>((r) => child.on("exit", () => r()));

  /* ------------------------------- verdict ------------------------------- */

  const expected = Array.from({ length: MESSAGES }, (_, i) => i);
  const unique = [...new Set(received)];
  const duplicates = received.length - unique.length;
  const missing = expected.filter((n) => !unique.includes(n));
  const inOrder = JSON.stringify(unique) === JSON.stringify([...unique].sort((a, b) => a - b));

  console.log(`\n  delivered:  ${received.length} (${unique.length} distinct of ${MESSAGES})`);
  console.log(`  duplicates: ${duplicates}`);
  console.log(`  missing:    ${missing.length}${missing.length ? ` e.g. ${missing.slice(0, 5).join(", ")}` : ""}`);
  console.log(`  in order:   ${inOrder ? "yes" : "NO"}`);

  const db = new Db(dbPath, { readOnly: true });
  const chain = db.verifyChain("crash");
  const states = db.sql
    .prepare("SELECT state, COUNT(*) AS n FROM deliveries GROUP BY state")
    .all() as Array<{ state: string; n: number }>;
  db.close();
  console.log(`  chain:      ${chain.ok ? `intact (${chain.checked})` : `BROKEN at ${chain.brokenAt}`}`);
  console.log(`  queue:      ${states.map((s) => `${s.state}=${s.n}`).join(" ") || "empty"}`);

  // A duplicate is the correct outcome, not a defect. If the process dies
  // after the remote received a message but before the result committed,
  // there is no way to know which happened, and redelivering is the only safe
  // choice — losing it is not. At most one delivery can be in flight per
  // ordering key, so a crash can duplicate at most one message. That is why
  // the FHIR facade is content-addressed: a repeated upsert is a no-op.
  //
  // An outage is different, and the demo's "zero duplicates" still holds
  // there: a failed send is recorded as failed, so nothing is ambiguous.
  const ok = missing.length === 0 && inOrder && chain.ok && duplicates <= KILLS;
  console.log(
    `\n${ok ? "PASSED" : "FAILED"}: no loss, order preserved, chain intact across ${KILLS} hard kills` +
      ` (${duplicates} redelivered, at most one per kill — at-least-once by design).`
  );

  await new Promise<void>((r) => sink.close(() => r()));
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  process.exit(ok ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
