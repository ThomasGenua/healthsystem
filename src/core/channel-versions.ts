/**
 * Channel configuration as a ledger, not a cell to overwrite.
 *
 * Everything else this system moves is provenance-carrying: messages chain,
 * the clinical record is append-only, audit rows chain, retention leaves
 * verifiable stubs. The configuration that determines how all of it is
 * produced was the one exception — `upsertChannel` overwrote in place, so a
 * mapping change that started dropping a segment at 14:00 left an operator an
 * `updated_at`, the current config, and their memory of what it used to say.
 *
 * Every change is now a version carrying who, when, why, and how it came to
 * be (edit, import, rollback, delete — or baseline, the state found when
 * versioning first touched a channel that predates it). Two versions diff at
 * the field level. A rollback restores old content as a new version, never by
 * mutation, so the history never lies about the order things happened in. An
 * import is a plan before it is an action.
 *
 * Config versions are not patient data: retention's purge schedule never
 * touches them, deliberately. The history of how an interface was configured
 * is operational memory, and it is cheap.
 */
import type { Db } from "../db.ts";
import { Refusal } from "./refusal.ts";

export type VersionOrigin = "baseline" | "edit" | "import" | "rollback" | "delete";

export interface ChannelVersionRow {
  seq: number;
  tenant_id: string;
  channel_id: string;
  version: number;
  name: string;
  enabled: number;
  config: string;
  origin: VersionOrigin;
  rollback_of: number | null;
  note: string;
  changed_by: string;
  changed_at: string;
}

/** One field-level difference between two versions. */
export interface ConfigDiff {
  /** Dotted path into the config, or "name" / "enabled". */
  path: string;
  from: unknown;
  to: unknown;
}

/** What applying an import document would do to one channel. */
export interface ImportPlanEntry {
  channelId: string;
  action: "create" | "change" | "unchanged";
  diff: ConfigDiff[];
}

export interface ImportPlan {
  entries: ImportPlanEntry[];
  /**
   * Channels that exist live but are absent from the document. Reported, and
   * deliberately never deleted: an import that silently removed whatever the
   * file forgot to mention would turn every partial export into an outage.
   */
  absent: string[];
}

/** The exported shape of one channel: its config, plus the enabled state. */
export interface ChannelDocument {
  id: string;
  name: string;
  enabled: boolean;
  config: Record<string, unknown>;
}

export class ChannelVersions {
  private db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /**
   * Records a new shape for a channel and applies it to the live row, as one
   * transaction.
   *
   * An identical shape writes nothing — the same position the clinical record
   * takes on resent content: a history that grew a version per no-op save
   * would bury the two changes that mattered under four hundred that said
   * nothing.
   *
   * The first time this touches a channel that predates versioning, the state
   * it found is captured as version 1 (`baseline`) before the change lands as
   * version 2 — otherwise the first versioned edit would destroy the last
   * unversioned config, which is the exact loss this table exists to end.
   */
  commit(input: {
    channelId: string;
    name: string;
    enabled: boolean;
    config: string;
    by: string;
    note: string;
    origin?: Extract<VersionOrigin, "edit" | "import" | "rollback">;
    rollbackOf?: number;
  }): { version: ChannelVersionRow; changed: boolean } {
    return this.db.transaction(() => {
      const head = this.head(input.channelId);
      const live = this.db.getChannel(input.channelId);

      if (!head && live) {
        this.insert({
          channelId: input.channelId,
          version: 1,
          name: live.name,
          enabled: live.enabled === 1,
          config: live.config,
          origin: "baseline",
          note: "state found when versioning first touched this channel",
          by: "(pre-versioning)",
        });
      }

      const prior = this.head(input.channelId);
      if (prior && sameShape(prior, input)) {
        return { version: prior, changed: false };
      }

      const row = this.insert({
        channelId: input.channelId,
        version: (prior?.version ?? 0) + 1,
        name: input.name,
        enabled: input.enabled,
        config: input.config,
        origin: input.origin ?? "edit",
        note: input.note,
        by: input.by,
        ...(input.rollbackOf !== undefined ? { rollbackOf: input.rollbackOf } : {}),
      });
      this.db.upsertChannel(input.channelId, input.name, input.enabled, input.config);
      this.db.sql
        .prepare("UPDATE channels SET config_version = ? WHERE tenant_id = ? AND id = ?")
        .run(row.version, this.db.tenantId, input.channelId);
      return { version: row, changed: true };
    });
  }

  /**
   * Records that a channel was deleted, before the row goes.
   *
   * The history outlives the channel on purpose: "who turned the ADT feed off
   * on Tuesday" is the question this table exists for, and deletion is its
   * sharpest form. A deleted channel can be brought back by rolling back to
   * any version before the delete marker.
   */
  markDeleted(channelId: string, by: { actorId: string; note: string }): ChannelVersionRow | undefined {
    return this.db.transaction(() => {
      const live = this.db.getChannel(channelId);
      if (!live) return undefined;
      const head = this.head(channelId);
      if (!head) {
        this.insert({
          channelId,
          version: 1,
          name: live.name,
          enabled: live.enabled === 1,
          config: live.config,
          origin: "baseline",
          note: "state found when versioning first touched this channel",
          by: "(pre-versioning)",
        });
      }
      const prior = this.head(channelId)!;
      return this.insert({
        channelId,
        version: prior.version + 1,
        name: live.name,
        enabled: false,
        config: live.config,
        origin: "delete",
        note: by.note,
        by: by.actorId,
      });
    });
  }

  /**
   * Restores an old version's content — as a new version, never by mutation.
   *
   * Works whether or not the channel still exists live, which is what makes a
   * deletion recoverable: the history holds everything needed to put the row
   * back.
   */
  rollback(channelId: string, toVersion: number, by: { actorId: string; note: string }): ChannelVersionRow {
    const target = this.get(channelId, toVersion);
    if (!target) throw new Refusal(`channel ${channelId} has no version ${toVersion}`, 404);
    if (target.origin === "delete") {
      throw new Refusal(`version ${toVersion} is the deletion marker; roll back to a version before it`, 409);
    }
    const r = this.commit({
      channelId,
      name: target.name,
      enabled: target.enabled === 1,
      config: target.config,
      by: by.actorId,
      note: by.note,
      origin: "rollback",
      rollbackOf: toVersion,
    });
    if (!r.changed) {
      throw new Refusal(`channel ${channelId} is already at the shape of version ${toVersion}`, 409);
    }
    return r.version;
  }

  /** Every shape this channel has had, newest first. */
  history(channelId: string): ChannelVersionRow[] {
    return this.db.sql
      .prepare("SELECT * FROM channel_versions WHERE tenant_id = ? AND channel_id = ? ORDER BY version DESC")
      .all(this.db.tenantId, channelId) as unknown as ChannelVersionRow[];
  }

  get(channelId: string, version: number): ChannelVersionRow | undefined {
    return this.db.sql
      .prepare("SELECT * FROM channel_versions WHERE tenant_id = ? AND channel_id = ? AND version = ?")
      .get(this.db.tenantId, channelId, version) as unknown as ChannelVersionRow | undefined;
  }

  /**
   * What changed between two versions, at the field level.
   *
   * `from`/`to` are whole values at the deepest path that differs, so "the
   * third destination's URL changed" reads as exactly that rather than as two
   * unreadable JSON blobs an operator has to eyeball.
   */
  diff(channelId: string, fromVersion: number, toVersion: number): ConfigDiff[] {
    const a = this.get(channelId, fromVersion);
    const b = this.get(channelId, toVersion);
    if (!a) throw new Refusal(`channel ${channelId} has no version ${fromVersion}`, 404);
    if (!b) throw new Refusal(`channel ${channelId} has no version ${toVersion}`, 404);
    return diffShapes(shapeOf(a), shapeOf(b));
  }

  // ---- export and import ---------------------------------------------------

  /** One channel, in the form source control holds and an operator edits. */
  exportChannel(channelId: string): ChannelDocument {
    const live = this.db.getChannel(channelId);
    if (!live) throw new Refusal(`no channel ${channelId}`, 404);
    return {
      id: channelId,
      name: live.name,
      enabled: live.enabled === 1,
      config: JSON.parse(live.config) as Record<string, unknown>,
    };
  }

  exportAll(): ChannelDocument[] {
    return this.db
      .listChannels()
      .map((c) => c.id)
      .sort()
      .map((id) => this.exportChannel(id));
  }

  /**
   * What applying a document would do — computed without writing anything.
   *
   * The plan is the review: which channels appear, which change and exactly
   * how, which are untouched, and which live channels the document does not
   * mention. Nothing is a surprise at apply time, because apply does exactly
   * what the plan said.
   */
  plan(docs: ChannelDocument[]): ImportPlan {
    const seen = new Set<string>();
    const entries: ImportPlanEntry[] = docs.map((doc) => {
      seen.add(doc.id);
      const live = this.db.getChannel(doc.id);
      if (!live) {
        return { channelId: doc.id, action: "create", diff: [] };
      }
      const current = { name: live.name, enabled: live.enabled === 1, config: live.config };
      const proposed = { name: doc.name, enabled: doc.enabled, config: JSON.stringify(doc.config) };
      const diff = diffShapes(
        { name: current.name, enabled: current.enabled, config: JSON.parse(current.config) as unknown },
        { name: proposed.name, enabled: proposed.enabled, config: doc.config }
      );
      return { channelId: doc.id, action: diff.length === 0 ? "unchanged" : "change", diff };
    });
    const absent = this.db
      .listChannels()
      .map((c) => c.id)
      .filter((id) => !seen.has(id))
      .sort();
    return { entries, absent };
  }

  /**
   * Applies a document: every create and change becomes a version, in one
   * transaction, and the returned plan is what actually happened.
   */
  apply(docs: ChannelDocument[], by: { actorId: string; note: string }): ImportPlan {
    return this.db.transaction(() => {
      const planned = this.plan(docs);
      for (const entry of planned.entries) {
        if (entry.action === "unchanged") continue;
        const doc = docs.find((d) => d.id === entry.channelId)!;
        this.commit({
          channelId: doc.id,
          name: doc.name,
          enabled: doc.enabled,
          config: JSON.stringify(doc.config),
          by: by.actorId,
          note: by.note,
          origin: "import",
        });
      }
      return planned;
    });
  }

  // ---- internals -----------------------------------------------------------

  private head(channelId: string): ChannelVersionRow | undefined {
    return this.db.sql
      .prepare(
        "SELECT * FROM channel_versions WHERE tenant_id = ? AND channel_id = ? ORDER BY version DESC LIMIT 1"
      )
      .get(this.db.tenantId, channelId) as unknown as ChannelVersionRow | undefined;
  }

  private insert(input: {
    channelId: string;
    version: number;
    name: string;
    enabled: boolean;
    config: string;
    origin: VersionOrigin;
    note: string;
    by: string;
    rollbackOf?: number;
  }): ChannelVersionRow {
    this.db.sql
      .prepare(
        `INSERT INTO channel_versions
           (tenant_id, channel_id, version, name, enabled, config, origin, rollback_of, note, changed_by, changed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        this.db.tenantId,
        input.channelId,
        input.version,
        input.name,
        input.enabled ? 1 : 0,
        input.config,
        input.origin,
        input.rollbackOf ?? null,
        input.note,
        input.by,
        new Date().toISOString()
      );
    return this.get(input.channelId, input.version)!;
  }
}

/** The comparable shape of a version or a proposed change. */
function shapeOf(v: { name: string; enabled: number; config: string }): {
  name: string;
  enabled: boolean;
  config: unknown;
} {
  return { name: v.name, enabled: v.enabled === 1, config: JSON.parse(v.config) as unknown };
}

/**
 * Equality by meaning, not by string: two configs whose JSON differs only in
 * key order are the same configuration, and a version recorded for a
 * reserialisation would be noise wearing a timestamp.
 */
function sameShape(
  prior: { name: string; enabled: number; config: string },
  next: { name: string; enabled: boolean; config: string }
): boolean {
  return (
    prior.name === next.name &&
    (prior.enabled === 1) === next.enabled &&
    canonical(JSON.parse(prior.config)) === canonical(JSON.parse(next.config))
  );
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function diffShapes(
  a: { name: string; enabled: boolean; config: unknown },
  b: { name: string; enabled: boolean; config: unknown }
): ConfigDiff[] {
  const out: ConfigDiff[] = [];
  if (a.name !== b.name) out.push({ path: "name", from: a.name, to: b.name });
  if (a.enabled !== b.enabled) out.push({ path: "enabled", from: a.enabled, to: b.enabled });
  walk("config", a.config, b.config, out);
  return out;
}

function walk(path: string, a: unknown, b: unknown, out: ConfigDiff[]): void {
  if (canonical(a) === canonical(b)) return;
  const bothObjects =
    a !== null && b !== null && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b);
  if (!bothObjects) {
    // Arrays included: a reordered destination list is a change in meaning
    // (order is delivery order), so it reports at the array's own path.
    out.push({ path, from: a, to: b });
    return;
  }
  const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
  for (const key of [...keys].sort()) {
    walk(`${path}.${key}`, (a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], out);
  }
}
