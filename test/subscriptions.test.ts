import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { Engine } from "../src/core/engine.ts";
import { startApi } from "../src/api/admin.ts";
import { mllpSend } from "../src/hl7/mllp.ts";
import { criteriaMatches } from "../src/fhir/subscriptions.ts";
import type { ChannelConfig, MappingDoc } from "../src/types.ts";
import { until } from "./helpers.ts";

const ADT = readFileSync(new URL("../fixtures/adt_a01.hl7", import.meta.url), "utf8");
const MAPPING = JSON.parse(
  readFileSync(new URL("../mappings/adt-patient.json", import.meta.url), "utf8")
) as MappingDoc;

function collector() {
  const received: Array<Record<string, unknown>> = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      received.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
      res.writeHead(200);
      res.end("ok");
    });
  });
  return new Promise<{ port: number; received: typeof received; close: () => Promise<void> }>((resolve) => {
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


test("criteria matching: bare type and identifier tokens", () => {
  const patient = { resourceType: "Patient", identifier: [{ system: "s", value: "NT1" }] };
  assert.equal(criteriaMatches("Patient", patient), true);
  assert.equal(criteriaMatches("Observation", patient), false);
  assert.equal(criteriaMatches("Patient?identifier=NT1", patient), true);
  assert.equal(criteriaMatches("Patient?identifier=s|NT1", patient), true);
  assert.equal(criteriaMatches("Patient?identifier=other|NT1", patient), false);
  assert.equal(criteriaMatches("Patient?identifier=NT2", patient), false);
});

test("rest-hook subscriptions notify on change, never on unchanged, and honour criteria", async () => {
  const hookAll = await collector();
  const hookFiltered = await collector();
  const engine = new Engine({ dbPath: ":memory:", tickMs: 15 });
  engine.registerMapping(MAPPING);
  await engine.start();

  const channel: ChannelConfig = {
    id: "t-sub",
    name: "sub test",
    source: { type: "mllp", port: 0 },
    pipeline: [
      { type: "filter.hl7Type", allow: ["ADT^A01", "ADT^A04"] },
      { type: "transform.mapping", mapping: "adt-patient" },
    ],
    destinations: [{ id: "facade", type: "fhirstore", ordered: true }],
  };
  await engine.addChannel(channel);
  const api = await startApi(engine, 0, "127.0.0.1");
  const base = `http://127.0.0.1:${api.port}`;

  const create = async (criteria: string, port: number) => {
    const res = await fetch(`${base}/fhir/Subscription`, {
      method: "POST",
      headers: { "content-type": "application/fhir+json" },
      body: JSON.stringify({
        resourceType: "Subscription",
        status: "requested",
        criteria,
        channel: { type: "rest-hook", endpoint: `http://127.0.0.1:${port}/hook` },
      }),
    });
    assert.equal(res.status, 201);
    return (await res.json()) as { id: string; status: string };
  };

  const subAll = await create("Patient", hookAll.port);
  assert.equal(subAll.status, "active");
  await create("Patient?identifier=NOPE", hookFiltered.port);

  // First admission notifies the type-level hook only.
  await mllpSend("127.0.0.1", engine.mllpPort("t-sub")!, ADT, 3000);
  await until(() => hookAll.received.length === 1);
  assert.equal(hookAll.received[0].resourceType, "Patient");

  // Identical resend: unchanged upsert, no notification.
  await mllpSend("127.0.0.1", engine.mllpPort("t-sub")!, ADT, 3000);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(hookAll.received.length, 1);

  // A changed admission notifies again; the mismatched criteria hook stays silent.
  await mllpSend("127.0.0.1", engine.mllpPort("t-sub")!, ADT.replace("12 Ptarmigan Rd", "14 Ptarmigan Rd"), 3000);
  await until(() => hookAll.received.length === 2);
  assert.equal(hookFiltered.received.length, 0);

  const bundle = (await (await fetch(`${base}/fhir/Subscription`)).json()) as { total: number };
  assert.equal(bundle.total, 2);

  const del = await fetch(`${base}/fhir/Subscription/${subAll.id}`, { method: "DELETE" });
  assert.equal(del.status, 200);
  const after = (await (await fetch(`${base}/fhir/Subscription`)).json()) as { total: number };
  assert.equal(after.total, 1);

  const invalid = await fetch(`${base}/fhir/Subscription`, {
    method: "POST",
    headers: { "content-type": "application/fhir+json" },
    body: JSON.stringify({ resourceType: "Subscription", criteria: "Patient", channel: { type: "email", endpoint: "x" } }),
  });
  assert.equal(invalid.status, 400);

  await api.close();
  await engine.stop();
  await hookAll.close();
  await hookFiltered.close();
});
