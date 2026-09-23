# Pilot readiness — 2026-09-09

For subsequent operational work and outstanding site evidence, see
[pilot acceptance](PILOT-ACCEPTANCE.md). PR #97 passed Linux CI on Node 22 and 24
before merge; the earlier local Windows results below remain a separate limitation.

This assessment starts at main `603d484a97e791b85bba755785f86e0e79121319`.
It records engineering evidence, not clinical or deployment approval.
Earlier roadmap tables are historical snapshots; their initial status labels
must not be interpreted as current release status.

## This increment

The patient portal now offers clinic sign-in through OIDC authorization code
with S256 PKCE. The server validates state, a browser-bound login cookie,
nonce, issuer, audience, subject, token expiry and optional access-token hash.
Tokens stay in process memory. Patient API authorization still uses AuthGate,
tenant isolation, consent checks and live chart grants on every request.
HttpOnly/Secure session cookies do not authorize admin or FHIR routes. Writes
and logout require the exact Origin and a session CSRF token. Logout destroys
the local session; it does not log the patient out of the upstream provider.

See [the runbook](RUNBOOK.md#the-patient-portal) for provider registration,
configuration, TLS, session limits and restart behavior. This client supports
client_secret_basic and JWT access tokens; providers requiring a different
token/authentication profile need a separately tested adapter. No real clinic
provider has been configured or claimed as tested in this increment.

## Verification

Uploads now have an opt-in local ClamAV INSTREAM adapter. Unexpected verdicts,
daemon errors and timeouts leave files quarantined. Concurrent scan completions
cannot file duplicate documents or review tasks. Protocol tests use a fake local
daemon, not an installed antivirus engine or evidence of current signatures.

- `npm run typecheck`
- `node --test --import ./test/exit-watchdog.ts test/clamav.test.ts test/intake.test.ts`:
  protocol framing, fail-closed responses, quarantine and concurrent scanning.
- `node --test --import ./test/exit-watchdog.ts test/portal-login.test.ts`: callback attacks,
  token/identity binding, cookie scope, CSRF, logout, expiry, provider failure.
- `node --test --import ./test/exit-watchdog.ts test/portal-browser.test.ts`: real Chromium,
  mobile viewport, sign-in, released/held results, message received by the
  clinic, caregiver restrictions, revocation and logout.
- `npm test`: complete regression suite; report environmental failures
  separately and compare against the same unmodified base.
- `npm run hazardcheck -- origin/main` and `npm run invariants`.

Set `NORTHSTAR_TEST_CHROME` to a Chromium executable if not auto-detected.
CI sets `NORTHSTAR_REQUIRE_BROWSER=1` so browser absence fails the job.
The browser test uses an isolated temporary profile and synthetic patients.

Local evidence on Windows / Node 24.11.0: type-checking and the hazard-ID
check pass. The combined ClamAV, intake, intake API, portal login and Chromium
suite passes 70/70 tests. The broader regression is not yet a clean release
gate. A separate unchanged-base Windows subset passed 59/64 tests, reproducing
five failures involving filesystem/backup/instance-lock/key-lifecycle checks.
Those results do not excuse additional failures or establish Linux deployment
behavior. Complete the full regression and deployment rehearsal before release.

## Remaining decisions and evidence

| Area | Required before using the affected feature at a pilot site |
|---|---|
| Identity | Register the actual clinic client; confirm issuer, JWT API audience, scopes, subject and tenant claims; exercise login/logout/revocation through the site's TLS proxy. |
| Notifications | Select the provider, configure credentials, implement authenticated delivery receipts and validate verified-contact handling with that provider. Store tests are not delivery evidence. |
| Uploads | Configure the local ClamAV adapter, maintain current signatures and demonstrate clean, EICAR and unavailable-daemon behavior on the deployment. The synthetic scanner is only a fixture. |
| Vendor feeds | Use the vendor's actual guide, sandbox and agreed test fixtures; record the resulting test report. |
| Clinical use | Named clinical owner reviews hazards, workflows and residual risk for the site's intended use. |
| Accessibility/security | Independent usability, assistive-technology and security testing on the deployed application; repository tests do not establish these outcomes. |
| Operations | Verify encryption, monitoring, off-machine backups, recoverable backup keys, restoration and rollback on the actual deployment. |
| Clinic location | Set `NORTHSTAR_CLINIC_TIMEZONE`, preferably to a place such as `America/Yellowknife`; a fixed offset such as `-07:00` does not follow daylight saving. Unset, the board, the worklist and the privacy review's after-hours all use UTC (H-211, R-19). Then check the boot line against the clinic's clocks: a place name is resolved with the time-zone data compiled into Node, and copies differ. Node 24.21 (tzdata 2026c) treats `America/Yellowknife` as `America/Edmonton` and keeps it on UTC-06:00 from November 2026; Node 22.22 (tzdata 2025c) falls back to UTC-07:00. Which matches the law at the site is for the site to confirm, and to re-confirm after any Node upgrade (H-214). |

## Open questions for the clinical owner

Five questions the pre-visit intake workflow raises and this repository has
deliberately not answered. Each has a current behaviour, chosen to be the
conservative one, and each is a clinical or operational judgement rather than
an engineering default — the same line `labs/README.md` and the score
governance draw. A named clinical owner should decide them before the feature
is used at a site; until then the current behaviour stands and is documented
here rather than assumed.

| # | Question | What it does today, and why that is the holding answer |
|---|---|---|
| 1 | **When does a pre-visit intake stop being current?** A form answered for a visit that was then moved by six weeks may or may not still describe the patient. | Nothing expires. A form covers the visit it names, for as long as that visit exists, and the board reads it as preparation for that visit only. No rule of the form "an intake older than N days is stale" has been invented, because the number is the whole clinical content of such a rule and this codebase is not the place it gets chosen. |
| 2 | **May a patient send a second intake for the same visit, and what should a clinician then see?** | The second one is refused, naming when the first was sent. This closes H-210, where two tabs produced two conflicting accounts with the *older* answers written second. It also blocks the patient who genuinely remembered something — they can still send a message, or a concern not attached to a visit. If the clinical answer is "yes, and show both in order", that is a supersede-and-display decision, not a bug fix. |
| 3 | **Does a form sent for a cancelled or rescheduled visit carry over to its replacement?** | No. `Clinics.rescheduleVisit()` moves slots and a booking keeps its identity, so a form follows a visit that merely moves. A visit that is *cancelled and rebooked* is a new booking, and the old form does not follow it — the patient shows as unprepared for the new visit. That is the conservative direction (H-209's reasoning) and it may still be the wrong workload answer for a clinic that reschedules often. |
| 4 | **How long after a visit should an unreviewed intake stay on the board?** | Indefinitely, oldest first. `attention().intakeAwaitingReview` never ages anything out, so a submission nobody read is still visible next month. Deciding it should drop off after some period is a decision about what a clinic is willing to stop being shown, which is H-202's question in a new place. |
| 5 | **Should a file sent in with an intake form get its own review task?** | Not today. An upload that names one of the patient's own forms raises no task and relies on the form's. But the form's task does not list its files, and a draft that is never sent in raises no task at all, so a file attached to an abandoned draft is filed to the chart with nobody asked to look at it. The portal never attaches an upload to a form, so every upload made through it raises its own task; this applies to other clients of the API. Since H-216 the form has to be the patient's own. "Always a task of its own" can mean two tasks for one visit's paperwork; "ride the form" needs the form's task to list its files and a rule for drafts nobody sends. Which is right is about what the review inbox should hold. |

## Deployment rehearsal

1. Pin the candidate commit and record runtime, configuration and enabled features.
2. Use synthetic data and the intended TLS proxy and identity provider.
3. Demonstrate login, released/held results, messaging, caregiver scope,
   revocation, tenant suspension, logout, session expiry and process restart.
4. Exercise an unavailable provider, interrupted request, duplicate submission,
   notification failure and quarantined upload for the features in scope.
5. Restore an encrypted off-machine backup onto a separate empty host and
   verify the audit chains, chart contents and measured recovery time.
6. Rehearse return to the pinned previous version with a verified pre-upgrade
   backup. Do not discard intervening clinical activity to simulate rollback.
7. Record outcomes, owners and remaining issues. Site approvals and live data
   deployment are separate from this engineering increment.

Design references: [OAuth security BCP](https://www.rfc-editor.org/rfc/rfc9700.html)
and [OIDC code flow](https://openid.net/specs/openid-connect-core-1_0.html#CodeFlowAuth).
