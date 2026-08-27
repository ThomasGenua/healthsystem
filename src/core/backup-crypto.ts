/**
 * Client-side encryption for a snapshot that is about to leave the machine.
 *
 * The live database sits on a volume Northstar does not encrypt (see
 * `atrest.ts`). A copy of that file on someone else's disk is the same
 * plaintext in a place this process cannot see, so the snapshot is wrapped
 * here before it is handed to a destination — AES-256-GCM, key from a file
 * the operator holds, not derived from anything on this host.
 *
 * That last part is the whole of the key-management question this module
 * exists to make unavoidable. A key that only this machine can read unlocks
 * nothing after the machine dies, which is the failure the remote copy is
 * for. The file must live somewhere that survives the host: a secrets
 * manager on another system, a USB in a drawer two buildings over, a
 * printed hex string in an envelope. Restoring after a flood begins with
 * producing that key, not with finding the object.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, chmodSync, existsSync } from "node:fs";

const MAGIC = Buffer.from("PTGB1");
const IV_LEN = 12;
const TAG_LEN = 16;
export const BACKUP_KEY_BYTES = 32;

export class BackupKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackupKeyError";
  }
}

/**
 * Reads a 32-byte key from a file. Hex (64 characters, optional trailing
 * newline) or raw 32 bytes; anything else is refused rather than coerced,
 * because a truncated key that "works" encrypts under the wrong material
 * and the copy will never come back.
 */
export function loadBackupKey(path: string): Buffer {
  let raw: Buffer;
  try {
    raw = readFileSync(path);
  } catch (err) {
    throw new BackupKeyError(
      `cannot read NORTHSTAR_BACKUP_KEY_FILE at ${path}: ${(err as Error).message}`
    );
  }
  const text = raw.toString("utf8").trim();
  if (/^[0-9a-fA-F]{64}$/.test(text)) return Buffer.from(text, "hex");
  if (raw.length === BACKUP_KEY_BYTES) return raw;
  throw new BackupKeyError(
    `NORTHSTAR_BACKUP_KEY_FILE must be 32 raw bytes or 64 hex characters; ${path} is ${raw.length} bytes`
  );
}

/** Writes a fresh hex key. Refuses to overwrite: losing this file loses every remote snapshot. */
export function initBackupKey(path: string): void {
  if (existsSync(path)) {
    throw new BackupKeyError(`${path} already exists; refusing to overwrite a backup key`);
  }
  writeFileSync(path, randomBytes(BACKUP_KEY_BYTES).toString("hex") + "\n", { encoding: "utf8", flag: "wx" });
  try {
    chmodSync(path, 0o600);
  } catch {
    // chmod can fail on filesystems that do not honour mode; the file is still written.
  }
}

/**
 * Wraps plaintext in `PTGB1 | iv | tag | ciphertext`. The header is what
 * stops a downloaded object being opened as a database by accident: without
 * it, a restore that forgot to decrypt would fail later, inside SQLite,
 * with an error that looks like a corrupt snapshot rather than a missing step.
 */
export function encryptSnapshot(plain: Buffer, key: Buffer): Buffer {
  if (key.length !== BACKUP_KEY_BYTES) {
    throw new BackupKeyError(`backup key must be ${BACKUP_KEY_BYTES} bytes, got ${key.length}`);
  }
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([MAGIC, iv, tag, ciphertext]);
}

export function isEncryptedSnapshot(blob: Buffer): boolean {
  return blob.length >= MAGIC.length && blob.subarray(0, MAGIC.length).equals(MAGIC);
}

/**
 * Unwraps a snapshot. Auth-tag failure is reported as a wrong key or
 * tampering — GCM does not distinguish, and either way the copy is unusable.
 */
export function decryptSnapshot(blob: Buffer, key: Buffer): Buffer {
  if (key.length !== BACKUP_KEY_BYTES) {
    throw new BackupKeyError(`backup key must be ${BACKUP_KEY_BYTES} bytes, got ${key.length}`);
  }
  if (blob.length < MAGIC.length + IV_LEN + TAG_LEN) {
    throw new BackupKeyError("snapshot is too short to be an encrypted backup");
  }
  if (!isEncryptedSnapshot(blob)) {
    throw new BackupKeyError("snapshot is not an encrypted Northstar backup (missing PTGB1 header)");
  }
  const iv = blob.subarray(MAGIC.length, MAGIC.length + IV_LEN);
  const tag = blob.subarray(MAGIC.length + IV_LEN, MAGIC.length + IV_LEN + TAG_LEN);
  const ciphertext = blob.subarray(MAGIC.length + IV_LEN + TAG_LEN);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new BackupKeyError(
      "could not decrypt the snapshot: the key is wrong, or the copy was tampered with"
    );
  }
}
