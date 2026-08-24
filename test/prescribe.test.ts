/**
 * A prescription that goes nowhere.
 *
 * It was recorded carefully and then nothing carried it: the clinician printed
 * it or read it down the phone, the pharmacy wrote it again at their end, and
 * two records of one decision drifted apart from the moment they were made.
 *
 * The tests that matter here are the refusals. Transmitting twice is a double
 * dispense. A prescription that is neither transmitted nor deliberately
 * printed is one the patient discovers at the counter. A cancellation the
 * pharmacy never heard leaves a stopped drug still standing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../src/db.ts";
import { MedicationStore } from "../src/meds/store.ts";
import { Directory } from "../src/directory/store.ts";
import { Prescribing, type PharmacyDispatcher, type PrescriptionPayload } from "../src/meds/prescribe.ts";
import { Refusal } from "../src/core/refusal.ts";

const P = "NT123456";
const GP = { actorId: "dr-tetso", actorKind: "practitioner" };

/** A pharmacy that receives everything, and remembers what it got. */
function goodPharmacy(): PharmacyDispatcher & { sent: PrescriptionPayload[] } {
  const sent: PrescriptionPayload[] = [];
  return {
    sent,
    dispatch(payload) {
      sent.push(payload);
      return `msg-${sent.length}`;
    },
  };
}

/** A pharmacy channel that is not there. */
const brokenPharmacy: PharmacyDispatcher = {
  dispatch() {
    throw new Error("no channel 'pharmacy' to transmit the prescription to");
  },
};

function clinic(opts: { dispatcher?: PharmacyDispatcher; controlledAuthority?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "portage-rx-"));
  const db = new Db(join(dir, "portage.db"));
  const meds = new MedicationStore(db, { check: () => [] });
  new Directory(db).addOrganization({ id: "yk-pharmacy", name: "Yellowknife Pharmacy" });
  const statement = meds.record({
    patientId: P,
    code: "860975",
    display: "Metformin 500mg tablet",
    ingredient: "metformin",
    dose: "500 mg",
    route: "oral",
    frequency: "twice daily",
    source: "prescribed",
    adherence: "taking",
    by: GP,
  });
  return {
    db,
    meds,
    statement,
    rx: new Prescribing(db, meds, {
      ...(opts.dispatcher ? { dispatcher: opts.dispatcher } : {}),
      ...(opts.controlledAuthority ? { controlledSubstanceAuthority: opts.controlledAuthority } : {}),
    }),
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("a prescription reaches a pharmacy and waits to be acknowledged", () => {
  const pharmacy = goodPharmacy();
  const w = clinic({ dispatcher: pharmacy });
  try {
    const rx = w.rx.write({
      statementId: w.statement.id,
      instructions: "One tablet twice daily with food",
      by: GP,
    });
    assert.equal(rx.status, "draft");

    const sent = w.rx.transmit(rx.id, "yk-pharmacy", GP);
    assert.equal(sent.status, "transmitted");
    assert.equal(sent.pharmacy_id, "yk-pharmacy");
    assert.equal(sent.message_id, "msg-1");
    assert.ok(sent.ack_due_by, "somebody now owes us confirmation it arrived");

    // The payload carries the drug from the statement, not a restatement of it.
    assert.equal(pharmacy.sent[0].medication.display, "Metformin 500mg tablet");
    assert.equal(pharmacy.sent[0].medication.dose, "500 mg");
    assert.equal(pharmacy.sent[0].instructions, "One tablet twice daily with food");
    assert.equal(pharmacy.sent[0].replaces, null);

    // Sent is not received, until it is.
    assert.equal(w.rx.awaitingAcknowledgement(new Date(Date.now() + 5 * 3_600_000).toISOString()).length, 1);
    const acked = w.rx.acknowledge(rx.id, { ...GP, detail: "pharmacy queue reference 8812" });
    assert.equal(acked.status, "acknowledged");
    assert.equal(w.rx.awaitingAcknowledgement(new Date(Date.now() + 5 * 3_600_000).toISOString()).length, 0);
    assert.deepEqual(
      w.rx.history(rx.id).map((e) => e.event),
      ["written", "transmitted", "acknowledged"]
    );
  } finally {
    w.cleanup();
  }
});

test("transmitting the same prescription twice is refused, because a pharmacy may dispense twice", () => {
  // The dangerous retry, and the reason `replaceFailed` exists.
  const pharmacy = goodPharmacy();
  const w = clinic({ dispatcher: pharmacy });
  try {
    const rx = w.rx.write({ statementId: w.statement.id, instructions: "One twice daily", by: GP });
    w.rx.transmit(rx.id, "yk-pharmacy", GP);
    assert.throws(
      () => w.rx.transmit(rx.id, "yk-pharmacy", GP),
      (err: unknown) => err instanceof Refusal && /may dispense it twice/.test((err as Error).message)
    );
    assert.equal(pharmacy.sent.length, 1, "and nothing went out a second time");

    w.rx.acknowledge(rx.id, GP);
    assert.throws(() => w.rx.transmit(rx.id, "yk-pharmacy", GP), Refusal);
    assert.equal(pharmacy.sent.length, 1);
  } finally {
    w.cleanup();
  }
});

test("a failed transmission is failed, not left looking like a draft", () => {
  // A draft reads as "nobody has got to it yet". This was attempted and did
  // not happen, and somebody has to act on it.
  const w = clinic({ dispatcher: brokenPharmacy });
  try {
    const rx = w.rx.write({ statementId: w.statement.id, instructions: "One twice daily", by: GP });
    const attempted = w.rx.transmit(rx.id, "yk-pharmacy", GP);
    assert.equal(attempted.status, "failed");
    assert.match(attempted.failure_reason ?? "", /no channel 'pharmacy'/);
    assert.equal(w.rx.failed().length, 1);
    assert.equal(w.rx.neverSent().length, 0, "it is not a draft");
    assert.ok(w.rx.history(rx.id).some((e) => e.event === "transmission-failed"));
  } finally {
    w.cleanup();
  }
});

test("a failed prescription is replaced by a new one that names what it replaces", () => {
  // So a pharmacy receiving both can tell they are one decision, and a
  // reviewer can see a retry happened rather than finding two prescriptions
  // and wondering whether the patient got two lots of the drug.
  const pharmacy = goodPharmacy();
  const w = clinic({ dispatcher: pharmacy });
  try {
    const rx = w.rx.write({ statementId: w.statement.id, instructions: "One twice daily", by: GP });
    w.rx.transmit(rx.id, "yk-pharmacy", GP);
    w.rx.fail(rx.id, { ...GP, reason: "pharmacy rejected: patient not known to them" });

    assert.throws(() => w.rx.replaceFailed(rx.id, { ...GP, reason: "" }), /needs a reason/);
    const replacement = w.rx.replaceFailed(rx.id, { ...GP, reason: "sending to the patient's usual pharmacy" });
    assert.equal(replacement.replaces, rx.id);
    assert.equal(replacement.status, "draft");
    assert.equal(replacement.instructions, "One twice daily", "the same decision, not a re-typed one");

    // Replacing twice would recreate the duplicate this exists to prevent.
    assert.throws(
      () => w.rx.replaceFailed(rx.id, { ...GP, reason: "again" }),
      (err: unknown) => err instanceof Refusal && /already been replaced/.test((err as Error).message)
    );
    assert.equal(w.rx.failed().length, 0, "the failure is answered, so it is off the chase list");

    const sent = w.rx.transmit(replacement.id, "yk-pharmacy", GP);
    assert.equal(sent.status, "transmitted");
    assert.equal(pharmacy.sent.at(-1)!.replaces, rx.id, "the pharmacy is told this replaces the earlier one");
  } finally {
    w.cleanup();
  }
});

test("with no pharmacy channel a prescription cannot be transmitted, and must be recorded as printed", () => {
  // The honest refusal. A deployment with no pharmacy interface is the
  // ordinary case, and a prescription that silently looked sent would be the
  // failure this module exists to remove.
  const w = clinic();
  try {
    const rx = w.rx.write({ statementId: w.statement.id, instructions: "One twice daily", by: GP });
    assert.throws(
      () => w.rx.transmit(rx.id, "yk-pharmacy", GP),
      (err: unknown) => err instanceof Refusal && /no pharmacy channel is configured/.test((err as Error).message)
    );
    assert.equal(w.rx.get(rx.id)!.status, "draft");

    const printed = w.rx.handOut(rx.id, { ...GP, reason: "printed and given to the patient" });
    assert.equal(printed.status, "handed-out");
    assert.equal(w.rx.neverSent().length, 0, "nobody is waiting for this one");
    assert.equal(w.rx.awaitingAcknowledgement().length, 0);
  } finally {
    w.cleanup();
  }
});

test("a prescription written and never sent anywhere is a list, not a silence", () => {
  // The one the patient discovers at the counter.
  const w = clinic({ dispatcher: goodPharmacy() });
  try {
    const rx = w.rx.write({ statementId: w.statement.id, instructions: "One twice daily", by: GP });
    const later = new Date(Date.now() + 3_600_000).toISOString();
    assert.deepEqual(w.rx.neverSent(later).map((r) => r.id), [rx.id]);

    w.rx.transmit(rx.id, "yk-pharmacy", GP);
    assert.equal(w.rx.neverSent(later).length, 0);
  } finally {
    w.cleanup();
  }
});

test("a controlled substance is not transmitted unless the deployment declares its authority", () => {
  // Narcotic e-prescribing is separately regulated. Transmitting one because
  // it was technically possible would put a deployment in breach without
  // telling it.
  const pharmacy = goodPharmacy();
  const w = clinic({ dispatcher: pharmacy });
  try {
    const rx = w.rx.write({
      statementId: w.statement.id,
      instructions: "One tablet at night",
      controlled: true,
      by: GP,
    });
    assert.equal(rx.controlled, 1);
    assert.throws(
      () => w.rx.transmit(rx.id, "yk-pharmacy", GP),
      (err: unknown) => err instanceof Refusal && /separately regulated/.test((err as Error).message)
    );
    assert.equal(pharmacy.sent.length, 0);
    // And the refusal names the way through, which is a real workflow.
    assert.equal(w.rx.handOut(rx.id, GP).status, "handed-out");
  } finally {
    w.cleanup();
  }
});

test("a declared controlled-substance authority permits transmission and is on the record", () => {
  const pharmacy = goodPharmacy();
  const w = clinic({ dispatcher: pharmacy, controlledAuthority: "NWT narcotic e-prescribing pilot 2026" });
  try {
    const rx = w.rx.write({
      statementId: w.statement.id,
      instructions: "One tablet at night",
      controlled: true,
      by: GP,
    });
    assert.equal(w.rx.transmit(rx.id, "yk-pharmacy", GP).status, "transmitted");
    assert.equal(pharmacy.sent[0].controlled, true, "the pharmacy is told what it is");
  } finally {
    w.cleanup();
  }
});

test("a prescription cannot be sent to a pharmacy nobody registered", () => {
  // A prescription sent to a typo is one nobody receives, and the patient
  // finds out at the counter.
  const w = clinic({ dispatcher: goodPharmacy() });
  try {
    const rx = w.rx.write({ statementId: w.statement.id, instructions: "One twice daily", by: GP });
    assert.throws(() => w.rx.transmit(rx.id, "not-a-pharmacy", GP), Refusal);
    assert.equal(w.rx.get(rx.id)!.status, "draft");
  } finally {
    w.cleanup();
  }
});

test("only a prescribed statement can become a prescription", () => {
  // A patient-reported drug is not a prescription, and transmitting one would
  // be this system inventing a prescriber's decision.
  const w = clinic({ dispatcher: goodPharmacy() });
  try {
    const reported = w.meds.record({
      patientId: P,
      code: "1191",
      display: "Aspirin 81mg",
      ingredient: "aspirin",
      source: "patient-reported",
      by: GP,
    });
    assert.throws(
      () => w.rx.write({ statementId: reported.id, instructions: "One daily", by: GP }),
      (err: unknown) => err instanceof Refusal && /not prescribed/.test((err as Error).message)
    );
    assert.throws(() => w.rx.write({ statementId: "nope", instructions: "One daily", by: GP }), Refusal);
    assert.throws(() => w.rx.write({ statementId: w.statement.id, instructions: "  ", by: GP }), Refusal);
  } finally {
    w.cleanup();
  }
});

test("cancelling a transmitted prescription owes the pharmacy a message until somebody confirms it", () => {
  // The most dangerous list in this module. The chart says stopped, the
  // pharmacy's screen says dispense, and the patient is the one who finds out.
  const w = clinic({ dispatcher: goodPharmacy() });
  try {
    const rx = w.rx.write({ statementId: w.statement.id, instructions: "One twice daily", by: GP });
    w.rx.transmit(rx.id, "yk-pharmacy", GP);

    assert.throws(() => w.rx.cancel(rx.id, { ...GP, reason: "" }), /needs a reason/);
    const cancelled = w.rx.cancel(rx.id, { ...GP, reason: "started on insulin instead" });
    assert.equal(cancelled.status, "cancelled");
    assert.deepEqual(w.rx.cancellationsOwed().map((r) => r.id), [rx.id]);

    assert.throws(() => w.rx.confirmCancellation(rx.id, { ...GP, detail: "  " }), /how the pharmacy was told/);
    w.rx.confirmCancellation(rx.id, { ...GP, detail: "telephoned the pharmacist, who withdrew it" });
    assert.equal(w.rx.cancellationsOwed().length, 0);
    assert.throws(() => w.rx.cancel(rx.id, { ...GP, reason: "again" }), Refusal);
  } finally {
    w.cleanup();
  }
});

test("cancelling a prescription that never left does not owe the pharmacy anything", () => {
  const w = clinic({ dispatcher: goodPharmacy() });
  try {
    const rx = w.rx.write({ statementId: w.statement.id, instructions: "One twice daily", by: GP });
    w.rx.cancel(rx.id, { ...GP, reason: "changed my mind before sending" });
    assert.equal(w.rx.cancellationsOwed().length, 0, "there is nobody to tell");
  } finally {
    w.cleanup();
  }
});

test("prescriptions are confined to their tenant", () => {
  const dir = mkdtempSync(join(tmpdir(), "portage-rx-iso-"));
  const root = new Db(join(dir, "portage.db"));
  try {
    root.createTenant("north", "Northern Health");
    root.createTenant("south", "Southern Health");

    const build = (t: string) => {
      const db = root.forTenant(t);
      const meds = new MedicationStore(db, { check: () => [] });
      new Directory(db).addOrganization({ id: "yk-pharmacy", name: "Yellowknife Pharmacy" });
      return { meds, rx: new Prescribing(db, meds, { dispatcher: goodPharmacy() }) };
    };
    const north = build("north");
    const south = build("south");

    const statement = north.meds.record({
      patientId: P,
      code: "860975",
      display: "Metformin 500mg",
      ingredient: "metformin",
      source: "prescribed",
      by: GP,
    });
    const rx = north.rx.write({ statementId: statement.id, instructions: "One twice daily", by: GP });
    north.rx.transmit(rx.id, "yk-pharmacy", GP);

    assert.equal(north.rx.forPatient(P).length, 1);
    assert.equal(south.rx.forPatient(P).length, 0);
    assert.equal(south.rx.get(rx.id), undefined);
    assert.equal(south.rx.neverSent().length, 0);
    assert.equal(south.rx.awaitingAcknowledgement(new Date(Date.now() + 5 * 3_600_000).toISOString()).length, 0);
    // And another custodian cannot act on it.
    assert.throws(() => south.rx.acknowledge(rx.id, GP), Refusal);
  } finally {
    root.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
