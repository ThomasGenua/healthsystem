/** SQLite persistence via node:sqlite. Single writer, WAL mode. */
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";
import type { ApiKeyRow, DeliveryRow, MessageRow, MessageStatus, SubscriptionRow } from "./types.ts";

/** Whether a pid is still running. Signal 0 checks without delivering. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to someone else, which still counts.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  config TEXT NOT NULL,
  last_hash TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  channel_id TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  source_type TEXT NOT NULL,
  content_type TEXT NOT NULL,
  raw TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'received',
  error TEXT,
  meta TEXT,
  hash TEXT NOT NULL,
  prev_hash TEXT,
  -- SHA-256 of the raw payload, recorded at ingest. The chain commits to this
  -- rather than to the payload itself, so lineage stays verifiable after the
  -- payload is redacted under a retention policy. NULL on rows written before
  -- retention existed, which verify by the older formula.
  raw_digest TEXT,
  redacted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_received ON messages(received_at);
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, seq);
CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status);

CREATE TABLE IF NOT EXISTS message_steps (
  message_id TEXT NOT NULL,
  step_index INTEGER NOT NULL,
  name TEXT NOT NULL,
  output TEXT,
  at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (message_id, step_index)
);

CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  destination_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  ordering_key TEXT NOT NULL,
  ordered INTEGER NOT NULL DEFAULT 0,
  skip_on_dead INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 8,
  next_attempt_at INTEGER NOT NULL,
  payload TEXT NOT NULL,
  content_type TEXT NOT NULL,
  last_error TEXT,
  ack TEXT,
  delivered_at TEXT,
  -- Set when retention emptied this row's payload. Replay consults it: the
  -- tombstone must never go out to a downstream system as if it were the
  -- message.
  redacted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_deliveries_due ON deliveries(state, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_deliveries_order ON deliveries(ordering_key, seq);
-- The ordered-delivery gate asks "is any earlier delivery for this key still
-- undelivered". Without this it scans every row sharing the key, which grows
-- with the backlog — exactly when draining matters most.
-- rowid cannot be named in an index, and does not need to be: index entries
-- for a given (ordering_key, state) are already ordered by rowid, so MIN(rowid)
-- is the first entry of the range.
CREATE INDEX IF NOT EXISTS idx_deliveries_gate ON deliveries(ordering_key, state);
CREATE INDEX IF NOT EXISTS idx_deliveries_message ON deliveries(message_id);

CREATE TABLE IF NOT EXISTS fhir_resources (
  resource_type TEXT NOT NULL,
  id TEXT NOT NULL,
  version_id INTEGER NOT NULL,
  json TEXT NOT NULL,
  hash TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (resource_type, id)
);
CREATE INDEX IF NOT EXISTS idx_fhir_updated ON fhir_resources(resource_type, updated_at);

CREATE TABLE IF NOT EXISTS fhir_identifiers (
  resource_type TEXT NOT NULL,
  id TEXT NOT NULL,
  system TEXT NOT NULL DEFAULT '',
  value TEXT NOT NULL,
  PRIMARY KEY (resource_type, id, system, value)
);
CREATE INDEX IF NOT EXISTS idx_fhir_ident_value ON fhir_identifiers(value, system);

CREATE TABLE IF NOT EXISTS channel_state (
  channel_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT,
  PRIMARY KEY (channel_id, key)
);

CREATE TABLE IF NOT EXISTS term_concepts (
  system TEXT NOT NULL,
  code TEXT NOT NULL,
  display TEXT,
  PRIMARY KEY (system, code)
);

CREATE TABLE IF NOT EXISTS term_valueset_members (
  valueset TEXT NOT NULL,
  system TEXT NOT NULL,
  code TEXT NOT NULL,
  PRIMARY KEY (valueset, system, code)
);

CREATE TABLE IF NOT EXISTS term_map_entries (
  map_id TEXT NOT NULL,
  source_system TEXT NOT NULL,
  source_code TEXT NOT NULL,
  target_system TEXT NOT NULL,
  target_code TEXT NOT NULL,
  target_display TEXT,
  equivalence TEXT NOT NULL DEFAULT 'equivalent',
  PRIMARY KEY (map_id, source_system, source_code, target_system, target_code)
);

CREATE TABLE IF NOT EXISTS fhir_subscriptions (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'active',
  criteria TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT 'application/fhir+json',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Only the SHA-256 of a key is stored. The key itself is shown once, at issue
-- time, and is unrecoverable afterwards.
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(hash);

-- Access audit trail, hash-chained like message lineage so a row cannot be
-- altered or removed without breaking verification. Carries identifiers and
-- references only, never payloads.
CREATE TABLE IF NOT EXISTS audit_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  recorded_at TEXT NOT NULL,
  action TEXT NOT NULL,
  outcome INTEGER NOT NULL DEFAULT 0,
  principal_id TEXT NOT NULL,
  principal_kind TEXT NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  resource_type TEXT,
  resource_id TEXT,
  patient TEXT,
  count INTEGER,
  source_ip TEXT,
  detail TEXT,
  hash TEXT NOT NULL,
  prev_hash TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_recorded ON audit_events(recorded_at);
CREATE INDEX IF NOT EXISTS idx_audit_principal ON audit_events(principal_id, recorded_at);
CREATE INDEX IF NOT EXISTS idx_audit_patient ON audit_events(patient, recorded_at);

-- At most one engine may own a database. Two would both claim due deliveries
-- and each would requeue the other's in-flight ones, duplicating messages.
-- The CHECK keeps it to a single row.
CREATE TABLE IF NOT EXISTS instance_lock (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  pid INTEGER NOT NULL,
  host TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  heartbeat_at INTEGER NOT NULL
);
`;

export interface DbOptions {
  /**
   * Open without writing. Used to inspect a backup snapshot: the schema is
   * already there, and applying it would fail against a read-only file.
   */
  readOnly?: boolean;
}

/**
 * Columns added to a table after it first shipped.
 *
 * `CREATE TABLE IF NOT EXISTS` does nothing at all to a table that already
 * exists, so a column added to SCHEMA never reaches a database an earlier
 * version created. Nothing complains on open — the failure arrives on the
 * first statement that names the column, which is the first ingest, so an
 * upgrade takes a working node off the air. New tables and new indexes are
 * fine, because IF NOT EXISTS does the right thing for those; only columns
 * need this.
 *
 * Every entry is nullable, which is what lets SQLite add it in place instead
 * of rewriting the table, and what lets existing rows read as "written before
 * this column existed".
 */
const ADDED_COLUMNS: Array<{ table: string; column: string; type: string }> = [
  { table: "messages", column: "raw_digest", type: "TEXT" },
  { table: "messages", column: "redacted_at", type: "TEXT" },
  { table: "deliveries", column: "redacted_at", type: "TEXT" },
];

export class Db {
  readonly sql: DatabaseSync;

  constructor(path: string, opts: DbOptions = {}) {
    if (opts.readOnly) {
      this.sql = new DatabaseSync(path, { readOnly: true });
      return;
    }
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.sql = new DatabaseSync(path);
    this.sql.exec("PRAGMA journal_mode = WAL;");
    this.sql.exec("PRAGMA foreign_keys = ON;");
    // Overwrite freed content with zeros instead of leaving it in place.
    // Without this, redacting a payload only detaches it: SQLite unlinks the
    // old row and moves on, and the bytes stay legible in the file until some
    // later write happens to reuse the page. A retention sweep would report
    // success while a copy of the database — a backup, a decommissioned disk,
    // an imaged VM — still yielded the patient record, which is the threat
    // retention exists to answer. Verified in test/retention-leak.test.ts by
    // searching the file rather than the columns.
    this.sql.exec("PRAGMA secure_delete = ON;");
    this.sql.exec(SCHEMA);
    this.migrate();
  }

  /**
   * Brings a database created by an earlier version up to the current schema.
   *
   * Runs on every open and is a no-op once there is nothing to add, so it
   * costs one PRAGMA per tracked column at boot and needs no version counter
   * to stay in step.
   */
  private migrate(): void {
    for (const { table, column, type } of ADDED_COLUMNS) {
      const cols = this.sql.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      // An empty result means the table is not there at all, which SCHEMA
      // has just seen to; there is nothing to alter.
      if (cols.length === 0 || cols.some((c) => c.name === column)) continue;
      this.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  }

  close(): void {
    this.sql.close();
  }

  /**
   * Runs fn as one transaction: it commits on return, rolls back on throw.
   *
   * Two reasons ingest needs this. Correctness first — the pipeline writes a
   * message, its steps and its delivery rows separately, so without a
   * transaction a crash partway leaves a stored message that will never be
   * delivered and that nothing retries. And speed: each statement would
   * otherwise be its own commit, and a commit is an fsync, so a single ingest
   * paid for half a dozen of them.
   *
   * Not reentrant, which is safe here because everything inside is
   * synchronous — no other JavaScript can run partway through.
   */
  transaction<T>(fn: () => T): T {
    this.sql.exec("BEGIN");
    try {
      const out = fn();
      this.sql.exec("COMMIT");
      return out;
    } catch (err) {
      try {
        this.sql.exec("ROLLBACK");
      } catch {
        // A rollback that fails leaves the original error the useful one.
      }
      throw err;
    }
  }

  /* ------------------------------ channels ------------------------------ */

  upsertChannel(id: string, name: string, enabled: boolean, config: string): void {
    this.sql
      .prepare(
        `INSERT INTO channels (id, name, enabled, config) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, enabled = excluded.enabled,
           config = excluded.config, updated_at = datetime('now')`
      )
      .run(id, name, enabled ? 1 : 0, config);
  }

  getChannel(id: string): { id: string; name: string; enabled: number; config: string; last_hash: string | null } | undefined {
    return this.sql.prepare("SELECT id, name, enabled, config, last_hash FROM channels WHERE id = ?").get(id) as
      | { id: string; name: string; enabled: number; config: string; last_hash: string | null }
      | undefined;
  }

  listChannels(): Array<{ id: string; name: string; enabled: number; config: string }> {
    return this.sql.prepare("SELECT id, name, enabled, config FROM channels ORDER BY id").all() as Array<{
      id: string;
      name: string;
      enabled: number;
      config: string;
    }>;
  }

  deleteChannel(id: string): void {
    this.sql.prepare("DELETE FROM channels WHERE id = ?").run(id);
  }

  /* ------------------------------ messages ------------------------------ */

  /** Insert a message, extending the channel hash chain. Returns the row. */
  insertMessage(channelId: string, sourceType: string, contentType: string, raw: string, meta?: unknown): MessageRow {
    const ch = this.getChannel(channelId);
    const prev = ch?.last_hash ?? null;
    const rawDigest = createHash("sha256").update(raw).digest("hex");
    // The chain commits to the digest rather than the payload. It is the same
    // commitment cryptographically, and it means a payload redacted under a
    // retention policy leaves the chain fully verifiable instead of broken.
    const hash = createHash("sha256")
      .update(prev ?? "")
      .update("|")
      .update(channelId)
      .update("|")
      .update(rawDigest)
      .digest("hex");
    const id = randomUUID();
    this.sql
      .prepare(
        `INSERT INTO messages (id, channel_id, source_type, content_type, raw, meta, hash, prev_hash, raw_digest)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, channelId, sourceType, contentType, raw, meta ? JSON.stringify(meta) : null, hash, prev, rawDigest);
    this.sql.prepare("UPDATE channels SET last_hash = ? WHERE id = ?").run(hash, channelId);
    return this.getMessage(id)!;
  }

  getMessage(id: string): MessageRow | undefined {
    return this.sql.prepare("SELECT * FROM messages WHERE id = ?").get(id) as MessageRow | undefined;
  }

  setMessageStatus(id: string, status: MessageStatus, error?: string): void {
    this.sql.prepare("UPDATE messages SET status = ?, error = ? WHERE id = ?").run(status, error ?? null, id);
  }

  listMessages(filter: { channelId?: string; status?: string; limit?: number }): MessageRow[] {
    const clauses: string[] = [];
    const args: unknown[] = [];
    if (filter.channelId) {
      clauses.push("channel_id = ?");
      args.push(filter.channelId);
    }
    if (filter.status) {
      clauses.push("status = ?");
      args.push(filter.status);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = Math.min(filter.limit ?? 100, 1000);
    return this.sql
      .prepare(`SELECT * FROM messages ${where} ORDER BY seq DESC LIMIT ${limit}`)
      .all(...(args as never[])) as unknown as MessageRow[];
  }

  /**
   * How many messages a channel holds. Served by idx_messages_channel, so it
   * stays cheap as the log grows — which matters because /metrics asks on
   * every scrape.
   */
  countMessages(channelId: string): number {
    return (
      this.sql.prepare("SELECT COUNT(*) AS n FROM messages WHERE channel_id = ?").get(channelId) as { n: number }
    ).n;
  }

  addStep(messageId: string, index: number, name: string, output: string | null): void {
    this.sql
      .prepare("INSERT INTO message_steps (message_id, step_index, name, output) VALUES (?, ?, ?, ?)")
      .run(messageId, index, name, output);
  }

  getSteps(messageId: string): Array<{ step_index: number; name: string; output: string | null; at: string }> {
    return this.sql
      .prepare("SELECT step_index, name, output, at FROM message_steps WHERE message_id = ? ORDER BY step_index")
      .all(messageId) as Array<{ step_index: number; name: string; output: string | null; at: string }>;
  }

  /**
   * Walks a channel's hash chain.
   *
   * Linkage alone is not enough, and this is the part that is easy to get
   * wrong. Walking forward from the beginning catches an edited row and a row
   * removed from the middle — the next row's back-pointer stops matching — but
   * it cannot catch rows removed from the *end*, because nothing after them
   * survives to point at them. A truncated chain is a shorter chain that
   * verifies perfectly. Since deleting the most recent entries is precisely
   * what someone covering their tracks would do, that is the case worth
   * catching.
   *
   * So the walk ends by comparing where it arrived against the tip the channel
   * has been carrying all along, which is written on every insert and is not
   * derivable from the surviving rows.
   *
   * Three further wrinkles, all honest rather than incidental:
   *
   *   Rows written before retention existed have no raw_digest and chain over
   *   the payload directly; they verify by that older formula, so an existing
   *   database keeps verifying across the upgrade.
   *
   *   A redacted row no longer holds the payload, but the chain commits to the
   *   digest recorded at ingest, so the link still verifies in full. What is
   *   lost is only the ability to re-derive that digest from the payload — so
   *   `payloadsChecked` reports how many rows still prove their own content.
   *
   *   A purged prefix leaves the first surviving row pointing at a hash that
   *   is gone. The tip at the time of the purge is kept, so linkage still
   *   verifies, and `verifiedFrom` says where the chain now begins. A purge
   *   removes a prefix and never the tip, so it does not disturb the check
   *   above — and a channel purged in its entirety keeps the tip it ended on.
   */
  verifyChain(channelId: string): {
    ok: boolean;
    checked: number;
    payloadsChecked: number;
    redacted: number;
    tip?: string;
    verifiedFrom?: string;
    brokenAt?: string;
    truncated?: { expectedTip: string; foundTip: string | null };
  } {
    const rows = this.sql
      .prepare("SELECT id, raw, hash, prev_hash, raw_digest, redacted_at FROM messages WHERE channel_id = ? ORDER BY seq")
      .all(channelId) as Array<{
      id: string;
      raw: string;
      hash: string;
      prev_hash: string | null;
      raw_digest: string | null;
      redacted_at: string | null;
    }>;

    const purgedTip = this.getChannelState(channelId, "purged_tip");
    const purgedBefore = this.getChannelState(channelId, "purged_before");
    let prev: string | null = purgedTip ?? null;
    let checked = 0;
    let payloadsChecked = 0;
    let redacted = 0;

    for (const r of rows) {
      const committed = r.raw_digest ?? r.raw;
      const expect: string = createHash("sha256")
        .update(prev ?? "")
        .update("|")
        .update(channelId)
        .update("|")
        .update(committed)
        .digest("hex");
      if (r.prev_hash !== prev || r.hash !== expect) {
        return { ok: false, checked, payloadsChecked, redacted, brokenAt: r.id, ...(purgedBefore ? { verifiedFrom: purgedBefore } : {}) };
      }
      if (r.redacted_at) {
        redacted++;
      } else if (r.raw_digest) {
        // The payload is still here, so it can be proved to be the one the
        // chain committed to.
        const actual = createHash("sha256").update(r.raw).digest("hex");
        if (actual !== r.raw_digest) {
          return { ok: false, checked, payloadsChecked, redacted, brokenAt: r.id };
        }
        payloadsChecked++;
      } else {
        payloadsChecked++;
      }
      prev = r.hash;
      checked++;
    }

    // Where the walk arrived has to be where the channel says it should be.
    // Nothing among the surviving rows can supply this, which is what makes it
    // worth checking: an attacker who deletes the tail has to know to move the
    // tip as well.
    const expectedTip = this.getChannel(channelId)?.last_hash ?? null;
    const from = purgedBefore ? { verifiedFrom: purgedBefore } : {};
    if (expectedTip !== null && prev !== expectedTip) {
      return {
        ok: false,
        checked,
        payloadsChecked,
        redacted,
        truncated: { expectedTip, foundTip: prev },
        ...from,
      };
    }
    return { ok: true, checked, payloadsChecked, redacted, ...(prev ? { tip: prev } : {}), ...from };
  }

  /* ------------------------------ retention ----------------------------- */

  /**
   * Replaces stored payloads older than the cutoff with a tombstone.
   *
   * This is the primary retention control: the message, its lineage, its
   * steps and its deliveries all remain as rows, and the chain still verifies,
   * but the patient data is gone.
   *
   * "Gone" has to mean every copy, and the engine keeps more than one. The
   * message log holds what arrived; a pipeline step holds what the transform
   * produced from it, which is the same patient by another encoding; a
   * delivery holds what was sent. Less obviously, a delivery also holds what
   * the remote said back — a FHIR server answering a create returns the
   * resource, and a rejection quotes the value it objected to. Redacting only
   * the first of those leaves the record fully reconstructible and reports
   * success while doing it, which is the worst shape a privacy control can
   * take.
   *
   * Verified by searching the database file for the patient's identifiers
   * after a sweep, rather than by checking the columns this comment happens to
   * list. See test/retention-leak.test.ts.
   */
  redactBefore(cutoffIso: string, channelId?: string): { messages: number; deliveries: number; steps: number } {
    const where = channelId ? " AND channel_id = ?" : "";
    const args = channelId ? [cutoffIso, channelId] : [cutoffIso];

    const messages = this.sql
      .prepare(
        `UPDATE messages SET raw = '[redacted]', redacted_at = datetime('now')
          WHERE received_at < ? AND redacted_at IS NULL AND raw_digest IS NOT NULL${where}`
      )
      .run(...(args as never[])).changes;

    const steps = this.sql
      .prepare(
        `UPDATE message_steps SET output = '[redacted]'
          WHERE output IS NOT NULL AND output != '[redacted]'
            AND message_id IN (SELECT id FROM messages WHERE received_at < ?${where})`
      )
      .run(...(args as never[])).changes;

    // Every settled state, dead included. A dead-lettered delivery sits in the
    // queue indefinitely waiting for an operator, which makes the DLQ the
    // longest-lived copy in the system and the last one that should be
    // exempt. Only queued and inflight are spared, because those still have to
    // be deliverable.
    const deliveries = this.sql
      .prepare(
        `UPDATE deliveries
            SET payload = '[redacted]', ack = CASE WHEN ack IS NULL THEN NULL ELSE '[redacted]' END,
                last_error = CASE WHEN last_error IS NULL THEN NULL ELSE '[redacted]' END,
                redacted_at = datetime('now')
          WHERE state IN ('delivered', 'discarded', 'dead')
            AND redacted_at IS NULL
            AND message_id IN (SELECT id FROM messages WHERE received_at < ?${where})`
      )
      .run(...(args as never[])).changes;

    return { messages: Number(messages), deliveries: Number(deliveries), steps: Number(steps) };
  }

  /**
   * Deletes messages older than the cutoff outright, for reclaiming disk.
   *
   * Redaction is usually the better answer, since it keeps the record of what
   * flowed and when. Where this is genuinely needed, the chain tip at the
   * purge point is kept so the surviving chain still verifies and reports
   * where it now begins, rather than looking tampered with.
   */
  purgeBefore(cutoffIso: string, channelId?: string): { messages: number; channels: string[] } {
    const channels = channelId
      ? [channelId]
      : (this.sql.prepare("SELECT DISTINCT channel_id AS c FROM messages").all() as Array<{ c: string }>).map((r) => r.c);

    let total = 0;
    const touched: string[] = [];
    for (const ch of channels) {
      const last = this.sql
        .prepare("SELECT id, hash, received_at FROM messages WHERE channel_id = ? AND received_at < ? ORDER BY seq DESC LIMIT 1")
        .get(ch, cutoffIso) as { id: string; hash: string; received_at: string } | undefined;
      if (!last) continue;

      const ids = this.sql
        .prepare("SELECT id FROM messages WHERE channel_id = ? AND received_at < ?")
        .all(ch, cutoffIso) as Array<{ id: string }>;
      const del = this.sql.prepare("DELETE FROM messages WHERE channel_id = ? AND received_at < ?").run(ch, cutoffIso);

      // Steps and deliveries have no foreign key, so they are cleared here.
      for (const { id } of ids) {
        this.sql.prepare("DELETE FROM message_steps WHERE message_id = ?").run(id);
        this.sql.prepare("DELETE FROM deliveries WHERE message_id = ?").run(id);
      }

      this.setChannelState(ch, "purged_tip", last.hash);
      this.setChannelState(ch, "purged_before", last.received_at);
      total += Number(del.changes);
      touched.push(ch);
    }
    return { messages: total, channels: touched };
  }

  /** Counts what a retention run would touch, without touching it. */
  retentionCounts(redactCutoff?: string, purgeCutoff?: string): { redactable: number; purgeable: number; oldest?: string } {
    const oldest = this.sql.prepare("SELECT MIN(received_at) AS m FROM messages").get() as { m: string | null };
    const redactable = redactCutoff
      ? (this.sql
          .prepare("SELECT COUNT(*) AS n FROM messages WHERE received_at < ? AND redacted_at IS NULL AND raw_digest IS NOT NULL")
          .get(redactCutoff) as { n: number }).n
      : 0;
    const purgeable = purgeCutoff
      ? (this.sql.prepare("SELECT COUNT(*) AS n FROM messages WHERE received_at < ?").get(purgeCutoff) as { n: number }).n
      : 0;
    return { redactable, purgeable, ...(oldest.m ? { oldest: oldest.m } : {}) };
  }

  /* ---------------------------- channel state --------------------------- */

  getChannelState(channelId: string, key: string): string | undefined {
    const row = this.sql
      .prepare("SELECT value FROM channel_state WHERE channel_id = ? AND key = ?")
      .get(channelId, key) as { value: string | null } | undefined;
    return row?.value ?? undefined;
  }

  setChannelState(channelId: string, key: string, value: string): void {
    this.sql
      .prepare(
        `INSERT INTO channel_state (channel_id, key, value) VALUES (?, ?, ?)
         ON CONFLICT(channel_id, key) DO UPDATE SET value = excluded.value`
      )
      .run(channelId, key, value);
  }

  /* ---------------------------- subscriptions ---------------------------- */

  listSubscriptions(): SubscriptionRow[] {
    return this.sql.prepare("SELECT * FROM fhir_subscriptions ORDER BY created_at").all() as unknown as SubscriptionRow[];
  }

  getSubscription(id: string): SubscriptionRow | undefined {
    return this.sql.prepare("SELECT * FROM fhir_subscriptions WHERE id = ?").get(id) as SubscriptionRow | undefined;
  }

  insertSubscription(row: { id: string; status: string; criteria: string; endpoint: string; payload: string }): void {
    this.sql
      .prepare("INSERT INTO fhir_subscriptions (id, status, criteria, endpoint, payload) VALUES (?, ?, ?, ?, ?)")
      .run(row.id, row.status, row.criteria, row.endpoint, row.payload);
  }

  deleteSubscription(id: string): boolean {
    return this.sql.prepare("DELETE FROM fhir_subscriptions WHERE id = ?").run(id).changes > 0;
  }

  /* ------------------------------ deliveries ---------------------------- */

  enqueueDelivery(row: {
    messageId: string;
    channelId: string;
    destinationId: string;
    seq: number;
    ordered: boolean;
    skipOnDead: boolean;
    maxAttempts: number;
    payload: string;
    contentType: string;
  }): string {
    const id = randomUUID();
    this.sql
      .prepare(
        `INSERT INTO deliveries (id, message_id, channel_id, destination_id, seq, ordering_key, ordered,
           skip_on_dead, max_attempts, next_attempt_at, payload, content_type)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        row.messageId,
        row.channelId,
        row.destinationId,
        row.seq,
        `${row.channelId}:${row.destinationId}`,
        row.ordered ? 1 : 0,
        row.skipOnDead ? 1 : 0,
        row.maxAttempts,
        Date.now(),
        row.payload,
        row.contentType
      );
    return id;
  }

  /**
   * Due deliveries. An ordered delivery is held back while any earlier message
   * on the same ordering key is still queued or in flight, and, unless
   * skip_on_dead is set, while an earlier one sits in the dead letter queue.
   */
  /**
   * Deliveries ready to attempt now.
   *
   * An ordered destination releases a message only when nothing earlier for
   * that destination is still queued, in flight, or dead-lettered. Expressed
   * as "this row is at or before the earliest blocking row", which is an
   * index seek on (ordering_key, state, rowid), rather than as a NOT EXISTS
   * over every predecessor — that form could not use an index, because it
   * filtered on rowid while the only index was on seq, so its cost grew with
   * the backlog exactly when draining mattered most.
   */
  dueDeliveries(now: number, limit: number): DeliveryRow[] {
    return this.sql
      .prepare(
        `SELECT * FROM deliveries d
         WHERE d.state = 'queued' AND d.next_attempt_at <= ?
           AND (
             d.ordered = 0
             OR d.rowid <= COALESCE(
                  (SELECT MIN(p.rowid) FROM deliveries p
                    WHERE p.ordering_key = d.ordering_key
                      AND p.state IN ('queued', 'inflight')),
                  d.rowid)
             AND d.rowid <= COALESCE(
                  (SELECT MIN(p.rowid) FROM deliveries p
                    WHERE p.ordering_key = d.ordering_key
                      AND p.state = 'dead' AND d.skip_on_dead = 0),
                  d.rowid)
           )
         ORDER BY d.rowid
         LIMIT ?`
      )
      .all(now, limit) as unknown as DeliveryRow[];
  }

  /**
   * The next deliverable message for one ordering key.
   *
   * Lets the worker drain a key in a tight sequential loop instead of one
   * message per timer tick. Strict ordering is preserved because the caller
   * only asks for the next one after the previous has succeeded.
   */
  nextDueForKey(orderingKey: string, now: number): DeliveryRow | undefined {
    return this.sql
      .prepare(
        `SELECT * FROM deliveries d
         WHERE d.ordering_key = ? AND d.state = 'queued' AND d.next_attempt_at <= ?
           AND d.rowid <= COALESCE(
                (SELECT MIN(p.rowid) FROM deliveries p
                  WHERE p.ordering_key = d.ordering_key
                    AND p.state = 'dead' AND d.skip_on_dead = 0),
                d.rowid)
         ORDER BY d.rowid
         LIMIT 1`
      )
      .get(orderingKey, now) as unknown as DeliveryRow | undefined;
  }

  markInflight(id: string): void {
    this.sql.prepare("UPDATE deliveries SET state = 'inflight', attempts = attempts + 1 WHERE id = ?").run(id);
  }

  markDelivered(id: string, ack: string | null): void {
    this.sql
      .prepare("UPDATE deliveries SET state = 'delivered', ack = ?, delivered_at = datetime('now') WHERE id = ?")
      .run(ack, id);
  }

  markFailed(id: string, error: string, nextAttemptAt: number, dead: boolean): void {
    this.sql
      .prepare("UPDATE deliveries SET state = ?, last_error = ?, next_attempt_at = ? WHERE id = ?")
      .run(dead ? "dead" : "queued", error, nextAttemptAt, id);
  }

  getDelivery(id: string): DeliveryRow | undefined {
    return this.sql.prepare("SELECT * FROM deliveries WHERE id = ?").get(id) as DeliveryRow | undefined;
  }

  deliveriesForMessage(messageId: string): DeliveryRow[] {
    return this.sql.prepare("SELECT * FROM deliveries WHERE message_id = ? ORDER BY seq").all(messageId) as unknown as DeliveryRow[];
  }

  listDeliveries(filter: { channelId?: string; state?: string; limit?: number }): DeliveryRow[] {
    const clauses: string[] = [];
    const args: unknown[] = [];
    if (filter.channelId) {
      clauses.push("channel_id = ?");
      args.push(filter.channelId);
    }
    if (filter.state) {
      clauses.push("state = ?");
      args.push(filter.state);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = Math.min(filter.limit ?? 100, 1000);
    return this.sql
      .prepare(`SELECT * FROM deliveries ${where} ORDER BY seq DESC LIMIT ${limit}`)
      .all(...(args as never[])) as unknown as DeliveryRow[];
  }

  /**
   * Requeues a settled delivery so an operator can send it again.
   *
   * Refuses one whose payload retention has already emptied. The states replay
   * accepts are exactly the states redaction empties, so without the check the
   * tombstone goes out as though it were the message — a downstream clinical
   * system receives `[redacted]` and has no way to tell it from real content.
   * Failing loudly is the only safe answer: the payload is genuinely gone, and
   * an operator asking for it is entitled to be told so rather than to have
   * something plausible sent on their behalf.
   */
  replayDelivery(id: string): { ok: true } | { ok: false; reason: string } {
    const row = this.sql.prepare("SELECT state, redacted_at FROM deliveries WHERE id = ?").get(id) as
      | { state: string; redacted_at: string | null }
      | undefined;
    if (!row) return { ok: false, reason: "no such delivery" };
    if (row.redacted_at) {
      return {
        ok: false,
        reason: `payload was redacted at ${row.redacted_at} under the retention policy and cannot be replayed`,
      };
    }

    const r = this.sql
      .prepare(
        `UPDATE deliveries SET state = 'queued', attempts = 0, last_error = NULL, next_attempt_at = ?
         WHERE id = ? AND state IN ('dead', 'delivered', 'discarded')`
      )
      .run(Date.now(), id);
    return r.changes > 0 ? { ok: true } : { ok: false, reason: `cannot replay a delivery in state '${row.state}'` };
  }

  discardDelivery(id: string): boolean {
    const r = this.sql
      .prepare("UPDATE deliveries SET state = 'discarded' WHERE id = ? AND state = 'dead'")
      .run(id);
    return r.changes > 0;
  }

  /* --------------------------- instance lock ---------------------------- */

  /**
   * Claims exclusive ownership of this database for the calling process.
   *
   * Two engines on one file is silent corruption rather than an error: both
   * claim due deliveries, and each one's startup reclaim requeues the other's
   * genuinely in-flight messages, so a message goes out twice. SQLite happily
   * permits it, so the check has to be here.
   *
   * A lock has to survive the case it exists to protect — a crash — without
   * deadlocking the restart that follows. Two escapes, in order:
   *
   *   If the holder is on this host and its process is gone, take over at
   *   once. That is the common case, and it costs no delay.
   *
   *   Otherwise wait for the heartbeat to go stale. That covers a holder on
   *   another host, or a reused pid, at the cost of a bounded wait.
   */
  acquireInstanceLock(staleMs = 20_000): { acquired: boolean; heldBy?: { pid: number; host: string; ageMs: number } } {
    const host = hostname();
    const now = Date.now();
    const held = this.sql.prepare("SELECT pid, host, heartbeat_at FROM instance_lock WHERE id = 1").get() as
      | { pid: number; host: string; heartbeat_at: number }
      | undefined;

    if (held) {
      const ageMs = now - held.heartbeat_at;
      const sameHost = held.host === host;
      const holderGone = sameHost && !processAlive(held.pid);
      if (!holderGone && ageMs < staleMs) {
        return { acquired: false, heldBy: { pid: held.pid, host: held.host, ageMs } };
      }
    }

    this.sql
      .prepare(
        `INSERT INTO instance_lock (id, pid, host, acquired_at, heartbeat_at) VALUES (1, ?, ?, datetime('now'), ?)
         ON CONFLICT(id) DO UPDATE SET pid = excluded.pid, host = excluded.host,
           acquired_at = excluded.acquired_at, heartbeat_at = excluded.heartbeat_at`
      )
      .run(process.pid, host, now);
    return { acquired: true };
  }

  /**
   * Keeps this process's claim fresh.
   *
   * Matched on host as well as pid: pid spaces are per-machine, so on a shared
   * volume this process could otherwise refresh — and so indefinitely prolong
   * — a same-numbered claim belonging to an engine on another host.
   */
  heartbeatInstanceLock(): void {
    this.sql
      .prepare("UPDATE instance_lock SET heartbeat_at = ? WHERE id = 1 AND pid = ? AND host = ?")
      .run(Date.now(), process.pid, hostname());
  }

  /**
   * Releases the claim on a clean shutdown, so a restart need not wait.
   * Scoped the same way, so shutting down never frees someone else's claim.
   */
  releaseInstanceLock(): void {
    this.sql.prepare("DELETE FROM instance_lock WHERE id = 1 AND pid = ? AND host = ?").run(process.pid, hostname());
  }

  /**
   * Returns deliveries left in flight by a crash to the queue.
   *
   * A delivery is marked inflight, sent, and then marked delivered or failed.
   * A process that dies in the middle of that leaves the row inflight forever:
   * nothing retries it, because only queued rows are ever claimed, and an
   * ordered destination treats an inflight predecessor as blocking — so one
   * orphaned row silently stops a clinical feed until someone notices.
   *
   * Safe only at startup, where a single-writer engine cannot have any
   * genuinely in-flight delivery. Delivery is at-least-once, so a row
   * reclaimed after the remote actually received it will be sent again; that
   * is why the FHIR facade is content-addressed and an unchanged upsert is a
   * no-op.
   *
   * The interrupted attempt stays counted. Not counting it would be kinder to
   * a delivery that never left, but a message that reliably crashes the
   * process would then retry forever instead of dead-lettering.
   */
  reclaimInflight(): number {
    const r = this.sql
      .prepare(
        `UPDATE deliveries
            SET state = 'queued',
                next_attempt_at = ?,
                last_error = 'interrupted by restart; requeued'
          WHERE state = 'inflight'`
      )
      .run(Date.now());
    return Number(r.changes);
  }

  /* -------------------------------- health ------------------------------ */

  /**
   * The signals a monitoring system can alert on.
   *
   * Counters answer "how much"; these answer "is anything wrong". Nobody
   * watches a dashboard at 03:00 at a community site, so the question that
   * matters is whether a channel has quietly stopped draining — which a total
   * delivered count cannot show, because it looks identical whether the queue
   * moved a minute ago or a week ago.
   */
  healthSignals(): {
    deadLetters: number;
    queued: number;
    oldestQueuedAgeSec: number | null;
    inflight: number;
    stalledChannels: Array<{ channelId: string; oldestQueuedAgeSec: number; queued: number }>;
    lastDeliveryAt: string | null;
    silentChannels: Array<{ channelId: string; lastMessageAgeSec: number | null; expectEverySec: number }>;
  } {
    const counts = this.sql
      .prepare("SELECT state, COUNT(*) AS n FROM deliveries GROUP BY state")
      .all() as Array<{ state: string; n: number }>;
    const by = Object.fromEntries(counts.map((r) => [r.state, r.n])) as Record<string, number>;

    // next_attempt_at is epoch milliseconds and is set when a delivery is
    // first queued, so the earliest one is the head of the oldest backlog.
    const oldest = this.sql
      .prepare("SELECT MIN(next_attempt_at) AS t FROM deliveries WHERE state IN ('queued', 'inflight')")
      .get() as { t: number | null };

    const perChannel = this.sql
      .prepare(
        `SELECT channel_id, MIN(next_attempt_at) AS t, COUNT(*) AS n
           FROM deliveries WHERE state IN ('queued', 'inflight')
          GROUP BY channel_id`
      )
      .all() as Array<{ channel_id: string; t: number; n: number }>;

    const lastDelivery = this.sql
      .prepare("SELECT MAX(delivered_at) AS t FROM deliveries WHERE delivered_at IS NOT NULL")
      .get() as { t: string | null };

    const ageSec = (epochMs: number | null): number | null =>
      epochMs === null ? null : Math.max(0, Math.floor((Date.now() - epochMs) / 1000));

    return {
      deadLetters: by.dead ?? 0,
      queued: by.queued ?? 0,
      inflight: by.inflight ?? 0,
      oldestQueuedAgeSec: ageSec(oldest.t),
      stalledChannels: perChannel.map((r) => ({
        channelId: r.channel_id,
        oldestQueuedAgeSec: ageSec(r.t) ?? 0,
        queued: r.n,
      })),
      lastDeliveryAt: lastDelivery.t,
      silentChannels: this.silentChannels(),
    };
  }

  /**
   * Channels that have not received a message for longer than they should.
   *
   * Every other signal here is about things in the queue — depth, dead
   * letters, the age of the oldest undelivered message. A feed that stops
   * sending puts nothing in the queue, so all of them read healthy: a dead ADT
   * interface and a quiet night are indistinguishable. At an unattended site
   * that is the failure most likely to run for days, because the whole premise
   * is that nobody is watching.
   *
   * A cadence has to be declared per channel rather than inferred. A nursing
   * station that admits four patients a day and a regional lab pushing results
   * every few minutes are both healthy, and no threshold fits both. Channels
   * that declare nothing are not reported, so this stays silent until an
   * operator says what silence would mean.
   */
  silentChannels(): Array<{ channelId: string; lastMessageAgeSec: number | null; expectEverySec: number }> {
    const out: Array<{ channelId: string; lastMessageAgeSec: number | null; expectEverySec: number }> = [];
    for (const row of this.listChannels()) {
      if (!row.enabled) continue;
      let expectEverySec: number | undefined;
      try {
        expectEverySec = (JSON.parse(row.config) as { expectMessageEverySec?: number }).expectMessageEverySec;
      } catch {
        // A channel whose config will not parse has larger problems, and this
        // is a health check: it must not be the thing that throws.
        continue;
      }
      if (typeof expectEverySec !== "number" || expectEverySec <= 0) continue;

      const last = this.sql
        .prepare(
          "SELECT (julianday('now') - julianday(MAX(received_at))) * 86400.0 AS age FROM messages WHERE channel_id = ?"
        )
        .get(row.id) as { age: number | null };
      // A channel that has never received anything is reported with a null
      // age rather than skipped: never having started is as much an outage as
      // having stopped, and it is the one an operator hits on the day they
      // stand the feed up.
      const ageSec = last.age === null ? null : Math.max(0, Math.round(last.age));
      if (ageSec === null || ageSec > expectEverySec) out.push({ channelId: row.id, lastMessageAgeSec: ageSec, expectEverySec });
    }
    return out;
  }

  /** Seconds since a channel last received a message, or null if never. */
  lastMessageAgeSec(channelId: string): number | null {
    const r = this.sql
      .prepare(
        "SELECT (julianday('now') - julianday(MAX(received_at))) * 86400.0 AS age FROM messages WHERE channel_id = ?"
      )
      .get(channelId) as { age: number | null };
    return r.age === null ? null : Math.max(0, Math.round(r.age));
  }

  /* -------------------------------- history ----------------------------- */

  /**
   * Message arrivals and delivery completions grouped into time buckets.
   *
   * Two different clocks, deliberately: messages are bucketed by when they
   * arrived, deliveries by when they completed. A message received during an
   * outage and delivered hours later belongs in both places, and collapsing
   * them onto one axis would hide exactly the behaviour worth watching.
   */
  history(hours: number, bucket: "hour" | "day"): {
    messages: Array<{ bucket: string; status: string; n: number }>;
    deliveries: Array<{ bucket: string; n: number }>;
  } {
    const fmt = bucket === "day" ? "%Y-%m-%d" : "%Y-%m-%dT%H:00";
    const since = `-${Math.max(1, Math.floor(hours))} hours`;

    const messages = this.sql
      .prepare(
        `SELECT strftime(?, received_at) AS bucket, status, COUNT(*) AS n
           FROM messages
          WHERE received_at >= datetime('now', ?)
          GROUP BY bucket, status
          ORDER BY bucket`
      )
      .all(fmt, since) as unknown as Array<{ bucket: string; status: string; n: number }>;

    const deliveries = this.sql
      .prepare(
        `SELECT strftime(?, delivered_at) AS bucket, COUNT(*) AS n
           FROM deliveries
          WHERE delivered_at IS NOT NULL AND delivered_at >= datetime('now', ?)
          GROUP BY bucket
          ORDER BY bucket`
      )
      .all(fmt, since) as unknown as Array<{ bucket: string; n: number }>;

    return { messages, deliveries };
  }

  /* ------------------------------- api keys ----------------------------- */

  insertApiKey(id: string, name: string, hash: string, scopes: string[]): void {
    this.sql
      .prepare("INSERT INTO api_keys (id, name, hash, scopes) VALUES (?, ?, ?, ?)")
      .run(id, name, hash, scopes.join(" "));
  }

  /** Looks a key up by hash. Revoked keys never resolve. */
  findApiKeyByHash(hash: string): ApiKeyRow | undefined {
    return this.sql
      .prepare("SELECT * FROM api_keys WHERE hash = ? AND revoked_at IS NULL")
      .get(hash) as ApiKeyRow | undefined;
  }

  touchApiKey(id: string): void {
    this.sql.prepare("UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?").run(id);
  }

  listApiKeys(): ApiKeyRow[] {
    return this.sql
      .prepare("SELECT * FROM api_keys ORDER BY created_at DESC")
      .all() as unknown as ApiKeyRow[];
  }

  revokeApiKey(id: string): boolean {
    const r = this.sql
      .prepare("UPDATE api_keys SET revoked_at = datetime('now') WHERE id = ? AND revoked_at IS NULL")
      .run(id);
    return r.changes > 0;
  }

  countActiveApiKeys(): number {
    return (this.sql.prepare("SELECT COUNT(*) AS n FROM api_keys WHERE revoked_at IS NULL").get() as { n: number }).n;
  }

  stats(): Record<string, unknown> {
    const msg = this.sql
      .prepare("SELECT status, COUNT(*) AS n FROM messages GROUP BY status")
      .all() as Array<{ status: string; n: number }>;
    const del = this.sql
      .prepare("SELECT state, COUNT(*) AS n FROM deliveries GROUP BY state")
      .all() as Array<{ state: string; n: number }>;
    const chan = (this.sql.prepare("SELECT COUNT(*) AS n FROM channels").get() as { n: number }).n;
    const fhir = this.sql
      .prepare("SELECT resource_type, COUNT(*) AS n FROM fhir_resources GROUP BY resource_type ORDER BY resource_type")
      .all() as Array<{ resource_type: string; n: number }>;
    return {
      channels: chan,
      messages: Object.fromEntries(msg.map((r) => [r.status, r.n])),
      deliveries: Object.fromEntries(del.map((r) => [r.state, r.n])),
      fhir: Object.fromEntries(fhir.map((r) => [r.resource_type, r.n])),
    };
  }
}
