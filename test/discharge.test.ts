/**
 * What is outstanding when somebody leaves, and who is holding it.
 *
 * Two properties, and both are about the gap between believing work has moved
 * and its having moved.
 *
 * A discharge list is taken from the chart rather than typed, because a form
 * records what somebody remembered at the end of a shift and the four things
 * that actually go wrong — an unread result, an unfinished reconciliation, no
 * follow-up booked, an open referral — are all computable at the moment the
 * visit closes.
 *
 * And a handoff is not complete until somebody accepts it. "I handed it over"
 * and "somebody has it" are different statements; only the second is true of
 * a transfer nobody answered, and the difference is a patient nobody is
 * following up.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine } from "../src/core/engine.ts";

const PATIENT = "NT000001";
const DOCTOR = { actorId: "dr-okpik", actorKind: "practitioner" };
const LOCUM = { actorId: "dr-halvorsen", actorKind: "practitioner" };
const NURSE = { actorId: "rn-tapatai", actorKind: "practitioner" };

async function clinic() {
  const engine = new Engine({ dbPath: ":memory:", tickMs: 15 });
  await engine.start();
  const t = engine.forTenant("default");
  t.clinical.record({
    entryType: "Patient",
    patientId: PATIENT,
    content: { resourceType: "Patient", identifier: [{ value: PATIENT }] },
    authorId: "adt",
    authorKind: "device",
  });
  const encounter = t.encounters.open({
    patientId: PATIENT,
    class: "in-person",
    reason: "Chest pain",
    by: DOCTOR,
    arrived: true,
  });
  return { engine, t, encounter, close: () => engine.stop() };
}

/** A result reported and never acknowledged: the commonest loose end there is. */
function unreadResult(t: ReturnType<Engine["forTenant"]>) {
  return t.orders.report({
    patientId: PATIENT,
    code: "2823-3",
    display: "Potassium",
    value: "6.9",
    unit: "mmol/L",
    abnormalFlag: "high",
    reportedBy: "Synthetic Regional Laboratory",
  });
}

test("the discharge list is taken from the chart, not asked for", async () => {
  const s = await clinic();
  try {
    const result = unreadResult(s.t);
    const { discharge, items } = s.t.discharges.open({
      encounterId: s.encounter.id,
      patientId: PATIENT,
      disposition: "home",
      accountableId: DOCTOR.actorId,
      by: DOCTOR,
    });

    assert.equal(discharge.status, "open");
    assert.equal(discharge.accountable_id, DOCTOR.actorId);

    const kinds = items.map((i) => i.kind).sort();
    // Nobody typed either of these. The potassium is unacknowledged and no
    // follow-up is booked, and both are facts about the chart.
    assert.deepEqual(kinds, ["no-follow-up", "unacknowledged-result"]);
    const unread = items.find((i) => i.kind === "unacknowledged-result")!;
    assert.equal(unread.reference_id, result.id);
    assert.match(unread.summary, /Potassium has not been acknowledged/);
  } finally {
    await s.close();
  }
});

test("a patient sent to hospital is not put on a clinic follow-up list", async () => {
  const s = await clinic();
  try {
    // Admitted: the follow-up is somebody else's, and raising one here puts
    // work on a list for a person who is not in the building.
    const { items } = s.t.discharges.open({
      encounterId: s.encounter.id,
      patientId: PATIENT,
      disposition: "admitted",
      accountableId: DOCTOR.actorId,
      by: DOCTOR,
    });
    assert.deepEqual(items.map((i) => i.kind), []);
  } finally {
    await s.close();
  }
});

test("closing a visit twice takes one snapshot", async () => {
  const s = await clinic();
  try {
    unreadResult(s.t);
    const first = s.t.discharges.open({
      encounterId: s.encounter.id,
      patientId: PATIENT,
      disposition: "home",
      accountableId: DOCTOR.actorId,
      by: DOCTOR,
    });
    const second = s.t.discharges.open({
      encounterId: s.encounter.id,
      patientId: PATIENT,
      disposition: "home",
      accountableId: NURSE.actorId,
      by: NURSE,
    });
    assert.equal(first.discharge.id, second.discharge.id);
    assert.equal(second.discharge.accountable_id, DOCTOR.actorId, "and the first snapshot stands");
    assert.equal(second.items.length, first.items.length, "two lists to reconcile is worse than one");
  } finally {
    await s.close();
  }
});

test("a discharge cannot be closed over something still outstanding", async () => {
  const s = await clinic();
  try {
    unreadResult(s.t);
    const { discharge, items } = s.t.discharges.open({
      encounterId: s.encounter.id,
      patientId: PATIENT,
      disposition: "home",
      accountableId: DOCTOR.actorId,
      by: DOCTOR,
    });

    // A button that makes the list go away is worse than no list: it produces
    // a record saying the follow-up was completed.
    assert.throws(
      () => s.t.discharges.close(discharge.id, { outcome: "all done", by: DOCTOR }),
      /2 item\(s\) are still outstanding/
    );

    for (const item of items) {
      assert.throws(
        () => s.t.discharges.resolve(item.id, { status: "resolved", resolution: "  ", by: DOCTOR }),
        /say what was done/
      );
    }
    s.t.discharges.resolve(items[0].id, {
      status: "resolved",
      resolution: "read and acted on; potassium repeated same day",
      by: DOCTOR,
    });
    s.t.discharges.resolve(items[1].id, {
      status: "not-needed",
      resolution: "patient is moving out of the region next week",
      by: DOCTOR,
    });

    const closed = s.t.discharges.close(discharge.id, { outcome: "followed up by telephone", by: DOCTOR });
    assert.equal(closed.status, "closed");
    // The snapshot survives its own resolution: the question asked later is
    // what was outstanding when this person went home.
    assert.equal(s.t.discharges.items(discharge.id).length, 2);
    assert.equal(s.t.discharges.items(discharge.id).filter((i) => i.status === "outstanding").length, 0);
  } finally {
    await s.close();
  }
});

test("one item is resolved once", async () => {
  const s = await clinic();
  try {
    unreadResult(s.t);
    const { items } = s.t.discharges.open({
      encounterId: s.encounter.id,
      patientId: PATIENT,
      disposition: "home",
      accountableId: DOCTOR.actorId,
      by: DOCTOR,
    });
    s.t.discharges.resolve(items[0].id, { status: "resolved", resolution: "acted on", by: DOCTOR });
    assert.throws(
      () => s.t.discharges.resolve(items[0].id, { status: "resolved", resolution: "acted on again", by: NURSE }),
      /already been resolved/
    );
  } finally {
    await s.close();
  }
});

/* ---------------------------------------------------------------- handoffs */

test("proposing a handoff does not move the work", async () => {
  const s = await clinic();
  try {
    const proposal = s.t.handoffs.propose({
      kind: "transfer",
      subjectKind: "discharge",
      subjectId: "d-1",
      patientId: PATIENT,
      fromId: DOCTOR.actorId,
      toId: NURSE.actorId,
      reason: "going on leave from Friday",
      by: DOCTOR,
    });
    assert.equal(proposal.status, "proposed");

    // Still the proposer's. This is the whole property: "I handed it over"
    // and "somebody has it" are different statements.
    const before = s.t.handoffs.accountableFor("discharge", "d-1", DOCTOR.actorId);
    assert.deepEqual(before, { ownerId: DOCTOR.actorId, via: "original", handoffId: null });
    assert.deepEqual(
      s.t.handoffs.unaccepted().map((h) => h.id),
      [proposal.id]
    );

    s.t.handoffs.accept(proposal.id, NURSE);
    const after = s.t.handoffs.accountableFor("discharge", "d-1", DOCTOR.actorId);
    assert.equal(after.ownerId, NURSE.actorId);
    assert.equal(after.via, "transfer");
    assert.deepEqual(s.t.handoffs.unaccepted(), []);
  } finally {
    await s.close();
  }
});

test("only the person it was offered to can answer it", async () => {
  const s = await clinic();
  try {
    const proposal = s.t.handoffs.propose({
      kind: "transfer",
      subjectKind: "discharge",
      subjectId: "d-1",
      fromId: DOCTOR.actorId,
      toId: NURSE.actorId,
      reason: "going on leave from Friday",
      by: DOCTOR,
    });
    // Not the proposer, and not a bystander: accepting on somebody's behalf
    // is how a list ends up with an owner who never agreed to it.
    assert.throws(() => s.t.handoffs.accept(proposal.id, DOCTOR), /only the person a handoff was offered to/);
    assert.throws(() => s.t.handoffs.accept(proposal.id, LOCUM), /only the person a handoff was offered to/);
    assert.throws(
      () => s.t.handoffs.decline(proposal.id, { ...LOCUM, reason: "not mine" }),
      /only the person a handoff was offered to/
    );
    // The proposer may take it back, which is a different act.
    const withdrawn = s.t.handoffs.withdraw(proposal.id, { ...DOCTOR, reason: "leave cancelled" });
    assert.equal(withdrawn.status, "withdrawn");
    assert.equal(s.t.handoffs.accountableFor("discharge", "d-1", DOCTOR.actorId).ownerId, DOCTOR.actorId);
  } finally {
    await s.close();
  }
});

test("a decline hands it back, and says why", async () => {
  const s = await clinic();
  try {
    const proposal = s.t.handoffs.propose({
      kind: "transfer",
      subjectKind: "discharge",
      subjectId: "d-1",
      fromId: DOCTOR.actorId,
      toId: NURSE.actorId,
      reason: "going on leave from Friday",
      by: DOCTOR,
    });
    assert.throws(() => s.t.handoffs.decline(proposal.id, { ...NURSE, reason: "  " }), /needs a reason/);

    const declined = s.t.handoffs.decline(proposal.id, { ...NURSE, reason: "I am off that week too" });
    assert.equal(declined.status, "declined");
    assert.equal(declined.response_reason, "I am off that week too");
    // Back where it always was. A decline is the system working, not a
    // failure state — the alternative is somebody accepting a list they
    // cannot cover.
    assert.equal(s.t.handoffs.accountableFor("discharge", "d-1", DOCTOR.actorId).ownerId, DOCTOR.actorId);
    // And the history is a record, so reassignment is not a guess.
    assert.deepEqual(
      s.t.handoffs.forSubject("discharge", "d-1").map((h) => h.status),
      ["declined"]
    );
  } finally {
    await s.close();
  }
});

test("one piece of work is offered to one person at a time", async () => {
  const s = await clinic();
  try {
    s.t.handoffs.propose({
      kind: "transfer",
      subjectKind: "discharge",
      subjectId: "d-1",
      fromId: DOCTOR.actorId,
      toId: NURSE.actorId,
      reason: "going on leave from Friday",
      by: DOCTOR,
    });
    // Two people each offered the same work can each accept it, and each
    // believe the other did not.
    assert.throws(
      () =>
        s.t.handoffs.propose({
          kind: "transfer",
          subjectKind: "discharge",
          subjectId: "d-1",
          fromId: DOCTOR.actorId,
          toId: LOCUM.actorId,
          reason: "trying somebody else",
          by: DOCTOR,
        }),
      /already been offered to somebody/
    );
  } finally {
    await s.close();
  }
});

test("coverage needs an end date, and hands itself back", async () => {
  const s = await clinic();
  try {
    assert.throws(
      () =>
        s.t.handoffs.propose({
          kind: "coverage",
          subjectKind: "discharge",
          subjectId: "d-1",
          fromId: DOCTOR.actorId,
          toId: LOCUM.actorId,
          reason: "annual leave",
          by: DOCTOR,
        }),
      /coverage needs an end date/
    );
    assert.throws(
      () =>
        s.t.handoffs.propose({
          kind: "coverage",
          subjectKind: "discharge",
          subjectId: "d-1",
          fromId: DOCTOR.actorId,
          toId: LOCUM.actorId,
          reason: "annual leave",
          coversUntil: "2020-01-01T00:00:00.000Z",
          by: DOCTOR,
        }),
      /already ended/
    );

    const from = new Date(Date.now() - 3600_000).toISOString();
    const until = new Date(Date.now() + 3600_000).toISOString();
    const cover = s.t.handoffs.propose({
      kind: "coverage",
      subjectKind: "discharge",
      subjectId: "d-1",
      fromId: DOCTOR.actorId,
      toId: LOCUM.actorId,
      reason: "annual leave",
      coversFrom: from,
      coversUntil: until,
      by: DOCTOR,
    });
    s.t.handoffs.accept(cover.id, LOCUM);

    // Inside the window the locum is holding it, and the record still says
    // whose list it is.
    const during = s.t.handoffs.accountableFor("discharge", "d-1", DOCTOR.actorId);
    assert.equal(during.ownerId, LOCUM.actorId);
    assert.equal(during.via, "coverage");
    assert.equal(during.covering, DOCTOR.actorId);
    assert.deepEqual(s.t.handoffs.activeCoverage().map((h) => h.id), [cover.id]);

    // After it, without anybody doing anything. That is what makes coverage
    // safe to grant: the locum who covered a list in March is not still
    // covering it in November.
    const later = new Date(Date.parse(until) + 60_000);
    const after = s.t.handoffs.accountableFor("discharge", "d-1", DOCTOR.actorId, later);
    assert.equal(after.ownerId, DOCTOR.actorId);
    assert.equal(after.via, "original");
    assert.deepEqual(s.t.handoffs.activeCoverage(later), []);
  } finally {
    await s.close();
  }
});

test("coverage sits on top of a transfer, not underneath it", async () => {
  const s = await clinic();
  try {
    const transfer = s.t.handoffs.propose({
      kind: "transfer",
      subjectKind: "discharge",
      subjectId: "d-1",
      fromId: DOCTOR.actorId,
      toId: NURSE.actorId,
      reason: "moving to her list",
      by: DOCTOR,
    });
    s.t.handoffs.accept(transfer.id, NURSE);

    const until = new Date(Date.now() + 3600_000).toISOString();
    const cover = s.t.handoffs.propose({
      kind: "coverage",
      subjectKind: "discharge",
      subjectId: "d-1",
      fromId: NURSE.actorId,
      toId: LOCUM.actorId,
      reason: "night shift",
      coversUntil: until,
      by: NURSE,
    });
    s.t.handoffs.accept(cover.id, LOCUM);

    const now = s.t.handoffs.accountableFor("discharge", "d-1", DOCTOR.actorId);
    assert.equal(now.ownerId, LOCUM.actorId);
    // Whose list it really is, which is the nurse's now and not the doctor's.
    assert.equal(now.covering, NURSE.actorId);

    const later = new Date(Date.parse(until) + 60_000);
    assert.equal(s.t.handoffs.accountableFor("discharge", "d-1", DOCTOR.actorId, later).ownerId, NURSE.actorId);
  } finally {
    await s.close();
  }
});

test("two people answering one offer leave one answer", async () => {
  const s = await clinic();
  try {
    const proposal = s.t.handoffs.propose({
      kind: "transfer",
      subjectKind: "discharge",
      subjectId: "d-1",
      fromId: DOCTOR.actorId,
      toId: NURSE.actorId,
      reason: "going on leave",
      by: DOCTOR,
    });
    s.t.handoffs.accept(proposal.id, NURSE);
    // The second finds nothing to change and is told so rather than
    // overwriting the first.
    assert.throws(() => s.t.handoffs.decline(proposal.id, { ...NURSE, reason: "changed my mind" }), /already accepted/);
    assert.equal(s.t.handoffs.get(proposal.id)!.status, "accepted");
  } finally {
    await s.close();
  }
});

/* -------------------------------------------------------------- the board */

test("the board shows what two people may each think the other is holding", async () => {
  const s = await clinic();
  try {
    unreadResult(s.t);
    const { discharge } = s.t.discharges.open({
      encounterId: s.encounter.id,
      patientId: PATIENT,
      disposition: "home",
      accountableId: DOCTOR.actorId,
      by: DOCTOR,
    });
    const proposal = s.t.handoffs.propose({
      kind: "transfer",
      subjectKind: "discharge",
      subjectId: discharge.id,
      patientId: PATIENT,
      fromId: DOCTOR.actorId,
      toId: NURSE.actorId,
      reason: "going on leave from Friday",
      by: DOCTOR,
    });

    const attention = s.t.board.attention();
    assert.deepEqual(attention.unacceptedHandoffs.rows.map((h) => h.id), [proposal.id]);
    assert.match(attention.unacceptedHandoffs.because, /still belongs to whoever offered it/);

    const [followUp] = attention.openFollowUps.rows;
    assert.equal(followUp.id, discharge.id);
    assert.equal(followUp.outstanding, 2, "and it says how much is loose, not just that it is open");
    assert.match(attention.openFollowUps.because, /the visit is over and something from it is not/);

    // Answered, and it leaves the queue.
    s.t.handoffs.accept(proposal.id, NURSE);
    assert.deepEqual(s.t.board.attention().unacceptedHandoffs.rows, []);
  } finally {
    await s.close();
  }
});

test("an offer nobody has answered for a while is its own question", async () => {
  const s = await clinic();
  try {
    const proposal = s.t.handoffs.propose({
      kind: "transfer",
      subjectKind: "discharge",
      subjectId: "d-1",
      fromId: DOCTOR.actorId,
      toId: NURSE.actorId,
      reason: "going on leave",
      by: DOCTOR,
    });
    // Fresh: on the list, but not yet stale.
    assert.equal(s.t.board.attention({ staleAfterHours: 4 }).unacceptedHandoffs.rows.length, 0);
    const later = new Date(Date.now() + 5 * 3600_000);
    assert.deepEqual(
      s.t.board.attention({ staleAfterHours: 4 }, later).unacceptedHandoffs.rows.map((h) => h.id),
      [proposal.id]
    );
  } finally {
    await s.close();
  }
});

test("one custodian's discharges and handoffs are not another's", async () => {
  const engine = new Engine({ dbPath: ":memory:", tickMs: 15 });
  await engine.start();
  try {
    engine.db.createTenant("south", "south", "south");
    const north = engine.forTenant("default");
    const south = engine.forTenant("south");

    north.clinical.record({
      entryType: "Patient",
      patientId: PATIENT,
      content: { resourceType: "Patient", identifier: [{ value: PATIENT }] },
      authorId: "adt",
      authorKind: "device",
    });
    const encounter = north.encounters.open({
      patientId: PATIENT,
      class: "in-person",
      reason: "Chest pain",
      by: DOCTOR,
      arrived: true,
    });
    north.discharges.open({
      encounterId: encounter.id,
      patientId: PATIENT,
      disposition: "home",
      accountableId: DOCTOR.actorId,
      by: DOCTOR,
    });
    north.handoffs.propose({
      kind: "transfer",
      subjectKind: "discharge",
      subjectId: "d-1",
      fromId: DOCTOR.actorId,
      toId: NURSE.actorId,
      reason: "going on leave",
      by: DOCTOR,
    });

    assert.equal(north.discharges.openFollowUps().length, 1);
    assert.equal(north.handoffs.unaccepted().length, 1);
    assert.deepEqual(south.discharges.openFollowUps(), []);
    assert.deepEqual(south.handoffs.unaccepted(), []);
    assert.equal(south.discharges.forEncounter(encounter.id), undefined);
    // And the southern site may offer the same subject id, because it is a
    // different subject.
    assert.doesNotThrow(() =>
      south.handoffs.propose({
        kind: "transfer",
        subjectKind: "discharge",
        subjectId: "d-1",
        fromId: "dr-south",
        toId: "rn-south",
        reason: "their own arrangement",
        by: { actorId: "dr-south", actorKind: "practitioner" },
      })
    );
  } finally {
    await engine.stop();
  }
});
