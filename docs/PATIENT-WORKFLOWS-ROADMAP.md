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
| 66 | Clinic operations workspace | **Partial** — the board and resources are in; two views wait on item 62 |
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

## 60. Pre-visit intake and patient uploads — **missing**

**Present.** `PatientDocuments` (`src/clinical/documents.ts`) stores a
patient-supplied document as a chart fact with a source and a received date,
refuses HTML, SVG and executables, caps a payload at 256 KiB (`:42`, `:146`),
and keeps lists metadata-only so a list is never a download.

**Missing.** Everything the item is about: versioned questionnaires, visit
concerns, proposed medication updates, drafts that survive an interrupted
connection, a patient-facing upload route at all, quarantine pending a malware
scan, and routing a proposed chart change to a clinician. `grep -ril
questionnaire src/` finds one unrelated hit; `quarantine`, `malware` and
`virus` find none.

## 61. Structured care plans and after-visit summaries — **partial**

**Present.** `CarePlans` (`src/clinical/careplans.ts:105`) writes onto the
append-only clinical record: a plan needs a goal and a review date, completing
it needs a written outcome and revoking it needs a written reason, both as
amendments, so versions are preserved by construction. A plan past its review
date is a worklist item (`overdue()`, `:171`).

**Missing.** Goals and actions as structured entities rather than prose;
responsible people, due dates and progress; links from an action to the
existing `tasks`, `schedule_bookings`, `orders` and `referrals` stores; the
proposed / approved / completed / declined / superseded distinction; and the
patient-readable after-visit summary. `src/clinical/summary.ts` produces a
signed IPS-shaped export, which is a different artefact for a different reader.

## 62. Discharge follow-up and team handoffs — **missing**

The word occurs four times and none of them is this workflow:
`Transition = "…​| discharge | …"` triggers a medication reconciliation
(`src/meds/store.ts:38`), and `src/clinical/encounters.ts:8`,
`encounters.ts:325` and `src/workspace/visit.ts:6` mention discharge summaries
in prose. There is no discharge workflow, no accountable owner on a piece of
work, no handoff to accept, no temporary coverage with dates, and nothing that
surfaces an unaccepted transfer.

## 63. A useful longitudinal chart — **partial**

**Present, and stronger than the item assumes.** `Workspace.chart()`
(`src/workspace/summary.ts:324`) assembles every clinical domain with a
per-section status, so "withheld", "never recorded" and "none" are already
three different answers rather than one empty array. The UCUM measurement
contract (`src/clinical/measurement.ts`) is exactly the "compare only
compatible measurements using validated conversions" requirement: equivalent
unit labels pass through, a pure change of scale is converted, and a
comparison needing a molar mass is refused rather than guessed. Provenance
(`src/fhir/provenance.ts`) links a stored resource to where it came from.

**Missing.** The timeline and the trends. No file in `src/` contains the word
`timeline` or `trend`. Reference ranges, collection times and correction
markers exist on individual results but are not assembled into a series, and
nothing links a plotted point back to its source record because nothing plots.

## 64. Outreach campaigns — **missing**

**Present.** `Registry` (`src/population/registry.ts:119`) computes cohorts,
care gaps and measures, and every one of them carries the members it could not
classify rather than dropping them.

**Missing.** Everything else. No file mentions `outreach` or `campaign`. There
is no reviewable list, no eligibility snapshot, no assigned staff member, no
contact attempt, no response, no exclusion with a reason, and no separation
between the clinical rule and the campaign that uses it.

## 65. Northern and travelling-clinic coordination — **partial**

**Present.** `Clinics` (`src/schedule/clinics.ts:123`) treats a travelling
clinic visit as one object that generates its slots, can be repeated, cancelled
or rescheduled, and carries a waitlist whose order is stated policy — priority,
then waited-longest, then most-bumped — with offers that resolve as accepted,
declined or unreachable.

**Missing.** The arrangements around the visit: transport, accommodation,
interpreter, escort, equipment, accessibility. Nobody owns one, nothing is
confirmed or unconfirmed, and a visit that moves does not identify what it
broke. The item's last line — do not mark an external booking confirmed
without evidence — has no code to attach to yet.

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

**Still missing.** Intake status needs item 60. Recently-discharged patients
and unaccepted handoffs need item 62, and are absent rather than rendered
empty — an empty panel and a quiet day look the same. Staff workload exists
as `TaskStore.load()` but is not on the board. The ranking is stated but not
configurable: a deployment that wanted a different rule would edit the
source, and governed configuration is its own piece of work.

## 67. Measuring whether these workflows help — **partial, and one premise is wrong**

**Present, and it is the hard half.** `MeasureResult`
(`src/population/registry.ts:91`) already does what the item's third bullet
asks: an explicit numerator and denominator, the members that could not be
classified carried alongside, `rate: null` rather than a number when more than
a fifth of the cohort is unassessable, and a written `caveat` so a dashboard
cannot print a bare percentage. "Preserve unknown outcomes rather than treating
them as success" is the existing design.

**Missing.** The six metrics themselves — time to clinician review, unresolved
follow-up, referral completion, notification failures, missed appointments,
staff task burden — and per-metric declared exclusions and time windows.

**The premise to correct.** The item says to reuse "existing aggregate-release
and small-cell protections". The aggregate-release honesty exists, as above.
**Small-cell suppression does not.** `grep -rn 'smallCell\|small-cell\|suppress'`
over `src/population/` and `src/workspace/` finds nothing: a measure over a
cohort of three returns a rate computed from three people. Any work on item 67
has to build that, not reuse it.

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
