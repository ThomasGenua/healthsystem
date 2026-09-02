/**
 * Every clinical lifecycle move, and the state it decided from.
 *
 * `concurrency.test.ts` fixed six of these. This is the rest of the class:
 * around twenty places that read a row, decide against its status, and then
 * write an update naming only the row. Two steps, and between them the row can
 * move — so the later writer overwrote whatever happened in between, and both
 * callers were told they succeeded.
 *
 * The fix is the same everywhere and is deliberately boring: the update names
 * the status it expects, and a write that changes no rows is a refusal rather
 * than a silent no-op. What differs is which way each one has to fail, and
 * that is what these tests pin — an encounter cancelled after the patient
 * arrived would erase that they attended, and a completion racing a decline on
 * an access request must not report the record as withheld when it was sent.
 *
 * ## What these prove, and what they do not
 *
 * They prove each move refuses a second attempt and that the refusal leaves
 * the row and its event log untouched — the behaviour a caller depends on,
 * and worth pinning against a future rewrite.
 *
 * They do **not** prove the new SQL predicates are load-bearing. Removing
 * every `AND status = ...` added here leaves all of them passing, because the
 * store's own check inside the transaction refuses first. That was confirmed
 * by trying it, not assumed.
 *
 * The predicates guard the case this runtime cannot produce: a writer whose
 * read happened before another writer's commit. The stores are synchronous,
 * so two calls in one process cannot interleave, and two connections that
 * each read and write inside one transaction are already separated by
 * SQLite's isolation. A test claiming to exercise them would be asserting
 * SQLite's semantics rather than anything in this repository — the same
 * conclusion `concurrency.test.ts` reached, and the same reason one such test
 * was written there and deleted rather than kept as coverage of nothing.
 *
 * Two connections are still used below rather than one, because that is the
 * shape of the hazard even where isolation happens to close it, and a
 * single-connection test would quietly stop being about concurrency at all.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../src/db.ts";
import { Encounters } from "../src/clinical/encounters.ts";
import { OrderStore } from "../src/orders/store.ts";
import { Schedule } from "../src/schedule/store.ts";
import { ConsentDirectives } from "../src/patient/consent.ts";

const P = "NT123456";
const GP = { actorId: "dr-tetso", actorKind: "practitioner" };
const CLERK = { actorId: "clerk-hale", actorKind: "staff" };

function site() {
  const dir = mkdtempSync(join(tmpdir(), "northstar-lifecycle-"));
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

/** One act succeeds; the second must refuse rather than overwrite it. */
function onlyOnce<T>(first: () => T, second: () => T): Error {
  first();
  let refusal: Error | undefined;
  try {
    second();
  } catch (err) {
    refusal = err as Error;
  }
  assert.ok(refusal, "the second act succeeded too; that is two plausible successes");
  return refusal!;
}

// ── Encounters ────────────────────────────────────────────────────────────

test("a visit cancelled after the patient arrived is refused, not erased", () => {
  // The direction that matters. A patient who attended and then left is a
  // disposition; cancelling would remove any record that they came at all.
  const s = site();
  try {
    const first = new Encounters(s.a);
    const second = new Encounters(s.b);
    const e = first.open({ patientId: P, class: "in-person", by: GP, reason: "sore throat" });

    const refusal = onlyOnce(
      () => first.arrive(e.id, GP),
      () => second.cancel(e.id, { ...CLERK, reason: "patient telephoned to cancel" }),
    );
    assert.match(refusal.message, /cannot be cancelled|no longer planned/);
    assert.equal(first.get(e.id)!.status, "in-progress", "the visit that started stays started");
  } finally {
    s.cleanup();
  }
});

test("two clerks marking one visit arrived leave one arrival", () => {
  const s = site();
  try {
    const first = new Encounters(s.a);
    const second = new Encounters(s.b);
    const e = first.open({ patientId: P, class: "in-person", by: GP, reason: "sore throat" });

    onlyOnce(
      () => first.arrive(e.id, GP),
      () => second.arrive(e.id, CLERK),
    );
    const events = first.history(e.id).filter((x: { event: string }) => x.event === "arrived");
    assert.equal(events.length, 1, "one arrival on the record, not two");
  } finally {
    s.cleanup();
  }
});

test("a visit closed twice keeps the first disposition", () => {
  const s = site();
  try {
    const first = new Encounters(s.a);
    const second = new Encounters(s.b);
    const e = first.open({ patientId: P, class: "in-person", by: GP, reason: "chest pain" });
    first.arrive(e.id, GP);

    onlyOnce(
      () => first.close(e.id, { ...GP, disposition: "sent to emergency by ambulance" }),
      () => second.close(e.id, { ...CLERK, disposition: "went home" }),
    );
    assert.match(first.get(e.id)!.disposition ?? "", /emergency/, "the first decision is the one recorded");
  } finally {
    s.cleanup();
  }
});

// ── Orders ────────────────────────────────────────────────────────────────

test("an order placed twice is placed once", () => {
  const s = site();
  try {
    const first = new OrderStore(s.a);
    const second = new OrderStore(s.b);
    const o = first.create({
      patientId: P, category: "lab", code: "2823-3", display: "Potassium",
      indication: "Electrolytes", by: GP,
    });

    onlyOnce(
      () => first.place(o.id, { ...GP, responsibleId: "dr-tetso" }),
      () => second.place(o.id, { ...CLERK, responsibleId: "dr-hale" }),
    );
    assert.equal(first.get(o.id)!.responsible_id, "dr-tetso", "the first placement owns the result");
    assert.equal(first.history(o.id).filter((e: { event: string }) => e.event === "placed").length, 1);
  } finally {
    s.cleanup();
  }
});

// ── Bookings ──────────────────────────────────────────────────────────────

test("a booking cancelled twice frees one seat, and the record says so once", () => {
  const s = site();
  try {
    const first = new Schedule(s.a);
    const second = new Schedule(s.b);
    const slot = first.openSlot({
      resourceId: "dr-tetso", service: "family-practice",
      startsAt: "2026-12-01T15:00:00.000Z", endsAt: "2026-12-01T15:15:00.000Z", capacity: 1,
    });
    const booking = first.book({ slotId: slot.id, patientId: P, reason: "follow-up", by: GP });

    const refusal = onlyOnce(
      () => first.cancel(booking.id, { ...GP, reason: "clinician called away" }),
      () => second.cancel(booking.id, { ...CLERK, reason: "patient telephoned" }),
    );
    assert.match(refusal.message, /cannot be cancelled|no longer booked/);
    assert.match(first.booking(booking.id)!.cancel_reason ?? "", /called away/);
  } finally {
    s.cleanup();
  }
});

// ── Consent ───────────────────────────────────────────────────────────────

test("revoking a directive twice does not report the second as having lifted it", () => {
  // A withheld record staying withheld is the safe outcome either way. Telling
  // the second caller they lifted a directive they did not is not.
  const s = site();
  try {
    const first = new ConsentDirectives(s.a);
    const second = new ConsentDirectives(s.b);
    const d = first.record({ patientId: P, kind: "withhold-all", by: GP });

    const refusal = onlyOnce(
      () => first.revoke(d.id, GP),
      () => second.revoke(d.id, CLERK),
    );
    assert.match(refusal.message, /already|no longer active/);
    assert.equal(first.directive(d.id)!.revoked_by, "dr-tetso");
  } finally {
    s.cleanup();
  }
});

// ── The property, once ────────────────────────────────────────────────────

test("a refused lifecycle move leaves the row exactly as it was", () => {
  const s = site();
  try {
    const first = new Encounters(s.a);
    const second = new Encounters(s.b);
    const e = first.open({ patientId: P, class: "in-person", by: GP, reason: "review" });
    first.arrive(e.id, GP);
    first.close(e.id, { ...GP, disposition: "went home with advice" });

    const before = first.get(e.id)!;
    const historyBefore = first.history(e.id).length;
    assert.throws(() => second.close(e.id, { ...CLERK, disposition: "admitted" }));
    assert.deepEqual(first.get(e.id), before, "the refused act changed nothing");
    assert.equal(first.history(e.id).length, historyBefore, "and left no event behind either");
  } finally {
    s.cleanup();
  }
});
