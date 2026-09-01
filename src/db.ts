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

/**
 * Tables holding one tenant's data, and therefore carrying tenant_id.
 *
 * Terminology is deliberately absent. SNOMED CT CA, LOINC and the
 * classification tables are provincial reference data — the shared
 * configuration baseline every organization works from — and copying them per
 * tenant would mean a code meaning one thing in one clinic and another
 * elsewhere. instance_lock is absent because it is a property of the database
 * file rather than of anyone's data.
 */
export const TENANT_SCOPED_TABLES = [
  "channels",
  "messages",
  "message_steps",
  "deliveries",
  "fhir_resources",
  "fhir_identifiers",
  "channel_state",
  "fhir_subscriptions",
  "api_keys",
  "audit_events",
  "clinical_entries",
  "patient_index",
  "patient_identifiers",
  "tasks",
  "task_events",
  "referrals",
  "referral_events",
  "orders",
  "order_results",
  "order_routing",
  "order_transmissions",
  "order_events",
  "medication_statements",
  "allergies",
  "med_reconciliations",
  "med_reconciliation_items",
  "medication_events",
  "patient_authority",
  "result_release",
  "patient_access_log",
  "patient_requests",
  "patient_request_events",
  "patient_enrolments",
  "patient_notices",
  "schedule_slots",
  "schedule_bookings",
  "schedule_events",
  "consent_directives",
  "break_glass",
  "encounters",
  "encounter_participants",
  "encounter_events",
  "directory_practitioners",
  "directory_organizations",
  "directory_locations",
  "directory_services",
  "directory_roles",
  "directory_identifiers",
  "care_team",
  "coverage",
  "patient_threads",
  "patient_messages",
  "patient_thread_events",
  "lab_identity_holds",
  "access_review_dismissals",
  "schedule_visits",
  "schedule_waitlist",
  "schedule_offers",
  "channel_versions",
  "patient_link_events",
  "station_manifest",
  "station_breakglass",
  "prescriptions",
  "prescription_events",
  "prescription_dispenses",
  "pharmacy_dispense_reporting",
  "migration_runs",
  "migration_records",
  "migration_declarations",
  "privacy_reviews",
  "privacy_review_events",
  "privacy_flags",
  "legal_holds",
  "privacy_incidents",
  "privacy_incident_events",
  "privacy_disclosures",
  "privacy_deadlines",
  "assurance_findings",
  "assurance_exercises",
  "subprocessors",
  "score_approvals",
] as const;

/**
 * The tenant existing rows belong to.
 *
 * A single-tenant database predates this entirely, so its rows have to land
 * somewhere on upgrade rather than becoming unreachable. They land here, and a
 * deployment that never configures a second tenant behaves exactly as before.
 */
export const DEFAULT_TENANT = "default";

/**
 * The key that defines a strict-ordering queue.
 *
 * One function because the format is a contract between two places that must
 * agree: the delivery row records it, and the worker looks a destination up by
 * it. They were built independently from the same string, and the first change
 * to the format broke delivery entirely with "Destination not registered" —
 * which is a loud failure and was still only caught because a test exercised
 * the whole path.
 *
 * The tenant leads. Channel ids are unique only within a tenant, so without it
 * two custodians who both name a channel "adt" share one ordered queue, and a
 * message stuck at one organization's head blocks the other's feed.
 */
export function orderingKey(tenantId: string, channelId: string, destinationId: string): string {
  return `${tenantId}:${channelId}:${destinationId}`;
}

const SCHEMA = `
-- A tenant is one health information custodian's boundary. Organizations,
-- providers and patients all live inside one; nothing crosses without an
-- explicit, separately authorised relationship.
CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  custodian TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  suspended_at TEXT
);

-- Every shape a channel's configuration has ever had.
--
-- The channels row is the running state; this is its history. Messages chain,
-- the clinical record is append-only, audit rows chain — and until this table
-- the configuration that determines how all of those are produced was
-- overwritten in place, with no record it ever said anything else. A mapping
-- change that starts dropping a segment at 14:00 left an operator an
-- updated_at, the current config, and their memory.
CREATE TABLE IF NOT EXISTS channel_versions (
  -- Ledger order across all channels, same reasoning as schedule_offers: two
  -- versions in one millisecond are still two versions in an order.
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  -- Per-channel, counting from 1. What an operator says out loud: "roll adt
  -- back to version 3".
  version INTEGER NOT NULL,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  config TEXT NOT NULL,
  -- How this version came to be: baseline (the state found when versioning
  -- first touched an existing channel), edit, import, rollback, or delete.
  origin TEXT NOT NULL,
  -- Set on a rollback: the version whose content was restored.
  rollback_of INTEGER,
  note TEXT NOT NULL,
  changed_by TEXT NOT NULL,
  changed_at TEXT NOT NULL,
  UNIQUE (tenant_id, channel_id, version)
);

CREATE TABLE IF NOT EXISTS channels (
  tenant_id TEXT NOT NULL DEFAULT 'default',
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  config TEXT NOT NULL,
  last_hash TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- Per tenant. A channel id is chosen by an operator, and "adt" is what
  -- every site calls its admissions feed; a key unique across the platform
  -- would mean the first custodian to use a name took it from everyone else.
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL DEFAULT 'default',
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

CREATE TABLE IF NOT EXISTS message_steps (
  tenant_id TEXT NOT NULL DEFAULT 'default',
  message_id TEXT NOT NULL,
  step_index INTEGER NOT NULL,
  name TEXT NOT NULL,
  output TEXT,
  at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (message_id, step_index)
);

CREATE TABLE IF NOT EXISTS deliveries (
  tenant_id TEXT NOT NULL DEFAULT 'default',
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

CREATE TABLE IF NOT EXISTS fhir_resources (
  tenant_id TEXT NOT NULL DEFAULT 'default',
  resource_type TEXT NOT NULL,
  id TEXT NOT NULL,
  version_id INTEGER NOT NULL,
  json TEXT NOT NULL,
  hash TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- Per tenant, deliberately. Two custodians can hold a patient with the same
  -- id without one overwriting the other, and a resource id is only ever
  -- meaningful inside the custodian that issued it.
  PRIMARY KEY (tenant_id, resource_type, id)
);

CREATE TABLE IF NOT EXISTS fhir_identifiers (
  tenant_id TEXT NOT NULL DEFAULT 'default',
  resource_type TEXT NOT NULL,
  id TEXT NOT NULL,
  system TEXT NOT NULL DEFAULT '',
  value TEXT NOT NULL,
  PRIMARY KEY (tenant_id, resource_type, id, system, value)
);

CREATE TABLE IF NOT EXISTS channel_state (
  tenant_id TEXT NOT NULL DEFAULT 'default',
  channel_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT,
  PRIMARY KEY (tenant_id, channel_id, key)
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
  tenant_id TEXT NOT NULL DEFAULT 'default',
  -- Per tenant, because a client may supply the id on a Subscription.
  id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  criteria TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT 'application/fhir+json',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (tenant_id, id)
);

-- Only the SHA-256 of a key is stored. The key itself is shown once, at issue
-- time, and is unrecoverable afterwards.
CREATE TABLE IF NOT EXISTS api_keys (
  tenant_id TEXT NOT NULL DEFAULT 'default',
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT,
  revoked_at TEXT,
  -- When the key stops working, by the clock rather than by anybody
  -- remembering. Null means it does not expire, which is a choice a caller
  -- has to make rather than the default.
  expires_at TEXT,
  -- Set on the old key when it is rotated, naming its replacement. The two
  -- overlap deliberately: a rotation that cut the old key off at the instant
  -- the new one was issued would take the interface down between issuing and
  -- deploying, which is why rotation gets skipped in practice.
  rotated_to TEXT,
  rotated_at TEXT,
  -- The organization this credential acts for, resolved against the directory
  -- when the key is issued. Null means the credential cannot say, which a
  -- withhold-from-organization directive treats as "possibly the withheld
  -- one" — over-restrictive on purpose rather than permissive by default.
  organization_id TEXT,
  -- The practitioner this credential acts as, resolved against the directory.
  --
  -- Separate from the organization, and the join the audit trail was missing:
  -- clinical stores record an actor ("dr-tetso") and the trail records a
  -- credential, so before this there was no way to ask whether the person who
  -- read a chart had any clinical relationship to that patient. Null for a
  -- system integration, which genuinely acts as no one.
  practitioner_id TEXT
);

-- Access audit trail, hash-chained like message lineage so a row cannot be
-- altered or removed without breaking verification. Carries identifiers and
-- references only, never payloads.
CREATE TABLE IF NOT EXISTS audit_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL DEFAULT 'default',
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
  -- HL7 ActReason code the caller declared. NULL means they declined to say,
  -- which is recorded as such rather than assumed to be treatment.
  purpose_of_use TEXT,
  -- Which organization the caller was acting for. "Who looked" and "which
  -- organization looked" are different questions and a privacy review asks
  -- both; before this column the trail could only answer the first.
  organization_id TEXT,
  -- Which person, where the credential acts as one. This is what makes
  -- "did anybody with no reason to look at this chart look at it" answerable.
  practitioner_id TEXT,
  hash TEXT NOT NULL,
  prev_hash TEXT
);

-- The clinical record.
--
-- Append-only, one row per version. Section 1 requires that nothing clinically
-- material is silently overwritten and that a correction retains the original
-- with its full history — which is a statement about storage, not about
-- discipline. An UPDATE-in-place table cannot satisfy it no matter how
-- carefully it is used, so there is no UPDATE path: an amendment writes a new
-- version pointing at the one it supersedes, and a retraction writes a version
-- marked entered-in-error. The earlier text stays readable, because "what did
-- this chart say when the decision was made" is the question a review asks.
--
-- One table for every kind of entry rather than one per resource type.
-- Problems, allergies, vitals, notes and encounters differ in their content,
-- not in what has to be true about them: each needs an author, a time, a
-- status, a supersession link and a place on the chain. Fifteen tables would
-- be fifteen chances to omit one of those.
--
-- Chained per patient, so a chart is tamper-evident as a whole rather than
-- row by row: removing an entry breaks the next one's back-pointer, and
-- removing the most recent ones is caught by the version counter below.
CREATE TABLE IF NOT EXISTS clinical_entries (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  -- Identity of the version.
  version_id TEXT NOT NULL,
  -- Identity of the record across all its versions. Stable under amendment.
  record_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  entry_type TEXT NOT NULL,
  patient_id TEXT NOT NULL,
  encounter_id TEXT,
  content TEXT NOT NULL,
  -- active | amended | entered-in-error. A superseded version keeps its own
  -- status so history reads as it was, not as it was later judged to be.
  status TEXT NOT NULL DEFAULT 'active',
  -- Who asserted it, and on whose behalf the system was acting.
  author_id TEXT NOT NULL,
  author_kind TEXT NOT NULL,
  -- Where it came from: an interface message id, a clinician, a patient.
  source TEXT,
  source_message_id TEXT,
  -- When it was written down, and when it was clinically true. A vital sign
  -- recorded an hour late belongs at the time it was taken.
  recorded_at TEXT NOT NULL,
  effective_at TEXT,
  supersedes TEXT,
  amendment_reason TEXT,
  -- What makes two messages about the same thing the same record: a business
  -- key derived from the payload's own identifiers. An interface retransmits
  -- constantly, and without this every retransmission would be a new record
  -- rather than the same one said again.
  record_key TEXT,
  hash TEXT NOT NULL,
  prev_hash TEXT
);

-- Work items: the unified inbox.
--
-- Section 8's requirement is that clinically important work must not disappear
-- between people or organizations. Losing a task is not usually a deletion —
-- it is a reassignment to somebody who has left, a completion with nothing to
-- show for it, or an item nobody owns that therefore appears on nobody's list.
-- So current state lives here, where an inbox can be queried quickly, and
-- every transition is written to task_events, which is append-only.
CREATE TABLE IF NOT EXISTS tasks (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  patient_id TEXT,
  encounter_id TEXT,
  -- routine | urgent | stat. Ordering an inbox by arrival alone buries the
  -- one item that mattered under the forty that did not.
  priority TEXT NOT NULL DEFAULT 'routine',
  -- open | in-progress | completed | cancelled. No "deleted".
  status TEXT NOT NULL DEFAULT 'open',
  -- NULL means nobody has it. Deliberately visible rather than absent: an
  -- unowned item is the single most common way work is lost.
  owner_id TEXT,
  due_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT,
  -- What produced it: a result, a referral update, a portal message. Kept so
  -- an item can be reconciled against the interface that raised it.
  source TEXT,
  source_message_id TEXT,
  -- Ties an item to the thing it is about across systems, so a referral and
  -- the consult report that answers it can be recognised as one loop.
  correlation_id TEXT,
  PRIMARY KEY (tenant_id, id)
);

-- Every transition, append-only. Who did what, to whom it went, and why.
CREATE TABLE IF NOT EXISTS task_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  at TEXT NOT NULL,
  event TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  from_owner TEXT,
  to_owner TEXT,
  detail TEXT,
  -- What was actually done, recorded on completion. A task closed with
  -- nothing to show for it is indistinguishable from one abandoned.
  evidence TEXT
);

-- Referrals, as a loop rather than a message.
--
-- Section 9 asks for closed-loop completion reporting, and the failure it
-- guards against is silence: a referral sent to a service that never
-- acknowledged it, or accepted and never reported back, looks exactly like one
-- proceeding normally. Nobody did anything wrong and the patient is not seen.
--
-- So a referral carries an expectation of when the next thing should happen,
-- and anything past it is stalled — a list, not a silence. The lifecycle is
-- here; every transition is appended to referral_events.
CREATE TABLE IF NOT EXISTS referrals (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  patient_id TEXT NOT NULL,
  -- draft | sent | acknowledged | accepted | declined | booked | seen
  -- | reported | closed | cancelled. Declined and cancelled are terminal;
  -- everything else is still owed something.
  status TEXT NOT NULL DEFAULT 'draft',
  priority TEXT NOT NULL DEFAULT 'routine',
  from_service TEXT NOT NULL,
  to_service TEXT NOT NULL,
  -- The directory service this names, when it names one. Three-valued on
  -- purpose: an id means a known service, to_external = 1 means a deliberate
  -- referral out to somewhere Northstar does not hold, and both NULL means
  -- nobody said which — an unverified free-text target, and a different thing
  -- from a declared external one.
  to_service_id TEXT,
  to_external INTEGER,
  -- Why the patient is being referred. A referral without an indication is
  -- one the receiving service cannot triage.
  indication TEXT NOT NULL,
  -- Documents the receiving service requires before it will triage, and what
  -- has actually been attached.
  required_documents TEXT,
  attached_documents TEXT,
  -- When the next step is expected by. Exceeding it is what "stalled" means.
  expected_by TEXT,
  appointment_at TEXT,
  -- Set at close: what came of it. A referral closed with no outcome is
  -- indistinguishable from one abandoned.
  outcome TEXT,
  correlation_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT,
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS referral_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  referral_id TEXT NOT NULL,
  at TEXT NOT NULL,
  event TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  detail TEXT
);

-- Orders placed, and the results that answer them.
--
-- An order that was never resulted and a result nobody acknowledged are the
-- two silences section 4 is about, and they are separate rows because they are
-- separate failures: the first is the lab never reporting, the second is the
-- report arriving and being read by nobody.
CREATE TABLE IF NOT EXISTS orders (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  patient_id TEXT NOT NULL,
  encounter_id TEXT,
  -- lab | imaging | procedure | referral | other
  category TEXT NOT NULL,
  code TEXT NOT NULL,
  code_system TEXT,
  display TEXT NOT NULL,
  -- draft | placed | in-progress | completed | cancelled
  status TEXT NOT NULL DEFAULT 'draft',
  priority TEXT NOT NULL DEFAULT 'routine',
  -- Why it was ordered. An order with no indication cannot be interpreted by
  -- whoever performs it, and cannot be judged appropriate afterwards.
  indication TEXT NOT NULL,
  ordered_by TEXT NOT NULL,
  ordered_at TEXT,
  -- Who reads the result. Not necessarily who ordered it: residents rotate,
  -- and a result routed to somebody who left the service is a result nobody
  -- sees. Nullable only before the order is placed.
  responsible_id TEXT,
  -- When a result is expected. Exceeding it is what "never came back" means.
  expected_by TEXT,
  correlation_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT,
  PRIMARY KEY (tenant_id, id)
);

-- Results, appended and never updated.
--
-- A correction is a new row superseding an earlier one, exactly as the chart
-- works, and this is what makes acknowledgement safe. Acknowledgement is
-- recorded on the row, so it belongs to one reported value and cannot be
-- inherited by a value that replaces it. A potassium of 7.1 correcting a 4.1
-- somebody already signed off arrives unacknowledged, which is the only
-- honest state for it to arrive in.
CREATE TABLE IF NOT EXISTS order_results (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  -- Null for an unsolicited result: one from another facility, or against an
  -- order placed on paper. Common enough that refusing them would lose real
  -- results, so they are kept and queued for matching instead.
  order_id TEXT,
  patient_id TEXT NOT NULL,
  code TEXT NOT NULL,
  code_system TEXT,
  display TEXT NOT NULL,
  value TEXT NOT NULL,
  unit TEXT,
  reference_range TEXT,
  -- normal | low | high | critical-low | critical-high | abnormal
  abnormal_flag TEXT NOT NULL DEFAULT 'normal',
  -- preliminary | final | corrected | cancelled
  result_status TEXT NOT NULL DEFAULT 'final',
  -- The result row this one replaces, if any.
  supersedes TEXT,
  observed_at TEXT,
  reported_at TEXT NOT NULL,
  reported_by TEXT NOT NULL,
  source_message_id TEXT,
  -- Who read it, when, and what they did about it. Null until a person says
  -- so; nothing sets these on anybody's behalf.
  acknowledged_by TEXT,
  acknowledged_at TEXT,
  acknowledgement_action TEXT,
  -- When acknowledgement is owed by, derived from how abnormal it is. A
  -- critical result is on a different clock from a normal one.
  ack_due_by TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

-- Whether orders of a given category actually leave this site, and to whom.
--
-- The third silence, and the earliest one. The orders table records that a
-- clinician placed an order; nothing in it records that the order was sent. A
-- site with no outbound ordering interface — which is every site until one is
-- built and commissioned — marks orders 'placed', shows them on the chart as
-- placed, and lists them as awaiting a result. The laboratory has never heard
-- of them.
--
-- That is worse than the dispense silence it resembles. A prescription with no
-- dispense record may still have been collected; the pharmacy simply may not
-- report. Here *we* are the sender, so the absence is not ambiguous — it is
-- ours, and it is knowable. Refusing to know it is the only way it stays
-- invisible.
--
-- So a route is declared per category, and its absence is a fact with a name
-- rather than an empty column: an order at a site that has declared no route
-- is not "awaiting the lab", it is sitting here.
CREATE TABLE IF NOT EXISTS order_routing (
  tenant_id TEXT NOT NULL,
  -- lab | imaging | procedure | referral | other
  category TEXT NOT NULL,
  -- 1 when an outbound interface exists and orders of this category go out on it.
  transmits INTEGER NOT NULL,
  -- Who receives them. Null when nothing is transmitted.
  destination TEXT,
  -- Where and as whom. All of it is required before an order can actually be
  -- sent, and all of it is checked when the declaration is made rather than
  -- when a clinician presses send: a routing that says it transmits and
  -- cannot is a promise the record makes on behalf of a site that has not
  -- kept it, and the moment it is discovered should not be the moment a
  -- specimen is waiting.
  endpoint_host TEXT,
  endpoint_port INTEGER,
  -- MSH-3/4 and MSH-5/6. Named per route because a site that sends to two
  -- laboratories is known to each of them by whatever they configured.
  sending_application TEXT,
  sending_facility TEXT,
  receiving_application TEXT,
  receiving_facility TEXT,
  -- The clinic's offset, e.g. "-06:00". Never this machine's: a server in one
  -- zone sending for a clinic in another is ordinary in the north.
  timezone_offset TEXT,
  -- Which laboratory profile the message is built against.
  profile_id TEXT,
  -- How, or why not. Read by an operator deciding whether this is expected.
  detail TEXT NOT NULL,
  declared_at TEXT NOT NULL,
  declared_by TEXT NOT NULL,
  PRIMARY KEY (tenant_id, category)
);

-- Every attempt to hand an order to whoever performs it, appended never updated.
--
-- Append-only for the same reason results are: an acknowledgement belongs to
-- the attempt it answered. A retry that overwrote the first attempt would let
-- a rejection be replaced by a later success and leave no trace that the
-- laboratory once refused this requisition, which is exactly the history
-- somebody needs when a specimen arrives against an order the lab does not
-- hold.
CREATE TABLE IF NOT EXISTS order_transmissions (
  -- Whether this attempt carried the order or its cancellation. One table
  -- because they are the same event with opposite meaning, and separating
  -- them would let a site answer "is this order with them?" without noticing
  -- that the cancellation never arrived.
  kind TEXT NOT NULL DEFAULT 'order',
  -- Ordering is the whole safety property here, so it does not rest on a
  -- timestamp. Two attempts in the same millisecond — a send and the
  -- acknowledgement that answers it, which is the ordinary case on a fast
  -- link — would otherwise fall back to a tiebreak on a random id, and the
  -- superseding attempt would be whichever uuid happened to sort last. That
  -- reports a rejected order as acknowledged about half the time.
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  -- sent | acknowledged | rejected | failed
  outcome TEXT NOT NULL,
  destination TEXT NOT NULL,
  -- MSH-10 of the message handed over, so an acknowledgement can be matched.
  control_id TEXT,
  detail TEXT NOT NULL,
  at TEXT NOT NULL,
  by TEXT NOT NULL,
  UNIQUE (tenant_id, id)
);

-- Laboratory results whose patient could not be identified.
--
-- The alternative to this table is a fallback match, and every fallback match
-- available here is wrong in the case that matters: on name, on the only
-- patient with that surname, on the most recent order. A result on the wrong
-- chart is the worst outcome the orders module has, so identity is resolved by
-- identifier or not at all — and "not at all" has to land somewhere a person
-- looks, or refusing to guess would just be losing the result more politely.
--
-- The whole message is kept, so resolving one re-files it through the ordinary
-- path rather than through a second set of rules.
CREATE TABLE IF NOT EXISTS lab_identity_holds (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  source_message_id TEXT,
  message_control_id TEXT NOT NULL,
  sending_facility TEXT NOT NULL,
  -- What the laboratory said, kept so a person can see who it thought this
  -- was. Never matched on.
  identifiers TEXT NOT NULL,
  patient_name TEXT NOT NULL,
  patient_birth_date TEXT NOT NULL,
  placer_order_number TEXT NOT NULL,
  filler_order_number TEXT NOT NULL,
  reason TEXT NOT NULL,
  payload TEXT NOT NULL,
  received_at TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by TEXT,
  resolved_patient_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS order_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  at TEXT NOT NULL,
  event TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  detail TEXT
);

-- What the patient is taking, and what they react to.
--
-- Both are appended and never updated, because both are claims made by
-- somebody at a time, and the previous claim stays true about that moment. A
-- medication list is not a set of current facts; it is a history of assertions
-- about what a person is taking, and the difference shows up the moment two
-- sources disagree.
CREATE TABLE IF NOT EXISTS medication_statements (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  patient_id TEXT NOT NULL,
  encounter_id TEXT,
  code TEXT NOT NULL,
  code_system TEXT,
  display TEXT NOT NULL,
  -- The ingredient or class, for duplicate-therapy checking. Two brands of
  -- the same drug from two prescribers is a real and common way to double a
  -- dose.
  ingredient TEXT,
  dose TEXT,
  route TEXT,
  frequency TEXT,
  -- prescribed | patient-reported | pharmacy-dispense | reconciled |
  -- external-record. Provenance is not decoration here: "the prescription
  -- exists" and "the patient is taking it" are different claims, and a list
  -- that cannot tell them apart is the commonest medication error there is.
  source TEXT NOT NULL,
  -- active | completed | stopped | on-hold | entered-in-error
  status TEXT NOT NULL DEFAULT 'active',
  -- taking | not-taking | taking-differently | unknown. Separate from status,
  -- because a prescription can be active while the patient stopped it months
  -- ago and told nobody.
  adherence TEXT NOT NULL DEFAULT 'unknown',
  indication TEXT,
  prescriber_id TEXT,
  -- Required to stop a medication. A drug that vanishes with no reason is
  -- indistinguishable from one deleted by accident.
  stop_reason TEXT,
  effective_from TEXT,
  effective_to TEXT,
  -- The statement this one replaces. A dose change is a new row.
  supersedes TEXT,
  asserted_by TEXT NOT NULL,
  asserted_at TEXT NOT NULL,
  source_message_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

-- Getting a prescription to a pharmacy, and knowing whether it arrived.
--
-- A prescription recorded and then not sent anywhere is the failure here: the
-- pharmacy writes it again at their end, and two records of one decision drift
-- apart from the moment they are made.
--
-- The statuses exist to keep three things apart that otherwise look identical
-- in a chart: transmitted and waiting, deliberately printed and handed to the
-- patient, and never sent at all. The third is the one a patient discovers at
-- the counter, so it has a queue of its own.
CREATE TABLE IF NOT EXISTS prescriptions (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  -- The medication statement this prescribes. Taken rather than restated, so
  -- the prescription and the medication list cannot disagree about the drug.
  statement_id TEXT NOT NULL,
  patient_id TEXT NOT NULL,
  -- The directory organization it went to. Null until it goes anywhere.
  pharmacy_id TEXT,
  -- draft | transmitted | acknowledged | handed-out | failed | cancelled
  status TEXT NOT NULL DEFAULT 'draft',
  -- Written for the patient to follow, not for a pharmacy's parser.
  instructions TEXT NOT NULL,
  -- 1 for a narcotic or controlled drug. Electronic transmission of one is
  -- separately regulated, so it is refused unless the deployment declares the
  -- authority it holds — and the declaration is kept here where an audit can
  -- read it.
  controlled INTEGER NOT NULL DEFAULT 0,
  controlled_authority TEXT,
  prescriber_id TEXT NOT NULL,
  written_at TEXT NOT NULL,
  transmitted_at TEXT,
  -- The message the transmission became, so it can be traced to a delivery,
  -- a retry and a dead letter like any other clinical message.
  message_id TEXT,
  acknowledged_at TEXT,
  acknowledged_by TEXT,
  -- When the pharmacy's acknowledgement is owed by. "We sent it" is not
  -- "they got it", and the gap is where a patient waits at a counter.
  ack_due_by TEXT,
  failure_reason TEXT,
  cancelled_at TEXT,
  cancel_reason TEXT,
  -- The failed prescription this one replaces. The only safe retry: a
  -- pharmacy receiving the same prescription twice may dispense it twice.
  replaces TEXT,
  -- Whether the pharmacy reported dispenses *at the moment this was sent*.
  -- Snapshotted rather than read live, because a declaration made next year
  -- says nothing about what this prescription's silence meant last week.
  dispense_reporting INTEGER,
  -- The safety check that ran when this was written, as it was shown to the
  -- prescriber: allergy status, findings, and anything signed past. A
  -- pharmacist doing their own check needs to know what this one saw.
  safety_summary TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS prescription_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  prescription_id TEXT NOT NULL,
  at TEXT NOT NULL,
  event TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  detail TEXT
);

-- What the pharmacy did with it.
--
-- "Prescribed" and "dispensed" are different facts, and a chart that cannot
-- tell them apart is misleading in the direction that causes harm: a
-- medication the patient never collected is not a medication they are taking,
-- and it reads as one on every screen that shows the prescription alone.
--
-- A log rather than a status, because a 90-day prescription filled 30 days at
-- a time is three dispenses of one decision, and the last one is what says
-- whether the patient still has any.
CREATE TABLE IF NOT EXISTS prescription_dispenses (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  prescription_id TEXT NOT NULL,
  patient_id TEXT NOT NULL,
  -- dispensed | partially-dispensed | not-collected
  --
  -- not-collected is a fact a pharmacy reports when it returns a prescription
  -- to stock, and it is the one worth having: it turns an absence into a
  -- statement somebody can act on.
  outcome TEXT NOT NULL,
  -- When the pharmacy says it happened, which is not when we heard.
  dispensed_at TEXT NOT NULL,
  quantity TEXT,
  days_supply INTEGER,
  reported_at TEXT NOT NULL,
  reported_by TEXT NOT NULL,
  source_message_id TEXT,
  detail TEXT,
  PRIMARY KEY (tenant_id, id)
);

-- Whether a pharmacy tells us what it dispensed.
--
-- The load-bearing table for the honesty of everything above. Without a
-- declaration, no dispense record means *we do not know* whether the patient
-- collected it — not that they did not. Treating silence as non-collection
-- would put "never collected" against every prescription sent to a pharmacy
-- that simply does not send notifications, and a list that is wrong that
-- often is a list nobody reads.
CREATE TABLE IF NOT EXISTS pharmacy_dispense_reporting (
  tenant_id TEXT NOT NULL,
  pharmacy_id TEXT NOT NULL,
  reports INTEGER NOT NULL,
  declared_at TEXT NOT NULL,
  declared_by TEXT NOT NULL,
  PRIMARY KEY (tenant_id, pharmacy_id)
);

-- Allergies and intolerances, including the assertion that there are none.
--
-- The distinction this table exists for: an empty allergy list because nobody
-- asked, and an empty one because somebody asked and the answer was none, are
-- clinically opposite and render identically in most systems. A check run
-- against the first returns "no interactions found", which is a reassuring
-- answer to a question that was never put. So "no known allergies" is a row —
-- an assertion with an author and a time — and its absence means nobody has
-- asked.
CREATE TABLE IF NOT EXISTS allergies (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  patient_id TEXT NOT NULL,
  -- Null on a no-known-allergies assertion, which is the whole point of it.
  code TEXT,
  code_system TEXT,
  display TEXT,
  ingredient TEXT,
  -- allergy | intolerance | no-known-allergies
  kind TEXT NOT NULL DEFAULT 'allergy',
  -- low | high | unable-to-assess. Anaphylaxis and a rash are not the same
  -- contraindication.
  criticality TEXT NOT NULL DEFAULT 'unable-to-assess',
  reaction TEXT,
  -- active | resolved | entered-in-error
  status TEXT NOT NULL DEFAULT 'active',
  supersedes TEXT,
  asserted_by TEXT NOT NULL,
  asserted_at TEXT NOT NULL,
  source_message_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

-- Medication reconciliation at a transition of care.
--
-- Admission, transfer and discharge are where lists diverge, and a
-- reconciliation that was started and never finished is worse than none: the
-- chart shows the work was done.
CREATE TABLE IF NOT EXISTS med_reconciliations (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  patient_id TEXT NOT NULL,
  encounter_id TEXT,
  -- admission | transfer | discharge | ambulatory-review
  transition TEXT NOT NULL,
  -- open | completed | abandoned
  status TEXT NOT NULL DEFAULT 'open',
  started_by TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_by TEXT,
  completed_at TEXT,
  abandon_reason TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

-- One line of a reconciliation: a medication, and what was decided about it.
CREATE TABLE IF NOT EXISTS med_reconciliation_items (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  reconciliation_id TEXT NOT NULL,
  statement_id TEXT,
  display TEXT NOT NULL,
  -- What the two sides said, so the discrepancy is on the record rather than
  -- only its resolution.
  prior TEXT,
  proposed TEXT,
  -- continue | stop | modify | start | unresolved
  decision TEXT NOT NULL DEFAULT 'unresolved',
  reason TEXT,
  decided_by TEXT,
  decided_at TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS medication_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  patient_id TEXT NOT NULL,
  statement_id TEXT,
  at TEXT NOT NULL,
  event TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  detail TEXT,
  -- Set when a prescriber signed past a safety finding. The override and its
  -- reason are the record that the warning was seen, which is the only thing
  -- that distinguishes a considered decision from a reflex click.
  overrides TEXT
);

-- Who may see a patient's record besides the patient.
--
-- Delegated authority is the part of patient access that goes wrong quietly.
-- A parent's access to a child's chart is correct until a birthday and wrong
-- afterwards, and nothing about that day generates an event: the grant simply
-- keeps working. A substitute decision-maker's authority ends when capacity
-- returns, and an ex-spouse's should have ended at a date somebody wrote down
-- once and nobody enforced.
--
-- So authority is time-bounded by construction: expires_at is set at grant
-- rather than reviewed later, and the check is against the clock rather than
-- against a status somebody has to remember to change.
CREATE TABLE IF NOT EXISTS patient_authority (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  patient_id TEXT NOT NULL,
  -- The person exercising the access: the patient themselves, or a proxy.
  subject_id TEXT NOT NULL,
  -- self | parent-guardian | substitute-decision-maker | representative
  relationship TEXT NOT NULL,
  -- full | summary. A proxy is often entitled to less than the patient is.
  extent TEXT NOT NULL DEFAULT 'full',
  -- Explicit capability list. JSON array of summary, results, appointments,
  -- messages, access-log, requests, delegates. Null only on legacy rows,
  -- which the store interprets narrowly.
  permissions TEXT,
  -- Why the delegated access exists. Scope, purpose and expiry are three
  -- separate decisions and a review needs all three.
  purpose TEXT,
  -- Null only for the patient's own access. Every delegated grant has an end,
  -- because the failure being guarded against is one that never ends.
  expires_at TEXT,
  -- Set when withdrawn early, with who and why.
  revoked_at TEXT,
  revoked_by TEXT,
  revoke_reason TEXT,
  granted_by TEXT NOT NULL,
  granted_at TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

-- Clinic-attested enrolment: binding an OAuth subject to a chart.
--
-- This is not identity-proofing and not ONE ID. A named person at the clinic
-- writes, in their own words, how they checked that the person in front of
-- them is the patient (or proxy) on the chart. The grant that follows is the
-- same patient_authority row the boundary already uses. A pending row is not
-- authority. GET /me does not enrol anyone.
CREATE TABLE IF NOT EXISTS patient_enrolments (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  patient_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  -- self | parent-guardian | substitute-decision-maker | representative
  relationship TEXT NOT NULL,
  -- pending | attested | declined
  status TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  requested_kind TEXT NOT NULL,
  -- Written method of verification. Required to attest; null while pending.
  method TEXT,
  attested_at TEXT,
  attested_by TEXT,
  declined_at TEXT,
  declined_by TEXT,
  decline_reason TEXT,
  authority_id TEXT,
  purpose TEXT,
  permissions TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

-- A notice the patient is owed, published onto a channel the deployment
-- already uses to reach people. Northstar does not know phone numbers or
-- inboxes and will not invent them. Dispatching is handing the fact to the
-- delivery machinery; recording that the patient was told is a separate act.
-- Kinds: enrolment-attested | result-released | request-completed.
CREATE TABLE IF NOT EXISTS patient_notices (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  patient_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  about_id TEXT,
  -- The fact, never a result value or a chart excerpt.
  summary TEXT NOT NULL,
  -- queued | dispatched | failed | told
  status TEXT NOT NULL,
  dispatched_at TEXT,
  message_id TEXT,
  error TEXT,
  told_at TEXT,
  told_by TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

-- When a result may be shown to the patient, and why it is being held.
--
-- Immediate release is the default and the right one: a patient waiting a week
-- for a normal result while their clinician's inbox fills is the harm the
-- information-blocking rules exist to stop. But "immediate" applied without
-- exception means a person can learn they have cancer from a phone at 11pm
-- with nobody to ask, and a system that cannot express that has not solved the
-- problem, it has picked the other side of it.
--
-- So a hold is possible, bounded, reasoned, attributed, and visible. It is not
-- a silent delay: the patient sees that something is being held and when it
-- will lift, because a portal that shows nothing is indistinguishable from one
-- where nothing has come back.
CREATE TABLE IF NOT EXISTS result_release (
  tenant_id TEXT NOT NULL,
  result_id TEXT NOT NULL,
  patient_id TEXT NOT NULL,
  -- immediate | held
  state TEXT NOT NULL DEFAULT 'immediate',
  -- Required for a hold, and shown to the patient as a category rather than as
  -- free text: "your clinician will discuss this with you" is honest and does
  -- not require the patient to read a clinical justification about themselves.
  hold_reason TEXT,
  hold_category TEXT,
  -- Every hold ends. A hold with no end is a result withheld indefinitely,
  -- which is the practice the release rules were written against.
  release_at TEXT,
  held_by TEXT,
  held_at TEXT,
  released_by TEXT,
  released_at TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, result_id)
);

-- Everything a patient or their proxy did, kept apart from the clinical trail.
--
-- The same events reach audit_events; this is the patient-facing view of their
-- own access history, which section 11 requires them to be able to see.
CREATE TABLE IF NOT EXISTS patient_access_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  patient_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  relationship TEXT NOT NULL,
  at TEXT NOT NULL,
  action TEXT NOT NULL,
  resource TEXT,
  outcome TEXT NOT NULL,
  detail TEXT
);

-- Requests made through the patient boundary. The request is durable data;
-- the task is the clinic's work to answer it. Keeping both lets the patient
-- see what they asked while the unified inbox keeps it from disappearing.
CREATE TABLE IF NOT EXISTS patient_requests (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  patient_id TEXT NOT NULL,
  -- access | correction
  kind TEXT NOT NULL,
  target TEXT,
  detail TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'submitted',
  submitted_by TEXT NOT NULL,
  relationship TEXT NOT NULL,
  submitted_at TEXT NOT NULL,
  task_id TEXT NOT NULL,
  completed_at TEXT,
  outcome TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS patient_request_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  at TEXT NOT NULL,
  event TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  detail TEXT
);

-- Appointment slots, and the bookings that hold them.
--
-- The one thing a scheduler must never do is give the same slot to two
-- patients, and check-then-insert cannot promise that: between reading "free"
-- and writing "booked" another booking fits, and the window is exactly as wide
-- as the gap between two statements. Under a real clinic — two clerks, a
-- portal and an inbound HL7 SIU feed — that window is hit.
--
-- So the promise is a uniqueness constraint rather than a code path. The
-- partial index below permits many cancelled bookings against a slot and
-- exactly one live booking, which means a double-book is refused by the
-- database whatever the caller does. Deliberate overbooking is expressed by
-- declaring a slot with capacity, not by defeating the constraint: making
-- overbooking impossible is how a scheduler gets routed around, and a clinic
-- that overbooks in a paper diary is worse off than one that overbooks here.
CREATE TABLE IF NOT EXISTS schedule_slots (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  -- Whose diary. A clinician, a room, a scanner.
  resource_id TEXT NOT NULL,
  resource_kind TEXT NOT NULL DEFAULT 'practitioner',
  service TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  -- How many bookings this slot admits. One unless a clinic has decided
  -- otherwise, in the open and with a number.
  capacity INTEGER NOT NULL DEFAULT 1,
  -- open | blocked. Blocked is leave, a meeting, a machine down for service:
  -- a slot that exists and must not be booked, which is different from one
  -- that does not exist.
  status TEXT NOT NULL DEFAULT 'open',
  block_reason TEXT,
  -- The travelling-clinic visit this slot belongs to, when it was planned as
  -- part of one. Null for a slot opened on its own, which stays the ordinary
  -- case; nothing downstream needs to know visits exist.
  visit_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS schedule_bookings (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  slot_id TEXT NOT NULL,
  patient_id TEXT NOT NULL,
  -- Which position in the slot this booking holds: 0 for a normal slot, and
  -- 0..capacity-1 where a clinic has chosen to overbook. Part of the unique
  -- index, so the constraint counts rather than merely forbids.
  seat INTEGER NOT NULL DEFAULT 0,
  -- booked | attended | did-not-attend | cancelled
  status TEXT NOT NULL DEFAULT 'booked',
  -- Why the patient is coming. A booking with no reason cannot be triaged if
  -- the clinic has to cut the list.
  reason TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'routine',
  -- The referral or order this appointment answers, so a missed appointment
  -- reaches the loop that is waiting on it.
  correlation_id TEXT,
  referral_id TEXT,
  booked_by TEXT NOT NULL,
  booked_at TEXT NOT NULL,
  cancelled_by TEXT,
  cancelled_at TEXT,
  cancel_reason TEXT,
  outcome_at TEXT,
  outcome_by TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS schedule_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  booking_id TEXT NOT NULL,
  at TEXT NOT NULL,
  event TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  detail TEXT
);

-- A travelling clinic's visit: a block of slots planned, moved and cancelled
-- as one thing. A specialist flying into a community for two days a month is
-- the northern scheduling primitive, and without this it is twenty
-- hand-created slots that can only be cancelled one at a time — leaving
-- twenty orphaned cancellations with no record that the plane was the cause.
CREATE TABLE IF NOT EXISTS schedule_visits (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  resource_kind TEXT NOT NULL,
  service TEXT NOT NULL,
  -- Where the visit happens, in words a patient recognises. What makes
  -- "next available" honest: an offer that crosses communities has to be able
  -- to say so, and it cannot if nothing records where the seats are.
  community TEXT NOT NULL,
  starts_on TEXT NOT NULL,
  ends_on TEXT NOT NULL,
  -- planned | cancelled. A cancelled visit keeps its rows: the fact that a
  -- clinic was supposed to run is what a capacity report is made of.
  status TEXT NOT NULL DEFAULT 'planned',
  cancelled_at TEXT,
  cancelled_by TEXT,
  cancel_reason TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

-- Who is waiting for a service, in an order that is policy rather than
-- accident. The row keeps when they first asked and how many times a
-- cancelled visit has bumped them, because both are inputs to who gets the
-- next seat and neither survives being kept in somebody's head.
CREATE TABLE IF NOT EXISTS schedule_waitlist (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  service TEXT NOT NULL,
  patient_id TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'routine',
  reason TEXT NOT NULL,
  -- The community the patient is in, when known, so an offer that would send
  -- them 900 km can be seen to before the phone call rather than during it.
  community TEXT,
  referral_id TEXT,
  -- waiting | offered | booked | removed
  status TEXT NOT NULL DEFAULT 'waiting',
  -- How many cancelled visits have taken a booked seat back off this person.
  -- Never reset: a patient bumped three times is a fact about the service,
  -- not a counter to tidy.
  bump_count INTEGER NOT NULL DEFAULT 0,
  added_by TEXT NOT NULL,
  added_at TEXT NOT NULL,
  removed_at TEXT,
  removed_by TEXT,
  removed_reason TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

-- One offer of one seat to one waiting patient, and what came of it.
-- "Unreachable" is a real outcome in a community with one phone line and is
-- not the same fact as "declined"; a schedule that collapses them punishes
-- people for where they live.
CREATE TABLE IF NOT EXISTS schedule_offers (
  -- The ledger order. Two offers made in the same millisecond are still two
  -- offers made in an order, and a history sorted by a timestamp presents
  -- them in whichever order the sort happened to leave them — an accident of
  -- insertion order in the one module written against those.
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  waitlist_id TEXT NOT NULL,
  slot_id TEXT NOT NULL,
  -- Where the offered seat is, in words, recorded at offer time so the
  -- conversation with the patient starts from the truth.
  place TEXT NOT NULL,
  made_by TEXT NOT NULL,
  made_at TEXT NOT NULL,
  -- accepted | declined | unreachable, null while the offer is out.
  outcome TEXT,
  outcome_at TEXT,
  outcome_by TEXT,
  note TEXT,
  UNIQUE (tenant_id, id)
);

-- A visit: the thing clinical work actually happens inside.
--
-- Orders, medication statements, reconciliations and notes have carried an
-- encounter_id since they were written, and until now no table owned one. The
-- column was a reference to a thing the system could not describe, so "what
-- happened at this visit" had no answer except a time-window guess across four
-- stores, and a discharge summary had nothing to summarise.
--
-- Kept separate from the append-only clinical record on purpose. An Encounter
-- entry there is a document about a visit; this is the visit, and the
-- difference matters when the question is which orders belong to it.
CREATE TABLE IF NOT EXISTS encounters (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  patient_id TEXT NOT NULL,
  -- in-person | virtual | telephone | home-visit. How the patient was seen,
  -- not where: a telephone review and a clinic visit generate different
  -- records and a chart that cannot tell them apart is misleading about what
  -- was examined.
  class TEXT NOT NULL,
  -- planned | in-progress | finished | cancelled.
  status TEXT NOT NULL DEFAULT 'planned',
  reason TEXT NOT NULL,
  location TEXT,
  -- The booking this arose from, where it arose from one. Nullable because a
  -- walk-in is a real encounter and was never booked.
  booking_id TEXT,
  started_at TEXT,
  ended_at TEXT,
  -- What was decided. Stored rather than derived from status, because
  -- "finished" says the visit ended and says nothing about how.
  disposition TEXT,
  opened_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

-- Who was there, and as what.
--
-- A role per row rather than a column on the encounter, because a visit has a
-- clinician and an interpreter and sometimes a family member, and flattening
-- that into "provider_id" loses the interpreter — who is exactly the person a
-- later reader needs to know was present.
CREATE TABLE IF NOT EXISTS encounter_participants (
  tenant_id TEXT NOT NULL,
  encounter_id TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  participant_kind TEXT NOT NULL,
  role TEXT NOT NULL,
  joined_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, encounter_id, participant_id, role)
);

CREATE TABLE IF NOT EXISTS encounter_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  encounter_id TEXT NOT NULL,
  at TEXT NOT NULL,
  event TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  detail TEXT
);

-- Who and what the system talks about: practitioners, organizations,
-- locations, the services they provide, and who holds which role where.
--
-- Before this, a scheduler slot named "dr-tetso" and a referral named
-- "Stanton Orthopaedics", and neither string resolved to anything. The system
-- could not say whether that person existed, was licensed, worked here, or was
-- the same dr-tetso who received a referral last week.
--
-- Effective-dated rather than deleted. A clinic that closes must not break the
-- referral sent to it in 2024, and a practitioner who leaves must not vanish
-- from the visits they attended — so a directory entry is retired by setting
-- active_to, and history keeps resolving.
CREATE TABLE IF NOT EXISTS directory_practitioners (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  family TEXT NOT NULL,
  given TEXT,
  prefix TEXT,
  active_from TEXT NOT NULL,
  active_to TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

-- Organization is NOT tenancy. Several organizations operate inside one
-- custodian's tenant, and conflating them would make a
-- withhold-from-organization directive useless in exactly the deployment that
-- needs it: a patient withholding from one clinic would withhold from the
-- whole territory.
CREATE TABLE IF NOT EXISTS directory_organizations (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT,
  part_of TEXT,
  active_from TEXT NOT NULL,
  active_to TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS directory_locations (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  organization_id TEXT,
  address TEXT,
  -- The community, which in the north is the thing a clinician actually needs
  -- when deciding whether an appointment is reachable.
  community TEXT,
  active_from TEXT NOT NULL,
  active_to TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS directory_services (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  organization_id TEXT,
  location_id TEXT,
  category TEXT,
  active_from TEXT NOT NULL,
  active_to TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

-- What a practitioner does, where, and for whom. Separate from the
-- practitioner because one person holds several: a locum at two clinics is one
-- practitioner and two roles, and flattening that loses which hat they were
-- wearing.
CREATE TABLE IF NOT EXISTS directory_roles (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  practitioner_id TEXT NOT NULL,
  organization_id TEXT,
  location_id TEXT,
  service_id TEXT,
  role TEXT NOT NULL,
  specialty TEXT,
  active_from TEXT NOT NULL,
  active_to TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

-- Licence numbers, provider numbers, facility identifiers. First-class rather
-- than a name string, because a name is not an identity and the join to a
-- credential (#17) has to be on something that is.
CREATE TABLE IF NOT EXISTS directory_identifiers (
  tenant_id TEXT NOT NULL,
  party_kind TEXT NOT NULL,
  party_id TEXT NOT NULL,
  system TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (tenant_id, party_kind, party_id, system, value)
);

-- Who is responsible for this patient, and in what role. Effective-dated:
-- a locum covering a month is not the MRP, and retiring the MRP must not
-- erase that they were the MRP. The directory says who the person is; this
-- says they belong on this chart.
CREATE TABLE IF NOT EXISTS care_team (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  patient_id TEXT NOT NULL,
  practitioner_id TEXT NOT NULL,
  organization_id TEXT,
  role TEXT NOT NULL,
  active_from TEXT NOT NULL,
  active_to TEXT,
  asserted_by TEXT NOT NULL,
  asserted_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

-- Provincial coverage and eligibility. A health-card number is also an
-- identifier on the patient; this is the claim about whether it is currently
-- good, which changes independently of who the patient is. New rows supersede
-- old ones; nothing is updated in place.
CREATE TABLE IF NOT EXISTS coverage (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  patient_id TEXT NOT NULL,
  plan TEXT NOT NULL,
  identifier_system TEXT,
  identifier_value TEXT,
  eligibility TEXT NOT NULL,
  eligibility_detail TEXT,
  effective_from TEXT,
  effective_to TEXT,
  supersedes TEXT,
  asserted_by TEXT NOT NULL,
  asserted_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

-- Correspondence between a patient and the clinic.
--
-- Not the integration messages table, and not a portal. A thread is the
-- durable record of a question; closing it needs a reason so a click is
-- not indistinguishable from an answer. Nothing is deleted.
CREATE TABLE IF NOT EXISTS patient_threads (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  patient_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  -- awaiting-clinic | awaiting-patient | closed
  status TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'routine',
  owner_id TEXT,
  opened_by TEXT NOT NULL,
  opened_kind TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  closed_at TEXT,
  closed_by TEXT,
  close_reason TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS patient_messages (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  patient_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  -- patient | proxy | practitioner | clerk
  author_kind TEXT NOT NULL,
  body TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS patient_thread_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  at TEXT NOT NULL,
  event TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  detail TEXT
);

-- A patient's instruction about who may see their record.
--
-- Provincial EHRs call this a consent directive or a lockbox: a patient may
-- withhold their record from a provider, or from a class of provider, and the
-- system must honour it. The instruction is a clinical fact about the patient
-- (they do not want this person reading this), and it lives here rather than
-- in a configuration file for the same reason allergies do.
--
-- Every directive is overridable in an emergency, because a patient
-- unconscious in a resuscitation room cannot lift their own lockbox and a
-- system that made it impossible would kill somebody. What makes that safe is
-- not the difficulty of the override; it is that overriding is loud. See
-- break_glass below.
CREATE TABLE IF NOT EXISTS consent_directives (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  patient_id TEXT NOT NULL,
  -- withhold-from-provider | withhold-from-organization | withhold-all
  kind TEXT NOT NULL,
  -- Who is being withheld from. Null on withhold-all, which is the blanket
  -- instruction: nobody outside the circle of care that created a record.
  target_id TEXT,
  -- Optional narrowing: only these entry types are withheld. Null means the
  -- whole record.
  scope TEXT,
  -- The patient's own words, kept because a directive without a reason is one
  -- a reviewer cannot weigh against an emergency.
  reason TEXT,
  -- active | revoked | expired
  status TEXT NOT NULL DEFAULT 'active',
  effective_from TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT,
  revoked_by TEXT,
  recorded_by TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

-- Emergency access taken past a directive.
--
-- The row that makes a lockbox real. An override with no record is
-- indistinguishable from no lockbox at all, and worse than none: everybody
-- learns that breaking glass costs nothing, and the directive becomes a
-- formality that slows down honest people and stops nobody.
--
-- So an override is declared before it is taken, carries a reason in the
-- clinician's own words, notifies the patient, and lands in a queue somebody
-- reviews. All four, because dropping any one of them turns the other three
-- into paperwork.
CREATE TABLE IF NOT EXISTS break_glass (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  patient_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  subject_kind TEXT NOT NULL,
  -- The directive that was overridden, where there was one.
  directive_id TEXT,
  -- Why, in the clinician's own words. Not a dropdown: "unconscious, no
  -- collateral history, need allergy status before induction" is a defence
  -- and "emergency" is not.
  reason TEXT NOT NULL,
  purpose_of_use TEXT,
  declared_at TEXT NOT NULL,
  -- How long this override is good for. An override that never ends is a
  -- permission, and this is not one.
  expires_at TEXT NOT NULL,
  -- Set when somebody has reviewed it. Unreviewed overrides are the queue.
  reviewed_at TEXT,
  reviewed_by TEXT,
  review_outcome TEXT,
  -- Whether the patient has been told, which is not optional.
  --
  -- Three separate facts, deliberately not collapsed into one. "We sent it"
  -- (notice_dispatched_at, with the message it became) and "we know they were
  -- told" (patient_notified_at) are different claims, and a portal message
  -- that bounced is neither. notice_error is why nothing was sent, so a
  -- notice that could not be addressed is a visible refusal rather than a row
  -- that silently looks the same as one nobody has got to yet.
  patient_notified_at TEXT,
  notice_dispatched_at TEXT,
  notice_message_id TEXT,
  notice_error TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

-- Loading a caseload out of an incumbent system.
--
-- What makes migration dangerous is that you cannot tell whether it worked by
-- whether it errored. A run that loads 96% of the allergies and reports
-- success is the catastrophe: no error anywhere, plausible counts, clinicians
-- at work, and the missing 4% invisible until somebody prescribes into a gap.
--
-- So completeness is declared and then checked, not inferred from the absence
-- of exceptions. migration_declarations holds what the source system says it
-- has; the report compares.
CREATE TABLE IF NOT EXISTS migration_runs (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  source_system TEXT NOT NULL,
  -- trial | cutover | delta. A trial is disposable, which is the only way
  -- anybody finds the mapping errors. A cutover is not.
  mode TEXT NOT NULL,
  -- open | completed | rolled-back | abandoned
  status TEXT NOT NULL DEFAULT 'open',
  started_by TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  -- The run a delta follows, so a delta cannot sit on top of a rollback.
  follows TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

-- One row per source record, whatever happened to it.
--
-- The payload is kept even on success, because a migrated record that cannot
-- be traced back to the row it came from cannot be checked against the source
-- system — and checking against the source is the only way a mapping error is
-- ever found. On a rejection it is the difference between "37 allergies
-- failed" and 37 rows somebody can open.
CREATE TABLE IF NOT EXISTS migration_records (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  source_system TEXT NOT NULL,
  -- Stable in the source. With record_type and source_system this is the
  -- idempotency key: a resumed run or an unchanged delta row writes nothing.
  source_id TEXT NOT NULL,
  record_type TEXT NOT NULL,
  -- The chart entry or statement it became. Null on a rejection.
  target_id TEXT,
  patient_id TEXT,
  -- loaded | unchanged | rejected
  outcome TEXT NOT NULL,
  reason TEXT,
  payload TEXT NOT NULL,
  loaded_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

-- What the source system says it holds. Without this the report can count what
-- arrived and cannot say whether that is all of it.
CREATE TABLE IF NOT EXISTS migration_declarations (
  tenant_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  record_type TEXT NOT NULL,
  source_count INTEGER NOT NULL,
  declared_by TEXT NOT NULL,
  declared_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, run_id, record_type)
);

-- Privacy office: reviews, holds, incidents, disclosures, assurance.
--
-- The audit trail records and proves. These tables are what a privacy office
-- actually runs — queues, clocks, holds that stop a sweep, and an assurance
-- catalogue that cannot close a finding by forgetting it. A chain nobody
-- reads proves only that nobody tampered with a log nobody reads.

CREATE TABLE IF NOT EXISTS privacy_reviews (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  -- open | closed. Never deleted.
  status TEXT NOT NULL DEFAULT 'open',
  patient_id TEXT,
  principal_id TEXT,
  since TEXT NOT NULL,
  conclusion TEXT,
  opened_by TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  closed_by TEXT,
  closed_at TEXT,
  task_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS privacy_review_events (
  tenant_id TEXT NOT NULL,
  review_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  at TEXT NOT NULL,
  event TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  detail TEXT,
  PRIMARY KEY (tenant_id, review_id, seq)
);

CREATE TABLE IF NOT EXISTS privacy_flags (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  review_id TEXT NOT NULL,
  -- after-hours | high-volume | high-volume-repeat | not-on-care-team |
  -- break-glass-unreviewed | sar-overdue | access-without-disclosure
  kind TEXT NOT NULL,
  patient_id TEXT,
  principal_id TEXT,
  principal_kind TEXT,
  detail TEXT NOT NULL,
  -- open | accepted | escalated
  status TEXT NOT NULL DEFAULT 'open',
  addressed_at TEXT,
  addressed_by TEXT,
  address_reason TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

-- A hold with a null patient_id is tenant-wide. Messages are not patient-keyed,
-- so any active hold on the tenant blocks the whole retention sweep.
CREATE TABLE IF NOT EXISTS legal_holds (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  patient_id TEXT,
  reason TEXT NOT NULL,
  placed_by TEXT NOT NULL,
  placed_at TEXT NOT NULL,
  released_at TEXT,
  released_by TEXT,
  release_reason TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS privacy_incidents (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  -- open | closed
  status TEXT NOT NULL DEFAULT 'open',
  what_happened TEXT NOT NULL,
  -- JSON array of patient ids. Empty only when none_affected is 1.
  affected_patients TEXT NOT NULL DEFAULT '[]',
  none_affected INTEGER NOT NULL DEFAULT 0,
  -- told | not-told. Null while open.
  notification TEXT,
  notification_reason TEXT,
  opened_by TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  closed_by TEXT,
  closed_at TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS privacy_incident_events (
  tenant_id TEXT NOT NULL,
  incident_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  at TEXT NOT NULL,
  event TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  detail TEXT,
  PRIMARY KEY (tenant_id, incident_id, seq)
);

-- Section names and counts, never a second copy of the chart.
CREATE TABLE IF NOT EXISTS privacy_disclosures (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  patient_id TEXT NOT NULL,
  request_id TEXT,
  purpose TEXT NOT NULL,
  -- JSON array of { name, count }.
  sections TEXT NOT NULL,
  recorded_by TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

-- Optional override of the PHIPA 30-day clock. Absent means submitted_at + 30 days.
CREATE TABLE IF NOT EXISTS privacy_deadlines (
  tenant_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  until_at TEXT NOT NULL,
  reason TEXT NOT NULL,
  set_by TEXT NOT NULL,
  set_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, request_id)
);

CREATE TABLE IF NOT EXISTS assurance_findings (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  control_id TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT NOT NULL,
  -- open | closed
  status TEXT NOT NULL DEFAULT 'open',
  remediation TEXT,
  residual_risk TEXT,
  opened_by TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  closed_by TEXT,
  closed_at TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS assurance_exercises (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  kind TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  rto_seconds INTEGER,
  -- passed | failed. Null while open.
  outcome TEXT,
  notes TEXT,
  recorded_by TEXT NOT NULL,
  -- open | closed
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS subprocessors (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  purpose TEXT NOT NULL,
  region TEXT,
  -- candidate | active | inactive
  status TEXT NOT NULL,
  recorded_by TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

-- A clinical score is arithmetic until somebody accountable says it may be
-- used here. This table is that decision, and its absence is the default: a
-- score with no row is not enabled, which is why the table being empty is the
-- safe state rather than an unconfigured one.
--
-- Append-only, like the clinical record. A renewal, a re-approval after the
-- arithmetic changed, and a withdrawal are all new rows pointing at the one
-- they supersede; nothing is updated. So "who allowed this, and what did they
-- know at the time" always has an answer, including after the decision was
-- reversed.
--
-- Every column that could be invented is required instead. review_due is
-- supplied by the person approving and is never computed from a default
-- interval, because a review date the system picked is not a commitment
-- anybody made. clinical_owner_id must resolve to a practitioner the
-- directory holds and has not retired. reason is written, because a decision
-- with no stated basis cannot be reviewed later.
CREATE TABLE IF NOT EXISTS score_approvals (
  tenant_id TEXT NOT NULL DEFAULT 'default',
  id TEXT NOT NULL,
  score_id TEXT NOT NULL,
  -- The exact implementation the decision was made about. Arithmetic that has
  -- changed since is not what anybody approved, so this is compared rather
  -- than assumed to still match.
  implementation_version TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('approved', 'disabled')),
  reason TEXT NOT NULL,
  -- Present on an approval, absent on a withdrawal.
  clinical_owner_id TEXT,
  -- A readable snapshot taken at the moment of the decision, so the record
  -- stays legible after the directory renames or retires the person.
  clinical_owner_display TEXT,
  review_due TEXT,
  -- The authenticated operator who recorded the decision, kept separate from
  -- the clinician who owns it. They are frequently not the same person, and a
  -- record that conflates them can answer neither question afterwards.
  recorded_by_id TEXT NOT NULL,
  recorded_by_kind TEXT NOT NULL,
  supersedes TEXT,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS idx_score_approvals_score
  ON score_approvals(tenant_id, score_id, recorded_at DESC);


-- Lookup index over the charts.
--
-- Derived, not authoritative. Every column here is recoverable from the
-- Patient entries in clinical_entries, and rebuildIndex() does exactly that —
-- which is the property that keeps the log the record and this a convenience.
-- An index that could not be rebuilt would quietly become a second source of
-- truth, and the two would drift.
CREATE TABLE IF NOT EXISTS patient_index (
  tenant_id TEXT NOT NULL,
  patient_id TEXT NOT NULL,
  family TEXT,
  given TEXT,
  birth_date TEXT,
  gender TEXT,
  preferred_language TEXT,
  phone TEXT,
  email TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, patient_id)
);

-- The assertion that two charts are one person — as events, because the
-- store's own docstring is the design brief: "there is no honest way to
-- unmerge afterwards" is true of merging, and the answer is to never merge.
-- A link is a row and an unlink is another row; nothing is rewritten, so
-- undoing one is honest for the first time.
CREATE TABLE IF NOT EXISTS patient_link_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  link_id TEXT NOT NULL,
  -- linked | unlinked
  event TEXT NOT NULL,
  patient_a TEXT NOT NULL,
  patient_b TEXT NOT NULL,
  -- The evidence on a link, the reason on an unlink. Required either way:
  -- an assertion that two charts are the same person is a clinical decision,
  -- and a decision nobody can weigh afterwards is not one.
  detail TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  at TEXT NOT NULL
);

-- What a reading station knows about its own cache: which snapshot it holds,
-- when that snapshot's data was true, and how long it may serve from it.
--
-- Lives in the station's *own* database rather than in the cached snapshot,
-- and that separation is the whole point. The cache is purged when the budget
-- expires; the record that reads happened is not PHI-optional and outlives it,
-- because those reads still have to reconcile onto the primary's trail. One
-- row per tenant: a station serves exactly one custodian, so a shared regional
-- station cannot put one custodian's outage on another's floor.
CREATE TABLE IF NOT EXISTS station_manifest (
  tenant_id TEXT PRIMARY KEY,
  station_id TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  -- When the data was true, not when the copy landed. A snapshot taken at
  -- 02:00 and filled at 06:00 is four hours old the moment it arrives, and a
  -- chart that dates itself from the copy would understate its own age.
  taken_at TEXT NOT NULL,
  filled_at TEXT NOT NULL,
  budget_hours REAL NOT NULL,
  cache_path TEXT NOT NULL,
  -- Set when the budget ran out and the clinical cache was destroyed. A purged
  -- station keeps its manifest so it can still say why it is not serving.
  purged_at TEXT,
  -- The station chain seq already appended to the primary. Reconciliation is
  -- append-only and resumable; this is where it resumes from.
  reconciled_through INTEGER NOT NULL DEFAULT 0
);

-- Break-glass declared while the link was down, kept until the primary knows.
--
-- The declaration itself lands in the cached database, where the same consent
-- code the primary runs honours it for the rest of the outage. But the cache
-- is destroyed at budget expiry, and the notice a patient is owed rides the
-- primary's dispatch machinery — so the fact of the declaration is copied
-- here, in the database that survives, and replayed onto the primary at
-- reconciliation. An emergency override the primary never learns about is a
-- patient never told their record was opened.
CREATE TABLE IF NOT EXISTS station_breakglass (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  patient TEXT NOT NULL,
  reason TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  declared_at TEXT NOT NULL,
  replayed_at TEXT
);

-- Every identifier a chart is known by. A patient reaches a clinic with a
-- provincial health number, a hospital MRN and sometimes an interim number
-- issued the night they arrived; all three have to find the same chart.
CREATE TABLE IF NOT EXISTS patient_identifiers (
  tenant_id TEXT NOT NULL,
  patient_id TEXT NOT NULL,
  system TEXT NOT NULL DEFAULT '',
  value TEXT NOT NULL,
  PRIMARY KEY (tenant_id, patient_id, system, value)
);

-- How many versions each patient's chart has ever been issued. Only ever
-- increases, so a chart that has lost entries disagrees with it — the same
-- reason the audit trail keeps one.
CREATE TABLE IF NOT EXISTS clinical_counters (
  tenant_id TEXT NOT NULL,
  patient_id TEXT NOT NULL,
  issued INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, patient_id)
);

-- How many audit rows each tenant has ever been issued. Only ever increases,
-- so a trail that has lost rows disagrees with it — the truncation check that
-- SQLite's own AUTOINCREMENT mark used to serve before the trail became
-- per-tenant and that mark started counting everybody.
-- A privacy officer's judgement on a flagged access, so a review has a memory.
--
-- A flag that can only be looked at is a report; a flag somebody can close,
-- with a reason, on a specific access, is a process. Dismissals are kept
-- rather than deleting the flag because the flag is derived from the trail on
-- every read — there is nothing to delete — and because "we looked at this and
-- decided it was fine" is itself a fact a later review needs.
CREATE TABLE IF NOT EXISTS access_review_dismissals (
  tenant_id TEXT NOT NULL,
  -- The audit row the flag was raised against, and which flag. One access can
  -- raise several and they are dismissed one at a time: "yes, she is his
  -- daughter" answers the surname match and says nothing about the fact that
  -- there was no encounter.
  audit_id TEXT NOT NULL,
  flag TEXT NOT NULL,
  reason TEXT NOT NULL,
  dismissed_by TEXT NOT NULL,
  dismissed_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, audit_id, flag)
);

CREATE TABLE IF NOT EXISTS audit_counters (
  tenant_id TEXT PRIMARY KEY,
  issued INTEGER NOT NULL DEFAULT 0
);

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

const INDEXES = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_clinical_version ON clinical_entries(tenant_id, version_id);
-- The chart read: every version of every record for one patient, in order.
CREATE INDEX IF NOT EXISTS idx_clinical_patient ON clinical_entries(tenant_id, patient_id, seq);
-- The current view: latest version of one record.
CREATE INDEX IF NOT EXISTS idx_clinical_record ON clinical_entries(tenant_id, record_id, version);
CREATE INDEX IF NOT EXISTS idx_clinical_type ON clinical_entries(tenant_id, patient_id, entry_type, seq);
CREATE INDEX IF NOT EXISTS idx_clinical_encounter ON clinical_entries(tenant_id, encounter_id, seq);
CREATE INDEX IF NOT EXISTS idx_clinical_key ON clinical_entries(tenant_id, record_key, version);
CREATE INDEX IF NOT EXISTS idx_patient_name ON patient_index(tenant_id, family, given, birth_date);
CREATE INDEX IF NOT EXISTS idx_patient_ident ON patient_identifiers(tenant_id, value, system);
CREATE INDEX IF NOT EXISTS idx_tasks_owner ON tasks(tenant_id, owner_id, status, due_at);
CREATE INDEX IF NOT EXISTS idx_tasks_open ON tasks(tenant_id, status, due_at);
CREATE INDEX IF NOT EXISTS idx_tasks_patient ON tasks(tenant_id, patient_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_correlation ON tasks(tenant_id, correlation_id);
CREATE INDEX IF NOT EXISTS idx_task_events ON task_events(tenant_id, task_id, seq);
CREATE INDEX IF NOT EXISTS idx_referrals_open ON referrals(tenant_id, status, expected_by);
CREATE INDEX IF NOT EXISTS idx_referrals_patient ON referrals(tenant_id, patient_id, status);
CREATE INDEX IF NOT EXISTS idx_referrals_corr ON referrals(tenant_id, correlation_id);
CREATE INDEX IF NOT EXISTS idx_referral_events ON referral_events(tenant_id, referral_id, seq);
CREATE INDEX IF NOT EXISTS idx_orders_open ON orders(tenant_id, status, expected_by);
CREATE INDEX IF NOT EXISTS idx_orders_patient ON orders(tenant_id, patient_id, status);
CREATE INDEX IF NOT EXISTS idx_orders_responsible ON orders(tenant_id, responsible_id, status);
CREATE INDEX IF NOT EXISTS idx_results_order ON order_results(tenant_id, order_id);
CREATE INDEX IF NOT EXISTS idx_results_patient ON order_results(tenant_id, patient_id, reported_at);
CREATE INDEX IF NOT EXISTS idx_results_unack ON order_results(tenant_id, acknowledged_at, ack_due_by);
CREATE INDEX IF NOT EXISTS idx_results_supersedes ON order_results(tenant_id, supersedes);
CREATE INDEX IF NOT EXISTS idx_order_events ON order_events(tenant_id, order_id, seq);
CREATE INDEX IF NOT EXISTS idx_meds_patient ON medication_statements(tenant_id, patient_id, status);
CREATE INDEX IF NOT EXISTS idx_meds_supersedes ON medication_statements(tenant_id, supersedes);
CREATE INDEX IF NOT EXISTS idx_meds_ingredient ON medication_statements(tenant_id, patient_id, ingredient);
CREATE INDEX IF NOT EXISTS idx_allergies_patient ON allergies(tenant_id, patient_id, status);
CREATE INDEX IF NOT EXISTS idx_allergies_supersedes ON allergies(tenant_id, supersedes);
CREATE INDEX IF NOT EXISTS idx_medrec_patient ON med_reconciliations(tenant_id, patient_id, status);
CREATE INDEX IF NOT EXISTS idx_medrec_items ON med_reconciliation_items(tenant_id, reconciliation_id);
CREATE INDEX IF NOT EXISTS idx_med_events ON medication_events(tenant_id, patient_id, seq);
CREATE INDEX IF NOT EXISTS idx_authority_subject ON patient_authority(tenant_id, subject_id, patient_id);
CREATE INDEX IF NOT EXISTS idx_authority_patient ON patient_authority(tenant_id, patient_id);
CREATE INDEX IF NOT EXISTS idx_release_patient ON result_release(tenant_id, patient_id, state);
CREATE INDEX IF NOT EXISTS idx_patient_access ON patient_access_log(tenant_id, patient_id, seq);
CREATE INDEX IF NOT EXISTS idx_patient_requests ON patient_requests(tenant_id, patient_id, submitted_at);
CREATE INDEX IF NOT EXISTS idx_enrolments_status ON patient_enrolments(tenant_id, status, requested_at);
CREATE INDEX IF NOT EXISTS idx_enrolments_patient ON patient_enrolments(tenant_id, patient_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_enrolment_pending
  ON patient_enrolments(tenant_id, patient_id, subject_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_patient_notices_status ON patient_notices(tenant_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_patient_notices_patient ON patient_notices(tenant_id, patient_id);
-- The deduplication lookup. Every inbound result does it, so it is the one
-- query on this table that has to stay fast as results accumulate.
CREATE INDEX IF NOT EXISTS idx_results_key ON order_results(tenant_id, result_key);
CREATE INDEX IF NOT EXISTS idx_results_source ON order_results(tenant_id, source_system, reported_at);
CREATE INDEX IF NOT EXISTS idx_lab_holds ON lab_identity_holds(tenant_id, resolved_at, received_at);
CREATE INDEX IF NOT EXISTS idx_prescriptions_patient ON prescriptions(tenant_id, patient_id, written_at);
-- The three chase lists: never sent, sent and unacknowledged, failed.
CREATE INDEX IF NOT EXISTS idx_prescriptions_status ON prescriptions(tenant_id, status, written_at);
CREATE INDEX IF NOT EXISTS idx_prescription_events ON prescription_events(tenant_id, prescription_id, seq);
-- The idempotency lookup every migrated record does.
CREATE INDEX IF NOT EXISTS idx_migration_source
  ON migration_records(tenant_id, source_system, record_type, source_id);
CREATE INDEX IF NOT EXISTS idx_migration_run ON migration_records(tenant_id, run_id, record_type, outcome);
CREATE INDEX IF NOT EXISTS idx_migration_patient ON migration_records(tenant_id, patient_id, loaded_at);
CREATE INDEX IF NOT EXISTS idx_privacy_reviews_status ON privacy_reviews(tenant_id, status, opened_at);
CREATE INDEX IF NOT EXISTS idx_privacy_flags_review ON privacy_flags(tenant_id, review_id, status);
CREATE INDEX IF NOT EXISTS idx_legal_holds_active ON legal_holds(tenant_id, released_at, placed_at);
CREATE INDEX IF NOT EXISTS idx_privacy_incidents_status ON privacy_incidents(tenant_id, status, opened_at);
CREATE INDEX IF NOT EXISTS idx_privacy_disclosures_patient ON privacy_disclosures(tenant_id, patient_id, recorded_at);
CREATE INDEX IF NOT EXISTS idx_privacy_disclosures_request ON privacy_disclosures(tenant_id, request_id);
CREATE INDEX IF NOT EXISTS idx_assurance_findings_status ON assurance_findings(tenant_id, status, opened_at);
CREATE INDEX IF NOT EXISTS idx_subprocessors_status ON subprocessors(tenant_id, status, name);
CREATE INDEX IF NOT EXISTS idx_patient_request_events ON patient_request_events(tenant_id, request_id, seq);
-- The double-booking constraint. Partial, so a cancelled booking releases its
-- seat while remaining on the record — a slot freed by deleting its booking
-- would lose the fact that somebody cancelled, which is what a pattern of
-- cancellations is made of.
CREATE UNIQUE INDEX IF NOT EXISTS idx_booking_seat
  ON schedule_bookings(tenant_id, slot_id, seat) WHERE status != 'cancelled';
CREATE INDEX IF NOT EXISTS idx_slots_when ON schedule_slots(tenant_id, resource_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_slots_service ON schedule_slots(tenant_id, service, starts_at);
CREATE INDEX IF NOT EXISTS idx_bookings_patient ON schedule_bookings(tenant_id, patient_id, status);
CREATE INDEX IF NOT EXISTS idx_bookings_slot ON schedule_bookings(tenant_id, slot_id, status);
CREATE INDEX IF NOT EXISTS idx_schedule_events ON schedule_events(tenant_id, booking_id, seq);
-- The chart read: a patient's visits, newest first.
CREATE INDEX IF NOT EXISTS idx_encounters_patient ON encounters(tenant_id, patient_id, started_at);
-- The worklist read: what is still open, so a visit cannot stay open forever
-- without somebody seeing it.
CREATE INDEX IF NOT EXISTS idx_encounters_status ON encounters(tenant_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_encounter_participants ON encounter_participants(tenant_id, encounter_id);
CREATE INDEX IF NOT EXISTS idx_encounter_events ON encounter_events(tenant_id, encounter_id, seq);
CREATE INDEX IF NOT EXISTS idx_directory_practitioner_name ON directory_practitioners(tenant_id, family, given);
CREATE INDEX IF NOT EXISTS idx_directory_org_name ON directory_organizations(tenant_id, name);
CREATE INDEX IF NOT EXISTS idx_directory_service_org ON directory_services(tenant_id, organization_id);
CREATE INDEX IF NOT EXISTS idx_directory_roles_practitioner ON directory_roles(tenant_id, practitioner_id);
CREATE INDEX IF NOT EXISTS idx_directory_roles_org ON directory_roles(tenant_id, organization_id);
-- The lookup that matters for #17: a credential carries an identifier, and
-- this is what turns it into a party.
CREATE INDEX IF NOT EXISTS idx_directory_identifier ON directory_identifiers(tenant_id, system, value);
CREATE INDEX IF NOT EXISTS idx_care_team_patient ON care_team(tenant_id, patient_id, active_to);
CREATE INDEX IF NOT EXISTS idx_care_team_practitioner ON care_team(tenant_id, practitioner_id, active_to);
CREATE INDEX IF NOT EXISTS idx_coverage_patient ON coverage(tenant_id, patient_id, created_at);
CREATE INDEX IF NOT EXISTS idx_threads_patient ON patient_threads(tenant_id, patient_id, status);
CREATE INDEX IF NOT EXISTS idx_threads_inbox ON patient_threads(tenant_id, owner_id, status, priority);
CREATE INDEX IF NOT EXISTS idx_thread_messages ON patient_messages(tenant_id, thread_id, recorded_at);
CREATE INDEX IF NOT EXISTS idx_thread_events ON patient_thread_events(tenant_id, thread_id, seq);
CREATE INDEX IF NOT EXISTS idx_directives_patient ON consent_directives(tenant_id, patient_id, status);
CREATE INDEX IF NOT EXISTS idx_directives_target ON consent_directives(tenant_id, target_id, status);
CREATE INDEX IF NOT EXISTS idx_breakglass_review ON break_glass(tenant_id, reviewed_at, declared_at);
CREATE INDEX IF NOT EXISTS idx_breakglass_patient ON break_glass(tenant_id, patient_id, declared_at);
CREATE INDEX IF NOT EXISTS idx_breakglass_subject ON break_glass(tenant_id, subject_id, declared_at);
CREATE INDEX IF NOT EXISTS idx_messages_received ON messages(received_at);
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(tenant_id, channel_id, seq);
CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status);
CREATE INDEX IF NOT EXISTS idx_deliveries_due ON deliveries(tenant_id, state, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_deliveries_order ON deliveries(ordering_key, seq);
-- The ordered-delivery gate asks "is any earlier delivery for this key still
-- undelivered". Without this it scans every row sharing the key, which grows
-- with the backlog — exactly when draining matters most.
-- rowid cannot be named in an index, and does not need to be: index entries
-- for a given (ordering_key, state) are already ordered by rowid, so MIN(rowid)
-- is the first entry of the range.
CREATE INDEX IF NOT EXISTS idx_deliveries_gate ON deliveries(ordering_key, state);
CREATE INDEX IF NOT EXISTS idx_deliveries_message ON deliveries(message_id);
CREATE INDEX IF NOT EXISTS idx_fhir_updated ON fhir_resources(resource_type, updated_at);
CREATE INDEX IF NOT EXISTS idx_fhir_ident_value ON fhir_identifiers(tenant_id, value, system);
CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(hash);
CREATE INDEX IF NOT EXISTS idx_audit_recorded ON audit_events(recorded_at);
CREATE INDEX IF NOT EXISTS idx_audit_principal ON audit_events(principal_id, recorded_at);
CREATE INDEX IF NOT EXISTS idx_audit_patient ON audit_events(tenant_id, patient, recorded_at);
`;


export interface DbOptions {
  /**
   * Open without writing. Used to inspect a backup snapshot: the schema is
   * already there, and applying it would fail against a read-only file.
   */
  readOnly?: boolean;
  /** Which tenant this handle speaks for. Defaults to the default tenant. */
  tenantId?: string;
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
  { table: "prescriptions", column: "dispense_reporting", type: "INTEGER" },
  { table: "prescriptions", column: "safety_summary", type: "TEXT" },
  { table: "referrals", column: "to_service_id", type: "TEXT" },
  { table: "referrals", column: "to_external", type: "INTEGER" },
  { table: "messages", column: "raw_digest", type: "TEXT" },
  { table: "messages", column: "redacted_at", type: "TEXT" },
  { table: "deliveries", column: "redacted_at", type: "TEXT" },
  { table: "audit_events", column: "purpose_of_use", type: "TEXT" },
  { table: "api_keys", column: "expires_at", type: "TEXT" },
  { table: "api_keys", column: "rotated_to", type: "TEXT" },
  { table: "api_keys", column: "rotated_at", type: "TEXT" },
  // Organization identity, so a `withhold-from-organization` directive can be
  // matched against one organization rather than withholding from everybody.
  // Nullable, and null keeps the old fail-closed behaviour: an upgraded
  // database's existing keys carry no organization until somebody sets one,
  // and until then they are treated exactly as they were before this column.
  { table: "api_keys", column: "organization_id", type: "TEXT" },
  { table: "audit_events", column: "organization_id", type: "TEXT" },
  // Dispatch, recorded separately from acknowledgement. An upgraded database's
  // existing overrides have all three NULL, which reads correctly: nothing was
  // sent, because before this there was nothing that could send.
  // The credential-to-person join. Null on every existing row, which reads
  // correctly: those credentials named nobody, and an access review says so
  // rather than guessing at who was behind them.
  { table: "api_keys", column: "practitioner_id", type: "TEXT" },
  // Travelling clinics. Existing slots were not planned as part of a visit,
  // and NULL says exactly that.
  { table: "schedule_slots", column: "visit_id", type: "TEXT" },
  // Config versioning. Null on existing rows reads correctly: written before
  // any version existed.
  { table: "channels", column: "config_version", type: "INTEGER" },
  { table: "messages", column: "config_version", type: "INTEGER" },
  { table: "audit_events", column: "practitioner_id", type: "TEXT" },
  { table: "break_glass", column: "notice_dispatched_at", type: "TEXT" },
  { table: "break_glass", column: "notice_message_id", type: "TEXT" },
  { table: "break_glass", column: "notice_error", type: "TEXT" },
  { table: "patient_index", column: "preferred_language", type: "TEXT" },
  { table: "patient_index", column: "phone", type: "TEXT" },
  { table: "patient_index", column: "email", type: "TEXT" },
  { table: "patient_authority", column: "permissions", type: "TEXT" },
  { table: "patient_authority", column: "purpose", type: "TEXT" },
  // Laboratory interface provenance. `result_key` is what makes a
  // retransmission a no-op instead of a duplicate; without it every nightly
  // repeat filed the day's results again. Null on rows written by hand or by
  // an earlier version, which is why the dedupe lookup is keyed rather than
  // assumed.
  { table: "order_results", column: "result_key", type: "TEXT" },
  { table: "order_results", column: "filler_order_number", type: "TEXT" },
  { table: "order_results", column: "source_system", type: "TEXT" },
  // The laboratory's own words for status and flag, kept beside the mapped
  // ones. A mapping is an interpretation, and a reconciliation that cannot see
  // what was actually sent cannot settle a disagreement about it.
  { table: "order_results", column: "raw_status", type: "TEXT" },
  { table: "order_results", column: "raw_flag", type: "TEXT" },
  // 1 when the observation time arrived with no timezone at all. A result an
  // hour out is a result on the wrong side of a shift change, so the ambiguity
  // is recorded rather than resolved by assuming UTC.
  { table: "order_results", column: "timezone_assumed", type: "INTEGER" },
  { table: "orders", column: "filler_order_number", type: "TEXT" },
  // Whether a transmission carried the order or its cancellation. Defaulted to
  // 'order' so rows written before cancellation existed keep their meaning.
  { table: "order_transmissions", column: "kind", type: "TEXT NOT NULL DEFAULT 'order'" },
  // The connection an order actually goes out on. Nullable: a site that has
  // declared it does not transmit has nothing to put here.
  { table: "order_routing", column: "endpoint_host", type: "TEXT" },
  { table: "order_routing", column: "endpoint_port", type: "INTEGER" },
  { table: "order_routing", column: "sending_application", type: "TEXT" },
  { table: "order_routing", column: "sending_facility", type: "TEXT" },
  { table: "order_routing", column: "receiving_application", type: "TEXT" },
  { table: "order_routing", column: "receiving_facility", type: "TEXT" },
  { table: "order_routing", column: "timezone_offset", type: "TEXT" },
  { table: "order_routing", column: "profile_id", type: "TEXT" },
  // Tenancy. NOT NULL with a default, so existing rows land in the default
  // tenant rather than becoming unreachable, and a deployment that never
  // configures a second tenant is unaffected.
  ...TENANT_SCOPED_TABLES.map((table) => ({
    table,
    column: "tenant_id",
    type: `TEXT NOT NULL DEFAULT '${DEFAULT_TENANT}'`,
  })),
];

/**
 * Tables whose primary key had to grow a tenant, and the DDL to rebuild them.
 *
 * `ALTER TABLE` cannot change a primary key, and here that is not cosmetic. On
 * an upgraded database these three would keep a key that is unique across all
 * tenants — so the first time a second custodian stored `Patient/p1`, it would
 * overwrite the first custodian's patient of that id. A silent cross-tenant
 * write is precisely what tenancy exists to prevent, so the rebuild is not
 * optional.
 *
 * SQLite's supported procedure: turn foreign keys off *outside* the
 * transaction (the pragma is a no-op inside one), create the new shape,
 * copy, drop, rename, `PRAGMA foreign_key_check`, then turn them back on.
 * SCHEMA has no REFERENCES today, so the rebuild is safe either way — the
 * day one is added, this is the difference between an upgrade that works
 * and one that deletes child rows or refuses to boot.
 */
const REBUILT_TABLES: Array<{ table: string; columns: string[]; ddl: string }> = [
  {
    table: "fhir_resources",
    columns: ["tenant_id", "resource_type", "id", "version_id", "json", "hash", "updated_at"],
    ddl: `CREATE TABLE fhir_resources__new (
      tenant_id TEXT NOT NULL DEFAULT '${DEFAULT_TENANT}',
      resource_type TEXT NOT NULL,
      id TEXT NOT NULL,
      version_id INTEGER NOT NULL,
      json TEXT NOT NULL,
      hash TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (tenant_id, resource_type, id)
    )`,
  },
  {
    table: "fhir_identifiers",
    columns: ["tenant_id", "resource_type", "id", "system", "value"],
    ddl: `CREATE TABLE fhir_identifiers__new (
      tenant_id TEXT NOT NULL DEFAULT '${DEFAULT_TENANT}',
      resource_type TEXT NOT NULL,
      id TEXT NOT NULL,
      system TEXT NOT NULL DEFAULT '',
      value TEXT NOT NULL,
      PRIMARY KEY (tenant_id, resource_type, id, system, value)
    )`,
  },
  {
    table: "channels",
    // config_version is here as well as in ADDED_COLUMNS, because the rebuild
    // runs after the ALTERs and recreates the table from this DDL: a column
    // listed only there would be added and then dropped by the copy, on
    // exactly the upgraded databases it exists for.
    columns: ["tenant_id", "id", "name", "enabled", "config", "last_hash", "created_at", "updated_at", "config_version"],
    ddl: `CREATE TABLE channels__new (
      tenant_id TEXT NOT NULL DEFAULT '${DEFAULT_TENANT}',
      id TEXT NOT NULL,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      config TEXT NOT NULL,
      last_hash TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      config_version INTEGER,
      PRIMARY KEY (tenant_id, id)
    )`,
  },
  {
    table: "fhir_subscriptions",
    columns: ["tenant_id", "id", "status", "criteria", "endpoint", "payload", "created_at"],
    ddl: `CREATE TABLE fhir_subscriptions__new (
      tenant_id TEXT NOT NULL DEFAULT '${DEFAULT_TENANT}',
      id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      criteria TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT 'application/fhir+json',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (tenant_id, id)
    )`,
  },
  {
    table: "channel_state",
    columns: ["tenant_id", "channel_id", "key", "value"],
    ddl: `CREATE TABLE channel_state__new (
      tenant_id TEXT NOT NULL DEFAULT '${DEFAULT_TENANT}',
      channel_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT,
      PRIMARY KEY (tenant_id, channel_id, key)
    )`,
  },
];

export class Db {
  readonly sql: DatabaseSync;

  /** Nesting depth, so only the outermost call begins and commits. */
  private txDepth = 0;

  /**
   * The tenant this handle speaks for.
   *
   * Deliberately part of the handle's identity rather than a parameter on
   * every method. A `tenantId` argument is one a caller can forget, and the
   * cost of forgetting it once is a query that reads across custodians — the
   * exact failure tenancy exists to prevent, arriving silently and looking
   * like ordinary results. Here there is nothing to forget: every statement
   * below binds `this.tenantId`, and reaching another tenant's data requires
   * saying so, in `forTenant`.
   */
  readonly tenantId: string;

  constructor(path: string, opts: DbOptions = {}) {
    this.tenantId = opts.tenantId ?? DEFAULT_TENANT;
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
    // Tables first, then the migration that brings an older database up to
    // them, and only then the indexes. An index naming a column the migration
    // is about to add cannot be created before it exists, and applying them
    // together is how the first version of this failed on every upgraded
    // database with "no such column: tenant_id".
    this.sql.exec(SCHEMA);
    this.migrate();
    this.sql.exec(INDEXES);
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

    const pending: typeof REBUILT_TABLES = [];
    for (const spec of REBUILT_TABLES) {
      const info = this.sql.prepare(`PRAGMA table_info(${spec.table})`).all() as Array<{ name: string; pk: number }>;
      if (info.length === 0) continue;
      // Already rebuilt if the tenant is part of the key. `pk` is the column's
      // 1-based position in the primary key, or 0 when it is not in it.
      if (info.some((c) => c.name === "tenant_id" && c.pk > 0)) continue;
      pending.push(spec);
    }

    if (pending.length > 0) {
      // Must sit outside the transaction: PRAGMA foreign_keys is a no-op
      // inside one, and DROP TABLE with FKs on would cascade or fail.
      this.sql.exec("PRAGMA foreign_keys = OFF;");
      try {
        for (const { table, columns, ddl } of pending) {
          const list = columns.join(", ");
          this.transaction(() => {
            this.sql.exec(ddl);
            this.sql.exec(`INSERT INTO ${table}__new (${list}) SELECT ${list} FROM ${table}`);
            this.sql.exec(`DROP TABLE ${table}`);
            this.sql.exec(`ALTER TABLE ${table}__new RENAME TO ${table}`);
            const violations = this.sql.prepare("PRAGMA foreign_key_check").all() as Array<{
              table: string;
              rowid: number;
            }>;
            if (violations.length > 0) {
              const first = violations[0];
              throw new Error(
                `foreign_key_check failed rebuilding ${table}: ${violations.length} violation(s), first on ${first.table} rowid ${first.rowid}`
              );
            }
          });
          console.warn(`migrated ${table} to a per-tenant primary key`);
        }
      } finally {
        this.sql.exec("PRAGMA foreign_keys = ON;");
      }
    }
    // Indexes dropped with a rebuilt table are restored by the caller, which
    // applies them after this returns.

    // The tenant existing rows were just assigned has to exist as a row, or a
    // later join against tenants finds nothing and the data reads as orphaned.
    this.sql
      .prepare(
        `INSERT INTO tenants (id, name, custodian) VALUES (?, ?, ?)
         ON CONFLICT(id) DO NOTHING`
      )
      .run(DEFAULT_TENANT, "Default", null);

    // Seed the audit counter from what the database already knows.
    //
    // Without this an upgraded node has audit rows and no counter, and the
    // truncation check silently does nothing — losing a guarantee on upgrade
    // while reporting a clean chain, which is precisely the shape of failure
    // that check exists to catch. SQLite's AUTOINCREMENT high-water mark is
    // still exact on a database that only ever had one tenant, so it is the
    // right thing to carry forward; the row count is the fallback.
    // crosses-tenants: one-time migration of a database that predates tenancy,
    // where every row is the default tenant's by definition.
    const already = this.sql.prepare("SELECT COUNT(*) AS n FROM audit_counters").get() as { n: number };
    if (already.n === 0) {
      const mark = this.sql.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'audit_events'").get() as
        | { seq: number }
        | undefined;
      const rows = this.sql.prepare("SELECT COUNT(*) AS n FROM audit_events").get() as { n: number };
      const issued = mark?.seq ?? rows.n;
      if (issued > 0) {
        this.sql.prepare("INSERT INTO audit_counters (tenant_id, issued) VALUES (?, ?)").run(DEFAULT_TENANT, issued);
      }
    }
  }

  close(): void {
    this.sql.close();
  }

  /**
   * A handle onto the same database, speaking for a different tenant.
   *
   * Shares the connection — one process, one writer, and the instance lock
   * still means what it meant — while every query it runs is bound to the
   * tenant named here. Crossing a boundary is therefore an explicit call with
   * the other tenant's name in it, which is greppable, reviewable, and
   * auditable, rather than the absence of a `WHERE` clause nobody notices.
   *
   * Does not create the tenant: a handle onto one that was never provisioned
   * reads and writes nothing, rather than quietly bringing it into existence.
   */
  forTenant(tenantId: string): Db {
    if (tenantId === this.tenantId) return this;
    const view: Db = Object.create(Db.prototype) as Db;
    Object.defineProperty(view, "sql", { value: this.sql, enumerable: true });
    Object.defineProperty(view, "tenantId", { value: tenantId, enumerable: true });
    return view;
  }

  /* -------------------------------- tenants ------------------------------ */

  createTenant(id: string, name: string, custodian?: string): void {
    this.sql
      .prepare(
        `INSERT INTO tenants (id, name, custodian) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, custodian = excluded.custodian`
      )
      .run(id, name, custodian ?? null);
  }

  listTenants(): Array<{ id: string; name: string; custodian: string | null; status: string; created_at: string }> {
    return this.sql.prepare("SELECT id, name, custodian, status, created_at FROM tenants ORDER BY id").all() as Array<{
      id: string;
      name: string;
      custodian: string | null;
      status: string;
      created_at: string;
    }>;
  }

  getTenant(id: string): { id: string; name: string; custodian: string | null; status: string } | undefined {
    return this.sql.prepare("SELECT id, name, custodian, status FROM tenants WHERE id = ?").get(id) as
      | { id: string; name: string; custodian: string | null; status: string }
      | undefined;
  }

  /**
   * Suspends a tenant. Section 13 requires a tenant to be stoppable without
   * touching anyone else, and without deleting anything.
   */
  setTenantStatus(id: string, status: "active" | "suspended"): boolean {
    const r = this.sql
      .prepare(
        `UPDATE tenants SET status = ?, suspended_at = CASE WHEN ? = 'suspended' THEN datetime('now') ELSE NULL END
          WHERE id = ?`
      )
      .run(status, status, id);
    return r.changes > 0;
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
   * Reentrant. A nested call joins the transaction already open rather than
   * starting a second one, which SQLite refuses outright. This matters as soon
   * as an operation is built from others: redirecting a referral closes one
   * and creates another, and each of those is itself atomic. Without this the
   * composite either crashes or has to be written non-atomically — and a
   * redirect that closed the original without creating its successor is
   * exactly the lost loop the referral store exists to prevent.
   *
   * A throw anywhere inside rolls the whole thing back, since only the
   * outermost call commits. Safe because everything within is synchronous: no
   * other JavaScript can interleave and find a half-finished transaction.
   */
  transaction<T>(fn: () => T): T {
    if (this.txDepth > 0) {
      this.txDepth++;
      try {
        return fn();
      } finally {
        this.txDepth--;
      }
    }

    this.sql.exec("BEGIN");
    this.txDepth = 1;
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
    } finally {
      this.txDepth = 0;
    }
  }

  /* ------------------------------ channels ------------------------------ */

  upsertChannel(id: string, name: string, enabled: boolean, config: string): void {
    this.sql
      .prepare(
        `INSERT INTO channels (tenant_id, id, name, enabled, config) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(tenant_id, id) DO UPDATE SET name = excluded.name, enabled = excluded.enabled,
           config = excluded.config, updated_at = datetime('now')`
      )
      .run(this.tenantId, id, name, enabled ? 1 : 0, config);
  }

  getChannel(
    id: string
  ):
    | { id: string; name: string; enabled: number; config: string; last_hash: string | null; config_version: number | null }
    | undefined {
    return this.sql
      .prepare(
        "SELECT id, name, enabled, config, last_hash, config_version FROM channels WHERE tenant_id = ? AND id = ?"
      )
      .get(this.tenantId, id) as
      | { id: string; name: string; enabled: number; config: string; last_hash: string | null; config_version: number | null }
      | undefined;
  }

  listChannels(): Array<{ id: string; name: string; enabled: number; config: string }> {
    return this.sql
      .prepare("SELECT id, name, enabled, config FROM channels WHERE tenant_id = ? ORDER BY id")
      .all(this.tenantId) as Array<{
      id: string;
      name: string;
      enabled: number;
      config: string;
    }>;
  }

  deleteChannel(id: string): void {
    this.sql.prepare("DELETE FROM channels WHERE tenant_id = ? AND id = ?").run(this.tenantId, id);
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
        `INSERT INTO messages (tenant_id, id, channel_id, source_type, content_type, raw, meta, hash, prev_hash,
           raw_digest, config_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        this.tenantId,
        id,
        channelId,
        sourceType,
        contentType,
        raw,
        meta ? JSON.stringify(meta) : null,
        hash,
        prev,
        rawDigest,
        // Which configuration processed this message. The lineage claim the
        // rest of the system already makes, extended to the config boundary:
        // a message that went wrong is traceable to the exact rules that were
        // live when it did. Null means the channel predates versioning.
        ch?.config_version ?? null
      );
    this.sql
      .prepare("UPDATE channels SET last_hash = ? WHERE tenant_id = ? AND id = ?")
      .run(hash, this.tenantId, channelId);
    return this.getMessage(id)!;
  }

  getMessage(id: string): MessageRow | undefined {
    return this.sql.prepare("SELECT * FROM messages WHERE tenant_id = ? AND id = ?").get(this.tenantId, id) as
      | MessageRow
      | undefined;
  }

  setMessageStatus(id: string, status: MessageStatus, error?: string): void {
    this.sql
      .prepare("UPDATE messages SET status = ?, error = ? WHERE tenant_id = ? AND id = ?")
      .run(status, error ?? null, this.tenantId, id);
  }

  listMessages(filter: { channelId?: string; status?: string; limit?: number }): MessageRow[] {
    // The tenant predicate is written into the statement rather than composed
    // into it. Both scope the query identically, but only this way can a
    // reader — or the check in test/tenant-scoping.test.ts — see the scope in
    // the SQL rather than having to trace where a variable was built.
    const clauses: string[] = [];
    const args: unknown[] = [this.tenantId];
    if (filter.channelId) {
      clauses.push("AND channel_id = ?");
      args.push(filter.channelId);
    }
    if (filter.status) {
      clauses.push("AND status = ?");
      args.push(filter.status);
    }
    const extra = clauses.join(" ");
    const limit = Math.min(filter.limit ?? 100, 1000);
    return this.sql
      .prepare(`SELECT * FROM messages WHERE tenant_id = ? ${extra} ORDER BY seq DESC LIMIT ${limit}`)
      .all(...(args as never[])) as unknown as MessageRow[];
  }

  /**
   * How many messages a channel holds. Served by idx_messages_channel, so it
   * stays cheap as the log grows — which matters because /metrics asks on
   * every scrape.
   */
  countMessages(channelId: string): number {
    return (
      this.sql
        .prepare("SELECT COUNT(*) AS n FROM messages WHERE tenant_id = ? AND channel_id = ?")
        .get(this.tenantId, channelId) as { n: number }
    ).n;
  }

  addStep(messageId: string, index: number, name: string, output: string | null): void {
    this.sql
      .prepare("INSERT INTO message_steps (tenant_id, message_id, step_index, name, output) VALUES (?, ?, ?, ?, ?)")
      .run(this.tenantId, messageId, index, name, output);
  }

  getSteps(messageId: string): Array<{ step_index: number; name: string; output: string | null; at: string }> {
    return this.sql
      .prepare(
        "SELECT step_index, name, output, at FROM message_steps WHERE tenant_id = ? AND message_id = ? ORDER BY step_index"
      )
      .all(this.tenantId, messageId) as Array<{ step_index: number; name: string; output: string | null; at: string }>;
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
      .prepare(
        "SELECT id, raw, hash, prev_hash, raw_digest, redacted_at FROM messages WHERE tenant_id = ? AND channel_id = ? ORDER BY seq"
      )
      .all(this.tenantId, channelId) as Array<{
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
    const args = channelId ? [this.tenantId, cutoffIso, channelId] : [this.tenantId, cutoffIso];

    const messages = this.sql
      .prepare(
        `UPDATE messages SET raw = '[redacted]', redacted_at = datetime('now')
          WHERE tenant_id = ? AND received_at < ? AND redacted_at IS NULL AND raw_digest IS NOT NULL${where}`
      )
      .run(...(args as never[])).changes;

    const steps = this.sql
      .prepare(
        `UPDATE message_steps SET output = '[redacted]'
          WHERE tenant_id = ? AND output IS NOT NULL AND output != '[redacted]'
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
          WHERE tenant_id = ? AND state IN ('delivered', 'discarded', 'dead')
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
      : (
          this.sql
            .prepare("SELECT DISTINCT channel_id AS c FROM messages WHERE tenant_id = ?")
            .all(this.tenantId) as Array<{ c: string }>
        ).map((r) => r.c);

    let total = 0;
    const touched: string[] = [];
    for (const ch of channels) {
      const last = this.sql
        .prepare(
          "SELECT id, hash, received_at FROM messages WHERE tenant_id = ? AND channel_id = ? AND received_at < ? ORDER BY seq DESC LIMIT 1"
        )
        .get(this.tenantId, ch, cutoffIso) as { id: string; hash: string; received_at: string } | undefined;
      if (!last) continue;

      const ids = this.sql
        .prepare("SELECT id FROM messages WHERE tenant_id = ? AND channel_id = ? AND received_at < ?")
        .all(this.tenantId, ch, cutoffIso) as Array<{ id: string }>;
      const del = this.sql
        .prepare("DELETE FROM messages WHERE tenant_id = ? AND channel_id = ? AND received_at < ?")
        .run(this.tenantId, ch, cutoffIso);

      // Steps and deliveries have no foreign key, so they are cleared here.
      for (const { id } of ids) {
        this.sql.prepare("DELETE FROM message_steps WHERE tenant_id = ? AND message_id = ?").run(this.tenantId, id);
        this.sql.prepare("DELETE FROM deliveries WHERE tenant_id = ? AND message_id = ?").run(this.tenantId, id);
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
    const oldest = this.sql
      .prepare("SELECT MIN(received_at) AS m FROM messages WHERE tenant_id = ?")
      .get(this.tenantId) as { m: string | null };
    const redactable = redactCutoff
      ? (
          this.sql
            .prepare(
              "SELECT COUNT(*) AS n FROM messages WHERE tenant_id = ? AND received_at < ? AND redacted_at IS NULL AND raw_digest IS NOT NULL"
            )
            .get(this.tenantId, redactCutoff) as { n: number }
        ).n
      : 0;
    const purgeable = purgeCutoff
      ? (
          this.sql
            .prepare("SELECT COUNT(*) AS n FROM messages WHERE tenant_id = ? AND received_at < ?")
            .get(this.tenantId, purgeCutoff) as { n: number }
        ).n
      : 0;
    return { redactable, purgeable, ...(oldest.m ? { oldest: oldest.m } : {}) };
  }

  /* ---------------------------- channel state --------------------------- */

  getChannelState(channelId: string, key: string): string | undefined {
    const row = this.sql
      .prepare("SELECT value FROM channel_state WHERE tenant_id = ? AND channel_id = ? AND key = ?")
      .get(this.tenantId, channelId, key) as { value: string | null } | undefined;
    return row?.value ?? undefined;
  }

  setChannelState(channelId: string, key: string, value: string): void {
    this.sql
      .prepare(
        `INSERT INTO channel_state (tenant_id, channel_id, key, value) VALUES (?, ?, ?, ?)
         ON CONFLICT(tenant_id, channel_id, key) DO UPDATE SET value = excluded.value`
      )
      .run(this.tenantId, channelId, key, value);
  }

  /* ---------------------------- subscriptions ---------------------------- */

  listSubscriptions(): SubscriptionRow[] {
    return this.sql
      .prepare("SELECT * FROM fhir_subscriptions WHERE tenant_id = ? ORDER BY created_at")
      .all(this.tenantId) as unknown as SubscriptionRow[];
  }

  getSubscription(id: string): SubscriptionRow | undefined {
    return this.sql
      .prepare("SELECT * FROM fhir_subscriptions WHERE tenant_id = ? AND id = ?")
      .get(this.tenantId, id) as SubscriptionRow | undefined;
  }

  insertSubscription(row: { id: string; status: string; criteria: string; endpoint: string; payload: string }): void {
    this.sql
      .prepare(
        "INSERT INTO fhir_subscriptions (tenant_id, id, status, criteria, endpoint, payload) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run(this.tenantId, row.id, row.status, row.criteria, row.endpoint, row.payload);
  }

  deleteSubscription(id: string): boolean {
    return this.sql
      .prepare("DELETE FROM fhir_subscriptions WHERE tenant_id = ? AND id = ?")
      .run(this.tenantId, id).changes > 0;
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
        `INSERT INTO deliveries (tenant_id, id, message_id, channel_id, destination_id, seq, ordering_key, ordered,
           skip_on_dead, max_attempts, next_attempt_at, payload, content_type)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        this.tenantId,
        id,
        row.messageId,
        row.channelId,
        row.destinationId,
        row.seq,
        orderingKey(this.tenantId, row.channelId, row.destinationId),
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
  // crosses-tenants: the delivery worker drains the whole node. One process
  // serves every tenant on it, so its queue sweep is necessarily platform-wide
  // — isolation here is carried by the ordering key, which is prefixed with
  // the tenant so no two tenants can ever share a queue or block each other.
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
  // crosses-tenants: the drain loop again. The ordering key it is given
  // already begins with a tenant, so this can only ever return rows belonging
  // to that tenant — the scope is carried by the key rather than by a column.
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

  // crosses-tenants: outcome recording for a row the worker already holds,
  // obtained from the platform-wide sweep above. Re-scoping by tenant here
  // would mean the worker could drain a delivery and then be unable to record
  // what happened to it, which loses the outcome rather than protecting
  // anything: the id is opaque and unguessable, and nothing reads across a
  // boundary.
  markInflight(id: string): void {
    this.sql.prepare("UPDATE deliveries SET state = 'inflight', attempts = attempts + 1 WHERE id = ?").run(id);
  }

  // crosses-tenants: as above.
  markDelivered(id: string, ack: string | null): void {
    this.sql
      .prepare("UPDATE deliveries SET state = 'delivered', ack = ?, delivered_at = datetime('now') WHERE id = ?")
      .run(ack, id);
  }

  // crosses-tenants: as above.
  markFailed(id: string, error: string, nextAttemptAt: number, dead: boolean): void {
    this.sql
      .prepare("UPDATE deliveries SET state = ?, last_error = ?, next_attempt_at = ? WHERE id = ?")
      .run(dead ? "dead" : "queued", error, nextAttemptAt, id);
  }

  getDelivery(id: string): DeliveryRow | undefined {
    return this.sql
      .prepare("SELECT * FROM deliveries WHERE tenant_id = ? AND id = ?")
      .get(this.tenantId, id) as DeliveryRow | undefined;
  }

  deliveriesForMessage(messageId: string): DeliveryRow[] {
    return this.sql
      .prepare("SELECT * FROM deliveries WHERE tenant_id = ? AND message_id = ? ORDER BY seq")
      .all(this.tenantId, messageId) as unknown as DeliveryRow[];
  }

  listDeliveries(filter: { channelId?: string; state?: string; limit?: number }): DeliveryRow[] {
    const clauses: string[] = [];
    const args: unknown[] = [this.tenantId];
    if (filter.channelId) {
      clauses.push("AND channel_id = ?");
      args.push(filter.channelId);
    }
    if (filter.state) {
      clauses.push("AND state = ?");
      args.push(filter.state);
    }
    const extra = clauses.join(" ");
    const limit = Math.min(filter.limit ?? 100, 1000);
    return this.sql
      .prepare(`SELECT * FROM deliveries WHERE tenant_id = ? ${extra} ORDER BY seq DESC LIMIT ${limit}`)
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
    const row = this.sql
      .prepare("SELECT state, redacted_at FROM deliveries WHERE tenant_id = ? AND id = ?")
      .get(this.tenantId, id) as { state: string; redacted_at: string | null } | undefined;
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
         WHERE tenant_id = ? AND id = ? AND state IN ('dead', 'delivered', 'discarded')`
      )
      .run(Date.now(), this.tenantId, id);
    return r.changes > 0 ? { ok: true } : { ok: false, reason: `cannot replay a delivery in state '${row.state}'` };
  }

  discardDelivery(id: string): boolean {
    const r = this.sql
      .prepare("UPDATE deliveries SET state = 'discarded' WHERE tenant_id = ? AND id = ? AND state = 'dead'")
      .run(this.tenantId, id);
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
  // crosses-tenants: runs once at startup, before any tenant context exists,
  // and its whole purpose is that nothing is left stranded anywhere on the
  // node. Scoping it would leave every other tenant's interrupted deliveries
  // wedged until someone happened to open a handle for them.
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
      .prepare("SELECT state, COUNT(*) AS n FROM deliveries WHERE tenant_id = ? GROUP BY state")
      .all(this.tenantId) as Array<{ state: string; n: number }>;
    const by = Object.fromEntries(counts.map((r) => [r.state, r.n])) as Record<string, number>;

    // next_attempt_at is epoch milliseconds and is set when a delivery is
    // first queued, so the earliest one is the head of the oldest backlog.
    const oldest = this.sql
      .prepare("SELECT MIN(next_attempt_at) AS t FROM deliveries WHERE tenant_id = ? AND state IN ('queued', 'inflight')")
      .get(this.tenantId) as { t: number | null };

    const perChannel = this.sql
      .prepare(
        `SELECT channel_id, MIN(next_attempt_at) AS t, COUNT(*) AS n
           FROM deliveries WHERE tenant_id = ? AND state IN ('queued', 'inflight')
          GROUP BY channel_id`
      )
      .all(this.tenantId) as Array<{ channel_id: string; t: number; n: number }>;

    const lastDelivery = this.sql
      .prepare("SELECT MAX(delivered_at) AS t FROM deliveries WHERE tenant_id = ? AND delivered_at IS NOT NULL")
      .get(this.tenantId) as { t: string | null };

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
          "SELECT (julianday('now') - julianday(MAX(received_at))) * 86400.0 AS age FROM messages WHERE tenant_id = ? AND channel_id = ?"
        )
        .get(this.tenantId, row.id) as { age: number | null };
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
        "SELECT (julianday('now') - julianday(MAX(received_at))) * 86400.0 AS age FROM messages WHERE tenant_id = ? AND channel_id = ?"
      )
      .get(this.tenantId, channelId) as { age: number | null };
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
          WHERE tenant_id = ? AND received_at >= datetime('now', ?)
          GROUP BY bucket, status
          ORDER BY bucket`
      )
      .all(fmt, this.tenantId, since) as unknown as Array<{ bucket: string; status: string; n: number }>;

    const deliveries = this.sql
      .prepare(
        `SELECT strftime(?, delivered_at) AS bucket, COUNT(*) AS n
           FROM deliveries
          WHERE tenant_id = ? AND delivered_at IS NOT NULL AND delivered_at >= datetime('now', ?)
          GROUP BY bucket
          ORDER BY bucket`
      )
      .all(fmt, this.tenantId, since) as unknown as Array<{ bucket: string; n: number }>;

    return { messages, deliveries };
  }

  /* ------------------------------- api keys ----------------------------- */

  insertApiKey(
    id: string,
    name: string,
    hash: string,
    scopes: string[],
    expiresAt?: string,
    organizationId?: string,
    practitionerId?: string
  ): void {
    this.sql
      .prepare(
        `INSERT INTO api_keys (tenant_id, id, name, hash, scopes, expires_at, organization_id, practitioner_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        this.tenantId,
        id,
        name,
        hash,
        scopes.join(" "),
        expiresAt ?? null,
        organizationId ?? null,
        practitionerId ?? null
      );
  }

  /**
   * Looks a key up by hash. Revoked keys never resolve.
   *
   * crosses-tenants: authentication happens before a tenant is known — the
   * key is what says which tenant the caller is in, so it cannot be found by
   * searching inside one. The row carries `tenant_id`, and the gate binds the
   * request to it; that is the moment the boundary starts applying. A hash is
   * 32 random bytes, so this is a lookup by secret rather than a search.
   */
  findApiKeyByHash(hash: string): ApiKeyRow | undefined {
    // Expiry is applied here, against the clock, rather than by a sweep that
    // has to run. A key that expired last night does not work this morning
    // whether or not anything has restarted since, which is the only way an
    // expiry date is a control rather than an intention.
    return this.sql
      .prepare(
        `SELECT * FROM api_keys
          WHERE hash = ? AND revoked_at IS NULL
            AND (expires_at IS NULL OR expires_at > ?)`
      )
      .get(hash, new Date().toISOString()) as ApiKeyRow | undefined;
  }

  touchApiKey(id: string): void {
    // crosses-tenants: paired with the lookup above and reached on the same
    // path, before the request is bound to a tenant.
    this.sql.prepare("UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?").run(id);
  }

  listApiKeys(): ApiKeyRow[] {
    return this.sql
      .prepare("SELECT * FROM api_keys WHERE tenant_id = ? ORDER BY created_at DESC")
      .all(this.tenantId) as unknown as ApiKeyRow[];
  }

  revokeApiKey(id: string): boolean {
    const r = this.sql
      .prepare("UPDATE api_keys SET revoked_at = datetime('now') WHERE tenant_id = ? AND id = ? AND revoked_at IS NULL")
      .run(this.tenantId, id);
    return r.changes > 0;
  }

  /**
   * Keys that still work and that nobody has used lately.
   *
   * A credential dormant for months is one of two things and both need it
   * found: nobody needs it, or somebody else has it. Neither announces itself,
   * and a key issued for a pilot that ended is indistinguishable from one an
   * attacker is sitting on.
   *
   * A key that has never been used at all is dormant from the day it was
   * issued, and is reported by age rather than being excluded for having no
   * last-used date — that shape is exactly the one left behind by a key
   * pasted into a ticket and never deployed.
   */
  dormantApiKeys(days: number, asOf = new Date().toISOString()): ApiKeyRow[] {
    const cutoff = new Date(new Date(asOf).getTime() - days * 86_400_000).toISOString();
    return this.sql
      .prepare(
        `SELECT * FROM api_keys
          WHERE tenant_id = ? AND revoked_at IS NULL
            AND (expires_at IS NULL OR expires_at > ?)
            AND COALESCE(last_used_at, created_at) < ?
          ORDER BY COALESCE(last_used_at, created_at)`
      )
      .all(this.tenantId, asOf, cutoff) as unknown as ApiKeyRow[];
  }

  /** Keys about to expire, so a renewal is a decision rather than an outage. */
  expiringApiKeys(withinDays: number, asOf = new Date().toISOString()): ApiKeyRow[] {
    const until = new Date(new Date(asOf).getTime() + withinDays * 86_400_000).toISOString();
    return this.sql
      .prepare(
        `SELECT * FROM api_keys
          WHERE tenant_id = ? AND revoked_at IS NULL AND expires_at IS NOT NULL
            AND expires_at > ? AND expires_at <= ?
          ORDER BY expires_at`
      )
      .all(this.tenantId, asOf, until) as unknown as ApiKeyRow[];
  }

  markApiKeyRotated(oldId: string, newId: string, retireAt: string): boolean {
    const r = this.sql
      .prepare(
        `UPDATE api_keys SET rotated_to = ?, rotated_at = ?, expires_at = ?
          WHERE tenant_id = ? AND id = ? AND revoked_at IS NULL AND rotated_to IS NULL`
      )
      .run(newId, new Date().toISOString(), retireAt, this.tenantId, oldId);
    return r.changes > 0;
  }

  countActiveApiKeys(): number {
    return (
      this.sql
        .prepare(
          `SELECT COUNT(*) AS n FROM api_keys
            WHERE tenant_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`
        )
        .get(this.tenantId, new Date().toISOString()) as { n: number }
    ).n;
  }

  stats(): Record<string, unknown> {
    const msg = this.sql
      .prepare("SELECT status, COUNT(*) AS n FROM messages WHERE tenant_id = ? GROUP BY status")
      .all(this.tenantId) as Array<{ status: string; n: number }>;
    const del = this.sql
      .prepare("SELECT state, COUNT(*) AS n FROM deliveries WHERE tenant_id = ? GROUP BY state")
      .all(this.tenantId) as Array<{ state: string; n: number }>;
    const chan = (
      this.sql.prepare("SELECT COUNT(*) AS n FROM channels WHERE tenant_id = ?").get(this.tenantId) as { n: number }
    ).n;
    const fhir = this.sql
      .prepare(
        "SELECT resource_type, COUNT(*) AS n FROM fhir_resources WHERE tenant_id = ? GROUP BY resource_type ORDER BY resource_type"
      )
      .all(this.tenantId) as Array<{ resource_type: string; n: number }>;
    return {
      channels: chan,
      messages: Object.fromEntries(msg.map((r) => [r.status, r.n])),
      deliveries: Object.fromEntries(del.map((r) => [r.state, r.n])),
      fhir: Object.fromEntries(fhir.map((r) => [r.resource_type, r.n])),
    };
  }
}
