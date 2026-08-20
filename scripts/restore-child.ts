/**
 * An engine started against a restored database, in its own process.
 *
 * Used by scripts/restore-rehearsal.ts. The separate process is the point:
 * nothing is shared with whoever did the restore — no open handle, no warm
 * page cache, no migration already run — so this is as close as one machine
 * gets to the database arriving somewhere new.
 *
 * It does not merely start. Starting proves the file parses; a restore is only
 * finished when the system can be *used*, so this reads a chart, writes a
 * message, verifies both hash chains with the new row on the end of one of
 * them, and checks that the scheduler's uniqueness guarantee came back. Those
 * are the four ways a restored database can be subtly wrong while opening
 * perfectly.
 */
import { randomUUID } from "node:crypto";
import { Engine } from "../src/core/engine.ts";
import { ClinicalRecord } from "../src/clinical/record.ts";
import { AuditStore } from "../src/audit/store.ts";

const dbPath = process.env.RESTORE_DB!;
const patient = process.env.RESTORE_PATIENT!;

async function main(): Promise<void> {
  const engine = new Engine({ dbPath, tickMs: 50 });
  await engine.start();
  const db = engine.db;

  // Readable: the clinical record survived the trip and says what it said.
  const chart = new ClinicalRecord(db).chart(patient);
  if (chart.length === 0) throw new Error(`the restored chart for ${patient} is empty`);

  // Writable: a restored database that cannot take the next message is a
  // museum piece, and this is the assertion the read-only verification the
  // backup path performs cannot make.
  const before = (db.sql.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n;
  const msg = db.insertMessage("adt", "mllp", "text/plain", "MSH|the first message after the restore");
  const after = (db.sql.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n;
  if (after !== before + 1) throw new Error(`the restored database did not accept a new message`);

  // Extensible: the chain still verifies with that row on the end of it. Not
  // "was the copy internally consistent" — which the snapshot already proved —
  // but "can it still be added to", which is a different question.
  const chain = db.verifyChain("adt");
  if (!chain.ok) throw new Error(`lineage broken after the restore at ${chain.brokenAt}`);
  if (chain.truncated) throw new Error("the restored chain is short at the tip");
  const audit = new AuditStore(db).verifyChain();
  if (!audit.ok) throw new Error(`audit trail broken after the restore at ${audit.brokenAt}`);

  // Constrained: an upgrade or a restore that produced tables without their
  // constraints is worse than one that failed — the site runs, and
  // double-books. The scheduler's promise is a partial unique index, and an
  // index is exactly the kind of thing that goes missing quietly.
  const slot = db.sql.prepare("SELECT id FROM schedule_slots LIMIT 1").get() as { id: string } | undefined;
  if (!slot) throw new Error("the restored database has no schedule slots; the fixture did not survive");
  let refused = false;
  try {
    db.sql
      .prepare(
        `INSERT INTO schedule_bookings
           (tenant_id, id, slot_id, patient_id, seat, status, reason, priority, booked_by, booked_at, created_at)
         VALUES ('default', ?, ?, 'NT-other', 0, 'booked', 'raced in', 'routine', 'clerk', '2026-06-01', '2026-06-01')`
      )
      .run(randomUUID(), slot.id);
  } catch {
    refused = true;
  }
  if (!refused) throw new Error("the scheduler's unique index did not survive the restore — this database double-books");

  console.log(
    `PROVED chart readable (${chart.length} entr${chart.length === 1 ? "y" : "ies"}), ` +
      `message ${msg.id.slice(0, 8)} written, both chains verify, seat uniqueness holds`
  );

  // Stay up until the parent stops us, so the parent times a running engine
  // rather than one that has already exited.
  process.on("SIGTERM", () => {
    void engine.stop().then(() => process.exit(0));
  });
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
