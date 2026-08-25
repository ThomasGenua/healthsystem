/**
 * The access review, and the join that made it possible.
 *
 * `AuditStore` recorded and proved and answered nothing a privacy office asks.
 * The reason was structural rather than missing data: the clinical stores
 * record an actor (`dr-tetso`) and the trail records a credential, so "did
 * whoever read this chart have any reason to" had no path between the two
 * halves of the database that could answer it.
 *
 * These check the flags fire where they should, that each one says why, and —
 * the part that matters most — that they stay honest about what they cannot
 * assess rather than reporting an unchecked access as a clean one.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { AuthGate } from "../src/auth/gate.ts";
import { Engine } from "../src/core/engine.ts";
import { startApi } from "../src/api/admin.ts";
import type { PatientAccessReview } from "../src/audit/review.ts";

const P = "NT990100";

/**
 * One patient, and three people with different reasons to be near the chart:
 * the clinician treating them, a stranger, and somebody sharing their surname.
 */
async function boot() {
  const engine = new Engine({ dbPath: ":memory:", tickMs: 15 });
  await engine.start();
  const t = engine.forTenant("default");

  t.directory.addOrganization({ id: "yk-clinic", name: "Yellowknife Family Practice" });
  t.directory.addPractitioner({ id: "dr-tetso", family: "Tetso", given: "Anne", prefix: "Dr" });
  t.directory.addPractitioner({ id: "dr-hale", family: "Hale", given: "Sam", prefix: "Dr" });
  t.directory.addPractitioner({ id: "n-blondin", family: "Blondin", given: "Marie" });

  const treating = t.keys.issue("tetso terminal", ["admin"], {
    organizationId: "yk-clinic",
    practitionerId: "dr-tetso",
  });
  const stranger = t.keys.issue("hale terminal", ["admin"], {
    organizationId: "yk-clinic",
    practitionerId: "dr-hale",
  });
  const namesake = t.keys.issue("blondin terminal", ["admin"], {
    organizationId: "yk-clinic",
    practitionerId: "n-blondin",
  });
  const integration = t.keys.issue("nightly feed", ["admin"], { organizationId: "yk-clinic" });

  const api = await startApi(engine, 0, "127.0.0.1", { auth: new AuthGate({ keys: engine.keys }) });
  const base = `http://127.0.0.1:${api.port}`;

  t.clinical.record({
    entryType: "Patient",
    patientId: P,
    content: {
      resourceType: "Patient",
      identifier: [{ system: "urn:jhn", value: P }],
      name: [{ family: "Blondin", given: ["Joseph"] }],
    },
    authorId: "adt-feed",
    authorKind: "device",
  });

  // The relationship that makes dr-tetso's reads ordinary.
  t.encounters.open({
    patientId: P,
    class: "in-person",
    reason: "Sore throat",
    by: { actorId: "dr-tetso", actorKind: "practitioner" },
  });

  return {
    engine,
    t,
    base,
    treating,
    stranger,
    namesake,
    integration,
    get: (p: string, key: string) => fetch(`${base}${p}`, { headers: { authorization: `Bearer ${key}` } }),
    review: (): PatientAccessReview => t.review.forPatient(P),
    close: async () => {
      await api.close();
      await engine.stop();
    },
  };
}

/** The flags on the most recent access by a given practitioner. */
function flagsFor(report: PatientAccessReview, practitionerId: string | null): string[] {
  const hit = report.accesses.find((a) => a.practitionerId === practitionerId);
  return (hit?.flags ?? []).map((f) => f.kind);
}

test("a clinician with an encounter is not flagged for having no reason to look", async () => {
  const s = await boot();
  try {
    await s.get(`/api/clinical/chart?patient=${P}`, s.treating.key);
    const flags = flagsFor(s.review(), "dr-tetso");
    assert.ok(!flags.includes("no-treatment-relationship"), `unexpected flags: ${flags.join(", ")}`);
  } finally {
    await s.close();
  }
});

test("a clinician with nothing linking them to the patient is flagged, and told why", async () => {
  // The question the trail held every ingredient for and could not answer.
  const s = await boot();
  try {
    await s.get(`/api/clinical/chart?patient=${P}`, s.stranger.key);
    const report = s.review();
    const access = report.accesses.find((a) => a.practitionerId === "dr-hale");
    const flag = access?.flags.find((f) => f.kind === "no-treatment-relationship");

    assert.ok(flag, "the stranger's read is flagged");
    assert.match(flag!.why, /no encounter, booking, referral, order or note links/);
    assert.match(flag!.why, /Dr Sam Hale/, "and names the person, not a credential id");
  } finally {
    await s.close();
  }
});

test("a shared surname is flagged as a prompt, and says it is not a finding", async () => {
  const s = await boot();
  try {
    await s.get(`/api/clinical/chart?patient=${P}`, s.namesake.key);
    const access = s.review().accesses.find((a) => a.practitionerId === "n-blondin");
    const flag = access?.flags.find((f) => f.kind === "surname-match");

    assert.ok(flag);
    assert.match(flag!.why, /shares the surname "blondin"/);
    // The wording matters: this ends in an HR conversation if it is read as an
    // accusation, and twins and families exist.
    assert.match(flag!.why, /twins, spouses and a father and son all also do/);
  } finally {
    await s.close();
  }
});

test("a credential naming no practitioner is reported as unassessable, not as clean", async () => {
  // The failure mode this codebase refuses everywhere else: an access nothing
  // could check looking exactly like one that was checked and passed.
  const s = await boot();
  try {
    await s.get(`/api/clinical/chart?patient=${P}`, s.integration.key);
    const report = s.review();
    const flags = flagsFor(report, null);

    assert.ok(flags.includes("unattributable"));
    assert.ok(
      !flags.includes("no-treatment-relationship"),
      "and is not also flagged for a relationship that could not be checked either way"
    );
    assert.ok(
      report.limits.some((l) => /naming no practitioner/.test(l)),
      "the report says on its face how much of it could not be assessed"
    );
  } finally {
    await s.close();
  }
});

test("an access under a declared override is marked as such, not as snooping", async () => {
  // An emergency override is the system working. Flagging it as an unexplained
  // access would train a privacy officer to ignore the flag that matters.
  const s = await boot();
  try {
    // The clinical route stores the credential id as `subject_id`, not the
    // practitioner. Matching only the latter would miss every production
    // override and flag the emergency read as unexplained.
    s.t.consent.breakGlass({
      patientId: P,
      by: { actorId: s.stranger.id, actorKind: "apikey" },
      reason: "unresponsive on arrival, no collateral history, need the allergy list",
    });
    await s.get(`/api/clinical/chart?patient=${P}`, s.stranger.key);

    const access = s.review().accesses.find((a) => a.practitionerId === "dr-hale");
    const kinds = (access?.flags ?? []).map((f) => f.kind);
    assert.ok(kinds.includes("break-glass"));
    assert.ok(
      !kinds.includes("no-treatment-relationship"),
      "the override explains the absent relationship rather than compounding it"
    );
  } finally {
    await s.close();
  }
});

test("a flag can be closed with a reason, and the reason is kept", async () => {
  // A review whose judgements vanish re-raises the same flag next month with
  // nothing to say it was answered.
  const s = await boot();
  try {
    await s.get(`/api/clinical/chart?patient=${P}`, s.namesake.key);
    const before = s.review().accesses.find((a) => a.practitionerId === "n-blondin")!;
    const flag = before.flags.find((f) => f.kind === "surname-match")!;
    assert.equal(flag.dismissed, undefined);

    s.t.review.dismiss({
      auditId: before.auditId,
      flag: "surname-match",
      reason: "she is his daughter and his named substitute decision maker",
      by: "privacy-office",
    });

    const after = s.review().accesses.find((a) => a.auditId === before.auditId)!;
    const closed = after.flags.find((f) => f.kind === "surname-match")!;
    assert.equal(closed.dismissed?.by, "privacy-office");
    assert.match(closed.dismissed!.reason, /his daughter/);

    // Dismissed flags stop counting toward what an officer must look at, and
    // the flag itself stays visible rather than disappearing.
    assert.equal(s.review().summary["surname-match"], undefined);
  } finally {
    await s.close();
  }
});

test("a dismissal needs a reason somebody can read later", async () => {
  const s = await boot();
  try {
    await s.get(`/api/clinical/chart?patient=${P}`, s.namesake.key);
    const access = s.review().accesses.find((a) => a.practitionerId === "n-blondin")!;
    assert.throws(
      () => s.t.review.dismiss({ auditId: access.auditId, flag: "surname-match", reason: "ok", by: "x" }),
      /a reason somebody can read later/
    );
  } finally {
    await s.close();
  }
});

test("dismissing one flag does not answer the others on the same access", async () => {
  // "Yes, she is his daughter" answers the surname match and says nothing
  // about there being no encounter.
  const s = await boot();
  try {
    await s.get(`/api/clinical/chart?patient=${P}`, s.namesake.key);
    const access = s.review().accesses.find((a) => a.practitionerId === "n-blondin")!;
    s.t.review.dismiss({
      auditId: access.auditId,
      flag: "surname-match",
      reason: "she is his daughter and his named substitute decision maker",
      by: "privacy-office",
    });

    const after = s.review().accesses.find((a) => a.auditId === access.auditId)!;
    const relationship = after.flags.find((f) => f.kind === "no-treatment-relationship");
    assert.ok(relationship, "the unrelated-access flag is still there");
    assert.equal(relationship!.dismissed, undefined, "and is still open");
  } finally {
    await s.close();
  }
});

test("the report carries whether the trail it was built from verifies", async () => {
  // A report extracted for an investigation is worth what its source is worth.
  const s = await boot();
  try {
    await s.get(`/api/clinical/chart?patient=${P}`, s.treating.key);
    const report = s.review();
    assert.equal(report.chain.ok, true);
    assert.ok(report.chain.checked > 0);
  } finally {
    await s.close();
  }
});

test("reading the review is itself an access, and lands on the trail", async () => {
  // A review surface that read access logs without leaving a trace would be
  // the one privileged back door in a system whose argument is that it has
  // none.
  const s = await boot();
  try {
    const before = s.t.audit.list({ limit: 500 }).length;
    const res = await s.get(`/api/audit/review?patient=${P}`, s.treating.key);
    assert.equal(res.status, 200);

    const rows = s.t.audit.list({ limit: 500 });
    assert.equal(rows.length, before + 1);
    assert.equal(rows[0].path, "/api/audit/review");
    assert.equal(rows[0].patient, P);
    assert.equal(rows[0].practitioner_id, "dr-tetso", "and names who ran it");
  } finally {
    await s.close();
  }
});

test("a review cannot reach another custodian's trail", async () => {
  const s = await boot();
  try {
    s.engine.db.createTenant("other", "Other custodian", "Other Regional Custodian");
    const other = s.engine.forTenant("other");
    other.clinical.record({
      entryType: "Patient",
      patientId: P,
      content: { resourceType: "Patient", identifier: [{ system: "urn:jhn", value: P }] },
      authorId: "adt-feed",
      authorKind: "device",
    });
    other.audit.record({
      action: "R",
      principalId: "their-key",
      principalKind: "apikey",
      method: "GET",
      path: "/api/clinical/chart",
      patient: P,
      practitionerId: "their-doctor",
    });

    await s.get(`/api/clinical/chart?patient=${P}`, s.treating.key);
    const mine = s.review();
    assert.ok(
      mine.accesses.every((a) => a.practitionerId !== "their-doctor"),
      "the other custodian's accesses are not in this report"
    );
    assert.ok(other.review.forPatient(P).accesses.some((a) => a.practitionerId === "their-doctor"));
  } finally {
    await s.close();
  }
});
