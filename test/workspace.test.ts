/**
 * A chart summary that is honest about what it does not contain.
 *
 * Section 2 asks for a longitudinal view a clinician can act from, and the
 * temptation is to treat that as presentation. The reason it is not is that a
 * summary is *read as complete*. That is its clinical function: a clinician
 * opens it precisely so they do not have to go looking, and having looked,
 * they proceed on the basis that what is there is what there is.
 *
 * So the dangerous failure is not an error. It is a section that came back
 * short — a store that threw and was caught, a list truncated at fifty — and
 * rendered as an empty panel meaning "none" when it means "not asked". These
 * tests break each section in turn and require the summary to say so.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../src/db.ts";
import { ClinicalRecord } from "../src/clinical/record.ts";
import { ClinicalNotes } from "../src/clinical/notes.ts";
import { MedicationStore } from "../src/meds/store.ts";
import { OrderStore } from "../src/orders/store.ts";
import { ReferralStore } from "../src/work/referrals.ts";
import { TaskStore } from "../src/work/tasks.ts";
import { Workspace } from "../src/workspace/summary.ts";
import { Immunizations } from "../src/clinical/immunizations.ts";
import { Vitals } from "../src/clinical/vitals.ts";
import { CareTeam } from "../src/clinical/careteam.ts";
import { Coverage } from "../src/clinical/coverage.ts";
import { Schedule } from "../src/schedule/store.ts";
import { Directory } from "../src/directory/store.ts";
import { PatientMessaging } from "../src/patient/messaging.ts";

const P = "NT123456";
const GP = { actorId: "dr-tetso", actorKind: "practitioner" };
/** The chart names an author; the work stores name an actor. Same person. */
const GP_AUTHOR = { authorId: "dr-tetso", authorKind: "practitioner" };
const NURSE = { actorId: "rn-blondin", actorKind: "practitioner" };
const ANALYSER = "stanton-lab-analyser-3";
const PAST = "2020-01-01T00:00:00Z";

function ward() {
  const dir = mkdtempSync(join(tmpdir(), "portage-ws-"));
  const db = new Db(join(dir, "portage.db"));
  const record = new ClinicalRecord(db);
  const notes = new ClinicalNotes(record);
  const meds = new MedicationStore(db, { check: () => [] });
  const orders = new OrderStore(db);
  const referrals = new ReferralStore(db);
  const tasks = new TaskStore(db);
  const immunizations = new Immunizations(record);
  const vitals = new Vitals(record);
  const careTeam = new CareTeam(db);
  const coverage = new Coverage(db);
  const schedule = new Schedule(db);
  const messaging = new PatientMessaging(db);
  new Directory(db).addPractitioner({ id: "dr-tetso", family: "Tetso", given: "Jean" });
  return {
    db,
    record,
    notes,
    meds,
    orders,
    referrals,
    tasks,
    immunizations,
    vitals,
    careTeam,
    coverage,
    schedule,
    messaging,
    ws: new Workspace({
      record,
      notes,
      meds,
      orders,
      referrals,
      tasks,
      immunizations,
      vitals,
      careTeam,
      coverage,
      schedule,
      messaging,
    }),
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function populate(w: ReturnType<typeof ward>) {
  w.record.record({
    entryType: "Patient",
    patientId: P,
    content: {
      resourceType: "Patient",
      identifier: [{ system: "urn:jhn", value: P }],
      name: [{ family: "Beaulieu", given: ["Marie"], use: "official" }],
      birthDate: "1984-03-17",
    },
    authorId: "adt-feed",
    authorKind: "device",
  });
  w.record.record({
    entryType: "Condition",
    patientId: P,
    content: { resourceType: "Condition", code: { text: "Type 2 diabetes mellitus" } },
    ...GP_AUTHOR,
  });
  w.meds.recordNoKnownAllergies(P, NURSE);
  w.meds.record({
    patientId: P,
    code: "860975",
    display: "Metformin 500mg tablet",
    ingredient: "metformin",
    source: "prescribed",
    adherence: "taking",
    by: GP,
  });
  const order = w.orders.create({
    patientId: P,
    category: "lab",
    code: "2823-3",
    display: "Potassium",
    indication: "Six-week electrolyte check",
    by: GP,
  });
  w.orders.place(order.id, { ...GP, responsibleId: "dr-tetso", expectedBy: PAST });
  w.orders.report({
    patientId: P,
    orderId: order.id,
    code: "2823-3",
    display: "Potassium",
    value: "7.1",
    unit: "mmol/L",
    abnormalFlag: "critical-high",
    reportedBy: ANALYSER,
  });
  const pending = w.orders.create({
    patientId: P,
    category: "imaging",
    code: "24627-2",
    display: "Chest X-ray",
    indication: "Cough, three weeks",
    by: GP,
  });
  w.orders.place(pending.id, { ...GP, responsibleId: "dr-tetso", expectedBy: PAST });

  const ref = w.referrals.create({
    patientId: P,
    fromService: "Yellowknife Primary Care",
    toService: "Stanton Nephrology",
    indication: "Rising potassium on metformin",
    by: GP,
  });
  w.referrals.send(ref.id, { ...GP, respondBy: PAST });
  w.tasks.create({ kind: "result-review", title: "Review potassium", by: GP, patientId: P, ownerId: "dr-tetso" });
  const note = w.notes.draft({ patientId: P, noteType: "SOAP", sections: { plan: "Repeat bloods" }, author: GP_AUTHOR });
  w.notes.sign(note.record_id, GP_AUTHOR);
  w.immunizations.record({
    patientId: P,
    vaccine: "MMR",
    occurrenceAt: "2010-06-01T00:00:00Z",
    by: GP_AUTHOR,
  });
  w.vitals.record({
    patientId: P,
    kind: "heart-rate",
    value: 72,
    unit: "/min",
    takenAt: "2026-08-24T10:00:00Z",
    by: GP_AUTHOR,
  });
  w.careTeam.assign({ patientId: P, practitionerId: "dr-tetso", role: "primary", by: { actorId: "ops" } });
  w.coverage.record({
    patientId: P,
    plan: "NIHB",
    eligibility: "eligible",
    by: { actorId: "ops" },
    identifierSystem: "urn:jhn",
    identifierValue: P,
  });
  const thread = w.messaging.open({
    patientId: P,
    subject: "Renewal — metformin",
    body: "Please renew, last fill six weeks ago.",
    authorKind: "patient",
    by: { actorId: P, actorKind: "patient" },
  });
  return { order, pending, ref, thread: thread.thread };
}

test("the assembled chart pulls every store into one view", () => {
  const w = ward();
  try {
    populate(w);
    const chart = w.ws.chart(P);

    assert.equal(chart.patient?.family, "Beaulieu");
    assert.equal(chart.allergyStatus, "none-documented");
    assert.deepEqual(chart.medications.items.map((m) => m.ingredient), ["metformin"]);
    assert.equal(chart.unacknowledgedResults.items[0].value, "7.1");
    assert.equal(
      chart.openOrders.items.length,
      1,
      "the potassium was answered, so its order closed — the unread result is what is outstanding, and it appears once"
    );
    assert.equal(chart.openOrders.items[0].display, "Chest X-ray", "the one still waiting on a report is here");
    assert.equal(chart.openReferrals.items[0].to_service, "Stanton Nephrology");
    assert.equal(chart.openTasks.items.length, 1);
    assert.equal(chart.recentNotes.items.length, 1);
    assert.equal(chart.problems.items.length, 1);
    assert.equal(chart.immunizationStatus, "documented");
    assert.equal(chart.immunizations.items[0].vaccine, "MMR");
    assert.equal(chart.vitalStatus, "documented");
    assert.equal(chart.vitals.items[0].value, 72);
    assert.equal(chart.careTeam.items[0].role, "primary");
    assert.equal(chart.coverage.items[0].plan, "NIHB");
    assert.equal(chart.openThreads.items[0].subject, "Renewal — metformin");

    assert.equal(chart.complete, true, "and it says it is whole");
    assert.deepEqual(chart.omissions, []);
  } finally {
    w.cleanup();
  }
});

test("a section that fails is empty and says why, rather than reading as none", () => {
  // The failure this module exists for. A caught exception that leaves a blank
  // panel tells the clinician there is nothing, and they proceed on that.
  const w = ward();
  try {
    populate(w);
    // Break one store underneath, exactly as a corrupt index or a bad
    // migration would.
    w.db.sql.exec("DROP TABLE medication_statements");

    const chart = w.ws.chart(P);
    assert.equal(chart.medications.items.length, 0);
    assert.equal(chart.medications.complete, false, "empty, and known to be empty for the wrong reason");
    assert.equal(chart.medications.incomplete!.reason, "unavailable");

    assert.equal(chart.complete, false, "and the whole summary is flagged");
    assert.equal(chart.omissions.length, 1);
    assert.match(chart.omissions[0], /^Medications: could not be loaded/);
    assert.match(chart.omissions[0], /empty because it failed, not because there is nothing/);

    // And the rest of the chart still arrives: six panels beat an error page.
    assert.equal(chart.problems.items.length, 1);
    assert.equal(chart.unacknowledgedResults.items.length, 1);
  } finally {
    w.cleanup();
  }
});

test("a truncated section says how much it dropped", () => {
  // A list silently cut at the limit reads as the whole list.
  const w = ward();
  try {
    populate(w);
    for (let i = 0; i < 12; i++) {
      w.record.record({
        entryType: "Condition",
        patientId: P,
        content: { resourceType: "Condition", code: { text: `Problem ${i}` } },
        ...GP_AUTHOR,
      });
    }

    const chart = w.ws.chart(P, { limit: 5 });
    assert.equal(chart.problems.items.length, 5);
    assert.equal(chart.problems.complete, false);
    assert.deepEqual(chart.problems.incomplete, { reason: "truncated", shown: 5, total: 13 });
    assert.equal(chart.complete, false);
    assert.ok(chart.omissions.includes("Problems: showing 5 of 13"));
  } finally {
    w.cleanup();
  }
});

test("a store nobody wired in is an omission, not an empty panel", () => {
  // The quietest version: a deployment that never configured a store. Every
  // panel renders, one of them is blank, and nothing says it is blank because
  // the data lives somewhere this summary cannot see.
  const w = ward();
  try {
    populate(w);
    const partial = new Workspace({ record: w.record, notes: w.notes, orders: w.orders });
    const chart = partial.chart(P);

    assert.equal(chart.medications.complete, false);
    assert.equal(chart.allergies.complete, false);
    assert.equal(chart.allergyStatus, "unavailable", "never silently 'none'");
    assert.equal(chart.complete, false);
    assert.ok(chart.omissions.some((o) => /Medications: could not be loaded \(not configured/.test(o)));
    assert.ok(chart.omissions.includes("Allergies: allergy status could not be determined"));
    assert.equal(chart.problems.items.length, 1, "and what is configured still works");
  } finally {
    w.cleanup();
  }
});

test("a patient nobody asked about allergies is flagged at the top of the chart", () => {
  // Carried up rather than left inside the panel: a clinician scanning a chart
  // must see "never asked" without having to interpret an empty box.
  const w = ward();
  try {
    w.meds.record({
      patientId: P,
      code: "860975",
      display: "Metformin 500mg",
      ingredient: "metformin",
      source: "prescribed",
      by: GP,
    });
    const chart = w.ws.chart(P);

    assert.equal(chart.allergyStatus, "never-asked");
    assert.equal(chart.allergies.items.length, 0, "the panel is empty either way");
    assert.equal(chart.allergies.complete, true, "the query genuinely succeeded");
    assert.ok(
      chart.omissions.includes("Allergies: no allergy history has ever been recorded for this patient"),
      "so the distinction has to be carried by the summary, not the panel"
    );

    w.meds.recordNoKnownAllergies(P, NURSE);
    const asked = w.ws.chart(P);
    assert.equal(asked.allergyStatus, "none-documented");
    assert.ok(
      !asked.omissions.some((o) => o.startsWith("Allergies:")),
      "and now the same empty allergy panel means none"
    );
  } finally {
    w.cleanup();
  }
});

test("a chart whose allergy status cannot be determined is not a complete chart", () => {
  // Two conditions guard completeness, and this covers the second. With the
  // MedicationStore that ships, they never diverge — allergyStatus() and
  // allergies() run the same query, so if one fails the other has too, and the
  // section flag alone would have caught it.
  //
  // Worth pinning anyway, because Workspace takes its stores by interface and
  // an implementation where those diverge is unremarkable: a status cached
  // separately, or derived from a service the list does not consult. The
  // asymmetry is what makes it worth a guard — a chart that renders every
  // panel successfully while silently not knowing whether anyone ever asked
  // about allergies is the exact failure the top-level field exists to
  // prevent, and it would report itself complete.
  const w = ward();
  try {
    populate(w);
    const blind = Object.create(Object.getPrototypeOf(w.meds)) as typeof w.meds;
    Object.assign(blind, w.meds);
    blind.allergyStatus = () => {
      throw new Error("allergy service unreachable");
    };

    const chart = new Workspace({ ...w, meds: blind }).chart(P);
    assert.equal(chart.allergies.complete, true, "every section loaded");
    assert.equal(chart.medications.complete, true);
    assert.equal(chart.allergyStatus, "unavailable", "but whether anyone asked is unknown");
    assert.equal(chart.complete, false, "so the chart must not present itself as whole");
    assert.ok(chart.omissions.includes("Allergies: allergy status could not be determined"));
  } finally {
    w.cleanup();
  }
});

test("the worklist gathers what is owed across every kind of work", () => {
  // A clinician's day is not one queue. Each system reports its own as though
  // it were the whole picture, and the value of one view is that nothing is
  // owed somewhere they are not looking.
  const w = ward();
  try {
    populate(w);
    w.meds.startReconciliation({ patientId: P, transition: "admission", by: GP });

    const list = w.ws.worklist("dr-tetso");
    assert.equal(list.unacknowledgedResults.items.length, 1);
    assert.equal(list.unacknowledgedResults.items[0].value, "7.1");
    assert.equal(list.stalledReferrals.items.length, 1);
    assert.equal(list.ordersAwaitingResult.items.length, 1, "the x-ray is past due with nothing back");
    assert.equal(list.ordersAwaitingResult.items[0].display, "Chest X-ray", "and the answered potassium is not here");
    assert.equal(list.tasks.items.length, 1);
    assert.equal(list.incompleteReconciliations.items.length, 1);
    assert.equal(list.today.complete, true, "today's diary loaded even when it is empty");
    assert.equal(list.awaitingMessages.items.length, 1);
    assert.equal(list.awaitingMessages.items[0].subject, "Renewal — metformin");
    assert.equal(list.complete, true);

    // Another clinician's list is not this one's.
    assert.equal(w.ws.worklist("dr-hale").unacknowledgedResults.items.length, 0);
    assert.equal(w.ws.worklist("dr-hale").tasks.items.length, 0);
  } finally {
    w.cleanup();
  }
});

test("an empty immunization panel is never-asked, not none", () => {
  const w = ward();
  try {
    w.meds.recordNoKnownAllergies(P, NURSE);
    w.coverage.record({ patientId: P, plan: "OHIP", eligibility: "eligible", by: { actorId: "ops" } });
    w.careTeam.assign({ patientId: P, practitionerId: "dr-tetso", role: "primary", by: { actorId: "ops" } });
    const chart = w.ws.chart(P);
    assert.equal(chart.immunizationStatus, "never-asked");
    assert.equal(chart.immunizations.items.length, 0);
    assert.equal(chart.immunizations.complete, true);
    assert.ok(chart.omissions.includes("Immunizations: no immunization history has ever been recorded for this patient"));
    assert.equal(chart.vitalStatus, "never-measured");
    assert.ok(chart.omissions.includes("Vitals: no vital signs have ever been recorded for this patient"));
  } finally {
    w.cleanup();
  }
});

test("today's appointments appear on the clinician's worklist, not another clinician's", () => {
  const w = ward();
  try {
    populate(w);
    const slot = w.schedule.openSlot({
      resourceId: "dr-tetso",
      service: "GP review",
      startsAt: "2026-08-24T14:00:00Z",
      endsAt: "2026-08-24T14:30:00Z",
    });
    w.schedule.book({
      slotId: slot.id,
      patientId: P,
      reason: "Diabetes review",
      by: GP,
    });
    const list = w.ws.worklist("dr-tetso", { asOf: "2026-08-24T12:00:00Z" });
    assert.equal(list.today.items.length, 1);
    assert.equal(list.today.items[0].booking.patient_id, P);
    assert.equal(w.ws.worklist("dr-hale", { asOf: "2026-08-24T12:00:00Z" }).today.items.length, 0);
  } finally {
    w.cleanup();
  }
});

test("a worklist section that fails is reported, not swallowed", () => {
  const w = ward();
  try {
    populate(w);
    w.db.sql.exec("DROP TABLE referrals");

    const list = w.ws.worklist("dr-tetso");
    assert.equal(list.stalledReferrals.complete, false);
    assert.equal(list.complete, false);
    assert.match(list.omissions[0], /^Stalled referrals: could not be loaded/);
    assert.equal(list.unacknowledgedResults.items.length, 1, "and the rest of the day still arrives");
  } finally {
    w.cleanup();
  }
});

test("the summary is confined to its tenant", () => {
  const dir = mkdtempSync(join(tmpdir(), "portage-ws-iso-"));
  const root = new Db(join(dir, "portage.db"));
  try {
    root.createTenant("north", "Northern Health");
    root.createTenant("south", "Southern Health");

    const build = (t: string) => {
      const db = root.forTenant(t);
      const record = new ClinicalRecord(db);
      const meds = new MedicationStore(db, { check: () => [] });
      return {
        meds,
        ws: new Workspace({
          record,
          notes: new ClinicalNotes(record),
          meds,
          orders: new OrderStore(db),
          referrals: new ReferralStore(db),
          tasks: new TaskStore(db),
        }),
      };
    };
    const north = build("north");
    const south = build("south");

    north.meds.recordAllergy({ patientId: P, display: "Penicillin", ingredient: "penicillin", criticality: "high", by: GP });
    north.meds.record({
      patientId: P,
      code: "860975",
      display: "Metformin 500mg",
      ingredient: "metformin",
      source: "prescribed",
      adherence: "taking",
      by: GP,
    });

    assert.equal(north.ws.chart(P).allergyStatus, "documented");
    assert.equal(north.ws.chart(P).allergies.items.length, 1);

    // The dangerous direction: south must not see a chart that looks answered.
    const s = south.ws.chart(P);
    assert.equal(s.medications.items.length, 0);
    assert.equal(s.allergies.items.length, 0);
    assert.equal(s.allergyStatus, "never-asked", "not 'none-documented' — south has never asked");
    assert.ok(s.omissions.some((o) => /no allergy history has ever been recorded/.test(o)));
  } finally {
    root.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
