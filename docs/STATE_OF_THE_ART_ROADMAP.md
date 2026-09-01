# State-of-the-art roadmap

Where this system stands against the published standards it intends to meet,
what has actually been demonstrated, and what only an outside party can
establish.

The document exists because the gap between "we implemented the guide" and
"an independent laboratory ran their suite against us" is the gap where
compliance claims go wrong. Keeping the two in one table, with the second
column never inferable from the first, is the only arrangement that survives
somebody reading it in a hurry.

## The status ladder

| Status | Means |
|---|---|
| `NOT_IMPLEMENTED` | Nothing here yet. The honest default. |
| `EXPERIMENTAL` | Code exists behind a default-off flag. Not for use. |
| `IMPLEMENTED` | Built and wired, but its own tests do not yet cover it. |
| `SELF_TESTED` | Built, and this repository's tests exercise it. |
| `EXTERNALLY_TESTED` | An outside party ran their suite against it. |
| `CERTIFIED` | A recognised body issued a certification. |

**Nothing in this repository may promote a capability past `SELF_TESTED`.**
The two statuses above it are records of something that happened outside this
codebase, and no test run, release script or reviewer here can produce that
event. A commit that moves a row to `EXTERNALLY_TESTED` or `CERTIFIED` must
cite the external report by name, date and issuer, or it is wrong.

`SELF_TESTED` is not a weak claim — it means the behaviour is pinned by tests
that fail when it regresses. It is simply not the same claim as conformance,
and this project does not run the suites that would make it one.

## Two conditions recorded at the start of this work

**The approval gate is `78b187e`, not `5c0d146`.** This work was specified as
building on commit `5c0d146` ("Enforce clinical score approval gates"). That
commit does not exist in this repository — checked across every ref including
all pull-request heads, by message, and by SHA through the GitHub API, on four
separate occasions. The fail-closed score approval gate those instructions
describe was instead written as `78b187e`, and that commit is what items
reusing "the gates already built for clinical scores" should be read against.
Recorded here rather than left as a discrepancy for somebody to rediscover.

**Standard versions in this document are unverified.** The environment this
was written in has no network route to `hl7.org`, `build.fhir.org`,
`packages2.fhir.org`, `terminology.hl7.org`, `www.w3.org` or the NIST
publication host — every one is refused by the egress proxy. So no package
was fetched, no checksum computed, and no canonical URL confirmed to resolve.
Version strings below are the ones named in the specification given to this
project, carried through unchanged and marked `[unverified]`. They are a
statement of intent, not of fact.

The conformance registry enforces the same distinction in code rather than
leaving it to this prose: an entry whose checksum has not been verified
against a fetched artifact is recorded `UNVERIFIED` and the registry refuses
to activate it in production. See `43` below.

---

## 43. Standards and conformance registry

- **Current capability** — Conformance packs exist as hand-written JSON with
  no recorded provenance: nothing states which published release a pack was
  derived from, at what version, or whether the bytes have changed since.
- **Target standard** — No external standard governs the registry itself. It
  records artifacts governed by others (FHIR IGs, terminology releases,
  security profiles) and pins each to its own canonical URL and version.
- **Status** — `NOT_IMPLEMENTED`
- **Evidence** — None yet.
- **External validation required** — None for the registry. The artifacts it
  records each carry their own validation requirement, listed below.
- **Risk and rollback** — Low. Additive: a new table and a read path. Rolling
  back means dropping the table; nothing depends on it until 45 and 46 do.

## 44. SMART App Launch and modern OAuth security

- **Current capability** — API keys and OIDC bearer tokens with an OAuth
  subject bound to a chart by clinic attestation. No SMART launch context, no
  PKCE, no `.well-known/smart-configuration`.
- **Target standard** — SMART App Launch `2.2.0` `[unverified]`;
  `http://hl7.org/fhir/smart-app-launch/` `[unresolved]`. PKCE S256 per
  RFC 7636 `[unverified]`; `private_key_jwt` per RFC 7523 `[unverified]`;
  DPoP per RFC 9449 `[unverified]`.
- **Status** — `SELF_TESTED` for token validation and discovery;
  `NOT_IMPLEMENTED` for `private_key_jwt`, DPoP/mTLS sender-constraining, and
  mandatory launch-context binding.
- **Evidence** — `test/smart-oauth.test.ts`: audience enforcement including
  a token minted for another application at the same issuer; key rotation with
  and without overlap; unknown `kid` without letting a caller hammer the
  provider; issuer outage failing closed rather than serving on a stale cache;
  `alg: none` and algorithm confusion; tampered payloads; issuer mismatch;
  expiry and not-before within the configured skew; scope narrowing, with
  `patient/` kept a separate trust boundary; and a refusal that echoes no part
  of the token.
- **External validation required** — A SMART conformance suite run by a party
  that is not this project. Nothing here can establish it, and the status
  above must not move on the strength of these tests.
- **Risk and rollback** — Requiring the audience is a breaking change made
  deliberately: a site that previously ran without one will not boot until
  `NORTHSTAR_OIDC_AUDIENCE` is set. Rollback is setting the variable, not
  reverting the check. Discovery is additive and read-only.

## 45. International Patient Access vertical slice

- **Current capability** — A FHIR R4 facade with patient-compartment reads
  behind an authority grant. No IPA capability statement, no declared profile
  conformance.
- **Target standard** — IPA `1.1.0` `[unverified]`;
  `http://hl7.org/fhir/uv/ipa/` `[unresolved]`. FHIR R4 `4.0.1`.
- **Status** — `SELF_TESTED` for pagination, patient-compartment scoping and
  the capability statement's guide claims; `NOT_IMPLEMENTED` for
  `_include`/`_revinclude`, Provenance in search results, and deleted
  resources.
- **Evidence** — `test/fhir-pagination.test.ts`: every resource appears
  exactly once across pages over a run of identical timestamps, a page is
  stable when re-requested, `_count` is bounded, and one tenant's page never
  contains another's; and the capability statement names a guide only once the
  conformance registry holds it active. `test/fhir-compartment.test.ts`: a
  scoped search returns only that chart, a resource whose patient cannot be
  determined is excluded rather than included, scoping composes with paging
  without leaking across the boundary, one tenant's scoped search never
  reaches another's, and a database written before the column gains it with
  the references recovered from stored JSON.
- **Known gap** — `_include`/`_revinclude`, Provenance in search results, and
  deleted-resource semantics. Compartment scoping is done: the patient
  reference is a column on `fhir_resources`, populated at write time and
  backfilled on open, and a patient-scoped search excludes what it cannot
  attribute rather than including it. The patient-facing surface remains
  `/patient/*`, where authority grants are enforced per chart, so there is one
  boundary rather than two — a deliberate choice recorded here because the
  alternative, serving patient tokens from `/fhir/*`, would put the grant
  check in two route families.
- **External validation required** — The official HL7 validator against the
  real IPA package, then a Connectathon track. Neither is possible here: the
  package cannot be fetched.
- **Risk and rollback** — Medium. Read-only surface; rollback is withdrawing
  the capability statement and the routes it advertises.

## 46. Patient summary generation

- **Current capability** — No summary export.
- **Target standard** — IPS `2.0.1` `[unverified]`;
  `http://hl7.org/fhir/uv/ips/` `[unresolved]`.
- **Status** — `NOT_IMPLEMENTED`
- **Evidence** — None yet.
- **External validation required** — IPS validation against the official
  package; separately, any PS-CA claim requires the official Canadian package.
  **No PS-CA package has been supplied to this project**, and none will be
  reconstructed from memory or inference — a Canadian conformance claim built
  from a guess is worse than no claim.
- **Risk and rollback** — Medium. A summary that omits or mislabels a section
  is a clinical hazard, so absent / unknown / withheld / not-applicable stay
  distinct all the way through. Rollback is disabling the export flag.

## 47. FHIR Provenance

- **Current capability** — Hash-chained `AuditEvent` for access and system
  activity, and message lineage on the transport side. No `Provenance`
  resources, so clinical authorship and transformation are not expressed in
  FHIR terms.
- **Target standard** — FHIR R4 `4.0.1` `Provenance`;
  `http://hl7.org/fhir/R4/provenance.html` `[unresolved]`.
- **Status** — `NOT_IMPLEMENTED`
- **Evidence** — None yet.
- **External validation required** — Profile validation against the R4
  package.
- **Risk and rollback** — Low to medium. Additive resources. `AuditEvent` and
  `Provenance` answer different questions — who looked, versus where this came
  from — and are not interchangeable; conflating them would leave both wrong.

## 48. Topic-based clinical event subscriptions

- **Current capability** — `fhir_subscriptions` with delivery through the
  ordinary channel machinery. Not topic-based, no handshake or heartbeat, no
  notification signing.
- **Target standard** — FHIR Subscriptions R5 Backport `1.1.0` `[unverified]`;
  `http://hl7.org/fhir/uv/subscriptions-backport/` `[unresolved]`.
- **Status** — `NOT_IMPLEMENTED`
- **Evidence** — None yet.
- **External validation required** — Backport IG validation and an
  interoperability run against another implementation.
- **Risk and rollback** — High. Outbound delivery to operator-supplied
  endpoints is an SSRF and cross-tenant leakage surface. Endpoint allowlists
  and per-tenant separation are prerequisites, not follow-ups.

## 49. Bulk Data export

- **Current capability** — De-identified aggregate release with small-cell
  suppression. No `$export`.
- **Target standard** — FHIR Bulk Data Access `2.0.0` `[unverified]`;
  `http://hl7.org/fhir/uv/bulkdata/` `[unresolved]`.
- **Status** — `NOT_IMPLEMENTED`
- **Evidence** — None yet.
- **External validation required** — Bulk Data test suite.
- **Risk and rollback** — High. A bulk export is the largest single
  disclosure this system can make. Feature-flagged off; authorization captured
  at job creation *and* revalidated at download; no publicly discoverable
  object URLs.

## 50. Versioned terminology service

- **Current capability** — Value sets and concept maps imported from real
  releases, refusing partial resolution. No `$validate-code`, `$subsumes` or
  `$translate`; no immutable release identity.
- **Target standard** — FHIR R4 `4.0.1` terminology operations. UCUM
  normalisation already implemented against the contract in
  `src/clinical/measurement.ts`.
- **Status** — `NOT_IMPLEMENTED` (UCUM normalisation alone is `SELF_TESTED`)
- **Evidence** — `test/score-measurement.test.ts` for UCUM handling.
- **External validation required** — Terminology conformance testing; SNOMED
  CT content requires a licence this project does not hold, so a local
  simulator and fixtures stand in and no restricted dataset is committed.
- **Risk and rollback** — Medium. Silently substituting a code from another
  version is the hazard; releases are immutable and activation atomic.

## 51. Governed computable clinical knowledge

- **Current capability** — Ten published risk scores behind the approval gate
  in `78b187e`. No `Library`, `PlanDefinition`, `ActivityDefinition` or CQL.
- **Target standard** — FHIR R4 `4.0.1` knowledge resources; CQL version to
  be pinned once verifiable.
- **Status** — `NOT_IMPLEMENTED`
- **Evidence** — The gate this would reuse: `test/score-governance.test.ts`.
- **External validation required** — Clinical review of any shipped logic by
  a qualified reviewer. No model may author clinical logic or reference
  ranges, and none has.
- **Risk and rollback** — High. Executable clinical logic is the highest-risk
  capability in this list. Execution only from an approved immutable package,
  with a kill switch.

## 52. Consent and policy decision service

- **Current capability** — Consent directives, authority grants, break-glass
  and tenant boundaries enforced, but the checks are distributed across call
  sites rather than centralised, and there is no machine-readable decision
  trace.
- **Target standard** — No single external standard mandated. Decisions
  reference FHIR R4 `Consent` and security labels.
- **Status** — `NOT_IMPLEMENTED` (the underlying controls are `SELF_TESTED`)
- **Evidence** — `test/consent.test.ts`, `test/break-glass-notice.test.ts`,
  `test/auth-bypass.test.ts`.
- **External validation required** — Independent security review.
- **Risk and rollback** — High. Centralising authorization means every call
  site changes at once. The decision point ships alongside the existing
  checks and is compared against them before either is removed.

## 53. Offline synchronisation protocol

- **Current capability** — Reading stations serve a restored snapshot with
  staleness as first-class incompleteness, offline break-glass replayed at
  reconcile. No versioned deltas or explicit conflict representation.
- **Target standard** — No external standard mandated.
- **Status** — `NOT_IMPLEMENTED` (snapshot serving is `SELF_TESTED`)
- **Evidence** — `test/reading-station.test.ts`.
- **External validation required** — None external; needs adversarial testing
  for tampering and clock skew.
- **Risk and rollback** — High. Last-write-wins on concurrent clinical edits
  is the hazard being removed; conflicts must be represented, never resolved
  silently.

## 54. AI safety foundation

- **Current capability** — Nothing in this repository uses a learned model,
  and the safety case says so. There is no AI feature registry.
- **Target standard** — NIST AI RMF Generative AI Profile, NIST AI `600-1`
  `[unverified]`.
- **Status** — `NOT_IMPLEMENTED`
- **Evidence** — `docs/CLINICAL-SAFETY.md` records the current absence.
- **External validation required** — Any model deployment needs evaluation on
  a dataset this project does not have, including subgroup analysis.
- **Risk and rollback** — High if ever enabled. Registry disabled by default;
  autonomous diagnosis, prescribing, ordering, score approval, chart
  modification and patient-facing clinical advice are prohibited outright
  rather than gated.

## 55. Independent conformance laboratory

- **Current capability** — 1068 tests, typecheck, and resilience workflows,
  all run by this project on Ubuntu only.
- **Target standard** — Runs the official HL7 validator; version pinned once
  the artifact can be fetched.
- **Status** — `NOT_IMPLEMENTED`
- **Evidence** — Existing suite; see `docs/RUNBOOK.md`.
- **External validation required** — This is the item whose entire purpose is
  to make external validation possible. It cannot itself produce it.
- **Risk and rollback** — Low. Adds a command; changes no behaviour.

## 56. Verifiable software supply chain

- **Current capability** — Two runtime dependencies, optional drivers, and no
  SBOM, signing or build provenance. CI actions are not pinned by digest.
- **Target standard** — SPDX or CycloneDX SBOM; SLSA build provenance —
  **the version named in the specification given to this project ("1.2") could
  not be verified**, and `slsa.dev` is blocked from this environment. The
  version this project knows as published is `1.0`. No version is pinned here
  until one is confirmed against the canonical source. NIST SSDF `SP 800-218`
  `[unverified]`.
- **Status** — `NOT_IMPLEMENTED`
- **Evidence** — None yet.
- **External validation required** — Independent verification of build
  reproducibility and provenance.
- **Risk and rollback** — Low to medium. Mostly additive CI.

## 57. Accessibility and human-factors evidence

- **Current capability** — Admin console and a bilingual patient page with a
  skip link and landmarks. No automated accessibility testing, no WCAG claim,
  and the safety case says so.
- **Target standard** — WCAG `2.2` Level AA `[unverified]`;
  `https://www.w3.org/TR/WCAG22/` `[unresolved]`.
- **Status** — `NOT_IMPLEMENTED`
- **Evidence** — None yet.
- **External validation required** — Screen-reader testing and human-factors
  evaluation by people, recorded separately from any automated scan. An
  automated checker finds a minority of real barriers, and a green scan is not
  an accessibility claim.
- **Risk and rollback** — Low. Additive tests.
