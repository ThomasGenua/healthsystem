/**
 * The product's name, and the parts of a rename that are not cosmetic.
 *
 * Northstar was called Portage. Changing a name in prose is free. Changing it
 * in the places a running deployment depends on is not, because every one of
 * those failures is silent — the engine boots, reports healthy, and is wrong:
 *
 *   - **The database filename.** `node:sqlite` creates what it cannot open. An
 *     engine that starts looking for `northstar.db` where `portage.db` is what
 *     exists does not fail; it makes an empty database and serves a site with
 *     no patients in it. The most dangerous outcome in this file.
 *
 *   - **Backup filenames.** The snapshot lister matches a prefix. Change the
 *     prefix and every existing backup becomes invisible at once: the restore
 *     tool finds nothing to restore, and the reading-station check reports no
 *     recent backup for a site whose backups are sitting right there.
 *
 *   - **Environment variables.** A deployment sets `PORTAGE_TLS_KEY`,
 *     `PORTAGE_ENCRYPTED_AT_REST`, `PORTAGE_OIDC_ISSUER`. Read only the new
 *     spellings and those values do not error — they go *absent*, and absent
 *     means TLS off, encryption unasserted, authentication unconfigured. A
 *     rename that quietly downgrades a site's security posture is worse than
 *     one that crashes.
 *
 * So the new names are what Northstar writes and what its documentation says,
 * and the old names keep working on the read side. Nothing is dropped in the
 * rename; the compatibility is deliberate, tested, and announced at boot
 * rather than left for somebody to discover.
 *
 * ## What deliberately did not change
 *
 * `PORTAGE` in MSH-3 of an outbound HL7 acknowledgement is not branding — it
 * is the receiving-application name a sending facility has configured at their
 * end. Changing it is a coordinated change with every partner, not a rename,
 * and a site that flipped it unilaterally would have its acknowledgements
 * rejected by a hospital that had not. It stays until a deployment sets
 * `NORTHSTAR_HL7_APPLICATION`, which is a decision somebody makes with a lab
 * on the phone. See `docs/RUNBOOK.md`.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

/** The product name, as it appears to a human. */
export const PRODUCT = "Northstar";

/** The lowercase form used in filenames, env prefixes and claim names. */
export const SLUG = "northstar";

/** What Northstar was called before, and still answers to. */
export const LEGACY_SLUG = "portage";

/**
 * Legacy names that actually supplied a value this process.
 *
 * Collected rather than warned about at the point of use: a warning per read
 * would fire several times for the same variable and scroll the ones that
 * matter off the top. Reported once, at boot, as a list.
 */
const legacyEnvUsed = new Set<string>();

/** Every `PORTAGE_*` variable that supplied a value, in the order first read. */
export function legacyEnvNamesInUse(): string[] {
  return [...legacyEnvUsed].sort();
}

/** Test seam; the set is process-global and would otherwise leak between tests. */
export function resetLegacyEnvTracking(): void {
  legacyEnvUsed.clear();
}

/**
 * Reads `NORTHSTAR_<suffix>`, falling back to `PORTAGE_<suffix>`.
 *
 * The new name wins when both are set, so a deployment can migrate one
 * variable at a time without the old value shadowing the new one.
 */
export function readEnv(suffix: string, source: NodeJS.ProcessEnv = process.env): string | undefined {
  const current = source[`NORTHSTAR_${suffix}`];
  if (current !== undefined) return current;
  const legacy = source[`PORTAGE_${suffix}`];
  if (legacy !== undefined) legacyEnvUsed.add(`PORTAGE_${suffix}`);
  return legacy;
}

/** The warning to print at boot when a deployment is still on the old names. */
export function legacyEnvWarning(): string | null {
  const names = legacyEnvNamesInUse();
  if (names.length === 0) return null;
  return (
    `configured with ${names.length} legacy PORTAGE_* variable${names.length === 1 ? "" : "s"} ` +
    `(${names.join(", ")}). These still work. Rename them to NORTHSTAR_* at your convenience; ` +
    `both are read, and the NORTHSTAR_* name wins where both are set.`
  );
}

/** What a fresh install names its database. */
export const DB_FILENAME = `${SLUG}.db`;

/** What an install made before the rename named its database. */
export const LEGACY_DB_FILENAME = `${LEGACY_SLUG}.db`;

export interface DbPathChoice {
  path: string;
  /** True when an existing pre-rename database is being opened under its old name. */
  legacy: boolean;
}

/**
 * Picks the database file to open, preferring one that already exists.
 *
 * The ordering is the whole point. A new name on a directory holding an old
 * database would not error — SQLite would create the new file and the engine
 * would come up empty, healthy, and serving nobody's chart. So an existing
 * file always wins over the preferred name, and only a genuinely empty data
 * directory gets `northstar.db`.
 *
 * Renaming the file is a deliberate step an operator takes with the engine
 * stopped, documented in the runbook alongside the WAL sidecars that have to
 * move with it. It is never done here, on a running boot, to a database.
 */
export function resolveDbPath(dataDir: string): DbPathChoice {
  const preferred = join(dataDir, DB_FILENAME);
  if (existsSync(preferred)) return { path: preferred, legacy: false };
  const legacy = join(dataDir, LEGACY_DB_FILENAME);
  if (existsSync(legacy)) return { path: legacy, legacy: true };
  return { path: preferred, legacy: false };
}

/** The notice to print at boot when the database is still under its old name. */
export function legacyDbNotice(choice: DbPathChoice): string | null {
  if (!choice.legacy) return null;
  return (
    `opening the existing database at ${choice.path}. Northstar names new databases ` +
    `${DB_FILENAME}; this one keeps its name and its data. To rename it, stop the engine and move ` +
    `the file together with its -wal and -shm sidecars — see docs/RUNBOOK.md.`
  );
}

/** Names a new snapshot. New backups are written under the new name. */
export function backupFileName(stamp: string): string {
  return `${SLUG}-${stamp}.db`;
}

/**
 * Matches a snapshot under either name.
 *
 * Both, always, on every read path. A backup taken the day before the upgrade
 * is the one most likely to be needed the day after it, and a lister that
 * matched only the new prefix would report a site with a year of snapshots as
 * having none.
 */
export const BACKUP_FILE_RE = new RegExp(`^(?:${SLUG}|${LEGACY_SLUG})-.*\\.db$`);

/** As above, for the remote store, where snapshots may also carry `.enc`. */
export const REMOTE_SNAPSHOT_RE = new RegExp(`^(?:${SLUG}|${LEGACY_SLUG})-.*\\.db(?:\\.enc)?$`);

/** Pulls the timestamp out of a snapshot filename under either name. */
export const BACKUP_STAMP_RE = new RegExp(
  `^(?:${SLUG}|${LEGACY_SLUG})-(\\d{4}-\\d{2}-\\d{2})T(\\d{2})-(\\d{2})-(\\d{2})\\.db$`
);

/**
 * Sort key for a snapshot filename, and the reason two prefixes need one.
 *
 * `prune()` and `latestSnapshot()` both rely on snapshot filenames sorting
 * chronologically, which they do while every name shares a prefix and carries
 * an ISO stamp. The moment two prefixes coexist that property breaks
 * *silently* and in the worst direction: `northstar-` sorts before `portage-`,
 * so today's snapshot lands at the oldest end of the list. `latestSnapshot()`
 * would hand the restore tool a three-week-old database, and `prune()`, which
 * deletes from the front, would delete this morning's backup and keep the
 * stale one.
 *
 * Stripping the prefix restores the property: what remains is the ISO stamp,
 * which sorts chronologically on its own. Names that match no prefix keep
 * their full form so they still sort deterministically rather than colliding.
 */
export function snapshotSortKey(name: string): string {
  return name.replace(new RegExp(`^(?:${SLUG}|${LEGACY_SLUG})-`), "");
}

/** Sorts snapshot filenames oldest-first, across both prefixes. */
export function sortSnapshots(names: string[]): string[] {
  return [...names].sort((a, b) => {
    const ka = snapshotSortKey(a);
    const kb = snapshotSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

/**
 * The application name Northstar puts in MSH-3 of the messages it sends.
 *
 * Defaults to `PORTAGE` — the pre-rename value — and that default is the point.
 * MSH-3 is not branding; it is the string a sending facility has typed into
 * their own interface configuration to say who they are talking to. Flipping
 * it because the product changed name would have a hospital's engine reject
 * our acknowledgements as coming from an application it has never heard of,
 * and the rejection would surface as unacknowledged messages piling up at
 * their end, not as an error at ours.
 *
 * So it moves when a deployment moves it, having agreed the change with the
 * sites on the other end, by setting `NORTHSTAR_HL7_APPLICATION`.
 */
export function hl7ApplicationName(source: NodeJS.ProcessEnv = process.env): string {
  return readEnv("HL7_APPLICATION", source) ?? "PORTAGE";
}
