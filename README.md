# Northstar

A health integration engine built for northern operating conditions. HL7 v2 in and out over MLLP, FHIR R4 over HTTP, declarative transformation, durable store-and-forward with ordered replay, and hash-chained message lineage. No build step: Node runs the TypeScript directly and persistence is node:sqlite.

The design targets the interoperability posture Canadian jurisdictions are converging on through Canada Health Infoway: PS-CA patient summaries, CA:FeX FHIR exchange, and CA:eReC eReferral and eConsult, operated over networks where a 5 Mbps satellite tail and a multi-hour outage are normal conditions rather than incidents. Every acknowledgement means the message is durably queued, not merely seen, and an ordered channel resumes exactly where it stopped.

## Contents

**Getting started** — [Status](#status) · [Requirements](#requirements) · [Quickstart](#quickstart)

**The clinical platform** — [The clinical record](#the-clinical-record) · [The inbox](#the-inbox) · [Closing referral loops](#closing-referral-loops) · [Orders and results](#orders-and-results) · [Medications](#medications) · [The clinician workspace](#the-clinician-workspace) · [Scheduling](#scheduling) · [Registries and care gaps](#registries-and-care-gaps)

**Privacy and access** — [Security](#security) · [Encryption at rest](#encryption-at-rest) · [Key lifecycle](#key-lifecycle) · [Audit trail](#audit-trail) · [Patient access](#patient-access) · [Consent directives and breaking glass](#consent-directives-and-breaking-glass) · [The clinical API, and audit by construction](#the-clinical-api-and-audit-by-construction) · [The privacy office](#the-privacy-office) · [Retention](#retention) · [What the chains prove](#what-the-chains-prove) · [Tenancy](#tenancy)

**Running it** — [Runbook](docs/RUNBOOK.md) · [Clinical safety](docs/CLINICAL-SAFETY.md) · [Provincial gap map](docs/PROVINCIAL.md) · [Upgrading](#upgrading) · [Backup](#backup) · [Monitoring](#monitoring) · [Throughput](#throughput) · [Durability under failure](#durability-under-failure) · [Crash recovery](#crash-recovery)

**Project** — [Changelog](CHANGELOG.md) · [Security policy](SECURITY.md) · [Licence](#licence) · [Contributing](#contributing)

**Reference** — [Architecture](#architecture) · [Laboratory profiles](labs/README.md) · [Channels](#channels) · [Character sets](#character-sets) · [Mappings](#mappings) · [API](#api) · [FHIR facade](#fhir-facade) · [Terminology](#terminology) · [Conformance packs](#conformance-packs) · [Subscriptions](#subscriptions) · [Connectors](#connectors) · [Admin UI](#admin-ui) · [Loading a licensed terminology release](#loading-a-licensed-terminology-release) · [Satellite demo](#satellite-demo) · [Roadmap](#roadmap)

## Status

v0.7.0. The v0.3.0 core (channels; MLLP, HTTP, FHIR, filedrop and dbpoll sources; filter, split, mapping and validation pipeline; retrying ordered destinations with DLQ and replay; hash-chained lineage; FHIR R4 facade; terminology service; PS-CA / CA:FeX / CA:eReC conformance packs; rest-hook Subscriptions; satellite outage demo; admin UI) plus:

- **Authentication and authorisation.** API keys and OAuth 2.0 / SMART on FHIR bearer tokens, three system scopes plus a separate OAuth-only patient scope, one gate ahead of every route. On by default.
- **Mutual TLS**, for node-to-node links, inbound and outbound.
- **Conformance validation on facade writes**, not only in-pipeline and on demand.
- **Native SFTP, Postgres and MySQL sources**, and cron scheduling for any polling source.
- **Terminology release loaders** for SNOMED CT RF2, LOINC CSV and the classification tables.
- **Packet loss and bandwidth shaping** in the link simulator.
- **Admin UI second round**: channel designer, mapping editor with live fixtures, history dashboards, access audit.
- **Hash-chained access audit**, answering who read whose record and who was refused.
- **Retention**, redacting stored payloads on a policy while leaving the chain verifiable.
- **Rate limiting**, closing the flood-the-audit-trail vector the audit work opened.
- **Verified online backup**, and health signals a monitor can alert on.
- **One engine per database**, enforced, so an overlapping deploy cannot silently duplicate messages.
- **In-place schema migration**, so upgrading an existing database does not take the node off the air.
- **Truncation-resistant chains**, so deleting the most recent entries no longer verifies clean.
- **Subscriptions behind `admin`**, so a push-only feed credential cannot arrange to receive the clinical record.
- **Character sets honoured on the wire**, so an accented or syllabic name is not silently replaced with question marks.
- **Silent-feed detection**, so an interface that stopped sending is not mistaken for a quiet night.
- **Multi-tenant end to end**: structural isolation in storage, checked by reading the source, and every request confined to its credential's custodian.
- **Purpose of use** on the audit trail, inside the hash chain.
- **An append-only clinical record**, where a correction cannot destroy what it corrects.
- **A patient index** derived from the log and rebuildable from it, surfacing duplicates rather than merging them.
- **Clinical documentation** where a signature fixes the text and only an addendum may follow.
- **A unified inbox** where work cannot be closed without evidence or left belonging to nobody unseen.
- **Closed-loop referrals**, where a deadline passes with nothing happening and the referral appears on a chase list rather than going quiet.
- **Results whose acknowledgement cannot be inherited**, so a corrected value never arrives already signed off by somebody who read the old one.
- **A medication list that says what the patient is taking**, and an allergy check that reports "nobody asked" rather than "no contraindications".
- **A chart summary that declares what it could not include**, because a summary is read as complete and an empty panel is not the same as none.
- **A clinical API that cannot serve patient data unaudited**, checked by reading the routing source rather than by remembering.
- **Proxy access that lapses on the day it was set to**, because nothing about a child's sixteenth birthday generates an event.
- **Quality measures that refuse a rate they cannot stand behind**, because the patients a measure cannot assess are the ones nobody managed.
- **Double-booking refused by the database**, not by a check that a second clerk can race past.
- **Break-glass that is loud**: declared before the access, reasoned in words, and held in queues an operator can read and has to discharge — because a quiet override makes the lockbox theatre.
- **A clinician console** — chart, worklist and break-glass queues — where a panel that failed, one that was cut short, and one the patient locked are three visibly different things rather than three empty boxes.
- **A lockbox that can cover part of a chart**, where the locked panel says a directive withheld it rather than rendering as "none" — so a patient can withhold one section without taking the rest of their chart away from the clinician treating them.
- **A restore that has actually been rehearsed**, to somewhere the database has never been, with a measured RTO — because a verified snapshot only proves the bytes hashed correctly when they were written.
- **A snapshot that leaves the machine**, encrypted, put, read back and walked again, so the stated RPO is not only for failures that spare the backup directory.
- **A chart that can say whether anyone asked about immunizations, took a vital, recorded a procedure, wrote a care plan or received a document the patient supplied**, and that names a primary provider and a coverage claim without overwriting the last ones. Blood pressure is two numbers; a completed procedure needs a date; a care plan needs a goal and a review date; a letter the patient brought in is not a SOAP note; a second current MRP is refused; today's appointments and overdue care plans sit on the worklist. This is still not a provincial EMR — see [docs/PROVINCIAL.md](docs/PROVINCIAL.md).
- **Durable patient–clinic messaging.** A question is a thread that cannot be deleted. Closing it needs a reason. Awaiting the clinic and belonging to nobody are lists. This is not a portal and not a claim that anything was delivered.
- **Clinic-attested enrolment, and notices that are fact rather than the chart.** A named clerk writes how they checked identity (twelve characters, same bar as breaking glass) before an OAuth subject is bound. A pending row is not a grant. Completing an access request queues a notice onto the same channel as break-glass; dispatching it is not recording that the patient was told. Not identity-proofing, not ONE ID, not a certified portal.
- **An OAuth-only patient/proxy API.** A patient-context SMART token cannot read the general FHIR facade; every chart is authorized again through an active grant with explicit scope, purpose and expiry. Held results, appointments, messages, access history, delegates and requests are patient-safe views, not the clinician Workspace.
- **Migration that cannot report success over a gap.** Completeness is declared and checked, not inferred from the absence of errors; rejects keep their payloads; a trial rolls back by retraction and a cutover with clinical activity refuses to.
- **A laboratory result bridge that closes the order loop**, not just a mapping onto the facade: a resend writes nothing, a correction supersedes and arrives unacknowledged, a stale preliminary is ignored, and a result whose patient cannot be identified is held for a person rather than filed against a guess. No vendor interface is claimed — see [docs/PROVINCIAL.md](docs/PROVINCIAL.md).
- **A privacy office a privacy officer can actually run.** Reviews cannot close with unaddressed flags. A legal hold skips the message-log retention sweep. An incident cannot close without saying whether patients were told. Access clocks queue; they do not hard-stop. Completing an access request without a disclosure is flagged, not blocked. The assurance catalogue cannot close a finding by forgetting the residual risk. `BACKUP-02` stays partial.
- **A patient HTML shell at `GET /me`.** Language, landmarks, an honest banner. Not a certified portal: no identity-proofing, no ONE ID, no WCAG claim, and this page does not enrol anyone. Clinic attestation is a named clerk writing how they checked. Chart access is `/patient/*` plus OAuth.
- **An access review of the trail.** `GET /api/audit/review?patient=` joins who looked to whether anything clinical linked them, with flags a person can dismiss with a reason. Complementary to the operational office: this one reads the trail; that one runs the queues.
- **Travelling clinics and a waitlist whose ordering is stated policy.** A visit is planned, repeated, moved and cancelled as one thing. Cancelling it puts every booked patient on a waitlist: priority, then waited-longest, then most-bumped. An offer resolves as accepted, declined or unreachable.
- **Channel configuration as a ledger.** Every change is a version with who, when and why. Export and import go through the same store; a dry run writes nothing; every message records which configuration processed it.
- **Chart linking that can be undone.** Two charts that may be one person are surfaced, not merged: linking is a reversible statement with an author and a reason, both charts keep their own history, and unlinking restores exactly what was there. A merge that cannot be undone is a merge that must never be wrong, and nobody can promise that.
- **A chart that stays readable when the link is down.** A reading station serves a restored, verified snapshot from the same binary, with staleness a first-class incompleteness — stamped on every panel, every response header and the console banner — a serving budget that expires and purges the cache, channels disabled so it cannot become a second engine, and offline break-glass declarations that survive the purge and are replayed onto the primary's consent and trail at reconcile. A cached chart's danger is being wrong while looking right, so it is dated from the snapshot's own stamp, never from when the copy landed.
- **Numbers that can leave the building.** `POST /api/clinical/release` turns a measure or care-gap summary into aggregate counts with small cells suppressed, complements suppressed with them, a rate withheld when it would divide the secret back out, and the method on the face of the document — because in a community of 300, "3 of 41" is a name and so is "38 of 41". No release without a recipient and a purpose, both on the chained trail.
- **What the pharmacy did with the prescription.** A dispense is its own recorded fact — full, partial, or a pharmacy reporting it was never collected — because a medication the patient never picked up is not a medication they are taking, and a chart that cannot tell those apart is misleading in the direction that causes harm. Dispense reporting is declared per pharmacy and snapshotted at transmission, so an absent record reads as `unknown` rather than as an accusation against every pharmacy that simply does not send notifications. A dispense against a cancelled prescription is recorded and surfaced rather than refused. The prescriber's safety check travels with the script, findings and overrides included; a renewal request is an item in the unified worklist, closable only with evidence.
- **A migration you can rehearse, and an extract reader that loses nothing.** `dryRun()` runs the whole load through the ordinary stores inside a transaction that is always rolled back — it *is* the loader, so it cannot approve what a real load would refuse, and nothing survives it. The FHIR Bundle and NDJSON reader skips nothing: a resource it cannot map comes back with its reason and the resource itself, one it can map but the stores refuse reaches the reject queue with its payload, and the declared count comes from the export's own `total` rather than from what happened to arrive.
- **Value sets and concept maps from real releases.** FHIR ValueSet and ConceptMap resources plus SNOMED RF2 refsets and cross-maps, replacing hand-written pack JSON. A value set that cannot be fully resolved — a filter, an exclusion, a reference this store cannot follow — refuses to import at all, because one carrying the publisher's name and a smaller membership is worse than none.
- **Risk scores that refuse an incomplete answer.** Ten instruments — CURB-65, CHA₂DS₂-VASc, HAS-BLED, Wells PE, HEART, MELD-Na, CIWA-Ar, Charlson, LACE, NEWS2 — where a missing input produces no number at all rather than a low one, because arithmetic that treats an undrawn urea as a normal one makes a patient read as safer for having been less investigated. Computed from the chart, every input carries a maximum age and a value past its window is not a value: a NEWS2 assembled from this morning's observations refuses rather than describing a patient who may since have deteriorated.
- **A laboratory conformance harness**, run against a vendor's own sample messages before anybody trusts the interface. It names the findings an integration analyst would raise — no accession number so resends cannot be told apart, two identifiers in PID-3 with nothing saying which is the health number, timestamps with no zone — and states in every report what a clean run does not establish. It never says an interface conforms.
- **Documents, procedures and care plans as chart facts rather than notes**, so their absence is visible and structured rather than a gap in prose.
- **Enrolment attested by a named clerk** who records how they checked, rather than inferred from a token.

1068 tests. Backend first, then the interface that makes the backend's honesty visible.

### What this is not

Honest limits, so nobody discovers them in production:

- **MLLP sources are unauthenticated.** The protocol has no authentication to hook into. Those ports are a network-layer concern — put them behind a VPN, a private APN, or mutual TLS at the transport, not behind Northstar. Being unauthenticated does not mean being fragile: frames are size-capped (16 MB, `maxFrameBytes` per channel) so a sender that never terminates one cannot exhaust memory, and malformed input is answered per message rather than taking the listener down.
- **`node:sqlite` is still flagged experimental on Node 22.** Durability rests on it, so run Node 24+ in production, where it is stable. The engine warns at boot when it is running below 24; the supported floor stays at 22.18 so an upgrade breaks nobody. CI covers both.
- **The shipped terminology pack is a labelled demo subset.** SNOMED CT CA, LOINC, pCLOCD, ICD-10-CA and CCI are licensed distributions; the loaders are here, the content is not.
- **The database file is not encrypted.** `node:sqlite` cannot encrypt, so the control that fits a single-file store is an encrypted volume underneath it. Northstar does not assume one is there: it checks at boot and on `/api/health`, and says so loudly when it cannot find one. See [Encryption at rest](#encryption-at-rest).
- **The conformance packs are not certified.** They encode the published profiles as data and pass the shipped fixtures, but no projectathon has scored them.
- **The clinician interface is thin, and most of the platform is API-only.** The admin UI now carries a chart, a worklist, break-glass and the privacy inbox, and there is a patient access page in English and French. Everything else described below — medications, orders, referrals, scheduling, registries, procedures, care plans, documents, enrolment — is a store and an HTTP API with tests and no screen. This is deliberate ordering, not an oversight, but "a clinician can run their day in this" is not a claim being made. It has also not had independent clinical-usability, human-factors or accessibility validation, so "a clinician can safely use this in production today" is not a claim being made either.
- **No certified patient portal.** `GET /me` is chrome: English/French copy, a skip link, landmarks, and a banner that says what this page is not. It does not enrol anyone. The JSON patient/proxy boundary is mounted at `/patient/*`; it is OAuth-only and checks a live, explicitly scoped authority grant on every chart. Binding a subject is clinic-attested enrolment — a named person writes how they checked — not identity-proofing and not ONE ID. Notices publish fact onto a configured channel; dispatching is not telling. There is no WCAG or AODA claim. A shell people can open is not a portal people can use.
- **No broad medication decision-support content.** The medication safety mechanism is here — the check, the severities, the override with its record — and ships a deliberately small cross-reactivity set covering the classes with the clearest consensus. Drug interactions come from a licensed database through the `InteractionSource` seam. An interaction table that is 80% complete is one prescribers learn to trust, and the missing 20% is then invisible. Ten deterministic published risk instruments are implemented separately; each response names its source, formula version, intended population, units and unreviewed assurance state. They are implementation-tested, not independently clinically validated.
- **Nothing here uses machine learning.** Section 7 of the requirements asks for it; nothing in this repository does anything of the sort, and no output should be read as though it did.

## Requirements

Node 22.18 or later; Node 24+ recommended in production (see above). No required runtime dependencies.

Optional, and only if you use the source that needs it: `pg` for a Postgres poller, `mysql2` for MySQL, `ssh2-sftp-client` for SFTP. They are declared as `optionalDependencies` and imported lazily, so an operator who never polls Postgres never installs it. `npm install` also fetches the dev-time type checker.

## Quickstart

```bash
npm start
```

Boots the engine on port 8686 (override with `NORTHSTAR_PORT`), creates `./data/northstar.db`, registers every mapping in `./mappings`, loads terminology packs from `./terminology` and conformance packs from `./conformance`, and seeds any channel in `./channels` that does not already exist in the database. Four channels ship: ADT to Patient on MLLP 6661, lab ORU to Observation on 6662 (split per OBX), ADT diagnoses to Condition on 6663 (split per DG1), and pharmacy RDE to MedicationRequest on 6664. All four deliver in strict order into the local FHIR facade, so a fresh boot is immediately queryable. The admin UI is at `http://localhost:8686/`.

**The API is authenticated by default.** With no key configured, one is minted at boot and printed once:

```
  No API key existed, so one was issued for this instance:

    ptg_EXAMPLEKEYxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

  This is the only time it is shown. Store it now.
```

Paste it into the admin UI's key box, or send it as `Authorization: Bearer …`. See [Security](#security) to turn it off for local work, or to use an identity provider instead.

Send it a message:

```bash
printf '\x0b%s\x1c\x0d' "$(cat fixtures/adt_a01.hl7)" | nc -w2 localhost 6661
```

You will get an AA acknowledgement back, and the facade serves the Patient a tick later:

```bash
curl -H "Authorization: Bearer $KEY" "localhost:8686/fhir/Patient?identifier=NT123456"
curl localhost:8686/fhir/metadata          # open: a discovery document
```

```bash
npm test          # 1068 tests
npm run demo      # scripted satellite outage: store-and-forward through a dead link, ordered drain
npm run typecheck # strict type check
```

## Security

Two credential schemes, either or both, chosen with `NORTHSTAR_AUTH_MODE`:

| value | meaning |
|---|---|
| `apikey` | **default.** API keys. One is minted and printed at first boot if none exists. |
| `oauth` | OAuth 2.0 / SMART on FHIR bearer tokens verified against an identity provider's JWKS. |
| `apikey+oauth` | both accepted |
| `off` | no authentication; logs a warning at boot |

Four scopes. The first three are system scopes; `patient` is a separate trust boundary:

| scope | reaches |
|---|---|
| `admin` | `/api/*`: channels, messages, the delivery queue, keys. Also `/fhir/AuditEvent` and `/fhir/Subscription`. Implies `read` and `write`, never `patient`. |
| `read` | `GET /fhir/*` and the terminology and conformance lookups, except `/fhir/AuditEvent` and `/fhir/Subscription` |
| `write` | `POST /ingest/:path`, `POST /fhir/:resourceType` |
| `patient` | `/patient/*`, OAuth only, then narrowed again by the subject's live `patient_authority` grant |

A SMART `patient/*.read` token maps only to `patient`. It does **not** map to `read`: doing that would let a patient-context token query every Patient on the general FHIR facade. API keys cannot be issued the patient scope. Authentication-off mode still refuses `/patient/*`; the synthetic anonymous principal never becomes a patient.

Two things under `/fhir/` are not clinical traffic and sit with the operator rather than the consumer. `AuditEvent` records who looked at whom, so read access to the facade must not also disclose the access history of everyone in it. `Subscription` is a standing instruction to send patient records to an address — a routing decision of the same kind `POST /api/channels` makes. Left under the general `/fhir/` rule it needed only `write`, which is exactly what a feed is given, so the credential a lab uses to file results could have registered a rest-hook of its own and turned push-only access into a continuous read of the record. See [Subscriptions](#subscriptions).

Open without credentials, by design: the admin UI shell, the patient HTML shell at `GET /me` (static chrome, no PHI), `GET /api/health`, and `GET /fhir/metadata` — a CapabilityStatement is a discovery document, and a client has to read it to learn how to authenticate against everything else. Any unrecognised path defaults to requiring `admin`, so a route added later fails closed.

### API keys

32 random bytes behind a `ptg_` prefix. Only the SHA-256 is stored, so a copy of the database yields no working credentials and a lost key can be replaced but never recovered.

```bash
curl -X POST localhost:8686/api/keys -H "Authorization: Bearer $KEY" \
  -H 'content-type: application/json' \
  -d '{"name":"lab-feed","scopes":["write"]}'      # the response is the only time the key is shown

curl localhost:8686/api/keys -H "Authorization: Bearer $KEY"          # metadata only, never keys
curl -X DELETE localhost:8686/api/keys/:id -H "Authorization: Bearer $KEY"
```

### OAuth 2.0 and SMART on FHIR

```bash
NORTHSTAR_AUTH_MODE=oauth \
NORTHSTAR_OIDC_ISSUER=https://login.microsoftonline.com/<tenant>/v2.0 \
NORTHSTAR_OIDC_AUDIENCE=api://northstar \
npm start
```

The JWKS is discovered from the issuer (`NORTHSTAR_OIDC_JWKS` overrides) and cached. Signature, issuer, audience and expiry are all checked; the permitted algorithms are a fixed table keyed off the token header, so `alg: none` is refused before any key material is touched. Works against any OIDC provider — Entra ID, Keycloak, Auth0 — nothing here is provider-specific.

SMART scopes are translated rather than requiring Northstar-specific scope names in your identity provider. Both v1 (`.read`, `.write`, `.*`) and v2 (`.rs`, `.cud`, `.cruds`) verb syntax are understood:

| token scope | grants |
|---|---|
| `system/Patient.read`, `system/Observation.rs` | `read` |
| `system/Patient.write`, `system/Patient.cud` | `write` |
| `system/*.*` | `read` + `write` |
| `northstar/admin` | `admin` |

### Mutual TLS

For links between nodes there is no browser, no user and no consent flow — just two hosts that must each prove what they are, so a client certificate is the practical answer.

```bash
./scripts/gen-dev-certs.sh                 # self-signed CA, server and client certs, for development

NORTHSTAR_TLS_CERT=certs/server.crt \
NORTHSTAR_TLS_KEY=certs/server.key \
NORTHSTAR_TLS_CLIENT_CA=certs/ca.crt \
npm start

curl --cacert certs/ca.crt --cert certs/client.crt --key certs/client.key \
     https://localhost:8686/api/health
```

Setting `NORTHSTAR_TLS_CLIENT_CA` turns on `requestCert` and `rejectUnauthorized`, so an untrusted caller is refused during the handshake and never reaches the router. That is transport-level proof of *which host* is calling; the scope check above is application-level proof of *what it may do*. Both apply. Half-configured TLS throws at startup rather than quietly serving plaintext.

Outbound destinations can present a client certificate too, which routes that delivery through `node:https` since `fetch` cannot carry one:

```json
{ "type": "http", "url": "https://meridian.gov.nt.ca/fhir/Patient",
  "tls": { "certPath": "/etc/northstar/client.crt", "keyPath": "/etc/northstar/client.key",
           "caPath": "/etc/northstar/ca.crt" } }
```

### Rate limiting

On by default. Two reasons, and the second is the sharper one:

An engine on a 5 Mbps satellite tail has very little headroom, and a client retrying in a tight loop can saturate the link the queue is trying to drain through — turning one misbehaving consumer into an outage for a whole community site.

And every refused request to a patient-data path writes a row to the audit trail. That is the right behaviour, but it means an unauthenticated caller could grow the database by hammering the facade. Without a limit, the control that records intrusion attempts becomes the way to exhaust the disk. Measured: 80 anonymous requests against a 20/min limit produce 41 audit rows, of which exactly **one** records the flood — not 80.

A token bucket, so a real client's burst is admitted and a sustained flood is not. Counted per principal for a credentialed caller and per source address otherwise, so one noisy anonymous client cannot spend a credentialed feed's budget. Requests on public routes, and every request when authentication is off, count per source — they all resolve to the same synthetic anonymous principal, and pooling them would be no protection at all.

| variable | default | meaning |
|---|---|---|
| `NORTHSTAR_RATE_AUTHENTICATED` | 1200/min | sustained rate for a credentialed caller |
| `NORTHSTAR_RATE_ANONYMOUS` | 120/min | sustained rate per source address |
| `NORTHSTAR_RATE_LIMIT=off` | — | disable entirely; warns at boot |

A refusal returns `429` with `Retry-After`. Counters are in memory, matching the single-writer design: a Northstar node is one process, and sharing limits across nodes would need shared state.

### Environment

| variable | default | meaning |
|---|---|---|
| `NORTHSTAR_PORT` | 8686 | API port |
| `NORTHSTAR_DATA` | `./data` | database directory |
| `NORTHSTAR_CHANNELS` / `_MAPPINGS` / `_TERMINOLOGY` / `_CONFORMANCE` / `_FIXTURES` | `./<name>` | boot-time load directories |
| `NORTHSTAR_AUTH_MODE` | `apikey` | `apikey`, `oauth`, `apikey+oauth`, `off` |
| `NORTHSTAR_OIDC_ISSUER` / `_AUDIENCE` / `_JWKS` | — | OAuth 2.0 configuration |
| `NORTHSTAR_TLS_CERT` / `_KEY` | — | serve over TLS |
| `NORTHSTAR_TLS_CLIENT_CA` | — | require a client certificate signed by this CA |
| `NORTHSTAR_VALIDATE_PACK` / `_MODE` | — | conformance pack enforced on every facade write |
| `NORTHSTAR_REDACT_AFTER_DAYS` | — | replace stored payloads older than this with a tombstone |
| `NORTHSTAR_PURGE_AFTER_DAYS` | — | delete messages older than this outright |
| `NORTHSTAR_RATE_AUTHENTICATED` / `_ANONYMOUS` / `NORTHSTAR_RATE_LIMIT` | 1200 / 120 / on | request rate limits |
| `NORTHSTAR_BACKUP_DIR` / `_KEEP` | `./backups` / 7 | where POST /api/backup writes locally, and how many to keep |
| `NORTHSTAR_BACKUP_REMOTE` | — | off-machine destination: `s3://bucket/prefix`, `sftp://user@host/path`, or `fs:/absolute/path` |
| `NORTHSTAR_BACKUP_KEY_FILE` | — | 32-byte key (raw or 64 hex chars) that encrypts every remote copy. Must survive this machine. |
| `NORTHSTAR_BACKUP_REMOTE_KEEP` | — | how many remote snapshots to keep; independent of local `_KEEP`. Unset means do not prune. |
| `NORTHSTAR_BACKUP_S3_ENDPOINT` / `_REGION` / `_ACCESS_KEY` / `_SECRET_KEY` | — | S3-compatible API. HTTPS required except on loopback. Falls back to `AWS_*`. |
| `NORTHSTAR_BACKUP_SFTP_PASSWORD` / `_KEY` / `_PASSPHRASE` | — | SFTP credentials when the destination is `sftp://` |

## Encryption at rest

`node:sqlite` has no encryption. The database is one file, so the control that fits is full-volume encryption underneath it — LUKS, FileVault, BitLocker, an encrypted cloud volume. SQLCipher would mean a native dependency and a key-management story this project does not have, and column-level encryption would break the patient index, which has to search on names and identifiers.

That decision is defensible. What is not defensible is the usual consequence of it: *encryption at rest* becomes a line in a procurement document and an assumption in a diagram, nothing checks, and then the test environment is promoted, or the volume is recreated during an incident, or the data directory moves to a mount nobody thought about — and the system carries on exactly as before, with every chart, allergy, result and audit row in the clear.

So Northstar refuses to be quiet about it. At boot:

```
WARNING: /var/lib/northstar is on /dev/vda1, which does not appear to be encrypted.
The database holds charts, allergies, results and the audit trail in plain text;
an encrypted volume is the control that fits a single-file store. If the volume is
encrypted somewhere this cannot see — a hypervisor or a cloud volume — set
NORTHSTAR_ENCRYPTED_AT_REST=yes to record that.
```

and on `/api/health` as `atRest`, so a monitor can alert on it.

Four states, and the distinctions are the point:

| | |
| --- | --- |
| `encrypted` | the data directory resolves to a device-mapper volume |
| `not-encrypted` | it resolves to a plain block device |
| `unknown` | the check could not answer — not Linux, no mount found, or a path that would not resolve |
| `asserted` | an operator set `NORTHSTAR_ENCRYPTED_AT_REST=yes` |

`unknown` is never folded into either answer, and an assertion is recorded as an assertion rather than as a finding — a LUKS volume presented by a hypervisor and an encrypted EBS volume both look like plain block devices from inside, so an operator has to be able to say so, and what they said must stay distinguishable from something this verified.

Only `encrypted` and `asserted` stop the warning.

## Key lifecycle

A credential that never expires and that nobody reviews is the ordinary way long-lived access outlives its reason. The contractor's integration key still works. The pilot that ended two years ago still has one. Nothing anywhere says so — and a key issued for a purpose that finished is indistinguishable from one somebody else is quietly using.

Three things address that, none relying on anyone remembering:

- **Expiry is checked at verification, against the clock.** A key that expired last night does not work this morning whether or not anything has restarted. `expires_at` is optional and has no default, so a non-expiring key is a choice somebody made.
- **Rotation overlaps.** `POST /api/keys/:id/rotate` issues a replacement and gives the old key a retirement date — both work in between. A rotation that cut the old key off the instant the new one existed would make every rotation an outage between issuing the credential and deploying it, which is exactly why rotation gets deferred and then skipped. The old key's retirement is a **date**, not a follow-up task, so the overlap ends on its own; two working credentials where there should be one is worse than not having rotated.
- **`GET /api/keys/review`** answers the two questions a list of keys cannot: which nobody is using, and which are about to stop working.

A key **never used at all** is dormant from the day it was issued, and is reported by age rather than skipped for having no last-used date — that shape is exactly the one left by a key pasted into a ticket and never deployed. Revoked and already-expired keys stay off the list, because padding a list somebody has to act on is how it stops being acted on.

## Audit trail

Canadian health privacy law — PHIPA in Ontario, HIA in Alberta, the Health Information Act in the territories — obliges a custodian to know who looked at whose record. Northstar holds patient data in the facade and raw HL7 in the message log, so it answers that question.

```bash
curl "localhost:8686/api/audit?patient=NT123456" -H "Authorization: Bearer $KEY"   # who read this record
curl "localhost:8686/api/audit?failures=true"    -H "Authorization: Bearer $KEY"   # who was turned away
curl "localhost:8686/api/audit/verify"           -H "Authorization: Bearer $KEY"   # has the trail been altered
curl "localhost:8686/api/audit/review?patient=NT123456" -H "Authorization: Bearer $KEY"  # who looked, and whether they had a reason to
curl "localhost:8686/fhir/AuditEvent"            -H "Authorization: Bearer $KEY"   # the same, as R4 AuditEvent
```

**What is recorded.** Disclosure is the event that matters, so every read of patient data is: a facade read or search, and any look at a raw message, since an ER7 message identifies a patient as surely as anything in the facade. A search records how many records it returned — one that discloses nine hundred is not a read. Refused attempts are recorded too, because a trail that shows only successes cannot show someone trying doors. Key issue and revocation are recorded because they change who can open them.

**What a privacy officer actually asks.** `/api/audit` answers "what rows are there". `GET /api/audit/review?patient=` answers who looked, whether anything clinical linked them to that patient, and what to look at first — self-lookup, surname match, no treatment relationship, break-glass, out-of-hours, unusual volume, or a credential that names nobody. Each flag says why it fired and can be dismissed with a reason that is kept. The chain's verification travels on the report. This is the trail half of the privacy office; the queues, holds and incidents live under `/api/clinical/privacy-*`. Credentials carry a practitioner so the join is possible.

**What is not.** Internal writes are not duplicated here. Every message already carries hash-chained lineage with its pipeline steps and deliveries, which is a stronger record than an audit line, and repeating it would bury the disclosures in routine traffic.

**Tamper evidence.** The trail is hash-chained exactly as message lineage is, so a row cannot be edited or deleted without breaking `/api/audit/verify` — including a row deleted from the end, which is the case a naive chain misses. See [What the chains prove](#what-the-chains-prove) for what that is and is not worth.

**The trail carries identifiers and references, never payloads.** An audit log that copied the record it was protecting would double the exposure it exists to detect.

**It is admin-scoped, including under `/fhir/`.** A consumer with `read` access to the facade must not also learn the access history of every patient in it — so `/fhir/AuditEvent` requires `admin`, unlike every other `/fhir/` read.

## Retention

The message log keeps every raw HL7 message it has ever received. Left alone that is both a disk problem and a liability: holding a patient's admission message for eight years because nothing deletes it is not a feature. Retention is off by default and configured in days.

```bash
NORTHSTAR_REDACT_AFTER_DAYS=30 NORTHSTAR_PURGE_AFTER_DAYS=365 npm start

curl localhost:8686/api/retention      -H "Authorization: Bearer $KEY"   # policy, and what it would touch
curl -X POST localhost:8686/api/retention/run -H "Authorization: Bearer $KEY"
```

Two controls, and the difference is the point:

**Redaction** replaces every stored copy of the payload with a tombstone. The message, its lineage, its pipeline steps and its deliveries all remain as rows, and **the hash chain still verifies in full** — because the chain commits to a digest taken at ingest rather than to the payload itself. You keep the record that a message arrived, from where, through which steps, and whether it was delivered; you lose the clinical content wherever it was held. This is almost always the right control.

"Every copy" is the load-bearing part, because the engine keeps more than one:

| where | what it holds |
|---|---|
| `messages.raw` | what arrived |
| `message_steps.output` | what each transform made of it — the same patient, another encoding |
| `deliveries.payload` | what was sent |
| `deliveries.ack` | what the remote said back, which for a FHIR create is the resource itself |
| `deliveries.last_error` | why it failed, which for a rejection quotes the value objected to |

All five are covered, in every settled delivery state including **dead** — a dead-lettered delivery waits in the queue indefinitely for an operator, which makes the DLQ the longest-lived copy in the system and the last one that should be exempt. Freed database pages are zeroed as they are released (`PRAGMA secure_delete`), so a redacted payload is not merely detached and left legible in the file for anyone holding a backup, a decommissioned disk or a VM image.

`test/retention-leak.test.ts` proves this by searching the database file for the patient's identifiers after a sweep, rather than by checking the columns the fix was written for — so a copy kept somewhere nobody thought of still fails the test.

**Purging** deletes the rows outright. It reclaims disk and destroys the record that anything happened, so the chain can only be verified from the purge point onward. The chain tip at the purge is retained, so the surviving chain still verifies and `verifiedFrom` reports where it now begins — rather than looking tampered with. Offered because operators sometimes genuinely need it, and deliberately not the default.

### What retention does not touch

Neither control reaches the FHIR facade, and neither reaches the clinical stores — the chart, medications, allergies, orders, results, referrals or tasks. Those hold **the record**, not a log of traffic, and how long a territorial EHR keeps a patient's chart is a clinical governance question, not something an interface engine should answer on a timer.

Worth stating outright, because the alternative reading is available and would be a catastrophe: *"retention is configured"* must not be heard as *"patient data ages out everywhere"*. It ages out of the message log. A patient's allergy to penicillin recorded four years ago is not stale data, and a sweep that deleted it because a number in a config file said `1095` would be destroying the record while reporting success — and it would report success, because deleting rows is exactly what it was asked to do.

An active **legal hold** on the tenant skips the sweep entirely. Messages are not patient-keyed, so there is no honest way to redact "just that patient". `test/privacy-office.test.ts` pins it.

`test/retention-boundary.test.ts` pins the line from both sides: it runs the most aggressive policy anyone would write over a fully populated chart and requires every record table to come out unchanged, and it reads the purge path's source and fails if a clinical table is ever named in a `DELETE`. Moving the boundary is then a deliberate act with a failing test attached, in either direction.

`/api/chain/verify` reports both halves of the guarantee:

```json
{ "ok": true, "checked": 500, "payloadsChecked": 120, "redacted": 380 }
```

Every link verifies; 120 rows can still prove their payload is the one the chain committed to; 380 have been redacted and can no longer. A payload put back where a redacted one was will not match its recorded digest and is caught.

## What the chains prove

Worth being exact about, because "hash-chained" is easy to read as more than it is.

**Walking the links is not enough on its own.** Verifying forward from the beginning catches an edited row, and catches a row removed from the middle, because the next row's back-pointer stops resolving. It cannot catch rows removed from the *end* — nothing survives that pointed at them, so a truncated chain is a shorter chain that verifies perfectly. This mattered: deleting an entire audit trail used to report `{ "ok": true, "checked": 0 }`, which is the one answer it must never give. Someone covering their tracks deletes the most recent entries; that is the whole shape of the attack.

Two anchors close it, neither of which the surviving rows can supply:

- **Message chains** end by comparing where the walk arrived against the tip the channel has been carrying since the last insert. A truncation reports `truncated` with both hashes, rather than a clean bill.
- **The audit trail** is append-only — a retention sweep purges messages, never the record of who read them — so its length is a fact it can be held to. `seq` is `AUTOINCREMENT`, so SQLite keeps the highest value ever issued and never lowers it on delete. Removal from anywhere, including every row at once, shows up as `missing: { expected, found }`.

A purge is not mistaken for either. It removes a prefix and never the tip, and a channel purged in its entirety keeps the tip it ended on, so a legitimately emptied channel does not read as tampered with.

**What none of this proves.** A hash chain kept in the same database as the data it attests to cannot be evidence against someone who can write to that database. They can recompute the links, move the tip, and edit `sqlite_sequence` — it is all just rows. Anyone claiming otherwise is selling something. What the chain actually buys is this:

- Accidental loss is caught. A partial restore, a truncated backup, a botched purge, a half-copied file — these are far more common than malice and every one of them shows up.
- Removal now takes more than a `DELETE`. It takes knowing the design.
- The evidence is already off the box. `/metrics` exports `northstar_audit_events_total` and `northstar_chain_length` as **counters**, so a chain that loses rows reads as a counter reset in whatever is scraping — which is the one record of the chain's history the engine does not control.

That last one is the control that survives an adversary with database access, and it is the reason to point a monitoring system at this rather than to trust `ok: true`. Alert on the reset.

In-flight and queued deliveries are never redacted — a payload that has not gone out still has to be deliverable, and emptying it would destroy a message the sender was told was safe.

**A redacted delivery cannot be replayed.** The states replay accepts are exactly the states redaction empties, so the two features meet on the same rows; without a check between them an operator clicking replay would send the literal tombstone to a downstream clinical system, which has no way to tell it from content. The replay is refused and says why:

```json
{ "error": "payload was redacted at 2026-08-07 14:02:11 under the retention policy and cannot be replayed" }
```

**Retention does not touch the FHIR facade.** That store holds the current clinical record a consumer is reading, not a log of traffic. How long a territorial EHR keeps a Patient resource is a clinical governance decision, not something an interface engine should quietly make.

A sweep that destroys data records itself on the audit trail, because that is an event worth being able to account for.

## The clinical record

Section 1 of the requirements asks that nothing clinically material is silently overwritten, and that a correction retains the original with its full history. That is a constraint on storage, not a matter of discipline — a table you `UPDATE` cannot satisfy it however carefully it is used.

So the clinical store has no update path. Three verbs, all writes:

```ts
const rec = new ClinicalRecord(db);
const dx = rec.record({ entryType: "Condition", patientId: "NT123456",
                        content: { code: "E11" }, authorId: "dr-tetso", authorKind: "practitioner" });

rec.amend(dx.record_id, { code: "E10" }, { …, reason: "coded from the wrong line of the referral" });
rec.retract(dx.record_id, { …, reason: "recorded against the wrong patient" });
```

An amendment writes a new version pointing at the one it supersedes; the superseded version stays exactly as it was. A reason is required, because "corrected" with no explanation is what tidying up looks like and is precisely what a reviewer needs to tell from a real correction.

**A retraction is not a deletion.** "This was recorded against the wrong patient" and "this never happened" are different claims, and only the first is true. The content is carried forward unchanged: a decision taken on the strength of the original cannot be reviewed against a blank. Retracted records leave the working chart and stay reachable for the review that needs them.

**One table, not fifteen.** Problems, allergies, vitals, notes, encounters and consents differ in their content, not in what must be true about them — an author, a time, a status, a supersession link, a place on the chain. A table per resource type would be a chance per resource type to leave one of those out.

**Charts are hash-chained per patient**, the same construction as message lineage and the access trail, and for the same reason: an amendment history that can be quietly rewritten is not a history. The chain commits to the clinical text itself, not to metadata about it — a chain over metadata alone would leave the diagnosis rewritable under an intact-looking history. Removal from the end is caught by a per-patient version counter, since linkage cannot see it.

**There is no `UPDATE` anywhere in the store.** An earlier version of this marked the replaced row as amended, which meant a correction wrote to a version a clinician had already signed — the one thing an append-only record exists to prevent — and, because the chain commits to every field, broke the chart's own verification. Whether a version was superseded is derived from a later one existing, never written back.

### Interfaces write to the chart

A `clinical` destination files a mapped payload onto the record it is about:

```json
{ "id": "chart", "type": "clinical",
  "patientPath": "subject.identifier.value",
  "identity": ["subject.identifier.value", "code.coding[0].code"],
  "effectivePath": "effectiveDateTime" }
```

Three outcomes, and the middle one carries the weight: an unknown record is a first version, **identical content writes nothing**, and changed content amends, naming the message that changed it. The no-op is not an optimisation. Interfaces resend — on reconnect, on replay from the DLQ, on a nightly repeat of the day's admissions — and a chart that grew a version per resend would bury the two amendments that mattered under four hundred that said nothing.

`identity` is what stops a chart holding exactly one observation forever. With the patient as the only key every result amends the last one, which looks like working software until someone asks for a trend; a result needs its analyte, an order needs its filler number.

An entry whose patient cannot be determined is **dead-lettered, not filed against a guess** — guessing is how a result reaches the wrong chart. And a record a clinician retracted is left alone by the next routine message from the system that produced it: an interface must not be able to reinstate a clinical judgement.

Every version carries where it came from: author and kind, the interface message that produced it, when it was written down and when it was clinically true. A vital sign filed an hour late belongs at the time it was taken, and a result that cannot name its source message cannot be reconciled against the feed that delivered it.

### Finding a patient

A chart nobody can look up is not a chart, and lookup is where a health record is most likely to go wrong: the wrong Marie Beaulieu, one person under two numbers, two people under one.

```ts
index.search({ family: "Beaulieu", birthDate: "1984-03-17" });
index.search({ identifier: "urn:jhn|NT123456" });
```

Every criterion given must match — a search that widened as the clinician supplied more would return more wrong Maries the better they knew which one they meant. Identifiers are added and never removed, so a message arriving under last year's interim number still reaches the same chart.

**The index is derived, and `rebuild()` proves it.** Every column is recoverable from the Patient entries in the log, and rebuilding reproduces it exactly — which is what keeps the log the record and this a convenience. An index that could not be rebuilt would have quietly become a second source of truth about who a patient is, and two of those do not stay in agreement.

**Duplicates are surfaced, never merged.** A shared identifier is close to conclusive: one health number should not name two charts. A matching name and birth date is a prompt rather than a finding — twins exist, and so do fathers and sons with one name between them. Both are reported with their evidence, and a human decides. Automatic merging is how a chart acquires someone else's allergies, and there is no honest way to unmerge afterwards.

The index also carries preferred language and telecom, recovered from the Patient resource the same way the name is. A rebuild still reproduces them, so they are not a second source of truth.

### Immunizations, vitals, procedures, care plans, patient-supplied documents, care team and coverage

Things a primary-care chart has to be able to say, and that used to live only as untyped entries or as a string on a note.

**Immunizations, vitals, procedures, care plans and patient-supplied documents write onto the clinical log.** They are not a second table. A given dose needs a vaccine and a date; a refusal needs a reason; blood pressure needs both numbers; a completed procedure needs the date it was performed; a not-done procedure needs a reason; a care plan needs a goal and a review date. A laboratory Observation is not a vital — mixing them would make a potassium look like a pulse. A specialist letter the patient brought in is not a SOAP note — mixing those would make an unsigned "note" nobody attested. Completing or revoking a care plan is an amendment. History is three-valued, the same way allergies are: `never-asked`, `never-measured`, `never-recorded`, `never-planned` and `never-received` are findings, not empty panels. An active care plan past its review date is work, not a status. The bytes of a document are optional: a clerk can record that paper arrived without pretending it was scanned. HTML, SVG and executables are refused; a payload over 256 KiB is refused. Lists never carry the payload. This is not a portal, not a virus scanner, and not a WCAG PDF.

**Care team and coverage are their own tables**, because a relationship and an eligibility claim are not generic chart entries. At most one *current* primary: two people who both believe they are most responsible is how a result goes to neither inbox. Retiring a membership sets an end date; the visits they attended stay theirs. A coverage change is a new row that supersedes the last one, so "were they covered when this visit happened" stays answerable. `unknown` is a recorded eligibility, not a missing field.

### Documentation, signatures and addenda

Section 3 turns on the difference between a draft and an attestation. A draft is working text. A signature says: this is what I found, this is what I decided, my name is on it.

```ts
const note = notes.draft({ patientId, encounterId, noteType: "SOAP", sections, author });
notes.revise(note.record_id, { …sections, assessment: "…" }, author);   // drafts only
notes.sign(note.record_id, resident);
notes.cosign(note.record_id, attending);
notes.addendum({ recordId: note.record_id, sections: { note: "Film reported later…" }, author });
```

**A signed note cannot be revised.** A refusal rather than a warning, because a signed note that can be edited is indistinguishable, afterwards, from one that was always what it now says — and the moment that matters is always months later, in a review of a decision somebody now regrets. The only way to say something further is an addendum, which is its own record, separately attested and linked to the note it follows, so a reader can always tell what was known at the time from what was added after.

A co-signature must come from someone other than the signer. One signature counted twice is not two people taking responsibility. `awaitingCosignature` is the supervisor's queue.

The signed text is covered by the chart chain too, so the refusal stops the API changing a note and verification catches anything that goes around it.

## The inbox

Section 8 asks for one guarantee, and it is not a feature: clinically important work must not disappear between people or organizations. Work is rarely lost by being deleted. It is lost by being handed to somebody who has left, closed with nothing to show for it, or owned by nobody — which means it is on nobody's list and is invisible in exactly the way that matters.

Three things are therefore structural:

- **Nothing is ever removed.** `cancel` is a status with a reason, distinct from `complete`, because "we decided not to" and "we did it" are different answers to an audit and only one of them is aftercare. A closed item is still there and can be reopened.
- **Completion requires evidence.** A task closed with an empty hand is indistinguishable, afterwards, from one abandoned — and "the result was acknowledged" versus "the result was marked acknowledged" is the distinction a review of a missed diagnosis turns on.
- **An unowned item is a list, not a silence.** `unassigned()` exists so that "belongs to nobody" is somewhere a person looks. Releasing an item is an action with a reason rather than a side effect of somebody leaving.

Every transition is appended with an actor and a reason, so delegation history is a record rather than a reconstruction. An owner column knows who has it now; "who had this when it went wrong" is the question actually asked.

**Inboxes are ordered by urgency and deadline, never by arrival.** A chronological inbox buries the one item that mattered under the forty that did not, which is the mechanism by which a critical result is missed with nobody doing anything wrong.

Items carry a correlation identifier, so a referral raised here and the consult report that answers it months later are recognisable as two items and one question — which is what closing a loop requires.

## Closing referral loops

Section 9 asks for closed-loop referral management, and the loop is the whole of it. Sending a referral is easy and every system does it. What is hard is knowing, eight months later, that one was sent and nothing has happened since — because nothing happening produces no error, no message and no alert. Nobody did anything wrong and the patient was not seen.

A referral here therefore always owes something to somebody, and the deadline is the record of what:

| Status | Who is waiting, and on what |
| --- | --- |
| `sent` | the referrer, on an acknowledgement |
| `acknowledged` | the referrer, on a triage decision |
| `accepted` | the patient, on an appointment |
| `booked` | everyone, on the appointment happening |
| `seen` | the referrer, on the consultation report |
| `reported` | the referrer, on reading it and closing |

Each transition sets what is expected next and by when, so `stalled()` — the query the rest of the module exists to serve — returns the referrals where a deadline passed with nothing happening, oldest first, which is the order they should be chased in.

Three decisions are worth stating, because each is a way a loop is quietly lost:

- **A redirect keeps the correlation, and carries the documents.** When a service passes a patient on, the new referral joins the same loop rather than starting one. Redirecting by cancelling and re-referring resets the clock, and the wait-time report then says the system is performing well while the patient waits from the beginning again. `waitDays()` measures from the first referral in the loop, which is what the patient experienced. The imaging already gathered travels with it too: making the next clinic re-request the same films is how a redirect costs a week.
- **Closing requires an outcome, cancelling requires a reason.** A referral closed with nothing recorded is indistinguishable afterwards from one abandoned, and that difference is usually the entire question. Both are refused, not warned about.
- **A referral is refused at send if the receiving service's required documents are missing.** A rejection three weeks later for a missing referral form is the same delay as never sending it, arrived at more slowly.

Nothing is deleted. Cancellation and decline are statuses with reasons, the full path is on `referral_events` with the actor who moved it, and a report arriving against a loop already closed is refused rather than backdated into looking like normal completion — a consultation nobody was expecting is a discrepancy worth a person's attention, and the findings themselves belong in the chart, which needs no live referral to hold them.

## Orders and results

Section 4 is about two silences, and they are different failures. An order placed and never resulted is the lab never reporting. A result reported and never read is the report arriving and landing on nobody. Both end with a clinician believing the question was answered, and neither raises an error.

The module is built around the second, because of a specific way it goes wrong.

**A correction does not inherit the acknowledgement of the value it replaced.** Laboratories correct results — a specimen is rerun, a transcription is fixed, a preliminary becomes final — and a correction can turn a value nobody needed to act on into one somebody urgently does. If acknowledgement is recorded against the order, or against a result identity that a correction reuses, the corrected value silently inherits the sign-off given to the old one. The chart then shows a potassium of 7.1 marked reviewed, and no one has ever seen it.

So results are appended, never updated. A correction is a new row superseding an earlier one, exactly as the chart works, and acknowledgement lives on the row. There is no mechanism by which it could carry over, because carrying over would mean writing it onto a row nobody wrote it onto. The superseded row keeps its own acknowledgement, because that part is true — that clinician did read that value; what is false is that anyone has read this one. Signing off a superseded result is refused, so the queue cannot be cleared with a number that is no longer current.

Three more decisions:

- **Acknowledgement says what was done.** "Acknowledged" alone records that a screen was clicked, and the question a review asks is what happened next. "Patient telephoned, attending this afternoon" is an answer; a timestamp is not.
- **Unsolicited results are kept, and matched by a person.** A result from another facility, or against an order placed on paper, is a real result about a real patient — refusing it would lose it, so it lands in `unmatched()`. Matching is an action somebody takes rather than an inference from code and date: two potassiums on one morning are not interchangeable, and a wrong automatic match reads afterwards as a result filed correctly.
- **Responsibility is a column, not an inference from who ordered.** Residents rotate and locums leave, so a result routed to whoever typed the order three weeks ago goes to an inbox nobody opens. `handover` moves it with a reason and refuses to leave it belonging to nobody.

Queues are ordered by how abnormal the value is, then by age, and the acknowledgement window comes from the same place: an hour for a panic value, a day for an abnormal one, three days for a normal one. Normal results are on the list too — "it was normal" is known after reading it, not before, and the results most often missed are the ones assumed unremarkable.

### The laboratory interface, as distinct from a mapping

A channel that turns an ORU into a FHIR Observation is easy to mistake for a laboratory interface. It is not one. It stores a copy of a value; it does not close the order the result answers, does not start an acknowledgement clock, and has no idea that tonight's retransmission is the same potassium it filed this morning. `oru-to-fhir-observation` does that; `lab-oru-to-orders` — a `labresults` destination — does the clinical half.

Four decisions carry it, and each is a way a laboratory feed quietly goes wrong:

- **A result whose patient cannot be identified is held, not guessed.** Matching is by identifier only. Name and birth date are read from the message and shown to whoever resolves it, and are never matched on — two people share a name and a birthday more often than a health system expects, and the failure is silent. An identifier resolving to two charts is also a refusal, because `duplicates()` surfacing them and declining to merge would be pointless if the interface picked one. `GET /api/clinical/lab-held` is where they wait, and resolving one re-files it through the same path, so deduplication and order matching still apply.
- **A resend is not a new result.** Identity is the laboratory's accession number, the analyte and the sub-id. An identical repeat writes nothing. Without this, a nightly repeat files the day's results again and the unacknowledged queue fills with duplicates of values somebody already read — and a queue that cannot be emptied is one clinicians stop reading.
- **A correction is not a duplicate.** The same key with a different value supersedes, and arrives unacknowledged even if the old value was signed off. That was already true of `OrderStore`; what the interface adds is telling the two apart.
- **A stale preliminary does not overwrite a final.** Out-of-order delivery is ordinary. Applying it would un-answer an order; dropping it silently would hide that the feed is delivering out of order. It is ignored, and recorded as ignored.

An unrecognised OBX-11 or OBX-8 is **refused**, not defaulted: `final` would start a clock on something unfinished, `preliminary` would silence one that was finished, and "normal" is not a safe reading of a flag nobody recognises. What the laboratory actually sent is kept beside the mapped meaning, because a mapping is an interpretation and a reconciliation that cannot see the original cannot settle a disagreement about it.

**Timestamps are not assumed to be UTC.** An explicit offset is honoured, a profile's declared `timezoneOffset` is applied when the message carries none, and a time with neither is filed with `timezone_assumed` set and counted in the reconciliation report. A result an hour out is a result on the wrong side of a shift change.

Laboratory dialects are **configuration**, in [`labs/`](labs/README.md) — a fork per laboratory is how a platform stops being one platform. A profile says where to find a field; it never says what a value means. A destination naming a profile that does not resolve **fails the delivery** rather than falling back to the generic reading, because a site that configured a vendor profile and silently got the generic one would believe it had a vendor interface.

`GET /api/clinical/lab-reconcile` answers what a feed did: filed, corrected, cancelled, unmatched, held, unacknowledged, overdue, critical-unacknowledged, and how many accessions. Every number is a count of rows somebody can go and look at, and the caveats say what the numbers cannot tell you — including that an unacknowledged result is work owed to a clinician rather than a broken interface.

**No vendor interface is shipped or claimed.** There is no Dynacare profile and no LifeLabs profile. Writing one from a published specification and calling it an interface would be the exact failure this repository spends its time refusing. A real one needs their conformance guide, a sandbox, credentials, a connectivity certificate and a signed test result.

`awaitingResult()` covers the other silence. A preliminary result does not answer an order: a blood culture reporting "gram-positive cocci" at 24 hours and never speciating is precisely the wait worth chasing, and an earlier version of that query dropped it from the list. Whether an order has been answered is now decided in exactly one place, and the query reads that decision rather than making it a second time.

## Medications

Section 5's failure is a list that records what was *prescribed* and is read as what is *in the patient*. Those are different claims. A prescription written eighteen months ago is evidence that somebody intended a drug; the patient who stopped their statin because of muscle aches and mentioned it to nobody has a chart saying otherwise. Every dose calculated around that list is calculated around a drug that is not there.

So provenance is required on every statement — `prescribed`, `patient-reported`, `pharmacy-dispense`, `reconciled`, `external-record`, with no default, because a default is a guess about provenance written into the record as a fact. Adherence is a separate column from status, so a prescription can be active while the patient is not taking it. `current()` returns what the patient is taking; `current({ asPrescribed: true })` returns the other list. Both are real, and conflating them is the error.

Statements are appended, never updated. A dose change is a new row superseding the old one, so "what was the patient on when this happened" stays answerable. Stopping requires a reason: a drug that vanishes with nothing recorded is indistinguishable from one removed by mistake, and the next prescriber's response to those two should be opposite.

### Nobody asked is not the same as no known allergies

This is what the allergy table exists for. An allergy list that is empty because somebody asked and the answer was none, and one that is empty because nobody has ever asked, are clinically opposite — and in most systems they render identically, as a blank panel. A check run against the second returns "no contraindications found", which is a reassuring answer to a question that was never put.

So "no known drug allergies" is a **row**: an assertion with an author and a time. Its absence means nobody has asked, and `allergyStatus()` returns three values rather than two. `never-asked` is a finding in its own right, at severity `severe`, and is never folded into `clear`.

The same refusal-to-guess applies to interactions. A source that cannot answer — an expired licence, an unreachable service — produces a finding saying so, not silence. A deployment with no interaction source configured reports interactions as unchecked rather than clear.

### What blocks, and what an override is for

The check never decides. A blocking finding means `prescribe` refuses without an override carrying a reason — but the prescriber may always proceed, because an emergency does not wait for an allergy history and a system that refuses outright is one clinicians route around. What must be true is that proceeding was an act somebody can be shown to have taken: the override records the reason **and the findings that were shown**, so a considered decision is distinguishable afterwards from a reflex click.

Findings are ordered worst-first, independently of the order the check discovers them in. A contraindication below three informational lines is one that gets scrolled past.

### Reconciliation

Admission, transfer and discharge are where lists diverge. A reconciliation is seeded from the current list rather than starting empty — an empty form is completed by doing nothing — and **cannot be completed while any line is undecided**, with the unresolved medications named in the refusal so it is actionable.

That refusal is the point. A reconciliation marked done with lines nobody resolved is worse than one never started, because the chart now says the work happened and the next clinician has no reason to look again. Decisions are applied to the list on completion, which is what makes it a reconciliation rather than a questionnaire, and one left open appears in `incompleteReconciliations()` rather than sitting invisibly.

### Getting a prescription to a pharmacy

A prescription was recorded carefully and then went nowhere. The clinician wrote it into the chart, printed it or read it down the phone, and the pharmacy wrote it again at their end — two records of one decision, drifting apart from the moment they were made. A "sent" flag does not fix that; four distinctions do.

**Not transmitted is a state, not an absence.** Printing a prescription and handing it to the patient is how most prescriptions in most places still travel, so `handOut()` records exactly that and nothing waits on an acknowledgement afterwards. What is refused is the third state — neither transmitted nor deliberately printed, sitting in the chart looking finished. `neverSent()` is that queue, because it is the one the patient discovers at the counter.

**Transmitting twice is a double dispense.** A pharmacy that receives the same prescription twice may dispense it twice, and for an opioid that is a serious adverse event with no error attached anywhere. A second transmission is refused. The only retry is `replaceFailed()`, which writes a new prescription naming the one it replaces — so a pharmacy receiving both can tell they are one decision, and a reviewer can see a retry rather than two prescriptions of unknown relationship.

**Sent is not received.** Northstar does not know how to talk to a pharmacy network and does not pretend to: the transmission becomes a message on a channel the deployment configures, carried by the same ordered, retried, dead-lettered machinery as everything else. Until an acknowledgement is recorded the prescription is outstanding, and `awaitingAcknowledgement()` is what stops "we sent it" being the end of the story. With no channel configured, `transmit()` **refuses** rather than recording one as sent.

**A controlled substance is not an ordinary prescription.** Electronic prescribing of narcotics is separately regulated. It is refused unless the deployment declares the authority it holds — a licence or programme name, not a boolean — and the declaration goes on the prescription where an audit can read it.

The most dangerous list is `cancellationsOwed()`: a prescription cancelled after transmission, with nobody having confirmed the pharmacy was told. The chart says stopped, the pharmacy's screen says dispense, and the patient is the one who finds out.

A prescription is written against a **medication statement** rather than restating a drug, so the prescription and the medication list cannot disagree about what was prescribed. Only a `prescribed` statement qualifies: transmitting a patient-reported drug would be this system inventing a prescriber's decision.

### What is deliberately not here

The mechanism is here; the clinical content is not. A drug interaction table that is 80% complete is one a prescriber learns to trust, and the missing 20% is then invisible — worse than the gap it was meant to close. Northstar ships a deliberately small cross-reactivity set covering the classes with the clearest consensus, and takes a licensed interaction database through the `InteractionSource` seam for anything more. Same posture as the terminology loaders: build the seam, do not fake the content.

## The clinician workspace

Section 2 asks for a longitudinal view a clinician can open and act from. The temptation is to treat that as presentation — join the tables, render the panels — and the reason it is not is what the module is built around.

**A summary is read as complete.** That is its entire clinical function: a clinician opens it precisely so they do not have to go looking, and having looked, they proceed on the basis that what is there is what there is.

So the dangerous failure is not an error. It is a section that came back short — a store that threw and was caught, a list truncated at fifty, a category nobody wired in — rendering as an empty panel that means "none" when it actually means "not asked". An empty allergy panel is the same lie as an empty allergy list, and the same one §5 refuses to tell.

Every section therefore carries its own completeness, and the summary carries `complete` and `omissions`:

- a section that **could not be loaded** says so, and its omission text says the panel is empty because it failed rather than because there is nothing;
- a section that was **cut short** says how many it dropped;
- a store that is **not configured** in this deployment is an omission, not a blank.

A failing store does not take the chart down — six panels beat an error page — but the panel it leaves behind never passes for "none". `complete === false` is the flag a renderer must surface, not a detail it may ignore.

Allergy, immunization, vital-sign, procedure, care-plan and patient-document status are carried to the top of the summary rather than left inside their panels, and read from the stores rather than inferred from the panel's contents. Inferring them would undo the distinction those stores exist for: a clinician scanning a chart has to see "never asked", "never measured", "never recorded", "never planned" or "never received" without interpreting an empty box. A chart with no current primary or no coverage claim says so in `omissions` the same way.

`worklist()` is the same idea across the day rather than across one patient. A clinician's work is not one queue — today's appointments, messages awaiting a reply, unowned messages, results, referrals, tasks, care plans past their review date, and each system reports its own as though it were the whole picture. The value of a single view is that nothing is owed to them somewhere they are not looking, which is only true if the view says what it could not reach. Today's list is that clinician's booked and attended appointments on the UTC day of `asOf`, not every empty slot in the diary. Overdue care plans are the service's, like stalled referrals: said plainly rather than filtered to nothing.

### Governed risk scores

`POST /api/clinical/score` computes ten deterministic published instruments;
`POST /api/clinical/chart-score` can assemble NEWS2 and CURB-65 from the chart
while refusing stale or unavailable inputs. A number without its definition is
not reproducible evidence, so every complete **and incomplete** result carries:

- the instrument and Northstar implementation versions;
- the original publication or official steward source;
- intended population, exclusions and required units;
- a copy of the supplied inputs and the calculation time;
- an assurance state that remains
  `implementation-tested-not-independently-clinically-validated` until a named
  clinical owner records a review.

Units travel with the values rather than being spelled into parameter names.
`POST /api/clinical/score/v2` takes `{ "value": 98.6, "unit": "[degF]" }`
against UCUM, and resolves it onto the scale the instrument is written in at a
single ingestion boundary — never inside a scorer, which sees canonical numbers
and cannot tell that a conversion ran. Equivalent labels (`Cel`, `°C`, `degC`)
are accepted exactly as sent, because they name one scale and there is nothing
to compute. A genuine conversion is returned with the score so it can be
checked. A mismatch that needs a fact about the substance rather than the units
is refused instead of guessed: relating bilirubin in µmol/L to a mg/dL
threshold needs that analyte's molar mass, and choosing one on a caller's
behalf is the silent rescaling the contract exists to prevent. `POST
/api/clinical/score` is unchanged and still supported.

Inputs are checked against a domain before any arithmetic runs. A domain says
what a measurement *can* be — a saturation is a percentage, a count of
emergency visits is a whole number, a CIWA-Ar item is scored 0 to 7 — and is
deliberately not one of the instrument's thresholds: it carries no clinical
judgement, and a change to it can only reject input that was never scoreable.
A value outside its domain refuses rather than joining the missing-input list,
because "nobody measured this" and "what you sent cannot be a measurement" are
different faults, and only the first is a clinician's to fix.

Chart-derived responses additionally carry their clinical `asOf` time, every
source record and its age, and the oldest observation on which the score rests.
The catalogue is `src/clinical/score-definitions.ts`; source-linked vectors in
`fixtures/clinical-scores/golden.json` are executable transcription checks, not
a substitute for independent validation. MELD-Na identifies itself as the 2016
OPTN formula and explicitly says it is not current MELD 3.0; NEWS2 says that
only Scale 1 is implemented. A mathematically complete score can still be
clinically inapplicable, which is why population and exclusions travel with the
number instead of living only in this README.

### Patient messaging

Section 11 asks for secure messaging; section 8 asks that clinically important work not disappear. The failure is the phone message on a sticky note: the patient asked, somebody heard, and the next shift has no record.

So a thread is append-only. Status follows the last speaker — a patient or proxy writing is `awaiting-clinic`, a practitioner or clerk writing is `awaiting-patient`. Closing needs a reason, and closing while the patient is still waiting needs to say what was done instead of a written reply. If the patient has a current primary, an incoming question is assigned to them; if not, it sits on `unassigned()` rather than vanishing.

This is the record of the conversation. It is not a patient portal, not email, and not a claim that a notification reached a phone. Northstar still does not know how to reach a patient. A future portal would write through this store.

The module owns no data and keeps no second copy of anything. It assembles from the stores that already exist, declares what it assembled, and is honest about the rest.

### The visit

`encounter_id` was a column on orders, medication statements, reconciliations and clinical entries long before anything owned one. It named a thing the system could not describe, so "what happened at this visit" had no answer except a time-window guess across four stores — wrong in the ordinary case where two clinicians see the same patient an hour apart — and a discharge summary had nothing to summarise.

A visit now exists, with a class (in-person, virtual, telephone, home visit), a status, a period, a location, its participants and their roles, and a disposition. Three decisions in it are worth stating because each was a choice:

**A visit is not a document about a visit.** The append-only record still accepts an `Encounter` entry, and that remains the right home for a narrative somebody wrote. It is the wrong home for the relationships — which orders belong here, who was present, whether it is still open — because those are queried rather than read, and re-deriving them from entries on every read is how a chart gets slow and a worklist gets wrong.

**A visit that started cannot be cancelled.** Only a planned one can. Once a patient has been seen the visit happened, and a status that could erase it would erase that they attended. A patient who leaves is a *disposition* — `left-without-being-seen` — on a finished encounter, which keeps both facts: they came, and nobody saw them. Cancelling would keep neither. For the same reason `close()` requires a disposition: "finished" says the visit ended and says nothing about whether the patient went home, was admitted, or was sent to emergency, which is the part a later reader most needs.

**Clinical content cannot name a visit that is not this patient's.** An `encounter_id` reads as provenance, so one pointing at another patient's visit is how a chart acquires somebody else's results. Orders, medication statements and clinical entries now check it where they write it, rather than trusting each caller to have got it right — which is what turned up eleven fixtures across the existing suite filing notes against an `enc-1` that never existed. A cancelled encounter accepts nothing at all; a finished one still accepts a late result, because results come back after the patient has gone home.

The assembled visit inherits the chart's position exactly: it is read as complete, so a section that failed says so rather than rendering as "nothing was ordered at this visit". Results hang off the orders the visit placed rather than off the encounter, because a result answers an order — and if the orders section came back short, the results section reports itself as an undercount rather than as a shorter true list.

Rows written before encounters existed keep `encounter_id IS NULL` and stay readable. An entry with no encounter is not an entry with an unknown one, and nothing backfills a guess.

### The directory

A slot said `dr-tetso`. A referral said "Stanton Orthopaedics". Neither string resolved to anything, so the system could not say whether that person existed, was licensed, worked here, or was the same `dr-tetso` who received a referral last week.

Practitioners, organizations, locations, the services they provide, and the roles joining them are now modelled, with licence and facility identifiers as first-class rather than a display name — a name is not an identity, and the identifier is what a credential will eventually be matched on.

**Organization is not tenancy.** Several organizations operate inside one custodian's tenant. Conflating the two would make a `withhold-from-organization` directive withhold a patient's record from the whole territory instead of from the one clinic they named, which is the deployment that most needs the distinction. One practitioner holds several roles for the same reason: a locum covering two clinics is one person and two roles, and a single `organization_id` would lose which hat they were wearing.

**Nothing is deleted.** A clinic that closes must not break the referral sent to it in 2024. Entries are effective-dated, so retiring one keeps it resolving afterwards as known-and-inactive — a more useful answer than either "gone" or "current".

**Resolution is honest rather than fatal.** A reference the directory does not hold resolves to `known: false` carrying the row's own value, not a blank and not an exception. That is what lets a site adopt a directory without a flag day: existing slots keep working and report themselves as unregistered. A caller wanting the strong guarantee passes a typed reference — `openSlot({ resource: { kind, id } })` — which is validated on write, so a typo is refused there rather than found by a clerk staring at a diary for somebody who does not work here.

A referral target is three-valued for the same reason: a known service, a **declared** external one, or unverified free text. A referral south is ordinary and must not be refused for being unknown; what it must not be is indistinguishable from a typo.

The same parties are served on the FHIR facade as `Practitioner`, `PractitionerRole`, `Organization`, `Location` and `HealthcareService`. A write that arrives as one of those types is ingested into the directory when it can be; a Patient is not a party, and a half-built Practitioner is not invented.

## The clinical API, and audit by construction

Everything above — the chart, the patient index, medications, allergies, immunizations, vitals, procedures, care plans, patient-supplied documents, care team, coverage, orders, results, referrals, tasks, notes, message threads and the assembled summary — is served under `/api/clinical/*`, behind the `admin` scope and inside the caller's tenant like the rest of the API.

Exposing it is the moment the audit requirement in §18 starts to bite. Until now the clinical stores were libraries: nothing reached them over a network, so nothing went unrecorded. A route is a way in, and **an audit guarantee that depends on each new route remembering to call `audit()` is one that holds until somebody forgets** — and the forgetting is invisible, because the route works, the data is served, and nothing anywhere says the trail is short.

Two things make it structural instead:

- **`phi()` audits first and sends second.** An exception between the two cannot produce a read that happened without a record of it happening, and there is no path through a clinical route that reaches `send` without passing through it. A store refusal (`Refusal`, including `SlotFull` → 409) keeps the status the store chose and is outcome 4; an unrecognised exception is 500 with a generic body, and the real message is on the trail and the log.
- **`test/clinical-api.test.ts` reads the routing source**, extracts every `/api/clinical/*` path, drives each one, and fails if any serves patient data without leaving a row. A route added tomorrow with no trail does not quietly work — it breaks the build. The test also fails on a route it has no case for, so a new endpoint cannot pass by being untested.

A search that finds nobody is still an access. "Who did you look for" is a question a privacy review asks, and a fruitless search for a well-known name is exactly the one it asks about — so the row is written with `count: 0` rather than not at all.

The allergy endpoint returns the three-valued status beside the list rather than the list alone, because an empty array on the wire is the same ambiguity an empty panel is on a screen.

Read scope is not enough for any of it. A credential that may read the FHIR facade is not thereby licensed to open charts, and a refused reach for a patient record is itself recorded — that refusal is among the things an audit trail exists to show.

The guarantee proved itself during this work: wiring the schedule and registry endpoints in, the structural test failed on the new routes before they had cases, which is precisely the moment it is supposed to fire.

### Directives are enforced here, not merely stored

The consent work above would be decoration if the chart API did not consult it, and worse than decoration — the system would claim to honour patient directives while serving the record anyway.

So the check lives **inside `phi()`**, not in each route. Every route that names a patient goes through it, which means a lockbox cannot be missed by a route that forgot to ask, and `test/clinical-api.test.ts` reads the source to require that a patient-scoped route goes through `phi()` at all.

A refusal is audited like any other access — a directive that stopped somebody is exactly what a privacy office wants to see — and the 403 says how to declare an emergency:

```json
{ "error": "this record is withheld by a patient directive",
  "breakGlass": "POST /api/clinical/break-glass" }
```

Declaring is itself an event on the trail, written before any record is read under it. And `GET /api/clinical/directives` is deliberately **outside** the withholding check: refusing to show somebody the directive that stopped them would leave them unable to tell a lockbox from an empty chart, which is exactly the ambiguity the rest of this refuses.

**Lists are a different problem from single records.** Refusing an entire worklist because one patient on it has a directive would take a clinician's day away, so withheld rows are omitted — but not silently:

```json
{ "rows": [ … ], "withheldCount": 1 }
```

A short list that looks complete is what this system refuses everywhere, and here it is worse than usual: a result withheld from the clinician responsible for reading it is a result now owed to **nobody**, which is the exact silence §4 exists to prevent. The count is reported so somebody can act on it; who they are is not, which is what the directive asked for. A task with no patient on it is not about anybody, so no directive withholds it.

**A chart is a third problem again**, because it is not one kind of thing. "May they read the chart?" has no honest yes-or-no answer when the patient has locked their counselling notes and nothing else — and both available answers are wrong. Serving it leaks what they locked. Refusing it takes the whole chart away over one panel, leaving break-glass as the only route to an allergy list nobody objected to.

So a directive narrowed by `scope` withholds its **section**:

```json
{ "recentNotes": { "items": [], "complete": false,
    "incomplete": { "reason": "withheld",
                    "detail": "withheld by a patient directive; break glass to see it if the situation warrants it" } },
  "complete": false,
  "omissions": ["Recent notes: withheld by a patient directive; …"] }
```

`withheld` is a distinct reason from `unavailable`, and the distinction is clinical rather than tidy. A panel that **failed to load** is a reason to go and look elsewhere before prescribing. A panel the **patient locked** is a reason to have a conversation, or to break glass if the situation warrants it. Rendering the second as the first would be both wrong and quietly alarming.

Neither the content nor the **count** of a withheld section reaches the response — "3 documents withheld" tells a reader the patient has counselling notes, which is most of what the lockbox was hiding — and the withheld section is not loaded and discarded but never read, because reading rows the patient locked in order to throw them away is still reading them. The access is audited as a success that withheld something, naming the types and nothing else.

A route serving **exactly** the locked type still refuses, having nothing left to serve, and a directive naming **no** entry types refuses the whole chart. Both are the same rule seen from different sides: withhold precisely what the patient asked to withhold, and no more.

### The clinician console

Everything above is a store with an API in front of it, and until something renders it the honesty is theoretical. `complete` and `omissions` have been on every chart section since the chart was written; nothing displayed them.

Four tabs in the admin UI, driven entirely through the clinical API — no privileged path, so every read leaves an audit row and passes the directive check like any other caller:

**Chart.** The patient, the allergy status at the top where it cannot be missed, and eight panels. The only thing this screen really has to do is make a panel that is *not* complete impossible to mistake for one that is, so incompleteness is on the left border and in a line of prose inside the panel — never a tint somebody reads past at 03:00. The three reasons are visually distinct because they call for different actions:

- **failed** — go and look somewhere else before you prescribe
- **truncated** — there is more below
- **withheld** — the patient asked; break glass if the situation warrants it

A chart that is short says so at the top, above the panels: *"This is not the whole chart. Do not read a panel below as 'none' without checking why it is short."*

**Worklist.** What is owed to one clinician across results, referrals, orders, tasks and reconciliations — each with the same completeness treatment, because something owed to you that is missing from the list is owed to nobody. Results are acknowledged inline, and the acknowledgement needs a sentence saying what was done: a queue that empties on a click teaches a ward that the queue is the work. The refusals come back verbatim, including *"this result was corrected; acknowledge &lt;other&gt; instead"*.

**Break-glass.** The two queues, and the controls that discharge them. A lockbox nobody can find out was opened is a lockbox with no lock.

**Privacy.** The queues a privacy officer actually runs: unreviewed break-glass, overdue access requests, pending enrolments, undelivered and untold patient notices, open reviews, active holds, incidents and assurance findings. Opening a review of the last 24 hours is a button; closing one with flags still open is not. After-hours uses UTC clinic hours, not local time.

Hostile content in this console runs in the browser session of the person holding an admin key, so `test/ui-xss.test.ts` drives the operational tabs in a real Chromium against genuinely hostile input — a patient's name from an ADT feed, and the free text a clerk types into a referral, a task or a break-glass reason — and asserts both that nothing executed and that the payloads actually reached the DOM. The Privacy tab is driven too; its honesty check is the inbox tests, because an empty queue would pass an XSS check having rendered nothing.

### What is deliberately not on the clinical API

**The patient-facing surface is separate.** `/api/clinical/*` remains for
operators and clinicians. `/patient/*` requires an OAuth patient-context
token, then binds that token's subject to a live `patient_authority` grant on
every request. A patient scope cannot read `/fhir/*`; an admin scope does not
imply patient; an API key cannot be issued patient scope.

`GET /me` is a static English/French shell with landmarks and an honest banner.
It loads no chart and does not enrol anyone. Clinic attestation is a named
clerk writing a method; it is not identity-proofing. Notices publish fact onto
a channel; dispatching is not telling. There is still no WCAG or AODA claim.

## The privacy office

The audit trail records and proves. It answers none of the questions a privacy
officer asks — who broke glass and has not been reviewed, which access request
is past thirty days, whether a hold is standing in the way of a sweep, whether
an incident closed with patients told. A chain nobody reads proves only that
nobody tampered with a log nobody reads.

`tenant.privacy` is that office, and `/api/clinical/privacy-*` is how it is
reached. Reads and writes still audit, and every query is still tenant-scoped.
They do **not** apply a patient lockbox. A directive that hid the office from
the record it is charged with reviewing would be a lock with no key. The trail
says the directive was not applied.

`GET /api/audit/review?patient=` is the complementary surface: it reads the
trail the queues above are not. One is who looked and whether they had a
reason to; the other is the work of emptying reviews, holds, incidents and
clocks. Neither substitutes for the other.

What it refuses, because a queue that empties on a click teaches a ward that
the queue was the work:

- **A review cannot close with unaddressed flags.** Addressing a flag needs a
  written reason; closing needs a written conclusion.
- **An incident cannot close** without a written account, named patients or
  `noneAffected`, and whether they were told. `not-told` needs a written why.
- **An active subprocessor needs a hosting region.** A candidate may have none;
  an active one may not.
- **A finding cannot close** without remediation or an accepted residual risk.
  `BACKUP-02` stays `partial` in the catalogue: the replica is still an
  operator copying a file, and a SQL seed that marked it in-place would be
  the finding closed by forgetting it.

What it queues rather than hard-stops:

- **Overdue access requests.** Thirty days from `submitted_at`, or an extended
  deadline. Completing without a recorded disclosure stays possible on
  `PatientAccess`; the inbox flags it. `fulfillAccess` records the disclosure
  (section names and counts, not a second copy of the chart) and then completes
  the request.
- **After-hours reads.** Decided from the UTC timestamp of the access, default
  clinic hours 07:00–19:00 UTC. Residual: not clinic-local.

A legal hold with a null patient is tenant-wide. Messages are not
patient-keyed, so any active hold on this tenant **skips the entire retention
sweep** rather than trying to redact "just that patient". Fail closed.

Hazards H-70–H-76.

## Patient access

Section 11 has two failures that nothing else in this system has, and they pull in opposite directions.

### Delegated authority that never ends

A parent's access to a child's chart is correct until a birthday and wrong afterwards — and **nothing about that day generates an event**. No message arrives, no status changes, no queue fills up. The grant simply keeps working, and a sixteen-year-old's mental health notes stay readable by somebody no longer entitled to them, for years, with nobody doing anything wrong.

The same shape covers a substitute decision-maker whose authority ended when capacity returned, and a representative named during an admission that finished in 2019.

So authority is time-bounded by construction:

- **A delegated grant without an expiry is refused, not defaulted.** A default would be this module's guess written into the record as somebody's decision — and the decision, *when does this end*, is the entire safeguard. For a parent it is the age of majority in the jurisdiction; for a substitute decision-maker it is a review date. Neither is something a library should choose.
- **Scope, purpose and expiry are separate required fields.** A representative allowed to manage appointments does not gain result or message access. A proxy can never receive `delegates` and therefore cannot grant access onwards.
- **The check is against the clock, not a status.** A grant that expired yesterday is not authority, whether or not any sweep has run.
- **`expiring()` surfaces grants about to lapse**, so a renewal is a decision somebody makes rather than a lapse somebody discovers. A parent who still needs access to a disabled adult child's chart should be asked; one who should not have it should stop, on the day.

The expired grant row stays. Who was entitled when is not something to delete — it simply stops being authority.

### Clinic-attested enrolment

Until a named person writes how they checked, an OAuth subject is not on the
chart. `POST /api/clinical/authority-self` and `authority-proxy` require a
`method` of at least twelve characters — "in person" is not a method — and
go through `PatientEnrolment`. A pending row is not a grant. `GET /me` does
not enrol anyone; there is no `/patient/enrol`, because naming a chart from
the internet is H-52. Proxy enrolments still need an expiry, a purpose and
explicit permissions. This is not identity-proofing and not ONE ID.

Completing an access request queues a patient notice whose payload is the
fact (kind, reference, a summary) and never a result value. The notice is
published onto the same configured channel as break-glass. Dispatching it is
not recording that the patient was told; a missing channel is a visible
failure. The Privacy tab lists pending enrolments and undelivered or untold
notices.

### The patient/proxy API

`GET /patient/authorities` is the starting point: the charts this OAuth subject
may act for and the relationship, permissions, purpose and expiry of each
grant. Every other route takes one of those patient ids and checks it again;
accepting a patient id is not accepting its authority.

- `/patient/summary` — demographics, allergy status, medication lists,
  immunizations, latest vitals, procedures, active care plans, patient-supplied
  document metadata (never the bytes), current care team and coverage. It is
  not the clinician Workspace: no internal tasks and no unacknowledged result
  values.
- `/patient/results` — only `PatientAccess.resultsFor()`, so a held result is
  visible while its value is not.
- `/patient/appointments` — bookings joined to their time and service.
- `/patient/threads`, `/patient/thread-open`, `/patient/thread-reply` —
  messaging where speaker identity is derived from the grant, never accepted
  from the request body.
- `/patient/access-log`, `/patient/delegates`,
  `/patient/delegate-revoke` — accountable access and patient-controlled
  revocation.
- `/patient/request`, `/patient/requests` — access and correction requests.
  The patient receives a durable receipt and the clinic receives a linked,
  unassigned privacy task that cannot be completed without evidence.

The patient-facing access row and the tamper-evident audit row commit in the
same database transaction as a patient write. A message reply cannot persist
without both trails.

### The patient HTML shell

`GET /me` is public on purpose, the way `GET /` is: it is chrome, not a record.
An unauthenticated GET is not audited as a reach for a patient. The page says,
in English and in French, that it is not a certified portal — no
identity-proofing, no ONE ID, no WCAG or AODA claim — and that this page does
not enrol anyone. Chart access is `/patient/*` with a live grant.

### Release timing

Immediate release is the default and it is right: a patient waiting a week for a normal result while their clinician's inbox fills is the harm the information-blocking rules were written against.

But "immediate, no exceptions" means a person can learn they have cancer from a phone at eleven at night with nobody to ask. A system that cannot express that has not solved the problem — it has picked the other side of it.

So a hold is possible and deliberately hard to abuse. It is **bounded** (a hold with no end is a result withheld indefinitely, which is the practice being legislated against), **reasoned**, **attributed**, and above all **visible**:

> **Biopsy report** — reported 14 March
> Your clinician will discuss this result with you. Available from 17 March.

A held result appears in the patient's list, saying that it is held and when it lifts. It is never simply absent, because an absent result is indistinguishable from one that never came back — and the patient then has no idea there is anything to ask about, which is the failure the whole regime exists to prevent.

What the patient is shown is a **category**, not the clinical justification. "Your clinician will discuss this result with you" is honest and does not require somebody to read a note about themselves written for someone else. The hold lifts by the clock; nothing has to run.

### The patient's own access log

Section 11 requires a patient be able to see who looked at their record, and a proxy's accesses are in it under the proxy's own name. *"My ex-husband opened my chart four times last month"* is exactly what a patient has a right to find out, and it is unanswerable if a proxy's reads are recorded as the patient's own. Refused attempts are in it too.

## Migration from an incumbent system

This is how a real deployment starts, and what makes it dangerous is not the volume. It is that **you cannot tell whether it worked by whether it errored.**

A migration that loads 96% of the allergies and reports success is the catastrophe. There is no error anywhere: the extract ran, the loader ran, the counts look plausible, the clinicians start work, and the 4% that never arrived are invisible until somebody prescribes into a gap.

So **completeness is declared and then checked.** Before loading a record type, the run records how many the source system says there are. Afterwards the report compares:

- counts agree → **complete**
- counts disagree → **incomplete**, and the gap is named as records that "neither loaded nor failed — nothing recorded them at all"
- nothing declared → **cannot verify completeness**, which is a different and equally honest answer

`complete` is never true because nothing threw. Closing a run over a gap is possible — sometimes the gap is a known duplicate the vendor confirmed — but it takes `acceptGapsBecause`, a sentence that lands in the run's notes with somebody's name on it.

Four more decisions:

- **Rejects are a queue with the payload in it.** A row that could not be loaded is kept whole, with its reason. "37 allergies failed validation" is not something a clinical safety officer can sign; 37 rows they can open is.
- **Loading goes through the ordinary stores**, not straight into SQL. A migration that bypassed validation would load records the live system would refuse — an allergy with no substance, a medication with no provenance — and the first anyone would know is a prescriber acting on it.
- **Source codes and provenance survive.** Every migrated record carries `_source`: the system, the row's own id, the run, and the source's own codes alongside the mapped ones. A record that cannot be traced back to the row it came from cannot be checked against the source, and checking against the source is the only way a mapping error is ever found.
- **A migrated medication is `external-record`, never `prescribed`.** Marking everything prescribed would assert that this clinic wrote prescriptions it never saw. Adherence is `unknown`, so the drug appears on the list with the caveat attached rather than being hidden — a migrated chart showing the patient on nothing would be far more dangerous.

**Loading is idempotent** on the source's own identity, so a resumed run does not double what it already did and a delta carrying unchanged rows writes nothing.

**A trial can be rolled back; a cutover with clinical activity cannot.** Trials are the only way anybody finds the mapping errors, so they are disposable — and rollback is by *retraction*, so the rollback is itself on the record rather than erasing the evidence that the run happened. A cutover whose charts have been written to since is refused, naming who has written, because rolling it back would remove the records their notes refer to.

`validationSample()` is the part counts cannot replace: a mapping that puts the dose in the frequency field reconciles perfectly. The sample spreads across record types rather than taking the top rows, because the first hundred rows of an extract are the easy ones.

**What this is not.** It is not an extractor. Getting data out of an incumbent system is that vendor's export, a database dump, or a negotiation. Source-system inventory, cutover scheduling and post-launch stabilisation are a plan a person writes.

## Registries and care gaps

Section 12 asks who in a population needs something they have not had. The arithmetic is easy. The denominator is not, and that is what this module is about.

A diabetes registry reports control by dividing patients whose last HbA1c was under target by patients with a recent HbA1c. Patients with **no** recent HbA1c fall out of both halves — and those are, precisely and not coincidentally, the people nobody has managed. So the measure reads best exactly where care is worst, and it does so silently: no error, no warning, a clean percentage on a dashboard a health region plans around.

The same shape appears throughout quality measurement. Exclusions accumulate, each individually defensible, until a measure describes a carefully chosen subset and is reported as though it described a population.

So:

- **The denominator is the whole cohort**, not its assessable part. A patient with no recent test counts against the measure rather than vanishing from it.
- **`unclassified` is returned beside the numerator and denominator**, with a reason per patient: no qualifying observation, a value that is not numeric, no birth date to apply an age criterion to.
- **`rate` is `null` when too much of the cohort could not be assessed.** A number that is wrong is worse than no number, because a number gets planned around. The caveat says why in words, so a dashboard cannot render a bare percentage.

The property that follows is the one worth stating: **a measure must get worse when somebody stops being tested, never better.** A measure that improves when patients drop out of testing is measuring the wrong thing, and it is tested for directly.

`"sample haemolysed"` is unclassified, not a pass. Parsed as a number it is `0`, which is below every target — and would count as excellent control.

An empty cohort reports `null` rather than `0%`. Zero over zero is not zero per cent, and a dashboard rendering 0% would be read as terrible care.

Cohort membership carries **why** — `condition diabetes`, `taking metformin, aged 54` — so a clinician can disagree with one patient rather than with the registry. A list nobody can argue with in detail is one they dismiss wholesale. A condition a clinician retracted takes the patient off the register, and a drug the patient has stopped taking does not keep them on it: the register is of people, not of prescriptions.

Care gaps distinguish **never done** from **overdue**, never-done first. They are different conversations — one patient has never been offered the test, the other has been and did not come back. A gap can be satisfied by a medication rather than a result, because "diabetic patients on a statin" is closed by a prescription, and a rule engine that only understood results would recall every patient already treated.

## Scheduling

Two failures carry this, unrelated except that both are ways a schedule quietly breaks.

### A slot belongs to one patient, and the database says so

The one thing a scheduler must never do is give one slot to two people, and **check-then-insert cannot promise that**. Between reading "free" and writing "booked" another booking fits, and the window is exactly as wide as the gap between two statements. Under a real clinic — two clerks, a patient portal and an inbound SIU feed on one diary — that window is hit, and the failure is discovered in the waiting room.

So the promise is a uniqueness constraint, not a code path:

```sql
CREATE UNIQUE INDEX idx_booking_seat
  ON schedule_bookings(tenant_id, slot_id, seat) WHERE status != 'cancelled';
```

`book()` still checks, because a clear refusal beats a constraint violation — but the check is a courtesy and the index is the guarantee. The test that matters therefore **bypasses `book()` entirely** and writes the row a racing second process would write, because a guarantee that only holds when callers behave is not a guarantee.

The index is partial so that cancelling frees the seat while keeping the row. A slot freed by *deleting* its booking loses the fact that somebody cancelled — and a pattern of cancellations is made of exactly those facts, for the clinic and sometimes for the patient, whose repeated cancellations are a clinical signal rather than an administrative one.

**Overbooking is a number somebody chose**, declared as slot capacity, rather than a constraint defeated. Making overbooking impossible is how a scheduler gets routed around, and a clinic overbooking in a paper diary is worse off than one overbooking here.

Blocking takes a slot out of use without deleting it — leave, a meeting, a scanner down for service. A slot that exists and must not be booked is different from one that does not exist: deleting it loses the fact that the clinic was supposed to be running, which is what a capacity report is made of. A slot with a patient already in it cannot be blocked out from under them.

### A missed appointment is a clinical event

Marking did-not-attend and closing the record is the administrative reading, and for a routine review it is right. For the patient who missed the appointment answering an urgent referral it is a catastrophe with no error attached: the referral reads booked, the clinic's list is clear, and nobody is waiting for anything.

So `didNotAttend()` returns **what is owed**, not just a status:

```ts
{ booking, followUpRequired: true,
  because: "this appointment answers a referral, which is still open and now has nothing booked against it" }
```

`unresolvedNonAttendance()` holds them until somebody says what they did about it — worst first, because a missed urgent appointment gets less recoverable with every week. Clearing one requires an action in words, for the same reason completing a task requires evidence.

### A travelling clinic is one visit, not a pile of slots

A specialist's two days in a community is one thing that happens to contain
slots. `tenant.clinics` plans, repeats, moves and cancels that visit as one
row; the slots stay ordinary rows under the same unique index, so nothing
downstream has to know visits exist. Cancelling the visit puts every booked
patient on a waitlist — bump counted, wait dated from when they first booked,
so weather does not send anybody to the back of the line.

The waitlist's order is stated policy rather than insertion order: clinical
priority, then waited-longest from first asking, then most-bumped. A seat is
offered to a named patient and resolves as accepted, declined or unreachable,
because collapsing "unreachable" into "declined" punishes people for where
they live.

## Consent directives and breaking glass

A patient may withhold their record from a provider, from an organization, or from everybody outside the circle of care that created it. Provincial EHRs call it a consent directive or a lockbox, and it is a clinical fact about the patient — *they do not want this person reading this* — rather than a configuration setting, which is why it lives beside their allergies.

**Every directive is overridable in an emergency.** That is not a weakness in the design, it is the design. A patient unconscious in a resuscitation room cannot lift their own lockbox, and a system that made the override impossible would eventually kill somebody — or, more likely, grow a shared account everybody uses, which is worse in every respect including the audit trail.

### What makes the override safe is not that it is hard

It is that it is **loud**. Four things, and dropping any one turns the other three into paperwork:

| | |
| --- | --- |
| **Declared before it is taken** | The access happens under a stated intention, rather than being reconstructed afterwards from logs. |
| **Reasoned in the clinician's own words** | Not a dropdown. *"Unconscious, no collateral history, need allergy status before induction"* is a defence; *"emergency"* is not — and a dropdown produces only the second. A reason under twelve characters is refused. |
| **The patient is told** | The part systems quietly omit, and the one that makes a directive mean anything. A lockbox nobody can find out was opened is a lockbox with no lock. `pendingNotification()` is a queue that must empty. |
| **Somebody reviews it** | `pendingReview()` is a queue rather than a statistic. An override nobody looks at teaches a ward that breaking glass costs nothing, and a directive that costs nothing to break slows down only the people who would have asked permission anyway. |

An override **expires**. One that did not would be a permission, and this is not one. Reviewing it does not extend it: the access window and the paperwork are separate things.

`frequentBreakers()` reports the pattern rather than the incident. One override is a clinical emergency; forty in a month is a workflow that has decided the directive is an obstacle, and only the count shows it.

Breaking glass where no directive existed is still recorded — the declaration is the thing worth keeping, because it is how *"I did not realise there was no lockbox"* is told apart from a habit.

### Two smaller decisions

**The refusal says a directive exists, never what it says.** "This record is withheld by a patient directive" is what a clinician needs. The patient's reason for withholding is between them and whoever recorded it, and disclosing it to the person being withheld from would be an odd way to honour the instruction.

**A directive narrowed to particular entry types does not withhold the rest of the chart.** Applying it to everything would give the patient more than they asked for, which is its own kind of not listening.

Directives lapse by the clock — revoked, expired, or not yet effective — rather than by a sweep changing a status, for the same reason proxy authority does.

## Tenancy

One platform, many health information custodians, and no code fork per clinic. A tenant is a custodian's boundary: organizations, providers, channels, messages, deliveries, keys, audit and facade records all live inside one.

**Isolation is structural, not conventional.** The tenant is part of the database handle's identity rather than a parameter on every method:

```ts
const db = new Db(path);                 // the default tenant
const north = db.forTenant("moh-north"); // same connection, different boundary
```

A `tenantId` argument is one a caller can forget, and the cost of forgetting it once is a query that reads across custodians — silently, returning plausible results. Here there is nothing to forget: every statement binds the handle's tenant, and reaching another custodian's data means naming them in a `forTenant` call, which is greppable and reviewable.

Isolation is verified two ways, because neither is sufficient alone. `test/tenant-isolation.test.ts` seeds two custodians with **deliberately colliding identifiers** — the same channel id, the same patient id, the same health number — and asks every accessor whether it leaks. Colliding is the normal case, not an edge one, and it is the only case where a forgotten scope returns the *wrong* patient rather than no patient; a test using distinct ids everywhere would pass against code with no isolation at all.

**And the property is checked structurally, not just asserted behaviourally.** `test/tenant-scoping.test.ts` reads the source and requires every statement naming a tenant-scoped table to name `tenant_id`. Behavioural tests only prove the queries someone thought to test are scoped; they say nothing about the fiftieth method or the one added next month. A statement that genuinely spans tenants — the delivery worker's queue sweep, startup reclaim, authentication by key hash — declares itself with a `crosses-tenants:` comment giving the reason, so crossing a boundary is always a visible act rather than an omission.

Terminology is deliberately **not** tenant-scoped. SNOMED CT CA, LOINC and the classification tables are the shared provincial baseline; copying them per tenant would mean a code meaning one thing in one clinic and another elsewhere.

Ids chosen by a caller are unique per tenant, not per platform: `channels.id` because "adt" is what every site calls its admissions feed, and `fhir_subscriptions.id` because a client may supply one. Ids the engine generates — messages, deliveries, keys — stay globally unique, since a UUID cannot collide and the delivery worker needs to address a row without knowing whose it is.

Three things this changed that were not obvious:

- **The ordering key now leads with the tenant.** It was `channel:destination`, and channel ids are only unique within a tenant — so two custodians who both named a channel `adt` would have shared one ordered queue, and a message stuck at one organization's head would have blocked the other's feed entirely. Strict ordering is a per-destination promise, not a promise to serialise the province.
- **A second custodian could not create a channel a first had named.** With a platform-wide key on `channels.id`, the second `upsertChannel("adt")` hit the conflict and did nothing — silently. Not a leak, but a worse shape of failure: a feed that reports success and does not exist. Found by the isolation tests, not by review.
- **The audit truncation check no longer uses SQLite's `AUTOINCREMENT` mark.** That mark counts rows across the whole table, which was exact with one tenant and meaningless with two — every tenant would have reported most of its trail missing. Each tenant now carries its own issued counter, backfilled on upgrade from the old mark so nothing is lost in the transition.

### Requests are confined to the credential's tenant

A key is issued by a custodian and carries that custodian on the stored row. The gate resolves it there and nowhere else — a caller who could name their own tenant on the request would be naming their own authorisation — and every store a route touches comes from that tenant's view of the engine. Scope says what a caller may do; the tenant says whose records they may do it to, so an `admin` key in one organization cannot revoke a key, read a message or replay a delivery in another.

An OIDC token carries its tenant in a `tenant` (or `northstar_tenant`) claim the identity provider controls. Without one the caller lands in the default tenant rather than in whichever one they would have preferred.

**Suspension takes effect immediately.** `setTenantStatus(id, "suspended")` stops that custodian's credentials at the gate, before scopes are consulted, and touches nobody else — suspending an organization whose keys keep working until the next restart is not suspending it.

### Purpose of use

Every request may declare why it is reaching for the record, as an HL7 ActReason code in `X-Purpose-Of-Use`: `TREAT`, `HPAYMT`, `HOPERAT`, `HRESCH`, `PATRQT`, `PUBHLTH`, `HLEGAL`. It is recorded on the audit row and **covered by the hash chain**, so it cannot be revised afterwards into something more defensible.

A closed set on purpose. Free text is a box people type "work" into, and it cannot be reported on. An unrecognised value is dropped rather than stored as typed, and declining to say is recorded as declining to say — "who looked at this chart" is a much weaker question than "who looked, and said they were treating the patient".

Existing databases migrate in place; see [Upgrading](#upgrading). Rows written before tenancy land in the `default` tenant, and a deployment that never configures a second one behaves exactly as before.

## Upgrading

An existing database is migrated in place on the first open. Columns added since it was created are added by `ALTER TABLE`; new tables and indexes come from the schema itself. Running the migration again finds nothing to do, so it costs one `PRAGMA` per tracked column at boot.

This matters more than it sounds. `CREATE TABLE IF NOT EXISTS` does *nothing* to a table that already exists, so before this a column added to the schema never reached a database an earlier version had created — and the failure arrived on the first ingest rather than on open. A site that had been running fine went off the air at upgrade and stayed there, reporting itself healthy. Every test starts from an empty file, so no test could see it; `test/migration.test.ts` starts from the real v0.3.0 table definitions instead.

A chain that spans the upgrade still verifies. Rows written before the digest column commit to the payload itself and rows after it commit to the digest, and `verifyChain` accepts both, so an upgrade does not read as tampering.

Tenancy needs more than added columns. `fhir_resources`, `fhir_identifiers` and `channel_state` had primary keys that were unique across the whole database, and `ALTER TABLE` cannot change a primary key — so those three are rebuilt (create, copy, drop, rename, in one transaction). Without it, the first time a second custodian stored `Patient/p1` it would overwrite the first custodian's patient of that id, which is a silent cross-tenant write and exactly what tenancy exists to prevent. Indexes are applied after the migration rather than with the tables, because an index naming a column the migration is about to add cannot be created before it exists.

One thing to do by hand, once, on a database that ran a version before this one: `sqlite3 data/northstar.db 'VACUUM;'`. Freed pages are zeroed from now on, but pages freed under the old build may still hold legible content, and only a rebuild clears those.

## Backup

Losing this database is the worst thing that can happen to a node. It holds the queue that has not drained, the lineage proving what flowed, the audit trail proving who read it, and the facade a consumer is reading from — a community site with a week of backlog waiting out an outage has a week of unsent clinical messages in one file.

**Copying that file is not a backup.** The engine runs SQLite in WAL mode, so committed data lives in `northstar.db-wal` until a checkpoint folds it in. `cp northstar.db` on a running engine yields a stale or torn snapshot that looks fine until the day it is needed — in testing, the copy could not even be opened.

```bash
npm run backup -- --init-key /etc/northstar/backup.key   # once; store a copy off this machine
npm run backup                                    # -> backups/northstar-<stamp>.db
npm run backup -- --out /mnt/usb --keep 7
npm run backup -- --verify backups/northstar-2026-08-07T15-22-33.db

curl -X POST localhost:8686/api/backup -H "Authorization: Bearer $KEY"
```

Safe against a live engine: this uses SQLite's online backup API, which takes a consistent snapshot without stopping writes.

**A snapshot nobody has opened is not a backup either.** Every snapshot is reopened and its hash chains walked before success is reported, so a backup that says it worked has been read back. A tampered or truncated snapshot fails here rather than on the day it is restored — including one shortened at the end, which passed until the tip check went in:

```
snapshot for channel adt is missing rows from the end of its chain
  (ends at 88963239b741, should end at ef0cc4c56d05)
```

A short chain names no row, because the missing rows are the point; saying "broken at undefined" would send an operator looking for something that is gone.

Each snapshot is exactly one file — the `-wal` and `-shm` sidecars left by verification are removed, because a restore that copies a `.db` while leaving a stale `-wal` beside it would apply a write-ahead log belonging to a different database.

### Off the machine that made it

A local snapshot survives a process crash and a bad upgrade. It does not survive the disk dying, the machine being stolen, the building flooding, or ransomware encrypting the volume the snapshots sit on. Those are the failures that need a restore, and every snapshot `takeBackup` writes is still on the same disk as the database it came from.

`NORTHSTAR_BACKUP_REMOTE` is a destination that is not this machine, configured rather than hard-coded:

| | |
|---|---|
| `s3://bucket/prefix` | S3-compatible object storage. HTTPS required except on loopback. |
| `sftp://user@host/path` | Reuses the existing SFTP client. |
| `fs:/absolute/path` | A directory treated as elsewhere — tests, CI, and a mount that really is another machine. |

The snapshot is encrypted here (AES-256-GCM) before it is handed over, put, **read back**, decrypted, and walked again. An upload that returned 200 is not a copy. A failed replica is visible on `/api/health` (`remoteBackup`) and `/metrics` (`northstar_backup_remote_ok`, `_age_seconds`) and marks the node degraded — silent failure here is the same hazard as a chart section rendering "none" when it failed to load. The local snapshot is still written; 500 means the half that survives the machine did not.

**The key has to outlive the host.** `NORTHSTAR_BACKUP_KEY_FILE` is 32 bytes, hex or raw. It must live somewhere this machine dying does not take with it: a secrets manager on another system, a USB in a drawer two buildings over, a printed hex string in an envelope. A key that only this machine can read unlocks nothing after the flood, and a remote copy nobody can decrypt is not a backup. Restoring begins with producing that key, not with finding the object. If the key file appears to share a volume with the database, boot says so.

**Immutability is the destination's job.** A backup an attacker holding production credentials can delete is a backup that does not survive the attack most likely to need it. Object-lock, or write-only credentials (put + get + list, no delete), are the usual answers and both have operational costs. When delete is refused, prune reports that and does not fail the backup — remote retention is then the destination's policy, which is what making the objects undeletable chose. `NORTHSTAR_BACKUP_REMOTE_KEEP` is independent of local `_KEEP` and is unset by default, so a destination that can delete is not pruned unless somebody said so.

Unconfigured is a posture, like an unencrypted volume: reported on health and at boot, not degraded. Configured-and-failed is an incident.

```
WARNING: no off-machine backup destination is configured (NORTHSTAR_BACKUP_REMOTE).
Local snapshots survive a process crash and a bad upgrade; they do not survive
the disk dying, the machine being stolen, or the building flooding. The stated
RPO is only real for failures that spare the backup directory.
```

### Restoring

With the engine stopped:

```bash
systemctl stop northstar
npm run restore -- --from backups              # newest local snapshot
npm run restore -- --from remote               # newest off-machine copy; fetches and decrypts
npm run restore -- --from remote --snapshot northstar-2026-08-19T14-00-00.db
npm run restore -- --snapshot backups/northstar-2026-08-19T14-00-00.db
systemctl start northstar
```

This used to be a documented sequence of `mv`, `rm` and `cp`, and the `rm` was the step people skip — a stale `-wal` left beside the restored file points SQLite at a write-ahead log belonging to the database you just replaced. A procedure that depends on nobody skipping a step at 03:00 is not a procedure, so it is code now.

It refuses to run against a database something still appears to hold, because restoring under a live engine hands it a file it does not own and the damage is silent. Nothing is deleted: the database being replaced is moved aside with a timestamped suffix and kept, because a restore is always made by somebody having a bad day and is sometimes the wrong call.

**The snapshot is proved to come up before anything is displaced.** Not by verifying the snapshot in place — that cannot work across versions, and finding out why is most of what rehearsing this was worth. `verifyBackup()` opens read-only, and a read-only handle skips both `SCHEMA` and `migrate()`, so it queries the *current* schema against a file written by whatever version took it: a snapshot one release old failed with `no such table: channels` and the verified path refused a perfectly good backup. So the preflight copies the snapshot somewhere temporary, opens the copy *writable* so the migration actually runs, and verifies that. One extra pass over the file buys the answer an operator actually needs — not "was this valid when written" but "will this come up under the code I am about to run" — and the migration is exercised before it is committed to rather than during the outage.

### What restoring costs

Measured by `npm run restoretest`, which takes a snapshot from under a live engine, encrypts and replicates it through the off-machine store, deletes the local snapshot, fetches the replica, restores it to a directory the database has never occupied, and boots an engine against it in a separate process. It runs nightly in CI on both supported Node versions.

| database | backup | restore | engine start | **RTO** |
|---|---|---|---|---|
| 10 MB (20,000 messages) | 141 ms | 0.2 s | 0.3 s | **0.5 s** |
| 96 MB (200,000 messages) | 2.5 s | 3.3 s | 2.8 s | **6.0 s** |

Single runs on one machine, so read them as an order of magnitude rather than a benchmark: a hundred-megabyte database comes back in seconds, not minutes. Re-run `npm run restoretest --messages <n>` on your own hardware for a number you can put in a service agreement.

**RPO is a property of your schedule, and of which disk survives.** There is no single number.

| What failed | What you still have | RPO |
|---|---|---|
| Process crash, bad upgrade, a restore you decide was the wrong call | The local snapshot in `NORTHSTAR_BACKUP_DIR` | time since the last local snapshot |
| The disk, the machine, the building, ransomware on that volume | The last *verified replica* at `NORTHSTAR_BACKUP_REMOTE` | time since the last successful replication |
| The disk, and no remote was configured | Nothing | everything |

A node snapshotting every 24 hours loses up to 24 hours of the message log — and the clinical record, which is in the same file — to a process crash. The same cadence against a dead disk is only real if the last replica left the machine. Shorten the cadence to shorten it — a snapshot of a 96 MB database cost 2.5 seconds against a live engine, so hourly is affordable at that size. Replication is one more pass over the file plus the network; budget for that, and alert on `northstar_backup_remote_ok` going to 0.

**The RTO is a floor, not a promise.** It is restore plus boot. It excludes noticing the outage, deciding to restore, and finding the snapshot, which on a real night are most of the elapsed time.

**What the rehearsal does not prove.** It takes the encrypt / put / read-back / decrypt / restore path, against a destination that is a directory on the same runner. That is the code an operator walks when the disk is gone. It is not a second machine, a different filesystem, or a live object store — saying "rehearsed off-box" would be the overclaim this exercise exists to refuse. The S3 and SFTP transports are tested against fakes. Running it on Node 22 and 24 covers the part that bites in practice: two different `node:sqlite` builds opening the same file.

`NORTHSTAR_BACKUP_DIR`, `NORTHSTAR_BACKUP_KEEP`, `NORTHSTAR_BACKUP_REMOTE` and `NORTHSTAR_BACKUP_KEY_FILE` configure the API endpoint.

## Monitoring

`GET /api/health` returns counters and, more usefully, the signals worth alerting on. Nobody watches a dashboard at 03:00 at a community site, and a total delivered count looks identical whether the queue moved a minute ago or a week ago.

```json
{
  "ok": true,
  "degraded": false,
  "signals": {
    "deadLetters": 0,
    "queued": 0,
    "oldestQueuedAgeSec": null,
    "stalledChannels": [],
    "lastDeliveryAt": "2026-08-07 15:22:29",
    "stalledAfterSec": 3600
  }
}
```

`degraded` is set by a dead letter, a channel holding work older than `?stalled_after_sec=` (default an hour), a silent feed, or a configured off-machine backup whose last replica failed. It is deliberately *degraded* rather than *unhealthy*: an engine holding a backlog through a satellite outage is working exactly as designed, and only an operator can say whether a backlog this old means something is wrong. `stalledChannels` names the feed, which is the first thing anyone needs and the thing a counter cannot say. An unconfigured remote is a posture (`remoteBackup.configured: false`) and is not degraded; configured-and-failed is.

`GET /metrics` serves the same in Prometheus text format:

```
northstar_deliveries{state="delivered"} 3
northstar_dead_letters 0
northstar_oldest_queued_age_seconds 0
northstar_channel_oldest_queued_age_seconds{channel="oru-to-fhir-observation"} 412
```

Both are public alongside liveness — a scrape happens before any credential is configured, and neither carries patient data: counters, ages and channel ids only. Neither writes to the audit trail, or a 15-second scrape would bury the disclosures the trail exists to surface.

### A feed that has gone quiet

Every signal above reports on what is *in* the queue — depth, dead letters, the age of the oldest undelivered message, which channels are stalled. A feed that stops sending puts nothing in the queue, so all of them read healthy: a dead ADT interface and a quiet night are indistinguishable.

A backlog is loud — it grows, it ages, it eventually dead-letters. Silence is not, and at an unattended site it is the failure most likely to run for days before anyone notices the records stopped arriving.

```json
{ "id": "adt", "name": "admissions", "expectMessageEverySec": 3600, "source": { "…": "…" } }
```

A channel that declares a cadence and exceeds it appears in `signals.silentChannels`, makes `/api/health` report `degraded`, and exports `northstar_channel_silent{channel="adt"} 1`. `northstar_channel_last_message_age_seconds` carries the age itself, so an alert is a threshold on a number rather than a special case.

Off unless declared, deliberately. No threshold fits both a nursing station admitting four patients a day and a regional lab pushing results every few minutes, and an alert that fires constantly is one nobody reads — which is worse than the gap it was meant to close. A channel that has *never* received anything is reported too: never having started is as much an outage as having stopped, and it is the one an operator hits the day they stand a feed up.

## Throughput

```bash
npm run loadtest -- --messages 10000
```

Measured on one core, ten thousand ADT messages through a filter, a mapping and an ordered destination:

| | rate |
|---|---|
| ingest | ~1,100/s |
| ordered drain | ~200/s |
| chain verify, 10,000 messages | 57ms |
| backup and verify, 33 MB | 184ms |
| every admin and FHIR endpoint | under 30ms |

About 3.5 KB of database per message, with the raw payload, its lineage, its pipeline steps and its delivery rows all retained.

**Ingest is deliberately bounded by durability, not by speed.** Each message commits as one transaction, and a commit is an fsync, because an MLLP AA promises the message is on disk rather than merely received. That ceiling is the guarantee working; raising it would mean weakening the promise, so it stays.

The drain rate is a property worth watching in particular, because it is what a satellite outage exercises. An ordered destination sends strictly one message at a time — each only after the previous succeeded — but in a loop rather than one per timer tick. Before that distinction was drawn, an ordered channel released a single message per tick regardless of how fast the far end answered, and the rate *fell* as the backlog grew because the gating query could not use an index. A ten thousand message backlog took hours. `test/throughput.test.ts` pins the property: one pass must drain the backlog, and it must still arrive in order.

## Durability under failure

Three things the acknowledgement contract depends on, each tested rather than assumed.

**Every commit is flushed.** WAL with `synchronous=NORMAL` survives a process crash but can lose recent transactions to a power cut. Community sites lose power, and an AA has already promised the message is safe, so the engine runs `synchronous=FULL` and a test pins it — this is what the ~1,100/s ingest ceiling buys, and it should not be quietly traded for throughput.

**A failed write is never acknowledged AA.** If the store cannot accept a message, the sender is told AE, or gets no answer. The dangerous outcome is a positive acknowledgement for a message that was never stored: the sender believes it is safe, drops it, and it is gone.

```bash
sudo mount -t tmpfs -o size=1M tmpfs /mnt/northstar-tiny
npm run diskfulltest -- --dir /mnt/northstar-tiny
```

Against a genuinely full filesystem: ten messages, ten AEs, no false AA, and only the messages that were acknowledged are stored. **The feed resumes on its own once space is freed** — no restart needed. A full disk is not hypothetical here: the message log grows with every message, and a community site is not somewhere anyone notices a disk filling up. See [Retention](#retention).

## Crash recovery

```bash
npm run crashtest -- --messages 300 --kills 3
```

Runs a real engine in its own process against a real database file, SIGKILLs it partway through draining, starts it again, and checks what survived. SIGKILL rather than a graceful stop on purpose: the interesting case is the one with no chance to clean up — power loss at a community site, an OOM kill, a container stopped hard mid-deploy.

**What is guaranteed:** nothing is lost, order is preserved, and the hash chain still verifies.

**What is not, and cannot be:** exactly-once. If the process dies between the remote receiving a message and the outcome being committed, the two are indistinguishable, and redelivering is the only safe answer — losing it is not. At most one delivery per ordering key is ever in that state, so a crash redelivers at most one message. This is why the FHIR facade is content-addressed: a repeated upsert is a no-op, and an interface replayed into it converges rather than duplicating.

The demo's "zero duplicates" claim is about an *outage*, and still holds there: a send that fails is recorded as failed, so nothing is ambiguous. A crash is the harder case, and it is worth being precise about the difference.

A restart also requeues any delivery left in flight. Without that, one orphaned row stops a feed permanently — nothing ever claims an in-flight delivery, and an ordered destination treats it as blocking, so everything behind it waits forever. It fails silently, which is the worst way for a clinical feed to fail.

### One engine per database

That reclaim assumes nothing else is running, and the engine now enforces it rather than assuming it. A second engine started against the same database file refuses, naming the process that holds it:

```
another Northstar instance owns this database (pid 4744 on ykpcc-01, last seen 1s ago).
Two engines on one database duplicate messages.
```

SQLite permits two writers, so without the check nothing objects — and the failure is silent rather than loud. Both engines claim due deliveries, and each one's startup reclaim requeues the *other's* genuinely in-flight sends, so a clinical message goes out twice. An overlapping deploy or a stray second `npm start` is enough. `test/instance-lock.test.ts` demonstrates the duplication against a real second engine rather than only asserting the refusal.

The claim has to survive the case it exists to protect, so a crash must not deadlock the restart that follows it:

- **Holder on this host, process gone** — taken over immediately, checked by pid. This is the ordinary crash-then-restart path and it costs no delay, which is why `npm run crashtest` still restarts instantly.
- **Holder on another host, or a reused pid** — a pid from another machine says nothing about whether that process is alive, so the only safe signal is the heartbeat. The claim is honoured until it goes stale (default 20s, `lockStaleMs`).
- **Clean shutdown** — released on `stop()`, so a planned restart never sits out the staleness window.

## Architecture

```
                         auth gate (scopes, mTLS)
                                 |
sources                 pipeline                        destinations
-------                 --------                        ------------
MLLP listener   --->    filter.hl7Type          --->    http (retry, backoff, mTLS)
HTTP /ingest    --->    filter.hl7FieldEquals   --->    mllp (framed, NAK aware)
FHIR /fhir/:T   --->    filter.jsonEquals       --->    fhirstore (local facade)
filedrop dir    --->    split.hl7Group                          |
sqlite poll     --->    split.hl7Segment                        | validate.profile
postgres poll   --->    transform.mapping                       v
mysql poll      --->    validate.profile                GET /fhir/:Type[/:id]
sftp poll       --->                                    rest-hook Subscriptions
  (any on cron) |                              |
                 v                              v
        messages + steps                 deliveries queue
        (hash chained)                   (ordered, replayable)
```

Everything flows through `Engine.ingest`, which is deliberately synchronous: the raw message is stored on the channel's hash chain, the pipeline runs with every step recorded (a pipeline carries a set of payloads: filters narrow it, the split steps widen it, transforms map it one to one, `validate.profile` gates or annotates it), and one durable delivery row is enqueued per payload per destination, all before the source is acknowledged. An MLLP AA therefore certifies durability. Transform failures return AE with the error recorded on the message.

The delivery worker wakes on a short tick, claims due deliveries, and honours ordering: an ordered destination will not release a message while any earlier message for that destination is queued, in flight, or dead-lettered. A dead head of line is resolved by replaying it (after fixing the fault) or discarding it, either of which releases the queue. Failures back off exponentially per destination configuration and dead-letter after `maxAttempts`.

Delivery into the facade is where conformance is enforced, if a pack is configured. That check runs *before* anything is written — ahead of the unchanged-content short circuit, not merely ahead of the insert — so a rejected resource is never stored and a retry re-validates honestly rather than finding its own earlier write already present and reporting success.

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

  clinical/record.ts       the append-only chart, hash chained per patient
  clinical/patients.ts     patient index, derived and rebuildable from the log
  clinical/notes.ts        drafts, signatures, co-signatures, addenda
  meds/store.ts            medication list, allergies, reconciliation
  meds/safety.ts           the check that runs before a prescription is signed
  orders/store.ts          orders, results, and acknowledgement that cannot be inherited
  work/tasks.ts            the unified inbox
  work/referrals.ts        closed-loop referrals and the stalled query
  schedule/store.ts        slots and bookings, double-booking refused by an index
  schedule/clinics.ts      travelling-clinic visits and the waitlist
  population/registry.ts   cohorts, care gaps, quality measures with honest denominators
  patient/access.ts        patient and proxy authority, result release timing
  patient/enrolment.ts     clinic-attested binding of an OAuth subject; pending is not a grant
  patient/notice.ts        break-glass and patient notices; dispatching is not telling
  patient/consent.ts       consent directives and break-glass
  privacy/office.ts        reviews, holds, incidents, clocks, assurance catalogue
  workspace/summary.ts     the assembled chart, declaring what it left out

  api/admin.ts        admin, ingest, clinical, terminology, conformance and FHIR API
  api/tls.ts          TLS and mutual TLS for the listener
  api/ratelimit.ts    per-principal and per-source token buckets
  api/ui.html         single-file admin UI served at GET /
  api/patient.html    patient HTML shell served at GET /me (not a certified portal)
  auth/scopes.ts      the scope model and the route-to-scope map
  auth/keys.ts        API key issue, verify, revoke
  auth/jwt.ts         OAuth 2.0 / SMART bearer validation against a JWKS
  auth/gate.ts        the one check every request passes
  audit/store.ts      hash-chained access trail
  audit/review.ts     who looked, and whether anything clinical linked them
  core/channel-versions.ts  channel configuration as a ledger, not an overwrite
  core/text.ts        small helpers for messages people read
  core/atrest.ts      whether the data directory is on an encrypted volume
  core/retention.ts   payload redaction and purge under a retention policy
  core/backup.ts      verified online snapshots
  core/backup-crypto.ts  AES-256-GCM wrap for a snapshot that is leaving
  core/remote.ts      off-machine destination, read-back, remote restore
  core/remote-s3.ts   S3-compatible SigV4 client (no AWS SDK)
  connectors/sql.ts   Postgres and MySQL polling clients
  connectors/sftp.ts  SFTP polling client
  connectors/cron.ts  five-field cron schedules
  terminology/loaders/  SNOMED RF2, LOINC CSV and delimited release readers
  server.ts           entry point, seeds channels, mappings, terminology, conformance
channels/             channel configurations seeded at boot
mappings/             mapping documents registered at boot
terminology/          terminology packs loaded at boot (labelled demo subset shipped)
conformance/          conformance packs registered at boot (ps-ca, ca-fex, ca-erec)
fixtures/             synthetic HL7 test messages and conformance fixtures
demo/                 satellite link simulator, Meridian endpoint simulator, scripted demo
scripts/              dev certificate generation, terminology import, backup, load/crash/disk-full tests
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

Sources: `mllp` (port, host, maxFrameBytes; port 0 binds ephemeral), `http` (POST /ingest/:path), `fhir` (POST /fhir/:resourceType with resource type validation), `filedrop` (poll a landing directory: dir, pattern, pollMs, archiveDir; files ingest in name order), `dbpoll` (poll a SQLite database: query with a single ? bound to the persisted cursor, cursorColumn, pollMs), `sqlpoll` (the same against Postgres or MySQL: driver, dsn, query, cursorColumn, initialCursor), `sftp` (poll a remote directory: host, port, username, password or privateKeyPath, dir, pattern, archiveDir).

Every polling source accepts `cron` instead of `pollMs` — a five-field expression, evaluated to the minute.

Pipeline steps: `filter.hl7Type` (MSH-9 allow list), `filter.hl7FieldEquals` (HL7 path equality), `filter.jsonEquals` (JSON path equality), `split.hl7Segment` (one output per instance of a repeating segment: an ORU with three OBX becomes three messages; zero instances filters the message), `split.hl7Group` (one output per anchor segment, each carrying the shared header plus everything up to the next anchor: a two-battery ORU becomes two messages that keep their own OBX and NTE children), `transform.mapping` (registered mapping id or inline document), `validate.profile` (validate JSON payloads against a conformance pack; reject fails the message, annotate records the issues and passes it through). Filtered messages are stored and acknowledged but produce no deliveries.

Destinations: `http` (url, method, headers, contentType, timeoutMs, and `tls` for a client certificate), `mllp` (host, port, timeoutMs; a remote MSA AE or AR is treated as failure) and `fhirstore` (no endpoint: upserts into the local facade store, optionally gated by `validatePack` and `validateMode`). All take `maxAttempts`, `backoffBaseMs`, `backoffCapMs`, `ordered`, `skipOnDead`.

## Character sets

HL7 v2 carries bytes and declares what they mean in MSH-18. Decoding every frame as UTF-8 regardless — which is what this did — corrupts every message that is not UTF-8, permanently and without saying so:

```
family: "B�dard"     given: "Ren�ee"     second: "Th�r�se"
```

Those are `Bédard`, `Renée`, `Thérèse` in ISO-8859-1, which is what most older HL7 v2 interfaces emit. The replacement character is lossy, so the original bytes are gone; the sender is acknowledged `AA`, and the chain commits to the corrupted bytes and verifies clean forever. That is the same class of failure as acknowledging a message that was never stored, and worse in one respect, because the corrupted record still looks like a record. It is not an edge case here either — French names, Dene names and Inuktitut syllabics are most of the register in the north.

Decoding is now strict and by declaration:

- **MSH-18 wins.** The sender is stating a fact about the bytes it just sent. MSH is ASCII by construction, so the field is read with a byte-preserving pass before the rest of the frame is decoded.
- **A channel's `charset` covers senders that declare nothing**, which is most of them. Set it to `8859/1` for a feed that speaks ISO-8859-1 silently.
- **Undecodable is refused, never substituted.** A frame that is not valid in its character set gets an `MSA|AR` naming the message control id and the reason, and nothing is stored. A rejection is recoverable; a corrupted name in a chart is not.
- **Acknowledgements go back in the character set the sender used**, so an accented name echoed in the ACK is the one they sent.

```json
{ "id": "adt", "source": { "type": "mllp", "port": 6661, "charset": "8859/1" } }
```

Supported: `ASCII`, `8859/1`, `8859/2`, `8859/15`, `UNICODE UTF-8`. Anything else is refused by name rather than guessed at. Outbound frames are fully supported in UTF-8 and ISO-8859-1; for `8859/2` and `8859/15` the high byte values do not line up with what Node can encode, so those decode inbound in full — the direction that carries patient data — and encode ASCII outbound, refusing anything else rather than mangling it.

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
POST   /api/backup                          verified online snapshot; off-machine replica when configured
GET    /metrics                             Prometheus exposition (public, no patient data)
GET    /api/audit?patient=&principal=&failures=  who accessed patient data
GET    /api/audit/verify                    walk and verify the audit hash chain
GET    /api/audit/review?patient=           who looked, flags, dismissible with a reason
POST   /api/audit/review/dismiss            close a flag, with a reason that is kept
GET    /api/channels/export                 the configuration as a versioned document
POST   /api/channels/import                 a plan, then an action; a dry run writes nothing
GET    /api/retention                       policy, and what a sweep would touch
POST   /api/retention/run                   apply the retention policy now
GET    /fhir/AuditEvent?patient=&_count=    the same trail as R4 AuditEvent (admin only)
GET    /api/keys                            list API keys (metadata only, never the keys)
POST   /api/keys                            issue a key; the response is the only time it is shown
DELETE /api/keys/:id                        revoke a key
GET    /api/mappings                        registered mapping documents
POST   /api/mappings/preview                {mapping, sample} -> mapped output; persists nothing
GET    /api/fixtures                        shipped sample messages, for the mapping editor
GET    /api/history?hours=&bucket=hour|day  message arrivals and delivery completions over time
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
GET    /me                                  patient HTML shell (EN/FR chrome; not a certified portal)
```

## FHIR facade

Channels that end in a `fhirstore` destination feed a local R4 store that the API serves back read-only. Versioning is content-addressed: an upsert that changes nothing keeps its `versionId`, a change increments it, so replaying an interface is idempotent at the facade. Resources arriving without an `id` get a deterministic one derived from their first identifier, so repeated ADT updates for the same health card number converge on one Patient instead of minting duplicates. The default resource set mirrors the Meridian Health FHIR server (Patient, Condition, Observation, MedicationRequest); any other valid R4 resource type is stored and served the same way.

```bash
curl localhost:8686/fhir/metadata
curl "localhost:8686/fhir/Patient?identifier=https://ehealth.gov.nt.ca/fhir/NamingSystem/nwt-hcn|NT123456"
curl "localhost:8686/fhir/Observation?identifier=FL9001-NT123456-1-718-7"
```

## Satellite demo

`npm run demo` stands up the whole story in one process: a Meridian endpoint simulator playing the territorial EHR, a satellite link simulator with latency, jitter and a hard outage, and a Northstar channel carrying community ADT through the link.

```
[community EMR feed] --MLLP--> Northstar --HTTP over satlink--> Meridian (territorial EHR)
```

Phase A sends admissions across a healthy link. Phase B cuts the link and keeps sending: every message is still acknowledged AA, because an AA certifies durable queueing rather than remote delivery, and the queue grows. Phase C restores the link and the backlog drains in strict arrival order with zero loss and zero duplicates, then the hash chain is verified. Tune it with `--messages-before`, `--messages-during`, `--outage-ms`, `--latency-ms`, `--jitter-ms`, `--packet-loss-pct`, `--bandwidth-kbps`. The same scenario runs compressed inside the test suite in `test/demo.test.ts`, and `demo/satlink.ts` and `demo/meridian-sim.ts` both run standalone for manual testing against a live instance.

The harder and more realistic case is a narrow, lossy link:

```bash
npm run demo -- --packet-loss-pct 8 --bandwidth-kbps 128
```

Bandwidth shaping is a per-direction token bucket, so a large message takes real time to clear rather than arriving whole. Packet loss is modelled as **retransmission delay, not discarded bytes**, and that distinction is deliberate: the simulator is a TCP proxy, so by the time a chunk reaches it the sender has already had it acknowledged. Dropping it would silently truncate the stream — something a real lossy link never does, because TCP retransmits — and a demo resting on that would "prove" the engine survives data loss that cannot actually occur. What an application really experiences under loss is delay, with the timeout doubling per successive failure, and that is what is simulated.

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

reject fails the message, which surfaces as an AE at an MLLP source with the first issue in the acknowledgement; annotate records the issues on the message step and passes the payload through, the honest setting while a feed is being cleaned up. The same validation runs on demand at `POST /api/conformance/validate`.

Enforcement also happens at the facade, on the write itself, configured per destination or engine-wide:

```json
{ "id": "facade", "type": "fhirstore", "validatePack": "ps-ca", "validateMode": "reject" }
```

A rejected write fails the delivery, which retries and then dead-letters with the reason attached — visible in the DLQ rather than silently absent. Nothing is stored and no subscription fires.

The two checks are not deduplicated, on purpose. A pipeline `validate.profile` runs at ingest; the write happens later off the queue — 250ms normally, but hours later after retries or a replay, by which point a pack may have been tightened. The write-time check is the one that reflects the rules in force when the data actually lands.

### What each pack actually covers

Stated per pack rather than as "the packs exist", because a pack claiming conformance it does not have is the same failure mode as a chart section rendering "none" when it failed to load.

| Pack | Profiles enforced | Rules | Capability self-check | Scored against Projectathon scripts |
| --- | --- | --- | --- | --- |
| `ps-ca` | Patient, Observation, Condition, MedicationRequest | 17 | resource types + interactions | **No** |
| `ca-fex` | Bundle | 3 | resource types + interactions | **No** |
| `ca-erec` | ServiceRequest, Patient | 8 | resource types + interactions | **No** |

The last column is the one that matters. Every rule in these packs encodes *this project's reading* of a published specification, and passes the fixtures shipped beside it. None has been run against Infoway's published Projectathon test scripts, which are the only thing that settles whether the reading is right — a pack that passes its own rules and fails a Projectathon script is not a conformance pack, it is a plausible guess with a test suite. Each pack's `name` says "working profile pack" for that reason.

Obtaining and running those scripts is [#23](https://github.com/ThomasGenua/healthsystem/issues/23), and it is gated on a relationship with Infoway rather than on code.

## Subscriptions

`POST /fhir/Subscription` with a rest-hook channel registers a consumer. **This needs `admin`**, not `write` — see [Security](#security) for why. A change in the facade store (created or updated; an unchanged upsert never notifies, because versioning is content-addressed) enqueues one delivery per matching active subscription on the same durable queue as everything else, so notifications get retry with backoff, dead-lettering, replay and strict per-subscription ordering, and they survive a restart. Criteria is a resource type with an optional identifier token: `Observation`, `Patient?identifier=NT123456`, or `Patient?identifier=system|value`.

Registering and removing one are both recorded on the audit trail, with the endpoint and criteria. A subscription is the largest disclosure decision the API offers — every matching record, to that address, indefinitely — and it was previously the only one that left no mark, while a single record read left one. A refused attempt is recorded too, since someone trying to arrange an exfiltration is exactly what an audit trail is for.

The endpoint an operator configures is trusted, the same way a channel's HTTP destination URL is: an operator who can rewrite a channel can already route anything anywhere, so there is no boundary left to enforce at that point. That is the reason subscription management belongs behind `admin` in the first place.

## Connectors

`filedrop` polls a landing directory, ingests each file as one message in filename order, then archives or deletes it. This remains the simplest SFTP pattern for northern sites: openssh terminates the transfer into the directory and Northstar takes it from there, so there is no bespoke protocol code to certify. `sftp` does the same against a remote server when there is no local landing directory to watch — archive or delete happens only after the message is durably stored, so a crash mid-poll re-reads the file rather than losing it.

`dbpoll` polls a SQLite database with a cursor bound into the query (`SELECT * FROM results WHERE id > ? ORDER BY id`); `sqlpoll` does the same against Postgres or MySQL. Both persist the cursor in the engine database, so a restart resumes exactly where it stopped. Queries always use `?` for the placeholder — the Postgres adapter rewrites it to `$1` — so the same channel JSON reads the same way whichever database is behind it.

Connections are made lazily inside the poll and dropped on failure, so a channel whose database or SFTP host is unreachable at boot still starts and picks up when the link returns. On these networks that is the normal condition, not the exception.

Every polling source can run on a cron schedule instead of a fixed interval:

```json
{ "type": "sqlpoll", "driver": "postgres", "dsn": "postgres://…", "cron": "*/15 * * * *",
  "query": "SELECT * FROM results WHERE id > ? ORDER BY id", "cursorColumn": "id" }
```

Day-of-month and day-of-week are OR'd when both are restricted, as standard cron does. A bad expression is rejected when the channel is configured, rather than leaving it activated and silently never firing.

All of these are engine sources, so everything downstream — pipeline, lineage, ordered delivery, replay — is identical to a socket feed.

## Admin UI

`GET /` serves a single-file, no-build UI over the public API: a dashboard with live counts, history charts, an access audit view, channels with hash-chain verification, a channel designer, a mapping editor with live fixtures, a message browser with per-step lineage, the delivery queue with dead-letter replay and discard, a FHIR facade browser, subscription management, terminology lookups, a conformance validator, and a **Privacy** tab over the office queues. It is deliberately thin; anything it does, curl does.

`GET /me` is a separate file: English/French chrome, a skip link, landmarks, and a banner that says this is not a certified portal and that the page does not enrol anyone. It does not load a chart.

Paste an API key into the box in the header and it is attached to every request; it is held in browser local storage and sent nowhere else.

The **designer** builds a channel against the source, pipeline and destination unions with a live JSON preview, and can load an existing channel to edit. The **mapping editor** previews a mapping document against a shipped fixture through `POST /api/mappings/preview`, which runs the mapper alone — no channel, no queue, no store — so previewing has no side effects. **History** charts message arrivals and delivery completions; messages are bucketed by arrival and deliveries by completion, because a message received during an outage and delivered hours later belongs in both places, and collapsing them onto one axis would hide exactly what is worth watching.

Charts are hand-rolled inline SVG. A chart library would have been less code, but it would break the page's no-external-request property, which is what lets it be served from an engine on an isolated network at all.

## Loading a licensed terminology release

Nothing licensed ships here. The loaders read the distributions as published:

```bash
# SNOMED CT CA, from the RF2 snapshot files
npm run terminology:import -- --format rf2 \
  --in sct2_Concept_Snapshot_CA1000087_20260501.txt \
  --descriptions sct2_Description_Snapshot-en_CA1000087_20260501.txt \
  --system snomed --pack snomed-ca

# LOINC, from the published CSV
npm run terminology:import -- --format loinc --in Loinc.csv --system loinc

# ICD-10-CA, pCLOCD, CCI: plain code/description tables
npm run terminology:import -- --format csv --in icd10ca.csv \
  --system icd10ca --code-column Code --display-column Description
```

`--system` accepts a URI or one of the shorthands `snomed`, `loinc`, `icd10ca`, `pclocd`, `cci`. `--db` chooses the database (default `./data/northstar.db`) and `--out` additionally writes a pack JSON file.

Everything streams and loads in batches, because a SNOMED snapshot runs to millions of rows. Concepts upsert on (system, code), so re-running a release is safe. RF2 emits only active concepts, uses the fully specified name as the display, and trims its trailing semantic tag — "Asthma (disorder)" becomes "Asthma".

## Licence

[Apache-2.0](LICENSE). Permissive, with an explicit patent grant — chosen
because the software is meant to be deployed and adapted by health authorities
and their vendors, and because clinical-safety and terminology mechanisms are
the kind of thing patent claims attach to. A licence that leaves that
unaddressed puts the risk on whoever deploys it.

Copyright 2026 Thomas Genua.

Northstar carries no clinical content and no licensed terminology. SNOMED CT,
LOINC, pCLOCD and ICD-10-CA are licensed separately by their owners; the
loaders in `scripts/` read releases you are already entitled to and ship none
of them. See [Loading a licensed terminology release](#loading-a-licensed-terminology-release).

## Contributing

Issues and pull requests are welcome. Two things worth knowing before you open
one:

- **Never attach real patient data**, in any form, including screenshots and
  log excerpts. `fixtures/` and the test suite carry synthetic identifiers for
  exactly this.
- **A suspected vulnerability is not an issue.** It goes through private
  disclosure — see [SECURITY.md](SECURITY.md).

`npm run typecheck && npm test` is what CI runs on every push; the crash,
disk-full, restore and load tests run nightly and can be triggered by hand
from the Actions tab.

## Roadmap

Tracked as issues rather than prose, so each one can be scoped, argued with and
closed. In the order it would be worth doing.

0.5.0 closed the first three: the restore is rehearsed and measured ([#15](https://github.com/ThomasGenua/healthsystem/issues/15)),
a scope-narrowed directive withholds its section rather than the chart around it
([#16](https://github.com/ThomasGenua/healthsystem/issues/16)), and the chart is in front of a clinician ([#19](https://github.com/ThomasGenua/healthsystem/issues/19)).
[#37](https://github.com/ThomasGenua/healthsystem/issues/37) is done: a snapshot leaves the machine, encrypted, read back and walked, and the restore path accepts the remote copy.

**Prove what is currently only claimed.**

- [#21 A clinical safety case and hazard log](https://github.com/ThomasGenua/healthsystem/issues/21) is done: [docs/CLINICAL-SAFETY.md](docs/CLINICAL-SAFETY.md) is the form a safety officer can open, and `test/clinical-safety.test.ts` fails if a cited test is gone. It is not signed by an independent clinician, and it says so (R-01).
- [#22 An external penetration test](https://github.com/ThomasGenua/healthsystem/issues/22) — the adversarial tests here share their author's model of what an attack looks like. The interesting findings are outside it.

**Make the consent enforcement precise.** Done. [#17](https://github.com/ThomasGenua/healthsystem/issues/17): credentials carry an organization, so a directive against one clinic no longer withholds from the territory. [#18](https://github.com/ThomasGenua/healthsystem/issues/18): a break-glass notice is dispatched through the delivery machinery rather than left on a queue for somebody to remember, and what could not be sent says so. What remains is honest and small — *sent* is still not *told*, and recording that the patient was actually told is a deliberate human act, because the last step happens on a channel Northstar does not own.

**Model what the system talks about.** Done. [#32](https://github.com/ThomasGenua/healthsystem/issues/32) and [#33](https://github.com/ThomasGenua/healthsystem/issues/33): a visit owns what happened inside it, and a practitioner, organization, location or service is a party that the FHIR facade serves as `Practitioner`, `PractitionerRole`, `Organization`, `Location` and `HealthcareService`. [#34](https://github.com/ThomasGenua/healthsystem/issues/34): two charts a person has decided are one person link reversibly — on evidence that is kept, never inferred, never merged. The chart assembles across the link with every row still attributed to the chart it was written on, says on its face that it is assembled, takes the worst member's answer for every status, and withholds when any member's directive says to. Unlinking restores the prior view exactly, with the reason kept.

**Put it in front of a person.**

[#35](https://github.com/ThomasGenua/healthsystem/issues/35) is done in two complementary pieces. A privacy officer can open a review of the last 24 hours, address flags with a written reason, place a legal hold that skips the retention sweep, record a disclosure when fulfilling an access request, and close an incident only after saying whether patients were told. The assurance catalogue cannot close a finding by forgetting it. Separately, `GET /api/audit/review?patient=` answers who looked, whether anything clinical linked them to the patient, and what to look at first — with each flag saying why it fired, dismissible with a reason that is kept, and the chain's verification attached to the report. Credentials carry a practitioner to make that join possible. It is not a SIEM, not a PIA product, and after-hours is UTC.

- [#23 Validate the conformance packs against the published Projectathon scripts](https://github.com/ThomasGenua/healthsystem/issues/23) — the packs validate against this project's reading of the specifications, which is not the same as conforming to them.
- [#24 The patient-facing surface, and its separate identity boundary](https://github.com/ThomasGenua/healthsystem/issues/24) — the backend boundary is done, clinic-attested enrolment binds a subject after a named clerk writes how they checked, and notices publish fact onto a channel (dispatching is not telling). `GET /me` is chrome and does not enrol anyone. What remains is identity-proofing / ONE ID, delivery to a phone or inbox the patient owns, and accessibility validation. Do not call `/me` a portal.
[#40](https://github.com/ThomasGenua/healthsystem/issues/40) is done: a prescription has a transmission lifecycle, a second transmission is refused because a pharmacy may dispense twice, and each way one is lost — never sent, sent and unacknowledged, failed, cancelled without telling the pharmacy — is a chase list. No pharmacy network has received a message.

**Built for where it actually runs.**

[#38](https://github.com/ThomasGenua/healthsystem/issues/38) is done: the read path now degrades the way the write path always did. A **reading station** — the same binary over a restored, verified snapshot — serves the chart while the link is down, and every panel wears its age, because a cached "no known drug allergies" from before this morning's reaction is worse than no chart at all. Consent still decides, from the directives the snapshot carried. The station is read-only and says where to write instead; past its serving budget it refuses everything and destroys the cache on its own, keeping only the trail it still owes the primary; and when the link returns, the offline reads append onto the primary's chain — dated when they happened, chained when they arrived — so an access review sees them where they belong. Walk it with `node demo/satlink-read.ts`. What remains is R-20: a directive issued mid-outage reaches the station at the next fill, bounded by the budget.
[#39](https://github.com/ThomasGenua/healthsystem/issues/39) is done: a visit is planned, repeated, moved and cancelled as one thing, its slots stay ordinary rows under the same unique index, and cancelling it puts every booked patient on a waitlist whose ordering is stated policy — priority, then waited-longest from first asking, then most-bumped — with offers that resolve as accepted, declined or unreachable, because a community with one phone line is not a community that keeps saying no.


**Operate it.** [#36](https://github.com/ThomasGenua/healthsystem/issues/36) is done: every channel change is a version carrying who, when and why; two versions diff at the field; a rollback restores old content as a new version and can resurrect a deleted channel; an import is a plan before it is an action and a dry run writes nothing; and every message records which configuration processed it, so "which rules were live when this went wrong" is a lookup rather than an archaeology project.

**Then scale.**

[#20](https://github.com/ThomasGenua/healthsystem/issues/20) is done for the half that carries the clinical risk: a loader whose completeness is declared and then checked, so a run cannot report success having dropped 4% of the allergies. It is not an extractor, and inventory, cutover scheduling and stabilisation are a plan a person writes.

- [#25 Horizontal operation](https://github.com/ThomasGenua/healthsystem/issues/25) — a single writer suits a community site and not a territorial hub. Last, because scaling a system whose recovery has never been rehearsed is optimising the wrong axis. The design is written and the code is not: [docs/MULTI-WRITER.md](docs/MULTI-WRITER.md) evaluates the candidates against the six claims a second writer would have to keep, rules read scaling in by generalizing the reading station, rules multi-master out, and recommends doing nothing until availability or locality — not capacity — is the demand.

**Smaller, from review.** [#26](https://github.com/ThomasGenua/healthsystem/issues/26) and [#27](https://github.com/ThomasGenua/healthsystem/issues/27) are done: a store refusal is not a 400-and-outcome-8, and the `migrate()` rebuild turns foreign keys off around the copy.

**Where the production build has reached.** Priorities 1–9, 11 and 13 of the immediate list are done or substantially done: the chart, documentation, inbox, scheduling (including travelling clinics and the waitlist), patient messaging, the FHIR service, an inbound laboratory bridge, medications with pharmacy transmission, the patient access boundary, a privacy office a privacy officer can run (queues *and* the trail join), a channel-configuration ledger, and a migration loader. The distance to the provincial specification is [docs/PROVINCIAL.md](docs/PROVINCIAL.md).

What is left is mostly not code. Vendor and provincial interfaces (Dynacare, LifeLabs, OLIS, DHDR, HRM, eConsult, ONE ID) each need a conformance guide, a sandbox, credentials and a signed test result — none of which can be written from inside this repository. Accessibility and Canadian-French parity need a person with a screen reader and a translator. A penetration test needs somebody who does not share the author's model of an attack. A clinical pilot needs a named safety officer.

**Deliberately not next.** Machine learning and broad decision-support content wait for validated data, licensed content and a clinical-governance process. The decision-support mechanism ships without content on purpose, and shipping content without that process would be the most consequential version of the failure this codebase spends its time refusing: a system answering a clinical question that nobody actually answered.
