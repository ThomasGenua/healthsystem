/**
 * Organization identity on a credential, and the directive it makes real.
 *
 * `withhold-from-organization` matched on an `organizationId` that no
 * `Principal` carried and nothing ever passed, so `undefined === "yk-clinic"`
 * was false on every request. The directive was recorded, reported to the
 * patient as active by `GET /api/clinical/directives`, and enforced by nothing.
 * The first fix made it fail closed, which was safe and withheld the record
 * from every caller in the territory — a patient who excluded one clinic had
 * excluded everybody.
 *
 * These tests are at the HTTP boundary on purpose. That is where the original
 * gap was invisible: the unit tests passed the whole time, because they passed
 * an `organizationId` that the only real caller never did.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { AuthGate } from "../src/auth/gate.ts";
import { Engine } from "../src/core/engine.ts";
import { startApi } from "../src/api/admin.ts";
import type { AuditRow } from "../src/audit/store.ts";

const P = "NT770001";
const OFFICE = { actorId: "privacy-office", actorKind: "practitioner" as const };

/**
 * Two organizations in one tenant, which is the case that matters: several
 * organizations operate inside one custodian, and tenancy cannot express the
 * difference between them.
 */
async function boot() {
  const engine = new Engine({ dbPath: ":memory:", tickMs: 15 });
  await engine.start();
  const t = engine.forTenant("default");

  t.directory.addOrganization({ id: "yk-clinic", name: "Yellowknife Family Practice" });
  t.directory.addOrganization({ id: "stanton", name: "Stanton Territorial Hospital" });

  const atYk = t.keys.issue("yk terminal", ["admin"], { organizationId: "yk-clinic" });
  const atStanton = t.keys.issue("stanton terminal", ["admin"], { organizationId: "stanton" });
  const anonymousOrg = t.keys.issue("legacy integration", ["admin"]);

  const api = await startApi(engine, 0, "127.0.0.1", { auth: new AuthGate({ keys: engine.keys }) });
  const base = `http://127.0.0.1:${api.port}`;

  t.clinical.record({
    entryType: "Patient",
    patientId: P,
    content: { resourceType: "Patient", identifier: [{ system: "urn:jhn", value: P }], name: [{ family: "Blondin" }] },
    authorId: "adt-feed",
    authorKind: "device",
  });

  return {
    engine,
    t,
    base,
    atYk,
    atStanton,
    anonymousOrg,
    get: (p: string, key: string) => fetch(`${base}${p}`, { headers: { authorization: `Bearer ${key}` } }),
    trail: () => t.audit.list({ limit: 500 }) as AuditRow[],
    close: async () => {
      await api.close();
      await engine.stop();
    },
  };
}

test("a directive against one organization does not withhold from another", async () => {
  // The whole point. Before this, either the directive did nothing at all, or
  // (after the fail-closed fix) it withheld from everybody. Neither is what the
  // patient asked for.
  const s = await boot();
  try {
    s.t.consent.record({ patientId: P, kind: "withhold-from-organization", targetId: "yk-clinic", by: OFFICE });

    const excluded = await s.get(`/api/clinical/chart?patient=${P}`, s.atYk.key);
    assert.equal(excluded.status, 403, "the organization the patient named is refused");
    assert.match(((await excluded.json()) as { error: string }).error, /withheld by a patient directive/);

    const other = await s.get(`/api/clinical/chart?patient=${P}`, s.atStanton.key);
    assert.equal(other.status, 200, "and an organization the patient did not name is not");
  } finally {
    await s.close();
  }
});

test("a credential that cannot say which organization it is still fails closed", async () => {
  // The safe direction, and the reason this stays over-restrictive rather than
  // permissive: a caller that has not shown it is outside the withheld
  // organization has not shown it is outside the withheld organization.
  const s = await boot();
  try {
    s.t.consent.record({ patientId: P, kind: "withhold-from-organization", targetId: "yk-clinic", by: OFFICE });

    const res = await s.get(`/api/clinical/chart?patient=${P}`, s.anonymousOrg.key);
    assert.equal(res.status, 403);
  } finally {
    await s.close();
  }
});

test("which organization looked is on the audit trail", async () => {
  // "Who looked at this record" and "which organization looked at this record"
  // are different questions and a privacy review asks both.
  const s = await boot();
  try {
    await s.get(`/api/clinical/chart?patient=${P}`, s.atStanton.key);
    const row = s.trail()[0];
    assert.equal(row.organization_id, "stanton");
    assert.equal(row.patient, P);

    await s.get(`/api/clinical/chart?patient=${P}`, s.anonymousOrg.key);
    assert.equal(s.trail()[0].organization_id, null, "and declining to say is recorded as declining to say");
  } finally {
    await s.close();
  }
});

test("the trail can be asked what one organization did", async () => {
  const s = await boot();
  try {
    await s.get(`/api/clinical/chart?patient=${P}`, s.atStanton.key);
    await s.get(`/api/clinical/chart?patient=${P}`, s.atYk.key);
    await s.get(`/api/clinical/chart?patient=${P}`, s.atYk.key);

    assert.equal(s.t.audit.list({ organization: "yk-clinic", limit: 50 }).length, 2);
    assert.equal(s.t.audit.list({ organization: "stanton", limit: 50 }).length, 1);
  } finally {
    await s.close();
  }
});

test("the organization comes from the stored credential, not from the request", async () => {
  // A caller who could name their own organization could name their way out of
  // a directive that withholds from it. Same reasoning as the tenant claim.
  const s = await boot();
  try {
    s.t.consent.record({ patientId: P, kind: "withhold-from-organization", targetId: "yk-clinic", by: OFFICE });

    // The excluded credential, dressed up as somebody else every way a caller
    // could try. None of these is read: the organization comes off the stored
    // row, so there is nothing here to override.
    const dressedUp = await fetch(`${s.base}/api/clinical/chart?patient=${P}`, {
      headers: {
        authorization: `Bearer ${s.atYk.key}`,
        "x-organization": "stanton",
        "x-organization-id": "stanton",
        organization: "stanton",
      },
    });
    assert.equal(dressedUp.status, 403, "still refused; no header changes which organization a credential is");

    // And the trail names the organization the credential actually has.
    assert.equal(s.trail()[0].organization_id, "yk-clinic");
  } finally {
    await s.close();
  }
});

test("the chain still verifies once organization rows are on it", async () => {
  // The chain hash gained a field. Appending it only when there is one is what
  // keeps every historical row hashing to what it hashed to before, so an
  // upgrade does not read as tampering.
  const s = await boot();
  try {
    await s.get(`/api/clinical/chart?patient=${P}`, s.atStanton.key);
    await s.get(`/api/clinical/chart?patient=${P}`, s.anonymousOrg.key);
    assert.equal(s.t.audit.verifyChain().ok, true);
  } finally {
    await s.close();
  }
});

test("a credential cannot be issued for an organization the directory does not have", async () => {
  // Recorded-and-ignored is the failure mode this issue exists to close. An
  // organization that resolves to nothing would make a credential look precise
  // while behaving exactly like one that named none — and the two must stay
  // distinguishable, because one is a deliberate "cannot say" and the other is
  // a typo nobody will find.
  const s = await boot();
  try {
    assert.throws(
      () => s.t.keys.issue("typo", ["read"], { organizationId: "ykclinic" }),
      /no organization 'ykclinic' in the directory/
    );

    s.t.directory.retire("organization", "stanton");
    assert.throws(
      () => s.t.keys.issue("late", ["read"], { organizationId: "stanton" }),
      /organization 'stanton' is retired/
    );
  } finally {
    await s.close();
  }
});

test("rotating a credential carries its organization to the replacement", async () => {
  // A replacement that lost its organization would silently widen what a
  // directive withholds from, which is the bug this issue closes arriving
  // again by the back door.
  const s = await boot();
  try {
    const replacement = s.t.keys.rotate(s.atYk.id);
    assert.equal(replacement.organizationId, "yk-clinic");

    s.t.consent.record({ patientId: P, kind: "withhold-from-organization", targetId: "yk-clinic", by: OFFICE });
    const res = await s.get(`/api/clinical/chart?patient=${P}`, replacement.key);
    assert.equal(res.status, 403, "the rotated credential is still the excluded organization");
  } finally {
    await s.close();
  }
});
