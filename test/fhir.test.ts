import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Db } from "../src/db.ts";
import { FhirStore } from "../src/fhir/store.ts";
import { Engine } from "../src/core/engine.ts";
import { startApi } from "../src/api/admin.ts";
import { mllpSend } from "../src/hl7/mllp.ts";
import type { ChannelConfig, MappingDoc } from "../src/types.ts";
import { until } from "./helpers.ts";

const load = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const mapping = (p: string) => JSON.parse(load(p)) as MappingDoc;

const ADT = load("../fixtures/adt_a01.hl7");
const ADT_DG1 = load("../fixtures/adt_a08_dg1.hl7");
const ORU = load("../fixtures/oru_r01.hl7");
const RDE = load("../fixtures/rde_o11.hl7");


test("store versions by content: unchanged upsert keeps versionId, change bumps it", () => {
  const db = new Db(":memory:");
  const store = new FhirStore(db);

  const patient = {
    resourceType: "Patient",
    identifier: [{ system: "https://example.org/hcn", value: "NT000111" }],
    name: [{ family: "Kochon", given: ["Ren"] }],
  };

  const r1 = store.upsert(structuredClone(patient));
  assert.equal(r1.created, true);
  assert.equal(r1.versionId, 1);
  assert.equal(r1.id.length, 24);

  const r2 = store.upsert(structuredClone(patient));
  assert.equal(r2.created, false);
  assert.equal(r2.changed, false);
  assert.equal(r2.versionId, 1);
  assert.equal(r2.id, r1.id);

  const r3 = store.upsert({ ...structuredClone(patient), name: [{ family: "Kochon", given: ["Rene"] }] });
  assert.equal(r3.changed, true);
  assert.equal(r3.versionId, 2);
  assert.equal(r3.id, r1.id);

  const stored = store.get("Patient", r1.id);
  assert.ok(stored);
  assert.equal((stored.meta as { versionId: string }).versionId, "2");
  db.close();
});

test("store search matches identifier as system|value and as bare value", () => {
  const db = new Db(":memory:");
  const store = new FhirStore(db);
  store.upsert({
    resourceType: "Patient",
    identifier: [{ system: "https://example.org/hcn", value: "NT000222" }],
  });
  store.upsert({
    resourceType: "Patient",
    identifier: [{ system: "https://example.org/hcn", value: "NT000333" }],
  });

  assert.equal(store.search("Patient", { identifier: "https://example.org/hcn|NT000222" }).total, 1);
  assert.equal(store.search("Patient", { identifier: "NT000333" }).total, 1);
  assert.equal(store.search("Patient", { identifier: "https://other.org|NT000222" }).total, 0);
  assert.equal(store.search("Patient", {}).total, 2);
  assert.equal(store.search("Observation", {}).total, 0);
  db.close();
});

test("store rejects a resource without a resourceType", () => {
  const db = new Db(":memory:");
  const store = new FhirStore(db);
  assert.throws(() => store.upsert({ name: [{ family: "X" }] }), /resourceType/);
  db.close();
});

test("HL7 feeds land in the facade: Patient, split Observations, split Conditions, MedicationRequest", async () => {
  const engine = new Engine({ dbPath: ":memory:", tickMs: 15 });
  engine.registerMapping(mapping("../mappings/adt-patient.json"));
  engine.registerMapping(mapping("../mappings/oru-observation.json"));
  engine.registerMapping(mapping("../mappings/adt-condition.json"));
  engine.registerMapping(mapping("../mappings/rde-medicationrequest.json"));
  await engine.start();

  const mk = (id: string, allow: string[], extra: ChannelConfig["pipeline"]): ChannelConfig => ({
    id,
    name: id,
    source: { type: "mllp", port: 0 },
    pipeline: [{ type: "filter.hl7Type", allow }, ...(extra ?? [])],
    destinations: [{ id: "facade", type: "fhirstore", ordered: true }],
  });

  await engine.addChannel(mk("t-patient", ["ADT^A01", "ADT^A04"], [{ type: "transform.mapping", mapping: "adt-patient" }]));
  await engine.addChannel(
    mk("t-obs", ["ORU^R01"], [
      { type: "split.hl7Segment", segment: "OBX" },
      { type: "transform.mapping", mapping: "oru-observation" },
    ])
  );
  await engine.addChannel(
    mk("t-cond", ["ADT^A08"], [
      { type: "split.hl7Segment", segment: "DG1" },
      { type: "transform.mapping", mapping: "adt-condition" },
    ])
  );
  await engine.addChannel(mk("t-rx", ["RDE^O11"], [{ type: "transform.mapping", mapping: "rde-medicationrequest" }]));

  const api = await startApi(engine, 0, "127.0.0.1");
  const base = `http://127.0.0.1:${api.port}`;

  // Patient over MLLP, then read it back through the facade by identifier.
  const ackP = await mllpSend("127.0.0.1", engine.mllpPort("t-patient")!, ADT, 3000);
  assert.match(ackP, /MSA\|AA/);
  await until(() => engine.fhir.search("Patient", { identifier: "NT123456" }).total === 1);
  const bundle = (await (await fetch(`${base}/fhir/Patient?identifier=NT123456`)).json()) as {
    resourceType: string;
    total: number;
    entry: Array<{ fullUrl: string; resource: { name: Array<{ family: string }> } }>;
  };
  assert.equal(bundle.resourceType, "Bundle");
  assert.equal(bundle.total, 1);
  assert.equal(bundle.entry[0].resource.name[0].family, "Beaulieu");
  assert.match(bundle.entry[0].fullUrl, /\/fhir\/Patient\//);

  // One ORU with two OBX becomes two Observations, values intact, in order.
  const ingested = engine.ingest("t-obs", ORU, "x-application/hl7-v2+er7", "test");
  assert.equal(ingested.status, "processed");
  assert.equal(ingested.payloads, 2);
  await until(() => engine.fhir.search("Observation", {}).total === 2);
  const obs = engine.fhir.search("Observation", {}).resources as Array<{
    status: string;
    code: { coding: Array<{ code: string }> };
    valueQuantity: { value: number; unit: string };
    subject: { identifier: { value: string } };
  }>;
  const byCode = new Map(obs.map((o) => [o.code.coding[0].code, o]));
  assert.equal(byCode.get("718-7")?.valueQuantity.value, 142);
  assert.equal(byCode.get("718-7")?.valueQuantity.unit, "g/L");
  assert.equal(byCode.get("6690-2")?.valueQuantity.value, 7.2);
  for (const o of obs) {
    assert.equal(o.status, "final");
    assert.equal(o.subject.identifier.value, "NT123456");
  }
  const obsDeliveries = engine.db.listDeliveries({ channelId: "t-obs" });
  assert.equal(obsDeliveries.length, 2);

  // One A08 with two DG1 becomes two Conditions.
  const ackC = await mllpSend("127.0.0.1", engine.mllpPort("t-cond")!, ADT_DG1, 3000);
  assert.match(ackC, /MSA\|AA/);
  await until(() => engine.fhir.search("Condition", {}).total === 2);
  const conds = engine.fhir.search("Condition", {}).resources as Array<{ code: { coding: Array<{ code: string; system: string }> } }>;
  const codes = conds.map((c) => c.code.coding[0].code).sort();
  assert.deepEqual(codes, ["E11", "J45"]);
  assert.equal(conds[0].code.coding[0].system, "http://hl7.org/fhir/sid/icd-10");

  // RDE becomes one MedicationRequest with DIN, dosage text and quantity.
  const ackR = await mllpSend("127.0.0.1", engine.mllpPort("t-rx")!, RDE, 3000);
  assert.match(ackR, /MSA\|AA/);
  await until(() => engine.fhir.search("MedicationRequest", {}).total === 1);
  const rx = engine.fhir.search("MedicationRequest", {}).resources[0] as {
    medicationCodeableConcept: { coding: Array<{ code: string; system: string }> };
    dosageInstruction: Array<{ text: string }>;
    dispenseRequest: { quantity: { value: number } };
    requester: { display: string };
  };
  assert.equal(rx.medicationCodeableConcept.coding[0].code, "02243224");
  assert.equal(rx.medicationCodeableConcept.coding[0].system, "http://hl7.org/fhir/NamingSystem/ca-hc-din");
  assert.equal(rx.dosageInstruction[0].text, "500 mg BID");
  assert.equal(rx.dispenseRequest.quantity.value, 30);
  assert.equal(rx.requester.display, "John Tetso");

  // CapabilityStatement advertises the core resource set.
  const cap = (await (await fetch(`${base}/fhir/metadata`)).json()) as {
    resourceType: string;
    fhirVersion: string;
    rest: Array<{ resource: Array<{ type: string }> }>;
  };
  assert.equal(cap.resourceType, "CapabilityStatement");
  assert.equal(cap.fhirVersion, "4.0.1");
  const types = cap.rest[0].resource.map((r) => r.type);
  for (const t of ["Patient", "Condition", "Observation", "MedicationRequest"]) {
    assert.ok(types.includes(t), `capability missing ${t}`);
  }

  // Read miss returns an R4 OperationOutcome.
  const missRes = await fetch(`${base}/fhir/Patient/does-not-exist`);
  assert.equal(missRes.status, 404);
  const miss = (await missRes.json()) as { resourceType: string; issue: Array<{ code: string }> };
  assert.equal(miss.resourceType, "OperationOutcome");
  assert.equal(miss.issue[0].code, "not-found");

  // Resending identical content is idempotent: same Patient, versionId still 1.
  await mllpSend("127.0.0.1", engine.mllpPort("t-patient")!, ADT, 3000);
  await until(
    () =>
      engine.db.listDeliveries({ channelId: "t-patient" }).filter((d) => d.state === "delivered").length === 2
  );
  const search = engine.fhir.search("Patient", { identifier: "NT123456" });
  assert.equal(search.total, 1);
  assert.equal((search.resources[0].meta as { versionId: string }).versionId, "1");

  await api.close();
  await engine.stop();
});
