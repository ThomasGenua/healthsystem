import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { Engine } from "../src/core/engine.ts";
import { until } from "./helpers.ts";
import type { ChannelConfig, ConformancePack } from "../src/types.ts";

const load = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));
const PSCA = load("../conformance/ps-ca.json") as ConformancePack;
const GOOD = load("../fixtures/conformance/psca-patient-good.json") as Record<string, unknown>;
const BAD = load("../fixtures/conformance/psca-patient-bad.json") as Record<string, unknown>;

const channel = (id: string, dest: Record<string, unknown>): ChannelConfig => ({
  id,
  name: id,
  source: { type: "http", path: id },
  destinations: [{ id: "facade", type: "fhirstore", ordered: true, maxAttempts: 2, backoffBaseMs: 5, ...dest }],
});

test("reject mode: a non-conformant resource never reaches the facade", async () => {
  const engine = new Engine({ dbPath: ":memory:", tickMs: 15 });
  engine.conformance.register(PSCA);
  await engine.start();
  try {
    await engine.addChannel(channel("v-reject", { validatePack: "ps-ca", validateMode: "reject" }));

    engine.ingest("v-reject", JSON.stringify(BAD), "application/fhir+json", "test");

    // The delivery exhausts its attempts and dead-letters, carrying the reason.
    await until(() => engine.db.listDeliveries({ channelId: "v-reject", state: "dead" }).length === 1);
    const dead = engine.db.listDeliveries({ channelId: "v-reject", state: "dead" })[0];
    assert.match(dead.last_error ?? "", /Conformance ps-ca/);

    // Nothing was stored. This is the property that matters: the gate runs
    // before any write, not after one.
    assert.equal(engine.fhir.search("Patient", {}).total, 0);

    // The destination is ordered, so the dead letter now blocks the queue —
    // exactly as a rejected HTTP delivery would. Discarding it is the
    // documented way to release the line.
    assert.equal(engine.db.discardDelivery(dead.id), true);

    engine.ingest("v-reject", JSON.stringify(GOOD), "application/fhir+json", "test");
    await until(() => engine.fhir.search("Patient", {}).total === 1);
  } finally {
    await engine.stop();
  }
});

test("a rejected delivery re-validates on retry instead of silently succeeding", async () => {
  // Guards a specific trap: had the check run after persistence, attempt 1
  // would store the resource and fail, then attempt 2 would find the content
  // hash unchanged, short-circuit, skip validation entirely and report
  // success. The delivery must fail every attempt, not just the first.
  const engine = new Engine({ dbPath: ":memory:", tickMs: 15 });
  engine.conformance.register(PSCA);
  await engine.start();
  try {
    await engine.addChannel(
      channel("v-retry", { validatePack: "ps-ca", validateMode: "reject", maxAttempts: 3, backoffBaseMs: 5 })
    );

    engine.ingest("v-retry", JSON.stringify(BAD), "application/fhir+json", "test");
    await until(() => engine.db.listDeliveries({ channelId: "v-retry", state: "dead" }).length === 1);

    const dead = engine.db.listDeliveries({ channelId: "v-retry", state: "dead" })[0];
    assert.equal(dead.attempts, 3, "every attempt must re-run validation and fail");
    assert.equal(engine.db.listDeliveries({ channelId: "v-retry", state: "delivered" }).length, 0);
    assert.equal(engine.fhir.search("Patient", {}).total, 0);
  } finally {
    await engine.stop();
  }
});

test("annotate mode stores the resource and records the issues on the ack", async () => {
  const engine = new Engine({ dbPath: ":memory:", tickMs: 15 });
  engine.conformance.register(PSCA);
  await engine.start();
  try {
    await engine.addChannel(channel("v-annotate", { validatePack: "ps-ca", validateMode: "annotate" }));

    engine.ingest("v-annotate", JSON.stringify(BAD), "application/fhir+json", "test");
    await until(() => engine.db.listDeliveries({ channelId: "v-annotate", state: "delivered" }).length === 1);

    assert.equal(engine.fhir.search("Patient", {}).total, 1, "annotate passes the resource through");
    const ack = engine.db.listDeliveries({ channelId: "v-annotate", state: "delivered" })[0].ack ?? "";
    assert.match(ack, /conformance issue/);
  } finally {
    await engine.stop();
  }
});

test("a rejected write notifies no subscription", async () => {
  const hits: string[] = [];
  const sink = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      hits.push(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(200).end();
    });
  });
  await new Promise<void>((r) => sink.listen(0, "127.0.0.1", () => r()));
  const sinkPort = (sink.address() as { port: number }).port;

  const engine = new Engine({ dbPath: ":memory:", tickMs: 15 });
  engine.conformance.register(PSCA);
  await engine.start();
  try {
    await engine.addChannel(channel("v-subs", { validatePack: "ps-ca", validateMode: "reject" }));

    engine.subs.create({
      resourceType: "Subscription",
      status: "requested",
      criteria: "Patient",
      channel: { type: "rest-hook", endpoint: `http://127.0.0.1:${sinkPort}/notify` },
    });

    engine.ingest("v-subs", JSON.stringify(BAD), "application/fhir+json", "test");
    await until(() => engine.db.listDeliveries({ channelId: "v-subs", state: "dead" }).length === 1);
    assert.equal(hits.length, 0, "a resource that was never stored must not notify anyone");

    // The same subscription does fire once a conformant resource lands, so the
    // silence above is the gate working, not a broken notify path.
    engine.db.discardDelivery(engine.db.listDeliveries({ channelId: "v-subs", state: "dead" })[0].id);
    engine.ingest("v-subs", JSON.stringify(GOOD), "application/fhir+json", "test");
    await until(() => hits.length === 1, 8000);
  } finally {
    await engine.stop();
    await new Promise<void>((r) => sink.close(() => r()));
  }
});

test("engine-wide default pack applies to destinations that name none", async () => {
  const engine = new Engine({ dbPath: ":memory:", tickMs: 15, validatePack: "ps-ca", validateMode: "reject" });
  engine.conformance.register(PSCA);
  await engine.start();
  try {
    await engine.addChannel(channel("v-default", {}));

    engine.ingest("v-default", JSON.stringify(BAD), "application/fhir+json", "test");
    await until(() => engine.db.listDeliveries({ channelId: "v-default", state: "dead" }).length === 1);
    assert.equal(engine.fhir.search("Patient", {}).total, 0);
  } finally {
    await engine.stop();
  }
});

test("validation is off by default, and an unknown pack is an error not a silent pass", async () => {
  const engine = new Engine({ dbPath: ":memory:", tickMs: 15 });
  await engine.start();

  try {
    // No pack configured anywhere: the facade behaves exactly as before.
    engine.fhir.upsert(BAD);
    assert.equal(engine.fhir.search("Patient", {}).total, 1);

    assert.throws(() => engine.fhir.upsert(GOOD, { pack: "no-such-pack" }), /Unknown conformance pack/);
  } finally {
    await engine.stop();
  }
});
