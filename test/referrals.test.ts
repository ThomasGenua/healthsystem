/**
 * Referral loops that cannot close themselves by going quiet.
 *
 * The failure section 9 guards against is silence. A referral nobody
 * acknowledged looks exactly like one proceeding normally; so does one
 * accepted eight months ago and never reported on. No error is raised, nobody
 * did anything wrong, and the patient was not seen. "We sent it" is not a
 * defence, and a system that cannot tell those apart is what makes it one.
 *
 * So the tests that matter here are about time passing without anything
 * happening, and about the two ways a loop is quietly lost: a redirect that
 * restarts the clock, and a close with nothing recorded.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../src/db.ts";
import { ReferralStore } from "../src/work/referrals.ts";

function clinic(): { db: Db; refs: ReferralStore; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "portage-refs-"));
  const db = new Db(join(dir, "portage.db"));
  return {
    db,
    refs: new ReferralStore(db),
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const GP = { actorId: "dr-tetso", actorKind: "practitioner" };
const ORTHO = { actorId: "ortho-intake", actorKind: "practitioner" };

const BASE = {
  patientId: "NT123456",
  fromService: "Yellowknife Primary Care",
  toService: "Stanton Orthopaedics",
  indication: "Mechanical knee pain, failed 12 weeks conservative management",
  by: GP,
};

const PAST = "2020-01-01T00:00:00Z";
const FUTURE = "2099-01-01T00:00:00Z";

test("a referral nobody acknowledged shows up as stalled", () => {
  // The commonest silent failure: sent, and then nothing. Without an
  // expectation there is no such thing as late, and it simply sits.
  const { refs, cleanup } = clinic();
  try {
    const r = refs.create(BASE);
    refs.send(r.id, { ...GP, respondBy: PAST });

    const stalled = refs.stalled();
    assert.equal(stalled.length, 1);
    assert.equal(stalled[0].id, r.id);
    assert.equal(stalled[0].status, "sent", "still sent, which is exactly the problem");
  } finally {
    cleanup();
  }
});

test("each step resets what is expected next, so lateness is about the current step", () => {
  const { refs, cleanup } = clinic();
  try {
    const r = refs.create(BASE);
    refs.send(r.id, { ...GP, respondBy: PAST });
    assert.equal(refs.stalled().length, 1);

    // Acknowledged in time — now triage is what is owed.
    refs.acknowledge(r.id, { ...ORTHO, triageBy: FUTURE });
    assert.equal(refs.stalled().length, 0, "the previous lateness is answered");

    refs.triage(r.id, { accept: true, bookBy: PAST }, ORTHO);
    assert.equal(refs.stalled().length, 1, "and now the booking is late");
    assert.equal(refs.stalled()[0].status, "accepted");
  } finally {
    cleanup();
  }
});

test("an appointment that passed with no report is stalled", () => {
  // The loop that is hardest to see: everything happened, on time, until the
  // last step — and the last step is the one the referrer is waiting on.
  const { refs, cleanup } = clinic();
  try {
    const r = refs.create(BASE);
    refs.send(r.id, { ...GP, respondBy: FUTURE });
    refs.acknowledge(r.id, { ...ORTHO, triageBy: FUTURE });
    refs.triage(r.id, { accept: true, bookBy: FUTURE }, ORTHO);
    refs.book(r.id, PAST, ORTHO);

    assert.deepEqual(refs.stalled().map((x) => x.status), ["booked"], "the appointment date came and went");

    refs.seen(r.id, { ...ORTHO, reportBy: PAST });
    assert.deepEqual(refs.stalled().map((x) => x.status), ["seen"], "seen, and no report");

    refs.report(r.id, { ...ORTHO, reference: "consult-note-88" });
    assert.equal(refs.stalled().length, 0);
  } finally {
    cleanup();
  }
});

test("closing requires an outcome", () => {
  // A referral closed with nothing recorded is indistinguishable, afterwards,
  // from one abandoned.
  const { refs, cleanup } = clinic();
  try {
    const r = refs.create(BASE);
    refs.send(r.id, { ...GP, respondBy: FUTURE });
    assert.throws(() => refs.close(r.id, { ...GP, outcome: "  " }), /needs an outcome/);
    assert.equal(refs.get(r.id)!.status, "sent", "and a refused close leaves it open");

    refs.close(r.id, { ...GP, outcome: "Seen 14 Aug, arthroscopy listed" });
    const closed = refs.get(r.id)!;
    assert.equal(closed.status, "closed");
    assert.match(closed.outcome ?? "", /arthroscopy listed/);
    assert.ok(closed.closed_at);
    assert.equal(refs.stalled().length, 0, "and a closed loop is not chased");
  } finally {
    cleanup();
  }
});

test("sending without the documents the service requires is refused", () => {
  // A referral triaged as incomplete goes round again with the patient
  // waiting through both circuits, which is the wait nobody counts.
  const { refs, cleanup } = clinic();
  try {
    const r = refs.create({ ...BASE, requiredDocuments: ["knee x-ray report", "medication list"] });
    assert.throws(
      () => refs.send(r.id, { ...GP, respondBy: FUTURE }),
      /missing required document\(s\): knee x-ray report, medication list/
    );

    refs.attach(r.id, "knee x-ray report", GP);
    assert.throws(() => refs.send(r.id, { ...GP, respondBy: FUTURE }), /missing required document\(s\): medication list/);

    refs.attach(r.id, "medication list", GP);
    assert.equal(refs.send(r.id, { ...GP, respondBy: FUTURE }).status, "sent");
  } finally {
    cleanup();
  }
});

test("a referral without an indication is refused", () => {
  // A receiving service triages on the indication; without one the referral
  // waits at routine regardless of why it was actually sent.
  const { refs, cleanup } = clinic();
  try {
    assert.throws(() => refs.create({ ...BASE, indication: "   " }), /needs a clinical indication/);
  } finally {
    cleanup();
  }
});

test("declining is terminal and carries a reason the sender can act on", () => {
  // A declined referral whose reason the sender never sees is one they send
  // again, unchanged.
  const { refs, cleanup } = clinic();
  try {
    const r = refs.create(BASE);
    refs.send(r.id, { ...GP, respondBy: FUTURE });
    assert.throws(() => refs.triage(r.id, { accept: false, reason: "" }, ORTHO), /needs a reason/);

    refs.triage(r.id, { accept: false, reason: "Refer to physiotherapy first; see pathway 4b" }, ORTHO);
    const declined = refs.get(r.id)!;
    assert.equal(declined.status, "declined");
    assert.match(refs.history(r.id).at(-1)!.detail ?? "", /pathway 4b/);
    assert.equal(refs.stalled().length, 0, "a decline closes the loop rather than leaving it open");
  } finally {
    cleanup();
  }
});

test("a redirect keeps the loop, so the wait already served still counts", () => {
  // The quietest way a loop is lost. Cancelling and starting again resets the
  // clock, and the wait-time report then says the system is performing well
  // while the patient has been waiting since spring.
  const { refs, cleanup } = clinic();
  try {
    const first = refs.create({ ...BASE, requiredDocuments: ["knee x-ray report"] });
    refs.attach(first.id, "knee x-ray report", GP);
    refs.send(first.id, { ...GP, respondBy: FUTURE });

    const second = refs.redirect(first.id, "Edmonton Orthopaedics", {
      ...ORTHO,
      reason: "out of catchment for this procedure",
      respondBy: FUTURE,
    });

    assert.equal(second.correlation_id, first.correlation_id, "one question, two referrals");
    assert.equal(second.status, "sent", "and it is already on its way");
    assert.equal(second.to_service, "Edmonton Orthopaedics");
    assert.deepEqual(
      JSON.parse(second.attached_documents ?? "[]"),
      ["knee x-ray report"],
      "documents travel: making the clinic re-attach the imaging is how a redirect adds a week"
    );

    const loop = refs.loop(first.correlation_id);
    assert.equal(loop.length, 2);
    assert.equal(loop[0].status, "closed");
    assert.match(loop[0].outcome ?? "", /redirected to Edmonton/);
  } finally {
    cleanup();
  }
});

test("wait time is measured across the whole loop, not from the latest hop", () => {
  // Measuring from the current referral restarts the count every time a
  // service passes the patient on.
  const { db, refs, cleanup } = clinic();
  try {
    const first = refs.create(BASE);
    refs.send(first.id, { ...GP, respondBy: FUTURE });
    // Age the first referral by a hundred days.
    db.sql
      .prepare("UPDATE referrals SET created_at = datetime('now', '-100 days') WHERE id = ?")
      .run(first.id);

    refs.redirect(first.id, "Edmonton Orthopaedics", { ...ORTHO, reason: "out of catchment", respondBy: FUTURE });

    const days = refs.waitDays(first.correlation_id)!;
    assert.ok(days >= 99, `the patient has waited ${days} days, not since the redirect`);
  } finally {
    cleanup();
  }
});

test("the whole path is on the record, with who moved it", () => {
  const { refs, cleanup } = clinic();
  try {
    const r = refs.create(BASE);
    refs.send(r.id, { ...GP, respondBy: FUTURE });
    refs.acknowledge(r.id, { ...ORTHO, triageBy: FUTURE });
    refs.triage(r.id, { accept: true, bookBy: FUTURE, priority: "urgent" }, ORTHO);
    refs.book(r.id, FUTURE, ORTHO);

    assert.deepEqual(
      refs.history(r.id).map((e) => e.event),
      ["created", "sent", "acknowledged", "accepted", "booked"]
    );
    assert.equal(refs.get(r.id)!.priority, "urgent", "triage may raise the priority the sender asked for");
    assert.equal(refs.history(r.id)[2].actor_id, "ortho-intake", "and it says who, not just what");
  } finally {
    cleanup();
  }
});

test("transitions out of order are refused rather than silently accepted", () => {
  const { refs, cleanup } = clinic();
  try {
    const r = refs.create(BASE);
    assert.throws(() => refs.acknowledge(r.id, { ...ORTHO, triageBy: FUTURE }), /only a sent referral/);
    assert.throws(() => refs.book(r.id, FUTURE, ORTHO), /a draft referral cannot be booked/);

    refs.send(r.id, { ...GP, respondBy: FUTURE });
    assert.throws(() => refs.send(r.id, { ...GP, respondBy: FUTURE }), /a sent referral cannot be sent again/);
    assert.throws(() => refs.seen(r.id, { ...ORTHO, reportBy: FUTURE }), /a sent referral cannot be marked seen/);
  } finally {
    cleanup();
  }
});

test("a cancelled referral stays on the record and is not chased", () => {
  const { db, refs, cleanup } = clinic();
  try {
    const r = refs.create(BASE);
    refs.send(r.id, { ...GP, respondBy: PAST });
    assert.equal(refs.stalled().length, 1);

    refs.cancel(r.id, { ...GP, reason: "patient moved to Alberta" });
    assert.equal(refs.stalled().length, 0);
    assert.equal((db.sql.prepare("SELECT COUNT(*) AS n FROM referrals").get() as { n: number }).n, 1);
    assert.match(refs.history(r.id).at(-1)!.detail ?? "", /moved to Alberta/);
    assert.throws(() => refs.close(r.id, { ...GP, outcome: "x" }), /already cancelled/);
  } finally {
    cleanup();
  }
});

test("referrals are confined to their tenant", () => {
  const dir = mkdtempSync(join(tmpdir(), "portage-refs-iso-"));
  const root = new Db(join(dir, "portage.db"));
  try {
    root.createTenant("north", "Northern Health");
    root.createTenant("south", "Southern Health");
    const north = new ReferralStore(root.forTenant("north"));
    const south = new ReferralStore(root.forTenant("south"));

    const n = north.create(BASE);
    north.send(n.id, { ...GP, respondBy: PAST });
    south.create({ ...BASE, toService: "Southern Orthopaedics" });

    assert.equal(north.stalled().length, 1);
    assert.equal(south.stalled().length, 0, "one custodian's overdue work is not another's");
    assert.equal(south.get(n.id), undefined);
    assert.throws(() => south.close(n.id, { ...GP, outcome: "reaching" }), /no referral/);
    assert.equal(north.forPatient("NT123456").length, 1);
  } finally {
    root.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("closing a loop needs a reason as much as an outcome does", () => {
  // Both terminal paths take something away from a clinician who is waiting.
  // A cancellation with nothing recorded reads, months later, exactly like a
  // referral that was quietly dropped — and the difference is whether anyone
  // decided.
  const { refs, cleanup } = clinic();
  try {
    const r = refs.create(BASE);
    refs.send(r.id, { ...GP, respondBy: FUTURE });

    assert.throws(() => refs.cancel(r.id, { ...GP, reason: "" }), /needs a reason/);
    assert.throws(() => refs.cancel(r.id, { ...GP, reason: "   " }), /needs a reason/, "whitespace is not a reason");
    assert.equal(refs.get(r.id)!.status, "sent", "and the refusal left it open, still on the chase list");

    refs.cancel(r.id, { ...GP, reason: "patient declined referral after discussion" });
    assert.match(refs.history(r.id).at(-1)!.detail ?? "", /declined referral after discussion/);
  } finally {
    cleanup();
  }
});

test("a report cannot land on a loop that is already closed", () => {
  // The cancellation and the appointment crossed: the clinic saw the patient
  // anyway. Marking the referral reported would say the loop completed
  // normally, and the discrepancy — a consultation nobody expected — is the
  // thing worth someone's attention. Refused here so it surfaces there.
  //
  // The report itself is not lost by this: consultation findings belong in the
  // chart, which is a separate record and does not require a live referral.
  const { refs, cleanup } = clinic();
  try {
    const r = refs.create(BASE);
    refs.send(r.id, { ...GP, respondBy: FUTURE });
    refs.cancel(r.id, { ...GP, reason: "patient moved to Alberta" });

    assert.throws(
      () => refs.report(r.id, { ...ORTHO, reference: "consult-note-88" }),
      /cancelled referral cannot receive a report/
    );
    assert.equal(refs.get(r.id)!.status, "cancelled", "the loop stays closed rather than reopening itself");
    assert.equal(
      refs.history(r.id).filter((e) => e.event === "reported").length,
      0,
      "and nothing on the record claims it completed"
    );
  } finally {
    cleanup();
  }
});

test("a terminal referral is never chased, deadline or no deadline", () => {
  // Two independent conditions, and this one covers the second. No path
  // through the API leaves a closed referral holding a deadline today —
  // every terminal transition clears it — so this reaches under the API to
  // build the row that would result if one ever stopped doing that.
  //
  // Worth pinning because the cost is asymmetric: a chase list padded with
  // work already done is one a clinician learns to skim, and skimming it is
  // how the genuinely stalled referral underneath goes unseen.
  const { db, refs, cleanup } = clinic();
  try {
    const live = refs.create(BASE);
    refs.send(live.id, { ...GP, respondBy: PAST });

    const done = refs.create({ ...BASE, toService: "Stanton Rheumatology" });
    refs.send(done.id, { ...GP, respondBy: FUTURE });
    refs.close(done.id, { ...GP, outcome: "seen and discharged" });
    db.sql.prepare("UPDATE referrals SET expected_by = ? WHERE id = ?").run(PAST, done.id);

    const stalled = refs.stalled();
    assert.deepEqual(
      stalled.map((x) => x.id),
      [live.id],
      "only the one still open is owed something"
    );
    assert.equal(refs.get(done.id)!.expected_by, PAST, "the setup really did leave a past deadline on it");
  } finally {
    cleanup();
  }
});
