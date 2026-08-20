# Security policy

Portage moves and stores personal health information. A defect in it is not an
availability problem with a privacy footnote — a record served to the wrong
clinician, an audit row that was never written, or a lockbox that reports
itself in force while enforcing nothing are all, on their own, the failure this
system exists to prevent. Please treat them as reportable even when nothing
crashed.

## Reporting a vulnerability

**Report privately through GitHub, not in an issue or a pull request.**

Open <https://github.com/ThomasGenua/healthsystem/security/advisories/new>, or
go to the repository's **Security** tab → **Report a vulnerability**. This
opens a private advisory visible only to you and the maintainers, with a
private fork to develop the fix in and a CVE request when one is warranted.

> If that link 404s for you, private vulnerability reporting has not been
> enabled on the repository yet. It is enabled under **Settings → Code security
> and analysis → Private vulnerability reporting**. Until it is on, please open
> an empty public issue titled "security contact request" with no details in it
> and wait to be contacted — do not describe the vulnerability publicly.

Please do not open a public issue, discussion or pull request describing an
unfixed vulnerability, and please do not post one to a mailing list or social
media before a fix is available. A deployed interface engine sits between
sources and destinations that cannot be patched on the same day it can.

### What to include

The report is more useful the closer it is to something that can be run:

- what version or commit you tested, and on which Node runtime
- the smallest reproduction you have — a failing test against this repository
  is ideal, a `curl` sequence is nearly as good
- what an attacker gets: which records, whose, and what access they needed to
  start with
- whether the audit trail records the access, and whether the consent check
  ran — the two structural guarantees this codebase makes are that patient data
  cannot be served without an audit row and cannot be served past a directive,
  so a bypass of either is a finding on its own even if no data is disclosed
- anything you already know about mitigation

**Please do not use real patient data in a report**, in any form, including
screenshots and log excerpts. Synthetic identifiers are in `fixtures/` and the
test suite; if a real record is the only way to demonstrate the issue, say so
in the advisory and describe it rather than attaching it.

### What to expect

This is a small project without a staffed security team, so these are honest
intentions rather than a contractual SLA:

| | Target |
| --- | --- |
| Acknowledgement of your report | 3 business days |
| Initial assessment and severity | 10 business days |
| Fix or documented mitigation for a high-severity issue | 30 days |
| Public advisory | after a fix ships, or 90 days, whichever comes first |

You will be credited in the advisory by whatever name you ask for, or not at
all if you prefer. There is no bug bounty.

## Testing against Portage

Security research against **your own deployment or a local checkout** is
welcome and needs no permission. Please do not test against a live deployment
you do not operate: this is health software, and a running instance is
somebody's clinic.

`npm run crashtest`, `npm run diskfulltest` and `npm run loadtest` are hostile
to the engine by design and are a reasonable place to start.

## Scope

**In scope** — anything in this repository: the engine, the HL7 v2 and FHIR
handling, the API and its authentication, the consent and break-glass
enforcement, the audit trail and its hash chain, the at-rest encryption, the
tenancy boundary, the retention and redaction paths, the backup format, and the
migration path between versions.

Particularly wanted, because they are the guarantees the README makes in
writing:

- reading or writing across a tenant boundary
- serving patient data without an audit row, or with one that misattributes it
- getting past a consent directive without a break-glass declaration
- forging or truncating the hash chain without `verify` noticing
- a durability claim that does not hold — acknowledged and lost, or replayed
  out of order
- recovering redacted or purged content from a database file or a backup

**Out of scope** — the demo fixtures and synthetic data, denial of service by
brute resource exhaustion against a single-node deployment (it is single-node
on purpose and documented as such), missing hardening headers on the admin UI
where no session or credential is at stake, and anything requiring physical
access to a machine or an operator's terminal. Reports generated wholesale by
an automated scanner with no reproduction attached are unlikely to get a useful
response.

## Supported versions

Portage is pre-1.0 and moving quickly. Only the latest minor release receives
security fixes; there are no long-term support branches. A site running an
older version should expect to upgrade to receive a fix — `test/migration.test.ts`
exists precisely so that upgrading is not the risky part.

| Version | Supported |
| --- | --- |
| 0.5.x | yes |
| < 0.5 | no |

## Known limitations, which are not vulnerabilities

These are documented in the README's honest-limits section and are design
positions rather than defects. Reporting them is welcome as a design
discussion, but they will not be treated as advisories:

- **Single node.** One process owns a database file, enforced with a lock.
  There is no clustering, and a hardware failure is an outage until the standby
  is promoted by hand.
- **No user interface for the clinical platform**, and no patient portal. The
  patient-facing modules are built and deliberately not mounted, because a
  portal is a different trust boundary and it has not been built yet.
- **`withhold-from-organization` directives currently withhold from every
  caller**, because no credential carries an organization identity to compare
  against. This fails closed on purpose; it is over-restrictive, not permissive.
- **Decision support ships as a mechanism without content**, and nothing in
  Portage uses machine learning. No output should be read as though it did.
