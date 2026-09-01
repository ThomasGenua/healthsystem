/**
 * Platform-specific behaviour, tested from whichever platform you are on.
 *
 * CI runs on Ubuntu only. Every branch that behaves differently on Windows is
 * therefore unexecuted here, and the way that shows up is not a red build — it
 * is a green one, on a machine that never took the branch. The failures get
 * found by whoever runs the suite on a laptop, which is the worst place to
 * find them and the least likely place for them to be fixed.
 *
 * So the platform is a parameter rather than a read of the host wherever it
 * decides anything, and this file drives both settings from either. What it
 * cannot do is prove the suite passes on Windows; it proves the logic that was
 * wrong there is now right, from here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { localBackupDir } from "../src/core/remote.ts";
import { encryptionAtRest } from "../src/core/atrest.ts";

// ── Local backup destinations ─────────────────────────────────────────────

test("a Windows absolute path is an absolute path", () => {
  // `C:\backups` has no leading slash, so the old check called it relative and
  // refused the one setting whose job is to put backups on another volume.
  assert.equal(localBackupDir("fs:C:\\backups", true), "C:\\backups");
  assert.equal(localBackupDir("fs:D:\\northstar\\snapshots", true), "D:\\northstar\\snapshots");
});

test("a Windows file:// URI resolves to a drive path, not a directory named C:", () => {
  // Slicing "file://" off `file:///C:/backups` left `/C:/backups`, which is
  // not a path: the backups would have gone to a folder called "C:" at the
  // root of the current drive, silently, on the machine that asked for them
  // somewhere else.
  assert.equal(localBackupDir("file:///C:/backups", true), "C:\\backups");
  assert.equal(localBackupDir("file:///D:/snap/nightly", true), "D:\\snap\\nightly");
});

test("percent-encoded spaces survive the round trip", () => {
  assert.equal(localBackupDir("file:///C:/Program%20Files/northstar", true), "C:\\Program Files\\northstar");
  assert.equal(localBackupDir("file:///srv/back%20ups", false), "/srv/back ups");
});

test("POSIX destinations are unchanged", () => {
  assert.equal(localBackupDir("fs:/srv/backups", false), "/srv/backups");
  assert.equal(localBackupDir("file:///srv/backups", false), "/srv/backups");
});

test("a relative destination is still refused, on either platform", () => {
  // The check that was there for a reason: a relative backup directory
  // resolves against whatever the working directory happens to be.
  for (const windows of [true, false]) {
    assert.throws(() => localBackupDir("fs:backups", windows), /absolute/);
    assert.throws(() => localBackupDir("fs:./backups", windows), /absolute/);
  }
  // A bare drive-relative path on Windows: "C:backups" means "the current
  // directory on drive C", which is exactly the ambiguity being refused.
  assert.throws(() => localBackupDir("fs:C:backups", true), /absolute/);
});

test("a POSIX host refuses a Windows path rather than treating it as relative-and-fine", () => {
  assert.throws(() => localBackupDir("fs:C:\\backups", false), /absolute/);
});

// ── Encryption at rest ────────────────────────────────────────────────────

test("the Linux detection path is exercised from any host", () => {
  // Before the platform became a parameter, this assertion only ran on Linux.
  // On Windows the function returned "cannot check" and the test either failed
  // or asserted nothing about the logic it exists to cover.
  const mounts = [
    { device: "/dev/sda1", point: "/", fsType: "ext4" },
    { device: "/dev/mapper/northstar-data", point: "/srv", fsType: "ext4" },
  ];
  const encrypted = encryptionAtRest("/srv", {} as NodeJS.ProcessEnv, mounts, "linux");
  assert.equal(encrypted.state, "encrypted");
  assert.equal(encrypted.device, "/dev/mapper/northstar-data");

  const plain = encryptionAtRest("/", {} as NodeJS.ProcessEnv, mounts, "linux");
  assert.equal(plain.state, "not-encrypted");
});

test("a non-Linux host says it cannot check, and names the host", () => {
  const r = encryptionAtRest("C:\\northstar", {} as NodeJS.ProcessEnv, [], "win32");
  assert.equal(r.state, "unknown");
  assert.match(r.detail, /cannot check encryption at rest on win32/);
  // Unknown is not "off", and must not read as a clean bill of health.
  assert.notEqual(r.state, "encrypted");
});

test("an operator's assertion outranks the platform check on any host", () => {
  for (const os of ["linux", "win32", "darwin"]) {
    const r = encryptionAtRest("/anywhere", { NORTHSTAR_ENCRYPTED_AT_REST: "yes" } as NodeJS.ProcessEnv, [], os);
    assert.equal(r.state, "asserted", `${os} should honour the assertion`);
    assert.match(r.detail, /not verified here/);
  }
});
