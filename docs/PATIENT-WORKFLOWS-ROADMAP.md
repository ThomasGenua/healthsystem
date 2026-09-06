# Patient and clinician workflows — what exists, and what item 58 adds

A classification of items 58–67 against the repository as it stands at
`31f9d61`, written before any of them was implemented, so the distance is
recorded rather than remembered. It follows the method of
[PROVINCIAL.md](PROVINCIAL.md): what is here, what is not, and no credit for
the second.

Every claim below carries a file reference. Where the request assumes
something exists that does not, that is stated rather than quietly worked
around — see item 67, where the premise is wrong.

| # | Item | Status |
|---|---|---|
| 58 | Patient and caregiver portal | **Partial** — the API is complete; there is no application |
| 59 | Patient notification delivery | **Done**, bar provider adapters — see the note under item 59 |
| 60 | Pre-visit intake and uploads | **Missing** — documents-as-chart-facts is the only adjacent piece |
| 61 | Structured care plans and after-visit summaries | **Partial** — plans exist; goals, actions and the summary do not |
| 62 | Discharge follow-up and team handoffs | **Missing** — the word appears; the workflow does not |
| 63 | Longitudinal chart | **Partial** — assembly and units are strong; timeline and trends are absent |
| 64 | Outreach campaigns | **Missing** — cohorts and gaps exist; nothing campaign-shaped |
| 65 | Travelling-clinic coordination | **Partial** — visits and waitlist exist; arrangements do not |
| 66 | Clinic operations workspace | **Partial** — board, resources and three attention queues; intake waits on item 60 |
| 67 | Measuring whether this helps | **Partial**, and one premise is wrong — see below |

---

## 58. A working patient and caregiver portal — **partial**

**Complete.** The whole OAuth patient boundary, in `src/api/admin.ts:626–950`:

| Surface | Route |
|---|---|
| Charts this subject may reach | `GET /patient/authorities` |
| Patient-safe chart | `GET /patient/summary` |
| Released results, with holds | `GET /patient/results` |
| Appointments | `GET /patient/appointments` |
| Message threads, one thread, open, reply | `GET /patient/threads`, `/patient/thread`, `POST /patient/thread-open`, `/patient/thread-reply` |
| Who looked at the chart | `GET /patient/access-log` |
| Delegates, and revoking one | `GET /patient/delegates`, `POST /patient/delegate-revoke` |
| Access and correction requests | `GET /patient/requests`, `POST /patient/request` |

Every one of those runs through `patientPhi()`, which resolves a live grant,
checks the specific permission, writes the access log and the audit row in the
same transaction as the read, and refuses with 403 otherwise. The behaviours
item 58 asks the portal to respect are already enforced underneath it:

- **Result holds** — `PatientAccess.resultsFor` (`src/patient/access.ts:392`)
  returns `{held: {because, until}}` with no value in the object at all, so a
  held result cannot leak through a client that renders every field it is
  given.
- **Expired grants** — `may()` and `forSubject()` (`:232`, `:245`) take an
  `asOf` and compare it to `expires_at`.
- **Revocation** — `revoke()` (`:213`) and `POST /patient/delegate-revoke`,
  which refuses to revoke anything but a delegated grant on the caller's own
  chart.
- **Caregiver scope** — `allows()` (`:264`) checks the named permission, and
  the summary route is deliberately blind to chart links so a proxy grant
  cannot widen itself through a clinician's identity assertion.
- **Consent restrictions** — `src/patient/consent.ts`, applied above this
  layer.

**Missing: the application.** `GET /me` serves `src/api/patient.html`
(`src/api/admin.ts:310`), 88 lines of static bilingual chrome that says it is
not a portal and loads no chart. There is no patient switcher, no screen for
any of the surfaces above, no path from a browser to the configured identity
provider, and no way to sign in at all during development.

**This increment.** See "What item 58 adds" below.

---

## 59. Patient notification delivery — **partial**

**Present.** `PatientNotices` (`src/patient/notice.ts:145`) queues a notice,
dispatches it onto a configured channel through the existing durable delivery
queue, and separates `queued` / `dispatched` / `failed` / `told`. Dispatching
is deliberately not telling (`markTold` is a separate act, `:228`), the
undelivered and untold queues are both exposed (`:277`, `:281`), and the
payload is a fact — `{type, kind, noticeId, patientId, aboutId, summary}` —
never a result field. That last property is hazard H-116 and is tested.

**Added in this increment.** `patient_contacts` with verification and consent
as separate recorded facts, language, quiet hours with a required zone, and
withdrawal that keeps the row. Five delivery states where the queue's success
is `provider-accepted` and only a receipt reaches `delivered`; `unknown` for a
receipt this build cannot read. Held sends that re-check consent when the
window closes. A portal view recorded separately from every delivery state and
from `told`. A `patient-contact` task on the unassigned queue when nobody can
be reached. Generic bilingual wording that names no kind, no summary and no
chart.

**Still missing.** A provider *adapter*: the outbound message carries an
address and a body onto a channel, and turning that into an SMS is the
deployment's HTTP destination plus a gateway account. Nothing here has sent a
text message. A receipt route for a gateway to call back into
`recordReceipt()` is a store method with no HTTP surface yet, so `delivered`
is currently reachable only from code. Verification is a clerk attesting, not
a code sent to the number — that check would need the sending path that does
not exist. And there is no per-patient digest or rate limit: ten results
released at once are ten notices.

## 60. Pre-visit intake and patient uploads — **done**

**Added in this increment.** `src/patient/intake.ts`: versioned questionnaire
definitions (`Questionnaires.publish()` always inserts a new version rather
than editing one, so a submission naming version 1 still finds exactly what
it answered after version 2 exists); a draft workflow (`IntakeSubmissions`)
that lives in an ordinary mutable table — not the append-only clinical record,
which has no update path and no business trying to acquire one for something
typed into over several sittings — and is deduplicated by (patient,
questionnaire, appointment) so a dropped connection resumes the same draft
rather than forking one; `submit()`, which is idempotent (a retried submit
after a lost reply returns what the first call already produced) and freezes
the draft into a `QuestionnaireResponse` on the chart, attributed to `patient`
or `proxy` so testimony is never confused with a clinician's assertion.

A proposed medication change is stored as exactly that — patient testimony,
read by nobody until a clinician opens the review task `submit()` raises.
Nothing in this module calls `MedicationStore`; reconciling a proposed change
into the medication list is a clinician's existing tool, not something this
increment automates on a patient's say-so.

`Uploads`: file type and size validated the same way `PatientDocuments`
already does (a shared `payloadSize()`, now exported), stored `pending-scan`
and never marked clean by `receive()` itself — a store cannot honestly vouch
for bytes it did not examine. No `MalwareScanner` configured means every
upload stays quarantined indefinitely, which is the same choice
`src/meds/safety.ts` makes about an unconfigured interaction database:
unchecked is reported as unchecked, never quietly as clear. A clean verdict
files the upload as a `PatientDocuments` entry (`source: "patient-submitted"`,
already an allowed value) and raises a review task unless it is riding a
submission that will raise its own; an infected verdict deletes the bytes from
the row on the spot, so no later code path can serve them by forgetting to
check status. `SyntheticScanner` recognizes exactly the EICAR test string —
the industry-standard, harmless file antivirus vendors publish for this
purpose — and is wired only behind `NORTHSTAR_DEV_MALWARE_SCANNER=on`, the
same explicit, loud, opt-in-only shape as the development identity provider.

A new `"intake"` patient permission (`src/patient/access.ts`) gates six new
`/patient/*` routes through the same `patientPhi()` boundary as everything
else — a caregiver's grant either names it or does not, exactly like
`results` or `messages`. Five clinician-side routes
(`/api/clinical/intake`, `-review`, `/questionnaires`, `/uploads`,
`/upload-scan`) go through the ordinary `phi()`/`phiFor()` gateway.

The portal (`src/api/portal.html`) gained an eighth tab, "Before your visit":
per-questionnaire forms rendered from the published questions, a free-text
concern box, an add-a-row medication-change list, and a file picker — all in
both languages, all wired through the existing loading/error/empty and
double-submit-guard machinery rather than new copies of it.

**Test evidence.** `test/intake.test.ts` (19 tests) covers the store in
isolation: draft dedup and merge, idempotent submit, required-question
validation, the quarantine state machine, and that a proposed medication
change never reaches `meds.current()`. `test/intake-api.test.ts` (8 tests)
drives the same journey through a real signed token from the development
identity provider: caregiver scope with and without "intake", revocation
taking effect on the next request, cross-tenant refusal, and an infected
upload that never becomes downloadable to the very patient who sent it.
Twelve mutations against the store and four against the API-layer permission
wiring, all sixteen caught by a test — four survived the first pass and are
the reason four of those tests exist. Confirmed against a live server with a
seeded synthetic patient (`scripts/portal-demo.ts`): sign in, save a draft,
submit it, and the clinic's worklist shows the routed task; upload a file,
watch it refuse to download at `pending-scan`, scan it, and download it.

Two scanners this session already relies on had the same gap this increment's
routes would have slipped through: the `/api/clinical/*` and `/patient/*`
route-audit tests matched path literals with a character class that admitted
neither digits nor `/`, so a route nested under a subpath — `/patient/intake/
draft` and `/patient/intake/submit` here — was invisible to the very check
that exists to catch an unaudited route. Both regexes are fixed to match what
the sibling `/api/clinical/*` scanner already had to learn once before.

**Still missing.** A submission is not tied to a specific appointment in the
portal UI, though the store supports it (`appointmentId` is a real, indexed
column) — the screen shows one open item per questionnaire rather than one
per upcoming visit. No resumable or chunked upload: a connection that drops
mid-transfer is retried from scratch, not resumed byte-for-byte. Reconciling
a proposed medication change into the medication list is still a manual step
through the existing reconciliation screens, by design.

## 61. Structured care plans and after-visit summaries — **done**

**Present, unchanged.** `CarePlans` (`src/clinical/careplans.ts:105`) still
writes the plan itself onto the append-only clinical record: a title, a
review date, completion needing a written outcome, revocation needing a
written reason. `CarePlanInput` gained one optional field,
`escalationCriteria` — a clinician's own words on what to watch for and when
to call, never generated (see below).

**Added in this increment.** `src/clinical/goals.ts`: `Goal` and `Task`
(reusing an `EntryType` record.ts had declared and nothing had written yet)
as their own entries on the append-only record, each carrying the five-value
status this item asks for — `proposed`, `approved`, `completed`, `declined`,
`superseded` — internal vocabulary chosen to match the item's own words
rather than FHIR's `Goal.lifecycleStatus` codes, which have no "superseded"
value and use "accepted"/"rejected" instead. `Goals.revise()` and the
equivalent on `Actions` supersede rather than edit: the old entry is amended
to `superseded` with a `supersededBy` pointer, and a new one carries the
change, so a plan reviewed months later can still see what a goal used to
say. An action carries `responsibleId`, `dueAt`, `progress`, and an optional
`link: {kind, id}` to an existing task, appointment, order or referral —
validated against the real store when one is wired in, recorded as asserted
when it is not, the same way an unvalidatable `encounterId` already is
elsewhere.

`src/clinical/avs.ts`: `AfterVisitSummaries.build(encounterId)` assembles a
patient-readable summary from `approved` and `completed` goals and actions
only — a `proposed` suggestion nobody agreed to and a `declined` one are
excluded by construction, not by convention. Escalation criteria are quoted
verbatim from the plan if a clinician wrote one, and the summary says
plainly that none was provided if not; nothing here generates one. Orders
placed during the visit are included because `encounter_id` is a real,
checkable link; referrals and prescriptions are deliberately not joined in
by matching on time, because neither carries one, and attributing either to
a visit it might not belong to would be worse than leaving it out.

Ten clinician routes (`/api/clinical/goals`, `-propose`, `-approve`,
`-decline`, `-complete`, `-revise` for goals; the equivalent five, minus
`-revise`, for actions; `/api/clinical/after-visit-summary`) go through the
existing `phi()`/`phiFor()` gateway. One patient route,
`/patient/after-visit-summary`, is gated on the existing `"summary"`
permission rather than a new one — a plan's approved content is exactly the
kind of thing `/patient/summary` already serves for the same chart.

**Test evidence.** `test/goals.test.ts` (7 tests) and `test/avs.test.ts` (6
tests): the full proposed → approved → completed / declined lifecycle, that
a revision supersedes rather than edits and the old text survives
verbatim, an action link's existence check, overdue actions requiring both
`approved` status and a passed date, and — the property the whole module
exists for — that a proposed goal, a declined action, and an unset
escalation field never reach the summary. Eleven mutations, all eleven
caught: one survived the first pass (`revise()`'s replacement always being
`proposed`, regardless of what the original's status was) and needed a
fresh `get()` read added to the assertion, since the mutation changed the
persisted row without changing the value the method itself returned.

**Still missing.** No portal screen. The after-visit summary is real,
permission-gated and fetchable by encounter id, but the portal has no
visit-history list a patient could find that id from — building one is
prerequisite work this item did not include. A team is still not modelled
for `responsibleId`, the same gap item 62 already has for handoffs.

## 62. Discharge follow-up and team handoffs — **missing**

**Added in this increment.** `src/work/discharge.ts`: a discharge snapshot
computed from the chart at the moment a visit closes, covering unacknowledged
results, unfinished reconciliations, open referrals and a missing follow-up;
items that resolve with a written resolution and a discharge that will not
close over an outstanding one. Handoffs that require acceptance, with the
proposer accountable until then, one live proposal per subject, and
`accountableFor()` answering ownership from the record. Coverage as a distinct
kind with a required end date that reverts without anybody acting. Unaccepted
handoffs and open follow-ups on the clinic board.

**The handoff record is what routing consults.** `TaskStore.inbox()` and
`Discharges.openFollowUps()` answer through `Handoffs.effectiveOwners()`
rather than from their own `owner_id` / `accountable_id` columns, and
`TaskStore.heldBy()` and `Discharges.accountableFor()` give the single answer
callers should ask for. The column is left alone on accept: it records who the
work started with, the handoff record decides whose list it is on today, and
there is one place to look when the two would have disagreed.

`effectiveOwners()` returns overrides only, so a subject no handoff moves is
absent and its column is still the truth. That absence is what makes coverage
revert **by arithmetic** — when the window closes the subject stops appearing,
with no sweep to run and therefore no sweep to fail. Coverage sits on top of
whoever holds the work, so a transfer accepted underneath it is what the work
returns to, not whoever first gave it away.

**Still missing.** The wiring is per-store and opt-in: a store that grows an
owner column later has to call `useOwnershipRecord()` and consult the map, and
nothing fails if it does not. (Referrals are not in that list because they
carry no owner of their own — a referral is chased through a task, and those
now route correctly.) A team is still not modelled — `to_id` is a person, and
"the diabetes team" would need a directory concept that does not exist. And
nothing expires a proposal: an offer nobody answers stays proposed forever and
is visible rather than acted on, which is the safe direction but not the
finished one.

## 63. A useful longitudinal chart — **done**

**Present, unchanged.** `Workspace.chart()` (`src/workspace/summary.ts:324`)
still assembles every clinical domain with a per-section status, and stays
the answer for "withheld", "never recorded" and "none" as three different
things. The UCUM measurement contract (`src/clinical/measurement.ts`) is
unchanged too — reused, not modified.

**Added in this increment.** `src/clinical/timeline.ts`: one chronological
read across results, vitals, procedures, immunizations, encounters, and
approved-or-better care-plan goals and actions, each entry carrying
`sourceRecordId` so it traces back to the record it summarises. A corrected
result contributes its current version only — `OrderStore.currentResultsFor()`
(new) excludes anything superseded, the same query shape
`access.resultsFor()` already used for the patient-facing list, without that
method's hold-awareness, which does not belong in a clinician's own read. A
merely `proposed` goal or action is not on the timeline: it is not yet an
event in the patient's history, only a suggestion.

`src/clinical/trends.ts`: a validated series per result code
(`OrderStore.resultSeries()`, new — every version of one code for one
patient, corrections included, each still carrying its own `supersedes`
pointer) or per vital kind. **Comparability is the one place this deliberately
falls short of what the item literally asks, on purpose.** measurement.ts
validates real unit conversion for the handful of quantities the clinical
scores measure — temperature, heart rate, respiratory rate, blood pressure,
oxygen saturation — and a vital series reuses that contract directly: two
readings in different units convert if the contract says they can, and are
marked not comparable with the contract's own reason if they cannot. A
laboratory result has no such contract for arbitrary analytes — there is no
molar-mass table in this codebase for potassium, sodium, or anything else a
lab might report — and building one would mean asserting a clinical fact
(a substance's molar mass, a scale's equivalence) nobody here is positioned
to assert. So a result series calls two points comparable only when their
unit strings match exactly; two points in genuinely equivalent but
differently-spelled units read as "not comparable" until that equivalence is
taught to measurement.ts's own registry, which is a narrower and more
honest gap than guessing one.

`Trends.staleness()` never defaults an expected interval — how often a given
measurement should recur is a clinical or programme decision this file may
not make on a deployment's behalf, so the caller supplies it and an interval
of zero or less is refused rather than silently treated as "always stale."

Three clinician routes (`/api/clinical/timeline`, `-result-trend`,
`-vital-trend`) go through the existing `phi()` gateway.

**Test evidence.** `test/trends.test.ts` (10 tests): a correction kept next
to the value it replaced without duplicating on the timeline, two units
correctly marked not comparable for a lab result, a genuine Celsius↔Fahrenheit
conversion succeeding for a vital and a nonsense unit genuinely failing (not
just assumed to pass), staleness refusing a non-positive interval, an empty
series answering "not stale" rather than crashing, tenant and patient
confinement, and a timeline whose sort order is proven against fixtures
where date order and "the order the code happens to read domains in"
deliberately disagree. Ten mutations, all ten caught — four survived the
first pass, each because the original test could not distinguish "did the
real check run" from "did the answer happen to come out the same anyway,"
and each fixed by making that distinction actually possible for the test to see.

**Still missing.** No patient-facing route. This item reads as a clinician's
tool extending `Workspace.chart()`, which is itself clinician-facing; the
existing `/patient/results` list is where a patient's released values
already live, and a full patient-facing trends UI is real, separate work
this item did not include. Cross-source comparison — a home vital-sign
reading against a lab result for a related analyte — is not attempted for
the same reason arbitrary lab-to-lab conversion is not: no verified
equivalence exists in this codebase to reuse.

## 64. Outreach campaigns — **done**

**Present, unchanged.** `Registry` (`src/population/registry.ts:119`)
computes cohorts, care gaps and measures, and every one of them carries the
members it could not classify rather than dropping them. This increment adds
nothing to `Registry` itself — a campaign is built by calling `gaps()`
exactly as before, once, at one moment.

**Added in this increment.** `src/population/eligibility.ts`:
`EligibilityRules`, a governed, versioned home for a `CohortRule` +
`CareGapRule` pair — the same publish-only, never-edit shape
`Questionnaires.publish()` already established in `src/patient/intake.ts`.
`publish()` always inserts a new version and retires the prior `active` one;
`get(id, version?)` finds exactly what was published, forever, so a campaign
built from version 3 still means version 3 after a clinician publishes
version 4.

`src/population/outreach.ts`: `OutreachCampaigns`. `create()` snapshots
`Registry.gaps()` against a published rule into an `outreach_campaigns` row
and one `outreach_items` row per gap member — the eligibility snapshot
(`eligible_last_done`, `eligible_overdue_days`) frozen at that moment, not a
live join. Duplicate outreach is prevented by
`idx_outreach_open_once` — a partial unique index on
`(tenant, patient, eligibility_rule_id)` while an item is open — enforced by
the schema itself, not by a check `create()` could get wrong under
concurrent requests; a second campaign against the same rule simply finds
those patients already spoken for and moves on to whoever is left.

An item's lifecycle — `pending → attempted/responded → booked → completed`,
with `excluded` and `unreachable` beside it — is enforced by status guards
the same shape as `Goals`/`Actions` in item 61: `assign()` needs an open
item, `recordAttempt()` refuses on a closed one and never moves an item
backward from `responded`/`booked`/`completed`, three unanswered attempts
surface it as `unreachable` (not a dead end — a later attempt that connects
still moves it forward), `linkBooking()` validates the booking exists and
belongs to this same patient when `Schedule` is wired in, `complete()`
refuses unless a booking is already on file, and `exclude()` needs a written
reason. `recordAttempt()` also calls `PatientContacts.reachable()` — the
same honesty item 59 built for a notification applies here: an attempt
against a patient with no verified, consented contact is refused, not
silently allowed because outreach is a different feature. `recheckEligibility()`
re-asks `Registry.gaps()` fresh, deliberately, rather than trusting the
stored snapshot — for the moment right before a call is actually made, not
as something that runs automatically and could make a list look shorter than
what a staff member was handed.

Fourteen clinician routes (`/api/clinical/eligibility-rules`,
`/api/clinical/outreach-campaigns[-close]`, `/api/clinical/outreach-items[-unreachable]`,
and `/api/clinical/outreach-item-{recheck,assign,attempt[s],book,complete,exclude}`)
go through the existing `phi()` gateway. No patient route: item 64's own text
describes a staff worklist, not something a patient portal shows — a patient
experiences the results of outreach (a notification, a booking) through the
portal surfaces items 58/59 already built, not a new one here.

**Test evidence.** `test/outreach.test.ts` (22 tests): rule versioning and
retirement, a negative or zero care-gap window refused, a campaign's
snapshot excluding patients not in the cohort, with a recent result, or
already on another campaign's open item — and picking them back up once that
item closes, refusing a campaign built against an unpublished rule, the full
assign → attempt → respond → book → complete happy path, refusing completion
without a booking and refusing a booking made for a different patient,
refusing to reassign or relink a completed item, one-way campaign closure,
three-unanswered-attempts surfacing as unreachable without trapping the item
there, a later attempt after a response never reverting it, exclusion
needing a written reason, `recordAttempt` refusing an unknown outcome and
refusing when no contact is reachable, `recheckEligibility` reporting a
closed gap without touching the stored snapshot, and tenant isolation.
Twenty-five mutations run against `eligibility.ts` and `outreach.ts`
together; twenty-two killed outright, five test gaps found and closed
(empty id/name on publish, an empty campaign name, an empty staff id, and
the state guards on `assign`/`linkBooking`/`close`/`complete`/`exclude` that
had no fixture exercising their refusal path at all). The remaining three
survivors are accepted as equivalent mutants and documented as such at the
call site rather than chased: the `status = 'active'` filter in
`EligibilityRules.get()`'s default path is provably redundant given the
invariant `publish()` maintains (the highest version number is always the
active one); the `<=0`/`<0` boundary on `withinDays` is unreachable because
the preceding `!input.gap.withinDays` falsy-check already catches zero, and
every negative number satisfies both variants identically; and
`create()`'s `String(err).includes("UNIQUE")` catch-guard cannot be
distinguished by any input reachable through the public API, because SQLite
reports a primary-key collision with the same "UNIQUE constraint failed"
text as the partial index this catch exists for, and no other constraint on
`outreach_items` is reachable from `create()`'s validated inputs.

**Correcting this document.** An earlier pass at item 67, below, claimed
small-cell suppression did not exist anywhere in this codebase. It does —
`src/population/release.ts`, merged before this roadmap was first written —
and the correction is recorded in full under item 67 rather than here.

**Still missing.** No portal or clinic-workspace screen surfaces a campaign
or worklist visually; the API is complete but, as with item 61's after-visit
summary, nothing renders it yet. A team is still not modelled for
`assigned_to`, the same gap items 61 and 62 already have for
`responsibleId`/handoffs. `channel` on an attempt is a free string, not a
closed set the way `outcome` is — deliberately, since a clinic's contact
channels are a deployment fact this codebase should not hardcode, but it
means the API does not reject a typo the way it rejects an unknown outcome.

## 65. Northern and travelling-clinic coordination — **done**

**Present, unchanged.** `Clinics` (`src/schedule/clinics.ts:123`) still
treats a travelling clinic visit as one object that generates its slots, can
be repeated, cancelled or rescheduled, and carries a waitlist whose order is
stated policy. Nothing in this increment touches it — `cancelVisit()` and
`rescheduleVisit()` know nothing about arrangements, deliberately (see
below).

**Added in this increment.** `src/schedule/arrangements.ts`: `Arrangements`,
covering the six kinds named verbatim in the item's own text — transport,
accommodation, interpreter, escort, equipment, accessibility. Each
arrangement names a visit, optionally a patient (unset for a visit-wide
need like an interpreter for the whole two days), and moves through
`needed → requested → confirmed`, with `cancelled` beside all three.
`assign()` records who owns chasing it down.

**Confirmation always needs evidence, never a status somebody picked.**
Two paths reach `confirmed`, both enforcing this the same way item 59's
notification-delivery states already do (H-183: sending is not delivering):
`confirm()` is the manual-coordination path and refuses without a
non-empty, human-written account of how the arrangement was checked.
`requestExternally()` is the simulated-external-integration path — an
`ExternalCoordinator` interface a real integration would implement, with
`SyntheticExternalCoordinator` as the demonstration stand-in, the same
shape as `SyntheticScanner` in `src/patient/intake.ts`. It marks confirmed
only when the external system's own answer says `confirmed: true`, carrying
that answer's reference as the evidence; anything else — including the
synthetic coordinator's ordinary answer — becomes `requested`, distinct
from confirmed, so a request handed to another party is not mistaken for
that party's agreement.

**A changed visit does not silently strand its arrangements.**
`reviewAfterVisitChange()` is called from the two routes that are the only
real callers of `Clinics.cancelVisit()`/`rescheduleVisit()` anywhere in this
codebase — `/api/clinical/visit-cancel` and `/api/clinical/visit-reschedule`
— immediately after each, rather than through a hook retrofitted into
`Clinics` itself. It raises one `arrangement`-kind task (a new `TaskKind` on
the existing `TaskStore`) per live arrangement on the changed visit, each
carrying the arrangement's own id as `correlationId` so every task raised
about one arrangement is traceable. It does not guess which arrangements
are actually voided by the change — a one-day move might not touch a
multi-day hotel booking, and this module has no way to know — so it asks a
person rather than deciding silently either way.

Seven clinician routes (`/api/clinical/arrangements` list/create,
`/api/clinical/arrangements-unconfirmed`, and `/api/clinical/arrangement-{assign,confirm,request-external,cancel}`),
through the existing `phi()`/`phiFor()` gateway, plus the two existing visit
routes extended to report `arrangementTasksRaised`. No new patient route —
like item 64, this is a staff coordination tool.

**Test evidence.** `test/arrangements.test.ts` (18 tests): a kind outside
the six refused, an empty detail refused, a visit that does not exist or is
cancelled refused, assignment needing a real owner, confirmation needing
non-empty evidence and refusing on an already-confirmed or cancelled
arrangement, cancellation needing a reason and refusing twice, the full
`requestExternally()` behaviour (an ordinary answer becomes requested not
confirmed; the confirm-marker answer becomes confirmed with the external
reference as evidence; a request left pending can still be confirmed
manually afterward without losing its reference; an empty reference from a
misbehaving coordinator is refused rather than treated as evidence),
`forVisit`/`forPatient`/`unconfirmed` each answering the different question
they are for, `reviewAfterVisitChange` raising exactly one task per live
arrangement while excluding cancelled ones and refusing without a reason,
and tenant isolation. Nineteen mutations, all nineteen caught: one survived
the first pass (an external coordinator returning an empty reference) and
needed a test using a custom, deliberately-misbehaving `ExternalCoordinator`
rather than the synthetic one, since the synthetic coordinator always
returns a real reference and so could never exercise that refusal.

**Still missing.** No portal or clinic-workspace screen. `unconfirmed()`
is not wired into the clinic board (item 66) as its own attention queue the
way item 66's existing `patient-contact` tasks are — a deployment can find
outstanding arrangements through `TaskStore.openOfKind("arrangement")`
today, but nothing renders them as a dedicated panel yet.

## 66. A clinic operations workspace — **partial**

**Present.** `Workspace.worklist()` (`src/workspace/summary.ts:616`) is the
clinician's queue: today's appointments, unacknowledged results, stalled
referrals, open tasks, overdue orders, incomplete reconciliations and care
plans past their review date, ordered by urgency and abnormality rather than
arrival.

**Added in this increment.** `ClinicBoard` (`src/workspace/board.ts`): a
waiting-room view derived from bookings and encounters, a separate
wall-mounted rendering with no field an identifier could go in, room and
resource availability with the next free slot, and an attention queue
carrying the patients nobody could reach. Every row states the reason it is
where it is. A room with nothing scheduled says so rather than reading as
free, and `progressKnown` is false on every row because the encounter model
cannot distinguish "in the waiting room" from "with the clinician".

**Still missing.** An intake-status panel is not on the board. Item 60 built
the workflow underneath it — `IntakeSubmissions.open()` is exactly the "who
has submitted, who has not" query a board panel would call — but nothing in
`src/workspace/board.ts` calls it yet; that wiring, not the underlying
capability, is what remains. Staff workload exists as `TaskStore.load()` but
is not on the board. The ranking is stated but not configurable: a deployment
that wanted a different rule would edit the source, and governed configuration
is its own piece of work.

*(Recently-discharged patients and unaccepted handoffs were listed here and
are now on the board, since item 62 built the workflow underneath them.)*

## 67. Measuring whether these workflows help — **partial**

**Present, and it is the hard half.** `MeasureResult`
(`src/population/registry.ts:91`) already does what the item's third bullet
asks: an explicit numerator and denominator, the members that could not be
classified carried alongside, `rate: null` rather than a number when more than
a fifth of the cohort is unassessable, and a written `caveat` so a dashboard
cannot print a bare percentage. "Preserve unknown outcomes rather than treating
them as success" is the existing design.

**Also present — correcting an earlier version of this document.** An
earlier draft of this section claimed small-cell suppression did not exist
in this codebase and would have to be built from scratch, on the strength of
a grep that should have found it and did not. It exists:
`src/population/release.ts` (merged in #55, well before this roadmap was
first written) already implements exactly what the item's closing bullet
asks for — `releaseMeasure()` and `releaseGaps()` fold any count from 1 to
`threshold−1` (default 5) to a suppressed cell, protect complementary pairs
so a published total cannot hand a suppressed count back by subtraction, and
state the method on the face of the release. Item 67's own text asks to
"reuse existing aggregate-release and small-cell protections", and that
premise was correct — it is this document's earlier claim to the contrary
that was wrong, now struck. The six metrics below reuse the same `cell()` /
`suppressComplementarily()` shape `releaseMeasure`/`releaseGaps` already use,
as new metric-shaped wrapper functions in `release.ts` alongside them, the
same way `releaseGaps` sits next to `releaseMeasure` rather than duplicating
its suppression logic.

**Missing.** The six metrics themselves — time to clinician review, unresolved
follow-up, referral completion, notification failures, missed appointments,
staff task burden — and per-metric declared exclusions and time windows.

---

## What item 58 adds

The API was complete and the application did not exist, so this increment is
the application, and nothing underneath it changed: no new patient route, no
new permission, no relaxation of a grant check. If the portal can see it, an
authorised `curl` could already see it.

- **`GET /me` serves a working application** rather than chrome — sign-in,
  a caregiver patient switcher, and screens for results, appointments,
  medications, messages, care team, access history and requests, each with its
  own loading, error and empty states.
- **A development identity provider**, off unless deliberately switched on,
  that mints tokens the ordinary `JwtVerifier` validates ordinarily. Northstar
  stays a resource server: there is no branch in the gate for development, and
  the portal signs in against whatever issuer is configured. In development
  that issuer happens to be local and synthetic.
- **Synthetic patients** to demonstrate against, generated rather than
  fixtured, so nothing that looks like a real person is committed.

What it does not add: identity proofing, ONE ID, a WCAG or AODA conformance
claim, or delivery of anything to a phone or an inbox the patient owns. Those
remain what PROVINCIAL.md §11 and §20 already say they are.
