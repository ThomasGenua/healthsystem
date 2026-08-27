/**
 * Eligibility is a claim that changes, and the previous claim stays.
 *
 * Overwriting "eligible" with "ineligible" loses "were they covered when
 * this visit happened". A billing dispute and a coverage audit both ask
 * that, and an in-place update cannot answer it.
 *
 * "Unknown" is a real eligibility, not a missing field.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../src/db.ts";
import { Coverage } from "../src/clinical/coverage.ts";
import { Refusal } from "../src/core/refusal.ts";

function clinic() {
  const dir = mkdtempSync(join(tmpdir(), "northstar-cov-"));
  const db = new Db(join(dir, "northstar.db"));
  return {
    db,
    coverage: new Coverage(db),
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const P = "NT123456";

test("a change of eligibility keeps the previous claim", () => {
  const { coverage, cleanup } = clinic();
  try {
    const first = coverage.record({
      patientId: P,
      plan: "NIHB",
      eligibility: "eligible",
      identifierSystem: "urn:jhn",
      identifierValue: P,
      by: { actorId: "clerk" },
    });
    const next = coverage.record({
      patientId: P,
      plan: "NIHB",
      eligibility: "ineligible",
      detail: "card expired",
      by: { actorId: "clerk" },
    });
    assert.equal(next.supersedes, first.id);
    assert.equal(coverage.current(P)?.id, next.id);
    assert.equal(coverage.current(P)?.eligibility, "ineligible");
    assert.equal(coverage.history(P).length, 2);
    assert.equal(coverage.get(first.id)?.eligibility, "eligible", "the original claim is still readable");
  } finally {
    cleanup();
  }
});

test("unknown is a recorded eligibility, not an empty field", () => {
  const { coverage, cleanup } = clinic();
  try {
    assert.throws(() => coverage.record({ patientId: P, plan: "", eligibility: "unknown", by: { actorId: "clerk" } }), Refusal);
    const row = coverage.record({ patientId: P, plan: "OHIP", eligibility: "unknown", detail: "card not presented", by: { actorId: "clerk" } });
    assert.equal(row.eligibility, "unknown");
    assert.equal(coverage.current(P)?.id, row.id);
  } finally {
    cleanup();
  }
});

test("one custodian's coverage is not another's", () => {
  const dir = mkdtempSync(join(tmpdir(), "northstar-cov-iso-"));
  const root = new Db(join(dir, "northstar.db"));
  try {
    root.createTenant("north", "Northern Health");
    root.createTenant("south", "Southern Health");
    const north = new Coverage(root.forTenant("north"));
    const south = new Coverage(root.forTenant("south"));
    north.record({ patientId: P, plan: "NIHB", eligibility: "eligible", by: { actorId: "clerk" } });
    assert.equal(north.current(P)?.plan, "NIHB");
    assert.equal(south.current(P), undefined);
  } finally {
    root.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
