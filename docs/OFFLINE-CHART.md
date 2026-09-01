# A readable chart when the link is down

The design for [#38](https://github.com/ThomasGenua/healthsystem/issues/38),
written before the build on purpose: a cached chart is a second copy of PHI
on a machine in a different building, and it acquires the one failure mode
the primary cannot have — being wrong while looking right. That is not a
feature to bolt on; it is a set of obligations to accept in writing first.

**Status: built.** Staleness is a first-class incompleteness (`stale`, beside
`unavailable`, `truncated` and `withheld`), stamped on every panel of a chart
assembled with an `asOf` and bannered in the console
(`test/offline-chart.test.ts`). The station is `src/core/station.ts`, tested in
`test/reading-station.test.ts` and walked end to end by `demo/satlink-read.ts`.
Hazards **H-84** through **H-88** carry its controls, and the residual that
survives the build — a directive issued mid-outage reaching the station only at
the next fill — is **R-20**.

Details the build settled that this design left open. The station keeps
**two databases**: the cached snapshot, destroyed at expiry, and the station's
own, holding the manifest, the offline trail, and any offline break-glass
declarations, all of which outlive it — because the record that somebody read
a chart during the outage still has to reach the primary afterwards, and
destroying it with the cache would make an offline read invisible to the
access review built to find exactly that. The cache is dated from the
**snapshot's own stamp** rather than from when the copy landed: a snapshot
taken at 02:00 and filled at 06:00 is four hours old on arrival, and a chart
dated from the copy would understate its age — the one direction staleness
must never err in.

The review hardened five more seams. **Read-only means no writes, not no
POSTs**: break-glass is accepted (declared against the cache, honoured for
the rest of the outage, copied into the surviving database, and replayed onto
the primary at reconciliation so the patient's notice rides the real dispatch
machinery), and the read-shaped checks — the safety check and the registry
queries — still answer, because taking the allergy check away for the outage
would be its own hazard. **Expiry is genuinely autonomous**: the first
request to arrive past the budget purges the cache, and an hourly sweep
purges the station nobody asks. **Every station response carries
`x-northstar-station-as-of` and `x-northstar-station-age-hours`**, so a consumer
that never opens the assembled chart still cannot mistake outage data for
current data without ignoring the response saying so. **A refill to a new
path destroys the previous cache** rather than orphaning a copy of the record
outside the manifest's tracking. And **the cache runs nobody's channels**:
the snapshot carries the primary's integration config, and every channel is
disabled at fill, because a station that ran them would be a second engine
sending the primary's feeds when the link returns.

---

## 1. The asymmetry

`demo/satlink.ts` demonstrates the write path during a satellite outage: the
queue holds, order is preserved, everything drains when the link returns.
The read path has no equivalent. A nurse in a community during a 40-hour
outage can queue what they write and see nothing of what is already known —
no allergies, no current medications, no reason for the last visit. This is
the operating condition the project is named for, and it is the one
asymmetry left in it.

## 2. The shape: a reading station, not a browser cache

The cache is **a second Northstar node in reading-station mode** — the same
binary, the same schema, the same stores — running on a machine at the site
that loses the link (a small server in the nursing station's locked room,
the same class of machine the primary is).

It is explicitly **not** a browser cache. Service workers and browser
storage fail every obligation at once: no at-rest encryption the deployment
controls, no `PRAGMA secure_delete`, no tenant scoping, no consent
machinery, no hash-chained audit, and a device threat model (a laptop in a
bag) this project has no controls for. Every one of those exists already in
the server — so the design reuses the server, and the browser stays what it
is today: a thin console talking to whichever node is reachable.

A station serves exactly one tenant. A shared regional station for several
custodians would put one custodian's outage on another's floor and is out
of scope.

## 3. What is cached, and how it gets there

**The tenant's verified, encrypted snapshot — the one the backup path
already produces.** `POST /api/backup` takes a snapshot, encrypts it,
replicates it, reads it back, decrypts it and walks it before calling it
good; the restore path proves a restored database is usable, including
across a version boundary. The station is fed by exactly that machinery:
it pulls the latest verified snapshot while the link is up, restores it
into its own encrypted volume, and records the snapshot's `takenAt` as its
**fill time**. There is no bespoke sync protocol, no row-level replication,
no second thing to trust — the cache is a restore, and restores are
rehearsed.

That choice buys correctness and costs freshness: the cache is as old as
the last snapshot. The staleness machinery (§5) is what makes that cost
honest, and the snapshot cadence is what bounds it. A deployment that fills
its station hourly has an hour-old chart when the link drops; one that
fills it nightly has yesterday's. Both are survivable **because the age is
on the face of the chart**; neither is survivable silently.

Everything rides the snapshot because everything is rows: the clinical
stores, the patient index, consent directives, API keys, the terminology
pack. The station mounts them read-only (§8).

## 4. For whom

The station answers the same authenticated console the primary does, with
the same keys — key rows ride the snapshot — the same scopes, and the same
per-request consent evaluation. Nothing about *who may see what* is
re-decided by the cache; it is the same code against the same tables.

Two consequences are named rather than hidden:

- **A key revoked at the primary after the snapshot still works at the
  station** until the next fill or the budget expiry (§7). Departure of a
  staff member is therefore a bounded exposure, not an instant one, and the
  bound is the serving budget. A deployment that cannot accept that bound
  must shorten the budget, or power the station down when someone leaves —
  an operational act the runbook will carry.
- The same bound applies to **directives** (§6). It is one clock on
  purpose: every decision the station makes is honest *as of the fill
  time*, and the budget is the deployment's written answer to "how long is
  as-of good enough".

## 5. Staleness on the face of the chart *(built)*

`Incompleteness` gains a fourth reason:

```ts
{ reason: "stale"; asOf: string; ageHours: number }
```

A chart assembled with `asOf` is **never `complete`**. Every panel that
would otherwise read as complete carries the stale reason and the age; a
panel that is already `unavailable`, `truncated` or `withheld` keeps its
more specific reason — a lockbox is still a lockbox on a cache. The
summary carries a top-level `stale` block, the omissions gain one line for
the whole chart, and the console banners it as a warning before anything
else: *"This chart is a cache, as of 14 hours ago."*

An `asOf` that does not parse throws: **a cache that cannot establish its
own age must not serve at all.** The station enforces the same rule one
level up — a missing or unreadable fill-time manifest means the station
answers every chart request with a refusal that says why, not with a chart.

## 6. Consent fails closed against the clock

Directives ride the snapshot and are evaluated at the station by the same
`restrictionsFor()` the primary runs. What the cache cannot know is a
directive **issued after the fill time**. The design's answer:

- The **serving budget** (`NORTHSTAR_STATION_BUDGET_HOURS`, default 72) is
  the directive-freshness budget. Within it, the station serves — stale on
  its face — accepting the stated residual that a directive issued during
  the outage is enforced only when the link returns. That residual is
  bounded, written down (R-19 until built, a hazard row once built), and
  is the same trade a paper chart in the same nursing station makes today.
- **Past the budget, the station withholds everything.** Not panel by
  panel: the whole chart refuses with words that say the cache outlived
  its budget, and the only way to a chart is the link coming back or a
  fresh fill. A month-old chart served because the outage lasted a month
  is exactly the failure the issue names.
- **Break-glass works offline.** It is declared at the station, recorded
  in the station's own audit chain, and the notice rides reconciliation
  (§7) into the same dispatch machinery the primary already has, so the
  patient is still told. An override declared at the station lifts only
  what it would lift at the primary, for the budget's remainder.

## 7. Audit at the station, reconciled without breaking anything

The station writes its own hash-chained trail, from its own genesis row,
with the station's identity in every row. Chains do not merge — the
primary's chain is never rewritten, reordered or back-inserted, and the
truncation counter (`sqlite_sequence` cross-check) is untouched, because
reconciliation is **append, not insert**:

- When the link returns, the station ships its rows since the last
  reconciliation. The primary writes them as *new* rows on its own chain,
  each carrying the station id, the original timestamp and the original
  station `seq` in the detail — so an access review of a patient shows the
  offline read where it belongs in the story, dated when it happened,
  chained when it arrived.
- The primary then writes one reconciliation row: station, row count, span
  covered, and the station chain's verification result. A station chain
  that does not verify is an incident (the privacy office intake from #35),
  not a silent drop.
- The station keeps its local rows until the primary confirms the append,
  then they age out by the same retention path as everything else.

## 8. Writes: the station is read-only, and says so

**Read-only first** is scope discipline, not a gap. The write path already
degrades acceptably — that is what `demo/satlink.ts` proves — and the
clinical value of the cache is the chart. Every mutating clinical route at
the station answers with a refusal that says what to do instead (the paper
form and the feed queue that already exist), and the refusal is audited.
The station's only writes are its own audit chain, its fill/reconciliation
bookkeeping, and its queued break-glass notices.

Offline *clinical* writing — with replay, ordering and surfaced conflicts —
is real work with real hazards, and it is deliberately not in this design.
If it is ever built, it gets its own design against this one's spine.

## 9. Expiry, device loss, and departure

- **Expiry is autonomous.** At budget expiry the station stops serving
  (§6) and **purges the clinical snapshot**: the cached database file is
  deleted and the space vacuumed. `PRAGMA secure_delete = ON` is already
  the project's standing posture, so deleted pages are overwritten rather
  than left readable in the file. What survives expiry is the station's
  own unreconciled audit chain — the record that reads happened is not
  PHI-optional and is kept for reconciliation.
- **The volume is encrypted or the station does not serve.** The primary's
  at-rest posture (H-44) applies verbatim: the station runs the same
  at-rest check and refuses with the same words when the volume is not
  encrypted. A stolen station disk is then the same non-event a stolen
  primary disk is.
- **Device loss is an incident, not a shrug.** The runbook step: record it
  in the privacy office as an incident (what was on it is knowable — the
  fill time bounds it), revoke the station's snapshot-decryption key at
  the primary so it can never fill again, and rotate the API keys that
  rode the snapshot. The encrypted volume is what makes this an
  inconvenience rather than a breach; the incident record is what makes
  that claim reviewable.
- **Departure** is §4's bounded exposure: revoke at the primary, and the
  budget bounds the station-side tail.

## 10. Hazards

Already in the log, control built: **H-83** — a clinician acts on a stale
cached chart; the control is the staleness disclosure at every layer, and
`test/offline-chart.test.ts` pins it. Residual risk **R-19** records that
the station itself is a design: no deployment serves a cached chart until
it is built and these rows land with it, named in advance:

- a directive issued during the outage is unknown to the cache (control:
  the serving budget, and withhold-everything past it)
- an offline read invisible to access review (control: append-only
  reconciliation into the primary chain)
- a cache that outlives its budget (control: autonomous expiry and purge)
- a station serving from an unencrypted volume (control: the H-44 check,
  verbatim)

## 11. Testing, in the shape already established

`demo/satlink-read.ts`, the read-path sibling of `demo/satlink.ts`: fill a
station from a verified snapshot, cut the link, open a chart and see every
panel wear its age, break glass and see it recorded locally, cross the
budget and watch the station refuse and purge, restore the link and watch
the trail reconcile onto the primary's chain with the chain verifying
before and after. The suite pins each piece the same way the write path's
pieces are pinned.

## 12. What this is not

Not [#25](https://github.com/ThomasGenua/healthsystem/issues/25). That is
horizontal operation — more than one writer, for scale. This is partition
tolerance for a single site, read-mostly, and it ships without touching
the single-writer model: the station writes nothing clinical, ever, and
the primary remains the only place a chart changes.
