/**
 * Opening a database an earlier version created.
 *
 * `CREATE TABLE IF NOT EXISTS` does nothing to a table that already exists, so
 * a column added to the schema string never reaches an existing database. The
 * shape of that failure is what makes it dangerous: the open succeeds, the
 * engine reports itself healthy, and the first ingest throws `no such column`.
 * A site that was running fine goes off the air at upgrade and stays there.
 *
 * Every other test starts from an empty file, so none of them can see it.
 * These start from the real v0.3.0 table definitions instead.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../src/db.ts";
import { ClinicalRecord } from "../src/clinical/record.ts";
import { MedicationStore } from "../src/meds/store.ts";
import { OrderStore } from "../src/orders/store.ts";
import { ReferralStore } from "../src/work/referrals.ts";
import { Schedule } from "../src/schedule/store.ts";

const ACTOR = { actorId: "dr-tetso", actorKind: "practitioner" };

/** messages and deliveries as v0.3.0 defined them, before retention existed. */
const V030 = `
CREATE TABLE messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  channel_id TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  source_type TEXT NOT NULL,
  content_type TEXT NOT NULL,
  raw TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'received',
  error TEXT,
  meta TEXT,
  hash TEXT NOT NULL,
  prev_hash TEXT
);
CREATE TABLE deliveries (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  destination_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  ordering_key TEXT NOT NULL,
  ordered INTEGER NOT NULL DEFAULT 0,
  skip_on_dead INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 8,
  next_attempt_at INTEGER NOT NULL,
  payload TEXT NOT NULL,
  content_type TEXT NOT NULL,
  last_error TEXT,
  ack TEXT,
  delivered_at TEXT
);
`;

function legacyDb(): { dir: string; path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "portage-v030-"));
  const path = join(dir, "portage.db");
  const old = new DatabaseSync(path);
  old.exec("PRAGMA journal_mode = WAL;");
  old.exec(V030);
  old.close();
  return { dir, path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("a database from before retention existed is brought up to the current schema", () => {
  const { path, cleanup } = legacyDb();
  try {
    const db = new Db(path);
    const columns = (table: string) =>
      (db.sql.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);

    assert.ok(columns("messages").includes("raw_digest"));
    assert.ok(columns("messages").includes("redacted_at"));
    assert.ok(columns("deliveries").includes("redacted_at"));
    db.close();
  } finally {
    cleanup();
  }
});

test("and it keeps working — the failure was on the first ingest, not on open", () => {
  // The point of the fix. Opening always worked; that was the problem.
  const { path, cleanup } = legacyDb();
  try {
    const db = new Db(path);
    db.upsertChannel("c", "c", true, "{}");

    const msg = db.insertMessage("c", "test", "text/plain", "after the upgrade");
    assert.equal(db.verifyChain("c").ok, true);
    db.enqueueDelivery({
      messageId: msg.id,
      channelId: "c",
      destinationId: "d",
      seq: msg.seq,
      ordered: true,
      skipOnDead: false,
      maxAttempts: 8,
      payload: "after the upgrade",
      contentType: "text/plain",
    });
    assert.equal(db.listDeliveries({ channelId: "c" }).length, 1);
    assert.deepEqual(db.redactBefore("2099-01-01T00:00:00Z"), { messages: 1, deliveries: 0, steps: 0 });
    db.close();
  } finally {
    cleanup();
  }
});

test("rows written before the digest column verify by the older formula", () => {
  // An upgraded database has a chain whose early links committed to the
  // payload itself and whose later ones commit to its digest. Both have to
  // verify, or an upgrade would look like tampering.
  const { path, cleanup } = legacyDb();
  try {
    // A v0.3.0 row: the hash commits to the payload itself, and there is no
    // digest column to record one in. The channel tip is carried the same way
    // it always was.
    {
      const old = new DatabaseSync(path);
      old.exec(`CREATE TABLE channels (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
        config TEXT NOT NULL, last_hash TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );`);
      const raw = "legacy message";
      const hash = createHash("sha256").update("").update("|").update("c").update("|").update(raw).digest("hex");
      old.prepare("INSERT INTO channels (id, name, config, last_hash) VALUES ('c', 'c', '{}', ?)").run(hash);
      old
        .prepare(
          `INSERT INTO messages (id, channel_id, source_type, content_type, raw, hash, prev_hash)
           VALUES ('legacy-1', 'c', 'test', 'text/plain', ?, ?, NULL)`
        )
        .run(raw, hash);
      old.close();
    }

    const db = new Db(path);
    assert.equal(db.verifyChain("c").ok, true, "the pre-upgrade link must still verify");

    // A new row lands on top of it and the whole chain still holds.
    db.insertMessage("c", "test", "text/plain", "post-upgrade message");
    const chain = db.verifyChain("c");
    assert.equal(chain.ok, true, "and the chain must survive the join between the two formulas");
    assert.equal(chain.checked, 2);
    db.close();
  } finally {
    cleanup();
  }
});

test("an upgraded database can hold two custodians with the same channel id", () => {
  // The rebuild path for keys that were unique across the whole database. On
  // an upgraded node these tables keep their old shape unless something
  // rewrites them, and the failure is quiet: the second custodian's
  // upsertChannel hits the conflict and does nothing, so their feed reports
  // success and does not exist.
  const { path, cleanup } = legacyDb();
  try {
    {
      const old = new DatabaseSync(path);
      old.exec(`CREATE TABLE channels (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        config TEXT NOT NULL,
        last_hash TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );`);
      old.prepare("INSERT INTO channels (id, name, config) VALUES ('adt', 'admissions', '{}')").run();
      old.close();
    }

    const db = new Db(path);
    // What was already there belongs to the default tenant and survives.
    assert.equal(db.listChannels().length, 1);
    assert.equal(db.getChannel("adt")!.name, "admissions");

    db.createTenant("north", "Northern Health");
    db.createTenant("south", "Southern Health");
    db.forTenant("north").upsertChannel("adt", "north admissions", true, "{}");
    db.forTenant("south").upsertChannel("adt", "south admissions", true, "{}");

    assert.equal(db.forTenant("north").getChannel("adt")!.name, "north admissions");
    assert.equal(db.forTenant("south").getChannel("adt")!.name, "south admissions", "and neither took the name");
    db.close();
  } finally {
    cleanup();
  }
});

test("migrating twice is a no-op, so every boot is not a schema change", () => {
  const { path, cleanup } = legacyDb();
  const names = (db: Db) =>
    (db.sql.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>).map((c) => c.name);
  try {
    const first = new Db(path);
    const after = names(first);
    first.close();
    // Named rather than counted: comparing two opens to each other would hold
    // just as well if neither had migrated at all.
    assert.ok(after.includes("raw_digest") && after.includes("redacted_at"), "the first open must have migrated");

    const second = new Db(path);
    assert.deepEqual(names(second), after, "and the second must find nothing left to do");
    second.close();
  } finally {
    cleanup();
  }
});

test("a v0.3.0 database upgrades into the whole clinical platform, usable", () => {
  // Fifteen tables arrived after v0.3.0 — the chart, medications, allergies,
  // orders, results, referrals, tasks, the schedule, patient authority. They
  // are created by CREATE TABLE IF NOT EXISTS, which is the easy half.
  //
  // The half worth testing is that the result is usable rather than merely
  // present. Indexes are applied after the migration rather than with the
  // tables, tenant_id is added by ALTER for tables that predate it and is
  // already there for tables that do not, and the scheduler's guarantee is a
  // partial unique index that has to exist on an upgraded database exactly as
  // it does on a fresh one. An upgrade that produced tables without their
  // constraints would be worse than one that failed to open: the site runs,
  // and double-books.
  const { path, cleanup } = legacyDb();
  try {
    // A message in the old shape, so the upgrade is carrying real rows.
    const old = new DatabaseSync(path);
    old
      .prepare(
        `INSERT INTO messages (id, channel_id, source_type, content_type, raw, hash)
         VALUES ('m1', 'adt', 'test', 'text/plain', 'MSH|old', 'deadbeef')`
      )
      .run();
    old.close();

    const db = new Db(path);
    try {
      assert.equal(db.listMessages({ channelId: "adt" }).length, 1, "the old row survived");

      const record = new ClinicalRecord(db);
      const meds = new MedicationStore(db);
      const orders = new OrderStore(db);
      const referrals = new ReferralStore(db);
      const schedule = new Schedule(db);

      record.record({
        entryType: "Patient",
        patientId: "NT123456",
        content: { resourceType: "Patient", identifier: [{ system: "urn:jhn", value: "NT123456" }], name: [{ family: "Beaulieu" }] },
        authorId: "adt-feed",
        authorKind: "device",
      });
      meds.recordAllergy({ patientId: "NT123456", display: "Penicillin", ingredient: "penicillin", criticality: "high", by: ACTOR });
      const o = orders.create({
        patientId: "NT123456",
        category: "lab",
        code: "2823-3",
        display: "Potassium",
        indication: "Electrolyte check",
        by: ACTOR,
      });
      orders.place(o.id, { ...ACTOR, responsibleId: "dr-tetso" });
      orders.report({ patientId: "NT123456", orderId: o.id, code: "2823-3", display: "Potassium", value: "7.1", reportedBy: "lab" });
      referrals.create({
        patientId: "NT123456",
        fromService: "Primary Care",
        toService: "Nephrology",
        indication: "Rising potassium",
        by: ACTOR,
      });

      assert.equal(record.verifyChart("NT123456").ok, true, "the chart chain works on an upgraded database");
      assert.equal(meds.allergyStatus("NT123456"), "documented");
      assert.equal(orders.unacknowledged().length, 1);
      assert.equal(referrals.open().length, 1);
      assert.equal(record.patientIndex.search({ identifier: "NT123456" }).length, 1, "and the derived index too");

      // The scheduler's guarantee is an index, so it has to have been applied.
      const slot = schedule.openSlot({
        resourceId: "dr-tetso",
        service: "General practice",
        startsAt: "2026-07-01T09:00:00Z",
        endsAt: "2026-07-01T09:15:00Z",
      });
      schedule.book({ slotId: slot.id, patientId: "NT123456", reason: "Review", by: ACTOR });
      assert.throws(
        () =>
          db.sql
            .prepare(
              `INSERT INTO schedule_bookings
                 (tenant_id, id, slot_id, patient_id, seat, status, reason, priority, booked_by, booked_at, created_at)
               VALUES ('default', 'raced', ?, 'NT999', 0, 'booked', 'raced in', 'routine', 'x', 'y', 'z')`
            )
            .run(slot.id),
        /UNIQUE constraint failed/,
        "an upgrade that produced tables without their constraints runs, and double-books"
      );

      // And the tenancy the whole platform rests on reached the new tables.
      db.createTenant("north", "Northern Health");
      const north = new ClinicalRecord(db.forTenant("north"));
      assert.equal(north.chart("NT123456").length, 0, "the upgraded rows are the default tenant's, not everyone's");
    } finally {
      db.close();
    }
  } finally {
    cleanup();
  }
});
