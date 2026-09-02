/**
 * What the database says about itself, checked against what is in it.
 *
 * The schema declares no foreign keys, so `PRAGMA foreign_keys = ON`
 * enforces nothing; and the tenant boundary is a column, not a database.
 * Both hold today because a structural test reads the source and says the
 * queries written so far are scoped. That is a different claim from "the
 * rows obey it" — a restore that merged two sites' snapshots, an edit made
 * outside the engine, or a version of this code from before the check
 * existed all produce a database no source scan can speak for.
 *
 * These pin the two properties that matter: the inspection finds the
 * violations it exists to find, and it never reports a clean database for a
 * check it did not run.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { Db } from "../src/db.ts";
import { inspect, render, LINKS } from "../src/core/invariants.ts";
import { Engine } from "../src/core/engine.ts";

test("a fresh schema evaluates every registered check, and passes all of them", () => {
  const db = new Db(":memory:");
  try {
    const report = inspect(db.sql);
    // The anti-drift guard, and the reason this file exists in the shape it
    // does. A registry naming a table or column the schema has renamed would
    // otherwise sit there reporting nothing wrong, which is what four other
    // scanners in this repository were found doing.
    assert.deepEqual(
      report.unevaluated.map((r) => `${r.name}: ${r.reason}`),
      [],
      "every check in the registry must resolve against the current schema"
    );
    assert.deepEqual(report.violated, []);
    assert.equal(report.ok, true);
    assert.ok(report.checked > 100, `only ${report.checked} checks registered`);
    assert.ok(LINKS.length >= 20, `only ${LINKS.length} references checked`);
    assert.match(render(report), /every one of them holds/);
  } finally {
    db.close();
  }
});

test("a check that cannot run is not a pass", () => {
  // An empty database: every table the registry names is absent. The report
  // must say so loudly rather than congratulating itself on finding no
  // violations in tables it never opened.
  const bare = new DatabaseSync(":memory:");
  try {
    const report = inspect(bare);
    assert.equal(report.ok, false, "a report that ran nothing is not ok");
    assert.deepEqual(report.violated, [], "and it found no violations, because it looked at nothing");
    assert.equal(report.unevaluated.length, report.checked, "so every check is unevaluated");
    for (const r of report.unevaluated) assert.ok(r.reason, `${r.name} gave no reason`);
    const text = render(report);
    assert.match(text, /UNEVALUATED/);
    assert.match(text, /This is not a pass/);
  } finally {
    bare.close();
  }
});

test("a row with no tenant is found, because nothing else can see it", () => {
  const db = new Db(":memory:");
  try {
    db.sql
      .prepare(
        `INSERT INTO encounters
           (tenant_id, id, patient_id, class, status, reason, opened_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run("", "ENC-ORPHANED", "NT123456", "in-person", "open", "review", "dr-tetso",
           "2026-09-01T10:00:00Z", "2026-09-01T10:00:00Z");

    const report = inspect(db.sql);
    const result = report.results.find((r) => r.name === "tenant/encounters")!;
    assert.equal(result.outcome, "violated");
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0].row, "id=ENC-ORPHANED");
    assert.match(result.violations[0].detail, /no tenant-bound query can ever see this row/);
    assert.equal(report.ok, false);
  } finally {
    db.close();
  }
});

test("an orphan and a reference into another custodian are different findings", () => {
  const db = new Db(":memory:");
  try {
    const slot = (tenant: string, id: string) =>
      db.sql
        .prepare(
          `INSERT INTO schedule_slots
             (tenant_id, id, resource_id, service, starts_at, ends_at, capacity, status, created_at)
           VALUES (?, ?, 'dr-tetso', 'GP', '2026-09-01T10:00:00Z', '2026-09-01T10:30:00Z', 1, 'open',
                   '2026-08-01T00:00:00Z')`
        )
        .run(tenant, id);
    const booking = (tenant: string, id: string, slotId: string) =>
      db.sql
        .prepare(
          `INSERT INTO schedule_bookings
             (tenant_id, id, slot_id, patient_id, seat, status, reason, booked_by, booked_at, created_at)
           VALUES (?, ?, ?, 'NT123456', 1, 'booked', 'follow-up', 'dr-tetso',
                   '2026-09-01T09:00:00Z', '2026-09-01T09:00:00Z')`
        )
        .run(tenant, id, slotId);

    // The southern site holds a slot. The northern site holds a booking
    // against it — which no query at either site would report as wrong,
    // because each one only ever looks at its own rows.
    slot("south", "SLOT-SOUTH");
    booking("north", "BK-CROSSED", "SLOT-SOUTH");
    // And a booking against a slot nobody holds at all.
    booking("north", "BK-ORPHANED", "SLOT-GONE");

    const report = inspect(db.sql);
    const result = report.results.find((r) => r.name === "reference/schedule_bookings.slot_id")!;
    assert.equal(result.outcome, "violated");
    assert.equal(result.examined, 2, "both bookings were looked at");

    const crossed = result.violations.find((v) => v.row === "id=BK-CROSSED")!;
    assert.equal(crossed.tenant, "north");
    assert.match(crossed.detail, /under a different custodian/);

    const orphan = result.violations.find((v) => v.row === "id=BK-ORPHANED")!;
    assert.match(orphan.detail, /resolves nowhere/);

    // The two are told apart because they are two incidents: one is a
    // disclosure, the other is data loss.
    assert.notEqual(crossed.detail, orphan.detail);
  } finally {
    db.close();
  }
});

test("a chain the index would now refuse is still found in a database that predates it", () => {
  const db = new Db(":memory:");
  try {
    // The partial unique index enforces this from the moment it exists,
    // which is not the same as always. Dropping it reproduces a database
    // written before the index was added — the only state in which this
    // violation can exist, and exactly the state the check is for.
    db.sql.exec("DROP INDEX idx_score_approvals_root");
    const approval = (id: string) =>
      db.sql
        .prepare(
          `INSERT INTO score_approvals
             (tenant_id, id, score_id, implementation_version, decision, reason,
              clinical_owner_id, review_due, recorded_by_id, recorded_by_kind, recorded_at)
           VALUES ('north', ?, 'meld-na', 'portage-1', 'approved', 'reviewed',
                   'dr-tetso', '2027-01-01', 'ops', 'apikey', '2026-09-01T10:00:00Z')`
        )
        .run(id);
    approval("AP-1");
    approval("AP-2");

    const report = inspect(db.sql);
    const rooted = report.results.find((r) => r.name === "chain/score-approvals-rooted")!;
    assert.equal(rooted.outcome, "violated");
    assert.equal(rooted.violations[0].row, "score_id=meld-na");
    assert.equal(rooted.violations[0].tenant, "north");
    assert.match(rooted.violations[0].detail, /2 approvals name no predecessor/);
    assert.equal(report.ok, false);
  } finally {
    db.close();
  }
});

test("one site's approval chain is not confused with another's", () => {
  const db = new Db(":memory:");
  try {
    db.sql.exec("DROP INDEX idx_score_approvals_root");
    for (const tenant of ["north", "south"]) {
      db.sql
        .prepare(
          `INSERT INTO score_approvals
             (tenant_id, id, score_id, implementation_version, decision, reason,
              clinical_owner_id, review_due, recorded_by_id, recorded_by_kind, recorded_at)
           VALUES (?, ?, 'meld-na', 'portage-1', 'approved', 'reviewed',
                   'dr-tetso', '2027-01-01', 'ops', 'apikey', '2026-09-01T10:00:00Z')`
        )
        .run(tenant, `AP-${tenant}`);
    }
    // Two sites each holding one root for the same score is correct, and a
    // check that grouped by score alone would report it as a fork.
    const report = inspect(db.sql);
    assert.equal(report.results.find((r) => r.name === "chain/score-approvals-rooted")!.outcome, "pass");
  } finally {
    db.close();
  }
});

test("a database the engine actually wrote holds every invariant", async () => {
  // The registry is only worth something if the code under it passes. Run a
  // pipeline end to end — a channel, a message through it, a delivery, an
  // encounter, a slot and a booking — and inspect what the engine left.
  const engine = new Engine({ dbPath: ":memory:", tickMs: 15 });
  await engine.start();
  try {
    const t = engine.forTenant("default");
    t.clinical.record({
      entryType: "Patient",
      patientId: "NT123456",
      content: { resourceType: "Patient", identifier: [{ value: "NT123456" }] },
      authorId: "adt",
      authorKind: "device",
    });
    const slot = t.schedule.openSlot({
      resourceId: "dr-tetso",
      service: "GP",
      startsAt: "2026-09-01T10:00:00Z",
      endsAt: "2026-09-01T10:30:00Z",
    });
    t.schedule.book({
      slotId: slot.id,
      patientId: "NT123456",
      reason: "Follow-up",
      by: { actorId: "dr-tetso", actorKind: "practitioner" },
    });
    const encounter = t.encounters.open({
      patientId: "NT123456",
      class: "in-person",
      reason: "Sore throat",
      by: { actorId: "dr-tetso", actorKind: "practitioner" },
    });
    assert.ok(encounter.id);

    const report = inspect(engine.db.sql);
    assert.deepEqual(report.violated.map((r) => `${r.name}: ${JSON.stringify(r.violations)}`), []);
    assert.deepEqual(report.unevaluated, []);
    assert.equal(report.ok, true);
    // And it examined something, so this is not a pass over an empty
    // database wearing a workload's clothes.
    assert.ok(report.results.some((r) => r.examined > 0), "the inspection examined no rows at all");
  } finally {
    await engine.stop();
  }
});

test("a violation names the row and nothing else in it", () => {
  const db = new Db(":memory:");
  try {
    db.sql
      .prepare(
        `INSERT INTO schedule_bookings
           (tenant_id, id, slot_id, patient_id, seat, status, reason, booked_by, booked_at, created_at)
         VALUES ('north', 'BK-1', 'SLOT-GONE', 'NT999999', 1, 'booked', 'chest pain on exertion',
                 'dr-tetso', '2026-09-01T09:00:00Z', '2026-09-01T09:00:00Z')`
      )
      .run();
    const report = inspect(db.sql);
    const text = render(report);
    // Enough to go and look at the row, and not a copy of it. The reason a
    // patient booked is chart content, and this output goes to a terminal
    // and from there into whatever an operator pastes it into.
    assert.match(text, /BK-1/);
    assert.ok(!text.includes("chest pain"), `the report copied the row: ${text}`);
    assert.ok(!text.includes("NT999999"), `the report copied the patient: ${text}`);
    assert.match(text, /Treat what is in them as chart content/);
  } finally {
    db.close();
  }
});
