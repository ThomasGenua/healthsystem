/** Portage core types. */

export type ContentType = "x-application/hl7-v2+er7" | "application/fhir+json" | "application/json" | "text/plain";

export interface MllpSourceConfig {
  type: "mllp";
  /** TCP port to listen on. 0 selects an ephemeral port. */
  port: number;
  host?: string;
  /**
   * Largest frame accepted, in bytes. Defaults to 16 MB. A sender that
   * exceeds it has its connection dropped — the port is unauthenticated, so
   * an unterminated frame must not be able to grow without limit.
   */
  maxFrameBytes?: number;
  /**
   * Character set to assume when a sender declares none in MSH-18, which is
   * most of them. Defaults to UNICODE UTF-8. A feed that emits ISO-8859-1
   * without saying so is configured here as "8859/1" — otherwise its accented
   * characters are refused rather than being silently replaced.
   */
  charset?: string;
}

export interface HttpSourceConfig {
  type: "http";
  /** Path suffix under /ingest/. Defaults to the channel id. */
  path?: string;
}

export interface FhirSourceConfig {
  type: "fhir";
  /** Resource types accepted at POST /fhir/:type. Empty accepts all. */
  resourceTypes?: string[];
}

/**
 * Poll a directory for dropped files. The practical northern pattern: the OS
 * terminates SFTP (openssh) into a landing directory, Portage picks files up,
 * ingests each as one message, and archives or deletes the original.
 */
export interface FiledropSourceConfig {
  type: "filedrop";
  dir: string;
  /** Regex applied to filenames. Default: all files. */
  pattern?: string;
  pollMs?: number;
  /** Poll on a 5-field cron schedule instead of every pollMs. */
  cron?: string;
  /** Move ingested files here. Default: delete after ingest. */
  archiveDir?: string;
  contentType?: string;
}

/**
 * Poll a SQLite database with a cursor. The query must take exactly one ?
 * bound to the last-seen cursor value and ORDER BY the cursor column
 * ascending, e.g. "SELECT * FROM results WHERE id > ? ORDER BY id".
 * Each row is ingested as one JSON message; the cursor persists in
 * channel_state so a restart resumes where it stopped.
 */
export interface DbPollSourceConfig {
  type: "dbpoll";
  dbPath: string;
  query: string;
  cursorColumn: string;
  pollMs?: number;
  /** Poll on a 5-field cron schedule instead of every pollMs. */
  cron?: string;
}

/**
 * Poll a Postgres or MySQL database. The query binds the persisted cursor
 * with a single `?`, exactly like the sqlite dbpoll source; the Postgres
 * adapter rewrites it to $1, so the same channel JSON reads the same way
 * whichever database is behind it.
 */
export interface SqlPollSourceConfig {
  type: "sqlpoll";
  driver: "postgres" | "mysql";
  /** Connection string, e.g. postgres://user:pass@host:5432/db */
  dsn: string;
  query: string;
  cursorColumn: string;
  /** Cursor to start from on first run. Defaults to 0. */
  initialCursor?: string;
  pollMs?: number;
  cron?: string;
  contentType?: string;
}

/** Poll a remote SFTP directory, the filedrop pattern without a local mount. */
export interface SftpSourceConfig {
  type: "sftp";
  host: string;
  port?: number;
  username: string;
  password?: string;
  /** Path to a private key file. Preferred over password. */
  privateKeyPath?: string;
  passphrase?: string;
  dir: string;
  /** Regex applied to filenames. Default: all files. */
  pattern?: string;
  /** Move ingested files here on the remote. Default: delete after ingest. */
  archiveDir?: string;
  pollMs?: number;
  cron?: string;
  contentType?: string;
}

export type SourceConfig =
  | MllpSourceConfig
  | HttpSourceConfig
  | FhirSourceConfig
  | FiledropSourceConfig
  | DbPollSourceConfig
  | SqlPollSourceConfig
  | SftpSourceConfig;

export interface Hl7TypeFilter {
  type: "filter.hl7Type";
  /** Allowed MSH-9 values as MessageType^TriggerEvent, e.g. "ADT^A01". */
  allow: string[];
}

export interface Hl7FieldEqualsFilter {
  type: "filter.hl7FieldEquals";
  path: string;
  equals: string;
}

export interface JsonEqualsFilter {
  type: "filter.jsonEquals";
  path: string;
  equals: string | number | boolean;
}

export interface MappingTransform {
  type: "transform.mapping";
  /** Mapping id registered with the engine, or an inline mapping document. */
  mapping: string | MappingDoc;
}

/**
 * Split one HL7 message into one message per instance of a repeating segment,
 * each output keeping every non-repeating segment. An ORU with three OBX
 * segments becomes three messages of one OBX each. Zero instances filters
 * the message. Grouping is flat: for multi-OBR batteries, split per OBR
 * upstream first.
 */
export interface Hl7SegmentSplit {
  type: "split.hl7Segment";
  segment: string;
}

/**
 * Split one HL7 message into one message per group anchored on a segment.
 * Each output keeps every segment before the first anchor (the header:
 * MSH, PID, PV1 and so on) plus the anchor instance and everything after
 * it up to the next anchor. An ORU with two OBR batteries becomes two
 * messages, each carrying its own OBX and NTE children; chain with
 * split.hl7Segment OBX for one message per result.
 */
export interface Hl7GroupSplit {
  type: "split.hl7Group";
  segment: string;
}

/**
 * Validate each JSON payload against a registered conformance pack.
 * mode "reject" (default) fails the message on any error-level issue,
 * which surfaces as an AE at an MLLP source. mode "annotate" records
 * the issues on the message step and lets the payload through.
 */
export interface ProfileValidate {
  type: "validate.profile";
  pack: string;
  mode?: "reject" | "annotate";
}

export type PipelineStep =
  | Hl7TypeFilter
  | Hl7FieldEqualsFilter
  | JsonEqualsFilter
  | MappingTransform
  | Hl7SegmentSplit
  | Hl7GroupSplit
  | ProfileValidate;

/**
 * Client certificate for an outbound destination. Present it and the delivery
 * goes out over node:https rather than fetch, which cannot carry one.
 */
export interface DestinationTlsConfig {
  certPath?: string;
  keyPath?: string;
  /** CA that signs the remote's certificate, when it is not publicly trusted. */
  caPath?: string;
  /** Defaults to true. Turning it off disables peer verification entirely. */
  rejectUnauthorized?: boolean;
}

export interface HttpDestinationConfig {
  id?: string;
  type: "http";
  url: string;
  method?: "POST" | "PUT";
  headers?: Record<string, string>;
  contentType?: string;
  tls?: DestinationTlsConfig;
  timeoutMs?: number;
  maxAttempts?: number;
  backoffBaseMs?: number;
  backoffCapMs?: number;
  /** Deliver strictly in arrival order for this destination. */
  ordered?: boolean;
  /** When ordered, allow later messages past a dead-lettered one. */
  skipOnDead?: boolean;
}

export interface MllpDestinationConfig {
  id?: string;
  type: "mllp";
  host: string;
  port: number;
  timeoutMs?: number;
  maxAttempts?: number;
  backoffBaseMs?: number;
  backoffCapMs?: number;
  ordered?: boolean;
  skipOnDead?: boolean;
}

/** Deliver into the local FHIR facade store, served back at GET /fhir/:type. */
export interface FhirStoreDestinationConfig {
  id?: string;
  type: "fhirstore";
  /**
   * Conformance pack enforced as the resource is written, overriding the
   * engine-wide default. reject fails the delivery (which retries, then
   * dead-letters) and stores nothing; annotate records the issues on the
   * delivery ack and stores the resource anyway.
   */
  validatePack?: string;
  validateMode?: "reject" | "annotate";
  maxAttempts?: number;
  backoffBaseMs?: number;
  backoffCapMs?: number;
  ordered?: boolean;
  skipOnDead?: boolean;
}

/**
 * Write into the longitudinal clinical record.
 *
 * The chart is append-only, so this never overwrites: a message about a record
 * already held either says the same thing, in which case nothing is written,
 * or says something different, in which case it amends and the earlier version
 * stays readable with the message that changed it recorded against it.
 */
export interface ClinicalDestinationConfig {
  id?: string;
  type: "clinical";
  /**
   * Where the patient identifier is in the payload, e.g.
   * "identifier[0].value" on a Patient, "subject.identifier.value" elsewhere.
   * A chart entry that cannot say whose it is has nowhere to go.
   */
  patientPath: string;
  /**
   * Paths whose values together identify the logical record, so a repeat or
   * an update lands on the record it is about rather than beside it. Defaults
   * to the patient path, which is right for a Patient and wrong for anything
   * that repeats per patient — an Observation needs its filler order number.
   */
  identity?: string[];
  /** Where an encounter identifier sits, when the payload carries one. */
  encounterPath?: string;
  /** Where the clinically effective time sits, when it differs from arrival. */
  effectivePath?: string;
  ordered?: boolean;
  skipOnDead?: boolean;
  maxAttempts?: number;
  backoffBaseMs?: number;
  backoffCapMs?: number;
}

export type DestinationConfig =
  | HttpDestinationConfig
  | MllpDestinationConfig
  | FhirStoreDestinationConfig
  | ClinicalDestinationConfig;

export interface ChannelConfig {
  id: string;
  name: string;
  enabled?: boolean;
  source: SourceConfig;
  pipeline?: PipelineStep[];
  destinations: DestinationConfig[];
  /**
   * How long this channel may go without receiving a message before it counts
   * as silent. Off unless set, because no threshold fits both a nursing
   * station admitting four patients a day and a lab pushing results every few
   * minutes — the cadence has to be declared, not guessed.
   *
   * Without it, a feed that stops sending is invisible: every other health
   * signal reports on what is in the queue, and a stopped feed puts nothing
   * there, so it reads exactly like a quiet night.
   */
  expectMessageEverySec?: number;
}

/** Declarative mapping document. */
export interface MappingDoc {
  id: string;
  name?: string;
  input: "hl7" | "json";
  output: "json";
  ops: MappingOp[];
}

export interface MappingOp {
  /** Target path on the output object, e.g. "name[0].family". */
  set: string;
  /** Source path on the input: an HL7 path like "PID-5.1" or a dot path for JSON input. */
  from?: string;
  /** Literal value. Used when "from" is absent, or as fn input alongside "from". */
  value?: unknown;
  /** Transform function name from the mapper library. */
  fn?: string;
  /** Function arguments. */
  args?: Record<string, unknown>;
  /** Only apply when this condition holds against the input. */
  when?: { path: string; equals?: unknown; exists?: boolean };
}

export type MessageStatus = "received" | "processed" | "filtered" | "error";
export type DeliveryState = "queued" | "inflight" | "delivered" | "dead" | "discarded";

export interface MessageRow {
  id: string;
  seq: number;
  channel_id: string;
  received_at: string;
  source_type: string;
  content_type: string;
  raw: string;
  status: MessageStatus;
  error: string | null;
  meta: string | null;
  hash: string;
  prev_hash: string | null;
}

export interface DeliveryRow {
  id: string;
  /** The custodian this delivery belongs to, so it is written into theirs. */
  tenant_id: string;
  message_id: string;
  channel_id: string;
  destination_id: string;
  seq: number;
  ordering_key: string;
  ordered: number;
  skip_on_dead: number;
  state: DeliveryState;
  attempts: number;
  max_attempts: number;
  next_attempt_at: number;
  payload: string;
  content_type: string;
  last_error: string | null;
  ack: string | null;
  delivered_at: string | null;
}

export interface SubscriptionRow {
  id: string;
  status: string;
  criteria: string;
  endpoint: string;
  payload: string;
  created_at: string;
}

export interface ApiKeyRow {
  id: string;
  /** The custodian this credential belongs to. */
  tenant_id: string;
  name: string;
  /** SHA-256 of the key. The key itself is never stored. */
  hash: string;
  /** Space-delimited scope list. */
  scopes: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  /** When it stops working. Null means it does not expire. */
  expires_at: string | null;
  /** Set on a rotated key: the id of its replacement. */
  rotated_to: string | null;
  rotated_at: string | null;
}

/** Declarative conformance pack: profile rules per resource type. */
export interface ProfileRule {
  /** Dot path; arrays flatten at every hop, so "identifier.system" reads every identifier. */
  path?: string;
  min?: number;
  max?: number;
  /** Every collected value must equal this. */
  fixed?: unknown;
  /** Every collected value must match this regex. */
  pattern?: string;
  /** Every collected value must be one of these. */
  inSet?: unknown[];
  /** Every collected value must be a code in this ValueSet from the terminology store. */
  valueSetRef?: string;
  /** Every collected element must carry these non-empty keys. */
  each?: { required: string[] };
  /** At least min (default 1) of these paths must be present. */
  oneOf?: string[];
  description?: string;
}

export interface ProfileDef {
  resourceType: string;
  profile?: string;
  rules: ProfileRule[];
}

export interface ConformancePack {
  id: string;
  name: string;
  description?: string;
  profiles: ProfileDef[];
  /** Exchange-level expectation checked against the facade CapabilityStatement. */
  capability?: { resourceTypes: string[]; interactions: string[] };
}

export interface ConformanceIssue {
  severity: "error" | "warning" | "information";
  path?: string;
  message: string;
}
