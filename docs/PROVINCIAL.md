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
| 5 | Scheduling and patient messaging | Scheduling is present. **Patient messaging is not.** |
| 6 | FHIR integration service | Present (R4 facade, mappings, subscriptions) |
| 7 | Laboratory and provincial-system sandboxes | **Not present.** No Dynacare, LifeLabs, OLIS, DHDR, HRM, eConsult or ONE ID interface is claimed. |
| 8 | Medication and result management | Present in-store. Pharmacy transmission is [#40](https://github.com/ThomasGenua/healthsystem/issues/40). |
| 9 | Patient access | Store built (`src/patient/access.ts`). **Not mounted.** [#24](https://github.com/ThomasGenua/healthsystem/issues/24). |
| 10 | Population-health reporting | Partial (cohorts, gaps, measures). Equity, outreach campaigns and burden measures are not. |
| 11 | Privacy, security and assurance operations | Partial (directives, break-glass, audit chain, auth). No assurance centre, PIA tracker, subprocessor register or SIEM product. |
| 12 | Source-linked AI assistance | **Deliberately later.** |
| 13 | Migration tooling | [#20](https://github.com/ThomasGenua/healthsystem/issues/20). Not started. |
| 14 | Accessibility, security and clinical-safety testing | Safety case: [CLINICAL-SAFETY.md](CLINICAL-SAFETY.md). WCAG/AODA and an external pentest ([#22](https://github.com/ThomasGenua/healthsystem/issues/22)) need people. |
| 15 | Controlled clinical pilot | Later. This is not a clinician-usable product today. |

## Specification sections

| § | Ask | What is here | What is not |
|---|---|---|---|
| 1 | Complete longitudinal chart | Append-only log; demographics (incl. language/telecom); coverage/eligibility history; care team; problems; allergies; meds; immunizations; vitals; results; encounters; notes; referrals; consent; provenance and amendment | Procedures/care plans as first-class stores; patient-uploaded documents; substitute decision-makers beyond proxy grants; specialty coding libraries |
| 2 | Clinician workspace | Assembled chart + worklist: today's appointments, results, referrals, tasks, overdue orders, incomplete reconciliations. Queues ordered by urgency/abnormality, not arrival | Waiting-room board, care-gap queue, recently discharged, high-risk follow-up, delegated-workload view, configurable ranking across all item kinds |
| 3 | Documentation | Draft / revise / sign / co-sign / addendum; SOAP and free sections; encounter-scoped notes | Voice dictation, macros, collaborative drafting, billing codes, patient-friendly AVS, PDF export |
| 4 | Orders and results | Order → result → acknowledge; critical clocks; correction does not inherit ack; unsolicited matching | Electronic requisitions to named labs; Dynacare/LifeLabs; trend UI; portal release rules; automatic patient notification |
| 5 | Medications | Current vs prescribed; allergy/interaction check; reconciliation; override with record | e-prescribing to a pharmacy; formulary/coverage; controlled-substance workflow; dosage calculators |
| 6 | Clinical decision support | Mechanism for meds only; never-asked ≠ none | Preventive-care rules, chronic-disease guidelines, duplicate-test CDS, renal dosing, configurable alert fatigue controls |
| 7 | AI | Nothing | All of it, by design, until governance exists |
| 8 | Inbox and tasks | Unified stores; evidence to close; unassigned list; escalation/deadline on referrals and results | Forms, privacy-request and portal-submission queues as first-class item kinds |
| 9 | Referrals | Closed-loop statuses, stalled chase, redirect with correlation, required documents | Specialist directory beyond the local one; eReferral/eConsult networks; wait-time reporting product |
| 10 | Scheduling | Slots, bookings, DNA follow-up, diary, today's list | Online booking, reminders, rooms/resources, waitlists, group visits, clinic status board |
| 11 | Patient and caregiver access | Proxy grants with expiry; result holds; consent | Mounted portal; EN/FR parity; caregiver UX; correction requests |
| 12 | Population health | Cohort, gap, measure with honest denominators | Outreach campaigns, equity stratification, burden measures, governed exports |
| 13 | Multi-tenant provincial architecture | Tenant isolation, shared schema, no per-clinic fork | Provincial config baseline overlays, feature flags, conformance monitoring, tenant rollback product |
| 14 | Interoperability | HL7 v2, FHIR R4, REST, OAuth/SMART, mTLS, idempotent delivery, DLQ | ONE ID, OLIS, DHDR, HRM, eConsult, pharmacy networks, contract-test harness for those |
| 15 | Migration and portability | Backup/restore; FHIR/HL7 ingest | Source inventory, mapping workbench, trial/delta/cutover, customer export product |
| 16 | Privacy operations | Directives, break-glass, disclosure-ish audit, access log | SAR/correction workflows, complaint/incident products, PIA, legal hold, de-identification |
| 17 | Security | API keys, OAuth, scopes, tenant auth, audit chain, at-rest volume check, remote backup | ONE ID, phishing-resistant MFA, PAM, Canadian KMS product, SBOM/pen-test programme |
| 18 | Audit and assurance centre | Hash-chained access trail | Certification/finding/remediation tracker, DR-exercise log, vendor reviews |
| 19 | Provincial administration | Tenant create/suspend in the store | Ontario Health operator console, release cohorts, terminology governance UI |
| 20 | Accessibility and language | Not demonstrated | WCAG 2.1 AA, AODA, EN/FR parity, accessible PDFs |
| 21 | Reliability | Single-node SQLite, verified backup, rehearsed restore, instance lock | 99.8% multi-region, horizontal scale ([#25](https://github.com/ThomasGenua/healthsystem/issues/25)), synthetic transactions as a product |
| 22 | Roadmap | See README. Phases 0–5 in the specification are a procurement timeline, not a commitment this file can make. | |
| 23 | Immediate priorities | The table above. | |

## What this increment added

Typed surfaces over the existing clinical log for **immunizations** and
**vitals** (so a refusal needs a reason, and blood pressure is two numbers),
and new tables for **care team** and **coverage** (relationships and
eligibility are not generic chart entries). The patient index now carries
preferred language and telecom, rebuildable from the Patient resource. The
worklist includes **today's appointments**. The chart says `never-asked` /
`never-measured` rather than rendering those panels as none.

Nothing clinically material is overwritten: doses and vitals amend or retract
on the log; a coverage change is a superseding row; retiring a provider sets
an end date.

## What must not be read into a demo

- A complete provincial EMR
- A Dynacare or LifeLabs interface
- A patient portal
- AI drafting or summarization
- Certified Ontario profiles or ONE ID
- 99.8% multi-region availability
