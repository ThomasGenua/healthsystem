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

165 tests. Backend first, tests before UI.

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
npm test          # 165 tests
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
| `admin` | `/api/*`: channels, messages, the delivery queue, keys. Implies the other two. |
| `read` | `GET /fhir/*` and the terminology and conformance lookups, except `/fhir/AuditEvent` |
| `write` | `POST /ingest/:path`, `POST /fhir/:resourceType` |

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

**Tamper evidence.** The trail is hash-chained exactly as message lineage is, so a row cannot be edited or deleted without breaking `/api/audit/verify`. That is the property that makes an audit log worth keeping rather than merely worth having.

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

`/api/chain/verify` reports both halves of the guarantee:

```json
{ "ok": true, "checked": 500, "payloadsChecked": 120, "redacted": 380 }
```

Every link verifies; 120 rows can still prove their payload is the one the chain committed to; 380 have been redacted and can no longer. A payload put back where a redacted one was will not match its recorded digest and is caught.

In-flight and queued deliveries are never redacted — a payload that has not gone out still has to be deliverable, and emptying it would destroy a message the sender was told was safe.

**A redacted delivery cannot be replayed.** The states replay accepts are exactly the states redaction empties, so the two features meet on the same rows; without a check between them an operator clicking replay would send the literal tombstone to a downstream clinical system, which has no way to tell it from content. The replay is refused and says why:

```json
{ "error": "payload was redacted at 2026-08-07 14:02:11 under the retention policy and cannot be replayed" }
```

**Retention does not touch the FHIR facade.** That store holds the current clinical record a consumer is reading, not a log of traffic. How long a territorial EHR keeps a Patient resource is a clinical governance decision, not something an interface engine should quietly make.

A sweep that destroys data records itself on the audit trail, because that is an event worth being able to account for.

## Upgrading

An existing database is migrated in place on the first open. Columns added since it was created are added by `ALTER TABLE`; new tables and indexes come from the schema itself. Running the migration again finds nothing to do, so it costs one `PRAGMA` per tracked column at boot.

This matters more than it sounds. `CREATE TABLE IF NOT EXISTS` does *nothing* to a table that already exists, so before this a column added to the schema never reached a database an earlier version had created — and the failure arrived on the first ingest rather than on open. A site that had been running fine went off the air at upgrade and stayed there, reporting itself healthy. Every test starts from an empty file, so no test could see it; `test/migration.test.ts` starts from the real v0.3.0 table definitions instead.

A chain that spans the upgrade still verifies. Rows written before the digest column commit to the payload itself and rows after it commit to the digest, and `verifyChain` accepts both, so an upgrade does not read as tampering.

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

**A snapshot nobody has opened is not a backup either.** Every snapshot is reopened and its hash chains walked before success is reported, so a backup that says it worked has been read back. A tampered or truncated snapshot fails here rather than on the day it is restored.

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

`POST /fhir/Subscription` with a rest-hook channel registers a consumer. A change in the facade store (created or updated; an unchanged upsert never notifies, because versioning is content-addressed) enqueues one delivery per matching active subscription on the same durable queue as everything else, so notifications get retry with backoff, dead-lettering, replay and strict per-subscription ordering, and they survive a restart. Criteria is a resource type with an optional identifier token: `Observation`, `Patient?identifier=NT123456`, or `Patient?identifier=system|value`.

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
