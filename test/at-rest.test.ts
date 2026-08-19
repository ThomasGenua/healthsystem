/**
 * Whether the file holding every chart is plain text.
 *
 * node:sqlite has no encryption, so the control that fits a single-file store
 * is an encrypted volume underneath it. That is a reasonable decision. What is
 * not reasonable is the usual consequence of it: "encryption at rest" becomes
 * a line in a procurement document and an assumption in a diagram, nothing
 * checks, and the test environment gets promoted or the data directory is
 * moved to a mount nobody thought about — and the system carries on exactly as
 * before, with charts, allergies, results and the audit trail in the clear.
 *
 * So the point of these tests is not that detection is clever. It is that
 * `unknown` is a distinct outcome from `off`, that an operator's assertion is
 * recorded as an assertion rather than as a finding, and that neither of those
 * quietly reads as "encrypted".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encryptionAtRest, looksEncrypted, mountFor, parseMounts, shouldWarn } from "../src/core/atrest.ts";

test("an operator's assertion is recorded as an assertion, not as a finding", () => {
  // A LUKS volume presented by a hypervisor, or an encrypted cloud volume,
  // both look like a plain block device from inside. An operator who knows
  // better must be able to say so — and what they said must not become
  // indistinguishable from something this verified.
  for (const value of ["yes", "true", "1", "YES"]) {
    const r = encryptionAtRest("/anywhere", { PORTAGE_ENCRYPTED_AT_REST: value } as NodeJS.ProcessEnv);
    assert.equal(r.state, "asserted");
    assert.notEqual(r.state as string, "encrypted", "an assertion is not a verification");
    assert.match(r.detail, /not verified here/);
    assert.equal(shouldWarn(r), false, "and it stops the boot warning, which is the point of saying it");
  }

  // Anything else is not an assertion. "no", "false" and a typo all fall
  // through to the real check rather than silently disabling it.
  for (const value of ["no", "false", "0", "ye"]) {
    const r = encryptionAtRest("/anywhere", { PORTAGE_ENCRYPTED_AT_REST: value } as NodeJS.ProcessEnv);
    assert.notEqual(r.state, "asserted", `"${value}" must not read as an assertion`);
  }
});

test("a directory that cannot be resolved is unknown, never encrypted", () => {
  // The failure that would matter: a check that cannot answer must not answer
  // "fine". Every path out of this function that is not a positive finding
  // has to warn.
  const r = encryptionAtRest("/no/such/directory/anywhere", {} as NodeJS.ProcessEnv);
  assert.equal(r.state, "unknown");
  assert.equal(shouldWarn(r), true);
  assert.match(r.detail, /could not determine|no mount found/);
});

test("a real directory resolves to a mount and reports one way or the other", () => {
  const dir = mkdtempSync(join(tmpdir(), "portage-atrest-"));
  try {
    writeFileSync(join(dir, "portage.db"), "x");
    const r = encryptionAtRest(dir, {} as NodeJS.ProcessEnv);

    if (process.platform !== "linux") {
      assert.equal(r.state, "unknown", "and says so rather than guessing");
      assert.match(r.detail, /cannot check encryption at rest on/);
      return;
    }

    assert.ok(["encrypted", "not-encrypted", "unknown"].includes(r.state));
    if (r.state !== "unknown") {
      assert.ok(r.mount, "a finding names the mount it is about");
      assert.ok(r.device);
      assert.ok(r.detail.includes(r.device!), "so an operator can check the claim");
    }
    // Whatever it found, only a positive finding stops the warning.
    assert.equal(shouldWarn(r), r.state !== "encrypted");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unencrypted finding says what is at stake and how to correct it", () => {
  // A warning that says "not encrypted" and stops there gets read as noise.
  // This one has to be actionable in the two cases that occur: the volume
  // genuinely is not encrypted, or it is and this cannot see it.
  const dir = mkdtempSync(join(tmpdir(), "portage-atrest-msg-"));
  try {
    const r = encryptionAtRest(dir, {} as NodeJS.ProcessEnv);
    if (r.state !== "not-encrypted") return; // an encrypted or non-Linux runner

    assert.match(r.detail, /charts, allergies, results and the audit trail in plain text/);
    assert.match(r.detail, /PORTAGE_ENCRYPTED_AT_REST=yes/, "the escape hatch is in the message that needs it");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the check never throws, whatever it is handed", () => {
  // A boot check that can fail is one that gets wrapped in a try/catch and
  // then ignored, which is worse than not having it.
  for (const path of ["", "/", "\0bad", "relative/path", "/proc/self/mem"]) {
    const r = encryptionAtRest(path, {} as NodeJS.ProcessEnv);
    assert.ok(["encrypted", "not-encrypted", "unknown", "asserted"].includes(r.state), `${path} produced ${r.state}`);
    assert.ok(r.detail.length > 0, `${path} produced no detail`);
  }
});

test("the longest matching mount wins, not the first", () => {
  // The whole of the logic, and nothing about it is observable on a real
  // machine: every Linux box has "/" covering every path, so a scan that took
  // the first match would look correct in every live test and be wrong for
  // exactly the deployment that did the right thing — a data directory on its
  // own encrypted mount, reported as the unencrypted root filesystem, which
  // teaches an operator to ignore the warning.
  const mounts = [
    { device: "/dev/vda1", point: "/", fsType: "ext4" },
    { device: "/dev/mapper/portage-data", point: "/var/lib/portage", fsType: "ext4" },
    { device: "/dev/vdb1", point: "/var", fsType: "ext4" },
  ];

  assert.equal(mountFor("/var/lib/portage/data", mounts)?.device, "/dev/mapper/portage-data");
  assert.equal(mountFor("/var/log", mounts)?.device, "/dev/vdb1");
  assert.equal(mountFor("/home/user", mounts)?.device, "/dev/vda1");

  // A prefix that is not a path boundary must not match. /var/libexec starts
  // with the string "/var/lib" and is not under that mount, and getting this
  // wrong sends a lookup to the wrong device — which for this check means
  // reporting the encryption status of a volume the data is not on.
  const withLib = [...mounts, { device: "/dev/vdc1", point: "/var/lib", fsType: "ext4" }];
  assert.equal(mountFor("/var/libexec", withLib)?.point, "/var", "not /var/lib");
  assert.equal(mountFor("/var/lib/other", withLib)?.point, "/var/lib");
  assert.equal(mountFor("/var/lib", withLib)?.point, "/var/lib");
  assert.equal(mountFor("/var/lib/portage", mounts)?.point, "/var/lib/portage", "the mount point itself");

  // And no mount at all is unknown territory rather than a clean bill.
  assert.equal(mountFor("/somewhere", []), undefined);
});

test("a mount table with no entry covering the path is unknown, not encrypted", () => {
  // The path the live check cannot reach, because "/" always covers
  // everything. A check that cannot answer must never answer "fine".
  assert.equal(mountFor("/data", parseMounts("")), undefined);
  assert.equal(mountFor("/data", parseMounts("/dev/vda1 /boot ext4 rw 0 0")), undefined);

  // And the same through the real entry point, since that is where the
  // decision is turned into a report somebody acts on.
  const dir = mkdtempSync(join(tmpdir(), "portage-atrest-nomount-"));
  try {
    if (process.platform !== "linux") return;
    const r = encryptionAtRest(dir, {} as NodeJS.ProcessEnv, [
      { device: "/dev/vda1", point: "/boot", fsType: "ext4" },
    ]);
    assert.equal(r.state, "unknown", "nothing covers it, so nothing is known about it");
    assert.equal(shouldWarn(r), true);
    assert.match(r.detail, /no mount found covering/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an encrypted volume under the data directory is recognised through the real entry point", () => {
  const dir = mkdtempSync(join(tmpdir(), "portage-atrest-luks-"));
  try {
    if (process.platform !== "linux") return;
    const r = encryptionAtRest(dir, {} as NodeJS.ProcessEnv, [
      { device: "/dev/vda1", point: "/", fsType: "ext4" },
      { device: "/dev/mapper/luks-portage", point: dir, fsType: "ext4" },
    ]);
    assert.equal(r.state, "encrypted", "the longest match is the encrypted mount, not the root filesystem");
    assert.equal(r.device, "/dev/mapper/luks-portage");
    assert.equal(shouldWarn(r), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mount lines are parsed the way the kernel writes them", () => {
  const parsed = parseMounts(
    ["/dev/vda1 / ext4 rw,relatime 0 0", "/dev/mapper/luks-x /var/lib/my\\040data ext4 rw 0 0", "", "junk"].join("\n")
  );
  assert.equal(parsed.length, 2);
  assert.equal(parsed[1].point, "/var/lib/my data", "octal-escaped spaces, which a data directory can genuinely have");
  assert.equal(mountFor("/var/lib/my data/portage", parsed)?.device, "/dev/mapper/luks-x");
});

test("what counts as an encrypted block device", () => {
  assert.ok(looksEncrypted("/dev/mapper/portage-data", "ext4"));
  assert.ok(looksEncrypted("/dev/dm-0", "ext4"));
  assert.ok(looksEncrypted("/dev/disk/by-id/dm-name-luks-abc", "ext4"));
  assert.ok(!looksEncrypted("/dev/vda1", "ext4"));
  assert.ok(!looksEncrypted("/dev/nvme0n1p2", "ext4"));
  // ZFS encryption is a dataset property and is not visible from the mount
  // table, so a zfs mount is not claimed either way — including when the pool
  // is called something that would otherwise trip the name match, which is
  // the case that makes this a real guard rather than a comment.
  assert.ok(!looksEncrypted("cryptpool/portage", "zfs"));
  assert.ok(!looksEncrypted("tank/luks-data", "zfs"));
  assert.ok(looksEncrypted("cryptpool/portage", "ext4"), "the same name on a block device does match");
});
