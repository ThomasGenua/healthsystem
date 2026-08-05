# Portage

A health integration engine built for northern operating conditions. HL7 v2 in and out over MLLP, FHIR R4 over HTTP, declarative transformation, durable store-and-forward with ordered replay, and hash-chained message lineage. Zero runtime dependencies, no build step: Node 22 runs the TypeScript directly and persistence is node:sqlite.

The design targets the interoperability posture Canadian jurisdictions are converging on through Canada Health Infoway: PS-CA patient summaries, CA:FeX FHIR exchange, and CA:eReC eReferral and eConsult, operated over networks where a 5 Mbps satellite tail and a multi-hour outage are normal conditions rather than incidents. Every acknowledgement means the message is durably queued, not merely seen, and an ordered channel resumes exactly where it stopped.

## Status

v0.3.0. The v0.2.0 core (channels; MLLP, HTTP and FHIR sources; filter, split and mapping pipeline; retrying ordered destinations with DLQ and replay; hash-chained lineage; FHIR R4 facade; satellite outage demo) plus the pan-Canadian conformance layer and the operational surface: a terminology service (concepts, ValueSet expansion, ConceptMap translation, a `translate` mapping function, FHIR $lookup, $expand and $translate operations), declarative conformance packs for PS-CA, CA:FeX and CA:eReC enforced in-pipeline by a `validate.profile` step (reject or annotate), FHIR rest-hook Subscriptions riding the durable delivery queue, `filedrop` and `dbpoll` polling connectors for the SFTP-landing-directory and legacy-database patterns, a `split.hl7Group` step for multi-battery ORU messages, and a single-file no-build admin UI at `GET /`. Backend first, tests before UI: the UI landed last and consumes only the public API.

## Requirements

Node 22.18 or later. Nothing else. `npm install` is only needed if you want the dev-time type checker (`typescript`, `@types/node`).

## Quickstart

```bash
npm start
```

Boots the engine on port 8686 (override with `PORTAGE_PORT`), creates `./data/portage.db`, registers every mapping in `./mappings`, loads terminology packs from `./terminology` and conformance packs from `./conformance`, and seeds any channel in `./channels` that does not already exist in the database. Four channels ship: ADT to Patient on MLLP 6661, lab ORU to Observation on 6662 (split per OBX), ADT diagnoses to Condition on 6663 (split per DG1), and pharmacy RDE to MedicationRequest on 6664. All four deliver in strict order into the local FHIR facade, so a fresh boot is immediately queryable. The admin UI is at `http://localhost:8686/`.

Send it a message:

```bash
printf '\x0b%s\x1c\x0d' "$(cat fixtures/adt_a01.hl7)" | nc -w2 localhost 6661
```

You will get an AA acknowledgement back, and the facade serves the Patient a tick later:

```bash
curl "localhost:8686/fhir/Patient?identifier=NT123456"
curl localhost:8686/fhir/metadata
```

```bash
npm test          # 39 tests: parser, mapper, queue, ordered delivery, DLQ, facade, terminology, conformance, subscriptions, connectors, outage, e2e
npm run demo      # scripted satellite outage: store-and-forward through a dead link, ordered drain
npm run typecheck # strict type check
```

## Architecture

```
sources                 pipeline                        destinations
-------                 --------                        ------------
MLLP listener   --->    filter.hl7Type          --->    http (fetch, retry, backoff)
HTTP /ingest    --->    filter.hl7FieldEquals   --->    mllp (framed, NAK aware)
FHIR /fhir/:T   --->    filter.jsonEquals       --->    fhirstore (local facade)
filedrop dir    --->    split.hl7Group                          |
db poll cursor  --->    split.hl7Segment                        v
                        transform.mapping               GET /fhir/:Type[/:id]
                        validate.profile                rest-hook Subscriptions
                 |                              |
                 v                              v
        messages + steps                 deliveries queue
        (hash chained)                   (ordered, replayable)
```

Everything flows through `Engine.ingest`, which is deliberately synchronous: the raw message is stored on the channel's hash chain, the pipeline runs with every step recorded (a pipeline carries a set of payloads: filters narrow it, the split steps widen it, transforms map it one to one, `validate.profile` gates or annotates it), and one durable delivery row is enqueued per payload per destination, all before the source is acknowledged. An MLLP AA therefore certifies durability. Transform failures return AE with the error recorded on the message.

The delivery worker wakes on a short tick, claims due deliveries, and honours ordering: an ordered destination will not release a message while any earlier message for that destination is queued, in flight, or dead-lettered. A dead head of line is resolved by replaying it (after fixing the fault) or discarding it, either of which releases the queue. Failures back off exponentially per destination configuration and dead-letter after `maxAttempts`.

### Layout

```
src/
  types.ts            channel, mapping, message and delivery types
  db.ts               node:sqlite schema, hash chain, queue queries
  core/engine.ts      channel lifecycle and ingest pipeline
  core/queue.ts       delivery worker, retry, backoff, ordered gating
  hl7/parser.ts       ER7 parser, path addressing, escapes, ACK, serializer
  hl7/mllp.ts         MLLP framing, TCP server and client
  transform/mapper.ts declarative mapping engine and function library
  terminology/store.ts     concepts, ValueSet expansion, ConceptMap translation
  conformance/validator.ts declarative profile rules and capability self-check
  fhir/store.ts       versioned FHIR resource store behind the facade
  fhir/subscriptions.ts    rest-hook subscriptions on the durable queue
  api/admin.ts        admin, ingest, terminology, conformance and FHIR API
  api/ui.html         single-file admin UI served at GET /
  server.ts           entry point, seeds channels, mappings, terminology, conformance
channels/             channel configurations seeded at boot
mappings/             mapping documents registered at boot
terminology/          terminology packs loaded at boot (labelled demo subset shipped)
conformance/          conformance packs registered at boot (ps-ca, ca-fex, ca-erec)
fixtures/             synthetic HL7 test messages and conformance fixtures
demo/                 satellite link simulator, Meridian endpoint simulator, scripted demo
test/                 node:test suites
```

## Channels

A channel is JSON: a source, an optional pipeline, and one or more destinations.

```json
{
  "id": "adt-to-fhir-patient",
  "name": "ADT feed to FHIR Patient",
  "source": { "type": "mllp", "port": 6661 },
  "pipeline": [
    { "type": "filter.hl7Type", "allow": ["ADT^A01", "ADT^A04"] },
    { "type": "transform.mapping", "mapping": "adt-patient" }
  ],
  "destinations": [
    {
      "id": "fhir-store",
      "type": "http",
      "url": "http://localhost:9090/fhir/Patient",
      "ordered": true,
      "maxAttempts": 10,
      "backoffBaseMs": 2000,
      "backoffCapMs": 300000
    }
  ]
}
```

Sources: `mllp` (port, host; port 0 binds ephemeral), `http` (POST /ingest/:path), `fhir` (POST /fhir/:resourceType with resource type validation), `filedrop` (poll a landing directory: dir, pattern, pollMs, archiveDir; files ingest in name order), `dbpoll` (poll a SQLite database: query with a single ? bound to the persisted cursor, cursorColumn, pollMs).

Pipeline steps: `filter.hl7Type` (MSH-9 allow list), `filter.hl7FieldEquals` (HL7 path equality), `filter.jsonEquals` (JSON path equality), `split.hl7Segment` (one output per instance of a repeating segment: an ORU with three OBX becomes three messages; zero instances filters the message), `split.hl7Group` (one output per anchor segment, each carrying the shared header plus everything up to the next anchor: a two-battery ORU becomes two messages that keep their own OBX and NTE children), `transform.mapping` (registered mapping id or inline document), `validate.profile` (validate JSON payloads against a conformance pack; reject fails the message, annotate records the issues and passes it through). Filtered messages are stored and acknowledged but produce no deliveries.

Destinations: `http` (url, method, headers, contentType, timeoutMs), `mllp` (host, port, timeoutMs; a remote MSA AE or AR is treated as failure) and `fhirstore` (no endpoint: upserts into the local facade store). All take `maxAttempts`, `backoffBaseMs`, `backoffCapMs`, `ordered`, `skipOnDead`.

## Mappings

A mapping is an ordered list of operations against an HL7 or JSON input, writing a JSON output.

```json
{ "set": "name[0].family", "from": "PID-5.1" }
{ "set": "birthDate", "from": "PID-7", "fn": "hl7date" }
{ "set": "gender", "from": "PID-8", "fn": "mapCode", "args": { "table": { "M": "male", "F": "female" }, "other": "unknown" } }
{ "set": "deceasedBoolean", "value": true, "when": { "path": "PID-30", "equals": "Y" } }
```

HL7 paths address segment, repetition, field, component and subcomponent: `PID-5.1`, `PID-3[2].4`, `NK1[2]-2`, `MSH-9.2`. Empty resolved values never write, so absent fields never emit nulls. Functions: `trim`, `upper`, `lower`, `number`, `hl7date`, `default`, `mapCode`, `translate` (ConceptMap translation through the terminology store; args map, system, targetSystem, result code or display), `concat`.

## API

```
GET    /api/health                          liveness and counters
GET    /api/channels                        channels with runtime state and bound ports
POST   /api/channels                        create or replace a channel
GET    /api/channels/:id                    configuration
DELETE /api/channels/:id                    stop and remove
GET    /api/messages?channel_id=&status=    browse (raw redacted in lists)
GET    /api/messages/:id                    full message with steps and deliveries
GET    /api/deliveries?channel_id=&state=   browse; state=dead is the DLQ
POST   /api/deliveries/:id/replay           requeue a dead, delivered or discarded delivery
POST   /api/deliveries/:id/discard          discard a dead delivery, releasing ordered flow
GET    /api/chain/verify?channel_id=        walk and verify the hash chain
POST   /ingest/:path                        ingest into an http source channel
POST   /fhir/:resourceType                  ingest into matching fhir source channels

GET    /fhir/metadata                       R4 CapabilityStatement for the facade
GET    /fhir/:Type?identifier=&_count=      search stored resources by identifier token
GET    /fhir/:Type/:id                      read one stored resource; a miss is an OperationOutcome

GET    /api/terminology/lookup|expand|translate|stats
GET    /fhir/CodeSystem/$lookup             FHIR terminology operations over the same store
GET    /fhir/ValueSet/$expand?url=
GET    /fhir/ConceptMap/$translate?code=&target=
GET    /api/conformance/packs               registered pack listing
POST   /api/conformance/validate            {pack, resource} -> ok, errors, OperationOutcome
GET    /api/conformance/capability?pack=    facade CapabilityStatement self-check
GET    /fhir/Subscription                   list subscriptions (searchset Bundle)
POST   /fhir/Subscription                   create a rest-hook subscription (201)
GET    /fhir/Subscription/:id               read one
DELETE /fhir/Subscription/:id               remove one
GET    /                                    admin UI (single file, no build step)
```

## FHIR facade

Channels that end in a `fhirstore` destination feed a local R4 store that the API serves back read-only. Versioning is content-addressed: an upsert that changes nothing keeps its `versionId`, a change increments it, so replaying an interface is idempotent at the facade. Resources arriving without an `id` get a deterministic one derived from their first identifier, so repeated ADT updates for the same health card number converge on one Patient instead of minting duplicates. The default resource set mirrors the Meridian Health FHIR server (Patient, Condition, Observation, MedicationRequest); any other valid R4 resource type is stored and served the same way.

```bash
curl localhost:8686/fhir/metadata
curl "localhost:8686/fhir/Patient?identifier=https://ehealth.gov.nt.ca/fhir/NamingSystem/nwt-hcn|NT123456"
curl "localhost:8686/fhir/Observation?identifier=FL9001-NT123456-1-718-7"
```

## Satellite demo

`npm run demo` stands up the whole story in one process: a Meridian endpoint simulator playing the territorial EHR, a satellite link simulator with latency, jitter and a hard outage, and a Portage channel carrying community ADT through the link.

```
[community EMR feed] --MLLP--> Portage --HTTP over satlink--> Meridian (territorial EHR)
```

Phase A sends admissions across a healthy link. Phase B cuts the link and keeps sending: every message is still acknowledged AA, because an AA certifies durable queueing rather than remote delivery, and the queue grows. Phase C restores the link and the backlog drains in strict arrival order with zero loss and zero duplicates, then the hash chain is verified. Tune it with `--messages-before`, `--messages-during`, `--outage-ms`, `--latency-ms`, `--jitter-ms`. The same scenario runs compressed inside the test suite in `test/demo.test.ts`, and `demo/satlink.ts` and `demo/meridian-sim.ts` both run standalone for manual testing against a live instance.

## Terminology

The terminology store holds code system concepts, ValueSet memberships and ConceptMap entries in the same SQLite database, loaded from JSON packs in `./terminology` at boot. The shipped pack is a clearly labelled demo subset: SNOMED CT CA, LOINC, pCLOCD, ICD-10-CA and CCI are licensed distributions that an operator loads through the same pack format under their own licence. Mappings reach the store through the `translate` function, conformance rules through `valueSetRef`, and consumers through plain endpoints and FHIR operations:

```bash
curl "localhost:8686/fhir/ConceptMap/\$translate?code=J45&target=http://snomed.info/sct"
curl "localhost:8686/fhir/ValueSet/\$expand?url=lab-codes-demo"
curl "localhost:8686/api/terminology/lookup?system=http://loinc.org&code=718-7"
```

## Conformance packs

`./conformance` ships three packs: `ps-ca` (patient summary profiles for Patient, Observation, Condition and MedicationRequest), `ca-fex` (bundle shape plus a CapabilityStatement self-check that the facade serves read and search for the exchanged types) and `ca-erec` (eReferral ServiceRequest rules). A pack is data: paths with cardinality, fixed values, patterns, code sets, ValueSet references and per-element required keys, so tightening a profile toward the published specifications is an edit, not a release. Enforcement is a pipeline step:

```json
{ "type": "validate.profile", "pack": "ps-ca", "mode": "reject" }
```

reject fails the message, which surfaces as an AE at an MLLP source with the first issue in the acknowledgement; annotate records the issues on the message step and passes the payload through, the honest setting while a feed is being cleaned up. The same validation runs on demand at `POST /api/conformance/validate`, and the pipeline test proves the mapped output of the shipped ADT channel passes `ps-ca` while a gutted PID is rejected with named issues.

## Subscriptions

`POST /fhir/Subscription` with a rest-hook channel registers a consumer. A change in the facade store (created or updated; an unchanged upsert never notifies, because versioning is content-addressed) enqueues one delivery per matching active subscription on the same durable queue as everything else, so notifications get retry with backoff, dead-lettering, replay and strict per-subscription ordering, and they survive a restart. Criteria is a resource type with an optional identifier token: `Observation`, `Patient?identifier=NT123456`, or `Patient?identifier=system|value`.

## Connectors

`filedrop` polls a landing directory, ingests each file as one message in filename order, then archives or deletes it. This is the working SFTP pattern for northern sites: openssh terminates the transfer into the directory and Portage takes it from there, so there is no bespoke protocol code to certify. `dbpoll` polls a SQLite database with a cursor bound into the query (`SELECT * FROM results WHERE id > ? ORDER BY id`); the cursor persists in the engine database, so a restart resumes exactly where it stopped. Both are engine sources, so everything downstream (pipeline, lineage, ordered delivery, replay) is identical to a socket feed.

## Admin UI

`GET /` serves a single-file, no-build UI over the public API: a dashboard with live counts, channels with hash-chain verification, a message browser with per-step lineage, the delivery queue with dead-letter replay and discard, a FHIR facade browser, subscription management, terminology lookups and a conformance validator. It is deliberately thin; anything it does, curl does.

## Roadmap

- Automatic profile validation on facade writes (validate.profile currently runs in-pipeline and on demand through the API)
- Projectathon readiness: pack tightening against the published PS-CA, CA:FeX and CA:eReC test scripts
- Licensed terminology release loaders: SNOMED CT CA, LOINC, pCLOCD, ICD-10-CA and CCI ingested from their distribution formats into the pack store
- Native SFTP client, Postgres and MySQL pollers, cron-style scheduled pollers
- Richer link simulation: packet loss and bandwidth shaping on top of the latency, jitter and outage model in demo/satlink.ts
- mTLS between nodes, OAuth 2.0 and SMART on FHIR for API consumers, Entra ID integration
- Admin UI second round: channel designer, mapping editor with live fixtures, dashboards over history
