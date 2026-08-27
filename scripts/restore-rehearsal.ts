/**
 * Restores a snapshot somewhere it has never been, boots an engine against it,
 * and times how long the whole thing took.
 *
 *   node scripts/restore-rehearsal.ts [--messages 20000] [--cadence-hours 24]
 *
 * The gap this closes: snapshots were verified and no snapshot had ever been
 * restored and run against. A verified snapshot proves the bytes hashed
 * correctly when they were written, which is not the claim anybody needs on
 * the day the disk fails. The claim they need is "this comes back, and here is
 * how long it takes", and neither half had a number attached.
 *
 * What this can and cannot prove, stated plainly because the difference is the
 * entire value of the exercise:
 *
 *   It takes a snapshot, encrypts it, puts it on a destination that is not the
 *   backup directory, deletes the local snapshot, fetches the remote copy,
 *   decrypts it, restores to a directory the database has never occupied, and
 *   boots a real engine in a *separate process* against the result. That is
 *   the path an operator walks when the disk that held both the database and
 *   the local backups is gone. It is also what caught the inherited instance
 *   lock, which is invisible to any restore onto the machine that took the
 *   backup.
 *
 *   The destination in CI is a directory on the same runner, reached through
 *   the same store interface as S3 and SFTP. That proves the encrypt / put /
 *   read-back / decrypt / restore path. It does not prove a second machine, a
 *   different filesystem, or a live object store. Saying "rehearsed off-box"
 *   would be the same species of overclaim this codebase spends its time
 *   refusing. The S3 and SFTP transports are tested against fakes in
 *   `test/remote-backup.test.ts`.
 *
 * The RTO it reports is a floor, not a promise: it excludes noticing the
 * outage, deciding to restore, and finding the snapshot, which on a real
 * night are most of the elapsed time.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Db } from "../src/db.ts";
import { takeBackup } from "../src/core/backup.ts";
import { restore } from "../src/core/restore.ts";
import { initBackupKey } from "../src/core/backup-crypto.ts";
import { RemoteBackup } from "../src/core/remote.ts";
import { ClinicalRecord } from "../src/clinical/record.ts";
import { Schedule } from "../src/schedule/store.ts";

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? Number(process.argv[i + 1]) : fallback;
}

const MESSAGES = arg("messages", 20_000);
const CADENCE_HOURS = arg("cadence-hours", 24);
const CHILD = fileURLToPath(new URL("./restore-child.ts", import.meta.url));
const P = "NT123456";

const secs = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "northstar-rehearsal-"));
  const sourcePath = join(dir, "source", "northstar.db");
  let failed = false;

  try {
    console.log(`restore rehearsal: ${MESSAGES.toLocaleString()} messages\n`);

    // ---- a site with something worth losing ----------------------------
    const source = new Db(sourcePath);
    source.acquireInstanceLock();
    // A real channel config, because the child boots an actual Engine and the
    // engine starts what it finds stored. An http source binds no port and an
    // empty destination list delivers nothing, which is what a rehearsal wants:
    // the question is whether the engine comes up against this database, not
    // whether it can reach a remote that is not part of the exercise.
    source.upsertChannel(
      "adt",
      "admissions",
      true,
      JSON.stringify({
        id: "adt",
        name: "admissions",
        source: { type: "http", path: "adt" },
        destinations: [],
      })
    );
    const builtAt = Date.now();
    source.transaction(() => {
      for (let i = 0; i < MESSAGES; i++) {
        source.insertMessage("adt", "mllp", "text/plain", `MSH|^~\\&|WOLF|YKPCC|PORTAGE|GNWT|${i}`);
      }
    });
    new ClinicalRecord(source).record({
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
    const slot = new Schedule(source).openSlot({
      resourceId: "dr-tetso",
      service: "General practice",
      startsAt: "2026-07-01T09:00:00Z",
      endsAt: "2026-07-01T09:15:00Z",
    });
    new Schedule(source).book({
      slotId: slot.id,
      patientId: P,
      reason: "Knee review",
      by: { actorId: "clerk", actorKind: "staff" },
    });
    console.log(`  built a ${MESSAGES.toLocaleString()}-message database in ${secs(Date.now() - builtAt)}`);

    // ---- the backup, taken from under a live engine ---------------------
    const localDir = join(dir, "backups");
    const backup = await takeBackup(source, { dir: localDir });
    // The snapshot's size, not the live file's. Under WAL the committed data
    // is still in northstar.db-wal until a checkpoint folds it in, so `stat` on
    // the database reports a fraction of what is actually there — which is the
    // same reason `cp northstar.db` is not a backup. The snapshot is checkpointed
    // by construction and is the number that matters for a restore anyway.
    const dbMb = backup.bytes / 1024 / 1024;
    console.log(
      `  snapshot: ${(backup.bytes / 1024 / 1024).toFixed(1)} MB in ${backup.durationMs}ms ` +
        `(${backup.verified.messages.toLocaleString()} messages verified)`
    );

    // ---- off the machine that made it -----------------------------------
    // A directory on this runner, through the remote store, with the local
    // snapshot deleted before the restore. That is the claim: what comes back
    // is the replica, not the file we just wrote two lines ago.
    const keyFile = join(dir, "backup.key");
    initBackupKey(keyFile);
    const remoteDir = join(dir, "offsite");
    const remote = RemoteBackup.fromEnv({
      NORTHSTAR_BACKUP_REMOTE: `fs:${remoteDir}`,
      NORTHSTAR_BACKUP_KEY_FILE: keyFile,
      NORTHSTAR_BACKUP_DIR: localDir,
    });
    const replica = await remote.replicate(backup.path);
    console.log(
      `  replicated to ${replica.location} as ${replica.name} ` +
        `(${replica.bytes} bytes encrypted, read back and verified in ${replica.durationMs}ms)`
    );
    rmSync(backup.path, { force: true });

    const fetched = await remote.fetch(join(dir, "from-remote", "snapshot.db"));
    console.log(`  fetched ${fetched.name} (${fetched.verified.messages.toLocaleString()} messages verified)`);

    // Left running and holding its lock, which is what makes the snapshot
    // carry a live claim — the condition that stalls a naive restore.
    source.close();

    // ---- the restore, somewhere the database has never been -------------
    const target = join(dir, "recovered", "northstar.db");
    console.log(`\n  restoring to ${target} from the remote copy`);
    const restoreStarted = Date.now();
    const result = restore({ snapshot: fetched.path, target });
    console.log(
      `    preflight ${result.timings.verifyMs}ms · copy ${result.timings.copyMs}ms · ` +
        `open+migrate ${result.timings.openMs}ms · re-verify ${result.timings.reverifyMs}ms`
    );
    if (result.clearedInheritedLock) {
      console.log(
        `    cleared an inherited instance lock (pid ${result.clearedInheritedLock.pid} ` +
          `on ${result.clearedInheritedLock.host}) — a naive copy would have waited it out`
      );
    }

    // ---- boot a real engine against it, in its own process --------------
    // A separate process so nothing is shared: no open handle, no warm page
    // cache, no migration already run. This is the part that says "and then it
    // worked" rather than "and then the file opened".
    console.log("\n  starting an engine against the restored database...");
    const bootStarted = Date.now();
    const proof = await bootChild(target);
    const bootMs = Date.now() - bootStarted;
    const rtoMs = Date.now() - restoreStarted;

    console.log(`    ready in ${secs(bootMs)}`);
    console.log(`    ${proof}`);

    // ---- what an operator needs written down ---------------------------
    const rpoHours = CADENCE_HOURS;
    console.log("\n" + "-".repeat(64));
    console.log(`database size          ${dbMb.toFixed(1)} MB (${MESSAGES.toLocaleString()} messages)`);
    console.log(`backup                 ${backup.durationMs}ms, verified`);
    console.log(`off-machine replica    ${replica.durationMs}ms, read back and verified`);
    console.log(`restore                ${secs(result.timings.totalMs)} (from the remote copy)`);
    console.log(`engine start           ${secs(bootMs)}`);
    console.log(`RTO (mechanical)       ${secs(rtoMs)} — restore + boot, excluding human time`);
    console.log(
      `RPO (worst case)       ${rpoHours}h — everything since the last snapshot, ` +
        `at a ${rpoHours}-hourly cadence`
    );
    console.log("-".repeat(64));
    console.log(
      "\nRPO is a property of the schedule, and of which disk survives. A node backing\n" +
        "up every 24 hours loses up to 24 hours of the message log to a process crash\n" +
        "or a bad upgrade (the local snapshot). The same cadence against a dead disk\n" +
        "or a stolen machine is only real if the last replica left the machine — the\n" +
        "step above. The clinical record is in the same file, so it is the same number.\n" +
        "Shorten the cadence to shorten it — the snapshot above cost " +
        `${backup.durationMs}ms against a live engine.`
    );
    console.log(
      "\nThe RTO above is a floor. It excludes noticing the outage, deciding to\n" +
        "restore, and finding the snapshot, which on a real night are most of it."
    );
    console.log("\nPASSED: restored from the remote copy, engine started, guarantees intact.");
  } catch (err) {
    failed = true;
    console.error(`\nFAILED: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  process.exit(failed ? 1 : 0);
}

/** Boots the child engine and returns what it proved, or throws what it said. */
function bootChild(dbPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CHILD], {
      env: { ...process.env, RESTORE_DB: dbPath, RESTORE_PATIENT: P },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`the engine did not come up against the restored database within 60s. Saw: ${out.trim()}`));
    }, 60_000);

    child.stdout?.on("data", (b: Buffer) => {
      out += b.toString();
      const line = out.split("\n").find((l) => l.startsWith("PROVED "));
      if (line) {
        clearTimeout(timer);
        child.kill("SIGTERM");
        resolve(line.slice("PROVED ".length).trim());
      }
    });
    child.stderr?.on("data", (b: Buffer) => {
      const s = b.toString();
      if (!s.includes("ExperimentalWarning") && !s.includes("trace-warnings")) process.stderr.write(`    child: ${s}`);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (!out.includes("PROVED ")) {
        reject(new Error(`the engine exited (${code}) without coming up. Saw: ${out.trim() || "(nothing)"}`));
      }
    });
  });
}

void main();
