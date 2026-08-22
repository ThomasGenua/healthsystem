/**
 * Getting a snapshot off the machine that made it.
 *
 * `takeBackup` writes a verified snapshot into a local directory. After #15
 * that snapshot restores, and every snapshot it restores is still on the same
 * disk, in the same building, as the database it came from. The stated RPO is
 * then real only for failures that spare the backup directory — and the
 * failures most likely to need a restore (the disk dies, the machine is
 * stolen, the building floods, ransomware encrypts the volume) are the ones
 * that do not.
 *
 * This is a destination and a retention policy over machinery that already
 * exists. A snapshot is encrypted, put, *read back*, decrypted, and walked
 * again before success is reported. An upload that returned 200 is not a
 * copy. A failed replication is recorded and exported on `/metrics` and
 * `/api/health`; silent failure here is the same hazard as a chart section
 * rendering "none" when it failed to load.
 *
 * Destinations, configured rather than hard-coded:
 *
 *   s3://bucket/prefix     S3-compatible object storage
 *   sftp://user@host/path  reuses the existing SFTP client
 *   fs:/absolute/path      a directory treated as "elsewhere" — tests, CI,
 *                          and a mount that really is another machine
 *
 * Encryption is required. A remote that holds plaintext PHI is a second
 * copy of the chart on a disk this process cannot see. The key lives in
 * `PORTAGE_BACKUP_KEY_FILE` and must survive the host; a key that only this
 * machine can read unlocks nothing after it dies. See `backup-crypto.ts`.
 *
 * Immutability is the destination's job, not ours. A backup an attacker
 * holding production credentials can delete is a backup that does not
 * survive the attack most likely to need it. Object-lock or write-only
 * credentials (put + get + list, no delete) are the usual answers. When
 * delete is refused, prune reports that and does not fail the backup —
 * retention is then the destination's policy, which is what the operator
 * chose by making the objects undeletable.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, posix } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { connectSftp, type SftpClient, type SftpConnectOptions } from "../connectors/sftp.ts";
import { decryptSnapshot, encryptSnapshot, loadBackupKey } from "./backup-crypto.ts";
import { verifyBackup, type BackupResult } from "./backup.ts";
import { mountFor, parseMounts } from "./atrest.ts";
import { s3Delete, s3Get, s3List, s3Put, type S3Config } from "./remote-s3.ts";

export type RemoteKind = "s3" | "sftp" | "fs";

export interface RemoteObject {
  name: string;
  bytes: number;
}

export interface RemoteStore {
  readonly kind: RemoteKind;
  /** For logs and health. Never contains a secret. */
  readonly location: string;
  put(name: string, body: Buffer): Promise<void>;
  get(name: string): Promise<Buffer>;
  list(): Promise<RemoteObject[]>;
  /**
   * `denied` means the destination refused the delete (write-only credentials
   * or object-lock). That is a successful immutability posture, not a failed
   * backup.
   */
  delete(name: string): Promise<"deleted" | "denied">;
}

export interface RemoteBackupStatus {
  configured: boolean;
  kind?: RemoteKind;
  location?: string;
  ok: boolean;
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  lastError?: string;
  lastName?: string;
  lastBytes?: number;
  verified?: BackupResult["verified"];
  /**
   * True when the key file and the database appear to share a volume. A key
   * that dies with the machine cannot unlock the copy that was meant to
   * outlive it.
   */
  keyOnSameVolume?: boolean;
  /** One line an operator can read. Always present when configured is false. */
  detail: string;
}

export interface ReplicateResult {
  ok: true;
  name: string;
  bytes: number;
  durationMs: number;
  verified: BackupResult["verified"];
  pruned: string[];
  /** Set when prune could not delete because the destination refused. */
  immutable?: boolean;
  location: string;
  kind: RemoteKind;
}

export interface RemoteBackupDeps {
  sftp?: (opts: SftpConnectOptions) => Promise<SftpClient>;
  s3?: Partial<Pick<S3Config, "fetch" | "now">>;
  now?: () => Date;
  /** Override mount-table parsing so same-volume detection is testable. */
  mounts?: Parameters<typeof mountFor>[1];
}

const SNAPSHOT_NAME = /^portage-.*\.db(\.enc)?$/;

function sha256(buf: Buffer): Buffer {
  return createHash("sha256").update(buf).digest();
}

function sameBytes(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function remoteSnapshotName(localPath: string): string {
  const base = localPath.split(/[/\\]/).pop() ?? "portage.db";
  return base.endsWith(".enc") ? base : `${base}.enc`;
}

/** Newest remote snapshot name, by filename, which sorts chronologically. */
export function latestRemoteName(names: string[]): string | undefined {
  const snaps = names.filter((n) => SNAPSHOT_NAME.test(n)).sort();
  return snaps.at(-1);
}

/**
 * Accepts the local filename (`portage-….db`) or the remote one (`….db.enc`).
 * An operator restoring at 03:00 will type whichever they remember seeing.
 */
export function resolveRemoteName(requested: string | undefined, available: string[]): string | undefined {
  if (!requested) return latestRemoteName(available);
  if (available.includes(requested)) return requested;
  if (available.includes(`${requested}.enc`)) return `${requested}.enc`;
  if (requested.endsWith(".enc") && available.includes(requested.slice(0, -4))) return requested.slice(0, -4);
  return requested;
}

/* -------------------------------- stores -------------------------------- */

export function fsStore(dir: string): RemoteStore {
  const ensure = (): void => {
    mkdirSync(dir, { recursive: true });
  };
  return {
    kind: "fs",
    location: `fs:${dir}`,
    async put(name, body) {
      ensure();
      writeFileSync(join(dir, name), body);
    },
    async get(name) {
      return readFileSync(join(dir, name));
    },
    async list() {
      if (!existsSync(dir)) return [];
      return readdirSync(dir)
        .filter((f) => SNAPSHOT_NAME.test(f))
        .map((name) => ({ name, bytes: statSync(join(dir, name)).size }));
    },
    async delete(name) {
      try {
        unlinkSync(join(dir, name));
        return "deleted";
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "EACCES" || code === "EPERM") return "denied";
        throw err;
      }
    },
  };
}

export function s3Store(cfg: S3Config): RemoteStore {
  const prefix = cfg.prefix ? `${cfg.prefix}/` : "";
  const location = cfg.endpoint
    ? `s3://${cfg.bucket}${cfg.prefix ? `/${cfg.prefix}` : ""} @ ${cfg.endpoint}`
    : `s3://${cfg.bucket}${cfg.prefix ? `/${cfg.prefix}` : ""}`;
  return {
    kind: "s3",
    location,
    put: (name, body) => s3Put(cfg, name, body),
    get: (name) => s3Get(cfg, name),
    async list() {
      const objects = await s3List(cfg);
      return objects
        .map((o) => ({
          name: o.key.startsWith(prefix) ? o.key.slice(prefix.length) : o.key,
          bytes: o.bytes,
        }))
        .filter((o) => SNAPSHOT_NAME.test(o.name));
    },
    delete: (name) => s3Delete(cfg, name),
  };
}

/**
 * Connects on first use, not at boot. A destination that is down must not
 * take the engine off the air; the failure belongs on the replica, where
 * health can say so, not on the process that is still taking messages.
 */
export function sftpStore(
  opts: SftpConnectOptions & { dir: string },
  connect: (o: SftpConnectOptions) => Promise<SftpClient> = connectSftp
): RemoteStore {
  const dir = opts.dir.replace(/\/+$/, "") || "/";
  const location = `sftp://${opts.username}@${opts.host}${opts.port && opts.port !== 22 ? ":" + opts.port : ""}${dir}`;
  let pending: Promise<SftpClient> | undefined;
  const client = (): Promise<SftpClient> => {
    pending ??= (async () => {
      const c = await connect(opts);
      await c.mkdir(dir);
      return c;
    })();
    return pending;
  };
  return {
    kind: "sftp",
    location,
    async put(name, body) {
      const c = await client();
      if (!c.put) {
        throw new Error("this SFTP client cannot put binary files; the backup destination needs put()");
      }
      await c.put(posix.join(dir, name), body);
    },
    async get(name) {
      const c = await client();
      const path = posix.join(dir, name);
      if (c.getBytes) return c.getBytes(path);
      return Buffer.from(await c.get(path), "binary");
    },
    async list() {
      const c = await client();
      return (await c.list(dir))
        .filter((e) => SNAPSHOT_NAME.test(e.name))
        .map((e) => ({ name: e.name, bytes: e.size }));
    },
    async delete(name) {
      const c = await client();
      try {
        await c.delete(posix.join(dir, name));
        return "deleted";
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/permission|denied|403|not allowed/i.test(msg)) return "denied";
        throw err;
      }
    },
  };
}

/* -------------------------------- config -------------------------------- */

export interface ParsedRemote {
  store: RemoteStore;
  key: Buffer;
  keyPath: string;
  keep?: number;
  kind: RemoteKind;
  location: string;
}

export class RemoteConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemoteConfigError";
  }
}

interface S3Uri {
  kind: "s3";
  bucket: string;
  prefix: string;
}
interface SftpUri {
  kind: "sftp";
  username: string;
  host: string;
  port?: number;
  dir: string;
}
interface FsUri {
  kind: "fs";
  dir: string;
}
export type RemoteUri = S3Uri | SftpUri | FsUri;

export function parseRemoteUri(uri: string): RemoteUri {
  if (uri.startsWith("s3://")) {
    const rest = uri.slice("s3://".length);
    const slash = rest.indexOf("/");
    const bucket = slash === -1 ? rest : rest.slice(0, slash);
    const prefix = slash === -1 ? "" : rest.slice(slash + 1).replace(/\/+$/, "");
    if (!bucket) throw new RemoteConfigError("s3:// URI needs a bucket");
    return { kind: "s3", bucket, prefix };
  }
  if (uri.startsWith("sftp://")) {
    const rest = uri.slice("sftp://".length);
    const slash = rest.indexOf("/");
    const authHost = slash === -1 ? rest : rest.slice(0, slash);
    const dir = slash === -1 ? "/" : rest.slice(slash);
    const at = authHost.lastIndexOf("@");
    if (at === -1) throw new RemoteConfigError("sftp:// URI needs user@host");
    const username = authHost.slice(0, at);
    const hostPort = authHost.slice(at + 1);
    const colon = hostPort.lastIndexOf(":");
    let host = hostPort;
    let port: number | undefined;
    if (colon !== -1 && !hostPort.includes("]")) {
      host = hostPort.slice(0, colon);
      port = Number(hostPort.slice(colon + 1));
      if (!Number.isInteger(port) || port <= 0) throw new RemoteConfigError(`bad sftp port in ${uri}`);
    }
    if (!username || !host) throw new RemoteConfigError("sftp:// URI needs user@host");
    return { kind: "sftp", username, host, port, dir };
  }
  if (uri.startsWith("fs:") || uri.startsWith("file://")) {
    const dir = uri.startsWith("file://") ? uri.slice("file://".length) : uri.slice("fs:".length);
    if (!dir.startsWith("/")) throw new RemoteConfigError("fs: and file:// destinations must be absolute paths");
    return { kind: "fs", dir };
  }
  throw new RemoteConfigError(
    `PORTAGE_BACKUP_REMOTE must be s3://, sftp://, fs: or file:// (got ${uri.split(":")[0] ?? uri})`
  );
}

function storeFromUri(uri: RemoteUri, env: NodeJS.ProcessEnv, deps: RemoteBackupDeps): RemoteStore {
  if (uri.kind === "fs") return fsStore(uri.dir);
  if (uri.kind === "s3") {
    const accessKey = env.PORTAGE_BACKUP_S3_ACCESS_KEY ?? env.AWS_ACCESS_KEY_ID;
    const secretKey = env.PORTAGE_BACKUP_S3_SECRET_KEY ?? env.AWS_SECRET_ACCESS_KEY;
    if (!accessKey || !secretKey) {
      throw new RemoteConfigError(
        "s3:// destination needs PORTAGE_BACKUP_S3_ACCESS_KEY and PORTAGE_BACKUP_S3_SECRET_KEY (or AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY)"
      );
    }
    return s3Store({
      bucket: uri.bucket,
      prefix: uri.prefix,
      region: env.PORTAGE_BACKUP_S3_REGION ?? env.AWS_REGION ?? "us-east-1",
      accessKey,
      secretKey,
      endpoint: env.PORTAGE_BACKUP_S3_ENDPOINT,
      fetch: deps.s3?.fetch,
      now: deps.s3?.now,
    });
  }
  const password = env.PORTAGE_BACKUP_SFTP_PASSWORD;
  const keyPath = env.PORTAGE_BACKUP_SFTP_KEY;
  if (!password && !keyPath) {
    throw new RemoteConfigError("sftp:// destination needs PORTAGE_BACKUP_SFTP_PASSWORD or PORTAGE_BACKUP_SFTP_KEY");
  }
  let privateKey: Buffer | undefined;
  if (keyPath) privateKey = readFileSync(keyPath);
  const connect = deps.sftp ?? connectSftp;
  return sftpStore(
    {
      host: uri.host,
      port: uri.port,
      username: uri.username,
      password,
      privateKey,
      passphrase: env.PORTAGE_BACKUP_SFTP_PASSPHRASE,
      dir: uri.dir,
    },
    connect
  );
}

function parseKeep(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new RemoteConfigError(`PORTAGE_BACKUP_REMOTE_KEEP must be a positive integer, got: ${raw}`);
  return n;
}

function keySharesVolume(keyPath: string, dataDir: string | undefined, mounts?: Parameters<typeof mountFor>[1]): boolean {
  if (!dataDir) return false;
  try {
    const table = mounts ?? (existsSync("/proc/mounts") ? parseMounts(readFileSync("/proc/mounts", "utf8")) : []);
    if (table.length === 0) return false;
    const keyMount = mountFor(realpathSync(keyPath), table);
    const dataMount = mountFor(realpathSync(dataDir), table);
    return Boolean(keyMount && dataMount && keyMount.point === dataMount.point);
  } catch {
    return false;
  }
}

/* -------------------------------- status -------------------------------- */

function unconfiguredStatus(): RemoteBackupStatus {
  return {
    configured: false,
    ok: false,
    detail:
      "no PORTAGE_BACKUP_REMOTE; a snapshot that never leaves this machine does not survive the failures that need a restore",
  };
}

export function remoteBackupWarning(status: RemoteBackupStatus): string | undefined {
  if (!status.configured) {
    return (
      "no off-machine backup destination is configured (PORTAGE_BACKUP_REMOTE). " +
      "Local snapshots survive a process crash and a bad upgrade; they do not survive " +
      "the disk dying, the machine being stolen, or the building flooding. The stated " +
      "RPO is only real for failures that spare the backup directory."
    );
  }
  if (status.keyOnSameVolume) {
    return (
      "PORTAGE_BACKUP_KEY_FILE is on the same volume as the database. " +
      "A key that dies with the machine cannot unlock the copy that was meant to outlive it."
    );
  }
  return undefined;
}

interface PersistedStatus {
  kind?: RemoteKind;
  location?: string;
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  lastError?: string;
  lastName?: string;
  lastBytes?: number;
  verified?: BackupResult["verified"];
}

function readSidecar(path: string): PersistedStatus | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as PersistedStatus;
  } catch {
    return undefined;
  }
}

function writeSidecar(path: string, body: PersistedStatus): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(body, null, 2) + "\n");
  } catch {
    // A sidecar that cannot be written is not worth failing a backup over;
    // /metrics will forget across a restart until the next success.
  }
}

/* -------------------------------- replicate ----------------------------- */

export async function pruneRemote(store: RemoteStore, keep: number): Promise<{ removed: string[]; immutable: boolean }> {
  const names = (await store.list()).map((o) => o.name).filter((n) => SNAPSHOT_NAME.test(n)).sort();
  const doomed = names.slice(0, Math.max(0, names.length - keep));
  const removed: string[] = [];
  let immutable = false;
  for (const name of doomed) {
    const result = await store.delete(name);
    if (result === "denied") immutable = true;
    else removed.push(name);
  }
  return { removed, immutable };
}

export async function replicateSnapshot(
  localPath: string,
  store: RemoteStore,
  key: Buffer,
  opts: { keep?: number } = {}
): Promise<ReplicateResult> {
  const started = Date.now();
  const name = remoteSnapshotName(localPath);
  const plain = readFileSync(localPath);
  const wrapped = encryptSnapshot(plain, key);

  await store.put(name, wrapped);
  const readBack = await store.get(name);
  if (!sameBytes(readBack, wrapped)) {
    throw new Error(
      `remote copy of ${name} at ${store.location} does not match what was uploaded ` +
        `(put ${wrapped.length} bytes, got ${readBack.length}; sha256 ${sha256(wrapped).toString("hex").slice(0, 12)} vs ${sha256(readBack).toString("hex").slice(0, 12)})`
    );
  }

  const decrypted = decryptSnapshot(readBack, key);
  const scratchDir = mkdtempSync(join(tmpdir(), "portage-remote-verify-"));
  const scratch = join(scratchDir, "candidate.db");
  let verified: BackupResult["verified"];
  try {
    writeFileSync(scratch, decrypted);
    verified = verifyBackup(scratch);
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }

  let pruned: string[] = [];
  let immutable = false;
  if (opts.keep !== undefined && opts.keep > 0) {
    const result = await pruneRemote(store, opts.keep);
    pruned = result.removed;
    immutable = result.immutable;
  }

  return {
    ok: true,
    name,
    bytes: wrapped.length,
    durationMs: Date.now() - started,
    verified,
    pruned,
    immutable: immutable || undefined,
    location: store.location,
    kind: store.kind,
  };
}

/**
 * Pulls a remote snapshot down, decrypts it, and writes the plaintext to
 * `dest`. `name` omitted means the newest. The file at `dest` is a local
 * snapshot `restore()` can take; the encrypted object is not left beside it.
 */
export async function fetchSnapshot(
  store: RemoteStore,
  key: Buffer,
  dest: string,
  name?: string
): Promise<{ path: string; name: string; verified: BackupResult["verified"] }> {
  const available = (await store.list()).map((o) => o.name);
  const chosen = resolveRemoteName(name, available);
  if (!chosen) throw new Error(`no portage-*.db snapshots at ${store.location}`);
  if (name && !available.includes(chosen)) {
    throw new Error(`no snapshot ${name} at ${store.location}`);
  }
  const blob = await store.get(chosen);
  const plain = decryptSnapshot(blob, key);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, plain);
  const verified = verifyBackup(dest);
  return { path: dest, name: chosen, verified };
}

/* -------------------------------- facade -------------------------------- */

export class RemoteBackup {
  readonly configured: boolean;
  readonly parsed?: ParsedRemote;
  readonly keyOnSameVolume: boolean;
  private persisted: PersistedStatus;
  private readonly sidecar: string;
  private lastError?: string;
  private lastOk = false;

  private constructor(
    parsed: ParsedRemote | undefined,
    sidecar: string,
    keyOnSameVolume: boolean,
    persisted: PersistedStatus
  ) {
    this.configured = parsed !== undefined;
    this.parsed = parsed;
    this.sidecar = sidecar;
    this.keyOnSameVolume = keyOnSameVolume;
    this.persisted = persisted;
    if (persisted.lastError) {
      this.lastError = persisted.lastError;
      this.lastOk = false;
    } else if (persisted.lastSuccessAt) {
      this.lastOk = true;
    }
  }

  /**
   * Builds from the environment. Missing `PORTAGE_BACKUP_REMOTE` is a
   * posture, not an error — the operator has chosen local-only snapshots,
   * and health will say so. A remote that is half-configured (URI without a
   * key, s3:// without credentials) throws: fail closed rather than upload
   * plaintext or pretend to send.
   */
  static fromEnv(env: NodeJS.ProcessEnv = process.env, deps: RemoteBackupDeps = {}): RemoteBackup {
    const backupDir = env.PORTAGE_BACKUP_DIR ?? join(process.cwd(), "backups");
    const sidecar = join(backupDir, ".remote-status.json");
    const persisted = readSidecar(sidecar) ?? {};
    const uriRaw = env.PORTAGE_BACKUP_REMOTE;
    if (!uriRaw) return new RemoteBackup(undefined, sidecar, false, persisted);

    const keyPath = env.PORTAGE_BACKUP_KEY_FILE;
    if (!keyPath) {
      throw new RemoteConfigError(
        "PORTAGE_BACKUP_REMOTE is set but PORTAGE_BACKUP_KEY_FILE is not. " +
          "A remote copy of the database is the clinical record on someone else's disk; " +
          "it is encrypted here, and the key has to live somewhere that survives this machine."
      );
    }
    const key = loadBackupKey(keyPath);
    const uri = parseRemoteUri(uriRaw);
    const store = storeFromUri(uri, env, deps);
    const keep = parseKeep(env.PORTAGE_BACKUP_REMOTE_KEEP);
    const dataDir = env.PORTAGE_DATA;
    const sameVolume = keySharesVolume(keyPath, dataDir, deps.mounts);
    return new RemoteBackup(
      { store, key, keyPath, keep, kind: store.kind, location: store.location },
      sidecar,
      sameVolume,
      persisted
    );
  }

  status(): RemoteBackupStatus {
    if (!this.configured || !this.parsed) return unconfiguredStatus();
    const lastSuccessAt = this.persisted.lastSuccessAt;
    const lastAttemptAt = this.persisted.lastAttemptAt;
    const failed = Boolean(this.lastError) && !this.lastOk;
    return {
      configured: true,
      kind: this.parsed.kind,
      location: this.parsed.location,
      ok: this.lastOk && !failed,
      lastAttemptAt,
      lastSuccessAt,
      lastError: this.lastError,
      lastName: this.persisted.lastName,
      lastBytes: this.persisted.lastBytes,
      verified: this.persisted.verified,
      keyOnSameVolume: this.keyOnSameVolume || undefined,
      detail: failed
        ? `last replication to ${this.parsed.location} failed: ${this.lastError}`
        : this.lastOk
          ? `last verified copy at ${this.parsed.location} (${this.persisted.lastName ?? "unnamed"})`
          : `destination ${this.parsed.location} is configured; no replica has been verified yet`,
    };
  }

  /**
   * Whether health should treat this as degraded. Unconfigured is a posture
   * (like an unencrypted volume) and is reported, not degraded. A configured
   * destination whose last attempt failed is an incident.
   */
  isDegraded(): boolean {
    return this.configured && Boolean(this.lastError) && !this.lastOk;
  }

  async replicate(localPath: string): Promise<ReplicateResult> {
    if (!this.parsed) {
      throw new RemoteConfigError("no PORTAGE_BACKUP_REMOTE; nothing to replicate to");
    }
    const attempted = this.nowIso();
    try {
      const result = await replicateSnapshot(localPath, this.parsed.store, this.parsed.key, {
        keep: this.parsed.keep,
      });
      this.lastOk = true;
      this.lastError = undefined;
      this.persisted = {
        kind: result.kind,
        location: result.location,
        lastAttemptAt: attempted,
        lastSuccessAt: attempted,
        lastName: result.name,
        lastBytes: result.bytes,
        verified: result.verified,
      };
      writeSidecar(this.sidecar, this.persisted);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.lastOk = false;
      this.lastError = message;
      this.persisted = {
        ...this.persisted,
        kind: this.parsed.kind,
        location: this.parsed.location,
        lastAttemptAt: attempted,
        lastError: message,
      };
      writeSidecar(this.sidecar, this.persisted);
      throw err;
    }
  }

  async fetch(dest: string, name?: string): Promise<{ path: string; name: string; verified: BackupResult["verified"] }> {
    if (!this.parsed) {
      throw new RemoteConfigError("no PORTAGE_BACKUP_REMOTE; nothing to fetch from");
    }
    return fetchSnapshot(this.parsed.store, this.parsed.key, dest, name);
  }

  async list(): Promise<RemoteObject[]> {
    if (!this.parsed) return [];
    return this.parsed.store.list();
  }

  private nowIso(): string {
    return new Date().toISOString();
  }
}

/** Age in seconds since last successful replication, or -1 if never. */
export function remoteAgeSec(status: RemoteBackupStatus, now = Date.now()): number {
  if (!status.lastSuccessAt) return -1;
  const then = Date.parse(status.lastSuccessAt);
  if (!Number.isFinite(then)) return -1;
  return Math.max(0, Math.floor((now - then) / 1000));
}
