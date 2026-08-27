/**
 * A rest-hook Subscription is not clinical traffic.
 *
 * It is a standing instruction to send patient records to an address, which is
 * the same class of decision as adding a destination to a channel — and that
 * needs admin. Created under the general `/fhir/` rule it needed only `write`,
 * which is exactly what a feed is given: a lab or an ADT sender that should be
 * able to push messages in and nothing else.
 *
 * So the credential a lab uses to file results could register a rest-hook of
 * its own choosing and have the facade delivered to it — push-only access
 * turned into a continuous read of the clinical record, and out to a
 * destination the operator never approved. `test/auth.test.ts` asserted the
 * old behaviour as though it were intended, which is why nothing caught it.
 *
 * These tests run the exploit rather than asserting the scope map, because the
 * scope map is what was wrong.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../src/core/engine.ts";
import { startApi } from "../src/api/admin.ts";
import { AuthGate } from "../src/auth/gate.ts";
import { mllpSend } from "../src/hl7/mllp.ts";
import { until } from "./helpers.ts";
import type { MappingDoc } from "../src/types.ts";

async function collector(): Promise<{ port: number; got: string[]; close: () => Promise<void> }> {
  const got: string[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      got.push(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(200).end("ok");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return {
    port: (server.address() as { port: number }).port,
    got,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), "northstar-subscope-"));
  const engine = new Engine({ dbPath: join(dir, "northstar.db"), tickMs: 25 });
  await engine.start();
  const api = await startApi(engine, 0, "127.0.0.1", { auth: new AuthGate({ keys: engine.keys }) });
  return {
    engine,
    api,
    base: `http://127.0.0.1:${api.port}`,
    close: async () => {
      await api.close();
      await engine.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** The site's real admissions feed: MLLP in, mapped, into the facade. */
async function adtChannel(engine: Engine): Promise<number> {
  engine.registerMapping(
    JSON.parse(readFileSync(new URL("../mappings/adt-patient.json", import.meta.url), "utf8")) as MappingDoc
  );
  await engine.addChannel({
    id: "adt",
    name: "admissions",
    source: { type: "mllp", port: 0 },
    pipeline: [{ type: "transform.mapping", mapping: "adt-patient" }],
    destinations: [{ id: "facade", type: "fhirstore", ordered: true }],
  });
  return engine.mllpPort("adt")!;
}

test("a feed credential cannot subscribe its way to the clinical record", async () => {
  const sink = await collector();
  const { engine, base, close } = await boot();
  try {
    const feed = engine.keys.issue("lab-feed", ["write"]);
    const auth = { authorization: `Bearer ${feed.key}`, "content-type": "application/json" };

    // The scope model working as documented: push-only cannot read.
    assert.equal((await fetch(`${base}/fhir/Patient`, { headers: auth })).status, 403);

    const attempt = await fetch(`${base}/fhir/Subscription`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        resourceType: "Subscription",
        status: "requested",
        criteria: "Patient",
        channel: { type: "rest-hook", endpoint: `http://127.0.0.1:${sink.port}/collect` },
      }),
    });
    assert.equal(attempt.status, 403, "registering a rest-hook is administration, not writing");
    assert.equal(engine.subs.list().length, 0, "and nothing was stored");

    // The site's real feed now does what it does every day. With no
    // subscription registered there is nowhere for the record to go.
    const port = await adtChannel(engine);
    const raw = readFileSync(new URL("../fixtures/adt_a01.hl7", import.meta.url), "utf8");
    assert.match(await mllpSend("127.0.0.1", port, raw, 5_000), /MSA\|AA/);
    await until(() => engine.fhir.search("Patient", {}).total === 1);
    await new Promise((r) => setTimeout(r, 400));

    assert.deepEqual(sink.got, [], "no patient record left the engine");
  } finally {
    await close();
    await sink.close();
  }
});

test("the same request with an admin key works, so the feature is intact", async () => {
  const sink = await collector();
  const { engine, base, close } = await boot();
  try {
    const operator = engine.keys.issue("operator", ["admin"]);
    const auth = { authorization: `Bearer ${operator.key}`, "content-type": "application/json" };

    const created = await fetch(`${base}/fhir/Subscription`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        resourceType: "Subscription",
        status: "requested",
        criteria: "Patient",
        channel: { type: "rest-hook", endpoint: `http://127.0.0.1:${sink.port}/collect` },
      }),
    });
    assert.equal(created.status, 201);

    const port = await adtChannel(engine);
    const raw = readFileSync(new URL("../fixtures/adt_a01.hl7", import.meta.url), "utf8");
    assert.match(await mllpSend("127.0.0.1", port, raw, 5_000), /MSA\|AA/);

    await until(() => sink.got.length === 1, 10_000);
    assert.match(sink.got[0], /Beaulieu/, "an operator-registered rest-hook still receives the resource");

    // And reading the list is administration too: it enumerates every place
    // patient data has been arranged to go.
    const reader = engine.keys.issue("consumer", ["read"]);
    const listed = await fetch(`${base}/fhir/Subscription`, {
      headers: { authorization: `Bearer ${reader.key}` },
    });
    assert.equal(listed.status, 403);
  } finally {
    await close();
    await sink.close();
  }
});

test("registering and removing a disclosure are both recorded", async () => {
  // The audit trail recorded a single record being read but not the standing
  // arrangement to send every future one elsewhere — by far the larger act,
  // and the only one that left no mark.
  const sink = await collector();
  const { engine, base, close } = await boot();
  try {
    const operator = engine.keys.issue("operator", ["admin"]);
    const auth = { authorization: `Bearer ${operator.key}`, "content-type": "application/json" };
    const endpoint = `http://127.0.0.1:${sink.port}/collect`;

    const created = await fetch(`${base}/fhir/Subscription`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        resourceType: "Subscription",
        status: "requested",
        criteria: "Patient",
        channel: { type: "rest-hook", endpoint },
      }),
    });
    const id = ((await created.json()) as { id: string }).id;

    const onCreate = engine.audit.list({ limit: 50 }).find((r) => r.resource_type === "Subscription");
    assert.ok(onCreate, "creating a standing disclosure must appear on the trail");
    assert.equal(onCreate!.action, "C");
    assert.equal(onCreate!.principal_id, operator.id);
    assert.match(onCreate!.detail ?? "", new RegExp(endpoint.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    await fetch(`${base}/fhir/Subscription/${id}`, { method: "DELETE", headers: auth });
    const onDelete = engine.audit.list({ limit: 50 }).find((r) => r.action === "D" && r.resource_type === "Subscription");
    assert.ok(onDelete, "ending one is part of the account too");
    assert.match(onDelete!.detail ?? "", /rest-hook to /);

    assert.equal(engine.audit.verifyChain().ok, true);
  } finally {
    await close();
    await sink.close();
  }
});

test("a refused attempt to subscribe is recorded, not silently dropped", async () => {
  const { engine, base, close } = await boot();
  try {
    const feed = engine.keys.issue("lab-feed", ["write"]);
    await fetch(`${base}/fhir/Subscription`, {
      method: "POST",
      headers: { authorization: `Bearer ${feed.key}`, "content-type": "application/json" },
      body: JSON.stringify({
        resourceType: "Subscription",
        status: "requested",
        criteria: "Patient",
        channel: { type: "rest-hook", endpoint: "http://127.0.0.1:1/collect" },
      }),
    });

    const refusal = engine.audit.list({ limit: 50 }).find((r) => r.outcome > 0);
    assert.ok(refusal, "someone trying to arrange an exfiltration should leave a mark");
    assert.equal(refusal!.principal_id, feed.id, "and it must name who tried");
    assert.match(refusal!.path, /\/fhir\/Subscription/);
  } finally {
    await close();
  }
});
