/**
 * Restoring a snapshot, and whether what comes back is usable.
 *
 * `test/backup.test.ts` proves a snapshot is taken consistently and verifies
 * before it is reported. That is the write half. Every claim on the read half
 * was untested, and the difference matters more than it sounds: a verified
 * snapshot proves the bytes hashed correctly when they were written. It says
 * nothing about whether the file opens somewhere else, whether the migration
 * runs against it, whether an engine comes up, or whether the guarantees the
 * database is supposed to carry survived the trip.
 *
 * So these start from a snapshot and end at a working system, and the
 * assertions are about *use* rather than about opening. Two of them exist
 * because writing them turned up real defects — the inherited instance lock
 * and the read-only preflight — neither of which could be seen from a restore
 * onto the machine that took the backup, which is the only kind anyone had
 * ever done.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, copyFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../src/db.ts";
import { takeBackup } from "../src/core/backup.ts";
import { restore, latestSnapshot, TargetInUse } from "../src/core/restore.ts";
import { ClinicalRecord } from "../src/clinical/record.ts";
import { Schedule } from "../src/schedule/store.ts";
import { AuditStore } from "../src/audit/store.ts";

const P = "NT123456";
const CLERK = { actorId: "clerk", actorKind: "staff" };
const MORNING = {
  resourceId: "dr-tetso",
  service: "General practice",
  startsAt: "2026-07-01T09:00:00Z",
  endsAt: "2026-07-01T09:15:00Z",
};

/** A site with something worth losing: traffic, a chart, an audit trail, a booking. */
async function siteWithHistory(): Promise<{
  dir: string;
  dbPath: string;
  snapshot: string;
  slotId: string;
  cleanup: () => void;
}> {
  const dir = mkdtempSync(join(tmpdir(), "northstar-restore-"));
  const dbPath = join(dir, "data", "northstar.db");
  const db = new Db(dbPath);

  db.upsertChannel("adt", "admissions", true, "{}");
  for (let i = 0; i < 5; i++) db.insertMessage("adt", "mllp", "text/plain", `MSH|^~\\&|WOLF|YK|${i}`);

  new ClinicalRecord(db).record({
    entryType: "Patient",
    patientId: P,
    content: {
      resourceType: "Patient",
      identifier: [{ system: "urn:jhn", value: P }],
      name: [{ family: "Beaulieu", given: ["Marie"] }],
    },
    authorId: "adt-feed",
    authorKind: "device",
  });
  new AuditStore(db).record({
    principalId: "dr-tetso",
    principalKind: "practitioner",
    method: "GET",
    path: "/api/clinical/chart",
    action: "R",
    outcome: 0,
    resourceType: "Composition",
    patient: P,
  });

  const schedule = new Schedule(db);
  const slot = schedule.openSlot(MORNING);
  schedule.book({ slotId: slot.id, patientId: P, reason: "Knee review", by: CLERK });

  // The engine that owns this file is running, and the snapshot is taken from
  // under it — which is the whole point of an online backup, and the reason
  // the snapshot carries a live lock row.
  db.acquireInstanceLock();
  const backup = await takeBackup(db, { dir: join(dir, "backups") });
  db.close();

  return {
    dir,
    dbPath,
    snapshot: backup.path,
    slotId: slot.id,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("a restored database is usable, not merely openable", async () => {
  // The claim the backup code could not make. Restoring somewhere the file has
  // never been is the closest a test on one machine gets to another machine:
  // a different directory, a database this path has never held, and no
  // sidecars — and it is enough to have caught both defects below.
  const site = await siteWithHistory();
  try {
    const target = join(site.dir, "restored", "northstar.db");
    const result = restore({ snapshot: site.snapshot, target });

    assert.equal(result.verified.messages, 5, "the traffic came back");
    assert.ok(result.verified.auditEvents >= 1, "and the audit trail with it");

    const db = new Db(target);
    try {
      // Readable: the chart is there and says what it said.
      const chart = new ClinicalRecord(db).chart(P);
      assert.equal(chart.length, 1);
      assert.equal(chart[0].entry_type, "Patient");

      // Writable: a restored database that cannot take the next message is a
      // museum piece. This is the assertion `verifyBackup` cannot make,
      // because it opens read-only.
      const msg = db.insertMessage("adt", "mllp", "text/plain", "MSH|after the restore");
      assert.ok(msg.id);

      // And the chain still verifies with the new row on the end of it, which
      // is the real question: not whether the copy was internally consistent,
      // but whether it can still be extended.
      const chain = db.verifyChain("adt");
      assert.equal(chain.ok, true);
      assert.equal(chain.truncated, undefined);
      assert.equal(new AuditStore(db).verifyChain().ok, true);
    } finally {
      db.close();
    }
  } finally {
    site.cleanup();
  }
});

test("the scheduler's uniqueness guarantee survives a restore", async () => {
  // An upgrade or a restore that produced tables without their constraints is
  // worse than one that failed outright: the site runs, and double-books.
  // `test/migration.test.ts` pins this across an upgrade; a restore is the
  // other way the schema can arrive, and the index is not something an
  // operator would ever think to check.
  const site = await siteWithHistory();
  try {
    const target = join(site.dir, "restored", "northstar.db");
    restore({ snapshot: site.snapshot, target });

    const db = new Db(target);
    try {
      // Around the booking API entirely, writing the row a racing second
      // process would write. The index is the guarantee; this asks whether the
      // guarantee came back.
      assert.throws(
        () =>
          db.sql
            .prepare(
              `INSERT INTO schedule_bookings
                 (tenant_id, id, slot_id, patient_id, seat, status, reason, priority, booked_by, booked_at, created_at)
               VALUES ('default', ?, ?, 'NT-other', 0, 'booked', 'raced in', 'routine', 'clerk', '2026-06-01', '2026-06-01')`
            )
            .run(randomUUID(), site.slotId),
        /UNIQUE constraint failed/,
        "the partial unique index did not survive the restore"
      );
      assert.equal(new Schedule(db).liveBookings(site.slotId).length, 1);
    } finally {
      db.close();
    }
  } finally {
    site.cleanup();
  }
});

test("a restored snapshot does not arrive owned by the machine it came from", async () => {
  // The defect rehearsing this found, and one that could only ever appear on a
  // restore somewhere other than where the backup was taken — which is exactly
  // the restore nobody had done.
  //
  // A snapshot copies the whole database, `instance_lock` included, so the
  // file arrives claiming to belong to a process on the source machine.
  // `acquireInstanceLock()` cannot prove that process is dead: its fast path
  // requires the holder to be on this host, which is false by construction
  // after a restore from somewhere else. So the new engine waits out the
  // heartbeat before it will start — a bounded stall, on the recovery path, in
  // the one situation where somebody is counting the minutes.
  const site = await siteWithHistory();
  try {
    // What a plain `cp` restore leaves behind, which is what the README's
    // procedure did.
    const copied = join(site.dir, "copied.db");
    copyFileSync(site.snapshot, copied);
    const naive = new Db(copied);
    try {
      const inherited = naive.sql.prepare("SELECT pid, host FROM instance_lock WHERE id = 1").get() as
        | { pid: number; host: string }
        | undefined;
      assert.ok(inherited, "the snapshot carries the source engine's claim");
      // Still live in this process, so the claim is fresh and refused.
      assert.equal(naive.acquireInstanceLock().acquired, false, "a copied snapshot will not start straight away");
    } finally {
      naive.close();
    }

    // What the restore procedure leaves behind.
    const target = join(site.dir, "restored", "northstar.db");
    const result = restore({ snapshot: site.snapshot, target });
    assert.ok(result.clearedInheritedLock, "and the restore says it cleared it, rather than doing it quietly");

    const db = new Db(target);
    try {
      assert.equal(
        db.acquireInstanceLock().acquired,
        true,
        "a restored database is owned by whoever starts next, not by a process on another machine"
      );
    } finally {
      db.close();
    }
  } finally {
    site.cleanup();
  }
});

test("a snapshot from an older version restores, and is migrated before it is committed to", () => {
  // The version boundary, which is the ordinary case rather than an exotic
  // one: a site restores last week's backup, and last week it was running the
  // previous release.
  //
  // This is the second defect rehearsing turned up. The preflight used to be
  // `verifyBackup()` on the snapshot itself, and `verifyBackup` opens
  // read-only — where `Db` skips both SCHEMA and migrate(), then queries the
  // current schema. A snapshot one release old failed with
  // `no such table: channels`, so the verified restore path refused a backup
  // that was perfectly good. The check reporting a problem with the data when
  // the problem is with the check, on the day somebody is restoring.
  const dir = mkdtempSync(join(tmpdir(), "northstar-restore-old-"));
  try {
    const legacy = join(dir, "portage-2026-01-01T00-00-00.db");
    const old = new DatabaseSync(legacy);
    old.exec("PRAGMA journal_mode = WAL;");
    old.exec(V030);
    old.close();
    rmSync(legacy + "-wal", { force: true });
    rmSync(legacy + "-shm", { force: true });

    const target = join(dir, "data", "northstar.db");
    const result = restore({ snapshot: legacy, target });
    assert.equal(result.migratedFromOlderSchema, true, "and it says so, rather than migrating silently");

    // The snapshot on disk is untouched: the preflight migrated a scratch
    // copy, not the backup. A restore that upgrades the operator's only
    // remaining copy of the old data has taken away their way back.
    const stillOld = new DatabaseSync(legacy, { readOnly: true });
    try {
      const has = stillOld
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'consent_directives'")
        .get();
      assert.equal(has, undefined, "the snapshot was not modified by being checked");
    } finally {
      stillOld.close();
    }

    // And the restored database is the current schema and works.
    const db = new Db(target);
    try {
      db.upsertChannel("adt", "admissions", true, "{}");
      const msg = db.insertMessage("adt", "mllp", "text/plain", "MSH|after the restore");
      assert.ok(msg.id);
      assert.equal(db.verifyChain("adt").ok, true);
      const slot = new Schedule(db).openSlot(MORNING);
      assert.ok(slot.id, "including the tables that did not exist when the snapshot was taken");
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a snapshot that cannot come up is refused before anything is displaced", () => {
  // The ordering that makes this survivable. A bad snapshot must leave the
  // site exactly where it was, rather than with nothing — an operator who
  // restores into a hole has lost the database *and* the way back.
  const dir = mkdtempSync(join(tmpdir(), "northstar-restore-bad-"));
  try {
    const target = join(dir, "data", "northstar.db");
    const live = new Db(target);
    live.upsertChannel("adt", "admissions", true, "{}");
    live.insertMessage("adt", "mllp", "text/plain", "the one thing we still have");
    live.close();

    const corrupt = join(dir, "portage-2026-08-01T00-00-00.db");
    writeFileSync(corrupt, "this is not a database");

    assert.throws(() => restore({ snapshot: corrupt, target }));

    // Untouched: same file, same content, and nothing moved aside.
    const db = new Db(target);
    try {
      assert.equal((db.sql.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n, 1);
    } finally {
      db.close();
    }
    assert.equal(existsSync(`${target}.displaced`), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("restoring under a running engine is refused, and the old database is kept when it is not", async () => {
  const site = await siteWithHistory();
  try {
    // Something still holds the target.
    const running = new Db(site.dbPath);
    running.acquireInstanceLock();
    try {
      assert.throws(
        () => restore({ snapshot: site.snapshot, target: site.dbPath }),
        TargetInUse,
        "restoring under a live engine hands it a file it does not own, and the damage is silent"
      );
    } finally {
      running.close();
    }

    // Stopped — the lock row is stale — and the database it replaces is moved
    // aside rather than deleted. It is evidence if this turns out to be an
    // incident rather than an accident.
    const result = restore({ snapshot: site.snapshot, target: site.dbPath, staleMs: 0 });
    assert.ok(result.displaced, "the replaced database was kept");
    assert.equal(existsSync(result.displaced!), true);
  } finally {
    site.cleanup();
  }
});

test("the newest snapshot in a directory is the one a restore reaches for", async () => {
  const site = await siteWithHistory();
  try {
    const dir = join(site.dir, "backups");
    const db = new Db(site.dbPath);
    await takeBackup(db, { dir, stamp: "2027-01-01T00-00-00" });
    db.close();

    const newest = latestSnapshot(dir);
    assert.ok(newest?.endsWith("northstar-2027-01-01T00-00-00.db"), `picked ${newest}`);
    assert.equal(latestSnapshot(join(site.dir, "no-such-dir")), undefined);
  } finally {
    site.cleanup();
  }
});

/**
 * The message and delivery tables as v0.3.0 defined them, before tenancy.
 *
 * The same fixture `test/migration.test.ts` uses, and deliberately a literal
 * rather than an import from it: the point of both is to pin what an older
 * release actually wrote, and a shared constant that drifts to match the
 * current schema would make both tests pass while proving nothing.
 */
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
