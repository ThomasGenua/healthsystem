import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Engine } from "../src/core/engine.ts";
import { mllpSend } from "../src/hl7/mllp.ts";
import type { ChannelConfig, MappingDoc } from "../src/types.ts";

const ORU_MULTI = readFileSync(new URL("../fixtures/oru_r01_multi.hl7", import.meta.url), "utf8");
const MAPPING = JSON.parse(
  readFileSync(new URL("../mappings/oru-observation.json", import.meta.url), "utf8")
) as MappingDoc;

async function until(cond: () => boolean, ms = 6000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("condition not reached");
}

test("split.hl7Group then split.hl7Segment: two OBR batteries become three Observations with per-battery times", async () => {
  const engine = new Engine({ dbPath: ":memory:", tickMs: 15 });
  engine.registerMapping(MAPPING);
  await engine.start();
  const channel: ChannelConfig = {
    id: "t-group",
    name: "group split test",
    source: { type: "mllp", port: 0 },
    pipeline: [
      { type: "filter.hl7Type", allow: ["ORU^R01"] },
      { type: "split.hl7Group", segment: "OBR" },
      { type: "split.hl7Segment", segment: "OBX" },
      { type: "transform.mapping", mapping: "oru-observation" },
    ],
    destinations: [{ id: "facade", type: "fhirstore", ordered: true }],
  };
  await engine.addChannel(channel);

  const result = engine.ingest("t-group", ORU_MULTI, "x-application/hl7-v2+er7", "test");
  assert.equal(result.status, "processed");
  assert.equal(result.payloads, 3);

  await until(() => engine.fhir.search("Observation", {}).total === 3);
  const obs = engine.fhir.search("Observation", {}).resources as Array<{
    code: { coding: Array<{ code: string }> };
    effectiveDateTime: string;
    identifier: Array<{ value: string }>;
    valueQuantity: { value: number };
  }>;
  const byCode = new Map(obs.map((o) => [o.code.coding[0].code, o]));

  assert.ok(byCode.get("718-7")?.effectiveDateTime.startsWith("2026-08-05T10:45"));
  assert.ok(byCode.get("6690-2")?.effectiveDateTime.startsWith("2026-08-05T10:45"));
  assert.ok(byCode.get("2345-7")?.effectiveDateTime.startsWith("2026-08-05T11:00"));
  assert.equal(byCode.get("2345-7")?.valueQuantity.value, 5.4);
  assert.match(byCode.get("718-7")!.identifier[0].value, /^FL9001-/);
  assert.match(byCode.get("2345-7")!.identifier[0].value, /^FL9002-/);

  const ack = await mllpSend("127.0.0.1", engine.mllpPort("t-group")!, ORU_MULTI, 3000);
  assert.match(ack, /MSA\|AA/);
  await until(() => engine.db.listDeliveries({ channelId: "t-group", state: "delivered" }).length === 6);
  assert.equal(engine.fhir.search("Observation", {}).total, 3);

  await engine.stop();
});
