/**
 * Online backup.
 *
 * Losing this database is the worst thing that can happen to a Northstar node.
 * It holds the queue that has not drained yet, the lineage that proves what
 * flowed, the audit trail that proves who read it, and the facade a consumer
 * is reading from. A community site with a week of backlog waiting out a
 * satellite outage has a week of unsent clinical messages in one file.
 *
 * Copying that file is not a backup. The engine runs SQLite in WAL mode, so
 * committed data lives in `northstar.db-wal` until a checkpoint folds it in;
 * `cp northstar.db` while the process is running yields a torn or stale
 * snapshot that looks fine until the day it is needed. This uses SQLite's
 * online backup API instead, which takes a consistent snapshot of a live
 * database without stopping writes.
 *
 * And a snapshot nobody has opened is not a backup either. Every snapshot is
 * reopened and its hash chains walked before this reports success — so a
 * backup that says it worked has been read back, not merely written.
 */
import { backup as sqliteBackup } from "node:sqlite";
import { mkdirSync, statSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { backupFileName, BACKUP_FILE_RE, sortSnapshots } from "./naming.ts";
import { Db } from "../db.ts";
import { AuditStore } from "../audit/store.ts";

export interface BackupResult {
  path: string;
  bytes: number;
  durationMs: number;
  /** Channels whose lineage was walked in the snapshot, and the audit trail. */
  verified: { channels: number; messages: number; auditEvents: number };
}

export interface BackupOptions {
  /** Directory to write snapshots into. */
  dir: string;
  /** Keep at most this many snapshots, deleting the oldest. */
  keep?: number;
  /**
   * Timestamp for the filename. Passed in rather than read from the clock so
   * a caller can name a snapshot deterministically.
   */
  stamp?: string;
}

function fileStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

/**
 * Reopens a snapshot and verifies it, so a reported success means the file was
 * read back rather than merely written. A corrupt or truncated snapshot fails
 * here rather than on the day it is restored.
 */
export function verifyBackup(path: string): BackupResult["verified"] {
  const db = new Db(path, { readOnly: true });
  try {
    const channels = db.listChannels();
    // crosses-tenants: a snapshot covers the database file, not one tenant's
    // slice of it, so the count it reports is deliberately the whole node's.
    const messages = (db.sql.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n;
    const auditEvents = new AuditStore(db).count();

    // Walking the chains is the real check: it touches every row and proves
    // the copy is internally consistent, not merely that the file parses.
    // A chain can fail two ways, and they call for different reactions: a
    // broken link names the row, while a short chain names no row at all
    // because the missing ones are the point. Reporting "broken at undefined"
    // for the second would send an operator looking for a row that is gone.
    for (const { id } of channels) {
      const chain = db.verifyChain(id);
      if (chain.truncated) {
        throw new Error(
          `snapshot for channel ${id} is missing rows from the end of its chain ` +
            `(ends at ${chain.truncated.foundTip?.slice(0, 12) ?? "nothing"}, should end at ${chain.truncated.expectedTip.slice(0, 12)})`
        );
      }
      if (!chain.ok) throw new Error(`snapshot lineage broken for channel ${id} at ${chain.brokenAt}`);
    }
    const audit = new AuditStore(db).verifyChain();
    if (audit.missing) {
      throw new Error(
        `snapshot audit trail is missing ${audit.missing.expected - audit.missing.found} of ${audit.missing.expected} entries`
      );
    }
    if (!audit.ok) throw new Error(`snapshot audit trail broken at ${audit.brokenAt}`);

    return { channels: channels.length, messages, auditEvents };
  } finally {
    db.close();
  }
}

/**
 * Removes the -wal and -shm sidecars beside a snapshot.
 *
 * The snapshot inherits WAL journal mode from the source, so opening it to
 * verify leaves those two files behind. They hold nothing — the .db is
 * complete on its own, which this module's tests assert by deleting them and
 * re-reading — but a snapshot must be exactly one file. Otherwise the restore
 * procedure copies a .db while leaving a stale -wal beside it, and SQLite
 * tries to apply a write-ahead log belonging to a different database.
 */
function dropSidecars(path: string): void {
  for (const suffix of ["-wal", "-shm"]) {
    try {
      unlinkSync(path + suffix);
    } catch {
      // Absent is the desired state, so failing to remove one is not an error.
    }
  }
}

/** Takes a verified snapshot of a live database. */
export async function takeBackup(db: Db, opts: BackupOptions): Promise<BackupResult> {
  mkdirSync(opts.dir, { recursive: true });
  const path = join(opts.dir, backupFileName(opts.stamp ?? fileStamp()));
  const started = Date.now();

  await sqliteBackup(db.sql, path);
  const verified = verifyBackup(path);
  dropSidecars(path);

  if (opts.keep !== undefined && opts.keep > 0) prune(opts.dir, opts.keep);

  return { path, bytes: statSync(path).size, durationMs: Date.now() - started, verified };
}

/** Keeps the newest `keep` snapshots, ordered by the stamp their names carry. */
export function prune(dir: string, keep: number): string[] {
  const snapshots = sortSnapshots(readdirSync(dir).filter((f) => BACKUP_FILE_RE.test(f)));
  const doomed = snapshots.slice(0, Math.max(0, snapshots.length - keep));
  for (const f of doomed) {
    try {
      unlinkSync(join(dir, f));
      dropSidecars(join(dir, f));
    } catch {
      // A snapshot that cannot be removed is not worth failing a backup over;
      // the new one is already written and verified.
    }
  }
  return doomed;
}
