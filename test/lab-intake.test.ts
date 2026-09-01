/**
 * A laboratory interface, as distinct from a mapping.
 *
 * There was already a channel turning ORU messages into FHIR Observations, and
 * it was easy to mistake for a laboratory interface. It stored a copy of a
 * value. It did not close the order the result answered, did not start an
 * acknowledgement clock, and had no idea that tonight's retransmission was the
 * same potassium it filed this morning.
 *
 * The load-bearing tests here are the two that refuse: an identical resend
 * writes nothing, and a result whose patient cannot be identified is held
 * rather than filed against a guess. Both are cases where doing something
 * helpful is the harm.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../src/db.ts";
import { ClinicalRecord } from "../src/clinical/record.ts";
import { OrderStore } from "../src/orders/store.ts";
import { LabIntake } from "../src/orders/intake.ts";
import { hl7Instant, parseOru, type LabProfile } from "../src/orders/hl7.ts";
import { Refusal } from "../src/core/refusal.ts";

const P = "NT123456";
const GP = { actorId: "dr-tetso", actorKind: "practitioner" };
const FEED = { authorId: "adt-feed", authorKind: "device" };

const PROFILE: LabProfile = {
  id: "test-lab",
  name: "Test laboratory",
  patientAssigningAuthority: "JHN",
  placerOrderPaths: ["ORC-2.1", "OBR-2.1"],
  fillerOrderPaths: ["ORC-3.1", "OBR-3.1"],
  timezoneOffset: "-05:00",
};

function lab() {
  const dir = mkdtempSync(join(tmpdir(), "northstar-lab-"));
  const db = new Db(join(dir, "northstar.db"));
  const record = new ClinicalRecord(db);
  const orders = new OrderStore(db);
  record.record({
    entryType: "Patient",
    patientId: P,
    content: {
      resourceType: "Patient",
      identifier: [{ system: "urn:jhn", value: P }],
      name: [{ family: "Beaulieu", given: ["Marie"], use: "official" }],
      birthDate: "1984-03-17",
    },
    ...FEED,
  });
  return {
    db,
    record,
    orders,
    intake: new LabIntake(db, orders, record.patientIndex),
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}

/**
 * One ORU. Defaults are a normal potassium; every field a test needs to vary
 * is an option, so each case reads as the one thing it is about.
 */
function oru(
  opts: {
    placer?: string;
    filler?: string;
    identifier?: string;
    authority?: string;
    value?: string;
    flag?: string;
    status?: string;
    subId?: string;
    controlId?: string;
    observedAt?: string;
    code?: string;
    note?: string;
  } = {}
): string {
  const {
    placer = "",
    filler = "ACC-1001",
    identifier = P,
    authority = "JHN",
    value = "4.1",
    flag = "N",
    status = "F",
    subId = "1",
    controlId = "MSG-1",
    observedAt = "20260824103000",
    code = "2823-3",
    note,
  } = opts;
  const lines = [
    `MSH|^~\\&|LABAPP|STANTON|PORTAGE|GNWT|20260824104500||ORU^R01|${controlId}|P|2.5.1`,
    `PID|1||${identifier}^^^${authority}^MR||Beaulieu^Marie||19840317|F`,
    `ORC|RE|${placer}|${filler}`,
    `OBR|1|${placer}|${filler}|CHEM^Chemistry panel|||${observedAt}|||||||||||||||20260824104000|||F`,
    `OBX|1|NM|${code}^Potassium^LN|${subId}|${value}|mmol/L|3.5-5.1|${flag}|||${status}|||${observedAt}`,
  ];
  if (note) lines.push(`NTE|1|L|${note}`);
  return lines.join("\r");
}

function placedOrder(orders: OrderStore, code = "2823-3", display = "Potassium") {
  const o = orders.create({
    patientId: P,
    category: "lab",
    code,
    display,
    indication: "Electrolyte check",
    by: GP,
  });
  orders.place(o.id, { ...GP, responsibleId: "dr-tetso", expectedBy: "2026-08-24T00:00:00Z" });
  return o;
}

test("a result closes the order it answers and starts an acknowledgement clock", () => {
  // What a FHIR mapping does not do. Before this the order stayed on the
  // overdue list forever while the value sat on the facade.
  const w = lab();
  try {
    const order = placedOrder(w.orders);
    assert.equal(w.orders.awaitingResult("2026-08-25T00:00:00Z").length, 1, "placed and unanswered");

    const report = w.intake.ingest(oru({ placer: order.id }), { profile: PROFILE, sourceMessageId: "msg-1" });
    assert.equal(report.patientId, P);
    assert.deepEqual(report.results.map((r) => r.outcome), ["filed"]);

    assert.equal(w.orders.get(order.id)!.status, "completed", "the order is answered");
    assert.equal(w.orders.awaitingResult("2026-08-25T00:00:00Z").length, 0);

    const filed = w.orders.resultsFor(order.id)[0];
    assert.equal(filed.value, "4.1");
    assert.equal(filed.unit, "mmol/L");
    assert.equal(filed.reference_range, "3.5-5.1");
    assert.equal(filed.result_status, "final");
    assert.equal(filed.source_message_id, "msg-1");
    assert.equal(filed.filler_order_number, "ACC-1001");
    assert.equal(filed.source_system, "test-lab");
    assert.ok(filed.ack_due_by, "somebody now owes a read of it");
    assert.equal(w.orders.get(order.id)!.filler_order_number, "ACC-1001", "the accession is on the order for reconciliation");
  } finally {
    w.cleanup();
  }
});

test("an identical retransmission writes nothing", () => {
  // The load-bearing test. Laboratories resend on reconnect and on a nightly
  // repeat. Filing each copy again fills the unacknowledged queue with
  // duplicates of a value somebody already read, and a queue that cannot be
  // emptied is one clinicians stop reading.
  const w = lab();
  try {
    const order = placedOrder(w.orders);
    w.intake.ingest(oru({ placer: order.id }), { profile: PROFILE });

    const again = w.intake.ingest(oru({ placer: order.id, controlId: "MSG-1-REPEAT" }), { profile: PROFILE });
    assert.deepEqual(again.results.map((r) => r.outcome), ["unchanged"]);
    assert.equal(w.orders.resultsFor(order.id).length, 1, "one result, not two");
    assert.equal(w.orders.unacknowledged().length, 1);

    // And it stays a no-op however many times the laboratory repeats itself.
    w.intake.ingest(oru({ placer: order.id }), { profile: PROFILE });
    w.intake.ingest(oru({ placer: order.id }), { profile: PROFILE });
    assert.equal(w.orders.resultsFor(order.id).length, 1);
  } finally {
    w.cleanup();
  }
});

test("a corrected value supersedes and arrives unacknowledged, even after sign-off", () => {
  // The hazard the whole orders module was built around, now reachable through
  // the interface rather than only through the library.
  const w = lab();
  try {
    const order = placedOrder(w.orders);
    w.intake.ingest(oru({ placer: order.id, value: "4.1", flag: "N" }), { profile: PROFILE });
    const first = w.orders.resultsFor(order.id)[0];
    w.orders.acknowledge(first.id, { ...GP, action: "normal, no action needed" });

    const corrected = w.intake.ingest(
      oru({ placer: order.id, value: "7.1", flag: "HH", status: "C", controlId: "MSG-2" }),
      { profile: PROFILE }
    );
    assert.deepEqual(corrected.results.map((r) => r.outcome), ["corrected"]);
    assert.match(corrected.results[0].detail, /4\.1 → 7\.1/);

    const outstanding = w.orders.unacknowledged();
    assert.equal(outstanding.length, 1, "the correction is owed to somebody");
    assert.equal(outstanding[0].value, "7.1");
    assert.equal(outstanding[0].abnormal_flag, "critical-high");
    assert.equal(outstanding[0].acknowledged_at, null, "the old sign-off did not follow the new value");
    assert.equal(w.orders.result(first.id)!.acknowledged_at !== null, true, "and the old row keeps its own");
    assert.equal(w.orders.resultHistory(outstanding[0].id).length, 2);
  } finally {
    w.cleanup();
  }
});

test("a preliminary arriving after the final is ignored, and says so", () => {
  // Out-of-order delivery is ordinary. Applying it would un-answer an order
  // and reopen a closed question; dropping it silently would hide that the
  // feed is delivering out of order.
  const w = lab();
  try {
    const order = placedOrder(w.orders);
    w.intake.ingest(oru({ placer: order.id, value: "4.1", status: "F" }), { profile: PROFILE });

    const stale = w.intake.ingest(
      oru({ placer: order.id, value: "pending", status: "P", controlId: "MSG-LATE" }),
      { profile: PROFILE }
    );
    assert.deepEqual(stale.results.map((r) => r.outcome), ["ignored-stale"]);
    assert.match(stale.results[0].detail, /kept the final/);
    assert.equal(w.orders.resultsFor(order.id).length, 1);
    assert.equal(w.orders.resultsFor(order.id)[0].value, "4.1");
    assert.equal(w.orders.get(order.id)!.status, "completed");
  } finally {
    w.cleanup();
  }
});

test("a preliminary followed by the final is two states of one result, not two results", () => {
  const w = lab();
  try {
    const order = placedOrder(w.orders);
    const prelim = w.intake.ingest(
      oru({ placer: order.id, value: "gram-positive cocci", status: "P", flag: "A" }),
      { profile: PROFILE }
    );
    assert.deepEqual(prelim.results.map((r) => r.outcome), ["filed"]);
    assert.equal(w.orders.get(order.id)!.status, "placed", "a preliminary does not answer the order");
    assert.equal(w.orders.resultsFor(order.id)[0].ack_due_by, null, "and starts no clock");

    const final = w.intake.ingest(
      oru({ placer: order.id, value: "Staphylococcus aureus", status: "F", flag: "A", controlId: "MSG-3" }),
      { profile: PROFILE }
    );
    assert.deepEqual(final.results.map((r) => r.outcome), ["corrected"]);
    assert.equal(w.orders.get(order.id)!.status, "completed");
    const current = w.orders.unacknowledged();
    assert.equal(current.length, 1);
    assert.equal(current[0].value, "Staphylococcus aureus");
    assert.ok(current[0].ack_due_by, "the final one is owed a read");
  } finally {
    w.cleanup();
  }
});

test("a withdrawn result is cancelled, and leaves the unacknowledged queue", () => {
  const w = lab();
  try {
    const order = placedOrder(w.orders);
    w.intake.ingest(oru({ placer: order.id }), { profile: PROFILE });
    assert.equal(w.orders.unacknowledged().length, 1);

    const cancelled = w.intake.ingest(
      oru({ placer: order.id, value: "specimen haemolysed", status: "X", controlId: "MSG-X" }),
      { profile: PROFILE }
    );
    assert.deepEqual(cancelled.results.map((r) => r.outcome), ["cancelled"]);
    assert.equal(w.orders.unacknowledged().length, 0, "nobody is owed a read of a withdrawn value");
    assert.equal(w.orders.resultHistory(cancelled.results[0].result!.id).length, 2, "and the withdrawal is on the record");
  } finally {
    w.cleanup();
  }
});

test("a result whose patient cannot be identified is held, never filed against a guess", () => {
  // The other load-bearing test. Every fallback available here — match on
  // name, on the only patient with that surname, on the most recent order — is
  // wrong in the case that matters, and wrong invisibly.
  const w = lab();
  try {
    const report = w.intake.ingest(oru({ identifier: "NT-NOBODY" }), { profile: PROFILE });
    assert.equal(report.patientId, null);
    assert.deepEqual(report.results.map((r) => r.outcome), ["held"]);

    assert.equal(w.orders.unmatched().length, 0, "nothing was filed against anybody");
    const held = w.intake.heldForIdentity();
    assert.equal(held.length, 1);
    assert.match(held[0].reason, /no chart carries NT-NOBODY/);
    assert.equal(held[0].patient_name, "Beaulieu, Marie", "what the lab thought, for a person to read");
    assert.equal(held[0].filler_order_number, "ACC-1001");

    // A matching name and birth date is on the message and was not used.
    assert.equal(w.record.chart(P).filter((e) => e.entry_type === "Observation").length, 0);
  } finally {
    w.cleanup();
  }
});

test("a held result files through the ordinary path once a person names the chart", () => {
  const w = lab();
  try {
    const order = placedOrder(w.orders);
    w.intake.ingest(oru({ placer: order.id, identifier: "NT-TYPO" }), { profile: PROFILE });
    const held = w.intake.heldForIdentity()[0];

    const resolved = w.intake.resolveIdentity(held.id, P, { actorId: "lab-clerk" });
    assert.deepEqual(resolved.results.map((r) => r.outcome), ["filed"]);
    assert.equal(w.orders.resultsFor(order.id).length, 1, "and it matched the order, like any other result");
    assert.equal(w.intake.heldForIdentity().length, 0);
    assert.equal(w.intake.hold_(held.id)!.resolved_patient_id, P);

    assert.throws(() => w.intake.resolveIdentity(held.id, P, { actorId: "lab-clerk" }), Refusal);
    assert.throws(() => w.intake.resolveIdentity("nope", P, { actorId: "lab-clerk" }), Refusal);
  } finally {
    w.cleanup();
  }
});

test("a held result cannot be filed against a chart that does not exist", () => {
  const w = lab();
  try {
    w.intake.ingest(oru({ identifier: "NT-TYPO" }), { profile: PROFILE });
    const held = w.intake.heldForIdentity()[0];
    assert.throws(
      () => w.intake.resolveIdentity(held.id, "NT-ALSO-NOBODY", { actorId: "lab-clerk" }),
      (err: unknown) => err instanceof Refusal && /no chart/.test((err as Error).message)
    );
    assert.equal(w.intake.heldForIdentity().length, 1, "and it stays held");
  } finally {
    w.cleanup();
  }
});

test("an identifier matching two charts is held rather than resolved to one of them", () => {
  // PatientIndex surfaces duplicates and refuses to merge them. Picking one
  // here would make that refusal pointless.
  const w = lab();
  try {
    w.record.record({
      entryType: "Patient",
      patientId: "NT-DUPLICATE",
      content: {
        resourceType: "Patient",
        identifier: [{ system: "urn:jhn", value: P }],
        name: [{ family: "Beaulieu", given: ["Marie"], use: "official" }],
        birthDate: "1984-03-17",
      },
      ...FEED,
    });

    const report = w.intake.ingest(oru(), { profile: PROFILE });
    assert.deepEqual(report.results.map((r) => r.outcome), ["held"]);
    assert.match(w.intake.heldForIdentity()[0].reason, /matches 2 charts/);
  } finally {
    w.cleanup();
  }
});

test("a result with no order to answer is filed and queued for matching, not dropped", () => {
  // An unsolicited result — another facility, or an order placed on paper — is
  // a real result about a real patient.
  const w = lab();
  try {
    const report = w.intake.ingest(oru({ placer: "" }), { profile: PROFILE });
    assert.deepEqual(report.results.map((r) => r.outcome), ["filed"]);
    assert.equal(report.results[0].orderId, undefined);
    assert.equal(w.orders.unmatched().length, 1);
    assert.equal(w.orders.unmatched()[0].value, "4.1");
  } finally {
    w.cleanup();
  }
});

test("the placer number never attaches a result to another patient's order", () => {
  const w = lab();
  try {
    const other = w.orders.create({
      patientId: "NT-OTHER",
      category: "lab",
      code: "2823-3",
      display: "Potassium",
      indication: "Check",
      by: GP,
    });
    w.orders.place(other.id, { ...GP, responsibleId: "dr-tetso" });

    // The message names our patient and the other patient's requisition.
    const report = w.intake.ingest(oru({ placer: other.id }), { profile: PROFILE });
    assert.deepEqual(report.results.map((r) => r.outcome), ["filed"]);
    assert.equal(report.results[0].orderId, undefined, "the order was not this patient's, so it was not used");
    assert.equal(w.orders.resultsFor(other.id).length, 0);
    assert.equal(w.orders.unmatched().length, 1);
  } finally {
    w.cleanup();
  }
});

test("two analytes on one specimen are two results, told apart by sub-id", () => {
  const w = lab();
  try {
    const order = placedOrder(w.orders);
    const raw = [
      "MSH|^~\\&|LABAPP|STANTON|PORTAGE|GNWT|20260824104500||ORU^R01|MSG-MULTI|P|2.5.1",
      `PID|1||${P}^^^JHN^MR||Beaulieu^Marie||19840317|F`,
      `ORC|RE|${order.id}|ACC-2002`,
      `OBR|1|${order.id}|ACC-2002|CHEM^Chemistry panel|||20260824103000`,
      "OBX|1|NM|2823-3^Potassium^LN|1|7.1|mmol/L|3.5-5.1|HH|||F|||20260824103000",
      "OBX|2|NM|2951-2^Sodium^LN|1|139|mmol/L|135-145|N|||F|||20260824103000",
    ].join("\r");

    const report = w.intake.ingest(raw, { profile: PROFILE });
    assert.deepEqual(report.results.map((r) => r.outcome), ["filed", "filed"]);
    assert.equal(w.orders.resultsFor(order.id).length, 2);

    // Worst first, which is the order they have to be read in.
    const queue = w.orders.unacknowledged();
    assert.equal(queue[0].value, "7.1");
    assert.equal(queue[0].abnormal_flag, "critical-high");

    // And the whole panel deduplicates as a panel.
    const again = w.intake.ingest(raw, { profile: PROFILE });
    assert.deepEqual(again.results.map((r) => r.outcome), ["unchanged", "unchanged"]);
    assert.equal(w.orders.resultsFor(order.id).length, 2);
  } finally {
    w.cleanup();
  }
});

test("an unknown result status or abnormal flag is refused, not filed as normal", () => {
  // A status this does not recognise cannot be defaulted: `final` would start a
  // clock on something unfinished, and `preliminary` would silence one that
  // was finished. A flag it does not recognise must not become "normal".
  const w = lab();
  try {
    assert.throws(
      () => w.intake.ingest(oru({ status: "Q" }), { profile: PROFILE }),
      (err: unknown) => err instanceof Refusal && /unknown OBX-11/.test((err as Error).message)
    );
    assert.throws(
      () => w.intake.ingest(oru({ flag: "ZZZ" }), { profile: PROFILE }),
      (err: unknown) => err instanceof Refusal && /unknown OBX-8/.test((err as Error).message)
    );
    assert.equal(w.orders.unmatched().length, 0, "and neither refusal filed anything");
    assert.equal(w.intake.heldForIdentity().length, 0);
  } finally {
    w.cleanup();
  }
});

test("a message that is not a result, or carries none, is refused", () => {
  const w = lab();
  try {
    const adt = [
      "MSH|^~\\&|ADT|STANTON|PORTAGE|GNWT|20260824104500||ADT^A01|MSG-ADT|P|2.5.1",
      `PID|1||${P}^^^JHN^MR||Beaulieu^Marie||19840317|F`,
    ].join("\r");
    assert.throws(() => w.intake.ingest(adt, { profile: PROFILE }), Refusal);

    const noObx = [
      "MSH|^~\\&|LABAPP|STANTON|PORTAGE|GNWT|20260824104500||ORU^R01|MSG-EMPTY|P|2.5.1",
      `PID|1||${P}^^^JHN^MR||Beaulieu^Marie||19840317|F`,
      "OBR|1||ACC-3003|CHEM^Chemistry panel",
    ].join("\r");
    assert.throws(
      () => w.intake.ingest(noObx, { profile: PROFILE }),
      (err: unknown) => err instanceof Refusal && /no OBX/.test((err as Error).message)
    );
  } finally {
    w.cleanup();
  }
});

test("a result with no order identity at all is refused rather than filed undeduplicable", () => {
  // Without an accession or a requisition number, every copy of this result
  // looks new. Filing it would mean the queue grows by one on every
  // retransmission, which is worse than saying so.
  const w = lab();
  try {
    assert.throws(
      () => w.intake.ingest(oru({ placer: "", filler: "" }), { profile: PROFILE }),
      (err: unknown) => err instanceof Refusal && /neither a filler nor a placer/.test((err as Error).message)
    );
  } finally {
    w.cleanup();
  }
});

test("the assigning authority decides which identifier is the health number", () => {
  // A laboratory that also sends its own accession number in PID-3 is the
  // ordinary case. Matching the wrong repetition finds nobody, or somebody
  // else.
  const w = lab();
  try {
    const raw = [
      "MSH|^~\\&|LABAPP|STANTON|PORTAGE|GNWT|20260824104500||ORU^R01|MSG-IDS|P|2.5.1",
      `PID|1||LAB-9999^^^LABAPP^AN~${P}^^^JHN^MR||Beaulieu^Marie||19840317|F`,
      "ORC|RE||ACC-4004",
      "OBR|1||ACC-4004|CHEM^Chemistry panel|||20260824103000",
      "OBX|1|NM|2823-3^Potassium^LN|1|4.1|mmol/L|3.5-5.1|N|||F|||20260824103000",
    ].join("\r");

    assert.equal(w.intake.ingest(raw, { profile: PROFILE }).patientId, P);

    // Told to read the laboratory's own authority instead, it finds nobody
    // rather than falling through to the identifier that would have worked.
    const wrong = w.intake.ingest(raw, {
      profile: { ...PROFILE, id: "wrong-authority", patientAssigningAuthority: "NOBODY" },
    });
    assert.equal(wrong.patientId, null);
    assert.match(w.intake.heldForIdentity()[0].reason, /assigning authority NOBODY/);
  } finally {
    w.cleanup();
  }
});

test("a timestamp with no timezone is recorded as assumed rather than silently made UTC", () => {
  // A result an hour out is a result on the wrong side of a shift change.
  assert.equal(hl7Instant("20260824103000", "-05:00").iso, "2026-08-24T15:30:00.000Z");
  assert.equal(hl7Instant("20260824103000-0500").iso, "2026-08-24T15:30:00.000Z");
  assert.equal(hl7Instant("20260824103000").assumed, true);
  assert.equal(hl7Instant("20260824103000").iso, "2026-08-24T10:30:00");
  assert.equal(hl7Instant("20260824").iso, "2026-08-24");
  assert.equal(hl7Instant("").iso, null);

  const w = lab();
  try {
    const order = placedOrder(w.orders);
    // Same profile without a declared offset.
    const naive = w.intake.ingest(oru({ placer: order.id }), {
      profile: { id: "no-zone", name: "No declared zone" },
    });
    assert.equal(naive.timezoneAssumed, true);
    assert.equal(w.orders.resultsFor(order.id)[0].timezone_assumed, 1);

    const report = w.intake.reconcile({ profileId: "no-zone" });
    assert.equal(report.timezoneAssumed, 1);
    assert.ok(
      report.caveats.some((c) => /no timezone/.test(c)),
      `the report has to say so, got ${JSON.stringify(report.caveats)}`
    );
  } finally {
    w.cleanup();
  }
});

test("notes attached to a result travel with it", () => {
  // "Sample haemolysed" changes what the number means, and dropping it leaves
  // a value that reads as trustworthy.
  const w = lab();
  try {
    const order = placedOrder(w.orders);
    w.intake.ingest(oru({ placer: order.id, note: "Specimen slightly haemolysed" }), { profile: PROFILE });
    assert.match(w.orders.resultsFor(order.id)[0].value, /haemolysed/);
  } finally {
    w.cleanup();
  }
});

test("the reconciliation report counts what was filed and says what it cannot tell you", () => {
  const w = lab();
  try {
    const order = placedOrder(w.orders);
    w.intake.ingest(oru({ placer: order.id, value: "7.1", flag: "HH" }), { profile: PROFILE });
    w.intake.ingest(oru({ placer: order.id, value: "6.8", flag: "HH", status: "C", controlId: "MSG-C" }), {
      profile: PROFILE,
    });
    w.intake.ingest(oru({ filler: "ACC-LOOSE", placer: "" }), { profile: PROFILE });
    w.intake.ingest(oru({ identifier: "NT-NOBODY", filler: "ACC-HELD" }), { profile: PROFILE });

    const report = w.intake.reconcile();
    assert.equal(report.filed, 3, "two versions of the potassium plus the unsolicited one");
    assert.equal(report.corrected, 1);
    assert.equal(report.unmatchedOrders, 1);
    assert.equal(report.heldForIdentity, 1);
    assert.equal(report.unacknowledged, 2, "the current potassium and the unsolicited result");
    assert.equal(report.criticalUnacknowledged, 1);
    assert.equal(report.accessions, 2);
    assert.ok(report.caveats.some((c) => /only the laboratory can say what it sent/.test(c)));
    assert.ok(report.caveats.some((c) => /waiting for a person/.test(c)));

    // An unacknowledged result is work owed to a clinician, not a broken
    // interface, and the report must not let those be confused.
    assert.ok(report.caveats.some((c) => /not a failed interface/.test(c)));
  } finally {
    w.cleanup();
  }
});

test("parsing keeps what the laboratory actually sent beside the mapped meaning", () => {
  const parsed = parseOru(oru({ flag: "HH", status: "C" }), PROFILE);
  assert.equal(parsed.observations[0].rawFlag, "HH");
  assert.equal(parsed.observations[0].rawStatus, "C");
  assert.equal(parsed.observations[0].abnormalFlag, "critical-high");
  assert.equal(parsed.observations[0].resultStatus, "corrected");
  assert.equal(parsed.fillerOrderNumber, "ACC-1001");
  assert.equal(parsed.panelDisplay, "Chemistry panel");
  assert.equal(parsed.sendingFacility, "STANTON");
});

test("one custodian's laboratory feed cannot reach another's charts", () => {
  const dir = mkdtempSync(join(tmpdir(), "northstar-lab-iso-"));
  const root = new Db(join(dir, "northstar.db"));
  try {
    root.createTenant("north", "Northern Health");
    root.createTenant("south", "Southern Health");

    const build = (t: string) => {
      const db = root.forTenant(t);
      const record = new ClinicalRecord(db);
      const orders = new OrderStore(db);
      return { record, orders, intake: new LabIntake(db, orders, record.patientIndex) };
    };
    const north = build("north");
    const south = build("south");

    north.record.record({
      entryType: "Patient",
      patientId: P,
      content: { resourceType: "Patient", identifier: [{ system: "urn:jhn", value: P }], name: [{ family: "Beaulieu" }] },
      ...FEED,
    });

    assert.equal(north.intake.ingest(oru(), { profile: PROFILE }).patientId, P);
    assert.equal(north.orders.unmatched().length, 1);

    // The south has no such chart, so the same message is held there rather
    // than filed against the north's patient.
    const atSouth = south.intake.ingest(oru({ controlId: "MSG-SOUTH" }), { profile: PROFILE });
    assert.equal(atSouth.patientId, null);
    assert.equal(south.orders.unmatched().length, 0);
    assert.equal(south.intake.heldForIdentity().length, 1);
    assert.equal(north.intake.heldForIdentity().length, 0);
  } finally {
    root.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
