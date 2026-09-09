# Pilot readiness — 2026-09-09

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
- `node --test --test-force-exit test/clamav.test.ts test/intake.test.ts`:
  protocol framing, fail-closed responses, quarantine and concurrent scanning.
- `node --test --test-force-exit test/portal-login.test.ts`: callback attacks,
  token/identity binding, cookie scope, CSRF, logout, expiry, provider failure.
- `node --test --test-force-exit test/portal-browser.test.ts`: real Chromium,
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
