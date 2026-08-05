import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Db } from "../src/db.ts";
import { FhirStore } from "../src/fhir/store.ts";
import { ConformanceRegistry, checkCapability, toOperationOutcome, validateResource } from "../src/conformance/validator.ts";
import { Engine } from "../src/core/engine.ts";
import { mllpSend } from "../src/hl7/mllp.ts";
import type { ChannelConfig, ConformancePack, MappingDoc } from "../src/types.ts";

const load = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));
const PSCA = load("../conformance/ps-ca.json") as ConformancePack;
const EREC = load("../conformance/ca-erec.json") as ConformancePack;
const FEX = load("../conformance/ca-fex.json") as ConformancePack;
const ADT_MAPPING = load("../mappings/adt-patient.json") as MappingDoc;

const errs = (pack: ConformancePack, r: unknown) =>
  validateResource(pack, r as Record<string, unknown>).filter((i) => i.severity === "error");

test("ps-ca pack passes the good patient and catches the bad one", () => {
  assert.equal(errs(PSCA, load("../fixtures/conformance/psca-patient-good.json")).length, 0);
  const bad = errs(PSCA, load("../fixtures/conformance/psca-patient-bad.json"));
  assert.ok(bad.length >= 3, `expected >=3 errors, got ${bad.length}`);
  const text = bad.map((i) => i.message).join(" | ");
  assert.match(text, /system/);
  assert.match(text, /not in \[male/);
  assert.match(text, /does not match/);
});

test("ca-erec pack distinguishes good and bad referrals", () => {
  assert.equal(errs(EREC, load("../fixtures/conformance/erec-servicerequest-good.json")).length, 0);
  const bad = errs(EREC, load("../fixtures/conformance/erec-servicerequest-bad.json"));
  assert.ok(bad.length >= 2);
  const text = bad.map((i) => i.message).join(" | ");
  assert.match(text, /at least 1/);
});

test("ca-fex bundle rules and capability self-check", () => {
  assert.equal(errs(FEX, load("../fixtures/conformance/fex-bundle-good.json")).length, 0);
  assert.ok(errs(FEX, load("../fixtures/conformance/fex-bundle-bad.json")).length >= 2);

  const db = new Db(":memory:");
  const cap = new FhirStore(db).capability("http://localhost", "0.3.0");
  const check = checkCapability(FEX, cap);
  assert.equal(check.ok, true);
  db.close();

  const registry = new ConformanceRegistry();
  registry.register(PSCA);
  registry.register(FEX);
  assert.equal(registry.list().length, 2);
  const outcome = toOperationOutcome(errs(FEX, load("../fixtures/conformance/fex-bundle-bad.json")));
  assert.equal(outcome.resourceType, "OperationOutcome");
});

test("unknown resource type yields an information issue, not an error", () => {
  const issues = validateResource(PSCA, { resourceType: "Appointment" });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].severity, "information");
});

test("validate.profile gates the pipeline: reject AEs, annotate passes with a note", async () => {
  const engine = new Engine({ dbPath: ":memory:", tickMs: 15 });
  engine.registerMapping(ADT_MAPPING);
  engine.conformance.register(PSCA);

  const mk = (id: string, mode: "reject" | "annotate"): ChannelConfig => ({
    id,
    name: id,
    source: { type: "mllp", port: 0 },
    pipeline: [
      { type: "filter.hl7Type", allow: ["ADT^A01", "ADT^A04"] },
      { type: "transform.mapping", mapping: "adt-patient" },
      { type: "validate.profile", pack: "ps-ca", mode },
    ],
    destinations: [{ id: "facade", type: "fhirstore", ordered: true }],
  });
  await engine.addChannel(mk("t-reject", "reject"));
  await engine.addChannel(mk("t-annotate", "annotate"));

  const good = readFileSync(new URL("../fixtures/adt_a01.hl7", import.meta.url), "utf8");
  // No PID-3 and no PID-5: the mapped Patient has neither identifier nor name.
  const bad =
    "MSH|^~\\&|WOLF|YKPCC|PORTAGE|GNWT|20260805120000||ADT^A01^ADT_A01|BAD0001|P|2.5.1\r" +
    "PID|1||||||19840317|F\rPV1|1|O\r";

  const ackGood = await mllpSend("127.0.0.1", engine.mllpPort("t-reject")!, good, 3000);
  assert.match(ackGood, /MSA\|AA/);

  const ackBad = await mllpSend("127.0.0.1", engine.mllpPort("t-reject")!, bad, 3000);
  assert.match(ackBad, /MSA\|AE/);
  assert.match(ackBad, /Conformance ps-ca/);
  const errored = engine.db.listMessages({ channelId: "t-reject", status: "error" });
  assert.equal(errored.length, 1);

  const ackAnnotate = await mllpSend("127.0.0.1", engine.mllpPort("t-annotate")!, bad, 3000);
  assert.match(ackAnnotate, /MSA\|AA/);
  const msg = engine.db.listMessages({ channelId: "t-annotate" })[0];
  const steps = engine.db.getSteps(msg.id);
  const note = steps.find((s) => s.name === "validate.profile");
  assert.ok(note?.output);
  const recorded = JSON.parse(note!.output!) as { pack: string; errors: Array<{ message: string }> };
  assert.equal(recorded.pack, "ps-ca");
  assert.ok(recorded.errors.length >= 2, `expected >=2 recorded errors, got ${recorded.errors.length}`);
  const messages = recorded.errors.map((e) => e.message).join(" | ");
  assert.match(messages, /Missing required value/);
  assert.match(messages, /Missing required family/);

  await engine.stop();
});
