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
import { TaskStore } from "../src/work/tasks.ts";
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

function clinic(opts: { dispatcher?: PharmacyDispatcher; controlledAuthority?: string; noTasks?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "northstar-rx-"));
  const db = new Db(join(dir, "northstar.db"));
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
  const tasks = new TaskStore(db);
  return {
    db,
    meds,
    statement,
    tasks,
    rx: new Prescribing(db, meds, {
      ...(opts.dispatcher ? { dispatcher: opts.dispatcher } : {}),
      ...(opts.controlledAuthority ? { controlledSubstanceAuthority: opts.controlledAuthority } : {}),
      ...(opts.noTasks ? {} : { tasks }),
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
  const dir = mkdtempSync(join(tmpdir(), "northstar-rx-iso-"));
  const root = new Db(join(dir, "northstar.db"));
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

// ---- what the pharmacy did with it ---------------------------------------

/** Transmits one prescription to a pharmacy and returns the workspace. */
function transmitted(opts: { reports?: boolean } = {}) {
  const pharmacy = goodPharmacy();
  const w = clinic({ dispatcher: pharmacy });
  if (opts.reports !== undefined) w.rx.declareDispenseReporting("yk-pharmacy", opts.reports, GP);
  const script = w.rx.write({ statementId: w.statement.id, instructions: "one twice daily with food", by: GP });
  w.rx.transmit(script.id, "yk-pharmacy", GP);
  return { ...w, pharmacy, script };
}

test("a prescription nobody has collected is not a prescription the patient is taking", () => {
  const w = transmitted({ reports: true });
  try {
    const before = w.rx.dispenseState(w.script.id);
    assert.equal(before.state, "awaiting", "sent to a reporting pharmacy and not yet filled");

    w.rx.recordDispense(w.script.id, { outcome: "dispensed", dispensedAt: "2026-08-20T15:00:00.000Z", by: GP, quantity: "60 tablets" });
    const after = w.rx.dispenseState(w.script.id);
    assert.equal(after.state, "dispensed");
    assert.match(after.detail, /2026-08-20/);
  } finally {
    w.cleanup();
  }
});

test("silence from a pharmacy that does not report is unknown, never 'not collected'", () => {
  // The property the whole feature rests on. A chart that renders "never
  // collected" for every prescription sent somewhere that does not send
  // notifications is making an accusation out of an absence, and a clinician
  // who learns to ignore it has lost the signal for the pharmacies that do.
  const quiet = transmitted({ reports: false });
  try {
    const state = quiet.rx.dispenseState(quiet.script.id);
    assert.equal(state.state, "unknown");
    assert.match(state.detail, /does not report dispenses/);
    assert.equal(quiet.rx.neverCollected(0).length, 0, "a silence that means nothing is not a worklist item");
  } finally {
    quiet.cleanup();
  }

  const loud = transmitted({ reports: true });
  try {
    assert.equal(loud.rx.neverCollected(0).length, 1, "a silence from somewhere that would have spoken is worth chasing");
  } finally {
    loud.cleanup();
  }
});

test("a pharmacy that reports and then does is off the list", () => {
  const w = transmitted({ reports: true });
  try {
    w.rx.recordDispense(w.script.id, { outcome: "dispensed", dispensedAt: "2026-08-20T15:00:00.000Z", by: GP });
    assert.equal(w.rx.neverCollected(0).length, 0);
  } finally {
    w.cleanup();
  }
});

test("the reporting declaration is snapshotted at transmission, not read later", () => {
  // A declaration made next year says nothing about what this prescription's
  // silence meant last week. Reading it live would rewrite history each time
  // a pharmacy's interface was switched on.
  const w = transmitted({ reports: false });
  try {
    w.rx.declareDispenseReporting("yk-pharmacy", true, GP);
    assert.equal(w.rx.dispenseState(w.script.id).state, "unknown", "this one was sent before they reported anything");
    assert.equal(w.rx.neverCollected(0).length, 0);

    const later = w.rx.write({ statementId: w.statement.id, instructions: "one twice daily", by: GP });
    w.rx.transmit(later.id, "yk-pharmacy", GP);
    assert.equal(w.rx.dispenseState(later.id).state, "awaiting", "this one was sent after");
  } finally {
    w.cleanup();
  }
});

test("a partial fill is not a full one, and the last word wins", () => {
  const w = transmitted({ reports: true });
  try {
    w.rx.recordDispense(w.script.id, { outcome: "partially-dispensed", dispensedAt: "2026-07-20T15:00:00.000Z", by: GP, quantity: "30 of 90" });
    assert.equal(w.rx.dispenseState(w.script.id).state, "partially-dispensed");
    w.rx.recordDispense(w.script.id, { outcome: "dispensed", dispensedAt: "2026-08-20T15:00:00.000Z", by: GP, quantity: "60 of 90" });
    assert.equal(w.rx.dispenseState(w.script.id).state, "dispensed", "a 90-day script filled in parts is one decision, not three");
    assert.equal(w.rx.dispenses(w.script.id).length, 2, "and every fill is kept");
  } finally {
    w.cleanup();
  }
});

test("a pharmacy reporting that it was never picked up is a fact, not a silence", () => {
  const w = transmitted({ reports: true });
  try {
    w.rx.recordDispense(w.script.id, { outcome: "not-collected", dispensedAt: "2026-08-25T15:00:00.000Z", by: GP, detail: "returned to stock" });
    const state = w.rx.dispenseState(w.script.id);
    assert.equal(state.state, "not-collected");
    assert.equal(w.rx.neverCollected(0).length, 0, "it is answered, not outstanding");
  } finally {
    w.cleanup();
  }
});

test("a dispense against a cancelled prescription is recorded and surfaced, never refused", () => {
  // The hazard cancellations are tracked for, arriving. Refusing to record it
  // would delete the only evidence that a stopped drug was handed over.
  const w = transmitted({ reports: true });
  try {
    w.rx.cancel(w.script.id, { ...GP, reason: "rash" });
    const { afterCancellation } = w.rx.recordDispense(w.script.id, {
      outcome: "dispensed",
      dispensedAt: "2026-08-21T15:00:00.000Z",
      by: GP,
    });
    assert.equal(afterCancellation, true);

    const incidents = w.rx.dispensedAfterCancellation();
    assert.equal(incidents.length, 1, "somebody has to know a stopped drug was dispensed");
    assert.equal(incidents[0].prescription.id, w.script.id);
    assert.match(w.rx.dispenseState(w.script.id).detail, /after this prescription was cancelled/);
    assert.ok(
      w.rx.history(w.script.id).some((e) => e.event === "dispensed-after-cancellation"),
      "and it is on the prescription's own history"
    );
  } finally {
    w.cleanup();
  }
});

test("a prescription that never left cannot have been dispensed", () => {
  const w = clinic({ dispatcher: goodPharmacy() });
  try {
    const rx = w.rx.write({ statementId: w.statement.id, instructions: "one twice daily", by: GP });
    assert.equal(w.rx.dispenseState(rx.id).state, "not-applicable");
    assert.throws(
      () => w.rx.recordDispense(rx.id, { outcome: "dispensed", dispensedAt: "2026-08-20T15:00:00.000Z", by: GP }),
      /has not gone anywhere/
    );
  } finally {
    w.cleanup();
  }
});

test("a prescription on paper is nobody's to report on", () => {
  const w = clinic({ dispatcher: goodPharmacy() });
  try {
    const rx = w.rx.write({ statementId: w.statement.id, instructions: "one twice daily", by: GP });
    w.rx.handOut(rx.id, { ...GP, reason: "patient going to the pharmacy themselves" });
    const state = w.rx.dispenseState(rx.id);
    assert.equal(state.state, "not-applicable");
    assert.match(state.detail, /on paper/);
  } finally {
    w.cleanup();
  }
});

// ---- renewal, and the check that travels --------------------------------

test("a pharmacy asking for a repeat becomes work somebody owns", () => {
  const w = transmitted({ reports: true });
  try {
    const task = w.rx.requestRenewal({
      prescriptionId: w.script.id,
      by: { actorId: "pharmacy-intake", actorKind: "system" },
      requestedBy: "Yellowknife Pharmacy",
      note: "patient has 3 days left",
    });
    assert.equal(task.kind, "prescription-renewal");
    assert.equal(task.patient_id, P);
    assert.match(task.title, /Metformin/);
    assert.equal(task.status, "open");
    assert.ok(w.tasks.unassigned({ kind: "prescription-renewal" }).length === 1, "it is visible from the moment it arrives");

    // The point of it being a task: it cannot be closed by being ignored.
    assert.throws(() => w.tasks.complete(task.id, { ...GP, evidence: "" }), /evidence/i);
    const done = w.tasks.complete(task.id, { ...GP, evidence: "renewed for 90 days, new script sent" });
    assert.equal(done.status, "completed");
  } finally {
    w.cleanup();
  }
});

test("repeat requests for one script are one thread, so a pattern is visible", () => {
  const w = transmitted({ reports: true });
  try {
    const by = { actorId: "pharmacy-intake", actorKind: "system" };
    w.rx.requestRenewal({ prescriptionId: w.script.id, by });
    w.rx.requestRenewal({ prescriptionId: w.script.id, by });
    w.rx.requestRenewal({ prescriptionId: w.script.id, by, priority: "urgent" });
    const thread = w.rx.renewalsFor(w.script.id);
    assert.equal(thread.length, 3, "three requests in a row is a fact about the patient, not three unrelated items");
    assert.ok(thread.some((t) => t.priority === "urgent"));
  } finally {
    w.cleanup();
  }
});

test("a renewal with no worklist to land in is refused, not dropped", () => {
  // Recording it anyway would put the request in a place nobody looks, which
  // is the fax tray this replaces.
  const pharmacy = goodPharmacy();
  const w = clinic({ dispatcher: pharmacy, noTasks: true });
  try {
    const script = w.rx.write({ statementId: w.statement.id, instructions: "one twice daily", by: GP });
    w.rx.transmit(script.id, "yk-pharmacy", GP);
    assert.throws(
      () => w.rx.requestRenewal({ prescriptionId: script.id, by: GP }),
      /nowhere to go that anybody would see/
    );
  } finally {
    w.cleanup();
  }
});

test("nobody can be asking to renew a prescription that never went out", () => {
  const w = clinic({ dispatcher: goodPharmacy() });
  try {
    const script = w.rx.write({ statementId: w.statement.id, instructions: "one twice daily", by: GP });
    assert.throws(() => w.rx.requestRenewal({ prescriptionId: script.id, by: GP }), /has not gone to a pharmacy/);
  } finally {
    w.cleanup();
  }
});

test("the safety check the prescriber saw travels with the script", () => {
  const pharmacy = goodPharmacy();
  const w = clinic({ dispatcher: pharmacy });
  try {
    const script = w.rx.write({
      statementId: w.statement.id,
      instructions: "one twice daily",
      by: GP,
      safetyCheck: {
        findings: [
          { kind: "interaction", severity: "moderate", message: "metformin with contrast media" },
          { kind: "allergy", severity: "severe", message: "documented sulfonamide allergy" },
        ],
        allergyStatus: "documented",
        clear: false,
        blocking: [{ kind: "allergy", severity: "severe", message: "documented sulfonamide allergy" }],
      },
      overrideReason: "discussed with patient; benefit outweighs, monitoring arranged",
    });
    w.rx.transmit(script.id, "yk-pharmacy", GP);

    const sent = pharmacy.sent[0].safetyCheck;
    assert.ok(sent, "a pharmacist cannot reconstruct what this check saw");
    assert.equal(sent?.clear, false);
    assert.equal(sent?.allergyStatus, "documented");
    assert.equal(sent?.findings.length, 2, "every finding travels, not only the blocking ones");
    assert.equal(sent?.overridden.length, 1);
    assert.match(sent?.overrideReason ?? "", /benefit outweighs/);
  } finally {
    w.cleanup();
  }
});

test("a prescription written before this existed transmits null, not a fabricated all-clear", () => {
  // The reachable null case: an upgraded database. Every prescription written
  // before the check travelled has no summary, and the difference between
  // "checked, nothing found" and "no check came with this" is the whole of
  // it — a pharmacist who reads the second as the first stops looking.
  const pharmacy = goodPharmacy();
  const w = clinic({ dispatcher: pharmacy });
  try {
    const script = w.rx.write({ statementId: w.statement.id, instructions: "one twice daily", by: GP });
    // Exactly what `migrate()` leaves on a row that predates the column.
    w.db.sql.prepare("UPDATE prescriptions SET safety_summary = NULL WHERE id = ?").run(script.id);
    w.rx.transmit(script.id, "yk-pharmacy", GP);
    assert.equal(pharmacy.sent[0].safetyCheck, null, "null is not a clear check");
  } finally {
    w.cleanup();
  }
});

test("a prescription written without a check being handed in still carries one", () => {
  // The ordinary path: a route writes a prescription against an existing
  // statement and has no SafetyCheck object to pass. If that transmitted "no
  // check recorded" every time, the field would always be empty and a
  // pharmacist would stop reading it — honest, and useless.
  const pharmacy = goodPharmacy();
  const w = clinic({ dispatcher: pharmacy });
  try {
    const script = w.rx.write({ statementId: w.statement.id, instructions: "one twice daily", by: GP });
    w.rx.transmit(script.id, "yk-pharmacy", GP);
    const sent = pharmacy.sent[0].safetyCheck;
    assert.ok(sent, "the check is run when the caller does not bring one");
    assert.equal(sent?.allergyStatus, "never-asked", "and it reports what it actually found");
    assert.equal(sent?.clear, false, "nobody asked about allergies, so this is not a clear check");
  } finally {
    w.cleanup();
  }
});

test("dispenses and renewals are confined to their custodian", () => {
  const dir = mkdtempSync(join(tmpdir(), "northstar-rx-tenant-"));
  const db = new Db(join(dir, "northstar.db"));
  try {
    db.createTenant("north", "Northern Health", "Northern Regional Custodian");
    const northDb = db.forTenant("north");
    const meds = new MedicationStore(db, { check: () => [] });
    new Directory(db).addOrganization({ id: "yk-pharmacy", name: "Yellowknife Pharmacy" });
    const pharmacy = goodPharmacy();
    const rx = new Prescribing(db, meds, { dispatcher: pharmacy, tasks: new TaskStore(db) });
    const statement = meds.record({
      patientId: P,
      code: "860975",
      display: "Metformin 500mg tablet",
      ingredient: "metformin",
      source: "prescribed",
      adherence: "taking",
      by: GP,
    });
    const script = rx.write({ statementId: statement.id, instructions: "one twice daily", by: GP });
    rx.declareDispenseReporting("yk-pharmacy", true, GP);
    rx.transmit(script.id, "yk-pharmacy", GP);
    rx.recordDispense(script.id, { outcome: "dispensed", dispensedAt: "2026-08-20T15:00:00.000Z", by: GP });

    const northRx = new Prescribing(northDb, new MedicationStore(northDb, { check: () => [] }), {
      dispatcher: pharmacy,
      tasks: new TaskStore(northDb),
    });
    assert.equal(northRx.dispenses(script.id).length, 0, "another custodian's dispense is not visible");
    assert.equal(northRx.neverCollected(0).length, 0);
    assert.equal(northRx.dispensedAfterCancellation().length, 0);
    assert.equal(northRx.reportsDispenses("yk-pharmacy"), false, "a declaration is the custodian's own");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a dispense cannot have happened in the future", () => {
  // A mistyped year sorts last and turns an uncollected prescription into a
  // dispensed one, which is the exact misreading this module exists to stop.
  const w = transmitted({ reports: true });
  try {
    const nextYear = new Date(Date.now() + 365 * 86_400_000).toISOString();
    assert.throws(
      () => w.rx.recordDispense(w.script.id, { outcome: "dispensed", dispensedAt: nextYear, by: GP }),
      /in the future/
    );
    assert.equal(w.rx.dispenseState(w.script.id).state, "awaiting", "and nothing was recorded");

    // A pharmacy's clock running a few minutes ahead is not a typo.
    const slightlyAhead = new Date(Date.now() + 5 * 60_000).toISOString();
    w.rx.recordDispense(w.script.id, { outcome: "dispensed", dispensedAt: slightlyAhead, by: GP });
    assert.equal(w.rx.dispenseState(w.script.id).state, "dispensed");
  } finally {
    w.cleanup();
  }
});
