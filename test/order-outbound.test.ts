/**
 * The order message, and the failure that is not a rejection.
 *
 * An OML that is missing a field gets rejected, and a rejection is a good
 * outcome: somebody sees it and fixes it. The failure worth building around is
 * the other one — a message that is *plausible* but wrong. A guessed patient
 * identifier is not refused by a laboratory; it is accepted, matched, and the
 * specimen is drawn against somebody else's chart. Nothing errors, and the
 * first sign is a result on the wrong record.
 *
 * So these tests are mostly about what does not get built.
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

function patient(over: Partial<PatientSummary> = {}): PatientSummary {
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
    ...over,
  };
}

function order(over: Partial<OrderRow> = {}): OrderRow {
  return {
    tenant_id: "default",
    id: "ord-7",
    patient_id: "NT123456",
    encounter_id: null,
    category: "lab",
    code: "2823-3",
    code_system: "LN",
    display: "Potassium",
    status: "placed",
    priority: "routine",
    indication: "On spironolactone",
    ordered_by: "dr-tetso",
    ordered_at: "2026-08-27T15:00:00.000Z",
    responsible_id: "dr-tetso",
    expected_by: null,
    correlation_id: "corr-7",
    filler_order_number: null,
    created_at: "2026-08-27T15:00:00.000Z",
    updated_at: "2026-08-27T15:00:00.000Z",
    closed_at: null,
    ...over,
  };
}

test("a complete order builds, and reads back as a laboratory would read it", () => {
  // Parsed with the same parser the inbound side uses, so this is not
  // asserting on a string it just formatted — it is asserting that the fields
  // land where somebody else's engine will look for them.
  const out = buildOml(order(), patient(), CTX, PROFILE);
  assert.equal(out.built, true);
  if (!out.built) return;

  const msg = parseHl7(out.message);
  assert.equal(getHl7(msg, "MSH-9"), "OML^O21^OML_O21");
  assert.equal(getHl7(msg, "MSH-3"), "NORTHSTAR");
  assert.equal(getHl7(msg, "MSH-5"), "LABAPP");
  assert.equal(getHl7(msg, "PID-3.1"), "NT123456");
  assert.equal(getHl7(msg, "PID-3.4"), "JHN", "the authority travels with the identifier, never bare");
  assert.equal(getHl7(msg, "PID-5.1"), "Beaulieu");
  assert.equal(getHl7(msg, "PID-7"), "19840317");
  assert.equal(getHl7(msg, "ORC-1"), "NW");
  assert.equal(getHl7(msg, "ORC-2.1"), "ord-7", "our requisition number, and how the result comes home");
  assert.equal(getHl7(msg, "OBR-4.1"), "2823-3");
  assert.equal(out.placerOrderNumber, "ord-7");
  assert.deepEqual(out.identifier, { authority: "JHN", value: "NT123456" });
});

test("timestamps carry the declared offset, not this machine's idea of local", () => {
  // A collection time an hour out is on the wrong side of a shift change, and
  // a fasting glucose an hour early is a different test.
  const out = buildOml(order(), patient(), CTX, PROFILE);
  assert.equal(out.built, true);
  if (!out.built) return;
  assert.match(getHl7(parseHl7(out.message), "MSH-7"), /^20260827153000-0600$/);
});

test("without a declared assigning authority, nothing is built", () => {
  // The refusal that matters most. Inbound, guessing the wrong identifier
  // finds nobody; outbound, it creates a record against somebody real.
  const out = buildOml(order(), patient(), CTX, { id: "x", name: "X" });
  assert.equal(out.built, false);
  if (out.built) return;
  assert.ok(out.missing.includes("profile.patientAssigningAuthority"));
  assert.match(out.reason, /accepted and matched to somebody/);
});

test("a patient with identifiers but none under that authority is refused", () => {
  // The ordinary case: a chart carrying a local MRN and no health number. The
  // tempting fallback is to send the MRN, which the laboratory files under
  // their own numbering and nobody can reconcile afterwards.
  const out = buildOml(
    order(),
    patient({ identifiers: [{ system: "LOCAL-MRN", value: "88213" }] }),
    CTX,
    PROFILE
  );
  assert.equal(out.built, false);
  if (out.built) return;
  assert.ok(out.missing.some((m) => /identifier under JHN/.test(m)));
});

test("a missing birth date stops the message, because it is what the lab verifies against", () => {
  const out = buildOml(order(), patient({ birthDate: null }), CTX, PROFILE);
  assert.equal(out.built, false);
  if (out.built) return;
  assert.ok(out.missing.includes("patient.birthDate"));
});

test("a missing or malformed timezone stops the message", () => {
  for (const offset of ["", "MST", "-6"]) {
    const out = buildOml(order(), patient(), { ...CTX, timezoneOffset: offset }, PROFILE);
    assert.equal(out.built, false, `${offset || "(empty)"} should not build`);
    if (!out.built) assert.ok(out.missing.includes("timezoneOffset"));
  }
});

test("a draft is not sent, because a draft is a clinician thinking", () => {
  const out = buildOml(order({ status: "draft" }), patient(), CTX, PROFILE);
  assert.equal(out.built, false);
  if (out.built) return;
  assert.match(out.reason, /books a collection for a test nobody has ordered/);
});

test("a cancelled order is not sent", () => {
  const out = buildOml(order({ status: "cancelled" }), patient(), CTX, PROFILE);
  assert.equal(out.built, false);
  if (out.built) return;
  assert.match(out.reason, /specimen nobody wants taken/);
});

test("every missing field is reported at once, not the first one found", () => {
  // An integration analyst commissioning an interface wants one list, not five
  // round trips a day apart.
  const out = buildOml(
    order(),
    patient({ birthDate: null, family: null, identifiers: [] }),
    { ...CTX, timezoneOffset: "", orderingProvider: { id: "", family: "" } },
    PROFILE
  );
  assert.equal(out.built, false);
  if (out.built) return;
  for (const field of [
    "timezoneOffset",
    "patient.birthDate",
    "patient.family",
    "orderingProvider.id",
    "orderingProvider.family",
  ]) {
    assert.ok(out.missing.includes(field), `${field} should be listed`);
  }
});

test("a name carrying delimiters does not break the message", () => {
  // Escaping is not cosmetic here: an unescaped separator shifts every field
  // after it, so a name becomes a birth date and the laboratory files a
  // requisition it can parse and that is wrong throughout.
  const out = buildOml(order(), patient({ family: "O|Brien^Smith", given: "A&B" }), CTX, PROFILE);
  assert.equal(out.built, true);
  if (!out.built) return;
  const msg = parseHl7(out.message);
  assert.equal(getHl7(msg, "PID-5.1"), "O|Brien^Smith", "round-trips through the escape");
  assert.equal(getHl7(msg, "PID-7"), "19840317", "and the fields after it are still where they belong");
});

test("stat is sent as stat", () => {
  // The one priority that must never be quietly downgraded.
  const out = buildOml(order({ priority: "stat" }), patient(), CTX, PROFILE);
  assert.equal(out.built, true);
  if (!out.built) return;
  assert.equal(getHl7(parseHl7(out.message), "OBR-5"), "S");

  const urgent = buildOml(order({ priority: "urgent" }), patient(), CTX, PROFILE);
  assert.equal(urgent.built && getHl7(parseHl7(urgent.message), "OBR-5"), "A");
});

test("every field is in the field a laboratory reads it from", () => {
  // The first draft of the builder put the indication in OBR-14 (Specimen
  // Received Date/Time) and the ordering provider in OBR-17 (Callback Phone),
  // because both segments were positional arrays and a run of empty strings
  // is uncountable by eye. Neither is a message that fails: the laboratory
  // parses it and files clinical information as a timestamp.
  //
  // These are the placements, by number, so they can be checked against a
  // specification rather than against a memory of one.
  const out = buildOml(order(), patient(), CTX, PROFILE);
  assert.equal(out.built, true);
  if (!out.built) return;
  const m = parseHl7(out.message);

  assert.equal(getHl7(m, "OBR-2"), "ord-7", "OBR-2 placer order number");
  assert.equal(getHl7(m, "OBR-4.1"), "2823-3", "OBR-4 universal service identifier");
  assert.equal(getHl7(m, "OBR-6"), "20260827150000-0600", "OBR-6 requested date/time");
  assert.equal(getHl7(m, "OBR-13"), "On spironolactone", "OBR-13 relevant clinical information");
  assert.equal(getHl7(m, "OBR-16.1"), "1234", "OBR-16 ordering provider");
  assert.equal(getHl7(m, "ORC-9"), "20260827150000-0600", "ORC-9 date/time of transaction");
  assert.equal(getHl7(m, "ORC-12.1"), "1234", "ORC-12 ordering provider");

  // OBR-7 is when the specimen was observed. For an order it has not been
  // collected, and filling it would assert a collection that never happened.
  assert.equal(getHl7(m, "OBR-7"), "", "OBR-7 stays empty until there is a specimen");
  assert.equal(getHl7(m, "OBR-14"), "", "and nothing has been received");
});

test("two orders never share a control id by accident", () => {
  const a = buildOml(order(), patient(), { ...CTX, controlId: undefined }, PROFILE);
  const b = buildOml(order({ id: "ord-8" }), patient(), { ...CTX, controlId: undefined }, PROFILE);
  assert.equal(a.built && b.built, true);
  if (!a.built || !b.built) return;
  assert.notEqual(a.controlId, b.controlId);
});
