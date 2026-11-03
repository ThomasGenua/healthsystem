# Pilot integration and clinical decision worksheet

Status: pending owner input. This is a handoff for the site, not approval to
use real patient data. Keep credentials out of this document and GitHub.
See [acceptance evidence](PILOT-ACCEPTANCE.md) for the required demonstrations.

## Service selections

| Decision | Information needed | Implementation and acceptance after selection |
|---|---|---|
| Clinic identity provider | Issuer, API audience, registered client ID, supported token profile, scopes and tenant/subject mapping, HTTPS hostname, technical owner | Use the existing OIDC client and secret-file configuration. Demonstrate patient/caregiver login, revoked access, expiry, logout and restart through the actual TLS proxy. |
| Notifications | Provider and channel, sandbox account, verified-contact rules, delivery receipt/signature documentation, support owner | Implement the actual provider adapter and receipt verification; test duplicate, forged, expired and out-of-order receipts, outage/retry and contact changes. Provider acceptance must remain distinct from delivery. |
| Backup destination | S3-compatible bucket or SFTP endpoint, region, retention, independent key custodian, recovery host and operator | Configure the existing remote backup transport; restore an encrypted copy on a separate host with independently recovered keys, verify records and audit chains, measure recovery time. |
| Deployment and monitoring | Host, clinic time zone, TLS ownership, alert recipient and escalation coverage | Run preflight, actual scanner clean/EICAR/outage checks, alert delivery to the chosen operator, and an upgrade/rollback rehearsal. |

The [clinic environment template](../deploy/staging/clinic.env.example) already
contains the supported configuration names. It is not loaded automatically.
Do not fill missing provider contracts with a synthetic implementation and
record that as a live integration.

## Clinical decisions

For each row record: named owner, intended site/workflow, decision and rationale,
approval date, resulting code/test changes and an acceptance scenario. All
five remain **undecided**. The detailed current behavior is recorded in
[pilot readiness](PILOT-READINESS.md#open-questions-for-the-clinical-owner).

| Question | Current behavior | Acceptance scenario once the owner decides |
|---|---|---|
| Intake currency | No invented expiry interval | Move a visit several weeks and verify the agreed reuse or re-entry behavior. |
| Second submission | Refused; patient can send a message | Patient remembers new information after submitting; verify the agreed correction path and what the clinician sees. |
| Cancel and rebook | New booking does not inherit the old form | Cancel, create a replacement, and verify the intended preparation status without silently treating old answers as new. |
| Unreviewed intake age | Remains outstanding indefinitely | Leave a submission unreviewed across the agreed interval and verify ownership and visibility. |
| Upload attached to a draft | API attachments rely on the form's review task; abandoned drafts have no form task | Attach a file to a draft that is never submitted, and demonstrate the agreed review responsibility and task linkage. Portal uploads already raise their own tasks. |

## Rehearsal record

Record the candidate SHA and links to the manually dispatched CI, staging,
monitoring and resilience workflows. CI browser fixtures use synthetic identity
and patients; container smoke checks cover startup, authentication boundaries
and restart; monitoring proves delivery only to its local synthetic receiver;
restore rehearsal uses a second process and a directory on the same runner.
None establishes real-provider behavior, off-host restoration or clinical approval.

Site rollback still needs the chosen host, previous release, verified backup,
operator and plan to preserve activity after the backup. Do not run a destructive
rollback against a live site as part of this worksheet.
