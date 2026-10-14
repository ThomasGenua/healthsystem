/**
 * Restoring a snapshot, as code rather than as four lines in a README.
 *
 * The backup side of this was already careful: `takeBackup` uses SQLite's
 * online backup API rather than a file copy, and reopens every snapshot and
 * walks its hash chains before reporting success. What was never true is the
 * other half. A verified snapshot proves the bytes hashed correctly when they
 * were written; it says nothing about whether the file opens somewhere else,
 * whether the migration path runs against it, or whether an engine comes up
 * and works afterwards. Those are the ways a restore fails, and every one of
 * them was going to be discovered during the incident.
 *
 * The restore itself was a documented sequence of `mv`, `rm` and `cp`. Three
 * things go wrong with that, and all three are silent:
 *
 *   The stale sidecars. `rm -f data/northstar.db-wal` is the step people skip,
 *   and skipping it points SQLite at a write-ahead log belonging to the
 *   database that was just replaced. The README says so; a procedure that
 *   relies on nobody skipping a step under pressure at 03:00 is not a
 *   procedure.
 *
 *   The inherited instance lock. This is the one nobody could have known,
 *   because it only appears when a snapshot is restored somewhere other than
 *   where it was taken — which had never been done. A snapshot copies the
 *   whole database, `instance_lock` included, so the restored file arrives
 *   claiming to be owned by a process on the machine it came from.
 *   `acquireInstanceLock()` then finds a holder it cannot prove is dead: the
 *   `holderGone` fast path checks `sameHost`, which is false by construction
 *   on a different machine, so the new engine waits for the heartbeat to go
 *   stale before it will start. That is a bounded stall rather than a
 *   deadlock — the lock was designed not to wedge a restart, and it doesn't —
 *   but it is a stall on the recovery path, in the one situation where the
 *   time is being counted. Cleared here, because a lock row in a snapshot
 *   describes an engine that was running somewhere else when the backup was
 *   taken, and has no authority over the copy.
 *
 *   Destroying the old file before finding out the new one is bad. Verifying
 *   the snapshot *first* costs a few seconds and means a bad snapshot leaves
 *   the site exactly where it was rather than with nothing.
 *
 * That last check cannot be `verifyBackup()` on the snapshot itself, which is
 * the other thing rehearsing this turned up. `verifyBackup` opens read-only,
 * and `Db` skips both `SCHEMA` and `migrate()` on a read-only handle — so it
 * queries the *current* schema against a file written by whatever version took
 * it. A snapshot one release old fails with `no such table: channels` and the
 * verified restore path refuses a backup that is perfectly good. Which is the
 * shape of failure this whole codebase is organised against: the check reports
 * a problem with the data when the problem is with the check, on the day
 * somebody is restoring.
 *
 * So the preflight runs against a scratch copy instead: copy the snapshot
 * somewhere temporary, open it *writable* so the migration actually runs, and
 * verify that. It costs one extra copy of the file, and it buys the thing an
 * operator actually needs to know before displacing a live database — not
 * "was this snapshot valid when it was written" but "will this snapshot come
 * up under the code I am about to run it under". The migration is exercised
 * before it is committed to rather than during the outage.
 *
 * Nothing here deletes. The database being replaced is moved aside and kept,
 * because a restore is sometimes the wrong call and is always made by somebody
 * having a bad day, and because if this turns out to be an incident rather
 * than an accident, that file is evidence.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { Db } from "../db.ts";
import { verifyBackup, type BackupResult } from "./backup.ts";
import { BACKUP_FILE_RE, sortSnapshots } from "./naming.ts";

export interface RestoreOptions {
  /** The snapshot to restore. Verified before anything is touched. */
  snapshot: string;
  /** Where the engine will look for its database. */
  target: string;
  /**
   * Proceed even though something appears to hold the target's instance lock.
   *
   * Deliberately not the default. The check exists because restoring under a
   * running engine gives it a database it is not the owner of, and the damage
   * is silent.
   */
  force?: boolean;
  /**
   * How stale a lock on the *target* has to be before this treats it as
   * abandoned. Matches the engine's own default so the two agree about what
   * "still running" means.
   */
  staleMs?: number;
  /**
   * Skip the scratch-copy preflight.
   *
   * The preflight copies the snapshot and migrates the copy to prove it comes
   * up before the live database is displaced. That is one extra pass over the
   * file, which on a large database is minutes an operator may not want to
   * spend. Offered for that case and deliberately not the default: skipping it
   * means finding out the snapshot does not migrate *after* the database it
   * would have replaced has been moved aside.
   */
  skipPreflight?: boolean;
}

export interface RestoreResult {
  target: string;
  bytes: number;
  /** Where the replaced database was moved to, if there was one. */
  displaced?: string;
  /** Whether a lock row belonging to the source engine was cleared. */
  clearedInheritedLock?: { pid: number; host: string };
  verified: BackupResult["verified"];
  /** Whether the snapshot needed migrating to come up under this version. */
  migratedFromOlderSchema?: boolean;
  timings: {
    /** Proving the snapshot comes up, against a scratch copy, before anything is displaced. */
    verifyMs: number;
    /** Moving the old file aside and copying the snapshot into place. */
    copyMs: number;
    /** Opening the restored database, which is where migrations run. */
    openMs: number;
    /** Verifying the restored database in its new home. */
    reverifyMs: number;
    totalMs: number;
  };
}

/** Raised when the target looks like it is in use. Distinct, so a CLI can say so. */
export class TargetInUse extends Error {
  readonly heldBy: { pid: number; host: string; ageMs: number };
  constructor(target: string, heldBy: { pid: number; host: string; ageMs: number }) {
    super(
      `${target} appears to be in use by pid ${heldBy.pid} on ${heldBy.host} ` +
        `(heartbeat ${Math.round(heldBy.ageMs / 1000)}s ago). Stop the engine first, or pass --force if you are certain it is gone.`
    );
    this.name = "TargetInUse";
    this.heldBy = heldBy;
  }
}

/**
 * Whether this file predates the current schema and will be migrated on open.
 *
 * Asked before opening, because opening is what performs the migration. Read
 * with a bare `DatabaseSync` rather than a `Db` for the same reason: `Db`
 * would migrate the thing being measured.
 *
 * `consent_directives` is the marker: it arrived with the clinical platform in
 * 0.5.0, so a snapshot without it was written by an older engine. Any table
 * from the newest schema would do; this one is named rather than inferred so
 * that the next release updates it deliberately.
 */
function needsMigration(path: string): boolean {
  const raw = new DatabaseSync(path, { readOnly: true });
  try {
    const row = raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'consent_directives'")
      .get() as { name: string } | undefined;
    return row === undefined;
  } catch {
    return true;
  } finally {
    raw.close();
  }
}

const SIDECARS = ["-wal", "-shm"] as const;

function dropSidecars(path: string): void {
  for (const suffix of SIDECARS) rmSync(path + suffix, { force: true });
}

/**
 * Whether an engine currently holds this database.
 *
 * Read-only and deliberately does not use `acquireInstanceLock`, which would
 * take the lock as a side effect of asking about it — leaving a claim behind
 * from a process that is about to exit.
 */
function heldBy(target: string, staleMs: number): { pid: number; host: string; ageMs: number } | undefined {
  if (!existsSync(target)) return undefined;
  let db: Db;
  try {
    db = new Db(target, { readOnly: true });
  } catch {
    // Unopenable is not "in use". It is very likely why somebody is restoring.
    return undefined;
  }
  try {
    const row = db.sql.prepare("SELECT pid, host, heartbeat_at FROM instance_lock WHERE id = 1").get() as
      | { pid: number; host: string; heartbeat_at: number }
      | undefined;
    if (!row) return undefined;
    const ageMs = Date.now() - row.heartbeat_at;
    // A claim from another host cannot be checked against a process table, so
    // only its age says anything. A stale one is abandoned.
    if (ageMs >= staleMs) return undefined;
    return { pid: row.pid, host: row.host, ageMs };
  } catch {
    // No instance_lock table means a database old enough to predate it.
    return undefined;
  } finally {
    db.close();
  }
}

/**
 * Restores a snapshot over a target database.
 *
 * Order matters and is the point: verify, then displace, then copy, then open,
 * then verify again in the new location. A failure in the first step leaves
 * everything as it was.
 */
export function restore(opts: RestoreOptions): RestoreResult {
  const staleMs = opts.staleMs ?? 20_000;
  const started = Date.now();

  if (!existsSync(opts.snapshot)) throw new Error(`no snapshot at ${opts.snapshot}`);

  // 1. Prove the snapshot comes up, before touching anything. Against a
  //    scratch copy rather than the snapshot itself, so the migration runs
  //    without modifying the backup — see the note at the top of this file
  //    about why verifying the snapshot in place cannot work across versions.
  const t0 = Date.now();
  let verified: BackupResult["verified"] | undefined;
  let migratedFromOlderSchema: boolean | undefined;
  if (!opts.skipPreflight) {
    const scratchDir = mkdtempSync(join(tmpdir(), "northstar-preflight-"));
    const scratch = join(scratchDir, "candidate.db");
    try {
      copyFileSync(opts.snapshot, scratch);
      migratedFromOlderSchema = needsMigration(scratch);
      // Writable, so `Db` runs SCHEMA and migrate(). This is the step that
      // fails loudly here instead of silently during the outage.
      const probe = new Db(scratch);
      probe.close();
      verified = verifyBackup(scratch);
    } finally {
      rmSync(scratchDir, { recursive: true, force: true });
    }
  }
  const verifyMs = Date.now() - t0;

  // 2. Refuse to restore under a running engine.
  if (!opts.force) {
    const holder = heldBy(opts.target, staleMs);
    if (holder) throw new TargetInUse(opts.target, holder);
  }

  // 3. Displace rather than delete.
  const t1 = Date.now();
  mkdirSync(dirname(opts.target), { recursive: true });
  let displaced: string | undefined;
  if (existsSync(opts.target)) {
    displaced = `${opts.target}.displaced-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
    renameSync(opts.target, displaced);
  }
  // The target's own sidecars belong to the database just moved aside, and
  // are the classic way a restore half-works.
  dropSidecars(opts.target);
  copyFileSync(opts.snapshot, opts.target);
  const copyMs = Date.now() - t1;

  // 4. Open it, which is where migrations run, and clear the source engine's
  //    claim. Both are part of the restore rather than the first boot: an
  //    operator timing a recovery should not discover the migration during it.
  const t2 = Date.now();
  const db = new Db(opts.target);
  let clearedInheritedLock: { pid: number; host: string } | undefined;
  try {
    const row = db.sql.prepare("SELECT pid, host FROM instance_lock WHERE id = 1").get() as
      | { pid: number; host: string }
      | undefined;
    if (row) {
      db.sql.prepare("DELETE FROM instance_lock WHERE id = 1").run();
      // Reported rather than done quietly. On a same-host restore this is
      // usually the node's own previous life and unremarkable; from another
      // machine it is the difference between starting now and waiting out a
      // heartbeat, and an operator counting minutes should see it.
      clearedInheritedLock = { pid: row.pid, host: row.host };
    }
  } finally {
    db.close();
  }
  dropSidecars(opts.target);
  const openMs = Date.now() - t2;

  // 5. Verify again, in the new location, after the migration. The snapshot
  //    verified before the copy; this is the copy, migrated, on this disk —
  //    which is a different claim, and the one that matters.
  const t3 = Date.now();
  const reverified = verifyBackup(opts.target);
  dropSidecars(opts.target);
  const reverifyMs = Date.now() - t3;

  // And the two verifications have to agree about how much is there. A
  // restore that silently arrived with fewer messages than the snapshot held
  // would pass both checks individually — each chain is internally consistent
  // — while the site quietly came back short. Comparing the counts is what
  // makes "restored" mean the same data rather than merely valid data.
  if (verified && (reverified.messages !== verified.messages || reverified.auditEvents !== verified.auditEvents)) {
    throw new Error(
      `restored database does not match the snapshot: ` +
        `${verified.messages} message(s) and ${verified.auditEvents} audit event(s) in the preflight, ` +
        `${reverified.messages} and ${reverified.auditEvents} after restoring. ` +
        `The displaced database is still at ${displaced ?? "(there was none)"}.`
    );
  }

  return {
    target: opts.target,
    bytes: statSync(opts.target).size,
    displaced,
    clearedInheritedLock,
    migratedFromOlderSchema,
    verified: reverified,
    timings: { verifyMs, copyMs, openMs, reverifyMs, totalMs: Date.now() - started },
  };
}

/**
 * The newest snapshot in a backup directory.
 *
 * Filenames carry an ISO stamp, so they order chronologically once the
 * product prefix is stripped — the same property `prune()` relies on to decide
 * what to delete, and the reason both are sorted through `sortSnapshots()`.
 */
export function latestSnapshot(dir: string): string | undefined {
  if (!existsSync(dir)) return undefined;
  const snapshots = sortSnapshots(readdirSync(dir).filter((f) => BACKUP_FILE_RE.test(f)));
  const newest = snapshots.at(-1);
  return newest ? join(dir, newest) : undefined;
}
