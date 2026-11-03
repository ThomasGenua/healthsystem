# Local administrator access

Start the HTTP server and all MLLP listeners on loopback for a local evaluation:

```powershell
$env:HEALTHSYSTEMS_HOST = '127.0.0.1'
npm start
```

The landing page is `/`, administrator sign-in is `/login`, the workspace is
`/ui`, and the separate patient portal remains `/me`.

Provision an administrator on the host with `node scripts/create-admin.ts`.
Supply one JSON line containing `email` and `password` on stdin. The terminal
input is hidden. No default password is committed. The account is saved in the
existing application database; attempting to create a duplicate email fails
rather than replacing an account or resetting its password.

Passwords use scrypt with a unique random salt. Sessions use random tokens;
only token hashes are stored in SQLite. Browser cookies are HttpOnly,
SameSite=Strict, expire after eight hours, and use Secure when the listener
terminates TLS. Cookie-authenticated writes require a session CSRF token and
reject conflicting origins. Sign-in attempts are limited per source address.
Administrator accounts are confined to their stored tenant and do not grant
patient-portal authority. Existing API-key and OIDC access remain supported.

After sign-in, the workspace confirms whether active API keys already exist.
Existing key secrets are never returned. Settings → API keys can generate a
separate read/write integration key with a 90-day expiry; copy the secret at
generation time. Generating a key leaves existing integrations working.

Privacy and terms pages are at `/privacy` and `/terms`. Demo and setup links
at `/contact` go through `/contact/email` to open a pre-addressed email draft;
the recipient is kept out of public HTML. `HEALTHSYSTEMS_CONTACT_EMAIL` configures
the recipient on the server. The application does not send email on a visitor's
behalf. The redirect reduces static harvesting; it is not bot-proof.

## HealthSystems upgrade compatibility

The application is now HealthSystems. Use `HEALTHSYSTEMS_*` for new configuration.
Existing `NORTHSTAR_*` and `PORTAGE_*` variables remain supported, in that order
after the current prefix. An explicitly empty current value also takes precedence.

An existing `northstar.db` or `portage.db` is opened in place when no
`healthsystems.db` exists. No database, account, password, or API key is renamed or
reissued. Backups under all three prefixes remain discoverable and sort by timestamp.
Current admin sessions accept the previous cookie name; logout clears and revokes
both names. Browser credentials migrate to `healthsystems.*` on first use.
Patient portal sessions still expire on server restart, as before.

Existing OAuth audiences remain deployment configured. Legacy scope and tenant,
organization, and practitioner claim names are accepted, and legacy monitoring
series and station headers are emitted alongside the new names. HL7 application
identifiers and existing FHIR provenance identifier systems remain stable for
connected systems.

The staging Compose project uses HealthSystems branding but explicitly keeps the
existing `northstar-staging_staging-data` volume. Set `HEALTHSYSTEMS_DATA_VOLUME`
only when intentionally selecting another volume; an empty volume is a new install.
