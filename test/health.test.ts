import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Engine } from "../src/core/engine.ts";
import { startApi } from "../src/api/admin.ts";
import { AuthGate } from "../src/auth/gate.ts";
import { until } from "./helpers.ts";
import type { ChannelConfig, MappingDoc } from "../src/types.ts";

const ADT = readFileSync(new URL("../fixtures/adt_a01.hl7", import.meta.url), "utf8");
const MAPPING = JSON.parse(
  readFileSync(new URL("../mappings/adt-patient.json", import.meta.url), "utf8")
) as MappingDoc;

/** Delivers into the local facade, so messages settle immediately. */
const HEALTHY: ChannelConfig = {
  id: "healthy",
  name: "healthy",
  source: { type: "http", path: "healthy" },
  pipeline: [
    { type: "filter.hl7Type", allow: ["ADT^A01", "ADT^A04"] },
    { type: "transform.mapping", mapping: "adt-patient" },
  ],
  destinations: [{ id: "facade", type: "fhirstore", ordered: true }],
};

/** Points at a closed port, so its deliveries pile up and then dead-letter. */
const STUCK: ChannelConfig = {
  id: "stuck",
  name: "stuck",
  source: { type: "http", path: "stuck" },
  destinations: [
    { id: "remote", type: "http", url: "http://127.0.0.1:1/nowhere", ordered: true, maxAttempts: 2, backoffBaseMs: 5, timeoutMs: 200 },
  ],
};

async function boot(tickMs = 15) {
  const engine = new Engine({ dbPath: ":memory:", tickMs });
  engine.registerMapping(MAPPING);
  await engine.start();
  const api = await startApi(engine, 0, "127.0.0.1");
  return {
    engine,
    base: `http://127.0.0.1:${api.port}`,
    close: async () => {
      await api.close();
      await engine.stop();
    },
  };
}

test("health reports the signals a monitor can alert on, not just counters", async () => {
  const { engine, base, close } = await boot();
  try {
    await engine.addChannel(HEALTHY);
    engine.ingest("healthy", ADT, "x-application/hl7-v2+er7", "test");
    await until(() => engine.db.listDeliveries({ channelId: "healthy", state: "delivered" }).length === 1);

    const body = (await (await fetch(`${base}/api/health`)).json()) as {
      ok: boolean;
      degraded: boolean;
      signals: {
        deadLetters: number;
        queued: number;
        oldestQueuedAgeSec: number | null;
        stalledChannels: Array<{ channelId: string }>;
        lastDeliveryAt: string | null;
      };
    };

    assert.equal(body.ok, true);
    assert.equal(body.degraded, false, "a draining engine is not degraded");
    assert.equal(body.signals.deadLetters, 0);
    assert.equal(body.signals.queued, 0);
    assert.equal(body.signals.oldestQueuedAgeSec, null, "nothing waiting means no age to report");
    assert.deepEqual(body.signals.stalledChannels, []);
    assert.ok(body.signals.lastDeliveryAt, "the last successful delivery is timestamped");
  } finally {
    await close();
  }
});

test("a dead letter marks the engine degraded and names the channel", async () => {
  // The question a counter cannot answer: which feed is in trouble.
  const { engine, base, close } = await boot();
  try {
    await engine.addChannel(STUCK);
    engine.ingest("stuck", "hello", "text/plain", "test");
    await until(() => engine.db.listDeliveries({ channelId: "stuck", state: "dead" }).length === 1);

    const body = (await (await fetch(`${base}/api/health`)).json()) as {
      degraded: boolean;
      signals: { deadLetters: number };
    };
    assert.equal(body.signals.deadLetters, 1);
    assert.equal(body.degraded, true, "a dead letter is something an operator must look at");
  } finally {
    await close();
  }
});

test("a backlog is reported with its age, and only counts as stalled past the threshold", async () => {
  // The worker is effectively stopped, so the delivery sits queued.
  const { engine, base, close } = await boot(100_000);
  try {
    await engine.addChannel(STUCK);
    engine.ingest("stuck", "hello", "text/plain", "test");

    const fresh = (await (await fetch(`${base}/api/health`)).json()) as {
      degraded: boolean;
      signals: { queued: number; oldestQueuedAgeSec: number | null; stalledChannels: Array<{ channelId: string }> };
    };
    assert.equal(fresh.signals.queued, 1);
    assert.ok(fresh.signals.oldestQueuedAgeSec !== null, "a waiting message has an age");
    assert.deepEqual(fresh.signals.stalledChannels, [], "a moment-old backlog is not a stall");
    assert.equal(fresh.degraded, false, "holding a backlog through an outage is correct behaviour");

    // With a threshold of zero, the same backlog is reported as stalled — and
    // names the channel, which is the first thing an operator needs.
    const strict = (await (await fetch(`${base}/api/health?stalled_after_sec=0`)).json()) as {
      degraded: boolean;
      signals: { stalledChannels: Array<{ channelId: string; queued: number }> };
    };
    assert.equal(strict.signals.stalledChannels.length, 1);
    assert.equal(strict.signals.stalledChannels[0].channelId, "stuck");
    assert.equal(strict.signals.stalledChannels[0].queued, 1);
    assert.equal(strict.degraded, true);
  } finally {
    await close();
  }
});

test("metrics are exposed in Prometheus text format", async () => {
  const { engine, base, close } = await boot();
  try {
    await engine.addChannel(HEALTHY);
    engine.ingest("healthy", ADT, "x-application/hl7-v2+er7", "test");
    await until(() => engine.db.listDeliveries({ channelId: "healthy", state: "delivered" }).length === 1);

    const res = await fetch(`${base}/metrics`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/plain/);
    const text = await res.text();

    for (const name of [
      "portage_channels",
      "portage_messages_total",
      "portage_deliveries",
      "portage_fhir_resources",
      "portage_dead_letters",
      "portage_oldest_queued_age_seconds",
    ]) {
      assert.match(text, new RegExp(`^# HELP ${name} `, "m"), `${name} needs a HELP line`);
      assert.match(text, new RegExp(`^# TYPE ${name} `, "m"), `${name} needs a TYPE line`);
      assert.match(text, new RegExp(`^${name}[{ ]`, "m"), `${name} needs a sample`);
    }

    assert.match(text, /^portage_messages_total\{status="processed"\} 1$/m);
    assert.match(text, /^portage_fhir_resources\{resource_type="Patient"\} 1$/m);
    assert.match(text, /^portage_dead_letters 0$/m);

    // Every non-comment line must be `name value` or `name{labels} value`, or
    // a scraper rejects the whole payload.
    for (const line of text.split("\n").filter((l) => l && !l.startsWith("#"))) {
      assert.match(line, /^[a-z_]+(\{[^}]*\})? -?\d+(\.\d+)?$/, `malformed exposition line: ${line}`);
    }

    // No patient data in something a monitoring system scrapes openly.
    assert.ok(!text.includes("Beaulieu") && !text.includes("NT123456"));
  } finally {
    await close();
  }
});

test("metrics and health are public; everything else still is not", async () => {
  const engine = new Engine({ dbPath: ":memory:", tickMs: 15 });
  await engine.start();
  const api = await startApi(engine, 0, "127.0.0.1", { auth: new AuthGate({ keys: engine.keys }) });
  const base = `http://127.0.0.1:${api.port}`;
  try {
    // A scrape happens before any credential is configured, so these are open
    // for the same reason liveness is.
    assert.equal((await fetch(`${base}/metrics`)).status, 200);
    assert.equal((await fetch(`${base}/api/health`)).status, 200);
    assert.equal((await fetch(`${base}/api/channels`)).status, 401);
    assert.equal((await fetch(`${base}/api/audit`)).status, 401);
  } finally {
    await api.close();
    await engine.stop();
  }
});

test("scraping metrics does not write to the audit trail", async () => {
  // A scrape every 15 seconds would otherwise bury real disclosures.
  const { engine, base, close } = await boot();
  try {
    const before = engine.audit.count();
    for (let i = 0; i < 10; i++) {
      await fetch(`${base}/metrics`);
      await fetch(`${base}/api/health`);
    }
    assert.equal(engine.audit.count(), before, "monitoring traffic must not appear as access");
  } finally {
    await close();
  }
});
