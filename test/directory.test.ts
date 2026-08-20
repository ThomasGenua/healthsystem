/**
 * A name is not an identity.
 *
 * Before this, a scheduler slot said `dr-tetso` and a referral said "Stanton
 * Orthopaedics", and neither resolved to anything: the system could not say
 * whether that person existed, worked here, or was the same dr-tetso as last
 * week. These tests pin the three decisions that answer it.
 *
 *   Organization is not tenancy. Several organizations operate inside one
 *   custodian's tenant, and conflating them would make a directive withholding
 *   a record from one clinic withhold it from the territory.
 *
 *   Nothing is deleted. A clinic that closes must not break the referral sent
 *   to it two years ago.
 *
 *   Resolution is honest rather than fatal. A reference the directory does not
 *   hold gets a real answer saying so, which is what lets a deployment adopt
 *   this without a flag day.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../src/db.ts";
import { Directory, UnknownParty } from "../src/directory/store.ts";
import { Schedule } from "../src/schedule/store.ts";
import { ReferralStore } from "../src/work/referrals.ts";

const CLERK = { actorId: "clerk", actorKind: "staff" };

function region(): { db: Db; dir: Directory; cleanup: () => void } {
  const d = mkdtempSync(join(tmpdir(), "portage-directory-"));
  const db = new Db(join(d, "portage.db"));
  return {
    db,
    dir: new Directory(db),
    cleanup: () => {
      db.close();
      rmSync(d, { recursive: true, force: true });
    },
  };
}

test("a practitioner resolves to a person, and an unregistered id says so instead of failing", () => {
  const { dir, cleanup } = region();
  try {
    const p = dir.addPractitioner({ family: "Tetso", given: "Marie", prefix: "Dr" });
    const found = dir.resolve("practitioner", p.id);
    assert.equal(found.known, true);
    assert.equal(found.display, "Dr Marie Tetso");
    assert.equal(found.known && found.active, true);

    // The legacy case: a slot written before any of this existed.
    const stranger = dir.resolve("practitioner", "dr-tetso");
    assert.equal(stranger.known, false);
    assert.equal(stranger.display, "dr-tetso", "the row's own value, so a diary can still show something true");
  } finally {
    cleanup();
  }
});

test("several organizations live inside one tenant, and a hierarchy cannot dangle", () => {
  const { dir, cleanup } = region();
  try {
    const authority = dir.addOrganization({ name: "NTHSSA", kind: "authority" });
    const clinic = dir.addOrganization({ name: "Yellowknife Primary Care", kind: "clinic", partOf: authority.id });
    assert.equal(clinic.part_of, authority.id);

    // Two organizations, one tenant. Conflating them is what would make a
    // withhold-from-organization directive useless.
    assert.equal(dir.count("organization"), 2);

    assert.throws(
      () => dir.addOrganization({ name: "Orphan", partOf: "nope" }),
      UnknownParty,
      "a parent that names nothing is the dangling reference this exists to remove"
    );
  } finally {
    cleanup();
  }
});

test("retiring keeps history resolving, and never deletes", () => {
  const { dir, cleanup } = region();
  try {
    const org = dir.addOrganization({ name: "Hay River Clinic" });
    const svc = dir.addService({ name: "Orthopaedics", organizationId: org.id });

    dir.retire("service", svc.id, "2026-03-31T00:00:00Z");

    const after = dir.resolve("service", svc.id);
    assert.equal(after.known, true, "the referral sent here in 2024 still resolves");
    assert.equal(after.known && after.active, false);
    assert.equal(after.known && after.retiredAt, "2026-03-31T00:00:00Z");

    // And it drops out of the working list without dropping out of existence.
    assert.equal(dir.list("service").length, 0);
    assert.equal(dir.list("service", { includeRetired: true }).length, 1);
  } finally {
    cleanup();
  }
});

test("one practitioner holds several roles, which is what tells one organization from another", () => {
  const { dir, cleanup } = region();
  try {
    const p = dir.addPractitioner({ family: "Hale" });
    const a = dir.addOrganization({ name: "Clinic A" });
    const b = dir.addOrganization({ name: "Clinic B" });
    dir.assignRole({ practitionerId: p.id, role: "locum", organizationId: a.id, specialty: "General practice" });
    dir.assignRole({ practitionerId: p.id, role: "locum", organizationId: b.id, specialty: "General practice" });

    assert.deepEqual(dir.organizationsFor(p.id).sort(), [a.id, b.id].sort());

    // A role ends; the other stands. This is the query #17 needs per request.
    dir.retire("organization", b.id);
    const roles = dir.rolesFor(p.id);
    assert.equal(roles.length, 2, "retiring the organization does not retire the role");

    assert.throws(() => dir.assignRole({ practitionerId: "ghost", role: "locum" }), UnknownParty);
  } finally {
    cleanup();
  }
});

test("an identifier is the join a credential will use", () => {
  const { dir, cleanup } = region();
  try {
    const p = dir.addPractitioner({
      family: "Tetso",
      identifiers: [{ system: "urn:nt:licence", value: "NT-4471" }],
    });
    assert.deepEqual(dir.byIdentifier("urn:nt:licence", "NT-4471"), [{ kind: "practitioner", id: p.id }]);
    assert.deepEqual(dir.byIdentifier("urn:nt:licence", "NT-0000"), []);
    assert.equal(dir.identifiersFor("practitioner", p.id).length, 1);

    dir.addIdentifier("practitioner", p.id, "urn:nt:licence", "NT-4471");
    assert.equal(dir.identifiersFor("practitioner", p.id).length, 1, "the same identifier twice is one identifier");
  } finally {
    cleanup();
  }
});

test("a slot with a typed resource is validated; a legacy string still works and reports as unregistered", () => {
  const { db, dir, cleanup } = region();
  try {
    const schedule = new Schedule(db);
    const p = dir.addPractitioner({ family: "Tetso", given: "Marie", prefix: "Dr" });

    const good = schedule.openSlot({
      resource: { kind: "practitioner", id: p.id },
      service: "General practice",
      startsAt: "2026-07-01T09:00:00Z",
      endsAt: "2026-07-01T09:15:00Z",
    });
    assert.equal(good.resource_id, p.id);
    assert.equal(schedule.resolveResource(good).display, "Dr Marie Tetso");

    assert.throws(
      () =>
        schedule.openSlot({
          resource: { kind: "practitioner", id: "typo" },
          service: "General practice",
          startsAt: "2026-07-01T10:00:00Z",
          endsAt: "2026-07-01T10:15:00Z",
        }),
      UnknownParty,
      "a typed reference opts into the guarantee, so a typo is refused here"
    );

    // The whole point of the incremental path: this is every slot written
    // before the directory existed, and it still works.
    const legacy = schedule.openSlot({
      resourceId: "dr-tetso",
      service: "General practice",
      startsAt: "2026-07-01T11:00:00Z",
      endsAt: "2026-07-01T11:15:00Z",
    });
    assert.equal(schedule.resolveResource(legacy).known, false);
  } finally {
    cleanup();
  }
});

test("a referral target is known, deliberately external, or unverified — and those are three things", () => {
  const { db, dir, cleanup } = region();
  try {
    const refs = new ReferralStore(db);
    const org = dir.addOrganization({ name: "Stanton Territorial" });
    const svc = dir.addService({ name: "Orthopaedics", organizationId: org.id });
    const base = {
      patientId: "NT123456",
      fromService: "Yellowknife Primary Care",
      indication: "Knee pain, failed conservative management",
      by: CLERK,
    };

    const known = refs.create({ ...base, toService: "Orthopaedics", toServiceId: svc.id });
    assert.equal(refs.target(known).kind, "known");

    const out = refs.create({ ...base, toService: "Edmonton — Orthopaedics", external: true });
    assert.equal(refs.target(out).kind, "external", "a referral south is ordinary and must not be refused");

    // The state every referral written before the directory is in, and the
    // one that must not be confused with a declared external target: this is
    // also what a typo looks like.
    const guess = refs.create({ ...base, toService: "Stanton Orthapedics" });
    assert.equal(refs.target(guess).kind, "unverified");

    assert.throws(
      () => refs.create({ ...base, toService: "x", toServiceId: svc.id, external: true }),
      /either to a service in the directory or explicitly external/
    );
    assert.throws(() => refs.create({ ...base, toService: "x", toServiceId: "ghost" }), UnknownParty);
  } finally {
    cleanup();
  }
});

test("a retired service still resolves for the referral that named it", () => {
  const { db, dir, cleanup } = region();
  try {
    const refs = new ReferralStore(db);
    const svc = dir.addService({ name: "Orthopaedics" });
    const r = refs.create({
      patientId: "NT123456",
      fromService: "Primary care",
      toService: "Orthopaedics",
      toServiceId: svc.id,
      indication: "Knee pain",
      by: CLERK,
    });
    dir.retire("service", svc.id);

    const t = refs.target(r);
    assert.equal(t.kind, "known", "the clinic closed; the referral it received did not stop having a target");
    assert.equal(t.kind === "known" && t.active, false);
  } finally {
    cleanup();
  }
});

test("the directory is confined to its tenant", () => {
  const { db, dir, cleanup } = region();
  try {
    const p = dir.addPractitioner({ family: "Tetso" });
    const other = new Directory(db.forTenant("hayriver"));
    assert.equal(other.resolve("practitioner", p.id).known, false);
    assert.equal(other.list("practitioner").length, 0);
    assert.equal(other.count("practitioner"), 0);
    assert.deepEqual(other.byIdentifier("urn:nt:licence", "NT-4471"), []);
    assert.throws(() => other.require("practitioner", p.id), UnknownParty);
  } finally {
    cleanup();
  }
});
