/**
 * Who is responsible for this patient, for a stretch of time.
 *
 * Two people who both believe they are the most-responsible provider is how
 * a result goes to neither inbox. Retiring one must not erase that they
 * were the MRP — the visits they attended stay theirs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../src/db.ts";
import { Directory } from "../src/directory/store.ts";
import { CareTeam } from "../src/clinical/careteam.ts";
import { Refusal } from "../src/core/refusal.ts";

function clinic() {
  const dir = mkdtempSync(join(tmpdir(), "portage-team-"));
  const db = new Db(join(dir, "portage.db"));
  const directory = new Directory(db);
  directory.addPractitioner({ id: "dr-tetso", family: "Tetso", given: "Jean" });
  directory.addPractitioner({ id: "dr-hale", family: "Hale", given: "Sarah" });
  directory.addOrganization({ id: "yk-clinic", name: "Yellowknife Primary Care" });
  return {
    db,
    team: new CareTeam(db),
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const P = "NT123456";

test("a second current primary is refused until the first is retired", () => {
  const { team, cleanup } = clinic();
  try {
    const first = team.assign({
      patientId: P,
      practitionerId: "dr-tetso",
      role: "primary",
      by: { actorId: "ops" },
    });
    assert.equal(team.primary(P)?.practitioner_id, "dr-tetso");
    assert.throws(
      () => team.assign({ patientId: P, practitionerId: "dr-hale", role: "primary", by: { actorId: "ops" } }),
      (err: unknown) => err instanceof Refusal && /already has a primary/.test((err as Error).message)
    );
    team.retire(first.id);
    const next = team.assign({ patientId: P, practitionerId: "dr-hale", role: "primary", by: { actorId: "ops" } });
    assert.equal(team.primary(P)?.id, next.id);
    assert.equal(team.forPatient(P, { includeRetired: true }).length, 2, "the first membership is still there");
    assert.ok(team.forPatient(P, { includeRetired: true }).find((r) => r.id === first.id)?.active_to);
  } finally {
    cleanup();
  }
});

test("an unregistered practitioner cannot be put on a chart", () => {
  const { team, cleanup } = clinic();
  try {
    assert.throws(
      () => team.assign({ patientId: P, practitionerId: "dr-nobody", role: "covering", by: { actorId: "ops" } }),
      Refusal
    );
  } finally {
    cleanup();
  }
});

test("a covering locum is not the primary, and retiring ends the stretch", () => {
  const { team, cleanup } = clinic();
  try {
    team.assign({ patientId: P, practitionerId: "dr-tetso", role: "primary", by: { actorId: "ops" } });
    const locum = team.assign({
      patientId: P,
      practitionerId: "dr-hale",
      role: "covering",
      organizationId: "yk-clinic",
      by: { actorId: "ops" },
    });
    assert.equal(team.primary(P)?.practitioner_id, "dr-tetso");
    assert.equal(team.forPractitioner("dr-hale")[0].role, "covering");
    team.retire(locum.id);
    assert.equal(team.forPractitioner("dr-hale").length, 0);
    assert.throws(() => team.retire(locum.id), (err: unknown) => err instanceof Refusal && /already ended/.test((err as Error).message));
  } finally {
    cleanup();
  }
});

test("one custodian's care team is not another's", () => {
  const dir = mkdtempSync(join(tmpdir(), "portage-team-iso-"));
  const root = new Db(join(dir, "portage.db"));
  try {
    root.createTenant("north", "Northern Health");
    root.createTenant("south", "Southern Health");
    const northDb = root.forTenant("north");
    const southDb = root.forTenant("south");
    new Directory(northDb).addPractitioner({ id: "dr-tetso", family: "Tetso" });
    new Directory(southDb).addPractitioner({ id: "dr-tetso", family: "Tetso" });
    const north = new CareTeam(northDb);
    const south = new CareTeam(southDb);
    north.assign({ patientId: P, practitionerId: "dr-tetso", role: "primary", by: { actorId: "ops" } });
    assert.equal(north.primary(P)?.practitioner_id, "dr-tetso");
    assert.equal(south.primary(P), undefined);
  } finally {
    root.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
