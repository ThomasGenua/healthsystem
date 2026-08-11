/**
 * The engine owns channels. A channel is configuration: a source, a pipeline
 * of filters, splits, transforms and validators, and one or more
 * destinations. Ingest stores the raw message on the channel's hash chain,
 * runs the pipeline with every step recorded, and enqueues one durable
 * delivery per payload per destination. A pipeline carries a set of
 * payloads: filters narrow it, splits widen it, transforms map it one to
 * one, validators gate or annotate it.
 */
import { readdirSync, readFileSync, renameSync, unlinkSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Db } from "../db.ts";
import { DeliveryWorker } from "./queue.ts";
import { FhirStore } from "../fhir/store.ts";
import { SubscriptionManager } from "../fhir/subscriptions.ts";
import { TerminologyStore } from "../terminology/store.ts";
import { ConformanceRegistry, validateResource } from "../conformance/validator.ts";
import { ApiKeyStore } from "../auth/keys.ts";
import { AuditStore } from "../audit/store.ts";
import { ClinicalRecord } from "../clinical/record.ts";
import { ClinicalNotes } from "../clinical/notes.ts";
import { MedicationStore } from "../meds/store.ts";
import type { InteractionSource } from "../meds/safety.ts";
import { OrderStore } from "../orders/store.ts";
import { ReferralStore } from "../work/referrals.ts";
import { TaskStore } from "../work/tasks.ts";
import { Workspace } from "../workspace/summary.ts";
import { Schedule } from "../schedule/store.ts";
import { Registry } from "../population/registry.ts";
import { RetentionRunner, type RetentionPolicy } from "./retention.ts";
import { buildAck, getHl7, parseHl7, serializeHl7 } from "../hl7/parser.ts";
import { startMllpServer, type MllpServerHandle } from "../hl7/mllp.ts";
import { applyMapping, type MapperContext } from "../transform/mapper.ts";
import { connectSql, type SqlClient, type SqlDriver } from "../connectors/sql.ts";
import { connectSftp, type SftpClient, type SftpConnectOptions } from "../connectors/sftp.ts";
import { CronSchedule, minuteKey } from "../connectors/cron.ts";
import type { ChannelConfig, ConformanceIssue, MappingDoc, MessageRow, PipelineStep } from "../types.ts";

interface RuntimeChannel {
  config: ChannelConfig;
  mllp?: MllpServerHandle;
  timers: NodeJS.Timeout[];
  pollDb?: DatabaseSync;
  sqlClient?: SqlClient;
  sftpClient?: SftpClient;
  polling: boolean;
  destinationIds: string[];
}

/**
 * How often a cron-scheduled source checks whether its minute has arrived.
 * Cron is minute-granular, so anything under a minute suffices; 20s keeps the
 * worst-case lateness small without waking often.
 */
const CRON_TICK_MS = 20_000;

/**
 * Connector constructors, injectable so tests can drive the poll loops with
 * fakes instead of standing up a real Postgres or SSH server.
 */
export interface ConnectorFactories {
  sql?: (driver: SqlDriver, dsn: string) => Promise<SqlClient>;
  sftp?: (opts: SftpConnectOptions) => Promise<SftpClient>;
}

/** One custodian's view of the engine's stores. See Engine.forTenant. */
export interface TenantView {
  tenantId: string;
  db: Db;
  fhir: FhirStore;
  subs: SubscriptionManager;
  keys: ApiKeyStore;
  audit: AuditStore;
  clinical: ClinicalRecord;
  notes: ClinicalNotes;
  meds: MedicationStore;
  orders: OrderStore;
  referrals: ReferralStore;
  tasks: TaskStore;
  schedule: Schedule;
  registry: Registry;
  /** The assembled chart, over exactly the stores above. */
  workspace: Workspace;
}

export interface EngineOptions {
  dbPath: string;
  tickMs?: number;
  /**
   * Conformance pack enforced on every facade write that does not name its
   * own. A destination's validatePack overrides it.
   */
  validatePack?: string;
  validateMode?: "reject" | "annotate";
  /** Override connector constructors. Tests inject fakes here. */
  connectors?: ConnectorFactories;
  /**
   * A licensed drug interaction database. Absent by default, and absence is
   * reported as "interactions unchecked" rather than as a clean check.
   */
  interactions?: InteractionSource;
  /** How long stored patient data is kept. Off unless configured. */
  retention?: RetentionPolicy;
  /**
   * How long another instance's claim on the database stays valid without a
   * heartbeat. A crashed holder on this host is detected at once by its pid,
   * so this only bounds the cross-host and reused-pid cases.
   */
  lockStaleMs?: number;
}

export class Engine {
  readonly db: Db;
  readonly fhir: FhirStore;
  readonly worker: DeliveryWorker;
  readonly terminology: TerminologyStore;
  readonly conformance: ConformanceRegistry;
  readonly subs: SubscriptionManager;
  readonly keys: ApiKeyStore;
  readonly audit: AuditStore;
  readonly retention: RetentionRunner;
  readonly mappings = new Map<string, MappingDoc>();
  private channels = new Map<string, RuntimeChannel>();
  private mapperCtx: MapperContext;
  private connectors: Required<ConnectorFactories>;
  private validation: ConstructorParameters<typeof FhirStore>[1];
  private views = new Map<string, TenantView>();
  private lockTimer: NodeJS.Timeout | null = null;
  private interactions: InteractionSource | null;
  private lockStaleMs: number;
  private lockHeartbeatMs: number;
  private holdsLock = false;

  constructor(opts: EngineOptions) {
    this.db = new Db(opts.dbPath);
    // The terminology store and conformance registry are built first: the FHIR
    // facade validates writes against them, so it cannot be constructed before
    // they exist.
    this.terminology = new TerminologyStore(this.db);
    this.conformance = new ConformanceRegistry();
    this.validation = {
      conformance: this.conformance,
      terminology: this.terminology,
      defaultPack: opts.validatePack,
      defaultMode: opts.validateMode,
    };
    this.fhir = new FhirStore(this.db, this.validation);
    // Resolved per delivery, since one worker drains every tenant on the node.
    this.worker = new DeliveryWorker(this.db, opts.tickMs ?? 250, 25, (tenantId) => this.forTenant(tenantId));
    this.subs = new SubscriptionManager(this.db, this.worker);
    this.keys = new ApiKeyStore(this.db);
    this.audit = new AuditStore(this.db);
    this.retention = new RetentionRunner(this.db, opts.retention ?? {}, this.audit);
    this.connectors = {
      sql: opts.connectors?.sql ?? connectSql,
      sftp: opts.connectors?.sftp ?? connectSftp,
    };
    this.interactions = opts.interactions ?? null;
    this.lockStaleMs = opts.lockStaleMs ?? 20_000;
    // Comfortably inside the staleness window, so a slow moment never costs a
    // running engine its own claim.
    this.lockHeartbeatMs = Math.max(1_000, Math.floor(this.lockStaleMs / 4));
    this.fhir.onChange((result, resource) => this.subs.notify(result, resource));
    this.mapperCtx = {
      translate: (value, args) => {
        const matches = this.terminology.translate({
          code: String(value ?? ""),
          system: typeof args.system === "string" ? args.system : undefined,
          map: typeof args.map === "string" ? args.map : undefined,
          targetSystem: typeof args.targetSystem === "string" ? args.targetSystem : undefined,
        });
        const m = matches[0];
        if (!m) return "";
        return args.result === "display" ? (m.display ?? "") : m.code;
      },
    };
  }

  /**
   * The engine as one custodian sees it.
   *
   * Every store is rebuilt against a tenant-bound database handle and wired
   * exactly as the default one is — a per-tenant FHIR facade whose changes
   * notify that tenant's subscriptions, and no one else's. Built once and
   * cached, because the subscription wiring is stateful and reconstructing it
   * per request would drop listeners.
   *
   * The delivery worker and the database connection are shared, which is what
   * makes this one node serving many organizations rather than many nodes:
   * isolation is in the data each view can address, not in duplicated
   * machinery.
   */
  forTenant(tenantId: string): TenantView {
    const existing = this.views.get(tenantId);
    if (existing) return existing;

    const db = this.db.forTenant(tenantId);
    const fhir = new FhirStore(db, this.validation);
    const clinical = new ClinicalRecord(db);
    const notes = new ClinicalNotes(clinical);
    // No interaction database unless a deployment supplies one. The safety
    // check reports interactions as unchecked rather than clear, which is the
    // honest answer and the one src/meds/safety.ts is built to give.
    const meds = new MedicationStore(db, this.interactions);
    const orders = new OrderStore(db);
    const referrals = new ReferralStore(db);
    const tasks = new TaskStore(db);
    const subs = new SubscriptionManager(db, this.worker);
    fhir.onChange((result, resource) => subs.notify(result, resource));
    const view: TenantView = {
      tenantId,
      db,
      fhir,
      subs,
      keys: new ApiKeyStore(db),
      audit: new AuditStore(db),
      clinical,
      notes,
      meds,
      orders,
      referrals,
      tasks,
      schedule: new Schedule(db),
      registry: new Registry(db),
      workspace: new Workspace({ record: clinical, notes, meds, orders, referrals, tasks }),
    };
    this.views.set(tenantId, view);
    return view;
  }

  registerMapping(doc: MappingDoc): void {
    this.mappings.set(doc.id, doc);
  }

  /**
   * The mapper context pipelines run with, so a preview resolves `translate`
   * against the same terminology store the real pipeline would use.
   */
  mapperContext(): MapperContext {
    return this.mapperCtx;
  }

  async start(): Promise<void> {
    // Ownership first. The reclaim below assumes no other engine is running,
    // and without that check a second instance would requeue this one's
    // genuinely in-flight deliveries and send them twice.
    const lock = this.db.acquireInstanceLock(this.lockStaleMs);
    if (!lock.acquired) {
      const held = lock.heldBy!;
      throw new Error(
        `another Portage instance owns this database (pid ${held.pid} on ${held.host}, ` +
          `last seen ${Math.round(held.ageMs / 1000)}s ago). Two engines on one database duplicate messages. ` +
          `If that process is gone, wait for its claim to expire and start again.`
      );
    }
    this.holdsLock = true;
    this.lockTimer = setInterval(() => this.db.heartbeatInstanceLock(), this.lockHeartbeatMs);
    this.lockTimer.unref?.();

    // A previous process may have died mid-delivery, leaving rows marked in
    // flight that nothing will ever claim and that block every ordered
    // message behind them.
    const reclaimed = this.db.reclaimInflight();
    if (reclaimed > 0) {
      console.warn(`recovered ${reclaimed} delivery(ies) interrupted by an unclean shutdown; requeued`);
    }
    this.worker.start();
    this.retention.start();
    this.subs.load();
    for (const row of this.db.listChannels()) {
      if (!row.enabled) continue;
      const config = JSON.parse(row.config) as ChannelConfig;
      await this.activate(config);
    }
  }

  async stop(): Promise<void> {
    if (this.lockTimer) clearInterval(this.lockTimer);
    this.lockTimer = null;
    await this.worker.stop();
    this.retention.stop();
    for (const rc of this.channels.values()) {
      if (rc.mllp) await rc.mllp.close();
      for (const t of rc.timers) clearInterval(t);
      rc.pollDb?.close();
      await this.dropSqlClient(rc);
      await this.dropSftpClient(rc);
    }
    this.channels.clear();
    // Release before closing, so a restart does not have to wait out a claim
    // this process no longer holds. Only if this engine actually holds it:
    // an engine whose start() was refused still has to be stoppable to close
    // its handle, and stopping it must not free the claim it lost to.
    if (this.holdsLock) {
      this.holdsLock = false;
      try {
        this.db.releaseInstanceLock();
      } catch {
        // A database already gone is nothing to complain about on the way out.
      }
    }
    this.db.close();
  }

  /** Persist and activate a channel. Replaces a running channel of the same id. */
  async addChannel(config: ChannelConfig): Promise<void> {
    validateChannel(config);
    this.db.upsertChannel(config.id, config.name, config.enabled !== false, JSON.stringify(config));
    if (this.channels.has(config.id)) await this.deactivate(config.id);
    if (config.enabled !== false) await this.activate(config);
  }

  async removeChannel(id: string): Promise<void> {
    await this.deactivate(id);
    this.db.deleteChannel(id);
  }

  listChannels(): Array<{ id: string; name: string; enabled: boolean; running: boolean; source: string; mllpPort?: number }> {
    return this.db.listChannels().map((row) => {
      const cfg = JSON.parse(row.config) as ChannelConfig;
      const rc = this.channels.get(row.id);
      return {
        id: row.id,
        name: row.name,
        enabled: row.enabled === 1,
        running: !!rc,
        source: cfg.source.type,
        ...(rc?.mllp ? { mllpPort: rc.mllp.port } : {}),
      };
    });
  }

  getChannelConfig(id: string): ChannelConfig | undefined {
    const row = this.db.getChannel(id);
    return row ? (JSON.parse(row.config) as ChannelConfig) : undefined;
  }

  /** The bound MLLP port for a running channel. Useful when configured as 0. */
  mllpPort(channelId: string): number | undefined {
    return this.channels.get(channelId)?.mllp?.port;
  }

  fhirChannels(resourceType: string): ChannelConfig[] {
    const out: ChannelConfig[] = [];
    for (const rc of this.channels.values()) {
      const src = rc.config.source;
      if (src.type !== "fhir") continue;
      if (!src.resourceTypes || src.resourceTypes.length === 0 || src.resourceTypes.includes(resourceType)) {
        out.push(rc.config);
      }
    }
    return out;
  }

  httpChannel(path: string): ChannelConfig | undefined {
    for (const rc of this.channels.values()) {
      const src = rc.config.source;
      if (src.type === "http" && (src.path ?? rc.config.id) === path) return rc.config;
    }
    return undefined;
  }

  private async activate(config: ChannelConfig): Promise<void> {
    const destinationIds = config.destinations.map((d, i) =>
      this.worker.registerDestination(this.db.tenantId, config.id, d, i)
    );
    const rc: RuntimeChannel = { config, destinationIds, timers: [], polling: false };

    if (config.source.type === "mllp") {
      const src = config.source;
      rc.mllp = await startMllpServer(src.port, src.host ?? "0.0.0.0", async (raw) => {
        try {
          const result = this.ingest(config.id, raw, "x-application/hl7-v2+er7", "mllp");
          const parsed = parseHl7(raw);
          if (result.status === "error") return buildAck(parsed, "AE", result.error ?? "processing error");
          return buildAck(parsed, "AA");
        } catch (err) {
          try {
            return buildAck(parseHl7(raw), "AE", err instanceof Error ? err.message : "parse error");
          } catch {
            throw err;
          }
        }
      }, { maxFrameBytes: src.maxFrameBytes, charset: src.charset });
    }

    if (config.source.type === "filedrop") {
      const src = config.source;
      const pattern = src.pattern ? new RegExp(src.pattern) : null;
      const poll = () => {
        if (rc.polling) return;
        rc.polling = true;
        try {
          let names: string[];
          try {
            names = readdirSync(src.dir).sort();
          } catch {
            return;
          }
          for (const name of names) {
            if (pattern && !pattern.test(name)) continue;
            const full = join(src.dir, name);
            try {
              if (!statSync(full).isFile()) continue;
              const content = readFileSync(full, "utf8");
              this.ingest(config.id, content, src.contentType ?? "text/plain", "filedrop", { file: name });
              if (src.archiveDir) {
                mkdirSync(src.archiveDir, { recursive: true });
                renameSync(full, join(src.archiveDir, name));
              } else {
                unlinkSync(full);
              }
            } catch (err) {
              console.error(`filedrop ${config.id}: ${name}: ${err instanceof Error ? err.message : err}`);
            }
          }
        } finally {
          rc.polling = false;
        }
      };
      this.schedule(rc, config.id, src, poll);
    }

    if (config.source.type === "dbpoll") {
      const src = config.source;
      rc.pollDb = new DatabaseSync(src.dbPath);
      const poll = () => {
        if (rc.polling || !rc.pollDb) return;
        rc.polling = true;
        try {
          const cursor = this.db.getChannelState(config.id, "cursor");
          const bound: string | number =
            cursor === undefined ? 0 : /^-?\d+(\.\d+)?$/.test(cursor) ? Number(cursor) : cursor;
          const rows = rc.pollDb.prepare(src.query).all(bound) as Array<Record<string, unknown>>;
          for (const row of rows) {
            this.ingest(config.id, JSON.stringify(row), "application/json", "dbpoll");
            this.db.setChannelState(config.id, "cursor", String(row[src.cursorColumn]));
          }
        } catch (err) {
          console.error(`dbpoll ${config.id}: ${err instanceof Error ? err.message : err}`);
        } finally {
          rc.polling = false;
        }
      };
      this.schedule(rc, config.id, src, poll);
    }

    if (config.source.type === "sqlpoll") {
      const src = config.source;
      const poll = async () => {
        if (rc.polling) return;
        rc.polling = true;
        try {
          // Connect lazily rather than at activation. A channel whose database
          // is unreachable at boot still starts and picks up when the link
          // returns, which is the normal condition here, not the exception.
          if (!rc.sqlClient) rc.sqlClient = await this.connectors.sql(src.driver, src.dsn);
          const stored = this.db.getChannelState(config.id, "cursor") ?? src.initialCursor ?? "0";
          const bound: string | number = /^-?\d+(\.\d+)?$/.test(stored) ? Number(stored) : stored;
          const rows = await rc.sqlClient.query(src.query, [bound]);
          for (const row of rows) {
            this.ingest(config.id, JSON.stringify(row), src.contentType ?? "application/json", "sqlpoll");
            this.db.setChannelState(config.id, "cursor", cursorValue(row[src.cursorColumn]));
          }
        } catch (err) {
          console.error(`sqlpoll ${config.id}: ${err instanceof Error ? err.message : err}`);
          await this.dropSqlClient(rc);
        } finally {
          rc.polling = false;
        }
      };
      this.schedule(rc, config.id, src, poll);
    }

    if (config.source.type === "sftp") {
      const src = config.source;
      const pattern = src.pattern ? new RegExp(src.pattern) : null;
      const poll = async () => {
        if (rc.polling) return;
        rc.polling = true;
        try {
          if (!rc.sftpClient) {
            rc.sftpClient = await this.connectors.sftp({
              host: src.host,
              port: src.port,
              username: src.username,
              password: src.password,
              privateKey: src.privateKeyPath ? readFileSync(src.privateKeyPath) : undefined,
              passphrase: src.passphrase,
            });
          }
          const files = (await rc.sftpClient.list(src.dir))
            .filter((f) => !pattern || pattern.test(f.name))
            .sort((a, b) => a.name.localeCompare(b.name));
          for (const f of files) {
            const remote = remoteJoin(src.dir, f.name);
            const content = await rc.sftpClient.get(remote);
            this.ingest(config.id, content, src.contentType ?? "text/plain", "sftp", { file: f.name });
            // Archive or delete only after the message is durably stored, so a
            // crash mid-poll re-reads the file rather than losing it.
            if (src.archiveDir) {
              await rc.sftpClient.mkdir(src.archiveDir);
              await rc.sftpClient.rename(remote, remoteJoin(src.archiveDir, f.name));
            } else {
              await rc.sftpClient.delete(remote);
            }
          }
        } catch (err) {
          console.error(`sftp ${config.id}: ${err instanceof Error ? err.message : err}`);
          await this.dropSftpClient(rc);
        } finally {
          rc.polling = false;
        }
      };
      this.schedule(rc, config.id, src, poll);
    }

    this.channels.set(config.id, rc);
  }

  /**
   * Registers a polling source's timer: either a plain interval or, when the
   * source carries a cron expression, a coarse tick that fires once per
   * matching minute. The fired minute is persisted, so a restart inside a
   * matching minute does not run the job twice.
   */
  private schedule(
    rc: RuntimeChannel,
    channelId: string,
    src: { pollMs?: number; cron?: string },
    poll: () => void | Promise<void>
  ): void {
    const run = (): void => {
      void Promise.resolve(poll()).catch((err: unknown) => {
        console.error(`poll ${channelId}: ${err instanceof Error ? err.message : err}`);
      });
    };

    if (src.cron) {
      const schedule = new CronSchedule(src.cron);
      const tick = (): void => {
        const now = new Date();
        if (!schedule.matches(now)) return;
        const key = minuteKey(now);
        if (this.db.getChannelState(channelId, "cron_fired") === key) return;
        this.db.setChannelState(channelId, "cron_fired", key);
        run();
      };
      const t = setInterval(tick, CRON_TICK_MS);
      t.unref?.();
      rc.timers.push(t);
      tick();
      return;
    }

    const t = setInterval(run, src.pollMs ?? 2000);
    t.unref?.();
    rc.timers.push(t);
    run();
  }

  private async dropSqlClient(rc: RuntimeChannel): Promise<void> {
    const client = rc.sqlClient;
    rc.sqlClient = undefined;
    try {
      await client?.close();
    } catch {
      // The connection is already being discarded; a failure to close it
      // cleanly must not mask the error that caused the drop.
    }
  }

  private async dropSftpClient(rc: RuntimeChannel): Promise<void> {
    const client = rc.sftpClient;
    rc.sftpClient = undefined;
    try {
      await client?.close();
    } catch {
      // As above.
    }
  }

  private async deactivate(id: string): Promise<void> {
    const rc = this.channels.get(id);
    if (!rc) return;
    if (rc.mllp) await rc.mllp.close();
    for (const t of rc.timers) clearInterval(t);
    rc.pollDb?.close();
    await this.dropSqlClient(rc);
    await this.dropSftpClient(rc);
    this.worker.unregisterChannel(this.db.tenantId, id);
    this.channels.delete(id);
  }

  /**
   * Ingest one message into a channel. Synchronous by design: the store,
   * pipeline and enqueue all commit before the source is acknowledged, so an
   * MLLP AA means every resulting payload is durably queued, not merely seen.
   *
   * The whole of that commits as one transaction, so the guarantee holds
   * literally. Writing the message, its steps and its deliveries separately
   * left a window where a crash produced a stored message with no deliveries
   * — durable, visible, and never sent.
   */
  ingest(
    channelId: string,
    raw: string,
    contentType: string,
    sourceType: string,
    meta?: unknown
  ): { message: MessageRow; status: "processed" | "filtered" | "error"; error?: string; payloads: number } {
    const config = this.getChannelConfig(channelId);
    if (!config) throw new Error(`Unknown channel: ${channelId}`);
    return this.db.transaction(() => this.ingestWithin(config, channelId, raw, contentType, sourceType, meta));
  }

  private ingestWithin(
    config: ChannelConfig,
    channelId: string,
    raw: string,
    contentType: string,
    sourceType: string,
    meta?: unknown
  ): { message: MessageRow; status: "processed" | "filtered" | "error"; error?: string; payloads: number } {
    const message = this.db.insertMessage(channelId, sourceType, contentType, raw, meta);

    let payloads: string[] = [raw];
    let payloadType = contentType;
    let stepIndex = 0;

    try {
      for (const step of config.pipeline ?? []) {
        const result = this.runStep(step, payloads, payloadType);
        payloads = result.payloads;
        payloadType = result.contentType;
        if (payloads.length === 0) {
          this.db.addStep(message.id, stepIndex, step.type, "filtered");
          this.db.setMessageStatus(message.id, "filtered");
          return { message, status: "filtered", payloads: 0 };
        }
        const record = result.note ?? (payloads.length === 1 ? payloads[0] : JSON.stringify(payloads));
        this.db.addStep(message.id, stepIndex, step.type, record.length > 20_000 ? record.slice(0, 20_000) : record);
        stepIndex++;
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.db.addStep(message.id, stepIndex, "error", error);
      this.db.setMessageStatus(message.id, "error", error);
      return { message, status: "error", error, payloads: 0 };
    }

    for (const payload of payloads) {
      config.destinations.forEach((dest, i) => {
        const destId = dest.id ?? `${dest.type}-${i}`;
        this.db.enqueueDelivery({
          messageId: message.id,
          channelId,
          destinationId: destId,
          seq: message.seq,
          ordered: dest.ordered ?? false,
          skipOnDead: dest.skipOnDead ?? false,
          maxAttempts: dest.maxAttempts ?? 8,
          payload,
          contentType: payloadType,
        });
      });
    }
    this.db.setMessageStatus(message.id, "processed");
    return { message, status: "processed", payloads: payloads.length };
  }

  private runStep(
    step: PipelineStep,
    payloads: string[],
    contentType: string
  ): { payloads: string[]; contentType: string; note?: string } {
    switch (step.type) {
      case "filter.hl7Type": {
        const kept = payloads.filter((p) => {
          const msg = parseHl7(p);
          const type = `${getHl7(msg, "MSH-9.1")}^${getHl7(msg, "MSH-9.2")}`;
          return step.allow.includes(type);
        });
        return { payloads: kept, contentType };
      }
      case "filter.hl7FieldEquals": {
        const kept = payloads.filter((p) => getHl7(parseHl7(p), step.path) === step.equals);
        return { payloads: kept, contentType };
      }
      case "filter.jsonEquals": {
        const kept = payloads.filter((p) => {
          const obj = JSON.parse(p);
          const parts = step.path.split(".");
          let cur: unknown = obj;
          for (const q of parts) cur = cur == null ? undefined : (cur as Record<string, unknown>)[q];
          return String(cur ?? "") === String(step.equals);
        });
        return { payloads: kept, contentType };
      }
      case "split.hl7Segment": {
        const out = payloads.flatMap((p) => splitHl7Segment(p, step.segment));
        return { payloads: out, contentType };
      }
      case "split.hl7Group": {
        const out = payloads.flatMap((p) => splitHl7Group(p, step.segment));
        return { payloads: out, contentType };
      }
      case "validate.profile": {
        const pack = this.conformance.get(step.pack);
        if (!pack) throw new Error(`Unknown conformance pack: ${step.pack}`);
        const errors: ConformanceIssue[] = [];
        for (const p of payloads) {
          let obj: Record<string, unknown>;
          try {
            obj = JSON.parse(p) as Record<string, unknown>;
          } catch {
            throw new Error("validate.profile requires JSON payloads; place it after transform.mapping");
          }
          errors.push(...validateResource(pack, obj, this.terminology).filter((i) => i.severity === "error"));
        }
        if ((step.mode ?? "reject") === "reject" && errors.length > 0) {
          const more = errors.length > 1 ? ` (+${errors.length - 1} more)` : "";
          throw new Error(`Conformance ${step.pack}: ${errors[0].message}${more}`);
        }
        return { payloads, contentType, note: JSON.stringify({ pack: step.pack, errors }) };
      }
      case "transform.mapping": {
        const doc = typeof step.mapping === "string" ? this.mappings.get(step.mapping) : step.mapping;
        if (!doc) throw new Error(`Unknown mapping: ${String(step.mapping)}`);
        const out = payloads.map((p) => JSON.stringify(applyMapping(doc, p, this.mapperCtx)));
        return { payloads: out, contentType: "application/fhir+json" };
      }
      default:
        throw new Error(`Unknown pipeline step: ${(step as { type: string }).type}`);
    }
  }
}

/** One message per instance of the named segment; non-matching segments kept in place. */
function splitHl7Segment(payload: string, segmentName: string): string[] {
  const msg = parseHl7(payload);
  const positions: number[] = [];
  msg.segments.forEach((s, i) => {
    if (s.name === segmentName) positions.push(i);
  });
  if (positions.length === 0) return [];
  if (positions.length === 1) return [payload];
  return positions.map((keep) =>
    serializeHl7({
      delimiters: msg.delimiters,
      segments: msg.segments.filter((s, i) => s.name !== segmentName || i === keep),
    })
  );
}

/** One message per group: shared header, then the anchor and everything up to the next anchor. */
function splitHl7Group(payload: string, segmentName: string): string[] {
  const msg = parseHl7(payload);
  const positions: number[] = [];
  msg.segments.forEach((s, i) => {
    if (s.name === segmentName) positions.push(i);
  });
  if (positions.length === 0) return [];
  if (positions.length === 1) return [payload];
  const header = msg.segments.slice(0, positions[0]);
  return positions.map((start, i) => {
    const end = positions[i + 1] ?? msg.segments.length;
    return serializeHl7({
      delimiters: msg.delimiters,
      segments: [...header, ...msg.segments.slice(start, end)],
    });
  });
}

export function validateChannel(config: ChannelConfig): void {
  if (!config.id || !/^[a-z0-9][a-z0-9-]*$/.test(config.id)) {
    throw new Error("Channel id must be lowercase alphanumeric with hyphens");
  }
  if (!config.name) throw new Error("Channel name is required");
  if (!config.source?.type) throw new Error("Channel source is required");
  if (config.source.type === "filedrop" && !config.source.dir) {
    throw new Error("filedrop source requires dir");
  }
  if (config.source.type === "dbpoll") {
    const s = config.source;
    if (!s.dbPath || !s.query || !s.cursorColumn) throw new Error("dbpoll source requires dbPath, query and cursorColumn");
    if (!s.query.includes("?")) throw new Error("dbpoll query must bind the cursor with a single ?");
  }
  if (config.source.type === "sqlpoll") {
    const s = config.source;
    if (s.driver !== "postgres" && s.driver !== "mysql") {
      throw new Error("sqlpoll driver must be postgres or mysql");
    }
    if (!s.dsn || !s.query || !s.cursorColumn) throw new Error("sqlpoll source requires dsn, query and cursorColumn");
    if (!s.query.includes("?")) throw new Error("sqlpoll query must bind the cursor with a single ?");
  }
  if (config.source.type === "sftp") {
    const s = config.source;
    if (!s.host || !s.username || !s.dir) throw new Error("sftp source requires host, username and dir");
    if (!s.password && !s.privateKeyPath) throw new Error("sftp source requires password or privateKeyPath");
  }
  // Reject a bad cron expression at configuration time rather than letting a
  // channel activate and then silently never fire.
  const cron = (config.source as { cron?: string }).cron;
  if (cron) new CronSchedule(cron);

  if (!Array.isArray(config.destinations) || config.destinations.length === 0) {
    throw new Error("At least one destination is required");
  }
  for (const d of config.destinations) {
    if (d.type === "http" && !d.url) throw new Error("HTTP destination requires url");
    if (d.type === "mllp" && (!d.host || !d.port)) throw new Error("MLLP destination requires host and port");
    // Refused at configuration rather than at the first message. A clinical
    // destination that cannot say whose chart an entry belongs on has nowhere
    // to put it, and discovering that per message means a dead-letter queue
    // full of entries nobody can file.
    if (d.type === "clinical" && !d.patientPath) {
      throw new Error("clinical destination requires patientPath, so an entry can be filed against a patient");
    }
  }
}

/**
 * Joins remote SFTP path segments. Always POSIX: node:path would use
 * backslashes on Windows, which the remote server would read as part of the
 * filename rather than as a separator.
 */
function remoteJoin(dir: string, name: string): string {
  return `${dir.replace(/\/+$/, "")}/${name}`;
}

/**
 * Serialises a cursor for storage. Drivers hand back Dates for timestamp
 * columns, and String(date) yields a locale form that will not round-trip
 * back into a query.
 */
function cursorValue(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  return String(v);
}
