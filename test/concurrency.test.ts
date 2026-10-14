/**
 * Two people doing the same thing at the same time.
 *
 * This engine is single-threaded and its stores are synchronous, so two calls
 * inside one process cannot interleave: a check and the act that follows it
 * are atomic by construction, and it is tempting to stop there. That
 * reasoning holds only as far as the process boundary. The database file is
 * opened by the backup tool, by the reading station, by a second node during
 * a migration rehearsal, and by whatever an operator runs at three in the
 * morning — and a guarantee that rests on there being exactly one writer is
 * not a guarantee, it is an assumption with good manners.
 *
 * So each test here opens a second connection to the same database and does
 * the same act twice. That is the shape of the real hazard, and it tests the
 * durable guarantee — what the database itself will refuse — rather than the
 * process-local one. What must never happen is two plausible successes: two
 * clinicians each told their acknowledgement was recorded, with the record
 * holding only the second.
 *
 * Every write under test is now conditional on the state its check read: the
 * update names the status it expects, and a write that changes no rows is a
 * refusal rather than a silent no-op.
 *
 * ## What these tests do and do not reach
 *
 * Be clear about which half is covered, because the shape of the mechanism
 * makes it easy to write something that looks like coverage and is not.
 *
 * Covered, and checked by removing each guard to confirm the test fails
 * without it: that a transition and its event row commit together or not at
 * all, and that the approval chain cannot fork. Both are real defects that
 * were present and are now absent.
 *
 * The sequential double-act tests below — acknowledging twice, completing a
 * reconciliation twice, booking a taken seat — assert the refusal a second
 * caller gets. They exercise the stores' own state checks, which already
 * worked; removing the conditional predicates from the SQL does not fail
 * them, because the check inside the transaction refuses first. They are
 * regression tests for behaviour that matters, not evidence for the new
 * predicates.
 *
 * The predicates themselves are defense in depth against a writer whose read
 * happened before another writer's commit. This runtime cannot produce that:
 * the stores are synchronous, so two calls in one process cannot interleave,
 * and two connections that each read and write inside one transaction are
 * already separated by SQLite's own isolation. A test claiming to exercise
 * them would have to drive the SQL itself, which asserts SQLite's semantics
 * rather than anything here. So they are kept, cheap and correct, and this
 * paragraph is the honest statement of what has not been demonstrated.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../src/db.ts";
import { OrderStore } from "../src/orders/store.ts";
import { ReferralStore } from "../src/work/referrals.ts";
import { MedicationStore } from "../src/meds/store.ts";
import { Schedule } from "../src/schedule/store.ts";
import { Directory } from "../src/directory/store.ts";
import { ScoreGovernance } from "../src/clinical/score-governance.ts";

const P = "NT123456";
const GP = { actorId: "dr-tetso", actorKind: "practitioner" };
const RESIDENT = { actorId: "dr-hale", actorKind: "practitioner" };

/** Two connections onto one database, as two processes would have. */
function site() {
  const dir = mkdtempSync(join(tmpdir(), "northstar-race-"));
  const path = join(dir, "northstar.db");
  const a = new Db(path);
  const b = new Db(path);
  return {
    a,
    b,
    cleanup: () => {
      a.close();
      b.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}

/** Runs the same act on both connections; expects one success, one refusal. */
function bothTry<T>(first: () => T, second: () => T): { winner: T; refusal: Error } {
  const winner = first();
  let refusal: Error | undefined;
  try {
    second();
  } catch (err) {
    refusal = err as Error;
  }
  assert.ok(refusal, "the second act succeeded as well; that is two plausible successes");
  return { winner, refusal: refusal! };
}

// ── Acknowledging a result ────────────────────────────────────────────────

test("two clinicians acknowledging one result leave one acknowledgement", () => {
  // The ordinary case, not the exotic one: a critical potassium is on two
  // screens and both people act. The unconditional write recorded the second
  // over the first, so what the first clinician said they did was gone.
  const s = site();
  try {
    const first = new OrderStore(s.a);
    const second = new OrderStore(s.b);
    const order = first.create({
      patientId: P, category: "lab", code: "2823-3", display: "Potassium",
      indication: "Electrolytes", by: GP,
    });
    first.place(order.id, { ...GP, responsibleId: "dr-tetso" });
    const result = first.report({
      patientId: P, code: "2823-3", display: "Potassium", value: "7.1",
      unit: "mmol/L", referenceRange: "3.5-5.0", reportedBy: "analyser-3", orderId: order.id,
    });

    const { refusal } = bothTry(
      () => first.acknowledge(result.id, { ...GP, action: "phoned the ward; repeat urgently" }),
      () => second.acknowledge(result.id, { ...RESIDENT, action: "reviewed, no action" }),
    );
    assert.match(refusal.message, /already been acknowledged/);

    // The first clinician's action is what survives, and there is one of them.
    const row = first.result(result.id)!;
    assert.equal(row.acknowledged_by, "dr-tetso");
    assert.match(row.acknowledgement_action ?? "", /phoned the ward/);
  } finally {
    s.cleanup();
  }
});

// ── Referral transitions ──────────────────────────────────────────────────

test("a referral's status and its event log commit together, or not at all", () => {
  // The transition was two writes outside any transaction: the status moved,
  // then the event was appended. A failure between them left a referral in a
  // state its own history did not account for — and the history is what a
  // stalled-referral review reads.
  const s = site();
  try {
    const store = new ReferralStore(s.a);
    const referral = store.create({
      patientId: P, fromService: "family-practice", toService: "cardiology",
      indication: "new atrial fibrillation", by: GP,
    });
    store.send(referral.id, { ...GP, respondBy: "2026-12-01T00:00:00.000Z" });

    const before = store.get(referral.id)!.status;
    const events = store.history(referral.id).length;

    // Force the event insert to fail partway through the transition.
    const original = s.a.sql.prepare.bind(s.a.sql);
    let armed = true;
    (s.a.sql as unknown as { prepare: typeof original }).prepare = ((sql: string) => {
      if (armed && sql.includes("INSERT INTO referral_events")) {
        armed = false;
        throw new Error("disk gave out mid-transition");
      }
      return original(sql);
    }) as typeof original;

    assert.throws(() => store.acknowledge(referral.id, { ...GP, triageBy: "2026-12-05T00:00:00.000Z" }));
    (s.a.sql as unknown as { prepare: typeof original }).prepare = original;

    // Neither half survived.
    assert.equal(store.get(referral.id)!.status, before, "the status rolled back with the event");
    assert.equal(store.history(referral.id).length, events, "no orphaned event either");
  } finally {
    s.cleanup();
  }
});

// ── Completing a medication reconciliation ────────────────────────────────

test("two clinicians completing one reconciliation leave one completion", () => {
  // The checks were outside the transaction and the write did not name the
  // state they had read, so both passed the guard and both wrote.
  const s = site();
  try {
    const first = new MedicationStore(s.a);
    const second = new MedicationStore(s.b);
    const rec = first.startReconciliation({ patientId: P, transition: "admission", by: GP });

    const { refusal } = bothTry(
      () => first.completeReconciliation(rec.id, GP),
      () => second.completeReconciliation(rec.id, RESIDENT),
    );
    assert.match(refusal.message, /already completed/);

    const row = first.reconciliation(rec.id)!;
    assert.equal(row.status, "completed");
    assert.equal(row.completed_by, "dr-tetso", "the first completion is the one on the record");
  } finally {
    s.cleanup();
  }
});

// ── Booking a slot ────────────────────────────────────────────────────────

test("two patients booked into a one-seat slot leave one booking", () => {
  const s = site();
  try {
    const first = new Schedule(s.a);
    const second = new Schedule(s.b);
    const slot = first.openSlot({
      resourceId: "dr-tetso", service: "family-practice",
      startsAt: "2026-12-01T15:00:00.000Z", endsAt: "2026-12-01T15:15:00.000Z",
      capacity: 1,
    });

    const { refusal } = bothTry(
      () => first.book({ slotId: slot.id, patientId: P, reason: "follow-up", by: GP }),
      () => second.book({ slotId: slot.id, patientId: "NT999999", reason: "follow-up", by: GP }),
    );
    assert.ok(/full|UNIQUE|constraint/i.test(refusal.message), `unexpected refusal: ${refusal.message}`);

    const live = first.liveBookings(slot.id);
    assert.equal(live.length, 1, "one seat, one booking");
    assert.equal(live[0].patient_id, P);
  } finally {
    s.cleanup();
  }
});

// ── Approving a score ─────────────────────────────────────────────────────

test("a score cannot acquire two current approvals", () => {
  // Two approvals in sequence are a renewal and entirely legitimate: the
  // second supersedes the first and the chain stays linear. A fork is two
  // decisions that each believe they are the first, which is what two writers
  // who both read an unapproved score would produce — and it would leave no
  // way to say which approval governed a result already sent out.
  const s = site();
  try {
    new Directory(s.a).addPractitioner({ id: "dr-tetso", family: "Tetso", given: "Jean" });
    const gov = new ScoreGovernance(s.a);
    const approval = {
      scoreId: "curb-65" as const,
      clinicalOwnerId: "dr-tetso",
      reviewDue: "2027-01-01",
      reason: "reviewed against the published instrument",
      by: { id: "ops", kind: "apikey" },
    };
    gov.approve(approval);

    // A renewal is fine and does not fork.
    gov.approve({ ...approval, reviewDue: "2028-01-01", reason: "annual review completed, renewed" });
    assert.equal(gov.history("curb-65").length, 2);
    assert.equal(gov.state("curb-65").status, "current");

    // A second root is not. This is what the racing writer would insert.
    assert.throws(
      () =>
        s.b.sql
          .prepare(
            `INSERT INTO score_approvals
               (tenant_id, id, score_id, implementation_version, decision, reason,
                clinical_owner_id, clinical_owner_display, review_due,
                recorded_by_id, recorded_by_kind, supersedes, recorded_at)
             VALUES ('default', 'second-root', 'curb-65', 'v', 'approved', 'a simultaneous first approval',
                     'dr-tetso', 'Jean Tetso', '2027-01-01', 'ops', 'apikey', NULL, ?)`
          )
          .run(new Date().toISOString()),
      /UNIQUE|constraint/i,
    );
    assert.equal(gov.history("curb-65").length, 2, "the chain is unchanged");
  } finally {
    s.cleanup();
  }
});

test("two decisions cannot supersede the same one", () => {
  const s = site();
  try {
    new Directory(s.a).addPractitioner({ id: "dr-tetso", family: "Tetso", given: "Jean" });
    const gov = new ScoreGovernance(s.a);
    gov.approve({
      scoreId: "curb-65", clinicalOwnerId: "dr-tetso", reviewDue: "2027-01-01",
      reason: "reviewed against the published instrument", by: { id: "ops", kind: "apikey" },
    });
    const root = gov.history("curb-65")[0];

    // Two withdrawals racing, each having read the same approval as current.
    const write = (id: string) =>
      s.a.sql
        .prepare(
          `INSERT INTO score_approvals
             (tenant_id, id, score_id, implementation_version, decision, reason,
              clinical_owner_id, clinical_owner_display, review_due,
              recorded_by_id, recorded_by_kind, supersedes, recorded_at)
           VALUES (?, ?, 'curb-65', 'v', 'disabled', 'withdrawn for review', NULL, NULL, NULL, 'ops', 'apikey', ?, ?)`
        )
        .run("default", id, root.id, new Date().toISOString());

    write("first-withdrawal");
    assert.throws(() => write("second-withdrawal"), /UNIQUE|constraint/i);

    assert.equal(gov.history("curb-65").length, 2, "the chain stays linear");
    assert.equal(gov.state("curb-65").status, "disabled");
  } finally {
    s.cleanup();
  }
});

// ── The property, stated once ─────────────────────────────────────────────

test("a refused second act changes nothing at all", () => {
  // A refusal that had already written half of something would be worse than
  // a silent overwrite, because it looks like nothing happened.
  const s = site();
  try {
    const first = new MedicationStore(s.a);
    const second = new MedicationStore(s.b);
    const rec = first.startReconciliation({ patientId: P, transition: "admission", by: GP });
    first.completeReconciliation(rec.id, GP);

    const before = first.reconciliation(rec.id)!;
    assert.throws(() => second.completeReconciliation(rec.id, RESIDENT));
    const after = first.reconciliation(rec.id)!;
    assert.deepEqual(after, before, "the refused act left the row exactly as it was");
  } finally {
    s.cleanup();
  }
});
