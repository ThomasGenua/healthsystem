# Pilot acceptance evidence — pending site setup

No real patient data, live messages, deployment or independent approvals were
used to produce this checklist. Do not mark an item complete from a unit test.

| Workstream | Repository progress | Evidence still required |
|---|---|---|
| Preflight | Configuration report and optional harmless local scanner probe | Run with real service environment; resolve blockers and review items |
| Upload queue | Bounded automatic scans, persistent retries, suspended-tenant checks, audit and backlog metrics | Actual clamd, current signatures, EICAR and outage drill; monitoring alerts |
| Notifications | Existing transport and delivery ledger; no new provider selected | Provider, credentials, authenticated callback signature/replay contract, delivery and verified-contact tests |
| Recovery | 100-message synthetic encrypted-copy restore passed locally, separate engine boot and chain verification | Separate host and actual off-machine store, key recovery, measured recovery time and rollback |
| Identity | OIDC client and synthetic provider/browser regression | Actual clinic issuer/client, HTTPS proxy, expiry/logout/revocation and claim mapping |
| Windows | Deterministic timestamp and Linux-path fixtures; leaked test handles fixed | Native Node 24.11.0 shutdown crash and remaining full-suite failures need verification on supported target runtime |
| Independent review | Existing hazard register and this acceptance checklist | Named external security/accessibility reviewers and clinical workflow owner; dated findings and sign-off |

## Site evidence to collect

Record candidate commit, host/runtime, reviewer/operator, date, exact steps,
expected and observed outcome, synthetic fixture IDs, report location and any
remaining issue. Never include secrets, real patient screenshots or tokens.

- Identity: patient and scoped caregiver, revoked grant, suspended tenant,
  expired session, logout and process restart; no chart access beyond grants.
- Notifications: verified and unverified contact, duplicate callback, forged or
  expired signature, out-of-order events, provider outage and recovered retry;
  distinguish gateway acceptance from actual delivery and patient awareness.
- Uploads: clean file, EICAR, stopped daemon, malformed reply, restart during
  scan and old backlog; no unscanned downloads or duplicate chart documents.
- Recovery: download the encrypted replica onto a different empty host, obtain
  the escrowed key independently, restore, verify chains/chart/appointments,
  measure recovery time and rehearse rollback without discarding new activity.
- Accessibility: keyboard-only and screen-reader navigation, mobile reflow,
  EN/FR workflows, errors/focus, caregiver chart changes and timeout handling.
- Security/clinical: tenant isolation, consent, released versus held results,
  medication testimony versus verified orders, audit review and escalation paths.

Real notification integration remains disabled/unclaimed until the provider is
chosen. Do not invent a callback signing scheme and call it provider-compatible.
