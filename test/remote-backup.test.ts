import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../src/db.ts";
import { Engine } from "../src/core/engine.ts";
import { startApi } from "../src/api/admin.ts";
import { takeBackup } from "../src/core/backup.ts";
import { restore } from "../src/core/restore.ts";
import {
  encryptSnapshot,
  decryptSnapshot,
  initBackupKey,
  loadBackupKey,
  isEncryptedSnapshot,
  BackupKeyError,
} from "../src/core/backup-crypto.ts";
import {
  RemoteBackup,
  fsStore,
  sftpStore,
  parseRemoteUri,
  replicateSnapshot,
  fetchSnapshot,
  pruneRemote,
  latestRemoteName,
  resolveRemoteName,
  remoteBackupWarning,
  remoteAgeSec,
  type RemoteStore,
  type RemoteObject,
} from "../src/core/remote.ts";
import { s3Put, s3Get, s3List, s3Delete, signCanonicalRequestForTest } from "../src/core/remote-s3.ts";
import type { SftpClient, SftpFile } from "../src/connectors/sftp.ts";
import { until } from "./helpers.ts";
import type { ChannelConfig, MappingDoc } from "../src/types.ts";

const ADT = readFileSync(new URL("../fixtures/adt_a01.hl7", import.meta.url), "utf8");
const MAPPING = JSON.parse(
  readFileSync(new URL("../mappings/adt-patient.json", import.meta.url), "utf8")
) as MappingDoc;

const CHANNEL: ChannelConfig = {
  id: "offsite",
  name: "offsite",
  source: { type: "http", path: "offsite" },
  pipeline: [
    { type: "filter.hl7Type", allow: ["ADT^A01", "ADT^A04"] },
    { type: "transform.mapping", mapping: "adt-patient" },
  ],
  destinations: [{ id: "facade", type: "fhirstore", ordered: true }],
};

async function liveEngine(dir: string, messages = 3): Promise<Engine> {
  const engine = new Engine({ dbPath: join(dir, "northstar.db"), tickMs: 15 });
  engine.registerMapping(MAPPING);
  await engine.start();
  await engine.addChannel(CHANNEL);
  for (let i = 0; i < messages; i++) engine.ingest("offsite", ADT, "x-application/hl7-v2+er7", "test");
  await until(() => engine.db.listDeliveries({ channelId: "offsite", state: "delivered" }).length === messages);
  return engine;
}

function temp(): string {
  return mkdtempSync(join(tmpdir(), "northstar-remote-"));
}

function keyFile(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "backup.key");
  initBackupKey(path);
  return path;
}

class MemoryStore implements RemoteStore {
  readonly kind = "fs" as const;
  readonly location = "memory://test";
  files = new Map<string, Buffer>();
  failPut: string | undefined;
  corruptGet = false;
  denyDelete = false;
  async put(name: string, body: Buffer): Promise<void> {
    if (this.failPut) throw new Error(this.failPut);
    this.files.set(name, Buffer.from(body));
  }
  async get(name: string): Promise<Buffer> {
    const body = this.files.get(name);
    if (!body) throw new Error(`no such object: ${name}`);
    if (this.corruptGet) {
      const copy = Buffer.from(body);
      copy[copy.length - 1] ^= 0xff;
      return copy;
    }
    return Buffer.from(body);
  }
  async list(): Promise<RemoteObject[]> {
    return [...this.files.entries()].map(([name, body]) => ({ name, bytes: body.length }));
  }
  async delete(name: string): Promise<"deleted" | "denied"> {
    if (this.denyDelete) return "denied";
    this.files.delete(name);
    return "deleted";
  }
}

function fakeSftp(initial: Record<string, Buffer | string> = {}) {
  const files = new Map<string, Buffer>(
    Object.entries(initial).map(([k, v]) => [k, Buffer.isBuffer(v) ? v : Buffer.from(v)])
  );
  const client: SftpClient = {
    async list(dir) {
      const out: SftpFile[] = [];
      const prefix = `${dir.replace(/\/+$/, "")}/`;
      for (const [path, body] of files) {
        if (path.startsWith(prefix) && !path.slice(prefix.length).includes("/")) {
          out.push({ name: path.slice(prefix.length), size: body.length });
        }
      }
      return out;
    },
    async get(path) {
      const body = files.get(path);
      if (!body) throw new Error(`no such file: ${path}`);
      return body.toString("binary");
    },
    async put(path, data) {
      files.set(path, Buffer.from(data));
    },
    async getBytes(path) {
      const body = files.get(path);
      if (!body) throw new Error(`no such file: ${path}`);
      return Buffer.from(body);
    },
    async rename(from, to) {
      const body = files.get(from);
      if (!body) throw new Error(`no such file: ${from}`);
      files.delete(from);
      files.set(to, body);
    },
    async delete(path) {
      files.delete(path);
    },
    async mkdir() {},
    async close() {},
  };
  return { client, files };
}

/* ------------------------------- crypto -------------------------------- */

test("a snapshot encrypts and comes back byte-identical", () => {
  const key = loadBackupKey(keyFile(temp()));
  const plain = Buffer.from("a database file is just bytes");
  const wrapped = encryptSnapshot(plain, key);
  assert.ok(isEncryptedSnapshot(wrapped));
  assert.notEqual(wrapped.equals(plain), true);
  assert.deepEqual(decryptSnapshot(wrapped, key), plain);
});

test("the wrong key, and a tampered copy, both fail closed", () => {
  const dir = temp();
  const key = loadBackupKey(keyFile(dir));
  const other = loadBackupKey(keyFile(join(dir, "other")));
  const wrapped = encryptSnapshot(Buffer.from("phi"), key);

  assert.throws(() => decryptSnapshot(wrapped, other), /key is wrong|tampered/);

  const flipped = Buffer.from(wrapped);
  flipped[flipped.length - 1] ^= 1;
  assert.throws(() => decryptSnapshot(flipped, key), /key is wrong|tampered/);

  assert.throws(
    () => decryptSnapshot(Buffer.from("not a snapshot but long enough to have been one"), key),
    /missing PTGB1/
  );
});

test("init-key refuses to overwrite, because losing it loses every remote snapshot", () => {
  const path = keyFile(temp());
  assert.throws(() => initBackupKey(path), BackupKeyError);
  assert.equal(loadBackupKey(path).length, 32);
});

/* ------------------------------- uris ---------------------------------- */

test("remote URIs parse, and anything else is refused", () => {
  assert.deepEqual(parseRemoteUri("s3://bucket/prefix/path"), { kind: "s3", bucket: "bucket", prefix: "prefix/path" });
  assert.deepEqual(parseRemoteUri("s3://bucket"), { kind: "s3", bucket: "bucket", prefix: "" });
  assert.deepEqual(parseRemoteUri("sftp://ops@offsite.example/portage"), {
    kind: "sftp",
    username: "ops",
    host: "offsite.example",
    port: undefined,
    dir: "/portage",
  });
  assert.deepEqual(parseRemoteUri("sftp://ops@offsite.example:2222/portage"), {
    kind: "sftp",
    username: "ops",
    host: "offsite.example",
    port: 2222,
    dir: "/portage",
  });
  assert.deepEqual(parseRemoteUri("fs:/mnt/offsite"), { kind: "fs", dir: "/mnt/offsite" });
  assert.throws(() => parseRemoteUri("http://somewhere"), /s3:\/\/, sftp:\/\/, fs:/);
  assert.throws(() => parseRemoteUri("fs:relative"), /absolute/);
});

test("a remote name accepts the local filename or the .enc one", () => {
  const names = ["portage-2026-01-01T00-00-00.db.enc", "portage-2026-01-02T00-00-00.db.enc"];
  assert.equal(latestRemoteName(names), "portage-2026-01-02T00-00-00.db.enc");
  assert.equal(resolveRemoteName("portage-2026-01-01T00-00-00.db", names), "portage-2026-01-01T00-00-00.db.enc");
  assert.equal(resolveRemoteName("portage-2026-01-01T00-00-00.db.enc", names), "portage-2026-01-01T00-00-00.db.enc");
  assert.equal(resolveRemoteName(undefined, names), "portage-2026-01-02T00-00-00.db.enc");
});

/* ----------------------------- replicate ------------------------------- */

test("a replica is encrypted, read back, decrypted and walked before success", async () => {
  const dir = temp();
  const engine = await liveEngine(dir, 3);
  try {
    const snap = await takeBackup(engine.db, { dir: join(dir, "backups") });
    const store = new MemoryStore();
    const key = loadBackupKey(keyFile(dir));
    const result = await replicateSnapshot(snap.path, store, key);

    assert.equal(result.ok, true);
    assert.match(result.name, /\.db\.enc$/);
    assert.equal(store.files.size, 1);
    const stored = [...store.files.values()][0];
    assert.ok(isEncryptedSnapshot(stored), "what left the machine is ciphertext");
    assert.equal(result.verified.messages, 3);

    const fetched = await fetchSnapshot(store, key, join(dir, "from-remote.db"));
    assert.equal(fetched.verified.messages, 3);
    assert.ok(!isEncryptedSnapshot(readFileSync(fetched.path)), "the file restore sees is plaintext");
  } finally {
    await engine.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an upload that returns 200 is not a copy: a corrupt read-back fails", async () => {
  const dir = temp();
  const engine = await liveEngine(dir, 2);
  try {
    const snap = await takeBackup(engine.db, { dir: join(dir, "backups") });
    const store = new MemoryStore();
    store.corruptGet = true;
    const key = loadBackupKey(keyFile(dir));
    await assert.rejects(() => replicateSnapshot(snap.path, store, key), /does not match what was uploaded/);
  } finally {
    await engine.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a put that throws is a failed replica, and the local snapshot is still there", async () => {
  const dir = temp();
  const engine = await liveEngine(dir, 2);
  try {
    const snap = await takeBackup(engine.db, { dir: join(dir, "backups") });
    const store = new MemoryStore();
    store.failPut = "destination unreachable";
    const key = loadBackupKey(keyFile(dir));
    await assert.rejects(() => replicateSnapshot(snap.path, store, key), /destination unreachable/);
    assert.ok(existsSync(snap.path), "the local snapshot survived the failed replica");
  } finally {
    await engine.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("remote retention is independent of local keep, and a refused delete is not a failed backup", async () => {
  const dir = temp();
  const engine = await liveEngine(dir, 1);
  try {
    const backups = join(dir, "backups");
    const key = loadBackupKey(keyFile(dir));
    const store = new MemoryStore();
    for (const stamp of ["2026-01-01T00-00-00", "2026-01-02T00-00-00", "2026-01-03T00-00-00"]) {
      const snap = await takeBackup(engine.db, { dir: backups, stamp, keep: 10 });
      await replicateSnapshot(snap.path, store, key, { keep: 2 });
    }
    // Local keep was 10, so all three local files remain.
    assert.equal(readdirSync(backups).filter((f) => f.endsWith(".db")).length, 3);
    // Remote keep was 2, so the oldest replica is gone.
    const names = [...store.files.keys()].sort();
    assert.deepEqual(names, ["northstar-2026-01-02T00-00-00.db.enc", "northstar-2026-01-03T00-00-00.db.enc"]);

    store.denyDelete = true;
    const snap = await takeBackup(engine.db, { dir: backups, stamp: "2026-01-04T00-00-00" });
    const result = await replicateSnapshot(snap.path, store, key, { keep: 1 });
    assert.equal(result.ok, true);
    assert.equal(result.immutable, true, "a write-only destination is reported, not failed");
    assert.ok(store.files.size >= 3, "nothing was deleted");
  } finally {
    await engine.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the filesystem destination is the same store the rehearsal uses", async () => {
  const dir = temp();
  const store = fsStore(join(dir, "offsite"));
  const key = loadBackupKey(keyFile(dir));
  const engine = await liveEngine(dir, 1);
  try {
    const snap = await takeBackup(engine.db, { dir: join(dir, "backups") });
    await replicateSnapshot(snap.path, store, key);
    const listed = await store.list();
    assert.equal(listed.length, 1);
    const fetched = await fetchSnapshot(store, key, join(dir, "out.db"));
    assert.equal(fetched.verified.messages, 1);
  } finally {
    await engine.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the SFTP destination puts and gets bytes, not utf8 text", async () => {
  const dir = temp();
  const remote = fakeSftp();
  const store = sftpStore(
    { host: "offsite.example", username: "ops", password: "x", dir: "/portage" },
    async () => remote.client
  );
  const key = loadBackupKey(keyFile(dir));
  const engine = await liveEngine(dir, 2);
  try {
    const snap = await takeBackup(engine.db, { dir: join(dir, "backups") });
    const result = await replicateSnapshot(snap.path, store, key);
    assert.equal(result.kind, "sftp");
    const stored = remote.files.get(`/portage/${result.name}`);
    assert.ok(stored && isEncryptedSnapshot(stored));
    const fetched = await fetchSnapshot(store, key, join(dir, "from-sftp.db"));
    assert.equal(fetched.verified.messages, 2);
  } finally {
    await engine.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------- config -------------------------------- */

test("a remote without a key is refused, not uploaded in the clear", () => {
  assert.throws(
    () => RemoteBackup.fromEnv({ PORTAGE_BACKUP_REMOTE: "fs:/tmp/offsite" }),
    /NORTHSTAR_BACKUP_KEY_FILE/
  );
});

test("unconfigured is a posture: warned, not degraded", () => {
  const remote = RemoteBackup.fromEnv({});
  const status = remote.status();
  assert.equal(status.configured, false);
  assert.equal(status.ok, false);
  assert.equal(remote.isDegraded(), false);
  assert.match(remoteBackupWarning(status) ?? "", /NORTHSTAR_BACKUP_REMOTE/);
  assert.equal(remoteAgeSec(status), -1);
});

test("a configured destination whose last attempt failed is degraded", async () => {
  const dir = temp();
  const engine = await liveEngine(dir, 1);
  try {
    const snap = await takeBackup(engine.db, { dir: join(dir, "backups") });
    writeFileSync(join(dir, "not-a-dir"), "nope");
    const broken = RemoteBackup.fromEnv({
      PORTAGE_BACKUP_REMOTE: `fs:${join(dir, "not-a-dir", "nested")}`,
      PORTAGE_BACKUP_KEY_FILE: keyFile(dir),
      PORTAGE_BACKUP_DIR: join(dir, "backups"),
    });
    await assert.rejects(() => broken.replicate(snap.path));
    assert.equal(broken.isDegraded(), true);
    assert.match(broken.status().detail, /failed/);
  } finally {
    await engine.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("last success survives a restart via the sidecar, so health does not forget overnight", async () => {
  const dir = temp();
  const engine = await liveEngine(dir, 1);
  try {
    const snap = await takeBackup(engine.db, { dir: join(dir, "backups"), stamp: "2026-08-22T00-00-00" });
    const env = {
      PORTAGE_BACKUP_REMOTE: `fs:${join(dir, "offsite")}`,
      PORTAGE_BACKUP_KEY_FILE: keyFile(dir),
      PORTAGE_BACKUP_DIR: join(dir, "backups"),
    };
    const first = RemoteBackup.fromEnv(env);
    await first.replicate(snap.path);
    assert.equal(first.status().ok, true);

    const second = RemoteBackup.fromEnv(env);
    assert.equal(second.status().ok, true, "a new process still knows the last replica verified");
    assert.equal(second.status().lastName, "northstar-2026-08-22T00-00-00.db.enc");
    assert.ok((remoteAgeSec(second.status()) as number) >= 0);
  } finally {
    await engine.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a key on the same volume as the database is reported", () => {
  const dir = temp();
  const key = keyFile(dir);
  const remote = RemoteBackup.fromEnv(
    {
      PORTAGE_BACKUP_REMOTE: `fs:${join(dir, "offsite")}`,
      PORTAGE_BACKUP_KEY_FILE: key,
      PORTAGE_DATA: dir,
    },
    {
      mounts: [
        { device: "/dev/vda1", point: "/", fsType: "ext4" },
        { device: "/dev/vda1", point: dir, fsType: "ext4" },
      ],
    }
  );
  assert.equal(remote.keyOnSameVolume, true);
  assert.match(remoteBackupWarning(remote.status()) ?? "", /same volume/);
});

/* --------------------------- health / api ------------------------------ */

test("health and metrics report an unconfigured remote without degrading", async () => {
  const engine = new Engine({ dbPath: ":memory:", tickMs: 15 });
  await engine.start();
  const api = await startApi(engine, 0, "127.0.0.1");
  const base = `http://127.0.0.1:${api.port}`;
  try {
    const health = (await (await fetch(`${base}/api/health`)).json()) as {
      degraded: boolean;
      remoteBackup: { configured: boolean; ok: boolean };
    };
    assert.equal(health.remoteBackup.configured, false);
    assert.equal(health.degraded, false);

    const text = await (await fetch(`${base}/metrics`)).text();
    assert.match(text, /^portage_backup_remote_configured 0$/m);
    assert.match(text, /^portage_backup_remote_ok 0$/m);
    assert.match(text, /^portage_backup_remote_age_seconds -1$/m);
  } finally {
    await api.close();
    await engine.stop();
  }
});

test("POST /api/backup replicates when a remote is configured, and 500s if the replica fails", async () => {
  const dir = temp();
  const engine = await liveEngine(dir, 2);
  const key = keyFile(dir);
  const previous = { dir: process.env.PORTAGE_BACKUP_DIR, keep: process.env.PORTAGE_BACKUP_KEEP };
  process.env.PORTAGE_BACKUP_DIR = join(dir, "backups");
  process.env.PORTAGE_BACKUP_KEEP = "7";

  const good = RemoteBackup.fromEnv({
    PORTAGE_BACKUP_REMOTE: `fs:${join(dir, "offsite")}`,
    PORTAGE_BACKUP_KEY_FILE: key,
    PORTAGE_BACKUP_DIR: join(dir, "backups"),
  });
  const api = await startApi(engine, 0, "127.0.0.1", { remote: good });
  try {
    const res = await fetch(`http://127.0.0.1:${api.port}/api/backup`, { method: "POST" });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { verified: { messages: number }; remote: { ok: boolean; name: string } };
    assert.equal(body.verified.messages, 2);
    assert.equal(body.remote.ok, true);
    assert.match(body.remote.name, /\.db\.enc$/);
  } finally {
    await api.close();
  }

  writeFileSync(join(dir, "blocked"), "nope");
  const bad = RemoteBackup.fromEnv({
    PORTAGE_BACKUP_REMOTE: `fs:${join(dir, "blocked", "nested")}`,
    PORTAGE_BACKUP_KEY_FILE: key,
    PORTAGE_BACKUP_DIR: join(dir, "backups"),
  });
  const api2 = await startApi(engine, 0, "127.0.0.1", { remote: bad });
  try {
    const res = await fetch(`http://127.0.0.1:${api2.port}/api/backup`, { method: "POST" });
    assert.equal(res.status, 500, "a replica that failed is not reported as a backup");
    const body = (await res.json()) as { error: string; path: string };
    assert.ok(body.path, "the local snapshot is named so it is not lost");
    assert.ok(existsSync(body.path));

    const health = (await (await fetch(`http://127.0.0.1:${api2.port}/api/health`)).json()) as {
      degraded: boolean;
      remoteBackup: { ok: boolean };
    };
    assert.equal(health.degraded, true, "a failed replica is an incident, not a posture");
    assert.equal(health.remoteBackup.ok, false);

    const text = await (await fetch(`http://127.0.0.1:${api2.port}/metrics`)).text();
    assert.match(text, /^portage_backup_remote_configured 1$/m);
    assert.match(text, /^portage_backup_remote_ok 0$/m);
  } finally {
    await api2.close();
    await engine.stop();
    if (previous.dir === undefined) delete process.env.PORTAGE_BACKUP_DIR;
    else process.env.PORTAGE_BACKUP_DIR = previous.dir;
    if (previous.keep === undefined) delete process.env.PORTAGE_BACKUP_KEEP;
    else process.env.PORTAGE_BACKUP_KEEP = previous.keep;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a restore from the remote copy is the same database, and does not need the local snapshot", async () => {
  const dir = temp();
  const engine = await liveEngine(dir, 4);
  try {
    const snap = await takeBackup(engine.db, { dir: join(dir, "backups") });
    const env = {
      PORTAGE_BACKUP_REMOTE: `fs:${join(dir, "offsite")}`,
      PORTAGE_BACKUP_KEY_FILE: keyFile(dir),
      PORTAGE_BACKUP_DIR: join(dir, "backups"),
    };
    const remote = RemoteBackup.fromEnv(env);
    await remote.replicate(snap.path);
    rmSync(snap.path, { force: true });
    assert.equal(existsSync(snap.path), false);

    const fetched = await remote.fetch(join(dir, "pulled.db"));
    const target = join(dir, "recovered", "northstar.db");
    const result = restore({ snapshot: fetched.path, target });
    assert.equal(result.verified.messages, 4);

    const recovered = new Db(target);
    try {
      assert.equal(recovered.listMessages({ channelId: "offsite" }).length, 4);
    } finally {
      recovered.close();
    }
  } finally {
    await engine.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

/* --------------------------------- S3 ---------------------------------- */

test("SigV4 is deterministic for a pinned canonical request", () => {
  const sig = signCanonicalRequestForTest(
    { accessKey: "AKID", secretKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", region: "us-east-1" },
    "GET\n/\n\nhost:examplebucket.s3.amazonaws.com\n\nhost\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "20130524T000000Z"
  );
  assert.equal(sig.length, 64);
  assert.match(sig, /^[0-9a-f]+$/);
  const again = signCanonicalRequestForTest(
    { accessKey: "AKID", secretKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", region: "us-east-1" },
    "GET\n/\n\nhost:examplebucket.s3.amazonaws.com\n\nhost\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "20130524T000000Z"
  );
  assert.equal(sig, again);
});

test("the S3 client puts, gets, lists, deletes, and treats 403 on delete as immutable", async () => {
  const objects = new Map<string, Buffer>();
  let denyDelete = false;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const key = decodeURIComponent(url.pathname.replace(/^\/bucket\//, "").replace(/^\/bucket$/, ""));
    if (req.method === "PUT") {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        objects.set(key, Buffer.concat(chunks));
        res.writeHead(200);
        res.end();
      });
      return;
    }
    if (req.method === "GET" && url.searchParams.get("list-type") === "2") {
      const prefix = url.searchParams.get("prefix") ?? "";
      const contents = [...objects.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([k, v]) => `<Contents><Key>${k}</Key><Size>${v.length}</Size></Contents>`)
        .join("");
      res.writeHead(200, { "content-type": "application/xml" });
      res.end(`<ListBucketResult>${contents}<IsTruncated>false</IsTruncated></ListBucketResult>`);
      return;
    }
    if (req.method === "GET") {
      const body = objects.get(key);
      if (!body) {
        res.writeHead(404);
        res.end("<Error><Code>NoSuchKey</Code></Error>");
        return;
      }
      res.writeHead(200);
      res.end(body);
      return;
    }
    if (req.method === "DELETE") {
      if (denyDelete) {
        res.writeHead(403);
        res.end("<Error><Code>AccessDenied</Code><Message>object lock</Message></Error>");
        return;
      }
      objects.delete(key);
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(405);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const cfg = {
    bucket: "bucket",
    prefix: "portage",
    region: "ca-central-1",
    accessKey: "AKID",
    secretKey: "SECRET",
    endpoint: `http://127.0.0.1:${port}`,
    now: () => new Date("2026-08-22T17:00:00Z"),
  };
  try {
    const body = Buffer.from("ciphertext");
    await s3Put(cfg, "portage-1.db.enc", body);
    assert.deepEqual(await s3Get(cfg, "portage-1.db.enc"), body);
    const listed = await s3List(cfg);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].key, "portage/portage-1.db.enc");

    denyDelete = true;
    assert.equal(await s3Delete(cfg, "portage-1.db.enc"), "denied");
    denyDelete = false;
    assert.equal(await s3Delete(cfg, "portage-1.db.enc"), "deleted");
    assert.equal(objects.size, 0);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("an http S3 endpoint that is not loopback is refused", async () => {
  await assert.rejects(
    () =>
      s3Put(
        {
          bucket: "b",
          prefix: "",
          region: "us-east-1",
          accessKey: "A",
          secretKey: "S",
          endpoint: "http://minio.example:9000",
        },
        "x.db.enc",
        Buffer.from("x")
      ),
    /must be https/
  );
});

test("pruneRemote removes the oldest names first", async () => {
  const store = new MemoryStore();
  store.files.set("portage-2026-01-01T00-00-00.db.enc", Buffer.from("a"));
  store.files.set("portage-2026-01-02T00-00-00.db.enc", Buffer.from("b"));
  store.files.set("portage-2026-01-03T00-00-00.db.enc", Buffer.from("c"));
  const result = await pruneRemote(store, 2);
  assert.deepEqual(result.removed, ["portage-2026-01-01T00-00-00.db.enc"]);
  assert.equal(result.immutable, false);
});
