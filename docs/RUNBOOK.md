# Northstar runbook

For the person holding the pager. Deployment steps first, then the failures
worth having written down before they happen.

The README explains *why* each mechanism works the way it does; this explains
what to type. Where the two disagree, the README is the design and this is the
mistake — please fix it here. The hazards those mechanisms exist to prevent,
with severity and the test that pins each one, live in
[CLINICAL-SAFETY.md](CLINICAL-SAFETY.md).

**Northstar carries personal health information. Two rules apply to every
paragraph below:** never paste a message body, a chart entry or a patient
identifier into a ticket, a chat channel or a search engine; and never work
around a refusal by disabling the thing that refused. A consent check, a
tenancy boundary or an audit write that is in your way is doing its job.
The escape hatch is break-glass, which is loud and recorded — see
[Breaking glass](#a-clinician-cannot-see-a-record-they-need).

---

## Contents

- [Deploying](#deploying)
  - [What a node needs](#what-a-node-needs)
  - [First install](#first-install)
  - [Upgrading](#upgrading)
  - [Upgrading a site installed as Portage](#upgrading-a-site-installed-as-portage)
  - [Rolling back](#rolling-back)
- [Daily and weekly](#daily-and-weekly)
- [Incidents](#incidents)
  - [`/api/health` says degraded](#apihealth-says-degraded)
  - [A channel is stalled](#a-channel-is-stalled)
  - [A feed has gone silent](#a-feed-has-gone-silent)
  - [Dead letters](#dead-letters)
  - [The disk is full](#the-disk-is-full)
  - [The engine will not start](#the-engine-will-not-start)
  - [The engine crashed](#the-engine-crashed)
  - [Chain verification fails](#chain-verification-fails)
  - [A clinician cannot see a record they need](#a-clinician-cannot-see-a-record-they-need)
  - [Break-glass queues are not emptying](#break-glass-queues-are-not-emptying)
  - [A credential is compromised](#a-credential-is-compromised)
  - [Restoring from backup](#restoring-from-backup)
  - [How long it takes, and how much you lose](#how-long-it-takes-and-how-much-you-lose)
- [Escalating](#escalating)

---

## Deploying

### What a node needs

- **Node 22.18 or later.** 24.x is the production target: `node:sqlite` is no
  longer flagged experimental there, and 22.x prints a warning on every boot.
- **A local filesystem for `NORTHSTAR_DATA`.** Not NFS, not SMB, not a network
  block device with write caching you cannot reason about. SQLite's durability
  guarantee is only as good as the filesystem's `fsync`, and Northstar's
  acknowledgement means *durably queued* — a lie at this layer makes it a lie
  all the way up.
- **Disk**: roughly 4 KB per message stored, plus backups. Size for the
  retention window, not for today.
- **One process per database file.** This is enforced with a lock and is not a
  convention — see [One engine per database](../README.md#one-engine-per-database).

### First install

```bash
git clone https://github.com/ThomasGenua/healthsystem.git northstar
cd northstar
npm ci
npm run typecheck && npm test    # 1153 tests; do not deploy a node that fails one

export NORTHSTAR_DATA=/var/lib/northstar
export NORTHSTAR_PORT=8686
node src/server.ts
```

Then, before any real feed is pointed at it:

1. **Set `NORTHSTAR_AUTH_MODE`.** It defaults to `apikey`. `off` exists for
   development and must never reach a machine that can see a real feed.
   The patient boundary additionally requires `oauth` and a configured OIDC
   issuer; API keys and authentication-off mode can never act as patients.
2. **Issue an admin key** and store it in whatever your site uses for secrets,
   not in a shell history. See [API keys](../README.md#api-keys).
3. **Turn on TLS** (`NORTHSTAR_TLS_CERT` / `_KEY`), and mutual TLS if the
   destinations support it (`NORTHSTAR_TLS_CLIENT_CA`).
4. **Set `NORTHSTAR_BACKUP_DIR`** to something on a different physical device
   than `NORTHSTAR_DATA`, and **set `NORTHSTAR_BACKUP_REMOTE`** to a destination
   that is not this machine (`s3://bucket/prefix` or `sftp://user@host/path`)
   with `NORTHSTAR_BACKUP_KEY_FILE` pointing at a 32-byte key that lives
   somewhere this host dying does not take with it. A backup on the disk
   that failed is not a backup; a key that only this machine can read
   unlocks nothing after it dies. `npm run backup -- --init-key /etc/northstar/backup.key`
   writes one; store a copy off-box before the first real feed.
5. **Decide retention deliberately.** `NORTHSTAR_REDACT_AFTER_DAYS` and
   `NORTHSTAR_PURGE_AFTER_DAYS` are unset by default and affect the *message
   log only* — never the chart, medications, allergies, orders, results or
   referrals. An active legal hold on the tenant skips the whole sweep:
   messages are not patient-keyed. See [What retention does not touch](../README.md#what-retention-does-not-touch).
6. **Point monitoring at `/api/health` and `/metrics`** before the first feed,
   so you have a baseline.
7. **Declare `expectMessageEverySec` on every channel you would notice the
   absence of.** Silence detection is off unless declared, and silence is the
   failure most likely to run for days unnoticed.

### Upgrading

Migrations run automatically on open and are introspection-driven rather than
version-numbered, so an upgrade is: stop, replace the code, start. There is no
migration command to forget to run. `test/migration.test.ts` opens a real
v0.3.0 file and exercises the whole platform against the result.

```bash
# 1. Take a backup and verify it. Not optional; this is the rollback.
curl -sS -X POST -H "authorization: Bearer $ADMIN_KEY" http://localhost:8686/api/backup

# 2. Stop the engine. SIGTERM; it drains.
systemctl stop northstar

# 3. Update, and re-run the suite against the new code on this machine.
git fetch --tags && git checkout v0.8.0
npm ci && npm run typecheck && npm test

# 4. Start. Watch the log: the migration announces each table it rebuilds.
systemctl start northstar
curl -sS http://localhost:8686/api/health
```

Then confirm, in this order: `/api/health` is `ok` and not `degraded`; each
channel has a recent `lastMessageAt`; and chain verification passes
(`GET /api/chain/verify` for the message chain, `GET /api/audit/verify` for the
audit chain). An upgrade that produced tables without their constraints
is worse than one that failed to open — the site runs, and double-books — so
the verification step is the point of the exercise, not paperwork.

### Upgrading a site installed as Portage

Northstar was called Portage. Nothing about that rename requires you to change
anything: **an existing site upgrades with no configuration changes at all.**
This section is what you may optionally tidy afterwards, and the two things you
must not do casually.

Everything below keeps working, indefinitely, and is read alongside the new
spelling:

| Still works | Current spelling | Where it lives |
|---|---|---|
| `PORTAGE_*` environment variables | `NORTHSTAR_*` | your unit file or `.env` |
| `data/portage.db` | `data/northstar.db` | the data directory |
| `portage-<stamp>.db` snapshots | `northstar-<stamp>.db` | the backup directory |
| `portage_*` Prometheus series | `northstar_*` | scrape config, dashboards, alert rules |
| `portage/admin` scope | `northstar/admin` | issued tokens, IdP config |
| `portage_tenant`, `portage_organization`, `portage_practitioner` claims | `northstar_*` | your identity provider |

Where both spellings are set, the `NORTHSTAR_*` one wins, so you can move one
variable at a time. The engine lists the legacy variables still in play once at
boot; that line is informational, not a deprecation warning.

**Do not rename the database file while the engine is running.** If you want it
under the new name, stop the engine first and move all three files together —
the database, its `-wal`, and its `-shm`. A `-wal` left behind belongs to a
database that is no longer there, and applying it to another one is how a
restore produces a chart that never existed:

```bash
systemctl stop northstar
cd /var/lib/northstar
for ext in "" -wal -shm; do [ -e "portage.db$ext" ] && mv "portage.db$ext" "northstar.db$ext"; done
systemctl start northstar
```

If you leave it alone, the engine finds it and says so at boot. An existing
file always wins over the preferred name — the alternative is SQLite creating
an empty `northstar.db` beside your real one and the site coming up healthy
with no patients in it.

**Do not change what goes out on the wire without agreeing it first.** MSH-3 on
outbound acknowledgements is still `PORTAGE`, because it is the receiving
application name each sending facility has configured at *their* end. Change it
unilaterally and their engine rejects your acknowledgements — visible to them
as messages that were never acknowledged, and not visible to you at all. When
every partner has scheduled the change, set `NORTHSTAR_HL7_APPLICATION`.

Metrics are exposed under both prefixes, so existing dashboards and alert rules
keep working untouched. Move them when convenient; a renamed metric does not
break a rule loudly, it just evaluates against a series that no longer exists.

### Rolling back

Northstar's migrations move forward only. **A database opened by a newer version
may not be readable by an older one**, so rolling back the code is not enough:

```bash
systemctl stop northstar
git checkout v0.4.0 && npm ci
# restore the pre-upgrade backup over NORTHSTAR_DATA — see Restoring, below
systemctl start northstar
```

Messages that arrived after the backup was taken are lost from the log by this,
which is why the backup in step 1 is taken immediately before the stop. If the
upgrade has been live long enough that this matters, fix forward instead and
call for help.

---

## Daily and weekly

| When | What | How |
| --- | --- | --- |
| Continuously | `degraded`, dead letters, silent channels | alert on `/metrics` |
| Daily | A backup exists, is recent, verified, and has left the machine | `remoteBackup` on `/api/health`; `northstar_backup_remote_ok` on `/metrics` |
| Daily | Break-glass queues are being drained | `GET /api/clinical/break-glass` |
| Weekly | Chain verification across all channels | `GET /api/chain/verify`, `GET /api/audit/verify` |
| Weekly | Unacknowledged results and open referrals past their deadline | `GET /api/clinical/results`, `/referrals` |
| Monthly | Restore a backup onto a scratch machine and open it | see [Restoring](#restoring-from-backup) |
| Monthly | Confirm the RTO has not drifted on your hardware | `npm run restoretest` |
| Monthly | Review API keys: expiry, rotation, anything unused | `GET /api/keys/review` |

The monthly restore is the only one that proves the others were worth doing. A
backup that has never been restored is a file.

---

## Incidents

### `/api/health` says degraded

`degraded` is set by a dead letter, a channel holding work older than
`stalledAfterSec` (default an hour), a channel that declared a cadence and
missed it, or a configured off-machine backup whose last replica failed. It
is deliberately not `unhealthy`: an engine holding a backlog through a
satellite outage is working exactly as designed. An unconfigured remote is
a posture (`remoteBackup.configured: false`) and is not degraded.

```bash
curl -sS http://localhost:8686/api/health | jq .signals
```

Read `stalledChannels` and `silentChannels` first — they name the feed, which
is the thing a counter cannot tell you. Then `remoteBackup`: if `configured`
is true and `ok` is false, the off-machine copy failed and the local
snapshots are the only ones you have. Then go to the matching section below.

### A channel is stalled

Work is arriving and not leaving. The destination is the suspect, not Northstar.

```bash
curl -sS -H "authorization: Bearer $ADMIN_KEY" \
  "http://localhost:8686/api/channels/<id>" | jq
```

1. Can this machine reach the destination at all? Try it by hand.
2. Is the destination refusing, or timing out? A refusal that repeats is a
   configuration mismatch; a timeout that repeats is usually the network.
3. **Do not clear the queue to make the alert stop.** The backlog is the
   patient data that has not arrived yet. Ordered replay is the design: once
   the destination recovers, the queue drains in order on its own.

Escalate to whoever owns the destination system. The backlog is safe while you
wait — that is what store-and-forward is for.

### A feed has gone silent

A source stopped sending. Nothing is in the queue, so every queue-shaped signal
reads healthy; only `silentChannels` catches it, and only for channels that
declared `expectMessageEverySec`.

A dead ADT interface and a quiet night are indistinguishable from here, so this
is a phone call to the sending site, not something to diagnose locally. Check
first that the listener is actually up (`GET /api/channels`) so you are not
calling them about your own outage.

### Dead letters

A message that failed past its retries. It is kept, not dropped.

```bash
curl -sS -H "authorization: Bearer $ADMIN_KEY" \
  "http://localhost:8686/api/deliveries?state=dead" | jq
```

Replay with `POST /api/deliveries/:id/replay`; `POST /api/deliveries/:id/discard`
drops one and releases the ordered flow behind it.

Read the error before replaying. A dead letter from a transient network failure
replays cleanly; one from a malformed message or a mapping bug replays into the
same failure and tells you nothing new. Fix the cause, then replay.

### The disk is full

Northstar refuses writes rather than half-writing them, and recovers on its own
once space is freed — this is exercised by `npm run diskfulltest` and nightly
in CI. So the engine is not the problem; the disk is.

1. Free space. Old backups in `NORTHSTAR_BACKUP_DIR` are usually the largest
   thing that is safe to delete, and `NORTHSTAR_BACKUP_KEEP` governs how many are
   retained.
2. **Do not delete anything inside `NORTHSTAR_DATA`.** Not the WAL, not the
   journal, not "the big one".
3. Confirm recovery: `/api/health` should return to `ok` without a restart.

Then work out why it filled. Retention unset on a busy feed is the usual
answer.

### The engine will not start

- **`another process owns this database`** — that is the instance lock working.
  Find the other process (`ss -lptn` on the port, or check for a stale
  systemd unit). Two engines on one file is the failure the lock exists to
  prevent; do not delete the lock to get past it.
- **`no such column: …`** — a migration did not run, which should be
  impossible on a supported path. Do not hand-edit the schema. Take a copy of
  the file, roll back to the previous version, and report it.
- **Port in use** — something else is on `NORTHSTAR_PORT`.

### The engine crashed

Start it again. That is the whole procedure, and it is a claim the code is
tested against: `npm run crashtest` SIGKILLs a real engine mid-drain and checks
that nothing is lost and order is preserved.

On restart, expect a log line about deliveries interrupted by an unclean
shutdown being requeued. At most one message per ordering key can have been in
the ambiguous state — sent but not committed — so a crash redelivers at most
one per key. That is at-least-once by design, and the content-addressed FHIR
facade absorbs the duplicate as a no-op.

Then check `GET /api/chain/verify` and move on.

### Chain verification fails

`GET /api/chain/verify?channel_id=` reports the message chain broken, or
`GET /api/audit/verify` reports the audit chain truncated.

This is serious and is **not** a thing to fix by re-verifying until it passes.
The chain exists to detect exactly two situations: a database that has been
edited outside Northstar, and one whose history has been truncated.

1. Do not restart the engine. Do not run retention. Do not take a new backup
   over the old one.
2. Copy the database file and the current backups somewhere read-only.
3. Note what `verify` says — it reports *where* the chain breaks and how much it
   checked, which is the difference between "somebody purged" and "somebody
   edited".
4. A gap that begins exactly at a purge cutoff is expected and is reported as
   such; see [What the chains prove](../README.md#what-the-chains-prove).
5. Anything else: treat it as a potential privacy incident and escalate to your
   privacy officer immediately. Preserve the file first.

### A clinician cannot see a record they need

They are hitting `403 this record is withheld by a patient directive`. The
patient has asked for the record to be withheld, and the refusal names the way
through in its own body.

This is not something to fix by editing directives, and never by turning off
the check. If the clinical need is real:

```bash
curl -sS -X POST -H "authorization: Bearer $KEY" -H "content-type: application/json" \
  -d '{"patient":"NT123456","reason":"unresponsive in ED, no collateral history, need allergy status before induction"}' \
  http://localhost:8686/api/clinical/break-glass
```

The reason must be something a privacy office can weigh months later; a single
word is refused. The override expires on its own, the patient is owed a
notification, and it lands in a review queue. All three are the point.

Two things are worth knowing before you reach for break-glass:

- **A narrowed directive does not refuse the chart.** If the patient locked one
  section, `GET /api/clinical/chart` still returns — that panel comes back
  marked `incomplete.reason: "withheld"` and the summary's `omissions` say so.
  Only a route serving exactly the locked type refuses, and only a directive
  naming no entry types refuses the whole chart. A clinician who says "the
  chart is blank" is describing something else; check `/api/health` first.
- **A `withhold-from-organization` directive withholds from a credential that
  carries no organization.** Credentials carry one now — set at issue
  time for API keys, from the `organization` (or `northstar_organization`) claim
  for OAuth — and a directive naming one clinic no longer withholds from the
  rest of the territory. A caller whose credential names no organization cannot
  show it is outside the withheld one and is still refused, which fails closed
  on purpose. If a clinician is being refused unexpectedly, check whether their
  credential has an `organization_id`:

  ```bash
  curl -s -H "authorization: Bearer $ADMIN_KEY" localhost:8080/api/keys | jq '.[] | {name, organization_id}'
  ```

### Break-glass queues are not emptying

```bash
curl -sS -H "authorization: Bearer $ADMIN_KEY" http://localhost:8686/api/clinical/break-glass | jq
```

Four lists come back, and they mean different things:

| | |
| --- | --- |
| `awaitingNotification` | patients who have not been told their record was opened |
| `awaitingReview` | overrides nobody has looked at |
| `overdueNotification` | of those, the ones more than 24 hours old |
| `undeliveredNotices` | notices that were attempted and could not be sent |

None of them drains itself, and none is a statistic — an override nobody
reviews teaches a ward that breaking glass costs nothing, and a directive that
costs nothing to break slows down only the people who would have asked.

**If `undeliveredNotices` is non-empty**, notice sending is configured and
failing. Each row carries `notice_error`. The usual cause is
`breakGlassNoticeChannel` naming a channel that does not exist or was removed
while the engine ran. Fix the channel, then retry — safe to run repeatedly,
because a notice already sent is never sent twice:

```bash
curl -sS -X POST -H "authorization: Bearer $ADMIN_KEY" -H "content-type: application/json" \
  -d '{"override":"<id>"}' http://localhost:8686/api/clinical/break-glass-dispatch
```

**If every row has `notice_dispatched_at: null` and no `notice_error`**, no
notice channel is configured at all. That is a valid deployment — the queue is
then the whole mechanism and an operator tells each patient by hand — but it
means nothing is being sent. Configure `breakGlassNoticeChannel` to change
that.

### Sent is not told

`notice_dispatched_at` says Northstar handed the notice to the delivery
machinery. It does not say the patient received it, and a portal message that
bounced is neither. Telling them still finishes on a channel Northstar does not
own — a letter, a call, a conversation — so record it once it has happened:

```bash
curl -sS -X POST -H "authorization: Bearer $ADMIN_KEY" -H "content-type: application/json" \
  -d '{"override":"<id>"}' http://localhost:8686/api/clinical/break-glass-notified

curl -sS -X POST -H "authorization: Bearer $ADMIN_KEY" -H "content-type: application/json" \
  -d '{"override":"<id>","outcome":"appropriate; ED attendance confirmed in the record"}' \
  http://localhost:8686/api/clinical/break-glass-review
```

If one person appears repeatedly, that is a workflow that has decided the
directive is an obstacle rather than a run of emergencies. It is a
conversation, not a metric.

### A credential is compromised

```bash
# Issue the replacement first, so nothing goes dark between the two calls.
curl -sS -X POST -H "authorization: Bearer $ADMIN_KEY" \
  http://localhost:8686/api/keys/<id>/rotate
```

Rotation records what replaced what, so the audit trail stays readable across
the change. Then revoke the old key, and read the audit trail for what it did
while it was out of your control:

```bash
curl -sS -H "authorization: Bearer $ADMIN_KEY" \
  "http://localhost:8686/api/audit?principal=<id>" | jq
```

If patient data was served to it, that is a privacy incident and follows your
jurisdiction's breach process, not this document. If the credential is a
vulnerability in Northstar rather than a leaked secret, see [SECURITY.md](../SECURITY.md).

### Restoring from backup

If the disk that held the database is still there and you are rolling back
an upgrade or undoing a bad write, the local snapshot is enough:

```bash
systemctl stop northstar                         # nothing may hold the file
npm run restore -- --from /var/lib/northstar/backups
systemctl start northstar
curl -sS http://localhost:8686/api/health
```

If the disk, the machine or the building is gone, the local directory is
gone with it. Fetch the off-machine copy — this needs `NORTHSTAR_BACKUP_KEY_FILE`
to be present on the replacement host, which is why that file must not have
lived only on the dead one:

```bash
npm run restore -- --from remote
# or a specific name, with or without the .enc suffix
npm run restore -- --from remote --snapshot northstar-2026-08-19T14-00-00.db
```

`npm run restore -- --snapshot <file>` picks a specific local file. The
script does the whole procedure and refuses rather than guessing:

- it **proves the snapshot comes up first**, by migrating a scratch copy of it,
  so a bad snapshot leaves you where you were instead of with nothing
- it **refuses if anything still holds the target** — restoring under a live
  engine hands it a file it does not own and the damage is silent. `--force`
  exists; be sure
- it **moves the old database aside** with a timestamped suffix rather than
  deleting it, and tells you where
- it **removes the stale `-wal` and `-shm` sidecars**, the step that gets
  skipped by hand and points SQLite at the log of the database you replaced
- it **clears the instance lock the snapshot inherited** from the machine that
  took it. Without this the new engine waits out a heartbeat belonging to a
  process on another host before it will start — seconds you are counting

Keep the displaced copy until the restore is confirmed. It is evidence if this
turns out to be an incident rather than an accident.

### How long it takes, and how much you lose

| database | restore | engine start | **RTO** |
|---|---|---|---|
| 10 MB (20,000 messages) | 0.2 s | 0.3 s | **0.5 s** |
| 96 MB (200,000 messages) | 3.3 s | 2.8 s | **6.0 s** |

**These are floors.** They are restore plus boot, and exclude noticing the
outage, deciding to restore, and finding the snapshot — which on a real night
are most of the elapsed time. Budget your RTO from when the pager goes off,
not from when you type the command.

**Your RPO depends on which disk survived.**

| What failed | What you still have | RPO |
| --- | --- | --- |
| Process crash, bad upgrade | The local snapshot | time since the last local snapshot |
| The disk, the machine, the building | The last verified replica at `NORTHSTAR_BACKUP_REMOTE` | time since the last *successful* replication |
| The disk, and no remote was configured | Nothing | everything |

A daily snapshot means a 24-hour RPO for a crash. The same cadence against a
dead disk is only real if the last replica left the machine and
`northstar_backup_remote_ok` is 1. Alert on that gauge going to 0, and on
`northstar_backup_remote_age_seconds` growing past your cadence. A snapshot of
a 96 MB database costs about 2.5 seconds against a live engine, so if 24
hours of loss is not acceptable at your site, run it hourly — the cost is
not the reason to hold back.

Re-run `npm run restoretest -- --messages <n>` on your own hardware before
putting a number in a service agreement. The figures above are single runs on
one machine.

---

## Escalating

Escalate immediately, before further diagnosis, for any of:

- chain verification failing in a way that is not an expected purge gap
- patient data served to the wrong tenant, or to a credential that should not
  have seen it
- a backup that will not restore
- any suspicion that the database file has been modified outside Northstar

For these, preserving the current state matters more than restoring service.
Copy the database file and the backups somewhere read-only **first**.

A suspected vulnerability in Northstar itself goes through private disclosure —
see [SECURITY.md](../SECURITY.md) — not a public issue.
