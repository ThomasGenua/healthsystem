/**
 * Whether the database file is on an encrypted volume.
 *
 * `node:sqlite` has no encryption. The database is one file, and the control
 * that fits a single-file embedded store is full-volume encryption underneath
 * it — LUKS on Linux, FileVault, BitLocker, or an encrypted cloud volume.
 * Adding SQLCipher would mean a native dependency and a key-management story
 * this project does not have, and application-level column encryption would
 * break the patient index, which has to search on names and identifiers.
 *
 * So the decision is: use volume encryption, and refuse to be quiet about
 * whether it is actually there.
 *
 * That last part is what this file is for. "Encryption at rest" is normally a
 * line in a procurement document and an assumption in an architecture diagram,
 * and the failure mode is that everyone believes it is on. Nothing checks. The
 * test environment gets promoted, or the volume is recreated during an
 * incident, or the data directory is moved to a mount nobody thought about,
 * and the system carries on exactly as before — with a plaintext file holding
 * every chart, allergy and result.
 *
 * Detection is best effort and says so. It reads the mount table and looks for
 * a device-mapper or ZFS-encrypted backing device, which is accurate for the
 * common Linux deployments and cannot see through every arrangement — a LUKS
 * volume presented by a hypervisor, or an encrypted EBS volume, both look like
 * a plain block device from inside. `unknown` is therefore a distinct outcome
 * from `off`, and an operator who knows better can assert it with
 * `PORTAGE_ENCRYPTED_AT_REST=yes` — which is recorded as an assertion rather
 * than a finding, because that is what it is.
 */
import { readFileSync, realpathSync } from "node:fs";
import { platform } from "node:os";

export type AtRestState = "encrypted" | "not-encrypted" | "unknown" | "asserted";

export interface AtRestReport {
  state: AtRestState;
  /** The mount the data directory resolves to, where one was found. */
  mount?: string;
  device?: string;
  /** One line fit for a boot warning or a health endpoint. */
  detail: string;
}

/** Device-mapper and ZFS names that mean the block layer is encrypted. */
export function looksEncrypted(device: string, fsType: string): boolean {
  if (fsType === "zfs") return false; // encryption is a dataset property, not visible here
  return (
    /^\/dev\/mapper\//.test(device) ||
    /^\/dev\/dm-/.test(device) ||
    device.includes("crypt") ||
    device.includes("luks")
  );
}

export interface MountEntry {
  device: string;
  point: string;
  fsType: string;
}

/**
 * The mount covering a path, by longest matching prefix.
 *
 * Longest match matters and is the whole of the logic here: `/` covers every
 * path, so a scan that took the first match would report the root filesystem
 * for a data directory sitting on its own encrypted mount — reporting "not
 * encrypted" for precisely the deployment that did the right thing, which
 * would teach an operator to ignore the warning.
 *
 * Exported so it can be tested against mount tables that do not exist on the
 * machine running the tests. Every real Linux box has `/` covering everything,
 * so nothing about this rule is observable from a live mount table.
 */
export function mountFor(path: string, mounts: MountEntry[]): MountEntry | undefined {
  let best: { device: string; point: string; fsType: string } | undefined;
  for (const m of mounts) {
    if (path === m.point || path.startsWith(m.point.endsWith("/") ? m.point : m.point + "/")) {
      if (!best || m.point.length > best.point.length) best = m;
    }
  }
  return best;
}

export function parseMounts(raw: string): MountEntry[] {
  const out: MountEntry[] = [];
  for (const line of raw.split("\n")) {
    const [device, point, fsType] = line.split(/\s+/);
    // Mount points escape spaces as \040; unescaping matters for a data
    // directory under a path with a space in it.
    if (device && point) out.push({ device, point: point.replace(/\\040/g, " "), fsType: fsType ?? "" });
  }
  return out;
}

/**
 * Reports whether the given directory is on an encrypted volume.
 *
 * Never throws: a boot check that can fail is one that gets wrapped in a
 * try/catch and then ignored.
 */
export function encryptionAtRest(
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
  // Injectable so the no-mount-found path can be reached at all: every real
  // Linux box has "/" covering every path, so that branch is unreachable
  // from a live mount table and would otherwise go untested.
  mounts?: MountEntry[]
): AtRestReport {
  const asserted = (env.PORTAGE_ENCRYPTED_AT_REST ?? "").toLowerCase();
  if (asserted === "yes" || asserted === "true" || asserted === "1") {
    return {
      state: "asserted",
      detail:
        "encryption at rest asserted by PORTAGE_ENCRYPTED_AT_REST; not verified here, and recorded as an operator's assertion",
    };
  }

  if (platform() !== "linux") {
    return {
      state: "unknown",
      detail: `cannot check encryption at rest on ${platform()}; set PORTAGE_ENCRYPTED_AT_REST=yes once the volume is confirmed`,
    };
  }

  try {
    const resolved = realpathSync(dataDir);
    const mount = mountFor(resolved, mounts ?? parseMounts(readFileSync("/proc/mounts", "utf8")));
    if (!mount) {
      return { state: "unknown", detail: `no mount found covering ${resolved}` };
    }
    if (looksEncrypted(mount.device, mount.fsType)) {
      return {
        state: "encrypted",
        mount: mount.point,
        device: mount.device,
        detail: `${resolved} is on ${mount.device}, which is an encrypted block device`,
      };
    }
    return {
      state: "not-encrypted",
      mount: mount.point,
      device: mount.device,
      detail:
        `${resolved} is on ${mount.device}, which does not appear to be encrypted. ` +
        "The database holds charts, allergies, results and the audit trail in plain text; " +
        "an encrypted volume is the control that fits a single-file store. " +
        "If the volume is encrypted somewhere this cannot see — a hypervisor or a cloud volume — " +
        "set PORTAGE_ENCRYPTED_AT_REST=yes to record that.",
    };
  } catch (err) {
    return { state: "unknown", detail: `could not determine encryption at rest: ${(err as Error).message}` };
  }
}

/** True when the report is something an operator ought to see now. */
export function shouldWarn(report: AtRestReport): boolean {
  return report.state === "not-encrypted" || report.state === "unknown";
}
