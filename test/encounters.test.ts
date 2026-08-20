/**
 * A visit is a thing that happened, and the record has to keep saying so.
 *
 * These tests are mostly about refusals, because the interesting failures here
 * are all cases where something plausible would quietly destroy a fact. The
 * two that matter most:
 *
 *   An encounter that started cannot be cancelled. Cancelling would erase that
 *   the patient attended, and "they came and nobody saw them" is a disposition
 *   worth keeping, not an absence.
 *
 *   Clinical content cannot name a visit that is not this patient's. An
 *   encounter_id reads as provenance; one pointing at somebody else's visit is
 *   how a chart acquires another person's results, which is the same hazard
 *   `duplicates()` refuses to merge for.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../src/db.ts";
import { Encounters, EncounterMismatch } from "../src/clinical/encounters.ts";
import { ClinicalRecord } from "../src/clinical/record.ts";
import { OrderStore } from "../src/orders/store.ts";
import { MedicationStore } from "../src/meds/store.ts";
import { VisitView } from "../src/workspace/visit.ts";

const CLERK = { actorId: "clerk", actorKind: "staff" };
const DOCTOR = { actorId: "dr-tetso", actorKind: "practitioner" };
const P = "NT123456";

function clinic(): {
  db: Db;
  encounters: Encounters;
  rec: ClinicalRecord;
  orders: OrderStore;
  meds: MedicationStore;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "portage-encounters-"));
  const db = new Db(join(dir, "portage.db"));
  return {
    db,
    encounters: new Encounters(db),
    rec: new ClinicalRecord(db),
    orders: new OrderStore(db),
    meds: new MedicationStore(db),
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function visit(encounters: Encounters, patientId = P, arrived = true) {
  return encounters.open({
    patientId,
    class: "in-person",
    reason: "Knee review",
    by: DOCTOR,
    arrived,
  });
}

test("a visit that started cannot be cancelled, because it happened", () => {
  const { encounters, cleanup } = clinic();
  try {
    const e = visit(encounters);
    assert.equal(e.status, "in-progress");

    assert.throws(
      () => encounters.cancel(e.id, { ...CLERK, reason: "patient left" }),
      /cannot be cancelled/,
      "cancelling would erase that the patient attended at all"
    );

    // The honest way to record the same thing keeps both facts: they came, and
    // nobody saw them.
    const closed = encounters.close(e.id, { ...DOCTOR, disposition: "left-without-being-seen" });
    assert.equal(closed.status, "finished");
    assert.equal(closed.disposition, "left-without-being-seen");
    assert.ok(closed.started_at, "and it still records that the visit started");
  } finally {
    cleanup();
  }
});

test("a planned visit can be cancelled, and closing one is refused", () => {
  const { encounters, cleanup } = clinic();
  try {
    const e = visit(encounters, P, false);
    assert.equal(e.status, "planned");
    assert.throws(
      () => encounters.close(e.id, { ...DOCTOR, disposition: "home" }),
      /only one in progress can/,
      "a visit that never started cannot have ended"
    );
    const cancelled = encounters.cancel(e.id, { ...CLERK, reason: "weather; plane did not fly" });
    assert.equal(cancelled.status, "cancelled");
  } finally {
    cleanup();
  }
});

test("closing a visit needs a disposition, because 'finished' does not say what was decided", () => {
  const { encounters, cleanup } = clinic();
  try {
    const e = visit(encounters);
    assert.throws(() => encounters.close(e.id, { ...DOCTOR, disposition: "  " }), /needs a disposition/);
  } finally {
    cleanup();
  }
});

test("the person who opened the visit is recorded as having been there", () => {
  const { encounters, cleanup } = clinic();
  try {
    const e = visit(encounters);
    const present = encounters.participants(e.id);
    assert.equal(present.length, 1);
    assert.equal(present[0].participant_id, DOCTOR.actorId);

    // An interpreter is exactly the person a later reader needs to know was
    // present, and a single provider_id column would have lost them.
    encounters.addParticipant(e.id, {
      participantId: "interpreter-7",
      participantKind: "staff",
      role: "interpreter",
    });
    assert.equal(encounters.participants(e.id).length, 2);
    encounters.addParticipant(e.id, {
      participantId: "interpreter-7",
      participantKind: "staff",
      role: "interpreter",
    });
    assert.equal(encounters.participants(e.id).length, 2, "recording the same role twice is not two people");
  } finally {
    cleanup();
  }
});

test("clinical content cannot name another patient's visit", () => {
  const { encounters, rec, orders, meds, cleanup } = clinic();
  try {
    const mine = visit(encounters, P);
    const theirs = visit(encounters, "NT999999");

    assert.throws(
      () => orders.create({ patientId: P, category: "lab", code: "718-7", display: "Haemoglobin", indication: "Anaemia", by: DOCTOR, encounterId: theirs.id }),
      EncounterMismatch,
      "an order filed against someone else's visit is how a chart acquires their results"
    );
    assert.throws(
      () => rec.record({ entryType: "Condition", patientId: P, content: { code: "E11" }, encounterId: theirs.id, authorId: "dr-tetso", authorKind: "practitioner" }),
      EncounterMismatch
    );
    assert.throws(
      () => meds.record({ patientId: P, code: "C09AA05", display: "Ramipril 5mg", source: "prescribed", by: DOCTOR, encounterId: theirs.id }),
      EncounterMismatch
    );

    // And the patient's own visit is accepted, so the refusal is about the
    // mismatch rather than about encounters being rejected wholesale.
    const o = orders.create({ patientId: P, category: "lab", code: "718-7", display: "Haemoglobin", indication: "Anaemia", by: DOCTOR, encounterId: mine.id });
    assert.equal(o.encounter_id, mine.id);
  } finally {
    cleanup();
  }
});

test("an encounter that does not exist is refused, rather than stored as provenance", () => {
  const { orders, cleanup } = clinic();
  try {
    assert.throws(
      () => orders.create({ patientId: P, category: "lab", code: "718-7", display: "Haemoglobin", indication: "Anaemia", by: DOCTOR, encounterId: "enc-1" }),
      /no encounter enc-1/,
      "the invented identifier every fixture used before this existed"
    );
  } finally {
    cleanup();
  }
});

test("a cancelled visit accepts nothing, and a finished one still accepts a late result", () => {
  const { encounters, orders, cleanup } = clinic();
  try {
    const cancelled = encounters.cancel(visit(encounters, P, false).id, { ...CLERK, reason: "rebooked" });
    assert.throws(
      () => orders.create({ patientId: P, category: "lab", code: "718-7", display: "Hb", indication: "Anaemia", by: DOCTOR, encounterId: cancelled.id }),
      /was cancelled, so nothing can belong to it/
    );

    const finished = encounters.close(visit(encounters).id, { ...DOCTOR, disposition: "home" });
    const late = orders.create({
      patientId: P,
      category: "lab",
      code: "718-7",
      display: "Hb",
      indication: "Anaemia",
      by: DOCTOR,
      encounterId: finished.id,
    });
    assert.equal(late.encounter_id, finished.id, "results come back after the patient has gone home");
  } finally {
    cleanup();
  }
});

test("a visit left open is on a worklist rather than open forever", () => {
  const { db, encounters, cleanup } = clinic();
  try {
    const stale = visit(encounters);
    // Backdate it, because the alternative is a test that sleeps.
    db.sql
      .prepare("UPDATE encounters SET started_at = ? WHERE tenant_id = ? AND id = ?")
      .run("2026-01-01T09:00:00Z", db.tenantId, stale.id);
    const fresh = visit(encounters);

    const open = encounters.stillOpen();
    assert.equal(open.length, 2);

    const old = encounters.stillOpen({ olderThanHours: 24, asOf: "2026-01-03T09:00:00Z" });
    assert.deepEqual(
      old.map((e) => e.id),
      [stale.id],
      "and the fresh one is not chased"
    );
    assert.ok(!old.some((e) => e.id === fresh.id));
  } finally {
    cleanup();
  }
});

test("the assembled visit says a section failed, rather than rendering as nothing happened", () => {
  const { encounters, rec, orders, meds, cleanup } = clinic();
  try {
    const e = visit(encounters);
    orders.create({ patientId: P, category: "lab", code: "718-7", display: "Hb", indication: "Anaemia", by: DOCTOR, encounterId: e.id });

    const broken = {
      forEncounter: () => {
        throw new Error("the orders table is unreadable");
      },
    } as unknown as OrderStore;

    const view = new VisitView({ encounters, record: rec, meds, orders: broken });
    const v = view.summarise(e.id);

    assert.equal(v.orders.items.length, 0);
    assert.equal(v.orders.complete, false);
    assert.equal(v.orders.incomplete?.reason, "unavailable");
    assert.ok(
      v.omissions.some((o) => o.includes("empty because it failed")),
      "the panel must not read as 'nothing was ordered at this visit'"
    );
    // Results hang off the orders, so an orders section that failed makes the
    // results an undercount rather than a shorter true list.
    assert.equal(v.results.complete, false);
    const why = v.results.incomplete;
    assert.ok(why && why.reason === "unavailable");
    assert.match(why.detail, /undercount/);
    assert.equal(v.complete, false);
  } finally {
    cleanup();
  }
});

test("a withheld type drops its section and says a directive is why", () => {
  const { encounters, rec, orders, meds, cleanup } = clinic();
  try {
    const e = visit(encounters);
    orders.create({ patientId: P, category: "lab", code: "718-7", display: "Hb", indication: "Anaemia", by: DOCTOR, encounterId: e.id });

    const view = new VisitView({ encounters, record: rec, meds, orders });
    const v = view.summarise(e.id, { withheldTypes: new Set(["ServiceRequest"]) });

    assert.equal(v.orders.items.length, 0, "neither the content nor the count reaches the reader");
    const why = v.orders.incomplete;
    assert.ok(why && why.reason === "withheld");
    assert.match(why.detail, /break glass/);
    // A different section is untouched, which is the whole point of doing this
    // per type rather than refusing the visit.
    assert.equal(v.medications.complete, true);
  } finally {
    cleanup();
  }
});

test("an assembled visit that does not exist says so instead of looking empty", () => {
  const { encounters, rec, orders, meds, cleanup } = clinic();
  try {
    const v = new VisitView({ encounters, record: rec, meds, orders }).summarise("nope");
    assert.equal(v.encounter, undefined);
    assert.equal(v.complete, false);
    assert.ok(v.omissions.some((o) => o.includes("no encounter nope")));
  } finally {
    cleanup();
  }
});

test("an encounter is confined to its tenant", () => {
  const { db, encounters, cleanup } = clinic();
  try {
    const mine = visit(encounters);
    const other = new Encounters(db.forTenant("yellowknife"));
    assert.equal(other.get(mine.id), undefined, "another custodian cannot read it");
    assert.equal(other.stillOpen().length, 0);
    assert.throws(() => other.validateFor(mine.id, P), EncounterMismatch);
  } finally {
    cleanup();
  }
});

test("the history records every transition with who made it", () => {
  const { encounters, cleanup } = clinic();
  try {
    const e = visit(encounters, P, false);
    encounters.arrive(e.id, CLERK);
    encounters.close(e.id, { ...DOCTOR, disposition: "home with advice" });

    const history = encounters.history(e.id);
    assert.deepEqual(
      history.map((h) => h.event),
      ["opened", "arrived", "closed"]
    );
    assert.equal(history[1].actor_id, CLERK.actorId);
    assert.equal(history[2].actor_id, DOCTOR.actorId);
    assert.equal(history[2].detail, "home with advice", "the disposition is on the trail, not just the row");
  } finally {
    cleanup();
  }
});
