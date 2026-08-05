import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Db } from "../src/db.ts";
import { TerminologyStore, type TerminologyPack } from "../src/terminology/store.ts";
import { Engine } from "../src/core/engine.ts";
import type { ChannelConfig } from "../src/types.ts";

const PACK = JSON.parse(
  readFileSync(new URL("../terminology/ca-demo-subset.json", import.meta.url), "utf8")
) as TerminologyPack;

test("terminology store loads, looks up, expands and translates", () => {
  const db = new Db(":memory:");
  const store = new TerminologyStore(db);
  const n = store.loadPack(PACK);
  assert.equal(n.concepts, 12);
  assert.ok(n.valueSetMembers >= 6);
  assert.equal(n.mapEntries, 4);

  assert.equal(store.lookup("http://loinc.org", "718-7")?.display, "Hemoglobin [Mass/volume] in Blood");
  assert.equal(store.lookup("http://loinc.org", "nope"), undefined);

  const exp = store.expand("lab-codes-demo");
  assert.equal(exp.total, 4);
  assert.ok(store.memberCodes("lab-codes-demo").has("2345-7"));

  const t1 = store.translate({ code: "XON10382-3", map: "pclocd-to-loinc" });
  assert.equal(t1[0].code, "718-7");
  const t2 = store.translate({ code: "J45", targetSystem: "http://snomed.info/sct" });
  assert.equal(t2[0].code, "195967001");
  assert.equal(t2[0].display, "Asthma");
  assert.equal(store.translate({ code: "J45", map: "pclocd-to-loinc" }).length, 0);

  const s = store.stats();
  assert.equal(s.maps, 2);
  db.close();
});

test("engine wires translate into mappings through the mapper context", async () => {
  const engine = new Engine({ dbPath: ":memory:", tickMs: 15 });
  engine.terminology.loadPack(PACK);
  const channel: ChannelConfig = {
    id: "t-translate",
    name: "translate test",
    source: { type: "http" },
    pipeline: [
      {
        type: "transform.mapping",
        mapping: {
          id: "inline-translate",
          input: "json",
          output: "json",
          ops: [
            { set: "resourceType", value: "Condition" },
            { set: "code.coding[0].system", value: "http://snomed.info/sct" },
            { set: "code.coding[0].code", from: "icd10ca", fn: "translate", args: { map: "icd10ca-to-snomed" } },
            { set: "code.coding[0].display", from: "icd10ca", fn: "translate", args: { map: "icd10ca-to-snomed", result: "display" } },
          ],
        },
      },
    ],
    destinations: [{ id: "facade", type: "fhirstore" }],
  };
  await engine.addChannel(channel);
  const result = engine.ingest("t-translate", JSON.stringify({ icd10ca: "E11" }), "application/json", "test");
  assert.equal(result.status, "processed");
  const payload = JSON.parse(engine.db.deliveriesForMessage(result.message.id)[0].payload) as {
    code: { coding: Array<{ code: string; display: string }> };
  };
  assert.equal(payload.code.coding[0].code, "44054006");
  assert.equal(payload.code.coding[0].display, "Diabetes mellitus type 2");
  await engine.stop();
});
