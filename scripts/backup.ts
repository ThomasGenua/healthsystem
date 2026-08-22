/**
 * Takes a verified snapshot of a Portage database, and replicates it off the
 * machine when PORTAGE_BACKUP_REMOTE is set.
 *
 *   node scripts/backup.ts [--db data/portage.db] [--out backups] [--keep 7]
 *   node scripts/backup.ts --verify backups/portage-2026-08-07T14-00-00.db
 *   node scripts/backup.ts --init-key /etc/portage/backup.key
 *
 * Safe to run against a live engine: this uses SQLite's online backup API, not
 * a file copy, which would be torn or stale under WAL. The snapshot is
 * reopened and its hash chains walked before this exits 0, so a success here
 * means the file has been read back.
 *
 * A local snapshot is not a backup for the failures that take the disk. When
 * a remote is configured, this encrypts the snapshot, puts it, reads it back,
 * decrypts it and walks the chains again before exiting 0. Restoring:
 *
 *   npm run restore -- --from remote
 */
import { join } from "node:path";
import { statSync } from "node:fs";
import { Db } from "../src/db.ts";
import { takeBackup, verifyBackup } from "../src/core/backup.ts";
import { initBackupKey } from "../src/core/backup-crypto.ts";
import { RemoteBackup } from "../src/core/remote.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const keyPath = arg("init-key");
  if (keyPath) {
    initBackupKey(keyPath);
    console.log(`wrote a new backup key to ${keyPath}`);
    console.log("  store a copy somewhere that survives this machine. losing it loses every remote snapshot.");
    return;
  }

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
  const dir = arg("out") ?? process.env.PORTAGE_BACKUP_DIR ?? join(process.cwd(), "backups");
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

    const remote = RemoteBackup.fromEnv({ ...process.env, PORTAGE_BACKUP_DIR: dir });
    if (!remote.configured) {
      console.log(
        "  local only: no PORTAGE_BACKUP_REMOTE. this snapshot does not survive the disk dying."
      );
      return;
    }
    const replica = await remote.replicate(result.path);
    console.log(`  replicated to ${replica.location} as ${replica.name}`);
    console.log(`  ${(replica.bytes / 1024 / 1024).toFixed(1)} MB encrypted, read back and verified in ${replica.durationMs}ms`);
    if (replica.immutable) {
      console.log("  destination refused deletes; remote retention is its policy, not ours");
    } else if (replica.pruned.length) {
      console.log(`  pruned ${replica.pruned.length} older remote snapshot(s)`);
    }
  } finally {
    db.close();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
