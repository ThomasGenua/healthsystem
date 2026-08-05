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

async function boot(): Promise<{ engine: Engine; base: string; close: () => Promise<void> }> {
  const engine = new Engine({ dbPath: ":memory:", tickMs: 15 });
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

test("mapping preview runs the mapper without persisting anything", async () => {
  const { engine, base, close } = await boot();
  try {
    const before = engine.db.stats() as { messages: Record<string, number> };

    const res = await fetch(`${base}/api/mappings/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mapping: "adt-patient", sample: ADT }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; output: Record<string, unknown> };
    assert.equal(body.ok, true);
    assert.equal(body.output.resourceType, "Patient");
    assert.deepEqual((body.output.name as Array<{ family: string }>)[0].family, "Beaulieu");

    // The whole point of a preview: no message, no delivery, no resource.
    assert.deepEqual(engine.db.stats(), before);
    assert.equal(engine.fhir.search("Patient", {}).total, 0);
    assert.equal(engine.db.listMessages({}).length, 0);
  } finally {
    await close();
  }
});

test("mapping preview accepts an inline document and reports errors without throwing", async () => {
  const { base, close } = await boot();
  try {
    const inline = await fetch(`${base}/api/mappings/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mapping: { id: "adhoc", input: "hl7", ops: [{ set: "family", from: "PID-5.1" }] },
        sample: ADT,
      }),
    });
    assert.deepEqual((await inline.json()) as unknown, { ok: true, output: { family: "Beaulieu" } });

    // Forgetting `input: "hl7"` is the easy mistake to make in the editor, and
    // the raw JSON.parse failure that results is unhelpful on its own.
    const wrongInput = await fetch(`${base}/api/mappings/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mapping: { id: "adhoc", ops: [{ set: "family", from: "PID-5.1" }] }, sample: ADT }),
    });
    const wrongBody = (await wrongInput.json()) as { ok: boolean; error: string };
    assert.equal(wrongBody.ok, false);
    assert.match(wrongBody.error, /input.*hl7/i);

    // A mapping that references an unknown function fails as data, not as a
    // 500 — the editor needs to show the message, not a stack trace.
    const broken = await fetch(`${base}/api/mappings/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mapping: { id: "bad", input: "hl7", ops: [{ set: "x", from: "PID-5.1", fn: "nosuchfn" }] },
        sample: ADT,
      }),
    });
    assert.equal(broken.status, 200);
    const brokenBody = (await broken.json()) as { ok: boolean; error: string };
    assert.equal(brokenBody.ok, false);
    assert.match(brokenBody.error, /nosuchfn/);

    for (const bad of [{ sample: ADT }, { mapping: "adt-patient" }, { mapping: "no-such-map", sample: ADT }]) {
      const r = await fetch(`${base}/api/mappings/preview`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(bad),
      });
      assert.equal(r.status, 400, `expected 400 for ${JSON.stringify(bad)}`);
    }
  } finally {
    await close();
  }
});

test("history buckets messages by arrival and deliveries by completion", async () => {
  const { engine, base, close } = await boot();
  try {
    const channel: ChannelConfig = {
      id: "hist",
      name: "history",
      source: { type: "http", path: "hist" },
      pipeline: [
        { type: "filter.hl7Type", allow: ["ADT^A01", "ADT^A04"] },
        { type: "transform.mapping", mapping: "adt-patient" },
      ],
      destinations: [{ id: "facade", type: "fhirstore", ordered: true }],
    };
    await engine.addChannel(channel);

    for (let i = 0; i < 3; i++) engine.ingest("hist", ADT, "x-application/hl7-v2+er7", "test");
    // One that the filter drops, so the status breakdown has more than one series.
    engine.ingest("hist", ADT.replace("ADT^A01", "ORU^R01"), "x-application/hl7-v2+er7", "test");

    await until(() => engine.db.listDeliveries({ channelId: "hist", state: "delivered" }).length === 3);

    const res = await fetch(`${base}/api/history?hours=24&bucket=hour`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      bucket: string;
      messages: Array<{ bucket: string; status: string; n: number }>;
      deliveries: Array<{ bucket: string; n: number }>;
    };

    assert.equal(body.bucket, "hour");
    const byStatus = Object.fromEntries(body.messages.map((r) => [r.status, r.n]));
    assert.equal(byStatus.processed, 3);
    assert.equal(byStatus.filtered, 1);
    assert.equal(body.deliveries.reduce((a, r) => a + r.n, 0), 3);
    // Bucket labels must be parseable, since the chart sorts on them.
    assert.match(body.messages[0].bucket, /^\d{4}-\d{2}-\d{2}T\d{2}:00$/);

    const daily = (await (await fetch(`${base}/api/history?bucket=day`)).json()) as { messages: Array<{ bucket: string }> };
    assert.match(daily.messages[0].bucket, /^\d{4}-\d{2}-\d{2}$/);

    // A window that predates everything is empty rather than an error.
    const empty = (await (await fetch(`${base}/api/history?hours=0`)).json()) as { messages: unknown[] };
    assert.ok(Array.isArray(empty.messages));
  } finally {
    await close();
  }
});

test("fixtures listing serves the shipped samples for the editor", async () => {
  const { base, close } = await boot();
  try {
    const fixtures = (await (await fetch(`${base}/api/fixtures`)).json()) as Array<{ name: string; content: string }>;
    assert.ok(fixtures.length >= 4);
    const adt = fixtures.find((f) => f.name === "adt_a01.hl7");
    assert.ok(adt, "the shipped ADT fixture should be listed");
    assert.match(adt.content, /^MSH\|/);
    // Directories are skipped, so every entry is loadable as text.
    assert.ok(fixtures.every((f) => typeof f.content === "string"));
  } finally {
    await close();
  }
});

test("the new endpoints sit behind the admin scope like the rest of /api", async () => {
  const engine = new Engine({ dbPath: ":memory:", tickMs: 15 });
  await engine.start();
  const reader = engine.keys.issue("reader", ["read"]);
  const api = await startApi(engine, 0, "127.0.0.1", { auth: new AuthGate({ keys: engine.keys }) });
  const base = `http://127.0.0.1:${api.port}`;
  try {
    for (const path of ["/api/history", "/api/fixtures", "/api/mappings"]) {
      assert.equal((await fetch(base + path)).status, 401, `${path} must require credentials`);
      assert.equal(
        (await fetch(base + path, { headers: { authorization: `Bearer ${reader.key}` } })).status,
        403,
        `${path} must require the admin scope`
      );
    }
    // Fixtures expose message content, so a read-scoped consumer must not
    // reach them just because they can read the facade.
    assert.equal(
      (
        await fetch(`${base}/api/mappings/preview`, {
          method: "POST",
          headers: { authorization: `Bearer ${reader.key}`, "content-type": "application/json" },
          body: JSON.stringify({ mapping: "x", sample: "y" }),
        })
      ).status,
      403
    );
  } finally {
    await api.close();
    await engine.stop();
  }
});
