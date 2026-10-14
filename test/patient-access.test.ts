/**
 * A patient's own record, and who else may see it.
 *
 * Section 11 has two failures that nothing else here has, and they pull in
 * opposite directions.
 *
 * The first is delegated authority that never ends. A parent's access to a
 * child's chart is correct until a birthday and wrong afterwards — and nothing
 * about that day generates an event. No message arrives, no status changes, no
 * queue fills. The grant simply keeps working, and a sixteen-year-old's notes
 * stay readable by somebody no longer entitled to them, for years, with nobody
 * doing anything wrong. That is the first test, and it is the load-bearing one.
 *
 * The second is release timing. Immediate release is right — a patient waiting
 * a week for a normal result is the harm the rules were written against — but
 * "immediate, no exceptions" means learning of a cancer from a phone at eleven
 * at night with nobody to ask. The tests here require a hold to be bounded,
 * reasoned, attributed and, above all, *visible*: a silently withheld result
 * is indistinguishable from one that never came back.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../src/db.ts";
import { OrderStore } from "../src/orders/store.ts";
import { PatientAccess } from "../src/patient/access.ts";
import { TaskStore } from "../src/work/tasks.ts";

const CHILD = "NT-child";
const P = "NT123456";
const CLERK = { actorId: "registration-desk", actorKind: "practitioner" };
const GP = { actorId: "dr-tetso", actorKind: "practitioner" };
const PROXY = {
  permissions: ["summary", "results", "appointments", "messages", "access-log", "requests"] as const,
  purpose: "help the patient manage their care",
};

const YEAR = 365 * 86_400_000;
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();

function portal() {
  const dir = mkdtempSync(join(tmpdir(), "northstar-pa-"));
  const db = new Db(join(dir, "northstar.db"));
  const orders = new OrderStore(db);
  const tasks = new TaskStore(db);
  return {
    db,
    orders,
    tasks,
    pa: new PatientAccess(db, orders, tasks),
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}

function aResult(orders: OrderStore, patientId = P, display = "Potassium", value = "4.1") {
  const o = orders.create({
    patientId,
    category: "lab",
    code: "2823-3",
    display,
    indication: "Electrolyte check",
    by: GP,
  });
  orders.place(o.id, { ...GP, responsibleId: "dr-tetso" });
  return orders.report({ patientId, orderId: o.id, code: "2823-3", display, value, reportedBy: "analyser" });
}

test("a parent's access lapses on the day it was set to, with nothing having to run", () => {
  // The load-bearing test. Nothing about a sixteenth birthday generates an
  // event, so a grant checked against a status rather than a clock keeps
  // working forever — and the notes it keeps open are exactly the ones a
  // teenager most needs kept closed.
  const { pa, cleanup } = portal();
  try {
    const majority = new Date(Date.now() + 2 * YEAR).toISOString();
    const grant = pa.grantProxy({
      patientId: CHILD,
      subjectId: "parent-1",
      relationship: "parent-guardian",
      expiresAt: majority,
      by: CLERK,
      permissions: [...PROXY.permissions],
      purpose: "parent of a minor",
    });

    assert.ok(pa.may("parent-1", CHILD), "entitled today");
    // The birthday arrives. No sweep, no job, no status change.
    const dayAfter = new Date(new Date(majority).getTime() + 86_400_000).toISOString();
    assert.equal(pa.may("parent-1", CHILD, dayAfter), undefined, "and not entitled the day after");
    assert.equal(pa.whoCanSee(CHILD, dayAfter).length, 0);

    // The grant row is still there — the history of who was entitled when is
    // not something to delete — it simply is not authority any more.
    assert.equal(pa.authority(grant.id)!.revoked_at, null);
    assert.equal(pa.authority(grant.id)!.expires_at, majority);
  } finally {
    cleanup();
  }
});

test("delegated access without an expiry is refused, not defaulted", () => {
  // A default would be this module's guess written into the record as
  // somebody's decision — and the decision, when does this end, is the entire
  // safeguard.
  const { pa, cleanup } = portal();
  try {
    assert.throws(
      () =>
        pa.grantProxy({
          patientId: CHILD,
          subjectId: "parent-1",
          relationship: "parent-guardian",
          expiresAt: "",
          by: CLERK,
          permissions: [...PROXY.permissions],
          purpose: PROXY.purpose,
        }),
      /needs an expiry; an authority that never ends is the failure this guards against/
    );
    assert.throws(
      () =>
        pa.grantProxy({
          patientId: CHILD,
          subjectId: "parent-1",
          relationship: "parent-guardian",
          expiresAt: inDays(-1),
          by: CLERK,
          permissions: [...PROXY.permissions],
          purpose: PROXY.purpose,
        }),
      /already past/
    );
    assert.equal(pa.whoCanSee(CHILD).length, 0, "and nothing was written");

    // The patient's own access is the one grant that does not expire.
    const self = pa.grantSelf(P, "patient-marie", CLERK);
    assert.equal(self.expires_at, null);
    assert.ok(pa.may("patient-marie", P, new Date(Date.now() + 50 * YEAR).toISOString()));
  } finally {
    cleanup();
  }
});

test("a proxy grant names scope, purpose and expiry, and cannot delegate again", () => {
  const { pa, cleanup } = portal();
  try {
    assert.throws(
      () =>
        pa.grantProxy({
          patientId: CHILD,
          subjectId: "parent-1",
          relationship: "parent-guardian",
          expiresAt: inDays(30),
          by: CLERK,
          permissions: [],
          purpose: "appointments",
        }),
      /explicit permission/
    );
    assert.throws(
      () =>
        pa.grantProxy({
          patientId: CHILD,
          subjectId: "parent-1",
          relationship: "parent-guardian",
          expiresAt: inDays(30),
          by: CLERK,
          permissions: ["summary"],
          purpose: "  ",
        }),
      /needs a purpose/
    );
    assert.throws(
      () =>
        pa.grantProxy({
          patientId: CHILD,
          subjectId: "parent-1",
          relationship: "parent-guardian",
          expiresAt: inDays(30),
          by: CLERK,
          permissions: ["delegates"],
          purpose: "manage everyone else",
        }),
      /not allowed/
    );

    const grant = pa.grantProxy({
      patientId: CHILD,
      subjectId: "parent-1",
      relationship: "parent-guardian",
      expiresAt: inDays(30),
      by: CLERK,
      permissions: ["summary", "appointments"],
      purpose: "book and prepare for visits",
    });
    assert.equal(pa.allows(grant, "summary"), true);
    assert.equal(pa.allows(grant, "appointments"), true);
    assert.equal(pa.allows(grant, "results"), false, "appointments did not quietly become result access");
    assert.equal(pa.allows(grant, "delegates"), false);
    assert.deepEqual(pa.permissionsFor(grant), ["summary", "appointments"]);
    assert.equal(grant.purpose, "book and prepare for visits");
  } finally {
    cleanup();
  }
});

test("a grant about to lapse is surfaced, so renewal is a decision and not a discovery", () => {
  // A parent who still needs access to a disabled adult child's chart should
  // be asked, not silently cut off. And one who should not have it should
  // stop, on the day.
  const { pa, cleanup } = portal();
  try {
    pa.grantProxy({
      patientId: CHILD,
      subjectId: "soon",
      relationship: "parent-guardian",
      expiresAt: inDays(10),
      by: CLERK,
      permissions: [...PROXY.permissions],
      purpose: PROXY.purpose,
    });
    pa.grantProxy({
      patientId: CHILD,
      subjectId: "later",
      relationship: "representative",
      expiresAt: inDays(200),
      by: CLERK,
      permissions: [...PROXY.permissions],
      purpose: PROXY.purpose,
    });
    pa.grantSelf(P, "patient-marie", CLERK);

    assert.deepEqual(pa.expiring(30).map((a) => a.subject_id), ["soon"]);
    assert.equal(pa.expiring(365).length, 2);
    assert.equal(pa.expiring(1).length, 0);
  } finally {
    cleanup();
  }
});

test("access can be withdrawn early, with a reason", () => {
  const { pa, cleanup } = portal();
  try {
    const g = pa.grantProxy({
      patientId: P,
      subjectId: "ex-spouse",
      relationship: "representative",
      expiresAt: inDays(300),
      by: CLERK,
      permissions: [...PROXY.permissions],
      purpose: PROXY.purpose,
    });
    assert.ok(pa.may("ex-spouse", P));

    assert.throws(() => pa.revoke(g.id, { ...GP, reason: "" }), /needs a reason/);
    assert.ok(pa.may("ex-spouse", P), "the refusal left the access in place");

    pa.revoke(g.id, { ...GP, reason: "patient withdrew consent" });
    assert.equal(pa.may("ex-spouse", P), undefined);
    assert.match(pa.authority(g.id)!.revoke_reason!, /withdrew consent/);
    assert.throws(() => pa.revoke(g.id, { ...GP, reason: "again" }), /already revoked/);
  } finally {
    cleanup();
  }
});

test("results reach the patient immediately by default", () => {
  const { orders, pa, cleanup } = portal();
  try {
    const r = aResult(orders);
    const seen = pa.resultsFor(P);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].value, "4.1", "waiting a week for a normal result is the harm the rules were written against");
    assert.equal(seen[0].held, undefined);
    assert.equal(seen[0].resultId, r.id);
  } finally {
    cleanup();
  }
});

test("a held result is visible as held, never simply absent", () => {
  // The decision that matters. A silently withheld result is
  // indistinguishable from one that never came back, and the patient then has
  // no idea there is anything to ask about.
  const { orders, pa, cleanup } = portal();
  try {
    const r = aResult(orders, P, "Biopsy report", "Adenocarcinoma");
    pa.hold({
      resultId: r.id,
      category: "clinician-will-discuss",
      releaseAt: inDays(3),
      by: GP,
      reason: "malignancy; appointment booked Thursday",
    });

    const seen = pa.resultsFor(P);
    assert.equal(seen.length, 1, "it appears — the patient knows something is there");
    assert.equal(seen[0].display, "Biopsy report");
    assert.equal(seen[0].value, undefined, "and not the finding itself");
    assert.equal(seen[0].held!.because, "Your clinician will discuss this result with you.");
    assert.ok(seen[0].held!.until, "and when it lifts");

    // The clinical justification is not what the patient is shown.
    assert.ok(!JSON.stringify(seen).includes("malignancy"));
    assert.equal(pa.activeHolds().length, 1, "and no hold is forgotten");
  } finally {
    cleanup();
  }
});

test("a hold ends by the clock, with nothing having to run", () => {
  const { orders, pa, cleanup } = portal();
  try {
    const r = aResult(orders, P, "Biopsy report", "Adenocarcinoma");
    const until = inDays(3);
    pa.hold({ resultId: r.id, category: "clinician-will-discuss", releaseAt: until, by: GP, reason: "appointment Thursday" });

    assert.equal(pa.resultsFor(P)[0].value, undefined);
    const after = new Date(new Date(until).getTime() + 1000).toISOString();
    assert.equal(pa.resultsFor(P, after)[0].value, "Adenocarcinoma", "released by the clock");
    assert.equal(pa.activeHolds(after).length, 0);
  } finally {
    cleanup();
  }
});

test("a hold needs an end and a reason, and can be lifted early", () => {
  const { orders, pa, cleanup } = portal();
  try {
    const r = aResult(orders);
    assert.throws(
      () => pa.hold({ resultId: r.id, category: "clinician-will-discuss", releaseAt: "", by: GP, reason: "x" }),
      /a hold needs an end; a result held indefinitely is a result withheld/
    );
    assert.throws(
      () => pa.hold({ resultId: r.id, category: "clinician-will-discuss", releaseAt: inDays(3), by: GP, reason: " " }),
      /needs a reason/
    );
    assert.throws(
      () => pa.hold({ resultId: r.id, category: "clinician-will-discuss", releaseAt: inDays(-1), by: GP, reason: "x" }),
      /already past/
    );
    assert.equal(pa.resultsFor(P)[0].value, "4.1", "and none of those refusals held anything");

    pa.hold({ resultId: r.id, category: "clinician-will-discuss", releaseAt: inDays(3), by: GP, reason: "discussing" });
    assert.equal(pa.resultsFor(P)[0].value, undefined);

    // Once the conversation has happened, the hold has no further purpose.
    pa.release(r.id, GP);
    assert.equal(pa.resultsFor(P)[0].value, "4.1");
    assert.equal(pa.activeHolds().length, 0);
  } finally {
    cleanup();
  }
});

test("a corrected result reaches the patient as the correction, not the old value", () => {
  const { orders, pa, cleanup } = portal();
  try {
    const first = aResult(orders);
    orders.correct(first.id, { value: "7.1", abnormalFlag: "critical-high", reportedBy: "analyser" });

    const seen = pa.resultsFor(P);
    assert.equal(seen.length, 1, "one result, not two");
    assert.equal(seen[0].value, "7.1");
    assert.equal(seen[0].abnormalFlag, "critical-high");
  } finally {
    cleanup();
  }
});

test("a patient can see who looked at their record, proxies included", () => {
  // "My ex-husband opened my chart four times last month" is exactly what a
  // patient has a right to find out, and it is unanswerable if a proxy's
  // reads are logged as the patient's own.
  const { pa, cleanup } = portal();
  try {
    pa.logAccess({ patientId: P, subjectId: "patient-marie", relationship: "self", action: "view-chart", outcome: "allowed" });
    pa.logAccess({
      patientId: P,
      subjectId: "ex-spouse",
      relationship: "representative",
      action: "view-chart",
      outcome: "allowed",
      resource: "Composition",
    });
    pa.logAccess({
      patientId: P,
      subjectId: "ex-spouse",
      relationship: "representative",
      action: "view-chart",
      outcome: "refused",
      detail: "authority expired",
    });

    const log = pa.accessLog(P);
    assert.equal(log.length, 3);
    assert.equal(log[0].outcome, "refused", "including the ones turned away");
    assert.equal(log[0].subject_id, "ex-spouse");
    assert.equal(
      log.filter((e) => e.relationship === "representative").length,
      2,
      "a proxy's reads are the proxy's, not the patient's"
    );
  } finally {
    cleanup();
  }
});

test("an access or correction request is a receipt for the patient and work for the clinic", () => {
  const { pa, tasks, cleanup } = portal();
  try {
    const correction = pa.submitRequest({
      patientId: P,
      kind: "correction",
      target: "Medication metformin",
      detail: "The dose shown is 500 mg; I take 1000 mg at supper.",
      by: { subjectId: "patient-marie", relationship: "self" },
    });
    assert.equal(correction.status, "submitted");
    assert.equal(correction.target, "Medication metformin");
    assert.equal(tasks.unassigned({ kind: "privacy-request" })[0].correlation_id, correction.id);

    const completed = pa.completeRequest(correction.id, {
      ...CLERK,
      outcome: "clinician reviewed; medication amended to 1000 mg at supper",
    });
    assert.equal(completed.status, "completed");
    assert.match(completed.outcome ?? "", /amended/);
    assert.equal(tasks.get(correction.task_id)?.status, "completed");
    assert.equal(pa.requestsFor(P)[0].id, correction.id, "the patient keeps the receipt");

    assert.throws(
      () =>
        pa.submitRequest({
          patientId: P,
          kind: "correction",
          detail: "Something is wrong.",
          by: { subjectId: "patient-marie", relationship: "self" },
        }),
      /identify what/
    );
  } finally {
    cleanup();
  }
});

test("authority and holds are confined to their tenant", () => {
  const dir = mkdtempSync(join(tmpdir(), "northstar-pa-iso-"));
  const root = new Db(join(dir, "northstar.db"));
  try {
    root.createTenant("north", "Northern Health");
    root.createTenant("south", "Southern Health");
    const nOrders = new OrderStore(root.forTenant("north"));
    const north = new PatientAccess(root.forTenant("north"), nOrders);
    const south = new PatientAccess(root.forTenant("south"), new OrderStore(root.forTenant("south")));

    north.grantProxy({
      patientId: P,
      subjectId: "parent-1",
      relationship: "parent-guardian",
      expiresAt: inDays(300),
      by: CLERK,
      permissions: [...PROXY.permissions],
      purpose: PROXY.purpose,
    });
    const r = aResult(nOrders);
    north.hold({ resultId: r.id, category: "clinician-will-discuss", releaseAt: inDays(3), by: GP, reason: "x" });

    assert.ok(north.may("parent-1", P));
    assert.equal(south.may("parent-1", P), undefined, "a grant at one custodian is not authority at another");
    assert.equal(south.whoCanSee(P).length, 0);
    assert.equal(south.expiring(365).length, 0);
    assert.equal(south.activeHolds().length, 0);
    assert.equal(south.resultsFor(P).length, 0);
    assert.equal(north.resultsFor(P).length, 1);
  } finally {
    root.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
