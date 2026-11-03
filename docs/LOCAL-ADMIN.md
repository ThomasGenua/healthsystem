# Local administrator access

Start the HTTP server and all MLLP listeners on loopback for a local evaluation:

```powershell
$env:NORTHSTAR_HOST = '127.0.0.1'
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
the recipient is kept out of public HTML. `NORTHSTAR_CONTACT_EMAIL` configures
the recipient on the server. The application does not send email on a visitor's
behalf. The redirect reduces static harvesting; it is not bot-proof.
