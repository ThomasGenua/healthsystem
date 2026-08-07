/** SQLite persistence via node:sqlite. Single writer, WAL mode. */
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ApiKeyRow, DeliveryRow, MessageRow, MessageStatus, SubscriptionRow } from "./types.ts";

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
  delivered_at TEXT
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
`;

export interface DbOptions {
  /**
   * Open without writing. Used to inspect a backup snapshot: the schema is
   * already there, and applying it would fail against a read-only file.
   */
  readOnly?: boolean;
}

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
    this.sql.exec(SCHEMA);
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

  /** Walk a channel's chain and confirm every link. */
  /**
   * Walks a channel's hash chain.
   *
   * Three wrinkles, all of them honest rather than incidental:
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
   *   verifies, and `verifiedFrom` says where the chain now begins.
   */
  verifyChain(channelId: string): {
    ok: boolean;
    checked: number;
    payloadsChecked: number;
    redacted: number;
    verifiedFrom?: string;
    brokenAt?: string;
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
    return { ok: true, checked, payloadsChecked, redacted, ...(purgedBefore ? { verifiedFrom: purgedBefore } : {}) };
  }

  /* ------------------------------ retention ----------------------------- */

  /**
   * Replaces stored payloads older than the cutoff with a tombstone.
   *
   * This is the primary retention control: the message, its lineage, its
   * steps and its deliveries all remain, and the chain still verifies, but the
   * patient data is gone. Deliveries are covered too — a queued payload is the
   * same clinical content as the message it came from.
   */
  redactBefore(cutoffIso: string, channelId?: string): { messages: number; deliveries: number } {
    const where = channelId ? " AND channel_id = ?" : "";
    const args = channelId ? [cutoffIso, channelId] : [cutoffIso];

    const messages = this.sql
      .prepare(
        `UPDATE messages SET raw = '[redacted]', redacted_at = datetime('now')
          WHERE received_at < ? AND redacted_at IS NULL AND raw_digest IS NOT NULL${where}`
      )
      .run(...(args as never[])).changes;

    // Only settled deliveries: one still queued or retrying needs its payload
    // to be deliverable.
    const deliveries = this.sql
      .prepare(
        `UPDATE deliveries SET payload = '[redacted]'
          WHERE state IN ('delivered', 'discarded')
            AND payload != '[redacted]'
            AND message_id IN (SELECT id FROM messages WHERE received_at < ?${where})`
      )
      .run(...(args as never[])).changes;

    return { messages: Number(messages), deliveries: Number(deliveries) };
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

  replayDelivery(id: string): boolean {
    const r = this.sql
      .prepare(
        `UPDATE deliveries SET state = 'queued', attempts = 0, last_error = NULL, next_attempt_at = ?
         WHERE id = ? AND state IN ('dead', 'delivered', 'discarded')`
      )
      .run(Date.now(), id);
    return r.changes > 0;
  }

  discardDelivery(id: string): boolean {
    const r = this.sql
      .prepare("UPDATE deliveries SET state = 'discarded' WHERE id = ? AND state = 'dead'")
      .run(id);
    return r.changes > 0;
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
    };
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
