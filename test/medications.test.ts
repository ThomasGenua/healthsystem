/**
 * A medication list that says what the patient is taking.
 *
 * Section 5's failure is a list that records what was prescribed and is read
 * as what is in the patient. Those are different claims. A prescription
 * written eighteen months ago is evidence that somebody intended a drug, and
 * the patient who stopped their statin because of muscle aches and told nobody
 * has a chart that says otherwise. Every dose calculated around that list is
 * calculated around a drug that is not there.
 *
 * The load-bearing test is the third one. An allergy list that is empty
 * because nobody asked and one that is empty because the answer was none are
 * clinically opposite, and in most systems they render identically — so a
 * check against the first returns "no contraindications found", which is a
 * reassuring answer to a question that was never put.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../src/db.ts";
import { MedicationStore, PrescriptionRefused } from "../src/meds/store.ts";
import { assess, crossReacts, type Finding, type InteractionSource } from "../src/meds/safety.ts";

function clinic(interactions: InteractionSource | null = null): {
  db: Db;
  meds: MedicationStore;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "northstar-meds-"));
  const db = new Db(join(dir, "northstar.db"));
  return {
    db,
    meds: new MedicationStore(db, interactions),
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}

const GP = { actorId: "dr-tetso", actorKind: "practitioner" };
const NURSE = { actorId: "rn-blondin", actorKind: "practitioner" };
const P = "NT123456";

const STATIN = {
  patientId: P,
  code: "617314",
  display: "Atorvastatin 40mg tablet",
  ingredient: "atorvastatin",
  by: GP,
};

/** A source that always answers, and one that cannot. */
const QUIET: InteractionSource = { check: () => [] };
const BROKEN: InteractionSource = {
  check: () => {
    throw new Error("licence expired");
  },
};

test("a prescribed drug the patient stopped taking is not on the list a dose is calculated from", () => {
  // The commonest medication error there is. Both lists are real; conflating
  // them is the mistake.
  const { meds, cleanup } = clinic();
  try {
    const s = meds.record({ ...STATIN, source: "prescribed", adherence: "taking", dose: "40mg" });
    meds.record({
      patientId: P,
      code: "860975",
      display: "Metformin 500mg tablet",
      ingredient: "metformin",
      source: "prescribed",
      adherence: "taking",
      by: GP,
    });

    // The patient mentions at review that they stopped the statin months ago.
    meds.revise(s.id, { adherence: "not-taking" }, { ...NURSE, source: "patient-reported" });

    assert.deepEqual(
      meds.current(P).map((m) => m.ingredient),
      ["metformin"],
      "what the patient is taking"
    );
    assert.deepEqual(
      meds.current(P, { asPrescribed: true }).map((m) => m.ingredient).sort(),
      ["atorvastatin", "metformin"],
      "and what is prescribed, which is a different question"
    );

    const still = meds.current(P, { asPrescribed: true }).find((m) => m.ingredient === "atorvastatin")!;
    assert.equal(still.status, "active", "the prescription is live");
    assert.equal(still.adherence, "not-taking", "and the patient is not taking it");
    assert.equal(still.source, "patient-reported", "on whose word matters too");
  } finally {
    cleanup();
  }
});

test("a dose change keeps the earlier dose readable", () => {
  const { meds, cleanup } = clinic();
  try {
    const s = meds.record({ ...STATIN, source: "prescribed", dose: "20mg", adherence: "taking" });
    const up = meds.revise(s.id, { dose: "40mg" }, GP);
    meds.revise(up.id, { dose: "80mg" }, GP);

    assert.deepEqual(meds.historyOf(s.id).map((m) => m.dose), ["20mg", "40mg", "80mg"]);
    assert.equal(meds.current(P).length, 1, "one drug, not three");
    assert.equal(meds.current(P)[0].dose, "80mg");
    assert.throws(() => meds.revise(s.id, { dose: "10mg" }, GP), /already been revised/);
  } finally {
    cleanup();
  }
});

test("nobody asked and no known allergies are different answers", () => {
  // The load-bearing test. A check against an empty list must not read as a
  // clean one, because a prescriber told "no contraindications" is being told
  // something this system does not know.
  const { meds, cleanup } = clinic(QUIET);
  try {
    assert.equal(meds.allergyStatus(P), "never-asked");
    const unknown = meds.check(P, { ingredient: "amoxicillin", display: "Amoxicillin 500mg" });
    assert.equal(unknown.clear, false, "an unchecked patient is not a clear one");
    assert.equal(unknown.allergyStatus, "never-asked");
    assert.equal(unknown.findings[0].kind, "allergy-history-not-taken");
    assert.equal(unknown.blocking.length, 1, "and it is a finding a prescriber has to answer for");

    // Somebody asks. The answer is none — and that is a record.
    meds.recordNoKnownAllergies(P, NURSE);
    assert.equal(meds.allergyStatus(P), "none-documented");
    const asked = meds.check(P, { ingredient: "amoxicillin", display: "Amoxicillin 500mg" });
    assert.equal(asked.clear, true, "now it is genuinely clear");
    assert.deepEqual(asked.findings, []);
  } finally {
    cleanup();
  }
});

test("an allergy recorded as a class catches the drug prescribed under its own name", () => {
  // "Penicillin" is how it is written down, and amoxicillin is what gets
  // prescribed. A check matching only on exact ingredient finds nothing.
  const { meds, cleanup } = clinic(QUIET);
  try {
    meds.recordAllergy({
      patientId: P,
      display: "Penicillin",
      ingredient: "penicillin",
      criticality: "high",
      reaction: "anaphylaxis",
      by: GP,
    });

    const c = meds.check(P, { ingredient: "amoxicillin", display: "Amoxicillin 500mg" });
    assert.equal(c.clear, false);
    assert.equal(c.findings[0].kind, "allergy");
    assert.equal(c.findings[0].severity, "contraindicated", "high criticality is not a warning");
    assert.match(c.findings[0].message, /cross-reacts with a recorded high-criticality allergy to penicillin/);
    assert.match(c.findings[0].message, /anaphylaxis/);

    assert.equal(meds.check(P, { ingredient: "metformin", display: "Metformin" }).clear, true);
    assert.ok(crossReacts("penicillin", "AMOXICILLIN"), "and case is not a defence");
    assert.ok(crossReacts("ibuprofen", "naproxen"), "two members of one class");
    assert.ok(!crossReacts("penicillin", "metformin"));
  } finally {
    cleanup();
  }
});

test("prescribing past a contraindication needs an override, and the override is the record", () => {
  // Not a refusal: an emergency does not wait for an allergy history, and a
  // system that says no outright is one clinicians route around. What must be
  // true is that proceeding was an act somebody can be shown to have taken.
  const { meds, cleanup } = clinic(QUIET);
  try {
    meds.recordAllergy({ patientId: P, display: "Penicillin", ingredient: "penicillin", criticality: "high", by: GP });

    let refused: PrescriptionRefused | undefined;
    try {
      meds.prescribe({ ...STATIN, display: "Amoxicillin 500mg", ingredient: "amoxicillin", code: "308192" });
    } catch (err) {
      refused = err as PrescriptionRefused;
    }
    assert.ok(refused instanceof PrescriptionRefused, "refused, and with the findings attached");
    assert.equal(refused.findings[0].kind, "allergy");
    assert.equal(refused.check.allergyStatus, "documented");
    assert.equal(meds.current(P).length, 0, "and nothing was written");

    // An empty reason is not an override.
    assert.throws(
      () =>
        meds.prescribe(
          { ...STATIN, display: "Amoxicillin 500mg", ingredient: "amoxicillin", code: "308192" },
          { reason: "  " }
        ),
      PrescriptionRefused
    );

    const { statement, check } = meds.prescribe(
      { ...STATIN, display: "Amoxicillin 500mg", ingredient: "amoxicillin", code: "308192" },
      { reason: "Documented rash only, discussed with patient, no anaphylaxis history" }
    );
    assert.equal(statement.status, "active");
    assert.equal(check.blocking.length, 1);

    const override = meds.events(P).find((e) => e.event === "override")!;
    assert.match(override.detail!, /Documented rash only/);
    const shown = JSON.parse(override.overrides!) as Finding[];
    assert.equal(shown[0].kind, "allergy", "what the prescriber was told is on the record, not just that they clicked");
    assert.equal(override.actor_id, "dr-tetso");
  } finally {
    cleanup();
  }
});

test("an interaction source that cannot answer does not read as one that said no", () => {
  const { meds, cleanup } = clinic(BROKEN);
  try {
    meds.recordNoKnownAllergies(P, NURSE);
    meds.record({ ...STATIN, source: "prescribed", adherence: "taking" });

    const c = meds.check(P, { ingredient: "clarithromycin", display: "Clarithromycin 500mg" });
    assert.equal(c.clear, false, "a licence that expired is not a clean check");
    assert.equal(c.findings[0].kind, "interaction-source-unavailable");
    assert.match(c.findings[0].message, /licence expired/);
    assert.equal(c.blocking.length, 1);
  } finally {
    cleanup();
  }
});

test("with no interaction source configured, interactions are reported unchecked", () => {
  const { meds, cleanup } = clinic(null);
  try {
    meds.recordNoKnownAllergies(P, NURSE);
    meds.record({ ...STATIN, source: "prescribed", adherence: "taking" });

    const c = meds.check(P, { ingredient: "clarithromycin", display: "Clarithromycin" });
    assert.equal(c.clear, false);
    assert.equal(c.findings[0].kind, "interaction-source-unavailable");
    assert.equal(c.blocking.length, 0, "moderate, so it informs rather than requiring an override");
  } finally {
    cleanup();
  }
});

test("two prescribers writing the same ingredient is caught", () => {
  const { meds, cleanup } = clinic(QUIET);
  try {
    meds.recordNoKnownAllergies(P, NURSE);
    meds.record({ ...STATIN, source: "prescribed", adherence: "taking" });

    const c = meds.check(P, { ingredient: "atorvastatin", display: "Lipitor 20mg" });
    assert.equal(c.findings[0].kind, "duplicate-therapy");
    assert.match(c.findings[0].message, /already taking Atorvastatin 40mg tablet, which is the same ingredient/);
    assert.equal(c.blocking.length, 1, "doubling a dose by accident is not a footnote");
  } finally {
    cleanup();
  }
});

test("a stopped drug leaves the list, with a reason, and stays readable", () => {
  const { meds, cleanup } = clinic();
  try {
    const s = meds.record({ ...STATIN, source: "prescribed", adherence: "taking" });
    assert.throws(() => meds.stop(s.id, { ...GP, reason: "" }), /needs a reason/);
    assert.equal(meds.current(P).length, 1, "the refusal left it on the list");

    meds.stop(s.id, { ...GP, reason: "myalgia, CK raised" });
    assert.equal(meds.current(P).length, 0);
    assert.equal(meds.current(P, { includeStopped: true, asPrescribed: true }).length, 1);
    assert.match(meds.current(P, { includeStopped: true, asPrescribed: true })[0].stop_reason!, /myalgia/);
    assert.deepEqual(meds.historyOf(s.id).map((m) => m.status), ["active", "stopped"]);
  } finally {
    cleanup();
  }
});

test("a reconciliation cannot be completed with medications nobody decided about", () => {
  // The refusal is the point. One marked done with lines unresolved is worse
  // than one never started: the chart says the work happened, so the next
  // clinician has no reason to look again.
  const { meds, cleanup } = clinic();
  try {
    const a = meds.record({ ...STATIN, source: "prescribed", adherence: "taking", dose: "40mg" });
    meds.record({
      patientId: P,
      code: "860975",
      display: "Metformin 500mg tablet",
      ingredient: "metformin",
      source: "prescribed",
      adherence: "taking",
      by: GP,
    });

    const rec = meds.startReconciliation({ patientId: P, transition: "admission", by: GP });
    assert.equal(meds.items(rec.id).length, 2, "seeded from the list; an empty form is completed by doing nothing");
    assert.match(meds.items(rec.id).find((i) => i.display.startsWith("Atorva"))!.prior!, /40mg/);

    assert.throws(() => meds.completeReconciliation(rec.id, GP), /2 medication\(s\) still undecided/);
    assert.throws(() => meds.completeReconciliation(rec.id, GP), /Atorvastatin 40mg tablet, Metformin/);

    const statin = meds.items(rec.id).find((i) => i.statement_id === a.id)!;
    assert.throws(() => meds.decide(statin.id, "stop", GP), /a stop decision needs a reason/);
    assert.throws(() => meds.decide(statin.id, "unresolved", GP), /cannot be to leave it undecided/);

    meds.decide(statin.id, "stop", { ...GP, reason: "myalgia on admission" });
    assert.throws(() => meds.completeReconciliation(rec.id, GP), /1 medication\(s\) still undecided/);

    meds.decide(meds.items(rec.id).find((i) => i.display.startsWith("Metformin"))!.id, "continue", GP);
    const done = meds.completeReconciliation(rec.id, GP);

    assert.equal(done.status, "completed");
    assert.equal(done.completed_by, "dr-tetso");
    // The decisions reach the list, which is what makes it a reconciliation
    // and not a questionnaire.
    assert.deepEqual(meds.current(P).map((m) => m.ingredient), ["metformin"]);
    assert.match(meds.historyOf(a.id).at(-1)!.stop_reason!, /myalgia on admission/);
    assert.equal(meds.incompleteReconciliations().length, 0);
  } finally {
    cleanup();
  }
});

test("a reconciliation left open is visible, and abandoning one needs a reason", () => {
  const { meds, cleanup } = clinic();
  try {
    meds.record({ ...STATIN, source: "prescribed", adherence: "taking" });
    const rec = meds.startReconciliation({ patientId: P, transition: "discharge", by: GP });
    assert.deepEqual(meds.incompleteReconciliations().map((r) => r.id), [rec.id]);

    // A medication the patient turned out to be on, that the list did not know.
    const found = meds.addToReconciliation(rec.id, "Warfarin 3mg", "3mg daily, from the community pharmacy", GP);
    assert.equal(found.decision, "unresolved");
    assert.equal(meds.items(rec.id).length, 2);

    assert.throws(() => meds.abandonReconciliation(rec.id, { ...GP, reason: "" }), /needs a reason/);
    meds.abandonReconciliation(rec.id, { ...GP, reason: "patient self-discharged before review" });
    assert.equal(meds.incompleteReconciliations().length, 0);
    assert.equal(meds.reconciliation(rec.id)!.status, "abandoned");
    assert.throws(() => meds.decide(found.id, "continue", GP), /abandoned reconciliation cannot be changed/);
  } finally {
    cleanup();
  }
});

test("findings are ordered by how bad they are, not by how they were found", () => {
  // A contraindication below three informational lines is a contraindication
  // that gets scrolled past. The order findings are *discovered* in is an
  // implementation detail of the check — allergies before duplicates before
  // interactions — and it has nothing to do with which one a prescriber needs
  // to read first.
  //
  // So the case that matters is where those two orders disagree: the missing
  // allergy history is found first and the contraindicated interaction last.
  const check = assess({
    proposedIngredient: "warfarin",
    proposedDisplay: "Warfarin 3mg",
    allergies: [],
    allergyStatus: "never-asked",
    currentIngredients: [
      { ingredient: "warfarin", display: "Warfarin 5mg" },
      { ingredient: "miconazole", display: "Miconazole gel" },
    ],
    interactions: {
      check: () => [
        { kind: "interaction", severity: "minor", message: "minor interaction" },
        { kind: "interaction", severity: "contraindicated", message: "miconazole potentiates warfarin markedly" },
      ],
    },
  });

  assert.deepEqual(
    check.findings.map((f) => f.severity),
    ["contraindicated", "severe", "severe", "minor"],
    "worst first, whatever order the check happened to find them in"
  );
  assert.equal(check.findings[0].kind, "interaction", "found last, read first");
  assert.equal(check.blocking.length, 3, "and minor ones inform rather than block");
  assert.equal(check.clear, false);
});

test("medications and allergies are confined to their tenant", () => {
  const dir = mkdtempSync(join(tmpdir(), "northstar-meds-iso-"));
  const root = new Db(join(dir, "northstar.db"));
  try {
    root.createTenant("north", "Northern Health");
    root.createTenant("south", "Southern Health");
    const north = new MedicationStore(root.forTenant("north"), QUIET);
    const south = new MedicationStore(root.forTenant("south"), QUIET);

    // Same health number at two custodians: a province issues it.
    north.recordAllergy({ patientId: P, display: "Penicillin", ingredient: "penicillin", criticality: "high", by: GP });
    const n = north.record({ ...STATIN, source: "prescribed", adherence: "taking" });
    north.startReconciliation({ patientId: P, transition: "admission", by: GP });

    assert.equal(south.allergyStatus(P), "never-asked", "one custodian's history is not another's");
    assert.equal(north.allergyStatus(P), "documented");
    assert.equal(south.current(P).length, 0);
    assert.equal(south.statement(n.id), undefined);
    assert.equal(south.incompleteReconciliations().length, 0);
    assert.equal(north.incompleteReconciliations().length, 1);

    // And the dangerous direction: a southern prescriber must not be told the
    // patient is clear because the allergy lives in the north.
    const c = south.check(P, { ingredient: "amoxicillin", display: "Amoxicillin" });
    assert.equal(c.allergyStatus, "never-asked", "not 'clear' — south has never asked");
    assert.equal(c.clear, false);
  } finally {
    root.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
