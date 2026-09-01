/**
 * Redaction has to reach every copy.
 *
 * A retention policy is a promise to a patient and to a regulator, and it is
 * the kind of promise that is easy to half-keep: the obvious copy gets
 * cleared, the sweep reports success, and the record stays fully
 * reconstructible from somewhere else in the same file. That failure is
 * invisible to a test that checks the column the fix was written for, so the
 * tests here search the database file itself for the patient's identifiers.
 * If a copy is kept somewhere nobody thought of, this finds it anyway.
 *
 * The engine keeps at least four:
 *
 *   messages.raw          what arrived
 *   message_steps.output  what the transform made of it — the same patient
 *   deliveries.payload    what was sent
 *   deliveries.ack        what the remote said back, which for a FHIR create
 *                         is the resource itself
 *
 * and deliveries.last_error, since a rejection quotes the value it objected
 * to.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../src/core/engine.ts";
import { mllpSend } from "../src/hl7/mllp.ts";
import { until } from "./helpers.ts";
import type { ChannelConfig, MappingDoc } from "../src/types.ts";

/** Identifiers from fixtures/adt_a01.hl7 that must not survive a sweep. */
const PHI = ["Beaulieu", "NT123456", "Ptarmigan", "8735555"];

/**
 * Which identifiers are recoverable from the database on disk.
 *
 * Checkpointed first, because content sitting in the write-ahead log is every
 * bit as readable as content in the main file, and a copy of the directory
 * takes both.
 */
function recoverable(engine: Engine, dir: string): string[] {
  engine.db.sql.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const found = new Set<string>();
  for (const f of readdirSync(dir)) {
    const bytes = readFileSync(join(dir, f));
    for (const needle of PHI) if (bytes.includes(needle)) found.add(needle);
  }
  return [...found];
}

test("no identifier survives a redaction sweep anywhere in the database", async () => {
  // The destination is an HTTP sink that answers with a bare "ok", not the
  // FHIR facade: the facade is deliberately exempt from retention — it holds
  // the current clinical record rather than a log of traffic — and including
  // it would make this test about that boundary instead of about whether
  // redaction reaches everything it is responsible for.
  const sink = createServer((req, res) => {
    req.resume();
    req.on("end", () => res.writeHead(200).end("ok"));
  });
  await new Promise<void>((r) => sink.listen(0, "127.0.0.1", () => r()));
  const port = (sink.address() as { port: number }).port;

  const dir = mkdtempSync(join(tmpdir(), "northstar-leak-"));
  const engine = new Engine({ dbPath: join(dir, "northstar.db"), tickMs: 25 });
  await engine.start();
  try {
    engine.registerMapping(
      JSON.parse(readFileSync(new URL("../mappings/adt-patient.json", import.meta.url), "utf8")) as MappingDoc
    );
    await engine.addChannel({
      id: "leak",
      name: "leak",
      source: { type: "mllp", port: 0 },
      // A transform, so a second encoding of the same patient is recorded as
      // a pipeline step.
      pipeline: [{ type: "transform.mapping", mapping: "adt-patient" }],
      destinations: [
        {
          id: "s",
          type: "http",
          url: `http://127.0.0.1:${port}/in`,
          ordered: true,
          maxAttempts: 3,
          backoffBaseMs: 10,
          timeoutMs: 2_000,
        },
      ],
    });

    const raw = readFileSync(new URL("../fixtures/adt_a01.hl7", import.meta.url), "utf8");
    assert.match(await mllpSend("127.0.0.1", engine.mllpPort("leak")!, raw, 5_000), /MSA\|AA/);
    await until(() => engine.db.listDeliveries({ channelId: "leak", state: "delivered" }).length === 1);

    assert.deepEqual(
      recoverable(engine, dir).sort(),
      [...PHI].sort(),
      "the setup has to actually store the patient, or this proves nothing"
    );

    const swept = engine.db.redactBefore("2099-01-01T00:00:00Z");
    assert.equal(swept.messages, 1);
    assert.equal(swept.deliveries, 1);
    assert.ok(swept.steps >= 1, "the pipeline step is a copy and has to be counted as one");

    assert.deepEqual(recoverable(engine, dir), [], "every copy of the patient must be gone");
    assert.equal(engine.db.verifyChain("leak").ok, true, "and the chain still verifies");
  } finally {
    await engine.stop();
    await new Promise<void>((r) => sink.close(() => r()));
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("a remote's reply is redacted too, on success and on rejection", async () => {
  // The engine stores up to 4 KB of whatever the destination answered. A FHIR
  // server returns the created resource; a rejection returns an
  // OperationOutcome quoting the value it refused. Both are the remote's
  // words and both are our patient's data.
  let mode: "echo" | "reject" = "echo";
  const remote = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      if (mode === "echo") res.writeHead(201).end(body);
      else res.writeHead(422).end(JSON.stringify({ resourceType: "OperationOutcome", diagnostics: `rejected: ${body}` }));
    });
  });
  await new Promise<void>((r) => remote.listen(0, "127.0.0.1", () => r()));
  const port = (remote.address() as { port: number }).port;

  const dir = mkdtempSync(join(tmpdir(), "northstar-reply-"));
  const engine = new Engine({ dbPath: join(dir, "northstar.db"), tickMs: 25 });
  await engine.start();
  try {
    const dest = (maxAttempts: number) => ({
      id: "s",
      type: "http" as const,
      url: `http://127.0.0.1:${port}/fhir/Patient`,
      ordered: false,
      maxAttempts,
      backoffBaseMs: 10,
      backoffCapMs: 20,
      timeoutMs: 2_000,
    });
    const body = JSON.stringify({ resourceType: "Patient", name: [{ family: "Beaulieu" }] });

    const ok: ChannelConfig = { id: "ok", name: "ok", source: { type: "http", path: "ok" }, destinations: [dest(3)] };
    await engine.addChannel(ok);
    engine.ingest("ok", body, "application/fhir+json", "test");
    await until(() => engine.db.listDeliveries({ channelId: "ok", state: "delivered" }).length === 1);

    mode = "reject";
    await engine.addChannel({ ...ok, id: "bad", name: "bad", source: { type: "http", path: "bad" }, destinations: [dest(2)] });
    engine.ingest("bad", body, "application/fhir+json", "test");
    await until(() => engine.db.listDeliveries({ channelId: "bad", state: "dead" }).length === 1);

    // Both rows carry the patient before the sweep: one in its ack, one in
    // the error that killed it.
    const holds = (col: "payload" | "ack" | "last_error") =>
      (
        engine.db.sql
          .prepare(`SELECT COUNT(*) AS n FROM deliveries WHERE CAST("${col}" AS TEXT) LIKE '%Beaulieu%'`)
          .get() as { n: number }
      ).n;
    assert.equal(holds("ack"), 1, "the successful delivery keeps the remote's echo");
    assert.equal(holds("last_error"), 1, "the dead delivery keeps the rejection that quoted the payload");

    const swept = engine.db.redactBefore("2099-01-01T00:00:00Z");
    assert.equal(swept.deliveries, 2, "a dead delivery is settled and must be swept like any other");

    assert.equal(holds("payload"), 0);
    assert.equal(holds("ack"), 0, "the remote's echo is a copy of the payload");
    assert.equal(holds("last_error"), 0, "so is the error that quoted it");
  } finally {
    await engine.stop();
    await new Promise<void>((r) => remote.close(() => r()));
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("a dead-lettered delivery is not exempt from retention", async () => {
  // The one most likely to be missed, and the worst one to miss. A dead
  // delivery waits in the queue indefinitely for an operator, so the DLQ is
  // the longest-lived copy in the system — and enumerating the settled states
  // as "delivered and discarded" leaves it there forever.
  const dir = mkdtempSync(join(tmpdir(), "northstar-dlq-"));
  const engine = new Engine({ dbPath: join(dir, "northstar.db"), tickMs: 25 });
  await engine.start();
  try {
    await engine.addChannel({
      id: "dlq",
      name: "dlq",
      source: { type: "http", path: "dlq" },
      // Nothing listening, so it exhausts its attempts and dies.
      destinations: [
        { id: "s", type: "http", url: "http://127.0.0.1:1/none", ordered: false, maxAttempts: 1, backoffBaseMs: 5, timeoutMs: 500 },
      ],
    });
    engine.ingest("dlq", JSON.stringify({ family: "Beaulieu" }), "application/json", "test");
    await until(() => engine.db.listDeliveries({ channelId: "dlq", state: "dead" }).length === 1);

    const swept = engine.db.redactBefore("2099-01-01T00:00:00Z");
    assert.equal(swept.deliveries, 1);
    assert.equal(engine.db.listDeliveries({ channelId: "dlq" })[0].payload, "[redacted]");
  } finally {
    await engine.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("an in-flight delivery keeps its payload, because it still has to be sent", () => {
  // The converse. Redaction must not empty a delivery that has not gone out,
  // or the sweep silently destroys a message the sender was told was safe.
  const dir = mkdtempSync(join(tmpdir(), "northstar-queued-"));
  const engine = new Engine({ dbPath: join(dir, "northstar.db"), tickMs: 100_000 });
  try {
    engine.db.upsertChannel("q", "q", true, "{}");
    const msg = engine.db.insertMessage("q", "test", "text/plain", "Beaulieu");
    engine.db.enqueueDelivery({
      messageId: msg.id,
      channelId: "q",
      destinationId: "d",
      seq: msg.seq,
      ordered: true,
      skipOnDead: false,
      maxAttempts: 8,
      payload: "Beaulieu",
      contentType: "text/plain",
    });

    const swept = engine.db.redactBefore("2099-01-01T00:00:00Z");
    assert.equal(swept.messages, 1, "the message log is redacted regardless");
    assert.equal(swept.deliveries, 0, "but a queued delivery is left alone");
    assert.equal(engine.db.listDeliveries({ channelId: "q" })[0].payload, "Beaulieu");
  } finally {
    engine.db.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
