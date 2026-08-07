/**
 * Takes a verified snapshot of a Portage database.
 *
 *   node scripts/backup.ts [--db data/portage.db] [--out backups] [--keep 7]
 *   node scripts/backup.ts --verify backups/portage-2026-08-07T14-00-00.db
 *
 * Safe to run against a live engine: this uses SQLite's online backup API, not
 * a file copy, which would be torn or stale under WAL. The snapshot is
 * reopened and its hash chains walked before this exits 0, so a success here
 * means the file has been read back.
 *
 * Restoring is a file move, with the engine stopped:
 *
 *   systemctl stop portage
 *   mv data/portage.db data/portage.db.broken
 *   rm -f data/portage.db-wal data/portage.db-shm     # stale, and not part of the snapshot
 *   cp backups/portage-<stamp>.db data/portage.db
 *   systemctl start portage
 *
 * Removing the -wal and -shm files matters: left behind, SQLite would try to
 * apply a write-ahead log belonging to the database you just replaced.
 */
import { join } from "node:path";
import { statSync } from "node:fs";
import { Db } from "../src/db.ts";
import { takeBackup, verifyBackup } from "../src/core/backup.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const verifyPath = arg("verify");
  if (verifyPath) {
    const verified = verifyBackup(verifyPath);
    const bytes = statSync(verifyPath).size;
    console.log(`${verifyPath}: ${(bytes / 1024 / 1024).toFixed(1)} MB`);
    console.log(
      `  verified: ${verified.channels} channel chain(s), ${verified.messages} message(s), ${verified.auditEvents} audit event(s)`
    );
    return;
  }

  const dbPath = arg("db") ?? join(process.cwd(), "data", "portage.db");
  const dir = arg("out") ?? join(process.cwd(), "backups");
  const keep = arg("keep") ? Number(arg("keep")) : undefined;
  if (keep !== undefined && (!Number.isInteger(keep) || keep < 1)) {
    throw new Error(`--keep must be a positive integer, got: ${arg("keep")}`);
  }

  const db = new Db(dbPath, { readOnly: true });
  try {
    const result = await takeBackup(db, { dir, keep });
    console.log(`wrote ${result.path}`);
    console.log(`  ${(result.bytes / 1024 / 1024).toFixed(1)} MB in ${result.durationMs}ms`);
    console.log(
      `  verified: ${result.verified.channels} channel chain(s), ${result.verified.messages} message(s), ` +
        `${result.verified.auditEvents} audit event(s)`
    );
  } finally {
    db.close();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
