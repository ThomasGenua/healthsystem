import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../src/db.ts";
import { Engine } from "../src/core/engine.ts";
import { startApi } from "../src/api/admin.ts";
import { prune, takeBackup, verifyBackup } from "../src/core/backup.ts";
import { until } from "./helpers.ts";
import type { ChannelConfig, MappingDoc } from "../src/types.ts";

const ADT = readFileSync(new URL("../fixtures/adt_a01.hl7", import.meta.url), "utf8");
const MAPPING = JSON.parse(
  readFileSync(new URL("../mappings/adt-patient.json", import.meta.url), "utf8")
) as MappingDoc;

const CHANNEL: ChannelConfig = {
  id: "backed-up",
  name: "backup source",
  source: { type: "http", path: "backed-up" },
  pipeline: [
    { type: "filter.hl7Type", allow: ["ADT^A01", "ADT^A04"] },
    { type: "transform.mapping", mapping: "adt-patient" },
  ],
  destinations: [{ id: "facade", type: "fhirstore", ordered: true }],
};

/** A live engine on a real file, since the point is backing up a live database. */
async function liveEngine(dir: string, messages = 5): Promise<Engine> {
  const engine = new Engine({ dbPath: join(dir, "portage.db"), tickMs: 15 });
  engine.registerMapping(MAPPING);
  await engine.start();
  await engine.addChannel(CHANNEL);
  for (let i = 0; i < messages; i++) engine.ingest("backed-up", ADT, "x-application/hl7-v2+er7", "test");
  await until(() => engine.db.listDeliveries({ channelId: "backed-up", state: "delivered" }).length === messages);
  return engine;
}

test("a snapshot of a live database is consistent and independently verifiable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "portage-backup-"));
  const engine = await liveEngine(dir);
  try {
    // The engine is running and has committed data through WAL, which is the
    // case where a file copy would be torn or stale.
    const result = await takeBackup(engine.db, { dir: join(dir, "backups") });

    assert.ok(result.bytes > 0);
    assert.equal(result.verified.channels, 1);
    assert.equal(result.verified.messages, 5, "every message made it into the snapshot");

    // Open the snapshot as an independent database and confirm the data.
    const restored = new Db(result.path, { readOnly: true });
    try {
      assert.equal(restored.listMessages({ channelId: "backed-up" }).length, 5);
      assert.equal(restored.verifyChain("backed-up").ok, true, "lineage verifies in the copy");
      const patients = restored.sql
        .prepare("SELECT COUNT(*) AS n FROM fhir_resources WHERE resource_type = 'Patient'")
        .get() as { n: number };
      assert.equal(patients.n, 1, "the facade came across too");
    } finally {
      restored.close();
    }

    // The live engine is untouched and still working.
    engine.ingest("backed-up", ADT, "x-application/hl7-v2+er7", "test");
    assert.equal(engine.db.listMessages({ channelId: "backed-up" }).length, 6);
  } finally {
    await engine.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a copied file is not a backup, but a snapshot of the same database is", async () => {
  // The reason this module exists. Under WAL, committed rows can still live in
  // the -wal sidecar, so the main file alone is not the database.
  const dir = mkdtempSync(join(tmpdir(), "portage-wal-"));
  const engine = await liveEngine(dir, 5);
  try {
    const naive = join(dir, "naive-copy.db");
    writeFileSync(naive, readFileSync(join(dir, "portage.db")));

    // Under WAL the main file can lack even the schema until a checkpoint, so
    // reading the copy may fail outright rather than merely come up short.
    let naiveCount: number | null = null;
    try {
      const naiveDb = new Db(naive, { readOnly: true });
      naiveCount = naiveDb.listMessages({ channelId: "backed-up" }).length;
      naiveDb.close();
    } catch {
      naiveCount = null;
    }

    const result = await takeBackup(engine.db, { dir: join(dir, "backups") });
    const properDb = new Db(result.path, { readOnly: true });
    const properCount = properDb.listMessages({ channelId: "backed-up" }).length;
    properDb.close();

    assert.equal(properCount, 5, "the online snapshot has everything");
    assert.ok(
      naiveCount === null || naiveCount < properCount,
      `a raw file copy must not be mistaken for a backup, saw ${naiveCount} vs ${properCount}`
    );
  } finally {
    await engine.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verification rejects a corrupt snapshot rather than reporting success", async () => {
  const dir = mkdtempSync(join(tmpdir(), "portage-corrupt-"));
  const engine = await liveEngine(dir, 4);
  try {
    const result = await takeBackup(engine.db, { dir: join(dir, "backups") });
    assert.equal(verifyBackup(result.path).messages, 4);

    // Someone edits the snapshot — the case that must not pass silently, since
    // a backup trusted wrongly is worse than no backup at all.
    const tampered = new Db(result.path);
    const victim = tampered.listMessages({ channelId: "backed-up" })[0];
    tampered.sql.prepare("UPDATE messages SET raw = 'MSH|tampered' WHERE id = ?").run(victim.id);
    tampered.close();

    assert.throws(() => verifyBackup(result.path), /lineage broken/);
  } finally {
    await engine.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("retention keeps the newest snapshots and removes the rest", async () => {
  const dir = mkdtempSync(join(tmpdir(), "portage-prune-"));
  const engine = await liveEngine(dir, 2);
  const backups = join(dir, "backups");
  try {
    // Deterministic stamps, so ordering is by name rather than by clock.
    for (const stamp of ["2026-01-01T00-00-00", "2026-01-02T00-00-00", "2026-01-03T00-00-00"]) {
      await takeBackup(engine.db, { dir: backups, stamp });
    }
    // Each snapshot is exactly one file: no -wal or -shm left beside it, or a
    // restore would apply a write-ahead log from a different database.
    assert.deepEqual(readdirSync(backups).sort(), [
      "portage-2026-01-01T00-00-00.db",
      "portage-2026-01-02T00-00-00.db",
      "portage-2026-01-03T00-00-00.db",
    ]);

    const removed = prune(backups, 2);
    assert.equal(removed.length, 1);
    assert.match(removed[0], /2026-01-01/, "the oldest goes first");

    const left = readdirSync(backups).sort();
    assert.deepEqual(left, ["portage-2026-01-02T00-00-00.db", "portage-2026-01-03T00-00-00.db"]);

    // Keeping more than exist is not an error.
    assert.deepEqual(prune(backups, 10), []);
  } finally {
    await engine.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the backup endpoint writes, verifies and records a snapshot", async () => {
  const dir = mkdtempSync(join(tmpdir(), "portage-api-backup-"));
  const engine = await liveEngine(dir, 3);
  const api = await startApi(engine, 0, "127.0.0.1");
  const previous = process.env.PORTAGE_BACKUP_DIR;
  process.env.PORTAGE_BACKUP_DIR = join(dir, "backups");
  try {
    const before = engine.audit.count();
    const res = await fetch(`http://127.0.0.1:${api.port}/api/backup`, { method: "POST" });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { path: string; bytes: number; verified: { messages: number } };

    assert.equal(body.verified.messages, 3);
    assert.ok(statSync(body.path).size > 0);
    assert.equal(engine.audit.count(), before + 1, "taking a backup is recorded");
    assert.match(engine.audit.list({ resourceType: "Backup" })[0].detail ?? "", /snapshot/);
  } finally {
    if (previous === undefined) delete process.env.PORTAGE_BACKUP_DIR;
    else process.env.PORTAGE_BACKUP_DIR = previous;
    await api.close();
    await engine.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
