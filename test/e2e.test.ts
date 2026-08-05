import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { Engine } from "../src/core/engine.ts";
import { startApi } from "../src/api/admin.ts";
import { mllpSend } from "../src/hl7/mllp.ts";
import { getHl7, parseHl7 } from "../src/hl7/parser.ts";
import type { ChannelConfig, MappingDoc } from "../src/types.ts";
import { until } from "./helpers.ts";

const FIXTURE = readFileSync(new URL("../fixtures/adt_a01.hl7", import.meta.url), "utf8");
const MAPPING = JSON.parse(
  readFileSync(new URL("../mappings/adt-patient.json", import.meta.url), "utf8")
) as MappingDoc;

function fhirCollector() {
  const received: unknown[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      received.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      res.writeHead(201, { "content-type": "application/fhir+json" });
      res.end(JSON.stringify({ resourceType: "Patient", id: `srv-${received.length}` }));
    });
  });
  return new Promise<{ port: number; received: unknown[]; close: () => Promise<void> }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({
        port: typeof addr === "object" && addr ? addr.port : 0,
        received,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}


test("MLLP ADT in, FHIR Patient out, with lineage, chain and API", async () => {
  const store = await fhirCollector();
  const engine = new Engine({ dbPath: ":memory:", tickMs: 15 });
  engine.registerMapping(MAPPING);
  await engine.start();

  const channel: ChannelConfig = {
    id: "adt-test",
    name: "ADT test channel",
    source: { type: "mllp", port: 0 },
    pipeline: [
      { type: "filter.hl7Type", allow: ["ADT^A01", "ADT^A04"] },
      { type: "transform.mapping", mapping: "adt-patient" },
    ],
    destinations: [
      {
        id: "fhir",
        type: "http",
        url: `http://127.0.0.1:${store.port}/fhir/Patient`,
        ordered: true,
        maxAttempts: 3,
        backoffBaseMs: 10,
        backoffCapMs: 30,
      },
    ],
  };
  await engine.addChannel(channel);
  const mllpPort = engine.mllpPort("adt-test")!;
  assert.ok(mllpPort > 0);

  // Send the ADT and expect an application accept.
  const ackRaw = await mllpSend("127.0.0.1", mllpPort, FIXTURE);
  const ack = parseHl7(ackRaw);
  assert.equal(getHl7(ack, "MSA-1"), "AA");
  assert.equal(getHl7(ack, "MSA-2"), "MSG00001");

  await until(() => store.received.length === 1);
  const patient = store.received[0] as Record<string, unknown>;
  assert.equal(patient.resourceType, "Patient");
  assert.equal((patient.name as Array<{ family: string }>)[0].family, "Beaulieu");
  assert.equal(patient.birthDate, "1984-03-17");
  assert.equal(patient.gender, "female");

  // A filtered type is acknowledged but not delivered.
  const a03 = FIXTURE.replace("ADT^A01^ADT_A01", "ADT^A03^ADT_A03").replace("MSG00001", "MSG00002");
  const ack2 = parseHl7(await mllpSend("127.0.0.1", mllpPort, a03));
  assert.equal(getHl7(ack2, "MSA-1"), "AA");
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(store.received.length, 1);

  // Lineage: raw stored, steps recorded, delivery ack captured.
  const messages = engine.db.listMessages({ channelId: "adt-test" });
  assert.equal(messages.length, 2);
  const processed = messages.find((m) => m.status === "processed")!;
  const filtered = messages.find((m) => m.status === "filtered")!;
  assert.ok(processed && filtered);
  const steps = engine.db.getSteps(processed.id);
  assert.equal(steps.length, 2);
  assert.equal(steps[1].name, "transform.mapping");
  const deliveries = engine.db.deliveriesForMessage(processed.id);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].state, "delivered");
  assert.match(deliveries[0].ack ?? "", /srv-1/);

  assert.deepEqual(engine.db.verifyChain("adt-test").ok, true);

  // API surface.
  const api = await startApi(engine, 0, "127.0.0.1");
  const base = `http://127.0.0.1:${api.port}`;

  const health = (await (await fetch(`${base}/api/health`)).json()) as { ok: boolean };
  assert.equal(health.ok, true);

  const channels = (await (await fetch(`${base}/api/channels`)).json()) as Array<{ id: string; running: boolean }>;
  assert.equal(channels.length, 1);
  assert.equal(channels[0].running, true);

  const msgList = (await (await fetch(`${base}/api/messages?channel_id=adt-test`)).json()) as Array<{ id: string }>;
  assert.equal(msgList.length, 2);

  const detail = (await (await fetch(`${base}/api/messages/${processed.id}`)).json()) as {
    steps: unknown[];
    deliveries: unknown[];
  };
  assert.equal(detail.steps.length, 2);
  assert.equal(detail.deliveries.length, 1);

  const verify = (await (await fetch(`${base}/api/chain/verify?channel_id=adt-test`)).json()) as { ok: boolean };
  assert.equal(verify.ok, true);

  await api.close();
  await engine.stop();
  await store.close();
});

test("FHIR source channel accepts a resource over HTTP", async () => {
  const store = await fhirCollector();
  const engine = new Engine({ dbPath: ":memory:", tickMs: 15 });
  await engine.start();
  await engine.addChannel({
    id: "fhir-in",
    name: "FHIR inbound",
    source: { type: "fhir", resourceTypes: ["Patient"] },
    destinations: [
      {
        id: "out",
        type: "http",
        url: `http://127.0.0.1:${store.port}/fhir/Patient`,
        maxAttempts: 3,
        backoffBaseMs: 10,
      },
    ],
  });
  const api = await startApi(engine, 0, "127.0.0.1");
  const base = `http://127.0.0.1:${api.port}`;

  const res = await fetch(`${base}/fhir/Patient`, {
    method: "POST",
    headers: { "content-type": "application/fhir+json" },
    body: JSON.stringify({ resourceType: "Patient", id: "p1" }),
  });
  assert.equal(res.status, 202);

  const wrong = await fetch(`${base}/fhir/Observation`, {
    method: "POST",
    headers: { "content-type": "application/fhir+json" },
    body: JSON.stringify({ resourceType: "Observation" }),
  });
  assert.equal(wrong.status, 404);

  const mismatch = await fetch(`${base}/fhir/Patient`, {
    method: "POST",
    headers: { "content-type": "application/fhir+json" },
    body: JSON.stringify({ resourceType: "Observation" }),
  });
  assert.equal(mismatch.status, 400);

  await until(() => store.received.length === 1);
  await api.close();
  await engine.stop();
  await store.close();
});

test("transform failure yields AE and an error message row", async () => {
  const engine = new Engine({ dbPath: ":memory:", tickMs: 15 });
  engine.registerMapping({ id: "boom", input: "hl7", output: "json", ops: [{ set: "x", from: "PID-5.1", fn: "nope" }] });
  await engine.start();
  await engine.addChannel({
    id: "err-ch",
    name: "error channel",
    source: { type: "mllp", port: 0 },
    pipeline: [{ type: "transform.mapping", mapping: "boom" }],
    destinations: [{ id: "d", type: "http", url: "http://127.0.0.1:1/never" }],
  });
  const port = engine.mllpPort("err-ch")!;
  const ack = parseHl7(await mllpSend("127.0.0.1", port, FIXTURE));
  assert.equal(getHl7(ack, "MSA-1"), "AE");
  const rows = engine.db.listMessages({ channelId: "err-ch" });
  assert.equal(rows[0].status, "error");
  assert.equal(engine.db.deliveriesForMessage(rows[0].id).length, 0);
  await engine.stop();
});
