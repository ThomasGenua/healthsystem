# Portage

A health integration engine built for northern operating conditions. HL7 v2 in and out over MLLP, FHIR R4 over HTTP, declarative transformation, durable store-and-forward with ordered replay, and hash-chained message lineage. No build step: Node runs the TypeScript directly and persistence is node:sqlite.

The design targets the interoperability posture Canadian jurisdictions are converging on through Canada Health Infoway: PS-CA patient summaries, CA:FeX FHIR exchange, and CA:eReC eReferral and eConsult, operated over networks where a 5 Mbps satellite tail and a multi-hour outage are normal conditions rather than incidents. Every acknowledgement means the message is durably queued, not merely seen, and an ordered channel resumes exactly where it stopped.

## Status

v0.4.0. The v0.3.0 core (channels; MLLP, HTTP, FHIR, filedrop and dbpoll sources; filter, split, mapping and validation pipeline; retrying ordered destinations with DLQ and replay; hash-chained lineage; FHIR R4 facade; terminology service; PS-CA / CA:FeX / CA:eReC conformance packs; rest-hook Subscriptions; satellite outage demo; admin UI) plus:

- **Authentication and authorisation.** API keys and OAuth 2.0 / SMART on FHIR bearer tokens, three scopes, one gate ahead of every route. On by default.
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
- **Break-glass that is loud**: declared, reasoned in words, notified to the patient, and queued for review — because a quiet override makes the lockbox theatre.

386 tests. Backend first, tests before UI.

### What this is not

Honest limits, so nobody discovers them in production:

- **MLLP sources are unauthenticated.** The protocol has no authentication to hook into. Those ports are a network-layer concern — put them behind a VPN, a private APN, or mutual TLS at the transport, not behind Portage. Being unauthenticated does not mean being fragile: frames are size-capped (16 MB, `maxFrameBytes` per channel) so a sender that never terminates one cannot exhaust memory, and malformed input is answered per message rather than taking the listener down.
- **`node:sqlite` is still flagged experimental on Node 22.** Durability rests on it, so run Node 24+ in production, where it is stable. The engine warns at boot when it is running below 24; the supported floor stays at 22.18 so an upgrade breaks nobody. CI covers both.
- **The shipped terminology pack is a labelled demo subset.** SNOMED CT CA, LOINC, pCLOCD, ICD-10-CA and CCI are licensed distributions; the loaders are here, the content is not.
- **The conformance packs are not certified.** They encode the published profiles as data and pass the shipped fixtures, but no projectathon has scored them.

## Requirements

Node 22.18 or later; Node 24+ recommended in production (see above). No required runtime dependencies.

Optional, and only if you use the source that needs it: `pg` for a Postgres poller, `mysql2` for MySQL, `ssh2-sftp-client` for SFTP. They are declared as `optionalDependencies` and imported lazily, so an operator who never polls Postgres never installs it. `npm install` also fetches the dev-time type checker.

## Quickstart

```bash
npm start
```

Boots the engine on port 8686 (override with `PORTAGE_PORT`), creates `./data/portage.db`, registers every mapping in `./mappings`, loads terminology packs from `./terminology` and conformance packs from `./conformance`, and seeds any channel in `./channels` that does not already exist in the database. Four channels ship: ADT to Patient on MLLP 6661, lab ORU to Observation on 6662 (split per OBX), ADT diagnoses to Condition on 6663 (split per DG1), and pharmacy RDE to MedicationRequest on 6664. All four deliver in strict order into the local FHIR facade, so a fresh boot is immediately queryable. The admin UI is at `http://localhost:8686/`.

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
npm test          # 386 tests
npm run demo      # scripted satellite outage: store-and-forward through a dead link, ordered drain
npm run typecheck # strict type check
```

## Security

Two credential schemes, either or both, chosen with `PORTAGE_AUTH_MODE`:

| value | meaning |
|---|---|
| `apikey` | **default.** API keys. One is minted and printed at first boot if none exists. |
| `oauth` | OAuth 2.0 / SMART on FHIR bearer tokens verified against an identity provider's JWKS. |
| `apikey+oauth` | both accepted |
| `off` | no authentication; logs a warning at boot |

Three scopes, deliberately coarse — the API has three kinds of caller, and finer distinctions would be invented rather than real:

| scope | reaches |
|---|---|
| `admin` | `/api/*`: channels, messages, the delivery queue, keys. Also `/fhir/AuditEvent` and `/fhir/Subscription`. Implies the other two. |
| `read` | `GET /fhir/*` and the terminology and conformance lookups, except `/fhir/AuditEvent` and `/fhir/Subscription` |
| `write` | `POST /ingest/:path`, `POST /fhir/:resourceType` |

Two things under `/fhir/` are not clinical traffic and sit with the operator rather than the consumer. `AuditEvent` records who looked at whom, so read access to the facade must not also disclose the access history of everyone in it. `Subscription` is a standing instruction to send patient records to an address — a routing decision of the same kind `POST /api/channels` makes. Left under the general `/fhir/` rule it needed only `write`, which is exactly what a feed is given, so the credential a lab uses to file results could have registered a rest-hook of its own and turned push-only access into a continuous read of the record. See [Subscriptions](#subscriptions).

Open without credentials, by design: the admin UI shell, `GET /api/health`, and `GET /fhir/metadata` — a CapabilityStatement is a discovery document, and a client has to read it to learn how to authenticate against everything else. Any unrecognised path defaults to requiring `admin`, so a route added later fails closed.

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
PORTAGE_AUTH_MODE=oauth \
PORTAGE_OIDC_ISSUER=https://login.microsoftonline.com/<tenant>/v2.0 \
PORTAGE_OIDC_AUDIENCE=api://portage \
npm start
```

The JWKS is discovered from the issuer (`PORTAGE_OIDC_JWKS` overrides) and cached. Signature, issuer, audience and expiry are all checked; the permitted algorithms are a fixed table keyed off the token header, so `alg: none` is refused before any key material is touched. Works against any OIDC provider — Entra ID, Keycloak, Auth0 — nothing here is provider-specific.

SMART scopes are translated rather than requiring Portage-specific scope names in your identity provider. Both v1 (`.read`, `.write`, `.*`) and v2 (`.rs`, `.cud`, `.cruds`) verb syntax are understood:

| token scope | grants |
|---|---|
| `system/Patient.read`, `system/Observation.rs` | `read` |
| `system/Patient.write`, `system/Patient.cud` | `write` |
| `system/*.*` | `read` + `write` |
| `portage/admin` | `admin` |

### Mutual TLS

For links between nodes there is no browser, no user and no consent flow — just two hosts that must each prove what they are, so a client certificate is the practical answer.

```bash
./scripts/gen-dev-certs.sh                 # self-signed CA, server and client certs, for development

PORTAGE_TLS_CERT=certs/server.crt \
PORTAGE_TLS_KEY=certs/server.key \
PORTAGE_TLS_CLIENT_CA=certs/ca.crt \
npm start

curl --cacert certs/ca.crt --cert certs/client.crt --key certs/client.key \
     https://localhost:8686/api/health
```

Setting `PORTAGE_TLS_CLIENT_CA` turns on `requestCert` and `rejectUnauthorized`, so an untrusted caller is refused during the handshake and never reaches the router. That is transport-level proof of *which host* is calling; the scope check above is application-level proof of *what it may do*. Both apply. Half-configured TLS throws at startup rather than quietly serving plaintext.

Outbound destinations can present a client certificate too, which routes that delivery through `node:https` since `fetch` cannot carry one:

```json
{ "type": "http", "url": "https://meridian.gov.nt.ca/fhir/Patient",
  "tls": { "certPath": "/etc/portage/client.crt", "keyPath": "/etc/portage/client.key",
           "caPath": "/etc/portage/ca.crt" } }
```

### Rate limiting

On by default. Two reasons, and the second is the sharper one:

An engine on a 5 Mbps satellite tail has very little headroom, and a client retrying in a tight loop can saturate the link the queue is trying to drain through — turning one misbehaving consumer into an outage for a whole community site.

And every refused request to a patient-data path writes a row to the audit trail. That is the right behaviour, but it means an unauthenticated caller could grow the database by hammering the facade. Without a limit, the control that records intrusion attempts becomes the way to exhaust the disk. Measured: 80 anonymous requests against a 20/min limit produce 41 audit rows, of which exactly **one** records the flood — not 80.

A token bucket, so a real client's burst is admitted and a sustained flood is not. Counted per principal for a credentialed caller and per source address otherwise, so one noisy anonymous client cannot spend a credentialed feed's budget. Requests on public routes, and every request when authentication is off, count per source — they all resolve to the same synthetic anonymous principal, and pooling them would be no protection at all.

| variable | default | meaning |
|---|---|---|
| `PORTAGE_RATE_AUTHENTICATED` | 1200/min | sustained rate for a credentialed caller |
| `PORTAGE_RATE_ANONYMOUS` | 120/min | sustained rate per source address |
| `PORTAGE_RATE_LIMIT=off` | — | disable entirely; warns at boot |

A refusal returns `429` with `Retry-After`. Counters are in memory, matching the single-writer design: a Portage node is one process, and sharing limits across nodes would need shared state.

### Environment

| variable | default | meaning |
|---|---|---|
| `PORTAGE_PORT` | 8686 | API port |
| `PORTAGE_DATA` | `./data` | database directory |
| `PORTAGE_CHANNELS` / `_MAPPINGS` / `_TERMINOLOGY` / `_CONFORMANCE` / `_FIXTURES` | `./<name>` | boot-time load directories |
| `PORTAGE_AUTH_MODE` | `apikey` | `apikey`, `oauth`, `apikey+oauth`, `off` |
| `PORTAGE_OIDC_ISSUER` / `_AUDIENCE` / `_JWKS` | — | OAuth 2.0 configuration |
| `PORTAGE_TLS_CERT` / `_KEY` | — | serve over TLS |
| `PORTAGE_TLS_CLIENT_CA` | — | require a client certificate signed by this CA |
| `PORTAGE_VALIDATE_PACK` / `_MODE` | — | conformance pack enforced on every facade write |
| `PORTAGE_REDACT_AFTER_DAYS` | — | replace stored payloads older than this with a tombstone |
| `PORTAGE_PURGE_AFTER_DAYS` | — | delete messages older than this outright |
| `PORTAGE_RATE_AUTHENTICATED` / `_ANONYMOUS` / `PORTAGE_RATE_LIMIT` | 1200 / 120 / on | request rate limits |
| `PORTAGE_BACKUP_DIR` / `_KEEP` | `./backups` / 7 | where POST /api/backup writes, and how many to keep |

## Audit trail

Canadian health privacy law — PHIPA in Ontario, HIA in Alberta, the Health Information Act in the territories — obliges a custodian to know who looked at whose record. Portage holds patient data in the facade and raw HL7 in the message log, so it answers that question.

```bash
curl "localhost:8686/api/audit?patient=NT123456" -H "Authorization: Bearer $KEY"   # who read this record
curl "localhost:8686/api/audit?failures=true"    -H "Authorization: Bearer $KEY"   # who was turned away
curl "localhost:8686/api/audit/verify"           -H "Authorization: Bearer $KEY"   # has the trail been altered
curl "localhost:8686/fhir/AuditEvent"            -H "Authorization: Bearer $KEY"   # the same, as R4 AuditEvent
```

**What is recorded.** Disclosure is the event that matters, so every read of patient data is: a facade read or search, and any look at a raw message, since an ER7 message identifies a patient as surely as anything in the facade. A search records how many records it returned — one that discloses nine hundred is not a read. Refused attempts are recorded too, because a trail that shows only successes cannot show someone trying doors. Key issue and revocation are recorded because they change who can open them.

**What is not.** Internal writes are not duplicated here. Every message already carries hash-chained lineage with its pipeline steps and deliveries, which is a stronger record than an audit line, and repeating it would bury the disclosures in routine traffic.

**Tamper evidence.** The trail is hash-chained exactly as message lineage is, so a row cannot be edited or deleted without breaking `/api/audit/verify` — including a row deleted from the end, which is the case a naive chain misses. See [What the chains prove](#what-the-chains-prove) for what that is and is not worth.

**The trail carries identifiers and references, never payloads.** An audit log that copied the record it was protecting would double the exposure it exists to detect.

**It is admin-scoped, including under `/fhir/`.** A consumer with `read` access to the facade must not also learn the access history of every patient in it — so `/fhir/AuditEvent` requires `admin`, unlike every other `/fhir/` read.

## Retention

The message log keeps every raw HL7 message it has ever received. Left alone that is both a disk problem and a liability: holding a patient's admission message for eight years because nothing deletes it is not a feature. Retention is off by default and configured in days.

```bash
PORTAGE_REDACT_AFTER_DAYS=30 PORTAGE_PURGE_AFTER_DAYS=365 npm start

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
- The evidence is already off the box. `/metrics` exports `portage_audit_events_total` and `portage_chain_length` as **counters**, so a chain that loses rows reads as a counter reset in whatever is scraping — which is the one record of the chain's history the engine does not control.

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

### What is deliberately not here

The mechanism is here; the clinical content is not. A drug interaction table that is 80% complete is one a prescriber learns to trust, and the missing 20% is then invisible — worse than the gap it was meant to close. Portage ships a deliberately small cross-reactivity set covering the classes with the clearest consensus, and takes a licensed interaction database through the `InteractionSource` seam for anything more. Same posture as the terminology loaders: build the seam, do not fake the content.

## The clinician workspace

Section 2 asks for a longitudinal view a clinician can open and act from. The temptation is to treat that as presentation — join the tables, render the panels — and the reason it is not is what the module is built around.

**A summary is read as complete.** That is its entire clinical function: a clinician opens it precisely so they do not have to go looking, and having looked, they proceed on the basis that what is there is what there is.

So the dangerous failure is not an error. It is a section that came back short — a store that threw and was caught, a list truncated at fifty, a category nobody wired in — rendering as an empty panel that means "none" when it actually means "not asked". An empty allergy panel is the same lie as an empty allergy list, and the same one §5 refuses to tell.

Every section therefore carries its own completeness, and the summary carries `complete` and `omissions`:

- a section that **could not be loaded** says so, and its omission text says the panel is empty because it failed rather than because there is nothing;
- a section that was **cut short** says how many it dropped;
- a store that is **not configured** in this deployment is an omission, not a blank.

A failing store does not take the chart down — six panels beat an error page — but the panel it leaves behind never passes for "none". `complete === false` is the flag a renderer must surface, not a detail it may ignore.

Allergy status is carried to the top of the summary rather than left inside its panel, and read from the store rather than inferred from the panel's contents. Inferring it would undo the distinction §5 exists for: a clinician scanning a chart has to see "never asked" without interpreting an empty box.

`worklist()` is the same idea across the day rather than across one patient. A clinician's work is not one queue — results wait in one place, referrals in another, tasks in a third, and each system reports its own as though it were the whole picture. The value of a single view is that nothing is owed to them somewhere they are not looking, which is only true if the view says what it could not reach.

The module owns no data and keeps no second copy of anything. It assembles from the stores that already exist, declares what it assembled, and is honest about the rest.

## The clinical API, and audit by construction

Everything above — the chart, the patient index, medications, allergies, orders, results, referrals, tasks, notes and the assembled summary — is served under `/api/clinical/*`, behind the `admin` scope and inside the caller's tenant like the rest of the API.

Exposing it is the moment the audit requirement in §18 starts to bite. Until now the clinical stores were libraries: nothing reached them over a network, so nothing went unrecorded. A route is a way in, and **an audit guarantee that depends on each new route remembering to call `audit()` is one that holds until somebody forgets** — and the forgetting is invisible, because the route works, the data is served, and nothing anywhere says the trail is short.

Two things make it structural instead:

- **`phi()` audits first and sends second.** An exception between the two cannot produce a read that happened without a record of it happening, and there is no path through a clinical route that reaches `send` without passing through it.
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

### What is deliberately not on this API

**The patient-facing surface.** `src/patient/access.ts` is built and tested, and it is not mounted here, because a patient portal is a different trust boundary — a patient authenticating as themselves, and a proxy authenticating as somebody entitled to act for them, neither of which is an operator holding an `admin` key. Bolting those endpoints onto an admin-scoped API would make the scope model say something false about who is calling.

That surface needs its own authentication (patient identity, not an issued operator credential), its own scope vocabulary, and `PatientAccess.may()` consulted on every request rather than a scope check. It is the next thing to build, not something already here under a different name.

## Patient access

Section 11 has two failures that nothing else in this system has, and they pull in opposite directions.

### Delegated authority that never ends

A parent's access to a child's chart is correct until a birthday and wrong afterwards — and **nothing about that day generates an event**. No message arrives, no status changes, no queue fills up. The grant simply keeps working, and a sixteen-year-old's mental health notes stay readable by somebody no longer entitled to them, for years, with nobody doing anything wrong.

The same shape covers a substitute decision-maker whose authority ended when capacity returned, and a representative named during an admission that finished in 2019.

So authority is time-bounded by construction:

- **A delegated grant without an expiry is refused, not defaulted.** A default would be this module's guess written into the record as somebody's decision — and the decision, *when does this end*, is the entire safeguard. For a parent it is the age of majority in the jurisdiction; for a substitute decision-maker it is a review date. Neither is something a library should choose.
- **The check is against the clock, not a status.** A grant that expired yesterday is not authority, whether or not any sweep has run.
- **`expiring()` surfaces grants about to lapse**, so a renewal is a decision somebody makes rather than a lapse somebody discovers. A parent who still needs access to a disabled adult child's chart should be asked; one who should not have it should stop, on the day.

The expired grant row stays. Who was entitled when is not something to delete — it simply stops being authority.

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

An OIDC token carries its tenant in a `tenant` (or `portage_tenant`) claim the identity provider controls. Without one the caller lands in the default tenant rather than in whichever one they would have preferred.

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

One thing to do by hand, once, on a database that ran a version before this one: `sqlite3 data/portage.db 'VACUUM;'`. Freed pages are zeroed from now on, but pages freed under the old build may still hold legible content, and only a rebuild clears those.

## Backup

Losing this database is the worst thing that can happen to a node. It holds the queue that has not drained, the lineage proving what flowed, the audit trail proving who read it, and the facade a consumer is reading from — a community site with a week of backlog waiting out an outage has a week of unsent clinical messages in one file.

**Copying that file is not a backup.** The engine runs SQLite in WAL mode, so committed data lives in `portage.db-wal` until a checkpoint folds it in. `cp portage.db` on a running engine yields a stale or torn snapshot that looks fine until the day it is needed — in testing, the copy could not even be opened.

```bash
npm run backup                                    # -> backups/portage-<stamp>.db
npm run backup -- --out /mnt/usb --keep 7
npm run backup -- --verify backups/portage-2026-08-07T15-22-33.db

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

### Restoring

With the engine stopped:

```bash
systemctl stop portage
mv data/portage.db data/portage.db.broken
rm -f data/portage.db-wal data/portage.db-shm     # stale, and not part of the snapshot
cp backups/portage-<stamp>.db data/portage.db
systemctl start portage
```

Removing the sidecars is the step people skip. Left behind, SQLite tries to apply a write-ahead log belonging to the database you just replaced.

`PORTAGE_BACKUP_DIR` and `PORTAGE_BACKUP_KEEP` configure the API endpoint.

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

`degraded` is set by a dead letter or a channel holding work older than `?stalled_after_sec=` (default an hour). It is deliberately *degraded* rather than *unhealthy*: an engine holding a backlog through a satellite outage is working exactly as designed, and only an operator can say whether a backlog this old means something is wrong. `stalledChannels` names the feed, which is the first thing anyone needs and the thing a counter cannot say.

`GET /metrics` serves the same in Prometheus text format:

```
portage_deliveries{state="delivered"} 3
portage_dead_letters 0
portage_oldest_queued_age_seconds 0
portage_channel_oldest_queued_age_seconds{channel="oru-to-fhir-observation"} 412
```

Both are public alongside liveness — a scrape happens before any credential is configured, and neither carries patient data: counters, ages and channel ids only. Neither writes to the audit trail, or a 15-second scrape would bury the disclosures the trail exists to surface.

### A feed that has gone quiet

Every signal above reports on what is *in* the queue — depth, dead letters, the age of the oldest undelivered message, which channels are stalled. A feed that stops sending puts nothing in the queue, so all of them read healthy: a dead ADT interface and a quiet night are indistinguishable.

A backlog is loud — it grows, it ages, it eventually dead-letters. Silence is not, and at an unattended site it is the failure most likely to run for days before anyone notices the records stopped arriving.

```json
{ "id": "adt", "name": "admissions", "expectMessageEverySec": 3600, "source": { "…": "…" } }
```

A channel that declares a cadence and exceeds it appears in `signals.silentChannels`, makes `/api/health` report `degraded`, and exports `portage_channel_silent{channel="adt"} 1`. `portage_channel_last_message_age_seconds` carries the age itself, so an alert is a threshold on a number rather than a special case.

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
sudo mount -t tmpfs -o size=1M tmpfs /mnt/portage-tiny
npm run diskfulltest -- --dir /mnt/portage-tiny
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
another Portage instance owns this database (pid 4744 on ykpcc-01, last seen 1s ago).
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
  api/admin.ts        admin, ingest, terminology, conformance and FHIR API
  api/tls.ts          TLS and mutual TLS for the listener
  api/ratelimit.ts    per-principal and per-source token buckets
  api/ui.html         single-file admin UI served at GET /
  auth/scopes.ts      the scope model and the route-to-scope map
  auth/keys.ts        API key issue, verify, revoke
  auth/jwt.ts         OAuth 2.0 / SMART bearer validation against a JWKS
  auth/gate.ts        the one check every request passes
  audit/store.ts      hash-chained access trail
  core/retention.ts   payload redaction and purge under a retention policy
  core/backup.ts      verified online snapshots
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
POST   /api/backup                          verified online snapshot of the database
GET    /metrics                             Prometheus exposition (public, no patient data)
GET    /api/audit?patient=&principal=&failures=  who accessed patient data
GET    /api/audit/verify                    walk and verify the audit hash chain
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

## Subscriptions

`POST /fhir/Subscription` with a rest-hook channel registers a consumer. **This needs `admin`**, not `write` — see [Security](#security) for why. A change in the facade store (created or updated; an unchanged upsert never notifies, because versioning is content-addressed) enqueues one delivery per matching active subscription on the same durable queue as everything else, so notifications get retry with backoff, dead-lettering, replay and strict per-subscription ordering, and they survive a restart. Criteria is a resource type with an optional identifier token: `Observation`, `Patient?identifier=NT123456`, or `Patient?identifier=system|value`.

Registering and removing one are both recorded on the audit trail, with the endpoint and criteria. A subscription is the largest disclosure decision the API offers — every matching record, to that address, indefinitely — and it was previously the only one that left no mark, while a single record read left one. A refused attempt is recorded too, since someone trying to arrange an exfiltration is exactly what an audit trail is for.

The endpoint an operator configures is trusted, the same way a channel's HTTP destination URL is: an operator who can rewrite a channel can already route anything anywhere, so there is no boundary left to enforce at that point. That is the reason subscription management belongs behind `admin` in the first place.

## Connectors

`filedrop` polls a landing directory, ingests each file as one message in filename order, then archives or deletes it. This remains the simplest SFTP pattern for northern sites: openssh terminates the transfer into the directory and Portage takes it from there, so there is no bespoke protocol code to certify. `sftp` does the same against a remote server when there is no local landing directory to watch — archive or delete happens only after the message is durably stored, so a crash mid-poll re-reads the file rather than losing it.

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

`GET /` serves a single-file, no-build UI over the public API: a dashboard with live counts, history charts, an access audit view, channels with hash-chain verification, a channel designer, a mapping editor with live fixtures, a message browser with per-step lineage, the delivery queue with dead-letter replay and discard, a FHIR facade browser, subscription management, terminology lookups and a conformance validator. It is deliberately thin; anything it does, curl does.

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

`--system` accepts a URI or one of the shorthands `snomed`, `loinc`, `icd10ca`, `pclocd`, `cci`. `--db` chooses the database (default `./data/portage.db`) and `--out` additionally writes a pack JSON file.

Everything streams and loads in batches, because a SNOMED snapshot runs to millions of rows. Concepts upsert on (system, code), so re-running a release is safe. RF2 emits only active concepts, uses the fully specified name as the display, and trims its trailing semantic tag — "Asthma (disorder)" becomes "Asthma".

## Roadmap

- Projectathon readiness: pack tightening against the published PS-CA, CA:FeX and CA:eReC test scripts
- Terminology: ValueSet and ConceptMap import from release formats (concepts land today; memberships and mappings are still pack JSON)
- Subscription topics and the R5 backport, alongside today's R4 rest-hook criteria
- Horizontal operation: today a Portage node is a single writer, which suits a community site but not a territorial hub
