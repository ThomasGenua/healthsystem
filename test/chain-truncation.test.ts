/**
 * Removing rows from the end of a chain.
 *
 * A hash chain walked forward from the beginning catches an edited row and a
 * row taken from the middle — the next row's back-pointer stops matching. It
 * cannot catch rows taken from the *end*, because nothing survives that
 * pointed at them: a truncated chain is a shorter chain that verifies
 * perfectly.
 *
 * That is not an academic gap. The audit trail exists to answer who read whose
 * record, and the adversary it exists for is someone who read records they
 * should not have and would like that not to be knowable. Deleting the most
 * recent entries is the move. Before this, deleting an entire trail reported
 * `{ ok: true, checked: 0 }` — the one answer it must never give.
 *
 * What these tests cannot claim, and what the README says plainly, is that any
 * of this stops someone with write access to the database. It cannot; a chain
 * kept beside the data it attests to is re-linkable by anyone who can write to
 * both. What it does is make removal require more than a DELETE, and put the
 * evidence somewhere a scrape has already carried off the box.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Db } from "../src/db.ts";
import { AuditStore } from "../src/audit/store.ts";
import { takeBackup, verifyBackup } from "../src/core/backup.ts";

function tempDb(): { db: Db; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "northstar-trunc-"));
  const db = new Db(join(dir, "northstar.db"));
  return {
    db,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}

function seed(db: Db, n: number): void {
  db.upsertChannel("c", "c", true, "{}");
  for (let i = 0; i < n; i++) db.insertMessage("c", "test", "text/plain", `message ${i}`);
}

test("a message chain with its tail removed does not verify", () => {
  const { db, cleanup } = tempDb();
  try {
    seed(db, 10);
    assert.equal(db.verifyChain("c").ok, true);

    db.sql.exec("DELETE FROM messages WHERE seq > (SELECT MAX(seq) - 3 FROM messages)");

    const v = db.verifyChain("c");
    assert.equal(v.ok, false, "seven linked rows are not a valid chain of ten");
    assert.equal(v.checked, 7);
    assert.ok(v.truncated, "and the report says it was truncated rather than edited");
    assert.notEqual(v.truncated!.foundTip, v.truncated!.expectedTip);
  } finally {
    cleanup();
  }
});

test("an audit trail with its tail removed does not verify", () => {
  const { db, cleanup } = tempDb();
  try {
    const audit = new AuditStore(db);
    for (let i = 0; i < 10; i++) {
      audit.record({
        action: "R",
        principalId: "dr-smith",
        principalKind: "apikey",
        method: "GET",
        path: `/fhir/Patient/${i}`,
        resourceType: "Patient",
        resourceId: String(i),
        patient: `NT${700000 + i}`,
      });
    }
    assert.equal(audit.verifyChain().ok, true);

    // Five records read, five records of having read them removed.
    db.sql.exec("DELETE FROM audit_events WHERE seq > (SELECT MAX(seq) - 5 FROM audit_events)");

    const v = audit.verifyChain();
    assert.equal(v.ok, false);
    assert.deepEqual(v.missing, { expected: 10, found: 5 }, "and it says how many are unaccounted for");
  } finally {
    cleanup();
  }
});

test("deleting every audit row is the case that must never report ok", () => {
  const { db, cleanup } = tempDb();
  try {
    const audit = new AuditStore(db);
    for (let i = 0; i < 4; i++) {
      audit.record({ action: "R", principalId: "p", principalKind: "apikey", method: "GET", path: "/fhir/Patient" });
    }
    db.sql.exec("DELETE FROM audit_events");

    const v = audit.verifyChain();
    assert.equal(v.ok, false, "an empty trail that once had entries is not an intact trail");
    assert.deepEqual(v.missing, { expected: 4, found: 0 });

    // A trail that genuinely never had an entry is a different thing, and has
    // to verify — otherwise a fresh install reports itself tampered with.
    const fresh = tempDb();
    try {
      assert.deepEqual(new AuditStore(fresh.db).verifyChain(), { ok: true, checked: 0 });
    } finally {
      fresh.cleanup();
    }
  } finally {
    cleanup();
  }
});

test("editing and middle-removal are still caught, so the tip check did not replace linkage", () => {
  const { db, cleanup } = tempDb();
  try {
    seed(db, 10);
    db.sql.exec("DELETE FROM messages WHERE seq = (SELECT MIN(seq) + 4 FROM messages)");
    const gap = db.verifyChain("c");
    assert.equal(gap.ok, false);
    assert.equal(gap.checked, 4, "it stops at the row whose back-pointer no longer resolves");
    assert.equal(gap.truncated, undefined, "which is a broken link, not a truncation");
  } finally {
    cleanup();
  }
});

test("a purge is not mistaken for a truncation", () => {
  // Purging removes a prefix, legitimately and on an operator's instruction.
  // A tip check that could not tell the two apart would make the feature
  // unusable — every purged channel would report as tampered with.
  const { db, cleanup } = tempDb();
  try {
    db.upsertChannel("c", "c", true, "{}");
    for (let i = 0; i < 6; i++) {
      db.sql
        .prepare(
          `INSERT INTO messages (id, channel_id, received_at, source_type, content_type, raw, hash, prev_hash, raw_digest)
           SELECT ?, ?, ?, 'test', 'text/plain', ?, '', NULL, ''`
        )
        .run(`x${i}`, "c", "2020-01-01 00:00:00", `old ${i}`);
      db.sql.prepare("DELETE FROM messages WHERE id = ?").run(`x${i}`);
    }
    // Six real rows, the first three dated in the past so a purge takes them.
    for (let i = 0; i < 6; i++) db.insertMessage("c", "test", "text/plain", `message ${i}`);
    db.sql.exec("UPDATE messages SET received_at = '2020-01-01 00:00:00' WHERE seq <= (SELECT MIN(seq) + 2 FROM messages)");

    const purged = db.purgeBefore("2021-01-01 00:00:00", "c");
    assert.equal(purged.messages, 3);

    const v = db.verifyChain("c");
    assert.equal(v.ok, true, "a purged prefix still verifies");
    assert.equal(v.checked, 3);
    assert.ok(v.verifiedFrom, "and it reports where the chain now begins");

    // Truncating the purged chain is still caught.
    db.sql.exec("DELETE FROM messages WHERE seq = (SELECT MAX(seq) FROM messages)");
    assert.equal(db.verifyChain("c").ok, false, "the tip check survives a purge");
  } finally {
    cleanup();
  }
});

test("a truncated snapshot is rejected at backup-verify time", async () => {
  // The backup module has always promised that a corrupt or truncated
  // snapshot fails when it is taken rather than on the day it is restored.
  // Half of that was not true: verification walked the links, so a snapshot
  // with its tail removed passed. This is the half that was missing.
  const dir = mkdtempSync(join(tmpdir(), "northstar-snap-"));
  const db = new Db(join(dir, "northstar.db"));
  try {
    seed(db, 10);
    const audit = new AuditStore(db);
    for (let i = 0; i < 5; i++) {
      audit.record({ action: "R", principalId: "p", principalKind: "apikey", method: "GET", path: "/fhir/Patient" });
    }

    const snap = await takeBackup(db, { dir: join(dir, "snaps"), keep: 5 });
    assert.deepEqual(snap.verified, { channels: 1, messages: 10, auditEvents: 5 });

    {
      const edited = new DatabaseSync(snap.path);
      edited.exec("DELETE FROM messages WHERE seq > (SELECT MAX(seq) - 3 FROM messages)");
      edited.close();
    }
    assert.throws(
      () => verifyBackup(snap.path),
      // Naming the row would be wrong here: the missing rows are the point,
      // and there is no row to point an operator at.
      /missing rows from the end of its chain/
    );

    // And the same for the audit trail, which fails on the count.
    const snap2 = await takeBackup(db, { dir: join(dir, "snaps2"), keep: 5 });
    {
      const edited = new DatabaseSync(snap2.path);
      edited.exec("DELETE FROM audit_events WHERE seq > (SELECT MAX(seq) - 2 FROM audit_events)");
      edited.close();
    }
    assert.throws(() => verifyBackup(snap2.path), /audit trail is missing 2 of 5 entries/);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("a channel purged in its entirety keeps the tip it ended on", () => {
  const { db, cleanup } = tempDb();
  try {
    db.upsertChannel("c", "c", true, "{}");
    for (let i = 0; i < 4; i++) db.insertMessage("c", "test", "text/plain", `message ${i}`);
    db.sql.exec("UPDATE messages SET received_at = '2020-01-01 00:00:00'");

    assert.equal(db.purgeBefore("2021-01-01 00:00:00", "c").messages, 4);
    const v = db.verifyChain("c");
    assert.equal(v.ok, true, "an emptied channel must not read as tampered with");
    assert.equal(v.checked, 0);
  } finally {
    cleanup();
  }
});
