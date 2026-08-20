# Changelog

Notable changes per release. Dates are the release date; a version is cut when
a coherent block of capability is finished and tested, not on a calendar.

Portage is pre-1.0: minor versions may change interfaces. Database upgrades are
always forward-compatible and run automatically on open — see
[Upgrading](docs/RUNBOOK.md#upgrading).

## Unreleased

**Added**

- **Encounters** (#32) — the visit, and everything that happened inside it.
  `encounter_id` had been a column on orders, medication statements,
  reconciliations and clinical entries since they were written, and no table
  owned one, so it named something the system could not describe. A visit now
  has a class, a status, a period, a location, participants with roles, and a
  disposition; `GET /api/clinical/encounter` assembles what belongs to it with
  the same per-section completeness as the chart, so a section that failed says
  so instead of reading as "nothing was ordered at this visit".
- A worklist of visits still open (`GET /api/clinical/encounters-open`), with an
  age threshold, so a visit cannot stay open indefinitely without somebody
  seeing it — everything filed against an open visit inherits its ambiguity,
  and a discharge summary cannot be produced for one that has not ended.
- `POST /api/clinical/encounter-open`, `-arrive`, `-close` and `-cancel`, each
  through the same directive check as a read: a caller who may not see a
  patient's record may not start adding to it either.

**Fixed**

- **Clinical content could name an encounter that did not exist, or that
  belonged to another patient.** `encounter_id` reads as provenance, and
  nothing checked it, so an order filed against somebody else's visit was
  stored as fact — the same hazard `duplicates()` declines to merge for. Orders,
  medication statements and clinical entries now validate it where they write
  it. Eleven existing tests were filing notes against an `enc-1` that was never
  created by anything, which is what the check was for.
- **A clinical route nested under a subpath was exempt from the audit-coverage
  guarantee.** `test/clinical-api.test.ts` discovers routes by reading
  `admin.ts`, and its pattern stopped at the first `/`, so a route added as
  `/api/clinical/encounter/arrive` would never have been driven and its missing
  audit row would never have been noticed. The pattern now admits nested paths.

**Changed**

- `phi()` is now a thin wrapper over `phiFor()`, which takes the subject
  explicitly. A route that learns whose record it is serving from the data
  rather than from the query string — an encounter knows its own patient — uses
  it directly, so the directive check cannot be dodged by omitting `patient`.
- 426 → 439 tests.

## 0.5.0 — 2026-08-19

The clinical platform, and the privacy enforcement that makes it safe to serve.

**Added**

- **Closed-loop referrals** (§9). Every status owes something to somebody and
  the deadline records what. A redirect keeps the correlation and carries the
  documents, rather than cancelling and resetting the clock.
- **Orders and results** (§4). Results are appended and acknowledgement lives
  on the row, so a correction does not inherit the sign-off of the value it
  replaced, and acknowledging a superseded result is refused.
- **Medications and allergies** (§5), where "no known drug allergies" is a row
  rather than an absence. `never-asked` is a `severe` finding and is never
  folded into `clear`; a blocking finding needs an override recording both the
  reason and the findings that were shown.
- **The assembled chart** (§2), where every section carries its own
  completeness and a section that failed says so instead of rendering as
  "none".
- **Patient access** (§11). Delegated authority without an expiry is refused
  rather than defaulted, and is checked against the clock rather than a status.
- **Registries and care gaps** (§12). The denominator is the whole cohort,
  `unclassified` comes back with a reason per patient, and `rate` is `null`
  when too much of the cohort could not be assessed.
- **Scheduling** (§10). Double-booking is refused by a partial unique index
  rather than by a check a second process can race past.
- **Consent directives and break-glass** (§16). The directive check lives
  inside `phi()` rather than per route, so a lockbox cannot be missed by a
  route that forgot to ask.
- **A clinical API that cannot serve patient data unaudited**, enforced by a
  test that reads the routing source, drives every clinical path, and fails if
  one serves patient data without leaving an audit row.
- `GET /api/clinical/break-glass`, and `POST /api/clinical/break-glass-notified`
  and `-review` — the notification and review queues, which existed in the
  store and could not be read or discharged by anything.
- **A clinician console**: `Chart`, `Worklist` and `Break-glass` tabs in the
  admin UI, driven entirely through the clinical API so every read is audited
  and passes the directive check. The chart's `complete` and `omissions` have
  existed since the chart was written and nothing rendered them; a panel that
  failed, one that was truncated and one the patient withheld are now three
  visibly different things. Results are acknowledged inline, with the sentence
  saying what was done that `orders.acknowledge()` requires.
- `POST /api/clinical/acknowledge`, the one write the console needs. It goes
  through the same directive check as any read — you cannot say what you did
  about a value you were not allowed to see — and surfaces the store's refusals
  verbatim, including the one that stops a superseded result being signed off.
- `SECURITY.md`, a vulnerability disclosure process, and
  [`docs/RUNBOOK.md`](docs/RUNBOOK.md) for deployment and incidents.
- A nightly **Resilience** workflow running the crash, disk-full, restore and
  load tests, which previously ran only when somebody remembered to run them by
  hand.
- **`npm run restore`** — the restore procedure as code rather than four lines
  of `mv`, `rm` and `cp` in a README. It proves the snapshot comes up before
  displacing anything, refuses to run against a database something still holds,
  keeps what it replaces, and removes the stale sidecars that make a restore
  half-work.
- **`npm run restoretest`** — a restore rehearsal that takes a snapshot from
  under a live engine, restores it somewhere the database has never been, and
  boots an engine against it in a separate process to prove the result is
  usable rather than merely openable. **A measured RTO and a stated RPO** are
  now in the README and the runbook; there were none before.

**Fixed**

- **A consent directive narrowed by `scope` was enforced by nothing over
  HTTP.** `mayRead()` honoured `scope` when told which entry type was being
  read, and `phi()` never tells it, because a chart is not one type. Every
  scoped directive therefore evaluated to "does not apply" on every request: a
  patient could lock their counselling notes and `GET /api/clinical/chart`
  served them with a 200. A read that cannot say which type it is reading may
  return the withheld one, so it is now refused.
- **A directive narrowed by `scope` withholds its section, not the whole
  chart.** The first fix for the leak above refused any read that could not
  name its entry type, which was safe and much blunter than the patient asked
  for: they locked one section and lost the chart, with break-glass as the only
  way back. There is no honest yes-or-no to "may they read the chart" when one
  panel is locked, so the chart now drops that panel and says on its face that
  a directive is why — `incomplete.reason` is `withheld`, distinct from
  `unavailable`, because a panel that failed and a panel the patient locked
  call for completely different things from a clinician. A route serving
  exactly the locked type still refuses, having nothing left to serve. Neither
  the content nor the count of a withheld section reaches the response, and the
  audit row names which types were withheld.
- **A `withhold-from-organization` directive could never be enforced at all**,
  because it matched on an organization identity that no credential carries and
  nothing passed. It was recorded, reported to the patient as active, and
  enforced by nothing. It now withholds from any caller that cannot say it is
  outside the withheld organization.
- `breakGlass()`'s docstring claimed `notifyPatient` ran there. It never did.
- **A restored snapshot arrived owned by the machine that took it.** A backup
  copies the whole database, `instance_lock` included, so the restored file
  claimed to belong to a process on the source host — and
  `acquireInstanceLock()` cannot prove a holder on another host is dead, so the
  new engine waited out the inherited heartbeat before starting. A stall on the
  recovery path, invisible to any restore onto the machine that took the
  backup, which is the only kind anyone had done.
- **A snapshot from an older release could not be verified, so the restore path
  refused it.** `verifyBackup()` opens read-only, and a read-only handle skips
  `SCHEMA` and `migrate()`, so it queried the current schema against a file
  written by an older version and failed with `no such table: channels`. The
  preflight now migrates a scratch copy instead, which both fixes the refusal
  and exercises the migration before the live database is displaced.
- `awaitingResult()` treated a preliminary result as an answer, so a blood
  culture reporting gram-positive cocci at 24 hours and never speciating
  dropped off the chase list.
- `Db.transaction` is reentrant, so an operation built from other atomic
  operations — a referral redirect closing one loop and opening another — is
  itself atomic rather than crashing or being written non-atomically.
- Article agreement in error messages across five modules ("a attended
  booking").

**Changed**

- Licensed under **Apache-2.0**. The repository previously carried no licence
  file and declared `UNLICENSED`, which meant nobody could legally use, fork or
  contribute to a public repository.
- 270 → 426 tests.

**Known limitations**, stated because both fixes above fail closed and are
blunter than the patient asked for:

- A `withhold-from-organization` directive withholds from every caller until
  organization identity reaches the auth layer.
- Break-glass notification is recorded, not sent. Telling the patient happens
  on a channel Portage does not own; the queue holds until an operator records
  that it happened.

## 0.4.0

Authentication and authorisation (API keys, OAuth 2.0 / SMART on FHIR, three
scopes, one gate ahead of every route); mutual TLS; conformance validation on
facade writes; native SFTP, Postgres and MySQL sources; terminology release
loaders; hash-chained access audit; retention with verifiable chains; rate
limiting; verified online backup and health signals; one-engine-per-database
enforcement; in-place schema migration; truncation-resistant chains;
multi-tenancy end to end; purpose of use on the audit trail; the append-only
clinical record, patient index, clinical documentation and unified inbox.

## 0.3.0

The core: channels; MLLP, HTTP, FHIR, filedrop and dbpoll sources; filter,
split, mapping and validation pipeline; retrying ordered destinations with DLQ
and replay; hash-chained lineage; FHIR R4 facade; terminology service; PS-CA,
CA:FeX and CA:eReC conformance packs; rest-hook Subscriptions; the satellite
outage demo; the admin UI.
