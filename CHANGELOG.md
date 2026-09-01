# Changelog

Notable changes per release. Dates are the release date; a version is cut when
a coherent block of capability is finished and tested, not on a calendar.

Northstar is pre-1.0: minor versions may change interfaces. Database upgrades are
always forward-compatible and run automatically on open — see
[Upgrading](docs/RUNBOOK.md#upgrading).

## Unreleased

**Fixed**

- **A FHIR search could return the same resource on two pages, and skip
  others.** Stored resources were ordered by `updated_at` alone, which has
  second granularity — so a bulk load writes dozens of resources sharing one
  timestamp, and SQLite specifies no order among rows equal under the ORDER
  BY. Paging through such a run repeats some resources and omits others, with
  no error and a correct-looking total: a client reading a patient's
  observations gets a chart with holes in it. The ordering now carries a
  tiebreak on id, so it is specified rather than incidental.

- **A backup destination on Windows went somewhere else, quietly.** `fs:` and
  `file://` destinations were parsed by slicing the scheme off and requiring a
  leading `/`. `C:\backups` has no leading slash, so an absolute Windows path
  was refused as relative; and `file:///C:/backups` sliced down to
  `/C:/backups`, which is not a path — the backups landed in a directory named
  `C:` at the root of the current drive. Both failures hit the one setting
  whose whole job is to put backups somewhere other than the machine holding
  the database. Parsing now goes through `fileURLToPath`, which knows the
  drive-letter and percent-encoding rules, and absoluteness is checked with
  the rules of the platform being targeted rather than of POSIX. Hazard H-158.

- **An expired reading station answered 500 instead of 503.** The first
  request past the serving budget destroys the cache, and `rmSync`'s `force`
  suppresses a missing file but not a locked one: on Windows, deleting a
  database another handle still holds throws EPERM, and the throw escaped into
  the request. The station's deliberate refusal — with the remedy an operator
  needs — became a generic fault. Refusing to serve is the guarantee and
  destroying the file is the tidying that usually accompanies it, so a failed
  purge is now reported rather than thrown, and the manifest is left unpurged
  rather than claiming a destruction that did not happen. Hazard H-157.

- **Platform-dependent logic is now testable from either platform.** CI runs
  on Ubuntu only, so every Windows branch was unexecuted — which shows up as a
  green build on a machine that never took the branch, and failures found on
  somebody's laptop. Encryption-at-rest detection takes the platform as a
  parameter, so its Linux path is exercised from any host instead of being
  skipped into a "cannot check" branch. Temporary-directory cleanup across the
  suite retries, which is inert on Linux and rides out the brief EPERM while a
  Windows handle or virus scanner still holds a file.

- **A medication reconciliation could be completed twice.** The status check
  and the count of undecided items ran outside the transaction and the write
  did not name the state they had read, so two clinicians completing the same
  reconciliation both passed the guard and both wrote — two people each told
  it was done, and a record naming only the second. The checks now run inside
  the transaction and the write is conditional on the reconciliation still
  being open.

- **A referral's status and its event log could disagree.** `transition()`
  moved the status and appended the event as two writes outside any
  transaction, so a failure between them left a referral in a state its own
  history did not account for — and that history is what the stalled-referral
  review reads. Both writes now commit together or not at all.

- **Lifecycle writes name the state they expect.** Result acknowledgement,
  referral transitions, reconciliation completion and prescription
  acknowledge/fail update conditionally on the status their check read, and a
  write that changes no rows refuses with 409 rather than silently succeeding.
  A score's approval chain is kept linear by the database as well as by the
  code: one root decision per score, and one successor per decision, so a
  score cannot acquire two current approvals. Hazards H-160 and H-161.

**Security**

- **`NORTHSTAR_OIDC_AUDIENCE` is now required when OAuth is enabled, and a
  site without it will not boot.** It was optional, and an absent audience
  skipped the check entirely: every token the configured issuer had ever
  signed was accepted, including tokens minted for a different application in
  the same directory. An identity provider serves many resource servers, so a
  token for the expenses system, signed by the same Entra or Keycloak tenant,
  was a valid Northstar token — and the deployments that never set the
  variable were exactly the ones running without the check.

  **Breaking, deliberately.** A site that cannot start is a site somebody
  fixes; one that starts and honours another application's tokens is not. Set
  `NORTHSTAR_OIDC_AUDIENCE` to the identifier this deployment is registered
  under at the issuer. A token carrying no `aud` claim at all is now refused
  for the same reason as one naming somebody else. Hazard H-162.

- **`.well-known/smart-configuration`**, generated from what this deployment
  is configured with. Northstar is a resource server — it validates tokens and
  does not issue them — so the document advertises the site's own
  authorization server, and lists only capabilities this end actually
  enforces. A discovery document claiming a capability the server does not
  have is how a client comes to trust a check that never runs.

- **SMART launch context is surfaced and type-checked.** `patient`,
  `encounter` and `fhirUser` are read from the token and exposed on the
  verified result, with a structured value dropped rather than carried around
  as though it were an identifier. It is not yet required: a patient token is
  bound to a chart here through an explicit authority grant, which is the
  stronger control, and demanding a launch claim as well would refuse tokens
  that are already correctly constrained.

**Added**

- **A FHIR search can be scoped to one chart.** `fhir_resources` recorded a
  resource's type, id and JSON and nothing about whose record it was, so the
  only way to answer "everything about this person" was to read every row and
  parse it. The patient reference is now lifted out at write time into a
  column, with `?patient=` on the search and a matching index.

  What its absence means is the load-bearing decision: a row whose patient
  could not be determined is **excluded** from a patient-scoped search, never
  included. Null is not a wildcard. If the extraction misses a reference
  spelling the result is a record that fails to appear — visible and
  conservative — rather than one appearing on the wrong chart. An unscoped
  search is unchanged, so nothing an existing caller sees is narrowed, and the
  unattributed resource is still readable there rather than silently gone.

  Databases written before the column gain it on open and the references are
  recovered from the stored JSON, which is the only place they ever were. The
  backfill is idempotent and leaves a resource it cannot attribute alone
  rather than guessing at one.

  The patient-facing surface is deliberately not this: a patient or proxy is
  still served by `/patient/*`, where an authority grant is checked per chart.
  This scoping is for staff and system callers already authorised broadly, so
  there is one boundary to get right rather than two.

- **FHIR search pagination.** `_count` (bounded to 100) and `_offset`, with
  `Bundle.link` carrying self, next and previous, so a client can page without
  constructing URLs itself.

- **The capability statement claims an implementation guide only where the
  conformance registry says that guide is in force.** `instantiates` is
  generated from the active packages rather than written literally, so the
  statement cannot name a guide the deployment never installed — the same
  failure as a hand-written conformance page, in the artifact a partner reads
  first.

- **Properties that hold across every instrument, not just the thresholds
  somebody wrote down.** A risk score is a sum of things that make a patient
  worse, so finding one more of them cannot make the total smaller — a
  constraint no individual boundary test states, and one an implementation can
  violate while passing all of them. Adding any positive criterion, stepping
  any graded criterion up, and moving any numeric criterion in its declared
  direction of risk are all asserted never to lower a score, across all ten
  instruments. Structural properties come with them: an additive score equals
  the sum of the components it publishes, a score is a function of its input
  alone, removing any one required input withholds the number entirely, and a
  higher total never lands in a safer band. Where the shape genuinely bends it
  is named rather than skipped: NEWS2 scores derangement in both directions,
  so its respiratory rate, blood pressure, heart rate and temperature are
  asserted to *be* U-shaped, and MELD-Na's components are asserted not to sum,
  because they are the working of a logarithmic formula rather than addends.
  These establish implementation behaviour only; the last test asserts the
  assurance state is still unreviewed, with no clinical owner and no review
  date. Hazard H-156.

- **Every clinical score is disabled until somebody accountable approves it
  here.** Correct arithmetic is not permission to act on the number: an
  instrument derived in one population, implemented from a paper and never
  looked at by anybody at this site is a calculator, and a calculator wired
  into a chart returning a band and an interpretation is indistinguishable at
  the point of care from a decision somebody stands behind. `score_approvals`
  records that decision, and its absence is the default — the empty table is
  the safe state, not an unconfigured one.

  Nothing can be invented. The review date is supplied and never computed from
  an interval, because a date the system picked is not a commitment anybody
  made. The clinical owner must resolve to a practitioner the tenant's own
  directory holds and has not retired. A reason of at least twelve characters
  is required to approve or to disable — the same bar as breaking the glass.
  The operator who records the decision is a separate column from the
  clinician who owns it, because they are usually different people and a
  record that conflates them can answer neither question afterwards.

  An approval stops being one in four ways, each disabling the score and none
  of them self-clearing: it passes its review date, the implementation version
  it was granted for stops matching the arithmetic the build runs, its owner
  is retired, or somebody withdraws it. `ScoreGovernance.expiring(withinDays,
  asOf)` reports what is due and what is already past; reading it renews
  nothing. The table is append-only, so a withdrawal supersedes an approval
  without erasing it and "who allowed this, and what did they know" survives
  the reversal. Approvals are tenant-scoped, so one site's decision cannot
  enable another's score. `POST /api/clinical/score` and `/score/v2` refuse
  with 403 unless a decision in force permits use, and there is deliberately
  no route that enables more than one score at a time. Hazard H-159.
  1061 tests.

- **A registry for every standard this deployment claims to conform to.**
  The conformance packs under `conformance/` are hand-written and say nothing
  about their own provenance: which published release they came from, at what
  version, or whether the bytes have changed since. Every implementation
  guide, terminology release, security profile and schema is now recorded
  with its canonical URL, package identifier, exact version, FHIR version,
  licence, publication status and a checksum, and nothing is in force until
  an operator activates it with a written reason.

  `checksumVerified` is the column that carries the weight: a hash copied
  from a release note proves the release note said it, so the flag is set
  only by hashing an artifact actually in hand. Activation in production is
  refused when the checksum is unverified, when the publication status is
  ballot, draft or unknown, or when the version names a moving target such as
  `current` — each being a reason the claim cannot be checked later. An
  operator may override in writing; the reason is recorded on the row and
  appears beside the package everywhere it is read, including on the
  generated conformance page. The database keeps at most one active version
  of a package per tenant, because two versions of one guide in force at once
  is a question nobody can answer about which rules applied to a resource.

  The public conformance page is generated from the registry rather than
  written by hand, so it cannot drift from what is installed, and it carries
  each package's outstanding caveats rather than only the claim.

- **`docs/STATE_OF_THE_ART_ROADMAP.md`**, recording for each target standard
  the current capability, the exact version intended, implementation status,
  the evidence behind it, the external validation still required, and the
  rollback path. Nothing in this repository may promote a capability past
  `SELF_TESTED`; the two statuses above it record events that happen outside
  this codebase.

- **Governed provenance for every clinical risk score.** A result now carries
  the exact instrument and Northstar implementation versions, original source,
  intended population, exclusions, required units, calculation time and a
  copy of the supplied inputs. The assurance state is deliberately machine
  readable and unresolved: source-linked golden vectors exercise the
  implementation, but no independent clinical reviewer or clinical owner has
  signed it. Chart-derived scores also state their clinical `asOf` time.

  The catalogue makes two easily hidden version choices explicit: MELD-Na is
  the historical 2016 OPTN formula, not current MELD 3.0, and NEWS2 implements
  Scale 1 only. `test/score-provenance.test.ts` requires one governed
  definition and one source-linked vector per scorer and keeps those caveats
  attached to the API result. Hazards H-139 through H-141.

- **A measurement contract, so a score knows what scale its numbers are on.**
  `POST /api/clinical/score/v2` takes a value together with its UCUM unit —
  `{ "value": 98.6, "unit": "[degF]" }` — instead of a bare number whose unit
  was spelled into the parameter name (`temperatureC`) and restated as prose
  in the catalogue, with nothing comparing either to what the caller sent.
  Equivalent labels are accepted unchanged: `Cel`, `°C` and `degC` are one
  scale, and refusing `mmHg` where UCUM writes `mm[Hg]` would be pedantry with
  a clinical cost. A real conversion — Fahrenheit to Celsius, hours to days,
  µmol/L to mmol/L — happens once at the ingestion boundary, never inside a
  scorer, and is returned with the score so the arithmetic can be checked
  rather than trusted. A mismatch needing a fact about the substance rather
  than the units is refused, not guessed: bilirubin in µmol/L against a mg/dL
  threshold needs a molar mass, and BUN in mg/dL is not urea in mmol/L.
  v1 is unchanged and still supported. The chart is the other ingestion
  boundary and now has the same check: a vital recorded in a convertible unit
  is converted and shows its working, one in a unit that cannot be read is
  reported unavailable like a stale value, and one recorded before this
  contract — carrying no unit at all — is used, with the evidence saying the
  record stated no scale rather than implying one was checked. Hazards H-144
  and H-145, and H-140's control is now enforced rather than declared.
  1025 tests.

- **A domain for every score input, distinct from the instrument's
  thresholds.** A supplied value that no measurement could have produced —
  a negative age or length of stay, a saturation outside 0-100, a CIWA-Ar
  item of 3.5, `NaN` from a caller's own arithmetic — now refuses with a 400
  naming the value and the domain, before any arithmetic and before the
  missing-input check. It previously joined the missing-input list, which
  reported a caller defect as a clinical data gap and sent somebody to
  collect a measurement that was never absent. Absent inputs are unchanged:
  `undefined` and `null` still refuse as missing, and a criterion stated
  absent still scores zero. Domains are keyed by input name, so `ageYears`
  cannot mean one thing in CURB-65 and another in HAS-BLED, and are
  definitional rather than clinical — a percentage cannot exceed 100, a
  count cannot be fractional, nothing is colder than absolute zero — so no
  bound here can move a real patient between bands. Blood pressures, heart
  and respiratory rates and laboratory concentrations are deliberately
  unbounded above, because implausibility is a judgement about a patient
  rather than a fact about a unit. Below, on and above probes now cover every
  numeric criterion and band edge in all ten instruments. Hazards H-142 and
  H-143. 962 tests.

- **An order placed here is no longer assumed to be with a laboratory.**
  `OrderStore.place()` wrote `status = 'placed'` and recorded an event.
  Nothing sent the requisition anywhere, because until an outbound ordering
  interface exists there is nothing to send it to. The chart showed "placed",
  the worklist showed it awaiting a result, and `awaitingResult()` would
  eventually list it as overdue — which reads as a slow laboratory. The
  laboratory had never heard of it.

  This is the third silence, and the earliest: `orders.ts` opens on an order
  never resulted and a result never read, and this one comes before both. It
  is also worse than the dispense silence it resembles. A prescription with no
  dispense record may still have been collected; the pharmacy may simply not
  report. Here *we* are the sender, so the absence is not ambiguous and not
  somebody else's — it is ours, and it is knowable.

  Transmission is now its own fact. A site declares per category whether
  orders leave and to whom, with a detail saying how or why not, so "we print
  the requisition" is distinguishable from "the interface is stuck" — the two
  call for opposite actions and rendered identically before. Each attempt to
  hand an order over is appended, never updated, and **only an acknowledgement
  from the far end means a laboratory holds the order.** Sent, rejected and
  failed each say what they are instead: a rejection says the order is not
  with them and needs correcting; a transport failure says to treat it as not
  sent. The state rides on the order row rather than being a second call a
  caller has to remember, because a guarantee that depends on every screen
  remembering holds until one screen forgets.

  `notWithFiller()` lists placed orders no laboratory has acknowledged. On a
  site with no outbound interface that is every open order, which is the
  correct and uncomfortable answer.

  `GET /api/clinical/order-transmission`, `GET
  /api/clinical/orders-not-with-filler`, `POST
  /api/clinical/order-transmission-record`, and `GET`/`POST
  /api/orders/routing` — the last kept out of `/api/clinical/` because it
  serves site configuration rather than patient data. Hazards H-128 to H-131.

  This is the honesty half; the message that does the telling is below.

- **The outbound order message** (`src/orders/outbound.ts`). `buildOml()`
  turns a placed order into an OML^O21 a laboratory's engine will accept, or
  says exactly what stopped it and builds nothing.

  The module is built around refusing, because the dangerous failure here is
  not a rejected message. A blank patient identifier is rejected, and somebody
  fixes it. A *plausible* one is accepted and matched, and the specimen is
  drawn against somebody else's chart with nothing raising an error. So the
  assigning authority must be declared on the profile and the patient must
  carry an identifier under it; a birth date is required because it is what a
  laboratory verifies against, and names are not unique in a community of four
  hundred people; the timezone is declared rather than read from this machine,
  since a server in one zone sending for a clinic in another is ordinary in the
  north. A draft is refused — a draft is a clinician thinking, and sending it
  books a collection for a test nobody ordered — and so is a cancelled order.
  Every missing field is reported at once, because an integration analyst
  commissioning an interface wants one list rather than five round trips.

  Building and sending are separate, so a message can be produced and shown to
  a laboratory's analyst during commissioning without anything reaching a wire.
  That is exactly how the first conversation with Dynacare or LifeLabs goes.

  Hazards H-132 to H-134.

- **Orders are sent, and the acknowledgement is correlated** (`src/orders/send.ts`).
  The piece that makes the rest of this move: build, hand to the transport,
  read what came back, record it. Every step can fail in a way that must not
  read as success, so each has its own outcome — a refused build records
  nothing at all ("we tried and the line was down" and "we never had enough to
  send" are different conversations), a throwing transport is `failed` which
  reads as *not sent*, and a negative acknowledgement is `rejected`.

  The attempt is written down **before** the send. A process dying between the
  socket and the database would otherwise leave an order reading as never sent
  while a laboratory holds it, and a clinician resending produces two
  requisitions for one specimen.

  `interpretAck()` checks MSA-2 before MSA-1. That is the field an
  implementation skips: MSA-1 says *an* acknowledgement was positive, and only
  MSA-2 says it was about **this** message. Acknowledgements arrive on
  connections carrying other traffic and a slow far end answers a previous
  message after this one went out — so a perfectly positive AA carrying
  somebody else's control id is `failed`, never `acknowledged`. A code the
  parser does not recognise is not assumed positive either, and a commit
  accept says it is one, because holding a message is not accepting an order.
  Hazards H-135 and H-137.

- **The laboratory is told when an order is cancelled** (H-136). `cancel()`
  set the order to cancelled here and nothing told anyone. A laboratory that
  acknowledged it still held the requisition, so the specimen was still
  collected, the test still run, and a result came back for a test the chart
  said nobody wanted — against a patient who may have been told it was called
  off.

  That is the original problem mirrored. The first was the record claiming a
  laboratory had something it did not; this is a laboratory having something
  the record says it does not, and it is the more urgent of the two because it
  ends with a needle.

  Cancellation goes as ORC-1 `CA` naming the same placer order number, since a
  cancellation naming a different requisition cancels nothing. Its
  acknowledgement is tracked separately from the order's, because an order can
  be acknowledged *and* its cancellation unsent — the dangerous combination,
  and the one that reads as fine if you only ask once.
  `cancelledButStillWithFiller()` lists every order cancelled here that no
  laboratory has confirmed withdrawing. A cancellation is refused for an order
  nobody cancelled, which would stop a test somebody is waiting for.

**Fixed**

- **A blood pressure reported no unit, however carefully it was recorded.**
  `Vitals.parse` read the unit off the top-level `valueQuantity`, which a
  component-valued observation does not have, so the one vital always written
  with a unit was the one vital whose unit was invisible. It is now read from
  the components.

- **A versioned clinical route was exempt from the audit-row guarantee.** The
  test that discovers routes by reading `admin.ts` matched
  `[a-z/-]+`, so `/api/clinical/score/v2` did not match at all — and the
  scanner went on reporting a healthy 139 routes while covering 139 of 140.
  The character class now admits digits. This is the second time that class
  has been too narrow; the first was the "/" that exempted nested paths.

- **Two HL7 fields were one position out** (H-133). The indication was landing
  in OBR-14, Specimen Received Date/Time, and the ordering provider in OBR-17,
  Order Callback Phone Number. Neither is a message that fails: a laboratory
  parses it and files clinical information as a timestamp.

  The cause was positional arrays, where a run of empty separators is
  uncountable by eye and one too many shifts everything after it. Segments are
  now built from explicit HL7 field numbers, so `{ 13: indication }` is OBR-13
  and can be checked against a specification without counting. Found by
  dumping the bytes of a built message rather than by rereading the array,
  which had already been read twice.

**Fixed**

- **A superseded transmission attempt could override the one that superseded
  it** (H-130). Attempts were ordered by timestamp with a tiebreak on a random
  UUID, and a send with the acknowledgement answering it lands in the same
  millisecond on a fast link — so the later attempt was whichever identifier
  happened to sort last, and a rejected order reported as acknowledged about
  half the time. That is the precise inversion the mechanism exists to
  prevent. Ordering is now an autoincrementing sequence.

  Caught as an intermittent failure in its own new tests: three runs gave 0, 0
  and 1 failures. Diagnosed rather than re-run, and pinned by a test that
  writes twenty attempts inside one millisecond and asserts the timestamps
  really did collide, so it cannot pass by accident.

## Unreleased

**Added**

- **Ask-at-order-entry, and the answer that is never invented**
  (`LabProfile.askAtOrderEntry`, `OmlContext.aoeAnswers`). A laboratory
  requires certain questions answered before it will run certain tests —
  fasting status, last menstrual period, a weight for a creatinine clearance.

  It looks like paperwork and is not. A glucose reported against a fasting
  reference interval when the patient had breakfast is a **wrong** result
  rather than a missing one: the number is real, the interval is real, and the
  pairing is false. Nothing in the specimen records whether anybody ate, so
  neither the laboratory nor the chart can detect it afterwards.

  That makes the accommodating implementation the dangerous one. Defaulting
  "fasting: no" produces an order that sends cleanly and a result that files
  cleanly, with the reference interval chosen by a program rather than by a
  patient. So an unanswered required question stops the order, listed
  alongside every other missing field, and whitespace is not an answer.

  Questions are declared per test code on the laboratory's own profile rather
  than inferred from the code: a potassium that demanded a fasting answer would
  train people to answer without reading, which is how the answers that matter
  stop being read. Only declared questions are sent, and an answer to a
  question this laboratory did not ask is dropped rather than smuggled
  through — an unasked observation invites an interpretation this end cannot
  predict. Answers ride as OBX after the OBR they qualify, and an unanswered
  optional question sends no segment at all, because an OBX with an empty
  value asserts that somebody answered and said nothing.

  Hazards H-146 and H-147.

## Unreleased

**Added**

- **The outbound order path is reachable** (`POST /api/clinical/order-send`,
  `POST /api/clinical/order-cancel-send`). Four merged changes built a message,
  a transmission model, an acknowledgement reading and a cancellation, and
  nothing could call any of it: every order read as "not sent" and was,
  correctly and permanently, because there was no way to send one.

  The route declaration now carries what a send needs — endpoint, the four MSH
  identities, the clinic's timezone offset and the laboratory profile — and
  **all of it is checked when the declaration is made, not when somebody
  presses send.** A route that promises to carry orders and cannot is a promise
  the record makes on a site's behalf, and the moment it is discovered should
  not be the moment a specimen is sitting in a fridge. A site that has declared
  it does not transmit needs none of it and is not made to invent an endpoint.

  **The connection is read from the declared route, never from the request.**
  The caller names the order, and may supply ask-at-order-entry answers and
  specimen detail; it may not name a destination. Anybody who could would be
  able to direct a named patient's requisition, with their identifiers and
  clinical indication, to a host of their choosing. A route naming a profile
  that is not loaded refuses rather than falling back to a generic reading,
  because a message built against a guess is the failure the profile exists to
  prevent.

  Sending is an access to the chart — the message is built from it — so it goes
  through the same patient-directive check as any other read, and is audited
  either way, with the acknowledgement outcome in the detail.

  Hazards H-153 to H-155.

- **The specimen travels with the order, when there is one** (`SpecimenDetail`,
  SPM on the outbound message). Type, collection time, tube identifier and
  source site.

  The design decision is the absence. Most orders are placed before anybody
  draws anything — the clinician orders now, phlebotomy happens later — so an
  order at that moment has no specimen, and **no specimen means no segment**.
  The accommodating implementation invents one, filling the collection time
  with the order time or with now because it makes the message look complete.

  That invention is dangerous in a specific way: a timed test is defined by
  when it was drawn. A vancomycin trough drawn an hour after the dose is not a
  trough; a cortisol at four in the afternoon is not a morning cortisol. The
  value is interpreted against the time, so a stamped-wrong time produces a
  valid-looking result for a test that was never performed as ordered, and
  nothing downstream can recover the difference from the tube.

  So a collection time is never defaulted; a specimen asserted without a type
  or a time refuses the message; a time that is not a time refuses it; and a
  time later than the moment of sending refuses it, because that is a typing
  error and forwarding it makes it the time the result is read against. A time
  *earlier* than the order is accepted — drawing first and entering the order
  afterwards is ordinary practice. Optional fields stay absent rather than
  empty: a tube with no barcode is real, and an empty field asserting "no
  source site" is a different claim from not saying.

  Hazards H-151 and H-152.

**Fixed**

- **The worklist called an order nobody sent a laboratory being slow** (H-148).
  "Orders awaiting a result" was built from orders past their expected date
  without asking whether anybody had ever received them. On a site with no
  outbound interface — which is every site until one is commissioned — an
  order appeared there, went overdue, and read as a slow laboratory. The
  clinician telephones a department that has never heard of it, is told there
  is nothing, and has no reason to suspect the requisition never left. The
  test stays undone while looking chased.

  The transmission work made that knowable and then left it unsaid, which is
  the worse half: the record knew, and the screen did not. The section now
  holds only orders a laboratory plausibly has — acknowledged, or at a site
  that has declared its requisitions travel on paper with the specimen — and
  everything else appears under **"Orders no laboratory has"**. Different
  headings because they need different actions: one is a telephone call, the
  other is a send. It is drawn from `notWithFiller()` rather than from
  `awaitingResult()`, so an unsent order appears when it is placed rather than
  only once it is already late; an order nobody sent does not become worth
  knowing about on the day it was due.

- **The cancelled-orders list could not be read** (H-149). The store answered
  "which orders did we cancel that a laboratory still holds" and nothing asked
  it — no route, no worklist section, no screen. That is the most urgent list
  in the ordering work, the one where the specimen is still due to be taken
  from a patient who was told the test was called off, and it was reachable
  only by a caller who already knew to look. Now an audited route
  (`GET /api/clinical/orders-cancelled-still-with-filler`) and a named
  worklist section.

- **A chase list that would have become wallpaper** (H-150). `notWithFiller()`
  listed orders at sites that had declared they do not transmit, forever. A
  site that prints its requisitions has answered the question, so every open
  order there sat on the list permanently and the genuinely unsent order in
  among them would not have been seen. Declared non-transmitting sites are
  excluded; undeclared ones are not, because nobody has said, and there every
  order is a real question.

## 0.8.0 — 2026-08-27

A release about what the record admits it does not know. 0.7.0 stopped the
system trusting a silence on the way out; this one stops it manufacturing
confidence on the way in.

Ten validated instruments now score risk, and refuse to when an input is
missing — because the arithmetic that treats an undrawn urea as a normal one
makes a patient read as safer for having been less investigated. Feeding those
same instruments from the chart adds the second version of that failure, a
value that is present but old, so every input carries a clock and a NEWS2 built
from this morning's observations refuses rather than describing a patient who
may since have deteriorated. A laboratory harness reads a vendor's own messages
before anybody trusts the interface, and states in the report what a clean run
does not establish. Documents, procedures and care plans stop being notes and
become facts with structure, which is what makes their absence visible.
Enrolment is attested by a named clerk who writes how they checked, rather than
inferred from a token.

And the product is now called Northstar — a rename carried out on the
principle that it must not move anything a running site depends on. The
database, the backups, the environment, the tenant claim, the metrics and the
wire all still answer to their old names, because every one of those failures
would have been silent.

**Added**

- **Patient-supplied documents as chart facts, not notes.** They write onto
  the existing append-only clinical record as `DocumentReference` with
  category `patient-supplied`, so the notes module will not read them as SOAP.
  A title, a source and a received date are required; the bytes are optional.
  Lists and the patient summary carry metadata only. HTML, SVG and
  executables are refused; a payload over 256 KiB is refused. An empty panel
  is `never-received`, not none. Locking `DocumentReference` withholds both
  clinic notes and patient-supplied documents. Not a portal, not a virus
  scanner, not WCAG. Hazards H-124 to H-127. 846 tests.

- **Procedures and care plans as first-class chart stores.** They write
  onto the existing append-only clinical record. A completed procedure
  needs the date it was performed; a not-done procedure needs twelve
  characters of reason. An empty procedure panel is `never-recorded`, not
  none. A care plan needs a goal and a review date (`reviewBy`, not faked
  as `period.end`); completing it needs a written outcome and revoking it
  needs a written reason, both as amendments. An active plan past its
  review date is a worklist item, service-wide like a stalled referral.
  Visit assembly gives procedures their own section. The patient summary
  carries procedures and active care plans. Not CDS, not a specialty
  procedure library, not a provincial care-plan product. Hazards H-118 to
  H-123. 839 tests.

- **Clinic-attested enrolment, and notices that publish fact rather than the
  chart.** Binding an OAuth subject to a chart is no longer `grantSelf` with
  nothing on the record saying how the clerk knew. A named person writes, in
  their own words, how they checked — twelve characters, same bar as breaking
  glass — and only then does the existing grant path run. A pending row is
  not authority. `GET /me` still does not enrol anyone; there is no
  `/patient/enrol`. Proxy enrolments still need an expiry, a purpose and
  explicit permissions. Completing an access request queues a notice whose
  payload is the fact, never a result value. Dispatching that notice onto the
  same configured channel as break-glass is not recording that the patient
  was told. No channel is a visible failure, not a quiet skip. Not
  identity-proofing, not ONE ID, not a certified portal, not WCAG. Hazards
  H-114 to H-117. 826 tests.

- **Risk scores computed from the chart, with a clock on every input**
  (`src/clinical/score-from-chart.ts`, `POST /api/clinical/chart-score`).
  Hand-supplied scores refuse a missing input. Feeding the same instruments
  from the chart adds the failure the hand-supplied form cannot have: **a value
  that is present but old.**

  A NEWS2 assembled from the most recent vitals is a NEWS2 of whenever those
  vitals were taken. If the last set was at 06:00 and it is now 20:00, the
  number describes a patient from fourteen hours ago and puts today's date on
  it — a complete set of real measurements, every field populated, rendering as
  confidently as one taken five minutes ago. It is not wrong about the past; it
  is wrong about now, which is the only tense anybody reads it in.

  So every input carries a maximum age, and a value past its window is not a
  value: it falls through to `missing` and the instrument refuses exactly as it
  would for a measurement nobody took. The windows differ because the clinical
  question does — NEWS2 accepts four hours, CURB-65 twelve — and every score
  reports the age of its stalest input, because a score is only as current as
  the oldest thing it rests on.

  Nothing the chart does not hold is defaulted. NEWS2 needs to know whether the
  patient is on supplemental oxygen and whether they are alert; neither is a
  vital sign, and both plausible defaults understate — by two points and three
  respectively, on the instrument that exists to escalate exactly those
  patients. They are reported as unavailable with the size of the
  understatement, so an interface can ask for precisely what is missing.

  Comorbidity indices are deliberately not derived from diagnosis codes:
  mapping ICD-10 onto Charlson's categories is real terminology work whose
  failure mode is a confident lower score, and it deserves its own design
  rather than a plausible lookup table. Hazards H-104 and H-105.

- **A laboratory conformance harness** (`src/orders/conformance.ts`, `npm run
  labcheck`). A laboratory interface is agreed on paper and discovered in
  practice: the specification says the accession number is in ORC-3 and the
  messages put it in OBR-3; the specification does not mention a timezone and
  every result lands an hour out. None of it is visible until real messages
  meet real parsing code, and by then the interface is usually live.

  The harness reads a laboratory's own sample messages against a profile and
  reports, per message and in aggregate, what parsed, what refused and why,
  which fields were absent, and which assumptions had to be made — each with
  the question to put to their integration analyst. A message that will not
  parse is a finding rather than an exception, so fifty messages produce one
  report instead of fifty round trips. Findings are marked blocking or not:
  a missing accession number is answerable, while a patient identifier the
  profile can never match would hold every result for identity.

  What it will not do is conclude that an interface conforms. Every report
  states that a sample set exercises only what it happens to contain, and that
  nothing was inferred into a profile — guessing field locations from a sample
  and calling the result a vendor interface is the failure `labs/README.md`
  exists to refuse. Hazard H-103.

- **Ten validated clinical risk scores** — CURB-65, CHA₂DS₂-VASc, HAS-BLED,
  Wells for PE, HEART, MELD-Na, CIWA-Ar, Charlson, LACE and NEWS2, in
  `src/clinical/scores.ts`, with `POST /api/clinical/score`.

  The arithmetic is the easy half. The reason the module is shaped the way it
  is: the obvious implementation of CURB-65 asks `urea > 7 ? 1 : 0`, and a
  patient whose urea was never drawn then scores zero for that criterion —
  identical to a patient whose urea came back normal. The total is lower, the
  band is milder, and the recommendation moves toward discharge. **The patient
  reads as safer because less is known about them.** That is the allergy list
  that is empty because nobody asked, wearing a different name.

  So a score with a missing input is not a score. It returns
  `{ complete: false, missing: [...] }`, which has no `score` field at all —
  there is no number to render and no way to misread one. Each criterion
  distinguishes three states, not two: present, looked-for-and-absent, and
  unstated; only the last refuses.

  NEWS2 escalates on any single parameter scoring 3 even when the aggregate is
  low, because a patient can be profoundly abnormal in one axis and
  unremarkable in the rest. Every result carries the instrument's published
  interpretation rather than an instruction, and HAS-BLED says in words that a
  high score is a prompt to address modifiable risk, not a reason to withhold
  anticoagulation. Hazards H-100 through H-102.

  This is decision support, not a decision, and Northstar is not a certified
  medical device.

**Changed**

- **Portage is now Northstar.** The product, the documentation, the admin UI
  and the package name. Release notes below this entry keep the old name,
  because that is what those versions shipped as.

  **An existing site upgrades with no configuration changes at all.** That is
  the part worth stating plainly, because almost nothing about a rename fails
  loudly, and every one of these would have been silent:

  - **The database.** SQLite creates what it cannot open. A build looking for
    `northstar.db` in a directory holding `portage.db` does not error — it
    makes an empty database, and the site comes up healthy with no patients in
    it. An existing file now always wins over the preferred name, whichever
    name it carries, and opening one under its old name is announced at boot.
    Renaming it is an operator step taken with the engine stopped, documented
    with the `-wal` and `-shm` sidecars that have to move with it.

  - **Backups.** The snapshot listers matched a filename prefix. Changing it
    would have made every existing snapshot invisible at once — nothing to
    restore, and a reading-station check reporting no recent backup, for a site
    whose snapshots were sitting right there. Both prefixes are matched on
    every read path. Ordering moved off the filename at the same time: a plain
    sort puts `northstar-` before `portage-`, which would have placed today's
    snapshot at the oldest end of the list, handed a restore a two-month-old
    database, and had retention delete the newest file it had.

  - **Environment variables.** `PORTAGE_*` is read alongside `NORTHSTAR_*`, the
    new name winning where both are set, so a unit file can migrate one line at
    a time. Reading only the new names would not have thrown; the values would
    have gone absent, and absent means TLS off, encryption unasserted,
    authentication unconfigured, on a site that had configured all three.

  - **Identity.** `portage_tenant`, `portage_organization` and
    `portage_practitioner` are still accepted, and are not scheduled for
    removal — the claim name lives in somebody's Keycloak realm, not in this
    repository. An unread tenant claim arrives as an absence rather than an
    error, and every downstream check would then decide tenancy on nothing.
    That is the one failure here that ends with one site reading another's
    charts. `portage/admin` likewise still grants admin, because the scope is
    inside tokens already issued.

  - **Metrics.** Every series is exposed under both `northstar_*` and
    `portage_*`. A renamed metric does not break an alerting rule loudly — the
    series stops existing, the rule evaluates against no data, and the alert
    watching for a dead-letter backlog quietly never fires again.

  - **The wire.** MSH-3 on outbound acknowledgements is still `PORTAGE`. It is
    not branding: it is the receiving-application name each sending facility
    typed into their own interface configuration, and changing it unilaterally
    has their engine reject our acknowledgements — visible at their end as
    messages never acknowledged, and not visible at ours at all. It moves when
    a deployment sets `NORTHSTAR_HL7_APPLICATION`, having agreed the change
    with the sites on the other end.

  Two identifier namespaces also keep their spelling: the audit-export URN
  `urn:portage:principal:*`, and the `https://portage.dev/fhir/NamingSystem/*`
  systems the shipped mappings stamp onto resource identifiers. A namespace
  identifier exists to be stable. Moving them would give resources created
  either side of the rename different identifier systems, so the same
  observation ingested twice would stop matching itself and file as two — and
  audit exports from before and after would no longer be comparable. Both name
  an identifier scheme, not the product.

  Hazards H-108 to H-113, `docs/RUNBOOK.md` → "Upgrading a site installed as
  Portage", and `test/rename-compat.test.ts`, whose regressions were checked
  against the unfixed source.

**Fixed**

- **The not-on-care-team flag never fired on real traffic** (H-106). The
  privacy office's review joined `principal_id` and required
  `principal_kind = "practitioner"` — but an HTTP audit row records the
  *credential* on `principal_id`, with kind `apikey` or `oauth`, and the
  clinician on `practitioner_id`. So every access through the API was skipped,
  and the flag that exists to catch a clinician reading a chart they have no
  part in never fired where it mattered. Worse than silent: the review
  reported a clean period because it had examined nothing. It now joins
  `practitioner_id`, the identity `AccessReview` already uses, and a
  credential naming no practitioner is excluded because it cannot be on a
  team.

- **A disclosure could outlive the request it answered** (H-107).
  `fulfillAccess` recorded the disclosure and completed the request as two
  independent writes. A failure between them left the ledger saying the chart
  had gone out while the queue said nobody had answered, and a retry recorded
  a second disclosure for one release. Both writes now share one transaction.

  Both fixes were found by a Cursor review that never reached `main`; the
  branch had gone too stale to merge, so they are ported here with regression
  tests verified to fail against the unfixed source.

- **The README claimed the clinical platform had no user interface.** It has
  had a chart, a worklist, break-glass and the privacy inbox for two releases,
  and a patient access page in English and French. An understatement is still
  an inaccuracy, and the Status section is load-bearing precisely because its
  caveats are meant to be exact. It now says which parts have a screen and
  which are API-only.

- **Nothing checked that the reported capability version was the shipped one.**
  Three files carry the version at a release and only `src/version.ts` is read
  at runtime, so forgetting it failed no build and no test — it shipped a
  CapabilityStatement telling every federation partner it was talking to the
  previous release. `src/version.ts` and `package.json` are now pinned to each
  other, and to what the statement actually reports, rather than to a literal
  that would be a third place to forget.

## 0.7.0 — 2026-08-26

What a prescription does after it leaves, and what an extract does before it
arrives. 0.6.0 made the system operable in the north; this closes the two
places where it was still trusting a silence — a pharmacy that never said
whether the patient collected the drug, and a migration that could report
success for records it never read.

**Added**

- **Value sets and concept maps from real releases** (#23, in part). Concepts
  already loaded from a licensed distribution; memberships and mappings were
  hand-written pack JSON, which is fine for a fixture and does not survive a
  real terminology release where one value set is thousands of codes revised
  quarterly. `src/terminology/loaders/valuesets.ts` reads FHIR ValueSet and
  ConceptMap resources, plus SNOMED RF2 simple refsets and extended cross-maps,
  and `scripts/import-terminology.ts` gained `--format valueset|conceptmap|refset|map`.

  The rule it is built around is a refusal: **a value set that cannot be fully
  resolved does not import at all.** FHIR allows an intensional definition —
  "every descendant of 73211009" — and expanding that needs a terminology
  server that knows the hierarchy, which this store deliberately is not.
  Importing the enumerated part and ignoring the filter would produce a value
  set with the publisher's name and a smaller membership, no error anywhere,
  and every membership check against it silently wrong. A filter, a grouped
  expansion, a reference to another value set, a whole-code-system include or
  any exclusion refuses the whole import and names the supported path: obtain
  the expansion from a terminology server. A server-produced expansion is
  preferred over the definition when the resource carries one.

  Mappings keep their `equivalence` (R4) or `relationship` (R5), because
  "wider" is a different clinical claim from "equivalent" and flattening them
  would assert a precision the publisher declined to. A code the publisher
  states is `unmatched` is reported as answered rather than imported as a
  mapping to nothing. Hazards H-98 and H-99.

- **An honest conformance status table** (#23, in part). The README now says
  per pack what is enforced, how many rules, and — the column that matters —
  that **none has been scored against Infoway's Projectathon scripts**. Every
  rule encodes this project's reading of a specification, and a pack that
  passes its own rules and fails a Projectathon script is a plausible guess
  with a test suite. The table is checked against the packs by
  `test/conformance.test.ts`, so a claim cannot drift past what the packs do.

- **A reader for a real export format** (#20). The loader took normalised
  records and something had to produce them. `src/migrate/read-fhir.ts` reads
  a FHIR Bundle or a bulk NDJSON export into `SourceRecord`s.

  The rule is the migration module's one rule, one layer earlier: **nothing is
  skipped.** A resource the reader cannot map comes back in `unreadable` with
  its reason and the resource itself; a resource it can map but the stores
  will refuse — an allergy with no substance, a record whose chart never
  arrived — becomes a record anyway and lands in the reject queue with its
  payload. A reader that quietly skipped what it did not understand would
  produce a clean run of everything it happened to recognise, reconciling
  against a number nobody chose.

  The declaration comes from the bundle's own `total`, never inferred from the
  entries: a count derived from what arrived cannot disagree with what
  arrived. NDJSON carries no total, and that is reported as a gap rather than
  filled in from the line count. Patients are ordered first regardless of
  export order, so an export listing an allergy before its patient does not
  reconcile as a pile of rejections that are really one ordering problem.

  FHIR because it is published and this repository can check its reading of it
  against the conformance packs it already carries. It is not a claim that
  every incumbent exports FHIR — most export a database dump or a delimited
  file, and that needs a per-deployment adapter, for which `SourceRecord` is
  the seam. Hazard H-97.

- **A migration you can rehearse** (#20). A migration is the riskiest day in
  a deployment's life, and the way to survive it is to have already done it.
  `dryRun()` runs the whole load — the real records, through the ordinary
  stores — inside a transaction that is always rolled back, and returns the
  same reconciliation report a real run would.

  It is deliberately not a separate validator. A checker written alongside the
  loader is a second opinion that drifts from the first, approving records the
  real load would refuse; this one *is* the loader, so it cannot disagree with
  itself. Nothing survives it either — not the run, not the record
  bookkeeping, not the chart writes — because a rehearsal whose bookkeeping
  persisted would make every record come back `unchanged` on the real load and
  migrate nothing, silently.

  The report says what a rehearsal cannot prove: that it describes this
  database today, that a record loading cleanly now can be refused at cutover
  if something takes its key first, and that a batch was validated in the
  order it was given. A dry run with nothing declared still reconciles
  perfectly and still means nothing — the same trap as the real run, reported
  the same way. Hazard H-96.

- **What the pharmacy did with the prescription** (#40). "Prescribed" and
  "dispensed" are different facts, and a chart that cannot tell them apart is
  misleading in the direction that causes harm: a medication the patient never
  collected is not a medication they are taking, and it reads as one on every
  screen that shows the prescription alone. A dispense is now its own recorded
  event — full, partial, or a pharmacy reporting that it was never picked up —
  and `dispenseState()` answers with `dispensed`, `partially-dispensed`,
  `not-collected`, `awaiting` or `unknown`.

  The load-bearing part is `unknown`. Most pharmacies send no dispense
  notification, so an absent record usually means nothing at all, and calling
  that "never collected" would flag every prescription sent to a quiet pharmacy
  until a clinician learned to ignore the list. Dispense reporting is declared
  per pharmacy and **snapshotted onto the prescription at transmission**, so a
  declaration made later never rewrites what an older silence meant, and
  `neverCollected()` is confined to the pharmacies that would have spoken.

  A dispense against a **cancelled** prescription is deliberately recorded
  rather than refused, and surfaced: refusing it would delete the only evidence
  that a stopped drug was handed over. Hazards H-91 through H-93.

- **The prescriber's safety check travels with the script** (#40). A pharmacist
  runs their own check — that is the point of two professionals — but cannot
  reconstruct what the prescriber's check saw or what they signed past. Every
  finding now travels, not only the blocking ones, with the override reason;
  and a prescription written without a recorded check transmits `null` rather
  than anything a pharmacy could read as checked-and-clear. Hazard H-94.

- **A renewal request is work, not a message** (#40). A pharmacy asking for a
  repeat arrives as an item in the unified worklist, correlated to the
  prescription so three requests in six weeks read as a pattern rather than as
  three unrelated items, and closable only with evidence of what was decided.
  With no worklist wired in it is refused rather than recorded somewhere nobody
  looks. Hazard H-95.

## 0.6.0 — 2026-08-26

Running it in the north: a chart that stays readable when the link is down, a
privacy office somebody can actually run, and numbers that can leave the
building without taking a name with them.

**Added**

- **A design for more than one writer, before any code** (#25).
  [`docs/MULTI-WRITER.md`](docs/MULTI-WRITER.md) names the six claims a
  multi-writer design must not weaken — ordered delivery per ordering key,
  three verifying hash chains, the per-tenant audit counter that makes
  truncation detectable, the scheduling unique index, tenant isolation, and
  an acknowledgement meaning durably queued — then takes the candidates
  against all six. Two engines on one file and multi-master for one tenant
  are ruled out (the latter breaks five of the six, and splicing forked
  chains is byte-for-byte what tampering looks like). Read scaling is ruled
  **in**, by generalizing the reading station already built for #38.
  Store-and-forward ingest edges are the one honest second writer, at the
  cost of restating what an acknowledgement means where an edge issues one;
  tenant partitioning is the capacity path if capacity ever becomes the
  demand. No code, and #25 stays open: the proposal is its first checkbox,
  not its last.

- **De-identified release with small-cell suppression** (#54). The registry
  answers honestly inside the walls; nothing patient-shaped may leave them,
  because in the communities this system is built for a small count is a
  name — "3 of 41 diabetics uncontrolled" identifies people to anyone who
  knows a community of 300, and so does "38 of 41 controlled", because
  subtraction works. `POST /api/clinical/release` turns a measure or a
  care-gap summary into aggregate counts with no identifiers anywhere in the
  document: counts from 1 to threshold−1 suppressed (default 5, floor 2,
  refused below as suppression in name only), zeroes published, complements
  suppressed where a published total would hand a suppressed count back, and
  a rate withheld when it would divide the secret back out. The method is on
  the face of the document, unclassified patients stay counted, and a
  release does not exist without a recipient and a purpose — both of which
  land on the chained trail, because an extract with nobody it goes to is a
  leak with paperwork pending. Consent for secondary use is named as a
  governance decision the release does not decide. Hazards H-89 and H-90.

- **A readable chart when the link is down** (#38, complete). The outage demo
  covered the write path: the queue holds, order survives, everything drains on
  reconnection. The read path had no equivalent, and a nurse in a community
  during a forty-hour outage could queue what they wrote and see nothing of
  what was already known. A **reading station** closes it — the same binary
  over a restored, verified snapshot, so the cache inherits a rehearsed
  procedure instead of a sync protocol nobody has tested. It dates itself from
  the snapshot's own stamp rather than from when the copy landed, so a chart
  never understates its age. Consent decides exactly as at the primary, from
  the directives the snapshot carried. The station is read-only and its
  refusal names the queue and the paper form. Past its serving budget it
  refuses every clinical route and destroys the clinical cache on its own,
  keeping the trail it still owes the primary — because reads that happened
  offline still have to reach an access review. Those reconcile by appending
  to the primary's chain, never rewriting it, each row carrying the station,
  the time of the read and the station's own seq; a station chain that does
  not verify is reported as an incident rather than dropped. Hazards H-84
  through H-88; R-20 records what remains. `demo/satlink-read.ts` walks the
  whole outage.
- **The offline chart, designed before it is built** (#38, part one).
  [docs/OFFLINE-CHART.md](docs/OFFLINE-CHART.md) is the written design the
  issue asks for first: a reading station — the same binary against the same
  schema, fed by the verified snapshot machinery that already exists, never a
  browser cache — serving read-only during an outage under one serving budget
  that bounds directive freshness and key revocation alike, auditing locally
  on its own chain and reconciling by append when the link returns, expiring
  and purging on its own if it never does. The piece everything else rests on
  ships now: `stale` joins `unavailable`, `truncated` and `withheld` as a
  first-class incompleteness. A chart assembled with an `asOf` is never
  complete — every panel says "as of N hours ago", the summary carries a
  stale block, the console banners it before anything else, and an age that
  cannot be established refuses to serve rather than serving as fresh.
  Hazard H-83; residual R-19 says nothing serves a cached chart until the
  station is built to the design.
- **Reversible chart linking** (#34). `duplicates()` finds two charts that may
  be one person and declines to merge them, because merging is how a chart
  acquires someone else's allergies and there is no honest way to unmerge. A
  link is the assertion that objection leaves open: made by a person, on
  evidence that is kept, withdrawn with a reason that is kept, never inferred.
  The chart assembles across the members of a link with every row still
  attributed to the chart it was written on — which is what makes an unlink
  restore the prior view exactly. The assembled chart says on its face that
  it is assembled; every summary status is the worst member's answer; a
  directive on any member withholds or locks the assembly, break-glass lifts
  only the member it was broken for, and the read lands on every member's
  audit trail. The patient portal stays deliberately blind to links: a grant
  names one chart and serves one chart. The medication safety check answers
  for the person the link asserts — allergies and current medications union
  across the members — and consent composes into it the way it composes into
  the chart, member by member and section by section, the named patient
  included: a whole-record directive refuses the check with the break-glass
  path, a locked section stays out of the union, and every gap is a blocking
  finding, never silence. The named chart's audit row lands on every answer,
  even one the directives emptied.
- **A privacy office a privacy officer can actually run** (#35). The
  audit trail records and proves, and answers none of the questions a
  privacy office asks. A chain nobody reads proves only that nobody
  tampered with a log nobody reads.

  Reviews cannot close with unaddressed flags; addressing a flag needs a
  written reason. A legal hold skips the whole message-log retention
  sweep, because messages are not patient-keyed. An incident cannot close
  without a written account and whether patients were told. Access clocks
  are a queue, not a hard stop; fulfilling an access request records a
  disclosure (section names and counts, not a second chart); completing
  without one is flagged, not blocked. The assurance catalogue cannot
  close a finding by forgetting remediation or residual risk.
  `BACKUP-02` stays partial. An active subprocessor needs a hosting
  region. After-hours is decided from a UTC timestamp.

  Privacy-office HTTP does not apply a patient lockbox: a directive that
  hid the office from the record it is charged with reviewing would be a
  lock with no key. Still tenant-scoped; the trail says the directive was
  not applied.

  **`GET /me`** is a static English/French shell with landmarks and an
  honest banner. Not a certified portal: no identity-proofing,
  notifications, or WCAG claim. Chart access remains `/patient/*` plus
  OAuth. Unauthenticated GETs are not audited as a reach for a patient.

  The clinician console gains a Privacy tab. Hazards H-70–H-76.

  596 → 611 tests for the office itself; 654 after merging the trail
  join, travelling clinics, and the config ledger. Its hazards are
  H-70–H-76; chart linking's moved to H-77–H-82 when the two lines met.

- **Channel configuration as a ledger** (#36). Everything else here is
  provenance-carrying — messages chain, the record is append-only, audit rows
  chain — and the configuration that decides how all of it is produced was
  overwritten in place. Every change is now a version with who, when, why and
  how it came to be; the first versioned change on a pre-existing channel
  captures the state it found, so upgrading cannot destroy the last
  unversioned config. Versions diff at the field. A rollback restores old
  content as a new version — never by mutation — and brings a deleted channel
  back, because deletion is a marker in the history rather than the end of
  one. `GET /api/channels/export` and `POST /api/channels/import` move the
  whole configuration as the document source control holds: the import is a
  plan before it is an action, a dry run writes nothing, and what the
  document does not mention is reported, never deleted.
- **Every message records which configuration processed it.** The lineage
  claim the rest of the system makes, extended to the config boundary: a
  message that went wrong is traceable to the exact rules that were live when
  it did, instead of to whatever the config says now.

- **Travelling clinics** (#39). A visit — the block of slots a specialist's
  two days in a community actually are — is planned, repeated ("the same as
  last time" is one call), moved and cancelled as one thing. Its slots stay
  ordinary rows guarded by the same partial unique index, so nothing downstream
  knows visits exist. Cancelling a visit puts the common cause on every booking
  and every booked patient on the waitlist, bump counted, wait dated from when
  they first booked: the weather does not send anybody to the back of the line.
- **A waitlist whose ordering is stated policy** rather than an accident of
  insertion order: clinical priority, then waited-longest from first asking,
  then most-bumped as the tiebreak, computed in one place on purpose. A seat is
  offered to a specific patient and the offer resolves as accepted, declined or
  unreachable — recorded as the different facts they are, because collapsing
  "unreachable" into "declined" punishes people for where they live. A seat
  taken while an offer was out lapses the offer rather than wedging the queue
  or blaming the patient — and a seat withdrawn by the visit's own cancellation
  lapses the same way. One cancelled visit is one bump, however many seats the
  patient held on it; a seat for another service is refused rather than
  clearing the wrong queue; removing somebody closes their open offer, so
  resolving it later cannot write them back in; and an offer history presents
  in the order offers were made, by ledger rather than by clock. Offers say
  where the seat is, and say both places when the patient's community and the
  seat's differ.

- **An access review of the trail a privacy officer can run** (#35, trail
  half). Complementary to the operational office above, not a substitute
  for it. `GET /api/audit/review?patient=` answers what the trail held every
  ingredient for
  and could not be asked: who looked, under what declared purpose, whether
  anything clinical linked them to that patient, and what deserves attention
  first. Each flag — self-lookup, shared surname, no treatment relationship,
  break-glass, out-of-hours, unusual volume against that person's own median —
  says why it fired, and is a rule somebody can read and argue with rather than
  a model, which is the right standard for something that can end in an HR
  process. A flag is closed with a reason that is kept, because a review whose
  judgements vanish re-raises the same question next month with nothing to say
  it was answered. The chain's verification travels on the report: an extract
  attached to an investigation is worth what its source is worth.
- **Credentials carry a practitioner**, which is what made the above possible.
  The clinical stores have always recorded an actor and the audit trail a
  credential, with nothing joining them — so "did whoever read this chart have
  any reason to" was unanswerable from inside the database. A credential naming
  nobody is reported as `unattributable` rather than passed over: an access
  nothing could check must not look like one that was checked and passed.

- **Migration that cannot report success over a gap** (#20). What makes
  migration dangerous is that you cannot tell whether it worked by
  whether it errored: a run loading 96% of the allergies produces no
  error anywhere, and the missing 4% are invisible until somebody
  prescribes into one.

  So completeness is **declared and then checked**. A run records what
  the source system says it holds, and the report compares: counts agree
  is complete, counts disagree names the gap as records that neither
  loaded nor failed, and nothing declared says completeness *cannot be
  verified*. `complete` is never true because nothing threw, and closing
  over a gap takes a written reason that lands in the run's notes.

  Rejects keep their whole payload, so a rejection is a row somebody can
  open rather than a count. Loading goes through the ordinary stores, so
  a migration cannot load what the live system would refuse. Source codes
  and the loading run are preserved on every record. A migrated
  medication is `external-record` with `unknown` adherence, never
  `prescribed`. Loading is idempotent on source identity, so a resumed
  run or an unchanged delta row writes nothing.

  A trial rolls back by retraction, so the rollback is on the record. A
  cutover whose charts have been written to since refuses, naming who
  wrote. `validationSample()` spreads across record types, because counts
  reconciling does not mean a mapping is right.

  Not an extractor: getting data out of an incumbent system is that
  vendor's export. Hazards H-65–H-69.

  579 → 596 tests.

- **Prescriptions that reach a pharmacy, or say why not** (#40). A
  prescription was recorded carefully and then went nowhere; the pharmacy
  wrote it again at their end and the two records drifted apart. Four
  distinctions rather than a "sent" flag.

  **Not transmitted is a state.** `handOut()` records a prescription
  printed for the patient, and nothing then waits on an acknowledgement.
  What is refused is the third state — neither sent nor deliberately
  printed — and `neverSent()` is that queue.

  **Transmitting twice is a double dispense**, so a second transmission
  is refused. The only retry is `replaceFailed()`, which names the
  prescription it replaces so a pharmacy receiving both can tell they are
  one decision.

  **Sent is not received.** The transmission publishes onto a channel and
  is carried by the ordinary delivery machinery; until an
  acknowledgement is recorded it is on `awaitingAcknowledgement()`. With
  no channel configured, transmit refuses rather than recording it as
  sent. `cancellationsOwed()` is the worst list: cancelled after
  transmission with nobody having told the pharmacy.

  **A controlled substance** is refused unless the deployment declares
  the authority it holds, which is recorded on the prescription.

  No pharmacy network interface has exchanged a message. Hazards
  H-61–H-64.

  566 → 579 tests.

- **A laboratory result bridge that closes the order loop.** There was a
  channel mapping ORU messages onto the FHIR facade, and it was easy to
  mistake for a laboratory interface: it stored a copy of a value and left
  the order it answered on the overdue list. A `labresults` destination
  now files the result, completes the order and starts the
  acknowledgement clock.

  Four refusals carry it. A result whose patient cannot be identified is
  **held** for a person rather than matched on name or on the most recent
  order — an ambiguous identifier is a refusal too, since surfacing
  duplicate charts and declining to merge them would be pointless if the
  interface picked one. An identical **retransmission writes nothing**,
  keyed on accession, analyte and sub-id. A **correction** supersedes and
  arrives unacknowledged even if the old value was signed off. A **stale
  preliminary** arriving after the final is ignored and recorded as
  ignored. An unrecognised OBX-11 or OBX-8 is refused rather than
  defaulted to final or normal.

  Timestamps are not assumed to be UTC: an explicit offset is honoured, a
  profile's declared offset is applied, and a time with neither is filed
  as assumed and counted in `GET /api/clinical/lab-reconcile`.

  Laboratory dialects are configuration in `labs/`, not a fork per lab. A
  destination naming a profile that does not resolve fails the delivery
  rather than silently reading as generic.

  **No vendor interface is shipped or claimed.** There is no Dynacare or
  LifeLabs profile; that needs their conformance guide, a sandbox,
  credentials and a signed test result (R-18). Hazards H-55–H-60.

  538 → 566 tests.

- **The patient/proxy identity boundary** (#24 backend). SMART
  `patient/*` is a fourth, OAuth-only scope and never becomes general FHIR
  `read`; admin does not imply it and API keys cannot carry it. Every
  `/patient/*` request binds the token subject to a live grant for the
  named chart and checks an explicit capability. Proxy scope, purpose and
  expiry are required, and proxies cannot delegate onwards.

  The patient-safe surface serves summary data (not the clinician
  Workspace), visibly held results, appointments with their slots,
  messages whose speaker is derived from the grant, access history and
  delegate review/revocation. Access and correction requests leave a
  patient receipt and an unassigned clinic privacy task. Patient writes
  and both access trails commit together.

  This is a JSON boundary, not a patient application. Identity-proofing
  enrolment, EN/FR UX, notifications and accessibility validation remain.
  Hazards H-51–H-54.

  526 → 538 tests.

- **Durable patient–clinic messaging.** A thread is the record of a
  question, not a portal and not a delivery claim. Patient or proxy
  writing is `awaiting-clinic` and assigned to the MRP when there is one;
  unowned threads are a list. Closing needs a reason; closing while the
  patient is still waiting needs to say what was done. Replies on a
  closed thread are refused. The chart and the worklist surface open
  threads. Hazards H-49–H-50.

  519 → 526 tests.

- **The next slice of the longitudinal chart.** Immunizations and vitals
  are typed writes onto the existing clinical log — a refusal needs a
  reason, blood pressure needs both numbers, a laboratory Observation is
  not a vital, and `never-asked` / `never-measured` are statuses rather
  than empty panels. Care team and coverage are their own tables: at most
  one current primary, retirement is an end date, a coverage change
  supersedes rather than overwrites. The patient index carries preferred
  language and telecom and still rebuilds from the log. Today's
  appointments sit on the clinician worklist. The chart, the HTTP API and
  the console surface all four. The provincial specification is not
  claimed; [docs/PROVINCIAL.md](docs/PROVINCIAL.md) is the gap map.

  Hazards H-45–H-48 in the safety case.

  498 → 519 tests.

- **A clinical safety case and hazard log** (#21). The hazards were already
  in the module headers; they had no severity, no likelihood, no named
  owner and no evidence trail a safety officer could follow.
  [docs/CLINICAL-SAFETY.md](docs/CLINICAL-SAFETY.md) is DCB0129-shaped, not
  certified, and not a substitute for a named clinician. Residual risks
  from the README's honest limits are restated there. A source-reading
  test fails if a cited test is renamed or deleted.

  497 → 498 tests.

**Fixed**

- **`phi()` distinguishes a store refusal from a fault** (#26). A `Refusal`
  (a full slot, a malformed visit, a result already signed off) keeps the
  status the store chose — `SlotFull` is 409 — and is audit outcome 4. An
  unrecognised exception is 500 with a generic body; the real message is on
  the trail and the log. `POST /api/clinical/book` is the write that makes
  a full slot reachable over HTTP.

- **The `migrate()` rebuild is FK-safe** (#27). Foreign keys are turned off
  *outside* the rebuild transaction (`PRAGMA foreign_keys` is a no-op
  inside one), and `PRAGMA foreign_key_check` runs before they go back on.
  SCHEMA has no `REFERENCES` today; the procedure is what keeps the next
  one from deleting rows or refusing to boot.

**Added**

- **The directory is served as FHIR** (#33). `Practitioner`,
  `PractitionerRole`, `Organization`, `Location` and `HealthcareService`
  are projected from the local registry onto the facade. A write that
  arrives as one of those types is ingested when it can be, and ignored
  when it cannot — a Patient upsert does not fail because the directory
  has no opinion about a patient.

  488 → 497 tests.

- **A snapshot that leaves the machine** (#37). `takeBackup` still writes a
  verified local file; that file does not survive the disk dying, and the
  stated RPO was only real for failures that spare the backup directory. A
  configured `PORTAGE_BACKUP_REMOTE` (`s3://`, `sftp://`, or `fs:`) encrypts
  the snapshot with a key from `PORTAGE_BACKUP_KEY_FILE`, puts it, *reads it
  back*, decrypts it and walks the chains again before success is reported.
  An upload that returned 200 is not a copy. Remote retention
  (`PORTAGE_BACKUP_REMOTE_KEEP`) is independent of local keep. A destination
  that refuses deletes — write-only credentials or object-lock — is reported
  as immutable rather than as a failed backup.

  The key has to outlive the host. A key that only this machine can read
  unlocks nothing after the flood, and boot says so if the key file appears
  to share a volume with the database. HTTPS is required for an S3 endpoint
  that is not loopback. There is no AWS SDK: the four calls a backup needs
  are SigV4-signed `fetch`.

  A failed replica is visible on `/api/health` (`remoteBackup`) and
  `/metrics` (`portage_backup_remote_ok`, `_age_seconds`, `_configured`) and
  marks the node degraded. Unconfigured is a posture, reported at boot and
  on health, not degraded. `npm run restore -- --from remote` fetches and
  decrypts so recovery does not begin with a manual download. The nightly
  restore rehearsal goes through the replica and deletes the local snapshot
  first, so what comes back is the copy that left.

  448 → 488 tests.

- **Organization identity on credentials** (#17), which is what makes a
  `withhold-from-organization` directive mean something. The directive matched
  on a field no `Principal` carried and nothing ever passed, so it was recorded,
  reported to the patient as active, and enforced by nothing; the 0.5.0 fix made
  it fail closed, which withheld the record from every caller in the territory
  when the patient had named one clinic. An API key now carries an organization
  set at issue time and checked against the directory, an OAuth token carries
  one from the `organization` (or `portage_organization`) claim, and both come
  off the credential rather than off the request — a caller that could name its
  own organization could name its way out of a directive. A directive against
  one organization no longer withholds from another; a credential that names
  none still cannot show it is outside the withheld one, and is still refused.
- **Break-glass notices are dispatched** (#18), not merely owed. An override
  becomes a message on a channel the deployment configures, carried by the same
  ordered, retried, dead-lettered machinery as any other clinical message —
  `breakGlassNoticeChannel` names it, and leaving it unset keeps the previous
  behaviour rather than pretending to send. Portage resolves no addresses: it
  holds nothing to reach a patient by, and inventing a destination for a
  disclosure notice sends somebody's private business to a stranger, so routing
  belongs to whatever the deployment already uses to reach patients.

  Three facts are now kept apart that were one: *sent*
  (`notice_dispatched_at`, with the message it became), *told*
  (`patient_notified_at`, still a deliberate human act), and *could not send*
  (`notice_error`). A notice that failed is on `undeliveredNotices` with the
  reason rather than looking exactly like one nobody has got to yet.
  `overdueNotification()` is the escalation the queue never had — it had no
  upper bound on how long somebody could go untold. `POST
  /api/clinical/break-glass-dispatch` retries, and never sends twice.

  A dispatch failure cannot stop somebody breaking glass. A clinician refused
  over an unconscious patient because a broker is down is how a shared login
  gets created, which is worse in every respect including the audit trail.
- **Which organization looked** is on the audit trail beside who and why, and
  `AuditFilter.organization` asks the question directly. "Did anyone at that
  clinic read this record" is what a privacy review asks, and the trail could
  not answer it.

- **Encounters** (#32) — the visit, and everything that happened inside it.
  `encounter_id` had been a column on orders, medication statements,
  reconciliations and clinical entries since they were written, and no table
  owned one, so it named something the system could not describe. A visit now
  has a class, a status, a period, a location, participants with roles, and a
  disposition; `GET /api/clinical/encounter` assembles what belongs to it with
  the same per-section completeness as the chart, so a section that failed says
  so instead of reading as "nothing was ordered at this visit".
- A worklist of visits still open (`GET /api/clinical/encounters-open`), with an
  age threshold, so a visit cannot stay open indefinitely without somebody
  seeing it — everything filed against an open visit inherits its ambiguity,
  and a discharge summary cannot be produced for one that has not ended.
- `POST /api/clinical/encounter-open`, `-arrive`, `-close` and `-cancel`, each
  through the same directive check as a read: a caller who may not see a
  patient's record may not start adding to it either.
- **A provider, organization, location and service directory** (#33), with
  roles and first-class identifiers. A scheduler slot said `dr-tetso` and a
  referral said "Stanton Orthopaedics", and neither resolved to anything.
  Organization is modelled separately from tenancy, because several
  organizations operate inside one custodian's tenant — conflating them is what
  would make a `withhold-from-organization` directive (#17) withhold a record
  from the whole territory rather than from one clinic.
- Directory entries are **retired, never deleted**: a clinic that closes must
  not break the referral sent to it two years ago, so `retire()` sets an end
  date and the reference keeps resolving as known-and-inactive, which is a more
  useful answer than either "gone" or "current".
- `Schedule.openSlot()` accepts a typed `resource: { kind, id }` that is
  validated against the directory, and `resolveResource()` answers for any
  slot including those written before the directory existed. A referral target
  is now three-valued — a known service, a **declared** external one, or
  unverified free text — because collapsing the last two makes a typo
  indistinguishable from a southern hospital, which is how a referral goes
  nowhere while looking as though it went somewhere.
- `GET/POST /api/directory`, `/resolve`, `/roles`, `/role` and `/retire`.

**Fixed**

- **Clinical content could name an encounter that did not exist, or that
  belonged to another patient.** `encounter_id` reads as provenance, and
  nothing checked it, so an order filed against somebody else's visit was
  stored as fact — the same hazard `duplicates()` declines to merge for. Orders,
  medication statements and clinical entries now validate it where they write
  it. Eleven existing tests were filing notes against an `enc-1` that was never
  created by anything, which is what the check was for.
- **A clinical route nested under a subpath was exempt from the audit-coverage
  guarantee.** `test/clinical-api.test.ts` discovers routes by reading
  `admin.ts`, and its pattern stopped at the first `/`, so a route added as
  `/api/clinical/encounter/arrive` would never have been driven and its missing
  audit row would never have been noticed. The pattern now admits nested paths.

**Changed**

- `phi()` is now a thin wrapper over `phiFor()`, which takes the subject
  explicitly. A route that learns whose record it is serving from the data
  rather than from the query string — an encounter knows its own patient — uses
  it directly, so the directive check cannot be dodged by omitting `patient`.
- 426 → 448 tests.

## 0.5.0 — 2026-08-19

The clinical platform, and the privacy enforcement that makes it safe to serve.

**Added**

- **Closed-loop referrals** (§9). Every status owes something to somebody and
  the deadline records what. A redirect keeps the correlation and carries the
  documents, rather than cancelling and resetting the clock.
- **Orders and results** (§4). Results are appended and acknowledgement lives
  on the row, so a correction does not inherit the sign-off of the value it
  replaced, and acknowledging a superseded result is refused.
- **Medications and allergies** (§5), where "no known drug allergies" is a row
  rather than an absence. `never-asked` is a `severe` finding and is never
  folded into `clear`; a blocking finding needs an override recording both the
  reason and the findings that were shown.
- **The assembled chart** (§2), where every section carries its own
  completeness and a section that failed says so instead of rendering as
  "none".
- **Patient access** (§11). Delegated authority without an expiry is refused
  rather than defaulted, and is checked against the clock rather than a status.
- **Registries and care gaps** (§12). The denominator is the whole cohort,
  `unclassified` comes back with a reason per patient, and `rate` is `null`
  when too much of the cohort could not be assessed.
- **Scheduling** (§10). Double-booking is refused by a partial unique index
  rather than by a check a second process can race past.
- **Consent directives and break-glass** (§16). The directive check lives
  inside `phi()` rather than per route, so a lockbox cannot be missed by a
  route that forgot to ask.
- **A clinical API that cannot serve patient data unaudited**, enforced by a
  test that reads the routing source, drives every clinical path, and fails if
  one serves patient data without leaving an audit row.
- `GET /api/clinical/break-glass`, and `POST /api/clinical/break-glass-notified`
  and `-review` — the notification and review queues, which existed in the
  store and could not be read or discharged by anything.
- **A clinician console**: `Chart`, `Worklist` and `Break-glass` tabs in the
  admin UI, driven entirely through the clinical API so every read is audited
  and passes the directive check. The chart's `complete` and `omissions` have
  existed since the chart was written and nothing rendered them; a panel that
  failed, one that was truncated and one the patient withheld are now three
  visibly different things. Results are acknowledged inline, with the sentence
  saying what was done that `orders.acknowledge()` requires.
- `POST /api/clinical/acknowledge`, the one write the console needs. It goes
  through the same directive check as any read — you cannot say what you did
  about a value you were not allowed to see — and surfaces the store's refusals
  verbatim, including the one that stops a superseded result being signed off.
- `SECURITY.md`, a vulnerability disclosure process, and
  [`docs/RUNBOOK.md`](docs/RUNBOOK.md) for deployment and incidents.
- A nightly **Resilience** workflow running the crash, disk-full, restore and
  load tests, which previously ran only when somebody remembered to run them by
  hand.
- **`npm run restore`** — the restore procedure as code rather than four lines
  of `mv`, `rm` and `cp` in a README. It proves the snapshot comes up before
  displacing anything, refuses to run against a database something still holds,
  keeps what it replaces, and removes the stale sidecars that make a restore
  half-work.
- **`npm run restoretest`** — a restore rehearsal that takes a snapshot from
  under a live engine, restores it somewhere the database has never been, and
  boots an engine against it in a separate process to prove the result is
  usable rather than merely openable. **A measured RTO and a stated RPO** are
  now in the README and the runbook; there were none before.

**Fixed**

- **A consent directive narrowed by `scope` was enforced by nothing over
  HTTP.** `mayRead()` honoured `scope` when told which entry type was being
  read, and `phi()` never tells it, because a chart is not one type. Every
  scoped directive therefore evaluated to "does not apply" on every request: a
  patient could lock their counselling notes and `GET /api/clinical/chart`
  served them with a 200. A read that cannot say which type it is reading may
  return the withheld one, so it is now refused.
- **A directive narrowed by `scope` withholds its section, not the whole
  chart.** The first fix for the leak above refused any read that could not
  name its entry type, which was safe and much blunter than the patient asked
  for: they locked one section and lost the chart, with break-glass as the only
  way back. There is no honest yes-or-no to "may they read the chart" when one
  panel is locked, so the chart now drops that panel and says on its face that
  a directive is why — `incomplete.reason` is `withheld`, distinct from
  `unavailable`, because a panel that failed and a panel the patient locked
  call for completely different things from a clinician. A route serving
  exactly the locked type still refuses, having nothing left to serve. Neither
  the content nor the count of a withheld section reaches the response, and the
  audit row names which types were withheld.
- **A `withhold-from-organization` directive could never be enforced at all**,
  because it matched on an organization identity that no credential carries and
  nothing passed. It was recorded, reported to the patient as active, and
  enforced by nothing. It now withholds from any caller that cannot say it is
  outside the withheld organization.
- `breakGlass()`'s docstring claimed `notifyPatient` ran there. It never did.
- **A restored snapshot arrived owned by the machine that took it.** A backup
  copies the whole database, `instance_lock` included, so the restored file
  claimed to belong to a process on the source host — and
  `acquireInstanceLock()` cannot prove a holder on another host is dead, so the
  new engine waited out the inherited heartbeat before starting. A stall on the
  recovery path, invisible to any restore onto the machine that took the
  backup, which is the only kind anyone had done.
- **A snapshot from an older release could not be verified, so the restore path
  refused it.** `verifyBackup()` opens read-only, and a read-only handle skips
  `SCHEMA` and `migrate()`, so it queried the current schema against a file
  written by an older version and failed with `no such table: channels`. The
  preflight now migrates a scratch copy instead, which both fixes the refusal
  and exercises the migration before the live database is displaced.
- `awaitingResult()` treated a preliminary result as an answer, so a blood
  culture reporting gram-positive cocci at 24 hours and never speciating
  dropped off the chase list.
- `Db.transaction` is reentrant, so an operation built from other atomic
  operations — a referral redirect closing one loop and opening another — is
  itself atomic rather than crashing or being written non-atomically.
- Article agreement in error messages across five modules ("a attended
  booking").

**Changed**

- Licensed under **Apache-2.0**. The repository previously carried no licence
  file and declared `UNLICENSED`, which meant nobody could legally use, fork or
  contribute to a public repository.
- 270 → 426 tests.

**Known limitations**, stated because both fixes above fail closed and are
blunter than the patient asked for:

- A `withhold-from-organization` directive withholds from every caller until
  organization identity reaches the auth layer. *(Closed — see Unreleased.)*
- Break-glass notification is recorded, not sent. Telling the patient happens
  on a channel Portage does not own; the queue holds until an operator records
  that it happened. *(Notices are dispatched as of Unreleased; recording that
  the patient was actually told is still a separate, manual act.)*

## 0.4.0

Authentication and authorisation (API keys, OAuth 2.0 / SMART on FHIR, three
scopes, one gate ahead of every route); mutual TLS; conformance validation on
facade writes; native SFTP, Postgres and MySQL sources; terminology release
loaders; hash-chained access audit; retention with verifiable chains; rate
limiting; verified online backup and health signals; one-engine-per-database
enforcement; in-place schema migration; truncation-resistant chains;
multi-tenancy end to end; purpose of use on the audit trail; the append-only
clinical record, patient index, clinical documentation and unified inbox.

## 0.3.0

The core: channels; MLLP, HTTP, FHIR, filedrop and dbpoll sources; filter,
split, mapping and validation pipeline; retrying ordered destinations with DLQ
and replay; hash-chained lineage; FHIR R4 facade; terminology service; PS-CA,
CA:FeX and CA:eReC conformance packs; rest-hook Subscriptions; the satellite
outage demo; the admin UI.
