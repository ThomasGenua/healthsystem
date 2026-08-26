# Clinical safety case and hazard log

This is the document a clinical safety officer can open. The hazards it lists
were not invented for it: they are the ones the code and tests already reason
about. What this file adds is the form those comments lack — severity,
likelihood, a named control, and a pointer at the test that pins it — so a
reviewer does not have to reconstruct the argument from forty module headers.

It is written in the shape of DCB0129 (manufacturer) and is usable as input to
DCB0160 (deploying organisation). It is **not** a certified safety case, not a
substitute for a named clinician signing it, and not a claim that residual
risk is acceptable for a particular site. A deployment still has to do its
own assessment against its own patients, its own network, and its own
staffing.

Versioned with the code. A hazard whose control has moved and whose evidence
still points at a deleted test is a silent failure of this document; 
`test/clinical-safety.test.ts` reads the evidence column and fails if a cited
test is gone.

**Product:** Portage (this repository).
**Version this case describes:** the `main` it is committed on (currently
the post-0.5.0 line: v0.5.0 plus off-machine backup, organization identity
on credentials, break-glass notice dispatch, encounters, the provider
directory, FHIR projection of that directory, the refusal/fault split
in `phi()`, the longitudinal-chart increment, durable patient messaging,
the OAuth patient/proxy boundary, the laboratory result bridge,
pharmacy transmission, the migration loader, the privacy office, the
patient HTML shell at `/me`, the access-review join on the trail,
travelling clinics and the waitlist, and channel configuration as a ledger).
**Last reviewed:** 2026-08-25.
**Reviewer of this draft:** the author of the controls, not an independent
clinical safety officer. That gap is residual risk R-01.

---

## 1. What the system is for

Portage is a health integration engine and a clinical store for a northern
Canadian deployment: HL7 v2 in and out, FHIR R4 over HTTP, durable
store-and-forward, and the chart, orders, medications, referrals, schedule
and consent that sit behind those feeds.

It is for a health information custodian — a territorial authority, a
hospital, a group of clinics — that needs one node to accept messages when
the link is down, to keep one patient's record coherent, and to refuse the
quiet failures that look like empty panels.

It is **not** an EPR that a ward already has. It is the layer that makes
feeds and a chart honest when the alternative is a paper list and a fax.

### Clinical scope

In scope, as stores and an authenticated HTTP API:

- an append-only clinical record and a derived patient index
- visits (encounters) that own what happened inside them
- orders and results, including acknowledgement that cannot be inherited
- medications, allergies, a safety check, and reconciliation
- referrals and a unified work inbox
- a schedule that cannot double-book a seat
- consent directives, break-glass, and an OAuth/grant-bound patient API
- a privacy office: reviews, legal holds, incidents, access clocks, disclosures, an assurance catalogue
- an access review of the trail (`GET /api/audit/review`), complementary to those queues
- travelling-clinic visits and a waitlist whose order is stated policy
- a FHIR R4 facade, including the local provider directory as resources
- hash-chained message lineage and a hash-chained access audit
- verified backup, including an off-machine replica when configured

### What it explicitly does not do

These are not gaps discovered later. They are scope:

| Out of scope | Why that is a clinical statement |
|---|---|
| A clinician user interface | The chart is an API. "A clinician can use this today" is not claimed. A consumer that ignores `complete === false` reintroduces H-06. |
| A patient application | `GET /me` is chrome (EN/FR, landmarks, an honest banner). Identity-proofing enrolment, notifications and accessibility validation are not. Do not call it a portal. |
| Clinical decision-support *content* | The check is here; the interaction table is not. An 80% complete table is one prescribers learn to trust. |
| Machine learning | Nothing in this repository infers, predicts or scores. No output should be read as though it did. |
| A certified PSI / Projectathon result | Conformance packs encode published profiles and pass shipped fixtures. |
| Authoritative provincial directories | The local registry is maintained here. Syncing from a provincial source is a later question. |
| Horizontal multi-writer scale | One writer per database. A territorial hub is #25, last on purpose. |
| Extraction from an incumbent | The declare-and-check loader exists (#20). Getting data out of the incumbent is that vendor's export. |

---

## 2. How hazards were identified

Harvest, not brainstorm. Each row below started as a module header or a test
name that already said what failure the code exists to prevent. Severity and
likelihood were assigned for this document; they are judgements, not
measurements.

A new module, a changed control, or an incident is a trigger to re-open the
log — see §5. Hazards that exist only in a deployment (a mis-addressed SMS
gateway, a clinic that never opens the worklist) are residual and named as
such, not dressed up as product defects.

### Scales

**Severity** — harm if the hazard is realised and the control fails or is
absent:

| Rating | Meaning |
|---|---|
| Catastrophic | Death, permanent disability, or a wrong-patient / wrong-result event that directs urgent treatment |
| Major | Significant delayed treatment, a privacy breach that changes who can act, or a chart that is quietly false |
| Moderate | Temporary harm, a missed administrative loop that is recoverable, or a disclosure that is bounded |
| Minor | Inconvenience, extra work, no lasting clinical effect |

**Likelihood** — after the control in this repository, in a deployment that
runs the tests and follows the runbook. Not the likelihood without the
control; that is usually higher, which is why the control exists.

| Rating | Meaning |
|---|---|
| High | Expected in ordinary operation if the remaining dependency (a person, a feed, a licensed DB) is not met |
| Medium | Foreseeable when the node is busy, the link is down, or a clerk races another |
| Low | Requires bypassing the store, a failed deploy discipline, or a rare coincidence the tests already name |

**Residual risk** is what remains after the control. Accepting it is a
deployment decision. This case states it; it does not sign it off.

---

## 3. Clinical safety officer

The role this document needs, and that this repository cannot appoint:

**Clinical Safety Officer (CSO)** — a registered clinician accountable for
keeping this log true. Not the author of the code. The CSO:

- reviews the log when a trigger in §5 fires
- decides whether a residual risk is acceptable *for a named deployment*
- is named on that deployment's DCB0160 case, not invented here as a
  placeholder person

Until a deployment names one, the manufacturer-side owner of this file is
the maintainer of the repository. That is not the same job, and R-01 says so.

### What triggers a review of this log

Any one of:

1. **A new clinical module** — a store, a route under `/api/clinical/`, or a
   FHIR resource type that names a patient.
2. **A changed control** — a test cited in the evidence column is deleted,
   renamed, or weakened; a uniqueness constraint is dropped; a catch starts
   swallowing a store exception as "none".
3. **An incident** — a near miss or a harm report that maps to a row here, or
   that maps to nothing here (which is a missing row).
4. **A release** that claims a closed issue in the "prove / model / in front
   of a person" bands of the README roadmap.
5. **A year** since the `Last reviewed` date, even if nothing else moved.

`test/clinical-safety.test.ts` is the mechanical half of (2): a cited test
that no longer exists fails the build.

---

## 4. Hazard log

Each row: the hazard, what causes it, what it does to a patient, how severe
and likely it is *with the control in place*, the control, and the test that
makes the control a fact rather than a comment.

### Record and identity

| ID | Hazard | Cause | Effect on a patient | Sev. | Like. | Control | Evidence |
|---|---|---|---|---|---|---|---|
| H-01 | Silent overwrite of clinically material data | An `UPDATE` that replaces the row | The chart no longer says what was known when a decision was taken | Catastrophic | Low | Append-only record: `record` / `amend` / `retract`; per-patient hash chain | `test/clinical-record.test.ts` — "there is no way to overwrite an entry through the store" |
| H-02 | Retraction treated as deletion | "Entered in error" removes the row | A decision taken on the original cannot be reviewed | Major | Low | Retraction is a new version; content is kept | `test/clinical-record.test.ts` — "a retraction marks the record without removing it" |
| H-03 | Signed note revised after attestation | Edit in place after signature | The attested text is not what the chart now shows | Major | Low | `revise` refuses a signed note; only a separately signed addendum follows | `test/clinical-notes.test.ts` — "a signed note cannot be revised" |
| H-04 | Wrong patient selected at lookup | Shared name/DOB or a shared identifier | Care, orders and meds applied to the wrong person | Catastrophic | Medium | Derived index; duplicates surfaced, never merged | `test/patient-index.test.ts` — "one identifier naming two charts is surfaced, not merged" |
| H-05 | Automatic merge of two charts | An algorithm decides they are the same person | One chart acquires the other's allergies; unmerge is not honest | Catastrophic | Low | `duplicates()` reports; nothing merges | `test/patient-index.test.ts` — "one identifier naming two charts is surfaced, not merged" |
| H-77 | A link made in error puts one person's record on another's chart | A clinician links two charts that are two people — twins, a father and son, a shared name and birth date | Another patient's allergies and medications are read as context for this patient's care | Catastrophic | Low | A link is a person's assertion on evidence worth weighing, never inferred; the assembled chart says on its face it is assembled and every row stays attributed to its own chart; an unlink restores the prior view exactly | `test/chart-links.test.ts` — "the assembled chart carries the linked member's allergy, and says on its face that it is assembled"; `test/chart-links.test.ts` — "unlinking restores the prior view exactly, with nothing lost on either side" |
| H-78 | Assembly across a link hides one member's failure | One member's section fails or is thinner while another's loads | The assembled chart reads complete while half the person is missing | Catastrophic | Low | Incompleteness surfaces per section; summary statuses are the worst member's answer, never the best | `test/chart-links.test.ts` — "a member whose section fails makes the assembled chart incomplete, not shorter"; `test/chart-links.test.ts` — "the assembled allergy status is the worst member's answer" |
| H-83 | Clinician acts on a stale cached chart | A chart served from a cache during an outage without its age on its face | A cached "no known drug allergies" from before this morning's reaction is read as current, and the clinician stops asking | Catastrophic | Medium | Staleness is a first-class incompleteness: every cached panel says "as of N hours ago", the summary carries a stale block, the console banners it first, and a cache that cannot establish its own age does not serve | `test/offline-chart.test.ts` — "a chart assembled from a cache wears its age on every panel"; `test/offline-chart.test.ts` — "a cache that cannot establish its own age does not serve"; `test/offline-chart.test.ts` — "staleness never displaces a more specific reason" |
| H-84 | A directive issued during the outage is unknown to the cache | Consent directives ride the snapshot; one recorded at the primary after the fill cannot reach the station | A patient who locked their record during the outage has it served anyway | Catastrophic | Low | The serving budget is the directive-freshness clock: inside it the station serves stale on its face, past it it serves nothing at all rather than a chart with an unknown lockbox over it | `test/reading-station.test.ts` — "past its budget the station serves nothing, and purges rather than waiting to be asked"; `test/reading-station.test.ts` — "consent still decides at the station, from the directives the snapshot carried" |
| H-85 | An offline read invisible to access review | The station keeps its own trail and the link returns without it ever reaching the primary | "Who looked at my record" omits every read that happened during the outage | Major | Medium | The station chains its own reads from its own genesis, and reconciliation appends them to the primary as new rows carrying the station id, the time of the read and the station seq — never a rewrite, never a back-insert | `test/reading-station.test.ts` — "offline reads reconcile onto the primary's chain by appending, never by rewriting"; `test/reading-station.test.ts` — "a station trail that does not verify is an incident, not a silent drop" |
| H-86 | A cache outlives its budget and keeps serving | The outage lasts longer than anyone planned for and nothing stops the station | A month-old chart is read as current, and a second copy of the record sits in a building nobody is watching | Catastrophic | Low | Expiry is autonomous: past the budget the station refuses every clinical route and destroys the clinical cache, keeping only the trail it still owes the primary | `test/reading-station.test.ts` — "past its budget the station serves nothing, and purges rather than waiting to be asked"; `test/reading-station.test.ts` — "a station inside its budget is not purged by asking" |
| H-87 | A station fills onto an unencrypted volume | The at-rest posture is applied at the primary and forgotten on the second node | The whole chart leaves with a disk from a room less locked than the server room | Catastrophic | Low | The H-44 check runs at fill time and refuses; a station sits in a nursing station rather than a locked room, so the check is applied harder rather than relaxed | `test/reading-station.test.ts` — "a station will not fill onto an unencrypted volume" |
| H-88 | A station accepts a clinical write | The cache is a full node, so the write routes are present and would otherwise work | A second writable copy of the record diverges from the primary with no honest way to reconcile it afterwards | Catastrophic | Low | Every non-GET clinical route on a station is refused and audited, and the refusal names the feed queue and the paper form the write path already degrades to | `test/reading-station.test.ts` — "a station refuses clinical writes, and says where to write instead" |
| H-82 | Safety check consults one chart of a linked person — or reads past a directive | The check reads the named chart while the summary assembles across members; or unions a chart the caller's directive check refuses | The assembled chart shows a penicillin allergy the safety check calls clear; or the check becomes an ingredient-by-ingredient oracle over a withheld allergy list | Catastrophic | Low | Consent composes into the check as into the chart, member by member and section by section, the named patient included: a whole-record directive refuses with the break-glass path, a locked section stays out, and every gap is a blocking finding, never silence | `test/chart-links.test.ts` — "the safety check answers for the person the link asserts"; `test/chart-links.test.ts` — "a withheld member is not consulted by the safety check — and the check says so"; `test/chart-links.test.ts` — "the safety check is inside the lockbox, with the same emergency path"; `test/chart-links.test.ts` — "a scoped lock on a member locks that section of the check" |
| H-06 | Empty chart panel read as "none" | A store threw, a list was cut, a section was withheld — and the renderer shows a blank | Prescribe against an allergy list that failed to load | Catastrophic | Medium | Every section carries `complete` / incompleteness (`unavailable`, `truncated`, `withheld`) | `test/workspace.test.ts` — "a section that fails is empty and says why, rather than reading as none" |
| H-07 | Empty visit read as "nothing happened" | Failed section or missing encounter rendered blank | Handover misses the orders and results of the visit | Major | Medium | Visit assembly is honest; membership is by encounter, not a time window | `test/encounters.test.ts` — "the assembled visit says a section failed, rather than rendering as nothing happened" |
| H-45 | Empty immunization panel read as "none" | Never asked and documented-empty render the same | A child is assumed vaccinated when nobody asked | Major | Medium | `never-asked` is a status; a refusal needs a reason | `test/immunizations.test.ts` — "nobody asked and a documented history are different answers" |
| H-46 | Half a blood pressure filed as a vital | Systolic stored without diastolic | A trend and a dose are calculated from one number | Major | Low | Blood pressure refused unless both numbers arrive together | `test/vitals.test.ts` — "blood pressure needs both systolic and diastolic" |
| H-47 | Two current primary providers | A locum assigned as MRP without retiring the last | A result is routed to neither inbox | Major | Low | At most one current primary; retire before assigning another | `test/careteam.test.ts` — "a second current primary is refused until the first is retired" |
| H-48 | Coverage overwritten in place | Eligibility `UPDATE`d when the card changes | "Were they covered when this visit happened" is unanswerable | Major | Low | New row supersedes; the previous claim stays | `test/coverage.test.ts` — "a change of eligibility keeps the previous claim" |
| H-49 | Patient message closed without saying what was done | Inbox cleared with a click | A renewal or a result question is treated as finished | Major | Medium | Close needs a reason; a waiting patient needs a longer one | `test/messaging.test.ts` — "closing a thread the patient is still waiting on needs to say what was done" |
| H-50 | Unowned patient message is nobody's work | No owner, no list | The question sits until it is stale | Major | Medium | `unassigned()` is a queue; open assigns the MRP when there is one | `test/messaging.test.ts` — "an unowned patient message is a list, not a missing inbox" |

### Visits and the diary

| ID | Hazard | Cause | Effect on a patient | Sev. | Like. | Control | Evidence |
|---|---|---|---|---|---|---|---|
| H-08 | A started visit is cancelled | Status used to erase attendance | The record says they never came | Moderate | Low | Only a planned visit may be cancelled; a started one is closed with a disposition | `test/encounters.test.ts` — "a visit that started cannot be cancelled, because it happened" |
| H-09 | Content attached to another patient's visit | A free-text `encounter_id` | Orders and notes land on the wrong chart | Major | Low | `EncounterMismatch`; validate-for-patient on write | `test/encounters.test.ts` — "clinical content cannot name another patient's visit" |
| H-10 | Two patients booked into one seat | Check-then-insert under two clerks, a portal and a SIU feed | Two people arrive; the urgent one waits | Major | Low | Uniqueness on `(slot, seat)`; `SlotFull` is 409 | `test/schedule.test.ts` — "the database refuses a second booking on a seat, whatever the caller does" |
| H-11 | A missed urgent appointment is closed as admin | DNA marked; nobody is owed anything | The appointment that answered a referral is the end of the story | Major | Medium | `didNotAttend` returns work; `unresolvedNonAttendance()` | `test/schedule.test.ts` — "a missed urgent appointment is work, not a status" |

### Orders and results

| ID | Hazard | Cause | Effect on a patient | Sev. | Like. | Control | Evidence |
|---|---|---|---|---|---|---|---|
| H-12 | Corrected result inherits the old acknowledgement | Ack stored on the order, or on an identity a correction reuses | Potassium 7.1 marked reviewed; nobody saw 7.1 or the 4.0 that replaced it | Catastrophic | Low | Results append; ack lives on the row; a superseded result cannot be signed off | `test/orders.test.ts` — "a corrected result does not inherit the acknowledgement of the value it replaced" |
| H-13 | Abnormal result reported and never read | No queue, or routed to someone who has left | The question looks answered | Catastrophic | Medium | Unacknowledged queue; per-flag clock; handover refuses nobody | `test/orders.test.ts` — "a critical value is on a different clock from a routine one" |
| H-14 | Order placed and never resulted | The lab never reports; no error | The test never happens and nobody is waiting | Major | Medium | `awaitingResult()`; a preliminary does not close the wait | `test/orders.test.ts` — "an order placed and never resulted is the other silence" |
| H-15 | Unsolicited result discarded | No matching order, so refused | An outside-facility result is lost | Major | Low | Stored and queued for matching | `test/orders.test.ts` — "a result with no order is kept and queued, not refused" |
| H-16 | Result filed against another patient's order | Interface mis-association | Wrong number in the chart | Catastrophic | Low | Store refuses a cross-patient file | `test/orders.test.ts` — "a result is never filed against another patient's order" |
| H-55 | Inbound result filed on the wrong chart | Fallback match on name, surname or most recent order when the identifier misses | Another person's result in this chart, invisibly | Catastrophic | Low | Identifier-only matching; an ambiguous or absent match is held for a person | `test/lab-intake.test.ts` — "a result whose patient cannot be identified is held, never filed against a guess" |
| H-56 | Retransmission read as a new result | No stable identity for an analyte on a specimen | The unacknowledged queue fills with duplicates and clinicians stop reading it | Major | High | Accession + analyte + sub-id key; identical resend writes nothing | `test/lab-intake.test.ts` — "an identical retransmission writes nothing" |
| H-57 | Stale preliminary overwrites a final | Out-of-order delivery applied blindly | An answered order reopens and the current value is replaced by an older one | Major | Medium | A preliminary arriving after a final is ignored and recorded as ignored | `test/lab-intake.test.ts` — "a preliminary arriving after the final is ignored, and says so" |
| H-58 | Unknown result status filed as final | Defaulting an unrecognised OBX-11 | An unfinished result starts an acknowledgement clock, or a finished one silences it | Major | Low | Unknown status or flag is refused, not defaulted | `test/lab-intake.test.ts` — "an unknown result status or abnormal flag is refused, not filed as normal" |
| H-59 | Result timestamped in the wrong hour | HL7 timestamp with no zone assumed to be UTC | A value lands on the wrong side of a shift change | Moderate | High | Explicit offset honoured; profile offset applied; otherwise recorded as assumed and reported | `test/lab-intake.test.ts` — "a timestamp with no timezone is recorded as assumed rather than silently made UTC" |
| H-60 | A mistyped vendor profile silently reads as generic | Fallback when a named profile is missing | A site believes it has a vendor interface it does not have | Major | Low | A named profile that does not resolve fails the delivery | `test/lab-channel.test.ts` — "a destination naming a laboratory profile that does not exist fails loudly" |

### Medications

| ID | Hazard | Cause | Effect on a patient | Sev. | Like. | Control | Evidence |
|---|---|---|---|---|---|---|---|
| H-17 | List says what was prescribed, not what is taken | One column for both claims | A dose is calculated around a statin the patient stopped | Major | Medium | `source` and `adherence` are separate; the taking-list is a query | `test/medications.test.ts` — "a prescribed drug the patient stopped taking is not on the list a dose is calculated from" |
| H-18 | Empty allergy panel: never-asked read as no-known | Both render blank; the check returns clear | Prescribe without a history, reassured | Catastrophic | Medium | `never-asked` ≠ `none-documented`; `unknown` is never `clear` | `test/medications.test.ts` — "nobody asked and no known allergies are different answers" |
| H-19 | Interaction source down reported as "no interactions" | A failed lookup returns empty | A contraindicated pair is signed as checked | Catastrophic | Medium | Unavailable source → finding, not clear; no source configured → unchecked | `test/medications.test.ts` — "an interaction source that cannot answer does not read as one that said no" |
| H-20 | Partial interaction table trusted as complete | An 80% table ships as the check | The missing 20% is invisible; trust is learned | Major | High | Deliberately small shipped set; licensed DB through a seam | `test/medications.test.ts` — "prescribing past a contraindication needs an override, and the override is the record" |
| H-21 | Stopped drug vanishes | Delete or silent status | Next prescriber cannot tell stop from mistake | Moderate | Low | Stop needs a reason; the row stays | `test/medications.test.ts` — "a stopped drug leaves the list, with a reason, and stays readable" |
| H-22 | Reconciliation closed with undecided meds | Complete clicked to clear a queue | The transition list is a guess | Major | Medium | Complete refused while items are unresolved | `test/medications.test.ts` — "a reconciliation cannot be completed with medications nobody decided about" |
| H-61 | Prescription transmitted twice, dispensed twice | A retry on an already-sent prescription | A double dispense; for an opioid, a serious adverse event with no error recorded | Catastrophic | Low | A second transmit is refused; the only retry is `replaceFailed`, which names what it replaces | `test/prescribe.test.ts` — "transmitting the same prescription twice is refused, because a pharmacy may dispense twice" |
| H-62 | Prescription looks sent and went nowhere | No pharmacy channel, or a silent dispatch failure | The patient arrives at a counter with nothing waiting | Major | High | Transmit refuses without a channel; a failed dispatch is `failed`, not left as a draft; `neverSent()` is a queue | `test/prescribe.test.ts` — "with no pharmacy channel a prescription cannot be transmitted, and must be recorded as printed" |
| H-63 | Cancelled prescription still standing at the pharmacy | Chart says stopped, pharmacy screen says dispense | The patient collects a drug their clinician withdrew | Major | Medium | `cancellationsOwed()` until somebody records how the pharmacy was told | `test/prescribe.test.ts` — "cancelling a transmitted prescription owes the pharmacy a message until somebody confirms it" |
| H-64 | Controlled substance transmitted without authority | Narcotic e-prescribing is separately regulated | The deployment is in breach and was not told | Major | Low | Refused unless the deployment declares its authority, which is recorded | `test/prescribe.test.ts` — "a controlled substance is not transmitted unless the deployment declares its authority" |

### Work and referrals

| ID | Hazard | Cause | Effect on a patient | Sev. | Like. | Control | Evidence |
|---|---|---|---|---|---|---|---|
| H-23 | Work disappears (unowned, closed without evidence) | Handed to someone who left; completed on a click | A result review or a renewal never happens | Major | Medium | No delete; complete needs evidence; `unassigned()` is a list | `test/tasks.test.ts` — "completing an item requires evidence of what was done" |
| H-24 | Referral sent and never heard of again | No ack, no report; no error | Specialist care never occurs; the sender assumes progress | Major | High | `expected_by` per step; `stalled()`; close needs an outcome | `test/referrals.test.ts` — "a referral nobody acknowledged shows up as stalled" |

### Consent, access, tenancy

| ID | Hazard | Cause | Effect on a patient | Sev. | Like. | Control | Evidence |
|---|---|---|---|---|---|---|---|
| H-25 | Lockbox with no survivable emergency path — or a quiet bypass | Hard refuse in ED, or a shared break-glass account | Either cannot treat, or everyone can and nobody is told | Major | Medium | Break-glass: reason in words, before the read, queued for notice and review | `test/consent.test.ts` — "breaking glass needs a reason somebody can weigh, not a word" |
| H-26 | Break-glass notice never leaves the node | A queue nobody sends | The patient is not told their record was opened | Major | Medium | Dispatch through the delivery machinery; failure is visible | `test/break-glass-notice.test.ts` — "a notice that cannot be sent is a visible failure, not a silent one" |
| H-27 | Withhold-from-organization defeated by a caller that names no organization | The directive matched a field nothing carried | The clinic they named still sees the record — or, after the fail-closed fix, the whole territory is withheld | Major | Low | Organization on the credential, checked against the directory | `test/organization-identity.test.ts` — "a credential that cannot say which organization it is still fails closed" |
| H-28 | Clinical route serves a record without consulting the directive | A new endpoint forgets to call `phi()` | The lockbox is theatre | Catastrophic | Low | Check lives inside `phi()`; source-reading test requires it | `test/clinical-api.test.ts` — "every patient-scoped clinical route consults the directive check" |
| H-29 | Clinical route serves a record without an audit row | A new endpoint forgets to audit — or a consent-emptied path skips it | A privacy office cannot see who looked | Major | Low | `phi()` audits first; source-reading test drives every route; the safety check audits the named patient on every answer, even one directives emptied | `test/clinical-api.test.ts` — "every clinical route leaves an audit row, including ones added later"; `test/chart-links.test.ts` — "a safety check that could consult nothing still lands on the patient's trail" |
| H-30 | Delegated access that never ends | A parent grant with no expiry | An adolescent's notes remain readable after entitlement ended | Major | Medium | Delegated grant without expiry is refused; clock-based lapse | `test/patient-access.test.ts` — "a parent's access lapses on the day it was set to, with nothing having to run" |
| H-31 | Held result looks like no result | A hold without a visible state | The patient thinks nothing came back | Moderate | Medium | A hold is visible as held; it ends by the clock | `test/patient-access.test.ts` — "a held result is visible as held, never simply absent" |
| H-51 | Patient SMART token becomes general FHIR read | `patient/*.read` collapsed into the system `read` scope | One patient can enumerate the provincial facade | Catastrophic | Low | Separate OAuth-only `patient` scope; it never implies FHIR read | `test/patient-api.test.ts` — "patient SMART scope cannot read the general FHIR facade" |
| H-52 | Patient or proxy names another chart | Route trusts a patient id in the query/body | Another person's results, messages or appointments are disclosed | Catastrophic | Low | Every route binds OAuth subject to a live patient_authority grant | `test/patient-api.test.ts` — "an OAuth subject still needs a live authority for the named chart" |
| H-53 | Appointment proxy gains results or messages | One coarse delegated-access flag | Sensitive information disclosed beyond the patient's purpose | Major | Low | Explicit grant permissions; proxy cannot delegate onward | `test/patient-api.test.ts` — "a proxy permission stays narrow" |
| H-54 | Authentication-off mode turns anonymous into a patient | Synthetic anonymous principal bypasses the scope map | Unauthenticated chart access | Catastrophic | Low | Route-level OAuth check in addition to the gate | `test/patient-api.test.ts` — "authentication-off mode never turns anonymous into a patient" |
| H-32 | Cross-custodian read on a shared node | A query that omits `tenant_id` | Another organization's chart | Catastrophic | Low | Tenant in every statement; source-reading test | `test/tenant-scoping.test.ts` — "no statement reads or writes tenant-scoped data without naming a tenant" |
| H-33 | Feed credential subscribes its way to the record | `write` on `/fhir/` included Subscription | A lab key becomes a standing read | Catastrophic | Low | Subscription is admin-scoped | `test/subscription-scope.test.ts` — "a feed credential cannot subscribe its way to the clinical record" |
| H-34 | Admin path reached without admin scope | Gate and router disagree on spelling | Unauthorized PHI or operator action | Catastrophic | Low | One gate; adversarial path spellings | `test/auth-bypass.test.ts` — "no spelling of an admin path reaches admin data without the admin scope" |
| H-79 | A link overrides a member's directive | Assembly reads every member; one of them said no | A chart the patient withheld is disclosed because a chart linked to it was opened | Catastrophic | Low | Fail-closed union: any member's directive withholds or locks the assembly; break-glass lifts only the member it was broken for, and the refusal names that member so the override can target it; the refused attempt lands on the queried chart's trail too; a caller a directive excludes may neither make nor sever a link | `test/chart-links.test.ts` — "a directive on either member withholds across the assembled view"; `test/chart-links.test.ts` — "a scoped directive on one member locks that section of the assembled chart"; `test/chart-links.test.ts` — "a caller a directive excludes cannot sever the link either" |
| H-80 | A patient-portal grant follows the link | The portal assembles the way the clinician chart does | A proxy authorized for one chart reads the linked person's record | Catastrophic | Low | The portal is deliberately blind to links; a grant names one chart and serves one chart | `test/chart-links.test.ts` — "the patient portal never assembles across a link" |
| H-81 | A linked read invisible to a member's access review | One audit row, written against the requested chart only | The linked member's "who looked at my record" answer omits a disclosure that included them | Major | Low | One audit row per disclosed member; the read lands on every member's trail | `test/chart-links.test.ts` — "reading a linked chart lands on every member's trail" |

### Privacy office and assurance

| ID | Hazard | Cause | Effect on a patient | Sev. | Like. | Control | Evidence |
|---|---|---|---|---|---|---|---|
| H-70 | Review closed with unaddressed flags | Close clicked to empty a queue | An unreviewed break-glass teaches the ward that breaking glass costs nothing | Major | Medium | Close refused while flags are open; addressing needs a written reason | `test/privacy-office.test.ts` — "closing a review with unaddressed flags is refused" |
| H-71 | Retention sweep runs through a legal hold | Sweep does not consult holds | The message log is destroyed while a matter is live | Catastrophic | Low | Any active hold on the tenant skips the whole sweep; messages are not patient-keyed | `test/privacy-office.test.ts` — "an active legal hold skips the retention sweep" |
| H-72 | Access request completed with no disclosure record | `completeRequest` remains possible without one | A privacy office cannot say what left the building | Major | Medium | `fulfillAccess` records a disclosure; completing without one is flagged, not blocked | `test/privacy-office.test.ts` — "fulfilling an access request records a disclosure" |
| H-73 | Incident closed without saying whether patients were told | Close to empty the queue | A notification duty is silently unmet | Major | Medium | Close refused without told/not-told; not-told needs a written why | `test/privacy-office.test.ts` — "closing an incident without saying whether patients were told is refused" |
| H-74 | Active subprocessor with no hosting region | Register a vendor without saying where the disks are | PHI leaves the country unnoticed | Major | Low | Active status refused without a region; a candidate may have none | `test/privacy-office.test.ts` — "an active subprocessor without a hosting region is refused" |
| H-75 | Finding closed by forgetting it | Status flipped with no remediation | The catalogue says a control is in-place when it is not | Major | Medium | Close needs remediation or an accepted residual risk; BACKUP-02 stays partial | `test/privacy-office.test.ts` — "closing a finding without remediation or residual risk is refused" |
| H-76 | After-hours decided from the wall clock | Review uses local time at the moment of the review | A 03:00 UTC read is missed because the officer opened the review at noon | Moderate | Medium | UTC timestamp of the access, not `Date.now()` | `test/privacy-office.test.ts` — "after-hours is decided from a UTC timestamp, not the wall clock" |

### Interface, backup, measurement

| ID | Hazard | Cause | Effect on a patient | Sev. | Like. | Control | Evidence |
|---|---|---|---|---|---|---|---|
| H-35 | AA acknowledged a message that was not stored | Ack before commit | The sender believes the chart was updated | Major | Low | AE on failed write; AA only when stored | `test/durability.test.ts` — "a failed write is answered with AE, never AA" |
| H-36 | A feed that stopped sending looks like a quiet night | Empty queue, health green | Care proceeds on a stale chart | Major | High | Declared cadence; silence degrades health | `test/silent-feed.test.ts` — "health reports degraded, and says which feed" |
| H-37 | `cp` of a live database offered as a backup | File copy during WAL writes | Restore is corrupt; RPO was fiction | Catastrophic | Low | SQLite backup API; verify chains; remote read-back | `test/backup.test.ts` — "a copied file is not a backup, but a snapshot of the same database is" |
| H-38 | Restore of a snapshot that cannot come up | Swap first, discover later | The live file is gone and the replacement will not open | Catastrophic | Low | Preflight migrate of a scratch copy; keep the displaced file | `test/restore.test.ts` — "a snapshot that cannot come up is refused before anything is displaced" |
| H-39 | Two engines on one database | Overlapping deploy | Duplicate in-flight messages; split-brain writes | Major | Low | Instance lock; restore clears a stale lock | `test/instance-lock.test.ts` — "without the lock a second instance duplicates a message in flight" |
| H-65 | Migration reports success having dropped records | Completeness inferred from the absence of errors | 4% of allergies missing and invisible; a prescriber acts into the gap | Catastrophic | High | Source counts declared then checked; `complete` is never true because nothing threw; closing over a gap needs a written reason | `test/migration-load.test.ts` — "a run cannot call itself complete because nothing threw" |
| H-66 | Migrated record rejected and lost | Rejection reported as a count | A row nobody can go and look at | Major | Medium | Rejects keep the whole payload and reason in a queue | `test/migration-load.test.ts` — "a record that cannot be loaded is rejected with its payload, not thrown away" |
| H-67 | Resumed migration doubles the caseload | No idempotency on source identity | Duplicate allergies and medications on every chart | Major | Medium | Keyed on source system, type and source id; a re-run records `unchanged` | `test/migration-load.test.ts` — "loading is idempotent, so a resumed run does not double what it already did" |
| H-68 | Rollback deletes records a clinician's note refers to | Cutover rolled back after go-live | The chart loses what a note was written about | Major | Low | A cutover with clinical activity since refuses, naming who wrote; rollback is retraction, not deletion | `test/migration-load.test.ts` — "a cutover cannot be rolled back once a clinician has written into a chart" |
| H-69 | Migrated drug read as this clinic's prescription | Everything loaded as `prescribed` | Provenance lost; the list asserts prescriptions nobody wrote | Major | Medium | Migrated medications are `external-record` with `unknown` adherence | `test/migration-load.test.ts` — "a migrated medication is external-record, never prescribed" |
| H-40 | Retention sweep ages out the chart | Operator thinks "retention" means the record | Allergies and meds gone; ops reports success | Catastrophic | Low | Retention is the message log only | `test/retention-boundary.test.ts` — "a retention sweep ages out the message log and leaves the record alone" |
| H-41 | Quality measure drops the untested from the denominator | "Assessable only" rate | The worst-managed patients vanish; the rate improves | Major | Medium | Unclassified stay in; rate is refused when it cannot stand | `test/registry.test.ts` — "patients nobody tested are in the denominator, not dropped from it" |
| H-42 | Store fault returned as HTTP 400 | `phi()` mapped every throw to 400 | A client gives up on a disk error it should have retried | Moderate | Low | `Refusal` vs fault: 4xx vs 500; outcome 4 vs 8 | `test/refusal.test.ts` — "a store refusal is 4xx the caller can read, and a fault is a 500 they cannot" |
| H-43 | Unauthenticated MLLP accepted as a person | The protocol has no authentication | Spurious ADT/results in the chart | Major | Medium | Network-layer control; frame cap; AE not crash | `test/mllp-limits.test.ts` — "hostile payloads are answered with an AE rather than taking the channel down" |
| H-44 | Database file readable off a stolen disk | `node:sqlite` cannot encrypt | The whole chart leaves with the disk | Catastrophic | Medium | Encrypted volume underneath; boot and health say when it is missing | `test/at-rest.test.ts` — "an unencrypted finding says what is at stake and how to correct it" |

---

## 5. Residual risks accepted in the product (not in a deployment)

These remain after every control above. A deploying organisation may reject
the product on the back of any of them. They are the honest-limits section
of the README, restated so a safety officer does not have to find them
twice.

| ID | Residual risk | Why it is accepted here | What a deployment must do |
|---|---|---|---|
| R-01 | This case has not been signed by an independent CSO | The repository can write the log; it cannot appoint the clinician | Name a CSO before go-live; treat this file as the manufacturer's draft |
| R-02 | No clinician UI | Backend first. A renderer that ignores `complete === false` reintroduces H-06 | Do not put an untested consumer in front of a prescriber |
| R-03 | No certified patient portal or enrolment flow | `GET /me` is static chrome; the OAuth/grant JSON boundary is mounted; identity proofing, notifications and accessibility validation are not | Do not call `/me` a portal or enrol a real patient without an approved proofing process |
| R-04 | Decision-support mechanism without content (H-20) | A partial table is more dangerous than a small one | Licence an interaction source, or accept that interactions are unchecked |
| R-05 | No machine learning | Section 7 asked; nothing here does it | Do not read any output as a prediction |
| R-06 | MLLP is unauthenticated (H-43) | The protocol has nothing to hook | VPN, private APN, or transport mTLS — not Portage |
| R-07 | Database file is not encrypted (H-44) | `node:sqlite` cannot | Encrypted volume; do not deploy if `/api/health` says the volume is not |
| R-08 | Single writer, one node | Scale is last on the roadmap | Size the site to one writer, or wait for #25 |
| R-09 | Migration loads, but does not extract | The declare-and-check loader exists (#20); getting data out of the incumbent is that vendor's export or a negotiation, and inventory, cutover scheduling and stabilisation are a plan a person writes | Do not treat a green reconciliation as a validated migration; read the sample against the source |
| R-18 | No vendor laboratory interface has exchanged a message | The ORU bridge is built and tested against synthetic messages; no Dynacare or LifeLabs sandbox has been connected | Do not present the generic profile as a vendor interface; obtain a conformance guide, sandbox, credentials and a signed test result |
| R-10 | Conformance packs are not certified | Fixtures are not a Projectathon | #23 before a claim of conformity |
| R-11 | Demo terminology pack | Licensed distributions are not shipped | Load a licensed release before coding decisions rest on it |
| R-12 | `node:sqlite` experimental on Node 22 | Durability rests on it | Node 24+ in production |
| R-13 | Sent is not told (H-26) | The last step is a letter, a call, a portal this system does not own | Record that the patient was actually told; review the undelivered queue |
| R-14 | Fail-closed organization withhold | A credential with no organization is treated as possibly inside the withheld clinic | Issue keys *with* an organization, or accept territorial withhold |
| R-15 | Linking two charts is a person's decision; `duplicates()` stays advisory (#34) | An algorithm that links on a shared name and birth date is H-05 with a reversibility feature — twins, and a father and son with one name between them, are exactly who it would join | Review the duplicates worklist; link on evidence somebody can weigh afterwards; unlink with a reason when it was wrong |
| R-16 | Remote backup unconfigured is a posture, not degraded | A missing replica is a choice | Configure `PORTAGE_BACKUP_REMOTE` or accept that RPO is the local disk |
| R-17 | Worklists only work if someone opens them (H-11, H-13, H-23, H-24) | The product can put a row on a list; it cannot make a person look | Staff the chase lists; do not treat an empty personal inbox as "nothing owed" |
| R-20 | A directive issued during an outage is enforced only after the next fill (#38) | The reading station evaluates the directives its snapshot carried; one recorded at the primary mid-outage cannot reach it. Bounded by the serving budget, past which the station serves nothing — the same trade a paper chart in the same nursing station makes today (H-84) | Set `PORTAGE_STATION_BUDGET_HOURS` to the window the custodian will accept; fill as often as the link allows; power a station down when a directive cannot wait |
| R-19 | After-hours uses UTC, not clinic-local time (H-76) | A single-zone engine; tests pin UTC timestamps | Do not staff the after-hours queue as if it were local clinic hours |

---

## 6. Narrative: why the residual risk is the one being taken

The product's clinical argument is not that it is safe. It is that the
failures it knows about fail *closed and visibly*, and that the failures it
does not know about are named as residual rather than implied to be absent.

The repeating shape is the same one: a quiet success that is actually a
miss. An empty allergy panel. A result already acknowledged. A feed that
has been silent since Tuesday. A backup that hashed the file it wrote and
never read it back. A directive that reports itself active and matches a
field nothing carries. Each control is a refusal to let that silence look
like an answer.

What a safety officer should not take from this file:

- that a site with no CSO, no licensed interaction source, no encrypted
  volume and no one reading the chase lists is safe because the tests pass
- that DCB0160 is done
- that #22 (an external pen test) is optional colour. The adversarial tests
  here share their author's model of an attack. The interesting findings
  are outside it.

What they can take:

- a catalogue of the hazards this codebase has already paid for
- a pointer from each to a test that fails if the control is removed
- a list of residual risks that are not hiding in a backlog

---

## 7. Related documents

- [README](../README.md) — honest limits, clinical modules, roadmap
- [RUNBOOK](RUNBOOK.md) — operate, upgrade, restore, when not to deploy
- [SECURITY](../SECURITY.md) — how to report a vulnerability
- Issues [#21](https://github.com/ThomasGenua/healthsystem/issues/21) (this
  document), [#22](https://github.com/ThomasGenua/healthsystem/issues/22)
  (external pen test)
