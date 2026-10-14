/**
 * The questions a laboratory asks before it will run a test.
 *
 * Ask-at-order-entry looks like paperwork and is not. A glucose reported
 * against a fasting reference interval when the patient had breakfast is a
 * **wrong** result, not a missing one — the number is real, the interval is
 * real, and the pairing is false. Neither the laboratory nor the chart can
 * tell afterwards, because nothing in the specimen says whether anybody ate.
 *
 * Which makes the dangerous implementation the accommodating one. Defaulting
 * "fasting: no" produces an order that sends cleanly, a result that files
 * cleanly, and an interval chosen by a program rather than by a patient. So an
 * answer is never invented: an unanswered required question stops the order,
 * exactly as a missing patient identifier does.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildOml, type OmlContext } from "../src/orders/outbound.ts";
import { parseHl7, getHl7 } from "../src/hl7/parser.ts";
import type { LabProfile } from "../src/orders/hl7.ts";
import type { OrderRow } from "../src/orders/store.ts";
import type { PatientSummary } from "../src/clinical/patients.ts";

const FASTING = { code: "1558-6", text: "Fasting status", required: true };
const LMP = { code: "8665-2", text: "Last menstrual period", required: false };

const PROFILE: LabProfile = {
  id: "stanton",
  name: "Stanton Laboratory",
  patientAssigningAuthority: "JHN",
  defaultCodeSystem: "LN",
  askAtOrderEntry: {
    // Glucose asks about fasting; potassium asks nothing.
    "2345-7": [FASTING, LMP],
  },
};

const CTX: OmlContext = {
  sendingApplication: "NORTHSTAR",
  sendingFacility: "GNWT",
  receivingApplication: "LABAPP",
  receivingFacility: "STANTON",
  timezoneOffset: "-06:00",
  orderingProvider: { id: "1234", family: "Tetso", given: "John" },
  controlId: "MSG-1",
  now: "2026-08-27T15:30:00.000Z",
};

/** OBX segments in a built message. */
function obxCount(message: string): number {
  return message.split("\r").filter((l) => l.startsWith("OBX")).length;
}

function patient(): PatientSummary {
  return {
    patientId: "NT123456",
    family: "Beaulieu",
    given: "Marie",
    birthDate: "1984-03-17",
    gender: "F",
    preferredLanguage: null,
    phone: null,
    email: null,
    identifiers: [{ system: "JHN", value: "NT123456" }],
    updatedAt: "2026-08-27T00:00:00.000Z",
  };
}

function order(code = "2345-7", display = "Glucose"): OrderRow {
  return {
    tenant_id: "default",
    id: "ord-7",
    patient_id: "NT123456",
    encounter_id: null,
    category: "lab",
    code,
    code_system: "LN",
    display,
    status: "placed",
    priority: "routine",
    indication: "Diabetes review",
    ordered_by: "dr-tetso",
    ordered_at: "2026-08-27T15:00:00.000Z",
    responsible_id: "dr-tetso",
    expected_by: null,
    correlation_id: "corr-7",
    filler_order_number: null,
    created_at: "2026-08-27T15:00:00.000Z",
    updated_at: "2026-08-27T15:00:00.000Z",
    closed_at: null,
  };
}

test("an unanswered required question stops the order rather than guessing", () => {
  // The whole point. The accommodating implementation defaults it, the order
  // sends cleanly, and a program has chosen the reference interval.
  const out = buildOml(order(), patient(), CTX, PROFILE);
  assert.equal(out.built, false);
  if (out.built) return;
  assert.ok(out.missing.some((m) => /Fasting status/.test(m) && /1558-6/.test(m)));
});

test("an answered question travels as an OBX against the order", () => {
  const out = buildOml(order(), patient(), { ...CTX, aoeAnswers: { "1558-6": "Y" } }, PROFILE);
  assert.equal(out.built, true);
  if (!out.built) return;
  const m = parseHl7(out.message);
  assert.equal(getHl7(m, "OBX-3.1"), "1558-6");
  assert.equal(getHl7(m, "OBX-3.2"), "Fasting status");
  assert.equal(getHl7(m, "OBX-5"), "Y");
  assert.equal(getHl7(m, "OBX-11"), "O", "an observation the order carries, not a result");
});

test("an optional question left blank does not stop the order, and is not sent empty", () => {
  // An OBX with an empty value asserts that somebody answered and said
  // nothing, which is a different claim from nobody having been asked.
  const out = buildOml(order(), patient(), { ...CTX, aoeAnswers: { "1558-6": "Y" } }, PROFILE);
  assert.equal(out.built, true);
  if (!out.built) return;
  assert.equal(obxCount(out.message), 1, "only the answered one");
});

test("both answered means both travel, numbered in order", () => {
  const out = buildOml(
    order(),
    patient(),
    { ...CTX, aoeAnswers: { "1558-6": "Y", "8665-2": "20260801" } },
    PROFILE
  );
  assert.equal(out.built, true);
  if (!out.built) return;
  const segs = out.message.split("\r").filter((l) => l.startsWith("OBX"));
  assert.equal(segs.length, 2);
  assert.deepEqual(segs.map((l) => l.split("|")[1]), ["1", "2"], "OBX-1 set ids run in order");
  assert.equal(segs[1].split("|")[5], "20260801");
});

test("a whitespace answer is not an answer", () => {
  const out = buildOml(order(), patient(), { ...CTX, aoeAnswers: { "1558-6": "   " } }, PROFILE);
  assert.equal(out.built, false);
  if (out.built) return;
  assert.ok(out.missing.some((m) => /Fasting status/.test(m)));
});

test("a test the laboratory asks nothing about carries no questions", () => {
  // The questions are per test, not per laboratory. A potassium that demanded
  // a fasting answer would train people to answer without reading.
  const out = buildOml(order("2823-3", "Potassium"), patient(), CTX, PROFILE);
  assert.equal(out.built, true);
  if (!out.built) return;
  assert.equal(obxCount(out.message), 0);
});

test("a laboratory that declares no questions asks none", () => {
  const bare: LabProfile = { id: "x", name: "X", patientAssigningAuthority: "JHN" };
  const out = buildOml(order(), patient(), CTX, bare);
  assert.equal(out.built, true, "no declaration is not a required question nobody can answer");
});

test("an answer to a question this laboratory did not ask is not smuggled through", () => {
  // Sending an unasked observation invites the laboratory to interpret it, and
  // what they do with it is not something this end can predict.
  const out = buildOml(
    order("2823-3", "Potassium"),
    patient(),
    { ...CTX, aoeAnswers: { "1558-6": "Y" } },
    PROFILE
  );
  assert.equal(out.built, true);
  if (!out.built) return;
  assert.equal(obxCount(out.message), 0, "not asked, so not sent");
});

test("units declared on a question travel with the answer", () => {
  const withUnits: LabProfile = {
    ...PROFILE,
    askAtOrderEntry: { "2345-7": [{ code: "3141-9", text: "Body weight", required: true, units: "kg" }] },
  };
  const out = buildOml(order(), patient(), { ...CTX, aoeAnswers: { "3141-9": "68" } }, withUnits);
  assert.equal(out.built, true);
  if (!out.built) return;
  const m = parseHl7(out.message);
  assert.equal(getHl7(m, "OBX-5"), "68");
  assert.equal(getHl7(m, "OBX-6"), "kg", "a weight with no unit is a number, not a measurement");
});

test("the missing answer is listed alongside every other missing field, not instead of them", () => {
  const out = buildOml(order(), { ...patient(), birthDate: null }, CTX, PROFILE);
  assert.equal(out.built, false);
  if (out.built) return;
  assert.ok(out.missing.includes("patient.birthDate"));
  assert.ok(out.missing.some((m) => /Fasting status/.test(m)));
});
