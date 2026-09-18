/**
 * That the handoff record decides every list it should, and no list it should not.
 *
 * `TaskStore.inbox` consulted the record; `OrderStore.unacknowledged` did
 * not, and the gap between them was a clinician on leave holding every
 * outstanding result while the colleague who accepted their patients held
 * none. Both were wired by hand and nothing failed when the second was
 * missed — so these are the tests that make the third one impossible to
 * miss, by reading the schema and the source rather than trusting a list.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { OWNER_COLUMNS } from "../src/work/ownership.ts";

const here = new URL(".", import.meta.url).pathname;
const src = join(here, "..", "src");

/** Every .ts file under src/, read once. */
function sources(dir = src, out: Array<{ path: string; text: string }> = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) sources(p, out);
    else if (e.name.endsWith(".ts")) out.push({ path: p, text: readFileSync(p, "utf8") });
  }
  return out;
}
const ALL = sources();
const SCHEMA = readFileSync(join(src, "db.ts"), "utf8");

/** A column that names a person who holds work, as the schema spells them. */
const OWNERISH = /^\s*(owner_id|accountable_id|responsible_id|assigned_to|held_by)\b/;

test("every column in the schema that names a holder of work is accounted for", () => {
  // The guard that outlasts this change. A table that grows an owner column
  // later must say whether a handoff moves it; saying nothing is what let
  // orders sit unrouted while tasks were fixed.
  const found = new Set<string>();
  let table = "";
  for (const line of SCHEMA.split("\n")) {
    const t = /CREATE TABLE IF NOT EXISTS (\w+)/.exec(line);
    if (t) table = t[1];
    const c = OWNERISH.exec(line);
    if (c && table) found.add(`${table}.${c[1]}`);
  }
  const listed = new Set(OWNER_COLUMNS.map((o) => `${o.table}.${o.column}`));

  assert.deepEqual(
    [...found].filter((f) => !listed.has(f)).sort(),
    [],
    "this column names somebody who holds work; say in src/work/ownership.ts whether a handoff moves it"
  );
  assert.deepEqual(
    [...listed].filter((l) => !found.has(l)).sort(),
    [],
    "this entry names a column the schema no longer has"
  );
  assert.ok(found.size >= 7, "the scanner found suspiciously few columns; check the pattern still matches");
});

test("each entry either routes or says why not, never both and never neither", () => {
  for (const o of OWNER_COLUMNS) {
    const where = `${o.table}.${o.column}`;
    assert.equal(
      Boolean(o.subjectKind) !== Boolean(o.reason),
      true,
      `${where}: give it a subjectKind or a reason, not both and not neither`
    );
    if (o.reason) assert.ok(o.reason.length > 40, `${where}: "why not" has to be a reason somebody can disagree with`);
  }
});

test("a column that claims to route is actually consulted", () => {
  // A registry entry is a claim. This is what makes it evidence: the subject
  // kind has to appear in a real effectiveOwners() call somewhere in src/.
  for (const o of OWNER_COLUMNS.filter((x) => x.subjectKind)) {
    const consulted = ALL.some((f) => f.text.includes(`effectiveOwners("${o.subjectKind}"`));
    assert.ok(
      consulted,
      `${o.table}.${o.column} claims to route as "${o.subjectKind}", but nothing calls effectiveOwners("${o.subjectKind}")`
    );
  }
});

test("a column excused from routing is not used to build somebody's list", () => {
  // Every exclusion rests on one fact: nothing reads the column to assemble
  // a worklist. The moment a SELECT filters by it that stops being true, and
  // the excuse has to expire by itself rather than wait to be noticed.
  for (const o of OWNER_COLUMNS.filter((x) => x.reason)) {
    for (const f of ALL) {
      for (const stmt of f.text.match(/prepare\(\s*`[^`]*`/gs) ?? []) {
        if (!/\bSELECT\b/i.test(stmt)) continue;
        if (!new RegExp(`\\b${o.column}\\s*=\\s*\\?`).test(stmt)) continue;
        // Table-aware, because `owner_id` belongs to more than one table and
        // a guard that cries wolf is one people learn to route around.
        if (!new RegExp(`\\b${o.table}\\b`).test(stmt)) continue;
        assert.fail(
          `${f.path.replace(src, "src")} selects from ${o.table} filtered by ${o.column}, so that column does ` +
            `decide somebody's list. Route it through the handoff record, because the reason given for ` +
            `${o.table}.${o.column} in src/work/ownership.ts is no longer true.`
        );
      }
    }
  }
});

// --- what the routing actually does -------------------------------------

/**
 * Dr Aput hands their work to Dr Beaulieu and goes on leave.
 *
 * Written from the probe that found this. Before it, the task moved and the
 * critical potassium did not: `unacknowledged` for Dr Aput was 1 and for Dr
 * Beaulieu 0, so a result of 7.1 sat on the list of somebody who was not
 * there, and the colleague who had accepted accountability saw nothing.
 */
import { Engine } from "../src/core/engine.ts";

const A = "dr-aput";
const B = "dr-beaulieu";
const P = "NT123456";
const by = { actorId: A, actorKind: "practitioner" };
const accepts = { actorId: B, actorKind: "practitioner" };

async function clinic() {
  const engine = new Engine({ dbPath: ":memory:", tickMs: 50, orderDispatchIntervalMs: 0 });
  await engine.start();
  const t = engine.forTenant("default");
  t.clinical.record({
    entryType: "Patient",
    patientId: P,
    content: { resourceType: "Patient", id: P, identifier: [{ system: "JHN", value: P }] },
    authorId: "reg",
    authorKind: "system",
    source: "test",
  });
  const order = t.orders.create({
    patientId: P, category: "lab", code: "2823-3", display: "Potassium",
    indication: "on spironolactone", by,
  });
  t.orders.place(order.id, { ...by, responsibleId: A });
  const critical = () =>
    t.orders.report({
      orderId: order.id, patientId: P, code: "2823-3", display: "Potassium", value: "7.1",
      unit: "mmol/L", abnormalFlag: "critical-high", resultStatus: "final", reportedBy: "Stanton Laboratory",
    });
  const hand = (kind: "transfer" | "coverage", extra: { coversUntil?: string } = {}) => {
    const h = t.handoffs.propose({
      kind, subjectKind: "order", subjectId: order.id, patientId: P,
      fromId: A, toId: B, reason: "going on leave", by, ...extra,
    });
    t.handoffs.accept(h.id, accepts);
    return h;
  };
  return { engine, t, orderId: order.id, critical, hand, done: () => engine.stop() };
}

test("a critical result follows the clinician who accepted the patient", async () => {
  const c = await clinic();
  try {
    c.hand("transfer");
    c.critical();
    assert.equal(c.t.orders.unacknowledged({ responsibleId: B }).length, 1, "Dr Beaulieu, who is here");
    assert.equal(c.t.orders.unacknowledged({ responsibleId: A }).length, 0, "not Dr Aput, who is not");
  } finally {
    await c.done();
  }
});

test("the order still records who placed it", async () => {
  // The column is not rewritten on accept. It says who the work started
  // with; the handoff record says whose it is today. One place to look when
  // the two would have disagreed.
  const c = await clinic();
  try {
    c.hand("transfer");
    assert.equal(c.t.orders.get(c.orderId)!.responsible_id, A);
    assert.deepEqual(c.t.orders.responsibleFor(c.orderId), { responsibleId: B, via: "transfer" });
  } finally {
    await c.done();
  }
});

test("coverage reverts by arithmetic, with no sweep to fail", async () => {
  // A locum covers a list until Friday. Nothing runs on Friday: the window
  // simply stops matching, so there is no job whose failure leaves somebody
  // holding a list they stopped watching.
  const c = await clinic();
  try {
    const until = new Date(Date.now() + 60_000).toISOString();
    c.hand("coverage", { coversUntil: until });
    c.critical();
    assert.equal(c.t.orders.unacknowledged({ responsibleId: B }).length, 1, "covered now");

    const after = new Date(Date.parse(until) + 1000);
    assert.equal(c.t.orders.unacknowledged({ responsibleId: B, asOf: after }).length, 0, "not after it ends");
    assert.equal(c.t.orders.unacknowledged({ responsibleId: A, asOf: after }).length, 1, "back where it was");
    assert.equal(c.t.orders.responsibleFor(c.orderId, after).via, "original");
  } finally {
    await c.done();
  }
});

test("a reply a clinician owes follows the handoff too", async () => {
  // The one the guard found rather than a person: PatientMessaging.inbox
  // filtered by owner_id, so a patient waiting on an answer was waiting on
  // somebody who had handed their work over.
  const c = await clinic();
  try {
    const { thread } = c.t.messaging.open({
      patientId: P,
      subject: "Is my potassium result back?",
      body: "Asking after Tuesday's blood test.",
      authorKind: "patient",
      by: { actorId: P, actorKind: "patient" },
    });
    c.t.messaging.assign(thread.id, A, { ...by, reason: "mine to answer" });
    assert.equal(c.t.messaging.inbox(A).length, 1);

    const h = c.t.handoffs.propose({
      kind: "transfer", subjectKind: "thread", subjectId: thread.id, patientId: P,
      fromId: A, toId: B, reason: "going on leave", by,
    });
    c.t.handoffs.accept(h.id, accepts);

    assert.equal(c.t.messaging.inbox(B).length, 1, "owed by whoever accepted it");
    assert.equal(c.t.messaging.inbox(A).length, 0, "not by somebody on leave");
  } finally {
    await c.done();
  }
});

test("with no handoffs in a deployment, every list answers from its column exactly as before", async () => {
  // The whole mechanism is inert until somebody hands something over, which
  // is what makes this safe to add under existing callers.
  const c = await clinic();
  try {
    c.critical();
    assert.equal(c.t.orders.unacknowledged({ responsibleId: A }).length, 1);
    assert.equal(c.t.orders.unacknowledged({ responsibleId: B }).length, 0);
    assert.deepEqual(c.t.orders.responsibleFor(c.orderId), { responsibleId: A, via: "original" });
  } finally {
    await c.done();
  }
});
