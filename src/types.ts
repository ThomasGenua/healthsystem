/** Portage core types. */

export type ContentType = "x-application/hl7-v2+er7" | "application/fhir+json" | "application/json" | "text/plain";

export interface MllpSourceConfig {
  type: "mllp";
  /** TCP port to listen on. 0 selects an ephemeral port. */
  port: number;
  host?: string;
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
}

export type SourceConfig = MllpSourceConfig | HttpSourceConfig | FhirSourceConfig | FiledropSourceConfig | DbPollSourceConfig;

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

export interface HttpDestinationConfig {
  id?: string;
  type: "http";
  url: string;
  method?: "POST" | "PUT";
  headers?: Record<string, string>;
  contentType?: string;
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
  maxAttempts?: number;
  backoffBaseMs?: number;
  backoffCapMs?: number;
  ordered?: boolean;
  skipOnDead?: boolean;
}

export type DestinationConfig = HttpDestinationConfig | MllpDestinationConfig | FhirStoreDestinationConfig;

export interface ChannelConfig {
  id: string;
  name: string;
  enabled?: boolean;
  source: SourceConfig;
  pipeline?: PipelineStep[];
  destinations: DestinationConfig[];
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
