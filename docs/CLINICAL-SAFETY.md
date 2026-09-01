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

**Product:** Northstar (this repository).
**Version this case describes:** v0.7.0.
**Last reviewed:** 2026-08-28.
**Reviewer of this draft:** the author of the controls, not an independent
clinical safety officer. That gap is residual risk R-01.

---

## 1. What the system is for

Northstar is a health integration engine and a clinical store for a northern
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
- procedures and care plans on the clinical log, with empty meaning never-recorded / never-planned
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
| A validated clinician application | The console renders the chart and work queues through the ordinary API, but has not had independent clinical-usability, human-factors or accessibility validation. A consumer that ignores `complete === false` reintroduces H-06. |
| A patient application | `GET /me` is chrome (EN/FR, landmarks, an honest banner) and does not enrol anyone. Clinic attestation binds a subject after a named person writes how they checked; it is not identity-proofing, not ONE ID, not a certified portal. Notices publish fact onto a channel; dispatching is not telling. Accessibility validation is not claimed. Do not call `/me` a portal. |
| Broad medication decision-support *content* | The check is here; the licensed interaction table is not. An 80% complete table is one prescribers learn to trust. Procedure libraries and care-plan pathways are the same shape of content, and are not here. Deterministic published risk instruments are implemented separately and carry an explicit unreviewed assurance state. |
| Machine learning | Nothing in this repository uses a learned model. The deterministic risk instruments must not be described as machine learning or as individualized predictions beyond their stated populations. |
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
| H-88 | A station accepts a clinical write | The cache is a full node, so the write routes are present and would otherwise work | A second writable copy of the record diverges from the primary with no honest way to reconcile it afterwards | Catastrophic | Low | Every clinical write on a station is refused and audited, and the refusal names the feed queue and the paper form the write path already degrades to. Two shapes are deliberately not writes: break-glass, because a withheld chart mid-emergency with no way through is H-25, and the read-shaped checks (safety check, registry queries), because taking the allergy check away for the outage would be its own hazard. An offline override is copied into the database that survives the purge and replayed onto the primary at reconciliation, so the patient is still told | `test/reading-station.test.ts` — "a station refuses clinical writes, and says where to write instead"; `test/reading-station.test.ts` — "break-glass works offline, and the primary learns of it at reconciliation"; `test/reading-station.test.ts` — "the safety check still answers during an outage" |
| H-82 | Safety check consults one chart of a linked person — or reads past a directive | The check reads the named chart while the summary assembles across members; or unions a chart the caller's directive check refuses | The assembled chart shows a penicillin allergy the safety check calls clear; or the check becomes an ingredient-by-ingredient oracle over a withheld allergy list | Catastrophic | Low | Consent composes into the check as into the chart, member by member and section by section, the named patient included: a whole-record directive refuses with the break-glass path, a locked section stays out, and every gap is a blocking finding, never silence | `test/chart-links.test.ts` — "the safety check answers for the person the link asserts"; `test/chart-links.test.ts` — "a withheld member is not consulted by the safety check — and the check says so"; `test/chart-links.test.ts` — "the safety check is inside the lockbox, with the same emergency path"; `test/chart-links.test.ts` — "a scoped lock on a member locks that section of the check" |
| H-06 | Empty chart panel read as "none" | A store threw, a list was cut, a section was withheld — and the renderer shows a blank | Prescribe against an allergy list that failed to load | Catastrophic | Medium | Every section carries `complete` / incompleteness (`unavailable`, `truncated`, `withheld`) | `test/workspace.test.ts` — "a section that fails is empty and says why, rather than reading as none" |
| H-07 | Empty visit read as "nothing happened" | Failed section or missing encounter rendered blank | Handover misses the orders and results of the visit | Major | Medium | Visit assembly is honest; membership is by encounter, not a time window | `test/encounters.test.ts` — "the assembled visit says a section failed, rather than rendering as nothing happened" |
| H-45 | Empty immunization panel read as "none" | Never asked and documented-empty render the same | A child is assumed vaccinated when nobody asked | Major | Medium | `never-asked` is a status; a refusal needs a reason | `test/immunizations.test.ts` — "nobody asked and a documented history are different answers" |
| H-46 | Half a blood pressure filed as a vital | Systolic stored without diastolic | A trend and a dose are calculated from one number | Major | Low | Blood pressure refused unless both numbers arrive together | `test/vitals.test.ts` — "blood pressure needs both systolic and diastolic" |
| H-47 | Two current primary providers | A locum assigned as MRP without retiring the last | A result is routed to neither inbox | Major | Low | At most one current primary; retire before assigning another | `test/careteam.test.ts` — "a second current primary is refused until the first is retired" |
| H-48 | Coverage overwritten in place | Eligibility `UPDATE`d when the card changes | "Were they covered when this visit happened" is unanswerable | Major | Low | New row supersedes; the previous claim stays | `test/coverage.test.ts` — "a change of eligibility keeps the previous claim" |
| H-118 | Empty procedure panel read as "none" | Never recorded and documented-empty render the same | A procedure that was never asked about is read as not having happened | Major | Medium | `never-recorded` is a status; an empty panel is a gap, not an answer | `test/procedures.test.ts` — "an empty procedure panel is never-recorded, not none" |
| H-119 | A procedure is filed without the fact that makes it one | Completed with no date, or not-done with no reason | A later reader cannot tell a knee injection that happened from one nobody recorded | Major | Medium | Completed needs `performedAt`; not-done needs twelve characters of reason, the same bar as breaking glass | `test/procedures.test.ts` — "a completed procedure needs a date it was performed"; `test/procedures.test.ts` — "a procedure that was not done needs a written reason" |
| H-120 | A care plan without a review date never ends | `reviewBy` omitted or defaulted | The plan looks current because nobody is looking at it | Catastrophic | Medium | Recording refuses a missing or unparseable review date; it is stored as `reviewBy`, not faked as `period.end` | `test/careplans.test.ts` — "a care plan without a review date is refused, not defaulted" |
| H-121 | Completing a care plan without a written outcome | Status flipped to completed with a click | The next clinician cannot tell what was achieved from a plan that was abandoned | Major | Medium | Complete and revoke are amendments; complete needs twelve characters of outcome; revoke needs twelve of reason | `test/careplans.test.ts` — "completing a care plan needs a written outcome" |
| H-122 | A care plan past its review date is silent | Review date sits on the plan and on nobody's list | The annual diabetes review is a year late with nobody owed the look | Major | Medium | Active plans past `reviewBy` are a worklist section, service-wide like stalled referrals | `test/careplans.test.ts` — "a care plan past its review date is work, not a status" |
| H-123 | One custodian reads another's procedures or care plans | Query not tenant-bound | A procedure or plan from the north appears on a southern chart | Catastrophic | Low | Stores read the clinical log through the tenant-bound record; isolation is tested, not assumed | `test/procedures.test.ts` — "one custodian cannot read another's procedures"; `test/careplans.test.ts` — "one custodian cannot read another's care plans" |
| H-124 | Empty document panel read as "none" | Never received and documented-empty render the same | A letter the patient handed over is assumed not to exist | Major | Medium | `never-received` is a status; an empty panel is a gap, not an answer | `test/documents.test.ts` — "an empty document panel is never-received, not none" |
| H-125 | A patient-supplied document is treated as a clinical note | Same `DocumentReference` entry type, no discriminator | An unsigned "note" appears on the chart, or a lockbox on counselling notes hides — or fails to hide — a form the patient handed over | Catastrophic | Medium | Category `patient-supplied` is the discriminator; notes refuse those rows; visit assembly gives documents their own section | `test/documents.test.ts` — "a patient-supplied document is not a clinical note"; `test/documents.test.ts` — "a document brought to a visit is a visit section, not a note" |
| H-126 | HTML, SVG or an executable is stored as a document | Content type accepted because it arrived | A chart becomes a place to host a script, and a later renderer executes it | Catastrophic | Medium | Allowlist only; HTML, SVG and executables are refused; a payload over 256 KiB is refused | `test/documents.test.ts` — "an executable or HTML file is not a document"; `test/documents.test.ts` — "a document larger than the cap is refused" |
| H-127 | One custodian reads another's patient-supplied documents | Query not tenant-bound | A letter from the north appears on a southern chart | Catastrophic | Low | Store reads the clinical log through the tenant-bound record; isolation is tested, not assumed | `test/documents.test.ts` — "one custodian cannot read another's patient-supplied documents" |
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
| H-89 | A small cell in a released count is a name | Registry numbers leave for QI, evaluation or research with patient-level rows or tiny aggregates | "3 of 41 uncontrolled" identifies people to anyone who knows a community of 300 | Major | Medium | Releases are aggregate-only with no identifiers; counts from 1 to threshold-1 are suppressed (threshold 5, floor 2, refused below); zero publishes; the method is on the face of the document | `test/release.test.ts` — "a small cell is suppressed, and zero is published"; `test/release.test.ts` — "no patient identifier appears anywhere in a release" |
| H-90 | A published total un-suppresses a cell by subtraction | The complement of a suppressed count is released beside its total, or a rate divides the secret back out | "38 of 41 controlled" hands back the 3 it suppressed | Major | Medium | Complementary suppression: the complement of a suppressed cell is suppressed with it, split halves protect each other under a published total, and a rate over a suppressed numerator is withheld | `test/release.test.ts` — "38 of 41 is as identifying as 3 of 41: the complement is suppressed too"; `test/release.test.ts` — "a rate that would undo the suppression is suppressed with it"; `test/release.test.ts` — "halves of a suppressed total are suppressed with it" |
| H-91 | A prescription nobody collected reads as a medication the patient takes | The chart shows the prescription; nothing shows that it is still on a pharmacy shelf | A prescriber titrates, adds or stops around a drug the patient never started | Major | High | A dispense is its own recorded fact, and `dispenseState()` separates dispensed, partially dispensed, not collected and awaiting; `neverCollected()` lists the silences worth chasing | `test/prescribe.test.ts` — "a prescription nobody has collected is not a prescription the patient is taking"; `test/prescribe.test.ts` — "a partial fill is not a full one, and the last word wins" |
| H-92 | An absent dispense is read as evidence the patient did not collect | Most pharmacies send no dispense notification, so silence is the normal case | "Never collected" against every prescription sent to a quiet pharmacy; the clinician learns to ignore the list, and misses the real ones | Moderate | High | Dispense reporting is declared per pharmacy and snapshotted onto the prescription at transmission; without a declaration the state is `unknown`, and `neverCollected()` is confined to pharmacies that would have spoken | `test/prescribe.test.ts` — "silence from a pharmacy that does not report is unknown, never 'not collected'"; `test/prescribe.test.ts` — "the reporting declaration is snapshotted at transmission, not read later" |
| H-93 | A cancelled prescription is dispensed and nobody knows | The cancellation reached the pharmacy late, or not at all | A drug somebody stopped is handed to the patient, who takes it | Catastrophic | Low | The dispense is recorded rather than refused — refusing would delete the evidence — flagged on the prescription's history and listed by `dispensedAfterCancellation()` | `test/prescribe.test.ts` — "a dispense against a cancelled prescription is recorded and surfaced, never refused" |
| H-94 | A pharmacist assumes a safety check was run and clear | The transmitted script carried no record of what the prescriber's check saw | The second check that exists to catch the first one's misses is not made | Major | Medium | The check travels with the script — allergy status, every finding, and anything signed past with its reason — and its absence is transmitted as null, never as clear | `test/prescribe.test.ts` — "the safety check the prescriber saw travels with the script"; `test/prescribe.test.ts` — "a prescription written without a check being handed in still carries one"; `test/prescribe.test.ts` — "a prescription written before this existed transmits null, not a fabricated all-clear" |
| H-95 | A renewal request is lost between the pharmacy and the prescriber | It arrives as a fax, an email or a note in a queue nobody owns | The patient runs out of a medication nobody decided to stop | Major | Medium | A renewal is an item in the unified worklist, correlated to the prescription so repeat requests are visible as a pattern, and closable only with evidence of what was decided | `test/prescribe.test.ts` — "a pharmacy asking for a repeat becomes work somebody owns"; `test/prescribe.test.ts` — "repeat requests for one script are one thread, so a pattern is visible" |
| H-96 | A migration is rehearsed against a validator that has drifted from the loader | A separate check approves records the real load would refuse, or refuses ones it would take | The mapping errors a rehearsal exists to find are found at cutover instead, with clinicians waiting | Moderate | Medium | The dry run *is* the loader: records go through the ordinary stores inside a transaction that is always rolled back, so a rehearsal cannot approve what a load would reject, and nothing it wrote survives to make the real run report "unchanged" | `test/migration-load.test.ts` — "a dry run finds the rejections a real run would, because it uses the real stores"; `test/migration-load.test.ts` — "a rehearsal leaves the real run free to use the same source ids" |
| H-97 | An extract reader silently skips what it does not understand | A resource type the reader does not map, a line that will not parse, or a record with no source key is dropped on the way in | The run reconciles cleanly against a number nobody chose, and the records never arrive — the chart is short and looks complete | Major | High | Nothing is skipped: an unmappable resource is returned in `unreadable` with its reason and the resource itself, a resource the reader maps but the stores refuse reaches the reject queue with its payload, and the declaration comes from the bundle's own `total` rather than from what arrived | `test/migration-read.test.ts` — "a resource the reader does not understand is reported, never skipped"; `test/migration-read.test.ts` — "a resource the reader maps but the stores refuse becomes a rejection with its payload"; `test/migration-read.test.ts` — "the bundle's own total is the declaration, and its absence is reported as absence" |
| H-98 | A value set imports partially and is trusted as complete | A FHIR ValueSet defined by a filter ("every descendant of X") has its enumerated concepts imported and its filter ignored | The value set carries the publisher's name and a smaller membership; every check against it silently passes or fails wrongly, and no error is raised anywhere | Major | Medium | An intensional definition, a grouped expansion, a reference to another value set, a whole-code-system include or any exclusion refuses the **whole** import by name, saying that a server-produced expansion is the supported path; a server expansion is preferred over the definition when present | `test/terminology-valuesets.test.ts` — "a value set defined by a filter is refused, not partially imported"; `test/terminology-valuesets.test.ts` — "an exclusion refuses the value set rather than being approximated"; `test/terminology-valuesets.test.ts` — "a grouped expansion is refused rather than flattened" |
| H-99 | A conformance claim outlives what the packs enforce | The README states coverage a rule change has since moved past, or implies a certification nobody obtained | A deployment relies on a profile check that is weaker than advertised, or a health authority is told the packs conform when no projectathon has scored them | Moderate | Medium | The README's per-pack table is checked against the packs themselves — enforced profiles, rule counts, and the "scored against Projectathon scripts" column — and the build fails when a claim drifts | `test/conformance.test.ts` — "the README's conformance table says what the packs actually enforce" |
| H-100 | A risk score computed from missing data reads as low risk | A criterion whose value was never measured is scored as absent, so an unassessed patient scores lower than an assessed one | The instrument recommends discharge for a patient nobody finished working up — the score is most reassuring exactly where least is known | Catastrophic | High | A score with any missing input returns `{complete: false, missing}` with **no score field**: there is no number to render. A criterion may be stated present or absent, and only an unstated one refuses | `test/scores.test.ts` — "a missing input yields no score at all, not a lower one"; `test/scores.test.ts` — "absent is a value; unknown is not"; `test/scores.test.ts` — "every score refuses an empty submission rather than returning zero" |
| H-101 | A deranged single parameter is hidden by a reassuring total | An aggregate early-warning score averages away one profoundly abnormal axis | A bradycardic or hypotensive patient scores in the routine-monitoring band and is not reviewed | Major | Medium | NEWS2 escalates to `low-medium` whenever any single parameter scores 3, independently of the aggregate, and says so in the interpretation | `test/scores.test.ts` — "NEWS2 escalates on a single deranged parameter even when the total is low" |
| H-102 | A score is read as an instruction | A number and a band are presented without the instrument's own meaning, or with an imperative | A clinician defers to arithmetic over the patient in front of them; a high bleeding score stops anticoagulation that was indicated | Major | Medium | Every result carries the published interpretation rather than a directive, HAS-BLED states in words that it is not a reason to withhold anticoagulation, and the module states it is decision support and not a certified device | `test/scores.test.ts` — "HAS-BLED reads as a prompt about modifiable risk, not a veto"; `test/scores.test.ts` — "a completed score shows its working" |
| H-103 | A laboratory interface is believed conformant on the strength of a sample run | A clean pass over sample messages is read as a conformance statement, or field locations are inferred from what a sample happened to contain | An interface goes live having never been tested on a corrected result or a resend; results misfile or duplicate against a profile nobody verified | Major | Medium | The conformance report always states what it does not establish — that it is not a conformance statement, that a sample exercises only what it contains, and that nothing was inferred into a profile — and a named profile that is absent is an error rather than a silent fall back to the generic reading | `test/lab-conformance.test.ts` — "the report never says the interface conforms"; `test/lab-conformance.test.ts` — "a vendor profile drops the generic-reading caveat but keeps the rest" |
| H-104 | A risk score is computed from stale observations and read as current | The most recent vitals are assembled into an early-warning score hours after they were taken | The score is a complete set of real measurements describing the patient as they were this morning, rendering as confidently as one taken now — and the deterioration it exists to catch is the change since | Catastrophic | High | Every chart-sourced input carries a maximum age set by the instrument's clinical question (NEWS2 4h, CURB-65 12h); a value past its window is not used and the score refuses, and every score reports the age of its stalest input | `test/score-from-chart.test.ts` — "a stale set of vitals refuses, rather than scoring a patient from this morning"; `test/score-from-chart.test.ts` — "the freshness window is the instrument's clinical question, not one number"; `test/score-from-chart.test.ts` — "the score is only as current as its stalest input" |
| H-105 | An input the chart does not hold is defaulted to the reassuring value | Supplemental oxygen defaults to air and consciousness defaults to alert, because both are the common case | A patient on oxygen scores two points lower and an unresponsive one three points lower, on the instrument that exists to escalate exactly them | Catastrophic | Medium | Neither is defaulted: both are reported as unavailable with the size of the understatement, the caller supplies them or the score refuses | `test/score-from-chart.test.ts` — "supplemental oxygen is never assumed, because the assumption understates"; `test/score-from-chart.test.ts` — "consciousness is never assumed either" |
| H-108 | A score cannot be reconstructed after its implementation changes | The response carries a number but not the source, formula version or inputs that produced it | A later review applies today's thresholds to yesterday's number and cannot tell whether the recorded decision followed the formula then in use | Major | Medium | Complete and incomplete results carry the governed definition, Northstar implementation version, calculation time and a copied input snapshot; source-linked vectors require one definition per scorer | `test/score-provenance.test.ts` — "every score has one governed definition and one source-linked golden vector"; `test/score-provenance.test.ts` — "an incomplete calculation still identifies its definition and preserves the supplied evidence" |
| H-109 | Correct arithmetic is used in the wrong population or units | A caller supplies bilirubin in µmol/L to an mg/dL threshold, uses NEWS2 in pregnancy, or treats a score derived in one setting as universal | A confident high or low band is produced from values the instrument does not mean | Catastrophic | Medium | Every result carries intended population, exclusions and required units; the assurance state says implementation-tested rather than independently clinically validated, with no invented owner or review date | `test/score-provenance.test.ts` — "every score has one governed definition and one source-linked golden vector"; `test/score-provenance.test.ts` — "source-linked golden vectors reproduce their governed scores" |
| H-110 | A historical or partial instrument is presented as the current full one | The 2016 MELD-Na allocation formula is called current MELD, or NEWS2 Scale 1 is offered where Scale 2 is prescribed | Transplant priority or deterioration response is based on a different instrument while the label looks authoritative | Catastrophic | Medium | The governed version names the exact variant and the response carries its exclusions: MELD-Na says historical 2016 and not MELD 3.0; NEWS2 says Scale 1 only | `test/score-provenance.test.ts` — "MELD-Na says that it is the historical 2016 formula, not current MELD 3.0"; `test/score-provenance.test.ts` — "NEWS2 says that only Scale 1 is implemented" |
| H-106 | The not-on-care-team flag never fires on real traffic | The review joined `principal_id` and required `principal_kind = practitioner`, but an HTTP audit row carries the credential on `principal_id` (kind apikey or oauth) and the clinician on `practitioner_id` | Every access through the API is skipped, so a clinician reading a chart they have no part in is never flagged — and the review reports a clean period because it examined nothing | Major | High | The join is on `practitioner_id`, the identity `AccessReview` already uses; a credential naming no practitioner is excluded, because it cannot be on a team | `test/privacy-office.test.ts` — "staff not on the care team are flagged, and an empty team is not" |
| H-107 | A disclosure outlives the request it answered | `fulfillAccess` recorded the disclosure and completed the request as two independent writes | A failure between them leaves the ledger saying the chart went out while the queue says nobody answered, and a retry records a second disclosure for one release | Moderate | Low | Both writes share one transaction, so a failed completion rolls the disclosure back | `test/privacy-office.test.ts` — "a failed fulfill leaves neither a disclosure nor a half-closed request" |
| H-108 | A rename opens an empty database beside the real one | The engine is upgraded to a build that looks for `northstar.db` in a data directory holding `portage.db` | SQLite creates what it cannot open, so the site boots clean and reports healthy with no patients in it; the clinician's first clue is a chart that has never existed | Catastrophic | Medium | An existing database always wins over the preferred filename, and opening one under its pre-rename name is announced at boot; renaming the file is a documented operator step taken with the engine stopped, never on a running boot | `test/rename-compat.test.ts` — "an existing portage.db is opened, not shadowed by an empty new one"; `test/rename-compat.test.ts` — "a fresh install gets the new name" |
| H-109 | A rename makes every existing backup invisible | The snapshot lister matches a filename prefix that changed with the product name | The restore tool reports nothing to restore, and the reading-station freshness check reports no recent backup, for a site whose snapshots are sitting in the directory | Catastrophic | Medium | Every read path matches both prefixes, and snapshots are ordered by the stamp their names carry rather than by filename — a plain sort places the new prefix before the old one and inverts the ordering | `test/rename-compat.test.ts` — "snapshots taken under the old name are still found"; `test/rename-compat.test.ts` — "retention deletes the oldest across both prefixes, not the newest"; `test/rename-compat.test.ts` — "the newest snapshot is the newest one, whichever name it carries" |
| H-110 | A rename silently downgrades a site's security posture | Configuration is read only under the new variable names, so `PORTAGE_TLS_KEY`, `PORTAGE_ENCRYPTED_AT_REST` and `PORTAGE_OIDC_ISSUER` go absent rather than erroring | Absent does not fail — it defaults: TLS off, encryption unasserted, authentication unconfigured, on a site that believed it had configured all three | Catastrophic | Medium | Both spellings are read on every variable, the current one winning where both are set, and the legacy names still in use are listed once at boot | `test/rename-compat.test.ts` — "a deployment still on PORTAGE_* keeps every value it configured"; `test/rename-compat.test.ts` — "the new name wins where both are set, so migration can go one at a time" |
| H-111 | A renamed claim makes a tenancy decision on an absence | The identity provider asserts `portage_tenant` and the verifier reads only `northstar_tenant` | The claim is not found rather than rejected, so a token that carried a tenant arrives carrying none and every downstream check decides tenancy on an absence — the failure ends with one site reading another's charts | Catastrophic | Medium | All three spellings are accepted in precedence order, and the pre-rename names are not scheduled for removal: the claim name lives in an identity provider this repository does not control | `test/rename-compat.test.ts` — "a token asserting portage_tenant still resolves to that tenant" |
| H-112 | A rename silences an alert rather than breaking it | A Prometheus series or an operator scope is renamed with the product | A renamed metric evaluates against no data, so the rule watching a dead-letter backlog never fires again; a renamed scope demotes an operator to 403s nobody can explain | Major | Medium | Every series is exposed under both prefixes and both admin scopes are accepted, until dashboards and identity-provider configuration have been moved by hand | `test/health.test.ts` — "metrics are exposed in Prometheus text format"; `test/rename-compat.test.ts` — "an operator token carrying portage/admin is still an operator" |
| H-113 | A rename changes what goes out on the wire | MSH-3 on outbound acknowledgements is updated to match the new product name | The receiving application name no longer matches what each sending facility configured at their end; their engine rejects the acknowledgements, visible to them as unacknowledged messages and not visible here at all | Major | Medium | MSH-3 keeps its original value by default and moves only when a deployment sets `NORTHSTAR_HL7_APPLICATION`, which is a change agreed with the sites on the other end | `test/rename-compat.test.ts` — "the rename does not touch what goes out on the wire"; `test/rename-compat.test.ts` — "a deployment that has agreed the change with its partners can move it" |
| H-114 | A subject is bound without a written method of verification | `grantSelf` / HTTP authority-self accepts a patient and a subject and writes a live grant | The wrong OAuth account reads the chart for years; nothing on the record says how anyone checked | Catastrophic | Medium | Attestation refuses a method shorter than twelve characters, the same bar as breaking glass; HTTP `authority-self` and `authority-proxy` require `method` and go through enrolment | `test/patient-enrolment.test.ts` — "attesting enrolment needs a written method of verification, not a word" |
| H-115 | A pending enrolment is treated as authority | The queue row is read as a grant | An account nobody checked can call `/patient/*` | Catastrophic | Medium | `may()` consults `patient_authority` only; a pending enrolment does not insert a grant; `GET /me` and `/patient/enrol` bind nobody | `test/patient-enrolment.test.ts` — "enrolment does not bind a subject without attestation"; `test/patient-ui.test.ts` — "GET /me still does not enrol anyone" |
| H-116 | A patient notice carries a result value | The payload includes what the chart says while announcing that something happened | A courtesy message is a disclosure | Catastrophic | Medium | The payload is `{type, kind, noticeId, patientId, aboutId, summary}` — the fact, never a result field; completing a request queues a summary that names the request, not the chart | `test/patient-enrolment.test.ts` — "a patient notice is published as fact, not the record" |
| H-117 | Dispatching a patient notice is recorded as the patient having been told | Status flips to `told` when the message is handed to the channel | A privacy office closes the duty because a queue drained; the letter never arrived | Major | Medium | Dispatch and `markTold` are separate; a missing channel is `failed` with an error, not a silent skip; the Privacy tab lists undelivered and untold | `test/patient-enrolment.test.ts` — "dispatching a patient notice does not mark the patient told"; `test/patient-enrolment.test.ts` — "a patient notice that cannot be sent is a visible failure, not a silent one" |
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
| R-02 | Clinician console not independently validated | The console makes completeness visible, but repository tests are not a clinical-usability, human-factors or accessibility study | Do not put the console in front of a prescriber until the named deployment validates the workflow and failure states |
| R-03 | No certified patient portal or identity-proofing | `GET /me` is static chrome and does not enrol anyone; clinic attestation binds a subject after a named person writes how they checked; notices publish fact onto a channel and dispatching is not telling; identity proofing, ONE ID, WCAG/AODA and a certified portal are not | Do not call `/me` a portal; do not treat clinic attestation as remote proofing; review the undelivered and untold queues |
| R-04 | Decision-support mechanism without content (H-20) | A partial table is more dangerous than a small one; deterministic risk scores are a separate governed catalogue | Licence an interaction source, or accept that interactions are unchecked |
| R-05 | No machine learning | Section 7 asked; nothing here does it | Do not read any output as a prediction |
| R-06 | MLLP is unauthenticated (H-43) | The protocol has nothing to hook | VPN, private APN, or transport mTLS — not Northstar |
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
| R-16 | Remote backup unconfigured is a posture, not degraded | A missing replica is a choice | Configure `NORTHSTAR_BACKUP_REMOTE` or accept that RPO is the local disk |
| R-17 | Worklists only work if someone opens them (H-11, H-13, H-23, H-24) | The product can put a row on a list; it cannot make a person look | Staff the chase lists; do not treat an empty personal inbox as "nothing owed" |
| R-20 | A directive issued during an outage is enforced only after the next fill (#38) | The reading station evaluates the directives its snapshot carried; one recorded at the primary mid-outage cannot reach it. Bounded by the serving budget, past which the station serves nothing — the same trade a paper chart in the same nursing station makes today (H-84) | Set `NORTHSTAR_STATION_BUDGET_HOURS` to the window the custodian will accept; fill as often as the link allows; power a station down when a directive cannot wait |
| R-19 | After-hours uses UTC, not clinic-local time (H-76) | A single-zone engine; tests pin UTC timestamps | Do not staff the after-hours queue as if it were local clinic hours |
| R-21 | Risk-score implementations have no independent clinical sign-off | Golden vectors and source citations verify the code against its declared reading; they do not appoint a clinical owner or validate use in a deployment's population | Name a clinical owner, review licensing and current steward guidance, validate every enabled instrument and record review/review-due dates before clinical use |

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
