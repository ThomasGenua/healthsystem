/**
 * A readable chart when the link is down.
 *
 * `demo/satlink.ts` proves the write path survives an outage: the queue holds,
 * order is preserved, everything drains on reconnection. The read path had no
 * equivalent, and a nurse in a community during a forty-hour outage could
 * queue what they wrote and see *nothing* of what was already known — no
 * allergies, no current medications, no reason for the last visit. That was
 * the one asymmetry left in a project named for exactly this condition.
 *
 * The design is docs/OFFLINE-CHART.md and this module is its spine.
 *
 * ## A second node, not a browser cache
 *
 * The station is the same binary against the same schema on a machine at the
 * site. Service workers and browser storage fail every obligation at once: no
 * at-rest encryption the deployment controls, no secure delete, no tenant
 * scoping, no consent machinery, no chained audit. All of those exist in the
 * server already, so this reuses the server.
 *
 * ## Two databases, on purpose
 *
 * The **cache** is a restored snapshot — the verified, encrypted one the
 * backup path already produces, because a cache that is a restore inherits a
 * rehearsed procedure instead of inventing a sync protocol. It is destroyed
 * when the budget runs out.
 *
 * The **station database** holds the manifest and the station's own audit
 * chain, and outlives the purge. That split is not tidiness: the record that
 * somebody read a chart during the outage still has to reach the primary's
 * trail afterwards, and destroying it with the cache would make an offline
 * read invisible to the access review built to find exactly that.
 *
 * ## One clock
 *
 * Everything the station decides is honest *as of the fill time*: the chart's
 * staleness, the consent directives it can see, the keys it will accept. The
 * serving budget is the deployment's written answer to how long as-of is good
 * enough, and past it the station serves nothing at all — a month-old chart
 * served because the outage lasted a month is the failure this exists to
 * refuse, not an edge case.
 */
import { existsSync, rmSync, statSync } from "node:fs";
import { basename, dirname } from "node:path";
import { Db } from "../db.ts";
import { AuditStore, type AuditEntry, type AuditRow } from "../audit/store.ts";
import { restore } from "./restore.ts";
import { verifyBackup } from "./backup.ts";
import { encryptionAtRest } from "./atrest.ts";
import { Refusal } from "./refusal.ts";

/** How long a station may serve from one fill, before it refuses and purges. */
export const DEFAULT_BUDGET_HOURS = 72;

export interface StationManifest {
  stationId: string;
  snapshot: string;
  /** When the data was true — the snapshot's stamp, not the copy's. */
  takenAt: string;
  filledAt: string;
  budgetHours: number;
  cachePath: string;
  purgedAt?: string;
  reconciledThrough: number;
}

/**
 * Whether the station may serve, and if not, why not in words a clinician can
 * act on.
 *
 * Never a bare boolean. "The station is not serving" sends somebody looking
 * for a bug; "the cache outlived its 72-hour budget and was destroyed" tells
 * them the link is what they need, and that nothing is broken.
 */
export type StationState =
  | { serving: true; asOf: string; ageHours: number; expiresAt: string; stationId: string }
  | { serving: false; reason: "never-filled" | "expired" | "purged" | "not-encrypted"; detail: string };

/**
 * When the data in a snapshot was true.
 *
 * `takeBackup` names files `portage-<ISO with : and . replaced by ->.db`, so
 * the stamp is recoverable from the name. A file that does not carry one falls
 * back to its modification time — later than the truth by however long the
 * copy took, which errs toward reporting the chart as *fresher* than it is.
 * That is the wrong direction, so a name that cannot be parsed is a warning
 * the caller receives rather than a silent substitution.
 */
export function snapshotTakenAt(path: string): { takenAt: string; fromName: boolean } {
  const name = basename(path);
  const m = /^portage-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})\.db$/.exec(name);
  if (m) {
    const iso = `${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`;
    const parsed = Date.parse(iso);
    if (!Number.isNaN(parsed)) return { takenAt: new Date(parsed).toISOString(), fromName: true };
  }
  return { takenAt: new Date(statSync(path).mtimeMs).toISOString(), fromName: false };
}

export interface FillOptions {
  /** The verified snapshot to fill from. */
  snapshot: string;
  /** Where the cached clinical database will live. */
  cachePath: string;
  /** Identifies this station on every audit row it writes. */
  stationId: string;
  budgetHours?: number;
  /** Skip the at-rest check. For tests and for an operator who has asserted it. */
  allowUnencrypted?: boolean;
  now?: string;
}

export interface FillResult {
  manifest: StationManifest;
  verified: ReturnType<typeof verifyBackup>;
  /** True when the age came from the file's mtime rather than its name. */
  ageFromMtime: boolean;
}

/**
 * Fills a station from a verified snapshot.
 *
 * The snapshot is verified, restored and dated before the manifest is written,
 * so a station that fails to fill has no manifest and therefore serves
 * nothing — rather than half a cache it would describe as whole.
 */
export function fillStation(station: Db, opts: FillOptions): FillResult {
  if (!existsSync(opts.snapshot)) throw new Refusal(`no snapshot at ${opts.snapshot}`, 404);

  // The at-rest posture is the primary's, verbatim (H-44). A station is a
  // machine in a nursing station rather than a locked server room, so a
  // stolen disk is a likelier event here than at the primary — which is a
  // reason to apply the check harder, not to relax it.
  if (!opts.allowUnencrypted) {
    // The directory, not the file: the cache does not exist yet at fill time,
    // and asking about a path that is not there resolves to the wrong mount.
    const atRest = encryptionAtRest(dirname(opts.cachePath));
    if (atRest.state === "not-encrypted") {
      throw new Refusal(
        `a reading station holds a second copy of the record and will not fill onto an unencrypted volume: ${atRest.detail}`,
        409
      );
    }
  }

  const verified = verifyBackup(opts.snapshot);
  const { takenAt, fromName } = snapshotTakenAt(opts.snapshot);
  restore({ snapshot: opts.snapshot, target: opts.cachePath });

  const filledAt = opts.now ?? new Date().toISOString();
  const budgetHours = opts.budgetHours ?? DEFAULT_BUDGET_HOURS;
  station.sql
    .prepare(
      `INSERT INTO station_manifest
         (tenant_id, station_id, snapshot, taken_at, filled_at, budget_hours, cache_path, purged_at, reconciled_through)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0)
       ON CONFLICT(tenant_id) DO UPDATE SET
         station_id = excluded.station_id,
         snapshot = excluded.snapshot,
         taken_at = excluded.taken_at,
         filled_at = excluded.filled_at,
         budget_hours = excluded.budget_hours,
         cache_path = excluded.cache_path,
         purged_at = NULL`
    )
    .run(station.tenantId, opts.stationId, basename(opts.snapshot), takenAt, filledAt, budgetHours, opts.cachePath);

  return { manifest: readManifest(station)!, verified, ageFromMtime: !fromName };
}

function readManifest(station: Db): StationManifest | undefined {
  const row = station.sql
    .prepare("SELECT * FROM station_manifest WHERE tenant_id = ?")
    .get(station.tenantId) as
    | {
        station_id: string;
        snapshot: string;
        taken_at: string;
        filled_at: string;
        budget_hours: number;
        cache_path: string;
        purged_at: string | null;
        reconciled_through: number;
      }
    | undefined;
  if (!row) return undefined;
  return {
    stationId: row.station_id,
    snapshot: row.snapshot,
    takenAt: row.taken_at,
    filledAt: row.filled_at,
    budgetHours: row.budget_hours,
    cachePath: row.cache_path,
    ...(row.purged_at ? { purgedAt: row.purged_at } : {}),
    reconciledThrough: row.reconciled_through,
  };
}

/**
 * A filled station, and the decisions that hang off its one clock.
 *
 * Holds the station's own database — manifest and chain — and never the cached
 * clinical data, which the caller mounts separately and this class only ever
 * describes and destroys.
 */
export class ReadingStation {
  readonly db: Db;
  readonly audit: AuditStore;

  constructor(stationDb: Db) {
    this.db = stationDb;
    this.audit = new AuditStore(stationDb);
  }

  manifest(): StationManifest | undefined {
    return readManifest(this.db);
  }

  /**
   * Whether this station may serve a chart right now.
   *
   * Fails closed at every branch. No manifest means nothing was ever filled;
   * a purged manifest means the cache is gone; past the budget means the
   * directives it holds are too old to be trusted about who may see what, and
   * the honest answer is nothing rather than a chart with an unknown lockbox.
   */
  state(now = new Date()): StationState {
    const m = this.manifest();
    if (!m) {
      return {
        serving: false,
        reason: "never-filled",
        detail: "this station has never been filled from a snapshot, so it holds no chart to serve",
      };
    }
    const takenMs = Date.parse(m.takenAt);
    if (Number.isNaN(takenMs)) {
      // The same rule the chart assembly applies one level down: a cache that
      // cannot establish its own age must not serve at all.
      return {
        serving: false,
        reason: "never-filled",
        detail: `this station cannot establish the age of its cache (${m.takenAt}), so it will not serve from it`,
      };
    }
    const ageHours = Math.max(0, Math.round(((now.getTime() - takenMs) / 36e5) * 10) / 10);
    const expiresAt = new Date(takenMs + m.budgetHours * 36e5).toISOString();

    if (m.purgedAt) {
      return {
        serving: false,
        reason: "purged",
        detail:
          `this station's cache outlived its ${m.budgetHours}-hour budget and was destroyed at ` +
          `${m.purgedAt}; a chart needs the link back or a fresh fill`,
      };
    }
    if (ageHours > m.budgetHours) {
      return {
        serving: false,
        reason: "expired",
        detail:
          `this station's cache is ${ageHours} hours old, past its ${m.budgetHours}-hour budget: ` +
          "a patient directive issued since the fill cannot be known here, so nothing is served",
      };
    }
    if (!existsSync(m.cachePath)) {
      return {
        serving: false,
        reason: "purged",
        detail: "this station's cached database is not present; it holds no chart to serve",
      };
    }
    return { serving: true, asOf: m.takenAt, ageHours, expiresAt, stationId: m.stationId };
  }

  /**
   * Records a read on the station's own chain.
   *
   * Its own genesis, its own hashes, the station's identity on every row —
   * chains are never merged. The primary's chain is a copy inside the cache
   * and writing into it would leave two divergent trails claiming the same
   * history, which is worse than no offline trail at all.
   */
  record(entry: AuditEntry): AuditRow {
    const m = this.manifest();
    const station = m?.stationId ?? "unfilled-station";
    return this.audit.record({
      ...entry,
      detail: entry.detail ? `[station ${station}] ${entry.detail}` : `[station ${station}]`,
    });
  }

  /** Rows not yet appended to the primary's trail, oldest first. */
  pending(): AuditRow[] {
    const through = this.manifest()?.reconciledThrough ?? 0;
    return this.audit.list({ limit: 100000 }).filter((r) => r.seq > through).sort((a, b) => a.seq - b.seq);
  }

  /**
   * Destroys the cached clinical database, keeping the chain.
   *
   * Autonomous: a station whose link never returns must stop being a copy of
   * the record sitting in a building nobody is watching. `PRAGMA
   * secure_delete` is the project's standing posture, so the pages the file
   * gave back were already overwritten; removing the file and its sidecars is
   * what closes it out. The manifest survives so the station can still say
   * why it is not serving, and the chain survives because those reads still
   * have to reach the primary.
   */
  expire(now = new Date()): { purged: boolean; detail: string } {
    const m = this.manifest();
    if (!m) return { purged: false, detail: "nothing to purge: this station has never been filled" };
    if (m.purgedAt) return { purged: false, detail: `already purged at ${m.purgedAt}` };

    const st = this.state(now);
    if (st.serving) {
      return {
        purged: false,
        detail: `still within budget until ${st.expiresAt}; a station inside its budget is not purged`,
      };
    }

    for (const suffix of ["", "-wal", "-shm"]) rmSync(m.cachePath + suffix, { force: true });
    const at = now.toISOString();
    this.db.sql
      .prepare("UPDATE station_manifest SET purged_at = ? WHERE tenant_id = ?")
      .run(at, this.db.tenantId);
    return { purged: true, detail: `cache destroyed at ${at}; the station's own trail is kept for reconciliation` };
  }

  markReconciled(throughSeq: number): void {
    this.db.sql
      .prepare("UPDATE station_manifest SET reconciled_through = ? WHERE tenant_id = ?")
      .run(throughSeq, this.db.tenantId);
  }
}

export interface ReconcileResult {
  appended: number;
  /** The station chain's own verification, carried onto the primary's trail. */
  stationChain: { ok: boolean; checked: number };
  /** Present when the station's chain did not verify — an incident, not a drop. */
  incident?: string;
  span?: { from: string; to: string };
}

/**
 * Appends a station's offline reads onto the primary's trail.
 *
 * **Append, never insert.** The primary's chain is not rewritten, reordered or
 * back-dated, and its truncation counter is untouched — the rows arrive as new
 * rows at the head, each carrying the station id, the time the read actually
 * happened and the station's own seq. So an access review of a patient sees
 * the offline read where it belongs in the story, dated when it happened and
 * chained when it arrived. Those are different facts and the row says both.
 *
 * A station chain that does not verify is still reconciled and then reported:
 * dropping the rows would destroy the only record of reads that occurred, and
 * a tampered trail is an incident for the privacy office rather than a reason
 * to have no trail at all.
 */
export function reconcile(
  station: ReadingStation,
  primary: AuditStore,
  by: { principalId: string; principalKind: string }
): ReconcileResult {
  const pending = station.pending();
  const chain = station.audit.verifyChain();
  const stationId = station.manifest()?.stationId ?? "unknown-station";

  for (const row of pending) {
    primary.record({
      action: row.action,
      outcome: row.outcome,
      principalId: row.principal_id,
      principalKind: row.principal_kind,
      method: row.method,
      path: row.path,
      ...(row.resource_type ? { resourceType: row.resource_type } : {}),
      ...(row.resource_id ? { resourceId: row.resource_id } : {}),
      ...(row.patient ? { patient: row.patient } : {}),
      ...(row.count !== null && row.count !== undefined ? { count: row.count } : {}),
      ...(row.purpose_of_use ? { purposeOfUse: row.purpose_of_use } : {}),
      ...(row.organization_id ? { organizationId: row.organization_id } : {}),
      ...(row.practitioner_id ? { practitionerId: row.practitioner_id } : {}),
      detail:
        `reconciled from station ${stationId}: read at ${row.recorded_at} (station seq ${row.seq})` +
        (row.detail ? ` — ${row.detail}` : ""),
    });
  }

  const span =
    pending.length > 0
      ? { from: pending[0].recorded_at, to: pending[pending.length - 1].recorded_at }
      : undefined;

  primary.record({
    action: "E",
    outcome: chain.ok ? 0 : 8,
    principalId: by.principalId,
    principalKind: by.principalKind,
    method: "POST",
    path: "/api/station/reconcile",
    resourceType: "AuditEvent",
    count: pending.length,
    detail:
      `station ${stationId} reconciled: ${pending.length} row${pending.length === 1 ? "" : "s"}` +
      (span ? ` spanning ${span.from} to ${span.to}` : " (none pending)") +
      `; station chain ${chain.ok ? `verified over ${chain.checked} rows` : "DID NOT VERIFY"}`,
  });

  if (pending.length > 0) station.markReconciled(pending[pending.length - 1].seq);

  return {
    appended: pending.length,
    stationChain: { ok: chain.ok, checked: chain.checked },
    ...(span ? { span } : {}),
    ...(chain.ok
      ? {}
      : {
          incident:
            `the trail from station ${stationId} did not verify. Its rows were appended rather than dropped — ` +
            "the record that these reads happened is not optional — and this is an incident for the privacy office.",
        }),
  };
}
