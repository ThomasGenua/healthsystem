/**
 * Restores a Northstar database from a verified snapshot.
 *
 *   node scripts/restore.ts --snapshot backups/northstar-2026-08-19T14-00-00.db
 *   node scripts/restore.ts --from backups            # newest snapshot there
 *   node scripts/restore.ts --from remote             # newest off-machine copy
 *   node scripts/restore.ts --from remote --snapshot northstar-2026-08-19T14-00-00.db
 *   node scripts/restore.ts --from backups --target /var/lib/northstar/northstar.db
 *
 * `--from remote` fetches, decrypts and verifies before anything is displaced,
 * so recovery does not begin with a manual download at 03:00. The key in
 * NORTHSTAR_BACKUP_KEY_FILE has to be present; a copy nobody can decrypt is not
 * a backup.
 *
 * Stop the engine first. This refuses to run against a database something
 * still appears to hold, because restoring under a running engine hands it a
 * file it is not the owner of and the damage is silent.
 *
 * Nothing is deleted. The database being replaced is moved aside with a
 * timestamped suffix and left there; a restore is always made by somebody
 * having a bad day, and sometimes it is the wrong call.
 */
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { restore, latestSnapshot, TargetInUse } from "../src/core/restore.ts";
import { RemoteBackup } from "../src/core/remote.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

function isRemoteFrom(from: string | undefined): boolean {
  if (!from) return false;
  return from === "remote" || from.startsWith("s3://") || from.startsWith("sftp://") || from.startsWith("fs:") || from.startsWith("file://");
}

async function main(): Promise<void> {
  const target = arg("target") ?? join(process.cwd(), "data", "northstar.db");
  const from = arg("from");
  let snapshot = arg("snapshot");
  let scratch: string | undefined;

  if (isRemoteFrom(from)) {
    const env = { ...process.env };
    if (from && from !== "remote") env.NORTHSTAR_BACKUP_REMOTE = from;
    const remote = RemoteBackup.fromEnv(env);
    if (!remote.configured) {
      console.error("NORTHSTAR_BACKUP_REMOTE (or PORTAGE_BACKUP_REMOTE) is not set; nothing to fetch from");
      process.exit(2);
    }
    scratch = mkdtempSync(join(tmpdir(), "northstar-restore-remote-"));
    const dest = join(scratch, "snapshot.db");
    // --snapshot on a remote fetch is a name at the destination, not a path.
    const name = snapshot && !snapshot.includes("/") ? snapshot : snapshot?.split(/[/\\]/).pop();
    const fetched = await remote.fetch(dest, name);
    console.log(`fetched ${fetched.name} from ${remote.status().location}`);
    snapshot = fetched.path;
  } else {
    snapshot = snapshot ?? (from ? latestSnapshot(from) : undefined);
  }

  if (!snapshot) {
    console.error("usage: node scripts/restore.ts --snapshot <file> | --from <backup dir|remote>");
    console.error("       [--target data/northstar.db] [--force]");
    if (from && !isRemoteFrom(from)) console.error(`\nno northstar-*.db snapshots found in ${from}`);
    process.exit(2);
  }

  console.log(`restoring ${snapshot}`);
  console.log(`        -> ${target}\n`);

  let result;
  try {
    result = restore({ snapshot, target, force: flag("force") });
  } catch (err) {
    if (scratch) rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    if (err instanceof TargetInUse) {
      console.error(`refusing: ${err.message}`);
      process.exit(3);
    }
    throw err;
  }
  if (scratch) rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });

  if (result.displaced) console.log(`  displaced the existing database to ${result.displaced}`);
  if (result.clearedInheritedLock) {
    // Worth printing rather than doing quietly: on a restore from another
    // machine this is the difference between the engine starting now and
    // waiting out the heartbeat of a process that has not existed for hours.
    console.log(
      `  cleared an instance lock inherited from the snapshot ` +
        `(pid ${result.clearedInheritedLock.pid} on ${result.clearedInheritedLock.host})`
    );
  }
  console.log(
    `  verified: ${result.verified.channels} channel chain(s), ${result.verified.messages} message(s), ` +
      `${result.verified.auditEvents} audit event(s)`
  );
  console.log(`  ${(result.bytes / 1024 / 1024).toFixed(1)} MB\n`);
  console.log(
    `  timings: verify ${result.timings.verifyMs}ms, copy ${result.timings.copyMs}ms, ` +
      `open+migrate ${result.timings.openMs}ms, re-verify ${result.timings.reverifyMs}ms`
  );
  console.log(`\nRESTORED in ${(result.timings.totalMs / 1000).toFixed(1)}s. Start the engine.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
