/**
 * The specimen, and the collection that has not happened yet.
 *
 * Most orders are placed before anybody draws anything: the clinician orders
 * now, phlebotomy happens later. An order in that state has no specimen, and
 * the accommodating implementation invents one — a type from the test code, a
 * collection time of "now" — because it makes the message look complete.
 *
 * Both inventions are dangerous in the same direction. A collection time is
 * not decoration: a trough vancomycin drawn an hour after the dose is not a
 * trough, and a cortisol at four in the afternoon is not a morning cortisol.
 * The value is interpreted against the time. Stamp the wrong one and the
 * laboratory reports a valid-looking result for a test that was never
 * performed as ordered, and nothing downstream can recover the difference from
 * the tube.
 *
 * So: no specimen, no segment. And a specimen that is asserted has to be
 * described.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildOml, type OmlContext } from "../src/orders/outbound.ts";
import { parseHl7, getHl7 } from "../src/hl7/parser.ts";
import type { LabProfile } from "../src/orders/hl7.ts";
import type { OrderRow } from "../src/orders/store.ts";
import type { PatientSummary } from "../src/clinical/patients.ts";

const PROFILE: LabProfile = {
  id: "stanton",
  name: "Stanton Laboratory",
  patientAssigningAuthority: "JHN",
  defaultCodeSystem: "LN",
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

const DRAWN = {
  type: "BLD",
  typeText: "Whole blood",
  collectedAt: "2026-08-27T14:05:00.000Z",
  specimenId: "TUBE-99213",
  sourceSite: "Left antecubital fossa",
};

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

function order(): OrderRow {
  return {
    tenant_id: "default",
    id: "ord-7",
    patient_id: "NT123456",
    encounter_id: null,
    category: "lab",
    code: "4049-3",
    code_system: "LN",
    display: "Vancomycin trough",
    status: "placed",
    priority: "routine",
    indication: "Day 3 of vancomycin",
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

function spmCount(message: string): number {
  return message.split("\r").filter((l) => l.startsWith("SPM")).length;
}

test("an order with nothing drawn yet carries no specimen segment", () => {
  // The ordinary case, and the one an accommodating implementation gets wrong.
  // An order placed at 15:00 for a draw at 16:30 has no specimen at 15:00, and
  // saying nothing is the accurate thing to say.
  const out = buildOml(order(), patient(), CTX, PROFILE);
  assert.equal(out.built, true);
  if (!out.built) return;
  assert.equal(spmCount(out.message), 0, "a request to collect is not a collection");
});

test("a collected specimen travels with its type, time, tube and site", () => {
  const out = buildOml(order(), patient(), { ...CTX, specimen: DRAWN }, PROFILE);
  assert.equal(out.built, true);
  if (!out.built) return;
  const m = parseHl7(out.message);
  assert.equal(getHl7(m, "SPM-4.1"), "BLD", "SPM-4 specimen type");
  assert.equal(getHl7(m, "SPM-4.2"), "Whole blood");
  assert.equal(getHl7(m, "SPM-2"), "TUBE-99213", "SPM-2, how the tube is matched to this requisition");
  assert.equal(getHl7(m, "SPM-8"), "Left antecubital fossa", "SPM-8 source site");
  assert.equal(getHl7(m, "SPM-17"), "20260827140500-0600", "SPM-17 collection time, with the declared offset");
});

test("a specimen with no collection time is refused, because the time is the test", () => {
  // The heart of it. A vancomycin trough is defined by when it was drawn; a
  // level with no time is a number the laboratory cannot interpret and the
  // chart cannot check.
  const { collectedAt: _omitted, ...noTime } = DRAWN;
  const out = buildOml(order(), patient(), { ...CTX, specimen: noTime as typeof DRAWN }, PROFILE);
  assert.equal(out.built, false);
  if (out.built) return;
  assert.ok(out.missing.includes("specimen.collectedAt"));
});

test("a collection time in the future is refused rather than passed on", () => {
  // A mistyped date. The reason to refuse rather than forward it is what a
  // wrong time does to a timed level: stamped an hour late, a trough drawn at
  // the wrong moment reads as a valid trough.
  const out = buildOml(
    order(),
    patient(),
    { ...CTX, specimen: { ...DRAWN, collectedAt: "2026-08-28T09:00:00.000Z" } },
    PROFILE
  );
  assert.equal(out.built, false);
  if (out.built) return;
  assert.ok(out.missing.some((m) => /in the future; nothing has been collected yet/.test(m)));
});

test("a collection time that is not a time is refused", () => {
  const out = buildOml(
    order(),
    patient(),
    { ...CTX, specimen: { ...DRAWN, collectedAt: "yesterday afternoon" } },
    PROFILE
  );
  assert.equal(out.built, false);
  if (out.built) return;
  assert.ok(out.missing.some((m) => /is not a time/.test(m)));
});

test("a specimen with no type is refused", () => {
  const out = buildOml(order(), patient(), { ...CTX, specimen: { ...DRAWN, type: "  " } }, PROFILE);
  assert.equal(out.built, false);
  if (out.built) return;
  assert.ok(out.missing.includes("specimen.type"));
});

test("a specimen collected before the order was entered is fine", () => {
  // Retrospective entry is ordinary: the tube is drawn, then somebody types
  // the order. Refusing it would reject correct practice.
  const out = buildOml(
    order(),
    patient(),
    { ...CTX, specimen: { ...DRAWN, collectedAt: "2026-08-27T09:00:00.000Z" } },
    PROFILE
  );
  assert.equal(out.built, true);
  if (!out.built) return;
  assert.equal(getHl7(parseHl7(out.message), "SPM-17"), "20260827090000-0600");
});

test("the optional parts stay out when they are not known", () => {
  // A tube with no barcode and a draw with no recorded site are both real. An
  // empty field asserting "no site" is a different claim from not saying.
  const out = buildOml(
    order(),
    patient(),
    { ...CTX, specimen: { type: "UR", collectedAt: "2026-08-27T14:05:00.000Z" } },
    PROFILE
  );
  assert.equal(out.built, true);
  if (!out.built) return;
  const spm = out.message.split("\r").find((l) => l.startsWith("SPM"))!.split("|");
  assert.equal(spm[2] ?? "", "", "no tube id claimed");
  assert.equal(spm[8] ?? "", "", "no source site claimed");
  assert.equal(spm[4], "UR^", "the type is still there");
});

test("the specimen sits between the order and its answers, where a laboratory reads it", () => {
  const withAoe: LabProfile = {
    ...PROFILE,
    askAtOrderEntry: { "4049-3": [{ code: "1558-6", text: "Dose given at", required: true }] },
  };
  const out = buildOml(
    order(),
    patient(),
    { ...CTX, specimen: DRAWN, aoeAnswers: { "1558-6": "20260827T1200" } },
    withAoe
  );
  assert.equal(out.built, true);
  if (!out.built) return;
  const kinds = out.message.split("\r").filter(Boolean).map((l) => l.slice(0, 3));
  assert.deepEqual(kinds, ["MSH", "PID", "ORC", "OBR", "SPM", "OBX"]);
});

test("a missing specimen field is listed with everything else that is missing", () => {
  const out = buildOml(
    order(),
    { ...patient(), birthDate: null },
    { ...CTX, specimen: { ...DRAWN, type: "" } },
    PROFILE
  );
  assert.equal(out.built, false);
  if (out.built) return;
  assert.ok(out.missing.includes("patient.birthDate"));
  assert.ok(out.missing.includes("specimen.type"));
});
