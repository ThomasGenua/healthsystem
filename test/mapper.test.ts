import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { applyMapping, getJsonPath, setJsonPath } from "../src/transform/mapper.ts";
import type { MappingDoc } from "../src/types.ts";

const FIXTURE = readFileSync(new URL("../fixtures/adt_a01.hl7", import.meta.url), "utf8");
const MAPPING = JSON.parse(
  readFileSync(new URL("../mappings/adt-patient.json", import.meta.url), "utf8")
) as MappingDoc;

test("json path set and get with array indexes", () => {
  const obj: Record<string, unknown> = {};
  setJsonPath(obj, "name[0].given[1]", "Marie");
  setJsonPath(obj, "name[0].family", "Beaulieu");
  assert.deepEqual(obj, { name: [{ given: [undefined, "Marie"], family: "Beaulieu" }] });
  assert.equal(getJsonPath(obj, "name[0].family"), "Beaulieu");
  assert.equal(getJsonPath(obj, "name[0].given[1]"), "Marie");
  assert.equal(getJsonPath(obj, "missing.deep[3]"), undefined);
});

test("adt-patient mapping produces a PS-CA shaped Patient", () => {
  const out = applyMapping(MAPPING, FIXTURE);
  assert.equal(out.resourceType, "Patient");
  assert.equal(getJsonPath(out, "identifier[0].value"), "NT123456");
  assert.equal(getJsonPath(out, "identifier[0].type.coding[0].code"), "JHN");
  assert.equal(getJsonPath(out, "name[0].family"), "Beaulieu");
  assert.equal(getJsonPath(out, "name[0].given[0]"), "Marie");
  assert.equal(getJsonPath(out, "name[0].given[1]"), "Louise");
  assert.equal(out.birthDate, "1984-03-17");
  assert.equal(out.gender, "female");
  assert.equal(getJsonPath(out, "address[0].city"), "Yellowknife");
  assert.equal(getJsonPath(out, "address[0].country"), "CA");
  assert.equal(out.deceasedBoolean, undefined);
});

test("when conditions and defaults", () => {
  const doc: MappingDoc = {
    id: "t",
    input: "hl7",
    output: "json",
    ops: [
      { set: "dead", value: true, when: { path: "PID-30", equals: "Y" } },
      { set: "country", from: "PID-11.6", fn: "default", args: { value: "CA" } },
      { set: "sex", from: "PID-8", fn: "mapCode", args: { table: { F: "female" }, other: "unknown" } },
      {
        set: "label",
        fn: "concat",
        args: { sep: ", ", parts: [{ from: "PID-5.1" }, { from: "PID-5.2" }] },
      },
    ],
  };
  const raw = "MSH|^~\\&|A|B|C|D|20260101||ADT^A01|1|P|2.5\rPID|1||X||Doe^Jane|||F||||||||||||||||||||||N\r";
  const out = applyMapping(doc, raw);
  assert.equal(out.dead, undefined);
  assert.equal(out.country, "CA");
  assert.equal(out.sex, "female");
  assert.equal(out.label, "Doe, Jane");
});

test("empty values never write keys", () => {
  const doc: MappingDoc = {
    id: "t2",
    input: "hl7",
    output: "json",
    ops: [{ set: "telecom[0].value", from: "PID-13.1" }],
  };
  const raw = "MSH|^~\\&|A|B|C|D|20260101||ADT^A01|1|P|2.5\rPID|1||X||Doe^Jane\r";
  const out = applyMapping(doc, raw);
  assert.deepEqual(out, {});
});

test("unknown function raises", () => {
  const doc: MappingDoc = { id: "t3", input: "json", output: "json", ops: [{ set: "a", value: "x", fn: "nope" }] };
  assert.throws(() => applyMapping(doc, "{}"));
});
