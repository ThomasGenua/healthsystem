# Provincial primary-care platform — what exists and what does not

This is a map of the 23-section provincial EMR specification against this
repository. It is not a bid response and it is not a claim that Portage is
that platform. Portage is a health integration engine with a growing clinical
record. The specification is the destination; this file is the honest
distance.

The architectural principle the specification ends on is already the
product's: **the system must be safe and useful without AI.** Deterministic
workflows, authorization and human accountability are authoritative. Nothing
in this repository uses machine learning, and no output should be read as
though it did.

## Immediate priorities

| # | Priority | Status |
|---|---|---|
| 1 | Patient, encounter, task, note and audit models | Present |
| 2 | Authorization and tenant isolation | Present |
| 3 | Longitudinal chart and documentation | **This increment:** demographics, immunizations, vitals, care team, coverage, today's appointments on the worklist. Problems, notes, meds, allergies, orders, results, referrals, consent were already here. Documentation is SOAP/templates as structured notes, not a full specialty-template library. |
| 4 | Durable inbox, task and referral workflows | Present |
| 5 | Scheduling and patient messaging | Scheduling is present. **Patient messaging is present as a durable clinic record** (threads, inbox, close-with-reason). Not a portal, not email, not a claim that anything was delivered. |
| 6 | FHIR integration service | Present (R4 facade, mappings, subscriptions) |
| 7 | Laboratory and provincial-system sandboxes | **Inbound result bridge present, vendor interfaces absent.** An ORU^R01 closes the order it answers, deduplicates retransmissions, supersedes on correction, ignores stale preliminaries and holds unidentifiable results for a person. Dialects are configuration (`labs/`). **No Dynacare, LifeLabs, OLIS, DHDR, HRM, eConsult or ONE ID interface has exchanged a message**, and none is claimed — that needs a conformance guide, a sandbox, credentials and a signed test result. |
| 8 | Medication and result management | Present. Pharmacy transmission ([#40](https://github.com/ThomasGenua/healthsystem/issues/40)) is done as a lifecycle: draft / transmitted / acknowledged / handed-out / failed / cancelled, with a refusal on double transmission and chase lists for each way it is lost. **No pharmacy network interface has exchanged a message** — the transmission publishes onto a channel a deployment configures. |
| 9 | Patient access | **Backend boundary present.** `/patient/*` is OAuth-only; every chart is bound through an active grant with explicit proxy scope, purpose and expiry. Patient-safe summary, held results, appointments, messages, delegates, access log, access/correction requests. No patient application, enrolment/identity proofing, French parity, notifications or accessibility claim. |
| 10 | Population-health reporting | Partial (cohorts, gaps, measures). Equity, outreach campaigns and burden measures are not. |
| 11 | Privacy, security and assurance operations | Partial (directives, break-glass, audit chain, auth). No assurance centre, PIA tracker, subprocessor register or SIEM product. |
| 12 | Source-linked AI assistance | **Deliberately later.** |
| 13 | Migration tooling | **Loader present** ([#20](https://github.com/ThomasGenua/healthsystem/issues/20)): trial/cutover/delta runs, idempotent on source identity, declared-then-checked completeness, rejects with payloads, source-code provenance, validation samples, constrained rollback. **Not an extractor** — getting data out of the incumbent is that vendor's export. Inventory, cutover scheduling and stabilisation are a plan, not code. |
| 14 | Accessibility, security and clinical-safety testing | Safety case: [CLINICAL-SAFETY.md](CLINICAL-SAFETY.md). WCAG/AODA and an external pentest ([#22](https://github.com/ThomasGenua/healthsystem/issues/22)) need people. |
| 15 | Controlled clinical pilot | Later. This is not a clinician-usable product today. |

## Specification sections

| § | Ask | What is here | What is not |
|---|---|---|---|
| 1 | Complete longitudinal chart | Append-only log; demographics (incl. language/telecom); coverage/eligibility history; care team; problems; allergies; meds; immunizations; vitals; results; encounters; notes; referrals; consent; provenance and amendment | Procedures/care plans as first-class stores; patient-uploaded documents; substitute decision-makers beyond proxy grants; specialty coding libraries |
| 2 | Clinician workspace | Assembled chart + worklist: today's appointments, results, referrals, tasks, overdue orders, incomplete reconciliations. Queues ordered by urgency/abnormality, not arrival | Waiting-room board, care-gap queue, recently discharged, high-risk follow-up, delegated-workload view, configurable ranking across all item kinds |
| 3 | Documentation | Draft / revise / sign / co-sign / addendum; SOAP and free sections; encounter-scoped notes | Voice dictation, macros, collaborative drafting, billing codes, patient-friendly AVS, PDF export |
| 4 | Orders and results | Order → result → acknowledge; critical clocks; correction does not inherit ack; unsolicited matching; inbound ORU bridge with deduplication, identity holds and a reconciliation report | Electronic requisitions *out* to a laboratory; a proven Dynacare/LifeLabs interface; trend UI; automatic patient notification |
| 5 | Medications | Current vs prescribed; allergy/interaction check; reconciliation; override with record; prescription transmission lifecycle with double-dispense refusal, controlled-substance safeguard and chase lists | A pharmacy network interface that has actually exchanged a message; formulary/coverage; dosage calculators; renewal request workflow |
| 6 | Clinical decision support | Mechanism for meds only; never-asked ≠ none | Preventive-care rules, chronic-disease guidelines, duplicate-test CDS, renal dosing, configurable alert fatigue controls |
| 7 | AI | Nothing | All of it, by design, until governance exists |
| 8 | Inbox and tasks | Unified stores; evidence to close; unassigned list; escalation/deadline on referrals and results; patient-message threads on the worklist | Forms, privacy-request and portal-submission queues as first-class item kinds |
| 9 | Referrals | Closed-loop statuses, stalled chase, redirect with correlation, required documents | Specialist directory beyond the local one; eReferral/eConsult networks; wait-time reporting product |
| 10 | Scheduling | Slots, bookings, DNA follow-up, diary, today's list | Online booking, reminders, rooms/resources, waitlists, group visits, clinic status board |
| 11 | Patient and caregiver access | Separate patient/proxy OAuth API; explicit delegated scope/purpose/expiry; result release/visible holds; appointments; durable messages; access log; delegate review/revoke; access and correction requests | Patient application; identity-proofing enrolment; EN/FR parity; caregiver UX; document downloads; delivery to a phone or inbox the patient owns |
| 12 | Population health | Cohort, gap, measure with honest denominators | Outreach campaigns, equity stratification, burden measures, governed exports |
| 13 | Multi-tenant provincial architecture | Tenant isolation, shared schema, no per-clinic fork | Provincial config baseline overlays, feature flags, conformance monitoring, tenant rollback product |
| 14 | Interoperability | HL7 v2, FHIR R4, REST, OAuth/SMART, mTLS, idempotent delivery, DLQ | ONE ID, OLIS, DHDR, HRM, eConsult, pharmacy networks, contract-test harness for those |
| 15 | Migration and portability | Backup/restore; FHIR/HL7 ingest; trial/delta/cutover runs; declared-then-checked completeness; reject queue with payloads; preserved source codes; validation samples; rollback constrained by clinical activity | Extraction from incumbent systems; a mapping workbench; source-system inventory; a customer-facing bulk export product at contract termination |
| 16 | Privacy operations | Directives, break-glass, disclosure-ish audit, access log | SAR/correction workflows, complaint/incident products, PIA, legal hold, de-identification |
| 17 | Security | API keys, OAuth, scopes, tenant auth, audit chain, at-rest volume check, remote backup | ONE ID, phishing-resistant MFA, PAM, Canadian KMS product, SBOM/pen-test programme |
| 18 | Audit and assurance centre | Hash-chained access trail | Certification/finding/remediation tracker, DR-exercise log, vendor reviews |
| 19 | Provincial administration | Tenant create/suspend in the store | Ontario Health operator console, release cohorts, terminology governance UI |
| 20 | Accessibility and language | Not demonstrated | WCAG 2.1 AA, AODA, EN/FR parity, accessible PDFs |
| 21 | Reliability | Single-node SQLite, verified backup, rehearsed restore, instance lock | 99.8% multi-region, horizontal scale ([#25](https://github.com/ThomasGenua/healthsystem/issues/25)), synthetic transactions as a product |
| 22 | Roadmap | See README. Phases 0–5 in the specification are a procurement timeline, not a commitment this file can make. | |
| 23 | Immediate priorities | The table above. | |

## What a real vendor interface still needs

The ORU bridge is built and tested against synthetic messages. Turning it into
a *Dynacare* or *LifeLabs* interface is not a coding task, and the remaining
work cannot be done from inside this repository:

1. The vendor's HL7 conformance guide, which is what a profile in `labs/` is
   written from — field locations, assigning authorities, timezone, accession
   format.
2. A sandbox endpoint, and network access to it.
3. Credentials, and a mutual-TLS or VPN path.
4. A connectivity and conformance test executed **with the vendor**, producing
   a signed result. That signed result is the procurement evidence; a passing
   local test suite is not.
5. The same again per provincial service: ONE ID, OLIS, DHDR, HRM, eConsult.

Until each of those exists for a given vendor, `generic-oru` is the honest
configuration and the reconciliation report says what it had to assume.

## What this increment added

**Laboratory result bridge.** An inbound ORU^R01 now closes the order it
answers rather than only landing on the FHIR facade. Identity is by identifier
only; an unidentifiable or ambiguous result is held for a person. A
retransmission writes nothing, a correction supersedes and arrives
unacknowledged, a stale preliminary is ignored, and an unrecognised status or
flag is refused rather than defaulted. Timestamps with no zone are recorded as
assumed. Dialects are configuration in `labs/`; a destination naming a profile
that does not resolve fails rather than silently reading as generic.

**Patient access boundary.** SMART `patient/*` is no longer general FHIR
read; it reaches only `/patient/*`. An OAuth subject still needs a live
authority grant for the named chart and the exact capability. Proxy scope,
purpose and expiry are explicit. Patient-safe summary, held results,
appointments, messages, access log, delegate review/revoke and durable
access/correction requests are mounted. An access/correction request is also
a privacy task on the clinic's unassigned inbox.

The JSON API is not a patient application. Identity-proofing enrolment,
English/French UX, notifications and accessibility testing remain.

The previous slice (immunizations, vitals, care team, coverage, today's
appointments) is already on `main`.

## What must not be read into a demo

- A complete provincial EMR
- A Dynacare or LifeLabs interface (the ORU bridge exists; no vendor message has ever been exchanged)
- A patient portal application (the patient/proxy JSON boundary exists)
- AI drafting or summarization
- Certified Ontario profiles or ONE ID
- 99.8% multi-region availability
