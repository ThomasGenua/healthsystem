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
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Db, type SourceFailureStage } from "../db.ts";
import { faultLine } from "./refusal.ts";
import { DeliveryWorker } from "./queue.ts";
import { FhirStore } from "../fhir/store.ts";
import { SubscriptionManager } from "../fhir/subscriptions.ts";
import { TerminologyStore } from "../terminology/store.ts";
import { ConformanceRegistry, validateResource } from "../conformance/validator.ts";
import { ApiKeyStore } from "../auth/keys.ts";
import { AuditStore } from "../audit/store.ts";
import { ClinicalRecord } from "../clinical/record.ts";
import { ClinicalNotes } from "../clinical/notes.ts";
import { Immunizations } from "../clinical/immunizations.ts";
import { Vitals } from "../clinical/vitals.ts";
import { Procedures } from "../clinical/procedures.ts";
import { CarePlans } from "../clinical/careplans.ts";
import { PatientDocuments } from "../clinical/documents.ts";
import { CareTeam } from "../clinical/careteam.ts";
import { Coverage } from "../clinical/coverage.ts";
import { MedicationStore } from "../meds/store.ts";
import type { InteractionSource } from "../meds/safety.ts";
import { ChannelPharmacyDispatcher, Prescribing } from "../meds/prescribe.ts";
import { OrderStore } from "../orders/store.ts";
import { LabIntake } from "../orders/intake.ts";
import { GENERIC_LAB_PROFILE, type LabProfile } from "../orders/hl7.ts";
import { ReferralStore } from "../work/referrals.ts";
import { TaskStore } from "../work/tasks.ts";
import { Workspace } from "../workspace/summary.ts";
import { VisitView } from "../workspace/visit.ts";
import { Encounters } from "../clinical/encounters.ts";
import { Directory } from "../directory/store.ts";
import { ScoreGovernance } from "../clinical/score-governance.ts";
import { StandardsRegistry } from "../conformance/standards.ts";
import { ingestFhir } from "../directory/fhir.ts";
import { ChannelNoticeDispatcher, PatientNotices } from "../patient/notice.ts";
import { AccessReview } from "../audit/review.ts";
import { Clinics } from "../schedule/clinics.ts";
import { ChannelVersions } from "./channel-versions.ts";
import { PatientLinks } from "../clinical/links.ts";
import { Schedule } from "../schedule/store.ts";
import { Registry } from "../population/registry.ts";
import { Migration } from "../migrate/run.ts";
import { ConsentDirectives } from "../patient/consent.ts";
import { PatientMessaging } from "../patient/messaging.ts";
import { PatientAccess } from "../patient/access.ts";
import { PatientEnrolment } from "../patient/enrolment.ts";
import { PrivacyOffice } from "../privacy/office.ts";
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
  immunizations: Immunizations;
  vitals: Vitals;
  procedures: Procedures;
  carePlans: CarePlans;
  documents: PatientDocuments;
  careTeam: CareTeam;
  coverage: Coverage;
  meds: MedicationStore;
  /** Prescriptions, and whether they reached a pharmacy. */
  prescribing: Prescribing;
  orders: OrderStore;
  /** Inbound laboratory results, and the queue of ones nobody could identify. */
  labIntake: LabIntake;
  referrals: ReferralStore;
  tasks: TaskStore;
  schedule: Schedule;
  messaging: PatientMessaging;
  patientAccess: PatientAccess;
  /** Clinic-attested binding of an OAuth subject to a chart. Not identity-proofing. */
  enrolment: PatientEnrolment;
  scoreGovernance: ScoreGovernance;
  standards: StandardsRegistry;
  /** Notices a patient is owed, published onto a channel. Dispatching is not telling. */
  notices: PatientNotices;
  registry: Registry;
  /** Bulk loads from an incumbent system, and whether they were complete. */
  migration: Migration;
  consent: ConsentDirectives;
  /** Queues, clocks, holds, incidents and the assurance catalogue. */
  privacy: PrivacyOffice;
  /** The assembled chart, over exactly the stores above. */
  workspace: Workspace;
  /** Visits, and what belongs to each one. */
  encounters: Encounters;
  /** Practitioners, organizations, locations and the services they provide. */
  directory: Directory;
  /** Reads the trail the way a privacy officer asks about it. */
  review: AccessReview;
  /** Travelling-clinic visits and the waitlist. */
  clinics: Clinics;
  /** Reversible assertions that two charts are one person. */
  links: PatientLinks;
  /** The assembled visit, the encounter-scoped counterpart to `workspace`. */
  visits: VisitView;
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
  /**
   * The channel break-glass notices are published to.
   *
   * Unset means notices are not sent, and the override queue behaves exactly
   * as it did before — an operator is shown what they owe and tells the patient
   * by hand. Set, and every override becomes a message on that channel, carried
   * to the deployment's destinations by the same ordered, retried, dead-lettered
   * machinery as any other clinical message.
   *
   * Deliberately a channel id rather than an address: Northstar holds nothing to
   * reach a patient by, and inventing one for a disclosure notice would send
   * somebody's private business to a stranger.
   */
  breakGlassNoticeChannel?: string;
  /**
   * The channel prescriptions are transmitted to a pharmacy on.
   *
   * Unset means prescriptions cannot be transmitted, and `transmit()` refuses
   * with that reason rather than recording one as sent. A deployment without a
   * pharmacy interface records prescriptions as printed, which is honest and is
   * how most prescriptions in most places still travel.
   */
  pharmacyChannel?: string;
  /**
   * What authorises this deployment to transmit controlled substances
   * electronically — a licence or programme name, not a boolean.
   *
   * Unset means it may not. Narcotic e-prescribing is separately regulated, and
   * a system that transmitted one because it technically could would put a
   * deployment in breach without telling it.
   */
  controlledSubstanceAuthority?: string;
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
  /** The ledger of every shape each channel's configuration has had. */
  readonly channelVersions: ChannelVersions;
  readonly mappings = new Map<string, MappingDoc>();
  /**
   * Laboratory dialects, by id. Configuration rather than code: every lab
   * sends a slightly different ORU, and a fork per laboratory is how a
   * platform stops being one platform.
   */
  readonly labProfiles = new Map<string, LabProfile>([[GENERIC_LAB_PROFILE.id, GENERIC_LAB_PROFILE]]);
  private channels = new Map<string, RuntimeChannel>();
  private mapperCtx: MapperContext;
  private connectors: Required<ConnectorFactories>;
  private validation: ConstructorParameters<typeof FhirStore>[1];
  private views = new Map<string, TenantView>();
  private lockTimer: NodeJS.Timeout | null = null;
  /** Where the database file lives; empty for an in-memory engine. */
  readonly dataDir: string;
  private interactions: InteractionSource | null;
  /** The channel break-glass notices go to, when a deployment configures one. */
  private noticeChannel: string | null;
  /** The channel prescriptions are transmitted on, when one is configured. */
  private pharmacyChannel: string | null;
  /** What authorises transmitting a controlled substance, when anything does. */
  private controlledAuthority: string | null;
  private lockStaleMs: number;
  private lockHeartbeatMs: number;
  private holdsLock = false;

  constructor(opts: EngineOptions) {
    this.db = new Db(opts.dbPath);
    // The directory the database lives in, so the encryption-at-rest check has
    // something to resolve without being told the path twice.
    this.dataDir = opts.dbPath === ":memory:" ? "" : dirname(opts.dbPath);
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
    const directory = new Directory(this.db);
    this.fhir = new FhirStore(this.db, this.validation, directory);
    // Resolved per delivery, since one worker drains every tenant on the node.
    this.worker = new DeliveryWorker(this.db, opts.tickMs ?? 250, 25, (tenantId) => this.forTenant(tenantId));
    this.worker.setLabProfiles((id) => this.labProfiles.get(id));
    this.subs = new SubscriptionManager(this.db, this.worker);
    this.keys = new ApiKeyStore(this.db, directory);
    this.audit = new AuditStore(this.db);
    this.channelVersions = new ChannelVersions(this.db);
    this.retention = new RetentionRunner(this.db, opts.retention ?? {}, this.audit);
    this.connectors = {
      sql: opts.connectors?.sql ?? connectSql,
      sftp: opts.connectors?.sftp ?? connectSftp,
    };
    this.interactions = opts.interactions ?? null;
    this.noticeChannel = opts.breakGlassNoticeChannel ?? null;
    this.pharmacyChannel = opts.pharmacyChannel ?? null;
    this.controlledAuthority = opts.controlledSubstanceAuthority ?? null;
    this.lockStaleMs = opts.lockStaleMs ?? 20_000;
    // Comfortably inside the staleness window, so a slow moment never costs a
    // running engine its own claim.
    this.lockHeartbeatMs = Math.max(1_000, Math.floor(this.lockStaleMs / 4));
    this.fhir.onChange((result, resource) => {
      this.subs.notify(result, resource);
      ingestFhir(directory, resource);
    });
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
    const clinical = new ClinicalRecord(db);
    const notes = new ClinicalNotes(clinical);
    const immunizations = new Immunizations(clinical);
    const vitals = new Vitals(clinical);
    const procedures = new Procedures(clinical);
    const carePlans = new CarePlans(clinical);
    const documents = new PatientDocuments(clinical);
    const careTeam = new CareTeam(db);
    const coverage = new Coverage(db);
    const schedule = new Schedule(db);
    const messaging = new PatientMessaging(db);
    // No interaction database unless a deployment supplies one. The safety
    // check reports interactions as unchecked rather than clear, which is the
    // honest answer and the one src/meds/safety.ts is built to give.
    const meds = new MedicationStore(db, this.interactions);
    // Before prescribing, because a renewal request from a pharmacy is an
    // item in this worklist rather than a status on the prescription.
    const tasks = new TaskStore(db);
    const prescribing = new Prescribing(db, meds, {
      tasks,
      // Absent unless a deployment configures a channel, and absence is a
      // refusal at transmit time rather than a prescription that looks sent.
      ...(this.pharmacyChannel ? { dispatcher: new ChannelPharmacyDispatcher(db, this.pharmacyChannel) } : {}),
      ...(this.controlledAuthority ? { controlledSubstanceAuthority: this.controlledAuthority } : {}),
    });
    const orders = new OrderStore(db);
    const labIntake = new LabIntake(db, orders, clinical.patientIndex);
    const referrals = new ReferralStore(db);
    const patientAccess = new PatientAccess(db, orders, tasks);
    const notices = new PatientNotices(db, this.noticeChannel);
    const enrolment = new PatientEnrolment(db, patientAccess, notices);
    const encounters = new Encounters(db);
    // Built here rather than inline in the view because the key store needs it
    // too: issuing a credential for an organization nobody has registered is a
    // typo worth refusing, and only the directory can tell.
    const directory = new Directory(db);
    // Reads the directory, so it is built after it: a clinical owner must be
    // a practitioner this tenant actually registered.
    const scoreGovernance = new ScoreGovernance(db);
    // Distinct from `conformance` above, which holds the validation packs:
    // this records which published standards this deployment claims.
    const standards = new StandardsRegistry(db);
    const fhir = new FhirStore(db, this.validation, directory);
    // Resources written before fhir_resources carried a patient reference have
    // none, and a patient-scoped search excludes what it cannot attribute. So
    // the recovery runs here rather than waiting for somebody to notice a
    // chart looking emptier than it is.
    fhir.backfillPatients();
    const subs = new SubscriptionManager(db, this.worker);
    fhir.onChange((result, resource) => {
      subs.notify(result, resource);
      ingestFhir(directory, resource);
    });
    // One AuditStore per view so the in-memory chain tip is shared. Consent,
    // tasks, patient access and the care team are the same instances the
    // privacy office reads — two copies would diverge the queues it is
    // charged with emptying.
    const audit = new AuditStore(db);
    const consent = new ConsentDirectives(db, {
      ...(this.noticeChannel ? { dispatcher: new ChannelNoticeDispatcher(db, this.noticeChannel) } : {}),
    });
    const privacy = new PrivacyOffice({ db, consent, patientAccess, careTeam, tasks });
    const view: TenantView = {
      tenantId,
      db,
      fhir,
      subs,
      keys: new ApiKeyStore(db, directory),
      audit,
      clinical,
      notes,
      immunizations,
      vitals,
      procedures,
      carePlans,
      documents,
      careTeam,
      coverage,
      meds,
      prescribing,
      orders,
      labIntake,
      referrals,
      tasks,
      schedule,
      messaging,
      patientAccess,
      enrolment,
      scoreGovernance,
      standards,
      notices,
      registry: new Registry(db),
      migration: new Migration(db, { clinical, meds }),
      consent,
      privacy,
      workspace: new Workspace({
        record: clinical,
        notes,
        meds,
        orders,
        referrals,
        tasks,
        immunizations,
        vitals,
        procedures,
        carePlans,
        documents,
        careTeam,
        coverage,
        schedule,
        messaging,
      }),
      encounters,
      directory,
      review: new AccessReview(db),
      clinics: new Clinics(db),
      links: new PatientLinks(db),
      visits: new VisitView({ encounters, record: clinical, meds, orders }),
    };
    this.views.set(tenantId, view);
    return view;
  }

  registerMapping(doc: MappingDoc): void {
    this.mappings.set(doc.id, doc);
  }

  /**
   * Registers a laboratory dialect.
   *
   * Refuses a profile with no id, because a `labresults` destination naming a
   * profile that does not resolve fails the delivery — and an operator who
   * mistyped one should find out at boot rather than from a dead letter at
   * three in the morning.
   */
  registerLabProfile(profile: LabProfile): void {
    if (!profile.id?.trim()) throw new Error("a laboratory profile needs an id");
    if (!profile.name?.trim()) throw new Error(`laboratory profile ${profile.id} needs a name`);
    this.labProfiles.set(profile.id, profile);
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
        `another Northstar instance owns this database (pid ${held.pid} on ${held.host}, ` +
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

  /**
   * Persist and activate a channel. Replaces a running channel of the same id.
   *
   * Every change lands as a version first — who, when, why, and what it said
   * before — because the configuration that decides how messages are produced
   * was the last thing here still overwritten in place. Callers that do not
   * say who they are are recorded as the system acting on its own, which is
   * itself information: a config change nobody claims is worth noticing.
   */
  async addChannel(config: ChannelConfig, opts: { by?: string; note?: string } = {}): Promise<void> {
    validateChannel(config);
    this.channelVersions.commit({
      channelId: config.id,
      name: config.name,
      enabled: config.enabled !== false,
      config: JSON.stringify(config),
      by: opts.by ?? "system",
      note: opts.note ?? "(no note given)",
      origin: "edit",
    });
    if (this.channels.has(config.id)) await this.deactivate(config.id);
    if (config.enabled !== false) await this.activate(config);
  }

  async removeChannel(id: string, opts: { by?: string; note?: string } = {}): Promise<void> {
    await this.deactivate(id);
    // The deletion marker goes into the history before the row goes, so "who
    // turned the ADT feed off on Tuesday" survives the feed being turned off.
    this.channelVersions.markDeleted(id, { actorId: opts.by ?? "system", note: opts.note ?? "(no note given)" });
    this.db.deleteChannel(id);
  }

  /**
   * Restores an old configuration as a new version and puts it live —
   * including recreating a channel that was deleted, which is what makes the
   * deletion marker an entry in a history rather than the end of one.
   */
  async rollbackChannel(id: string, toVersion: number, opts: { by?: string; note?: string } = {}): Promise<ChannelConfig> {
    const restored = this.channelVersions.rollback(id, toVersion, {
      actorId: opts.by ?? "system",
      note: opts.note ?? `rollback to version ${toVersion}`,
    });
    await this.refreshChannel(id);
    return JSON.parse(restored.config) as ChannelConfig;
  }

  /**
   * Makes the runtime match the stored row, and writes nothing.
   *
   * The row's `enabled` column is the authority, not the blob's `enabled`
   * field: an import can disable a channel at the document level while the
   * blob says nothing, and a restart that re-derived enabled from the blob
   * would turn the channel back on — recording a second version nobody asked
   * for while it did it. Reactivation after a ledger write goes through here
   * so the ledger stays the only writer.
   */
  async refreshChannel(id: string): Promise<void> {
    if (this.channels.has(id)) await this.deactivate(id);
    const row = this.db.getChannel(id);
    if (row && row.enabled === 1) {
      await this.activate(JSON.parse(row.config) as ChannelConfig);
    }
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
          } catch (err) {
            // A drop directory that has been unmounted, renamed or had its
            // permissions changed used to be swallowed by a bare `catch`
            // with no log and nothing written down. The channel stayed
            // `running`, the health check stayed green, and the only symptom
            // was files nobody collected.
            this.sourceFailed(config.id, "read", err);
            return;
          }
          let clean = true;
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
              // The directory was read, so the link is up and one file is
              // bad. The name goes to the record rather than the log: a drop
              // file is routinely named by the sending system after an
              // accession or a chart number.
              clean = false;
              this.sourceFailed(config.id, "item", err, name);
            }
          }
          if (clean) this.sourcePassed(config.id);
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
          let rows: Array<Record<string, unknown>>;
          try {
            const cursor = this.db.getChannelState(config.id, "cursor");
            const bound: string | number =
              cursor === undefined ? 0 : /^-?\d+(\.\d+)?$/.test(cursor) ? Number(cursor) : cursor;
            rows = rc.pollDb.prepare(src.query).all(bound) as Array<Record<string, unknown>>;
          } catch (err) {
            // The query is the link. A file that has moved, a schema that has
            // changed under us, a database that will not open: whatever it
            // is, nothing is arriving and somebody has to be told.
            this.sourceFailed(config.id, "read", err);
            return;
          }
          let clean = true;
          for (const row of rows) {
            try {
              this.ingest(config.id, JSON.stringify(row), "application/json", "dbpoll");
              this.db.setChannelState(config.id, "cursor", String(row[src.cursorColumn]));
            } catch (err) {
              // Stop at the first bad row rather than advancing past it. The
              // cursor has not moved, so the next poll re-reads from here;
              // continuing would step over the row and lose it silently.
              clean = false;
              this.sourceFailed(config.id, "item", err);
              break;
            }
          }
          if (clean) this.sourcePassed(config.id);
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
          let rows: Array<Record<string, unknown>>;
          try {
            if (!rc.sqlClient) rc.sqlClient = await this.connectors.sql(src.driver, src.dsn);
            const stored = this.db.getChannelState(config.id, "cursor") ?? src.initialCursor ?? "0";
            const bound: string | number = /^-?\d+(\.\d+)?$/.test(stored) ? Number(stored) : stored;
            rows = await rc.sqlClient.query(src.query, [bound]);
          } catch (err) {
            // Connecting and querying are both the link, and both fail the
            // same way from an operator's chair: the far end is not
            // answering. The client is dropped so the next poll reconnects.
            this.sourceFailed(config.id, "read", err);
            await this.dropSqlClient(rc);
            return;
          }
          let clean = true;
          for (const row of rows) {
            try {
              this.ingest(config.id, JSON.stringify(row), src.contentType ?? "application/json", "sqlpoll");
              this.db.setChannelState(config.id, "cursor", cursorValue(row[src.cursorColumn]));
            } catch (err) {
              // As in dbpoll: stop here, leave the cursor, re-read next time.
              clean = false;
              this.sourceFailed(config.id, "item", err);
              break;
            }
          }
          if (clean) this.sourcePassed(config.id);
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
          let files: Array<{ name: string }>;
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
            files = (await rc.sftpClient.list(src.dir))
              .filter((f) => !pattern || pattern.test(f.name))
              .sort((a, b) => a.name.localeCompare(b.name));
          } catch (err) {
            // Credentials, host key, network, a directory that has moved: all
            // of them are "we cannot reach the far end", which is the thing
            // an operator has to be told and the thing nothing recorded.
            this.sourceFailed(config.id, "read", err);
            await this.dropSftpClient(rc);
            return;
          }
          let clean = true;
          for (const f of files) {
            try {
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
            } catch (err) {
              // One file, on a link that answered. The session is dropped
              // anyway, because a transfer that failed part-way is the most
              // likely sign of a connection that has gone bad underneath it.
              clean = false;
              this.sourceFailed(config.id, "item", err, f.name);
              await this.dropSftpClient(rc);
              break;
            }
          }
          if (clean) this.sourcePassed(config.id);
        } finally {
          rc.polling = false;
        }
      };
      this.schedule(rc, config.id, src, poll);
    }

    this.channels.set(config.id, rc);
  }

  /**
   * Writes a poll failure down where a health check can see it.
   *
   * Every inbound poll used to catch its own exception, print it and return.
   * A printed line is not a signal: nobody alerts on it, `/api/health` is
   * built from the queue and from declared cadences, and a channel with no
   * declared cadence therefore reported healthy for as long as its source
   * stayed unreachable. The record is durable and per-channel; the log gets
   * the id that reaches it, and the class and frames, and not the message —
   * a polling query can quote the row it was reading, and a drop file is
   * routinely named after a chart.
   */
  private sourceFailed(channelId: string, stage: SourceFailureStage, err: unknown, item?: string): void {
    const record = this.db.recordSourceFailure(channelId, stage, err, item);
    console.error(`channel ${channelId}: ${stage} failed ${record.consecutive}x - ${faultLine(record.faultId, err)}`);
  }

  /** Forgets a channel's failures, after a pass that read its source and handled everything on it. */
  private sourcePassed(channelId: string): void {
    if (this.db.sourceFailure(channelId)) this.db.clearSourceFailure(channelId);
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
      // `Promise.resolve(poll())` evaluates `poll()` first, so a synchronous
      // throw escapes before there is a promise to attach `.catch` to — out
      // of the setInterval callback, and out of the process, which is an
      // unhandled exception that takes the engine down over one bad poll.
      // Every poll below guards itself, but this is the net under all of
      // them and it has to actually be under them.
      try {
        void Promise.resolve(poll()).catch((err: unknown) => this.sourceFailed(channelId, "read", err));
      } catch (err) {
        this.sourceFailed(channelId, "read", err);
      }
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
    // A `labresults` destination reads raw HL7. A mapping step ahead of it
    // replaces the payload with JSON, so the destination would refuse every
    // message — a whole feed dead-lettering for a reason that is visible here
    // and invisible at three in the morning. A channel that wants both a filed
    // result and a facade Observation runs two channels, or maps in the
    // second destination rather than in the pipeline.
    if (d.type === "labresults" && (config.pipeline ?? []).some((s) => s.type === "transform.mapping")) {
      throw new Error(
        "a labresults destination reads raw HL7, so it cannot follow a transform.mapping step; " +
          "put the mapping on a separate channel"
      );
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
