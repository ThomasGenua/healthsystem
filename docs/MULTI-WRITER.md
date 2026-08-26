# More than one writer

The design proposal for
[#25](https://github.com/ThomasGenua/healthsystem/issues/25), written before
any code on purpose — the issue asks for exactly that, because every guarantee
this codebase makes was designed under one writer, and each one becomes
materially harder to keep across writers. This document names the guarantees,
takes the candidate designs one at a time, evaluates each against the full
list, and says honestly what every survivor gives up.

**Status: proposal. No code.** #25 stays open until a design is chosen and
built; this document is the issue's first checkbox, not its last.

## The claims, and where they physically live

A Portage node makes six claims that a multi-writer design must not quietly
weaken. They are not aspirations; each is a mechanism with a file name and a
test, which is what makes the evaluation below concrete rather than
rhetorical.

1. **Ordered delivery per ordering key.** Every delivery carries a `seq` and
   an ordering key — `tenant:channel:destination` (`orderingKey`,
   `src/db.ts`; the tenant leads so two custodians who both name a channel
   `adt` do not share one queue). The drain releases a delivery only when no
   earlier one on the same key is still queued or in flight
   (`nextDueForKey`), and a failure stops that key's drain so nothing
   overtakes it (`test/throughput.test.ts` — "a failure stops that key's
   drain, so nothing overtakes it"). The order is the insertion order, under
   one writer.

2. **Hash-chained lineage that verifies.** Three chains: the message log per
   tenant and channel (`src/db.ts`), the audit trail per tenant
   (`src/audit/store.ts`), the clinical record per record key
   (`src/clinical/record.ts`). Every append is *read the tip, hash over it,
   insert* — correct because one writer serializes appends. A chain has one
   tip by construction.

3. **The audit counter.** `audit_counters` holds a per-tenant issued count,
   incremented on every append; `verifyChain()` compares rows present against
   rows issued, which is what makes truncation — deleting the embarrassing
   tail — detectable (`test/chain-truncation.test.ts` — "an audit trail with
   its tail removed does not verify"). The counter is one number because
   there is one place that increments it.

4. **The scheduling uniqueness guarantee.** One active booking per seat is a
   partial unique index (`idx_booking_seat`, `src/db.ts`), enforced by the
   database inside the booking transaction (`src/schedule/store.ts`) —
   `test/schedule.test.ts` — "the database refuses a second booking on a
   seat, whatever the caller does". A unique index guards the database it
   lives in. It says nothing about a second database.

5. **Tenant isolation.** Every tenant-scoped statement names its tenant,
   enforced by a source-reading test (`test/tenant-scoping.test.ts` — "no
   statement reads or writes tenant-scoped data without naming a tenant").
   Every chain, counter, ordering key and registry is already per-tenant.
   This matters more than it looks below: **the tenant is the unit every
   guarantee is scoped to**, which makes it the natural unit of partition.

6. **An acknowledgement means durably queued.** Ingest is one synchronous
   transaction — store, pipeline, enqueue — committed before the MLLP AA or
   the HTTP 200 leaves the socket (`src/core/engine.ts`). The sender may
   delete its copy on our say-so; that is the claim the whole design rests
   on, and today it is a claim about *this node's* disk.

The instance lock (`acquireInstanceLock`, `src/db.ts`) is the fence around
all six: a second engine on the same database is a **refusal rather than a
corruption** (`test/instance-lock.test.ts` — "a second engine on the same
database refuses to start"), because two engines both claim due deliveries
and each one's startup reclaim requeues the other's genuinely in-flight
sends. That is not a hypothetical: the same file pins the failure the lock
prevents — "without the lock a second instance duplicates a message in
flight". The lock is not the ceiling by accident. It is the ceiling because
everything above depends on it.

## What "more than one writer" would actually be for

Three different demands hide under the phrase, and they have different
answers:

- **Write capacity** — more ingest per second than one node can commit.
- **Write availability** — a second node that can take over when this one is
  down.
- **Write locality** — a community site accepting writes while its link to
  the territorial hub is out.

Capacity is the least real of the three, and the measured numbers say so: a
single node ingests about 1,100 messages a second and drains an ordered
destination at about 200 a second. A territory's clinical traffic is
thousands of messages a day, not thousands a second. Nobody should build a
cluster for a problem the single node finishes before lunch.

There is a sharper point underneath. **The ingest ceiling is bounded by
durability, not by speed**: each message commits as one transaction, a
commit is an fsync, and the engine runs `synchronous=FULL` because community
sites lose power and an AA has already promised the message is on disk. A
second writer would not raise that ceiling for a given stream — it would
add a second stream. Any design that appears to raise it *per stream* has
almost certainly traded the promise for the throughput, which is the one
trade this system does not make.

The real demands in this operating environment are availability and
locality — the satellite link is what fails, not the disk under the hub.

## Read scaling, first and separately

The issue asks for read and write scaling to be ruled in or out separately,
because read replicas may deliver most of the practical benefit at a
fraction of the risk. They do, and one is already merged.

The **reading station** (`docs/OFFLINE-CHART.md`, `src/core/station.ts`,
built for #38) is a read replica with the honesty problems solved: a
restored and *verified* snapshot of the primary, served by the same binary,
with staleness stamped on every panel and every response header, a serving
budget that expires it, channels disabled so it cannot become a second
engine, and a purge that keeps its own audit trail so offline reads still
reach the access review. It accepts no writes except a declared
break-glass — and even that is not an append to the primary's chains. It is
a *declaration*, carried back and replayed onto the primary's consent store
and audit chain by the primary writer at reconcile time.

**Read scaling is ruled in**, by generalizing what exists. N stations filled
from the same verified snapshots serve N communities' reads. A station
promoted to a warm standby — filled on a schedule, budget long, restore
rehearsed (`docs/RUNBOOK.md` measures the RPO and the RTO) — is the
availability answer for reads and most of it for writes, because the
failover path is the already-tested restore path. None of this touches a
single one of the six claims, because none of it appends anywhere but the
primary.

## Write scaling: the candidate designs

### A. Two engines, one database file — stays refused

The design the instance lock already forbids. Ordered delivery breaks first
(both engines claim due deliveries; startup reclaim double-sends), the chain
tips race second — two appenders read the same tip and both hash over it, a
fork, which `verifyChain()` correctly reports as a break. There is nothing
to salvage; the refusal is the feature. **Rejected permanently.**

### B. Partition by tenant — viable, and cheap to reason about

Each tenant lives on exactly one node; a hub is a **router**, not a merger.
Because every guarantee is already scoped to a tenant (claim 5 is what makes
this true), moving a tenant whole moves all six claims intact: its chains
have one appender on its one node, its counter one incrementer, its booking
index guards the only database its bookings live in, its ordering keys begin
with its tenant id, and an ack is still one node's committed transaction.
Isolation gets physically stronger, not weaker.

What it costs: fleet operations — per-node backup, restore, upgrade,
multiplied rather than complicated — and a routing layer that must never
guess which node holds a tenant. What it rules out: nothing the system does
today, because nothing crosses tenants except deliberate, aggregate,
read-only reporting, and the source scan that enforces tenant naming is also
the inventory proving it.

**Ruled in as the write-capacity path, if capacity ever becomes the demand.**
Note what it is: "more nodes", not "more writers per node" — the distinction
that keeps the instance lock honest.

### C. Multi-master for one tenant — rejected against every claim

Two nodes both accepting writes for the same tenant, merging afterwards.
Taken against the list:

1. *Ordering*: two origins mint `seq` for one ordering key, and the merge
   must invent an order neither sender saw. **Broken.**
2. *Chains*: two tips. A merge that rewrites `prev_hash` to splice the forks
   is byte-for-byte what tampering looks like — the chain exists precisely
   to make that detectable, so a design requiring it is the attack the
   design is meant to catch. **Broken.**
3. *Counter*: `issued` becomes a distributed sum, and truncation detection
   degrades to per-replica bookkeeping that a lost replica quietly resets.
   **Weakened past usefulness.**
4. *Scheduling*: a partial unique index on each copy and on no whole. Both
   nodes book the last seat on the plane, and the conflict surfaces at sync
   time — after both patients were told yes. In this domain that is not an
   inconvenience, it is a hazard-log entry. **Broken.**
5. *Isolation*: survives, irrelevantly.
6. *Ack*: "durably queued" becomes "durably queued here, pending merge". The
   sender deleted its copy on the strength of a claim that now carries an
   asterisk. **Broken.**

Five of six broken is not a tuning problem. **Ruled out** — and honestly:
this is the design that offline *community writes* would require, and the
answer this system gives to offline is deliberately different. Reads come
from a station; an urgent override goes break-glass with declared
provenance and is replayed by the one writer. Conflict-free replicated types
do not rescue it: counts can merge, but a seat, a chain tip and an
acknowledgement are not counts.

### D. Store-and-forward ingest — the one honest second writer

A satellite site runs an ingest edge. It accepts a sender's message, commits
it to its **own** durable queue in its own transaction, and acks. From there
it forwards to the tenant's home node in order, with retries, over whatever
the link allows; the home node ingests normally — mints `seq`, appends the
chains, increments the counter, enqueues deliveries — as the single writer
it never stopped being.

This is not a new machine. It is the **outbound delivery queue pointed
inward** — ordered per key, durable, retrying, dead-lettering — and it is
the reading station's break-glass pattern generalized: a write accepted
elsewhere arrives at the primary as an *input with provenance*, never as a
peer append. Both precedents are built and tested.

Against the list: ordering holds per key, because the edge forwards FIFO per
key and the home node serializes — what the system promises is per-key
order, not cross-site wall-clock order, and that is worth saying plainly.
Chains, counter, scheduling index: untouched, one appender and one
incrementer and one index, all at home. Isolation: unchanged.

The acknowledgement is the one claim that **changes meaning**. An AA from an
edge means *durably queued on the path*, not yet on the home node's disk.
The sender may still delete its copy — the durability is real — but
end-to-end latency becomes visible, and the edge must wear it the way the
station wears staleness: a header, a health signal, an age somebody can
alarm on. Never a silent gap.

What it rules out, stated rather than implied: an edge cannot book. The seat
index lives at home, and a booking is a read-check-write that
store-and-forward cannot express without reinventing design C. **An edge
accepts messages, not transactions.**

## What the recommended shape gives up

- **No active-active, ever, for one tenant.** The chains and the seat index
  are single-appender by design, and that design *is* the safety property.
- **No offline booking and no offline chart writes** at a community site.
  Reads come from a station, urgent consent overrides go break-glass with
  declared provenance, and everything else waits for the link. This is a
  real limitation, and the system prefers it to a double-booked plane.
- **A hub is a router.** Tenant sharding adds nodes; it never merges
  histories.
- **The ack's meaning must be restated wherever an edge acks** — "durably
  queued on the path" — and surfaced as an age, or the claim rots silently.
- **Fleet cost.** Every node added is a backup schedule, a restore
  rehearsal, and a key ceremony added. The runbook multiplies. Nothing in it
  gets harder; all of it gets more numerous.

## Recommendation

1. **Now**: nothing. The ceiling is real and correctly placed, and no
   deployment shape in front of us needs a second writer. #25 was ranked
   last for that reason and the ranking was right.
2. **When availability is the demand**: warm standby, by scheduled
   fill-and-verify on the station machinery, with failover as the rehearsed
   restore path. Read-only until promoted, and promotion is a decision on
   the runbook, not an election.
3. **When locality is the demand**: store-and-forward ingest edges (design
   D), built on the delivery queue and the break-glass replay precedents,
   with the edge's queue age on the health surface from day one.
4. **When capacity is the demand** (it is not): partition by tenant
   (design B). Never design C.

Each step is separately testable against the six claims, and none of them
moves the instance lock an inch: every database still has exactly one
engine, and every chain exactly one appender.
