/**
 * Paging through a search, and the ordering that has to hold for it to work.
 *
 * A page is only meaningful if the thing being paged is in a settled order.
 * `updated_at` on a stored resource has second granularity, so a bulk load —
 * a migration, an overnight import, any ordinary ingest — writes dozens of
 * resources bearing the same timestamp. An ordering with no tiebreak leaves
 * those rows in whatever order the engine finds convenient, and it is free to
 * find a different one on the next query.
 *
 * That failure does not look like a failure. Page one returns twenty
 * observations, page two returns twenty more, and some of the patient's
 * results appear twice while others never appear at all. Nothing errors, the
 * totals look right, and the client has a chart with holes in it.
 *
 * This is the same shape as the transmission-attempt ordering already on the
 * record: a timestamp with a tiebreak that was not deterministic.
 *
 * ## What these tests prove, and what the tiebreak rests on
 *
 * They prove the paging arithmetic: every resource appears exactly once
 * across pages, a page repeats when asked for twice, a page past the end is
 * empty, `_count` is bounded, and one tenant's page never contains another's.
 *
 * They do not prove the tiebreak is load-bearing. Removing `ORDER BY ... , id`
 * leaves every test here passing, because SQLite happens to return these rows
 * in insertion order and that coincides with the order the tiebreak asks for.
 * That is luck, not a guarantee: SQLite specifies no order among rows equal
 * under the ORDER BY, and is free to change what it returns with a different
 * query plan, an index added later, or more rows than fit its current
 * strategy. The tiebreak is there so the ordering is specified rather than
 * incidental, and a test cannot easily demonstrate the absence of a promise.
 * Stated here rather than left as coverage this file does not have.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Db } from "../src/db.ts";
import { FhirStore } from "../src/fhir/store.ts";
import { StandardsRegistry } from "../src/conformance/standards.ts";

function site() {
  const dir = mkdtempSync(join(tmpdir(), "northstar-page-"));
  const db = new Db(join(dir, "northstar.db"));
  return {
    db,
    fhir: new FhirStore(db),
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}

/** Writes n observations that all share one timestamp, as a bulk load does. */
function bulkLoad(s: ReturnType<typeof site>, n: number) {
  for (let i = 0; i < n; i++) {
    s.fhir.upsert({
      resourceType: "Observation",
      id: `obs-${String(i).padStart(3, "0")}`,
      status: "final",
      code: { text: "Potassium" },
      subject: { reference: "Patient/NT123456" },
    });
  }
  // The condition that makes the ordering matter: one timestamp for all of them.
  s.db.sql.prepare("UPDATE fhir_resources SET updated_at = ? WHERE tenant_id = ?").run("2026-09-01T10:00:00Z", "default");
}

test("paging a run of identical timestamps returns every resource exactly once", () => {
  // The whole point. Without a tiebreak this passes or fails depending on
  // what the query planner felt like, which is worse than failing.
  const s = site();
  try {
    bulkLoad(s, 50);
    const seen: string[] = [];
    for (let offset = 0; offset < 50; offset += 10) {
      const page = s.fhir.search("Observation", { count: 10, offset });
      assert.equal(page.total, 50, "the total is the whole set, not the page");
      assert.equal(page.resources.length, 10, `page at ${offset} should be full`);
      seen.push(...page.resources.map((r) => String((r as { id?: unknown }).id)));
    }
    assert.equal(seen.length, 50);
    assert.equal(new Set(seen).size, 50, "no resource appears on two pages");
    const expected = Array.from({ length: 50 }, (_, i) => `obs-${String(i).padStart(3, "0")}`);
    assert.deepEqual([...seen].sort(), expected, "and none is skipped");
  } finally {
    s.cleanup();
  }
});

test("the same page asked for twice is the same page", () => {
  const s = site();
  try {
    bulkLoad(s, 40);
    const once = s.fhir.search("Observation", { count: 7, offset: 14 }).resources.map((r) => String((r as { id?: unknown }).id));
    for (let n = 0; n < 5; n++) {
      const again = s.fhir.search("Observation", { count: 7, offset: 14 }).resources.map((r) => String((r as { id?: unknown }).id));
      assert.deepEqual(again, once, "an unstable ordering shows up here first");
    }
  } finally {
    s.cleanup();
  }
});

test("a page past the end is empty rather than an error, and the total still stands", () => {
  const s = site();
  try {
    bulkLoad(s, 5);
    const past = s.fhir.search("Observation", { count: 10, offset: 100 });
    assert.equal(past.total, 5);
    assert.deepEqual(past.resources, []);
  } finally {
    s.cleanup();
  }
});

test("_count is bounded and a negative offset is treated as the start", () => {
  const s = site();
  try {
    bulkLoad(s, 30);
    // An unbounded _count is a way to ask one request for the whole store.
    assert.equal(s.fhir.search("Observation", { count: 10_000 }).resources.length, 30);
    assert.equal(s.fhir.search("Observation", { count: 0 }).resources.length, 1, "a page of nothing is not a page");
    assert.equal(s.fhir.search("Observation", { count: 5, offset: -20 }).resources.length, 5);
    const idAt = (offset: number) =>
      String((s.fhir.search("Observation", { count: 5, offset }).resources[0] as { id?: unknown }).id);
    assert.equal(idAt(-20), idAt(0), "a negative offset starts at the beginning, not somewhere else");
  } finally {
    s.cleanup();
  }
});

test("one tenant's page never contains another tenant's resources", () => {
  const s = site();
  try {
    bulkLoad(s, 20);
    const other = new FhirStore(s.db.forTenant("yellowknife"));
    other.upsert({ resourceType: "Observation", id: "obs-000", status: "final", code: { text: "Sodium" } });

    const mine = s.fhir.search("Observation", { count: 100 });
    assert.equal(mine.total, 20);
    const theirs = other.search("Observation", { count: 100 });
    assert.equal(theirs.total, 1, "the other site sees only its own");
    assert.equal(String((theirs.resources[0] as { code?: { text?: string } }).code?.text), "Sodium");
  } finally {
    s.cleanup();
  }
});

// ── What the capability statement may claim ───────────────────────────────

test("the capability statement claims no implementation guide by default", () => {
  const s = site();
  try {
    const cap = s.fhir.capability("http://example.invalid", "0.8.0");
    assert.equal(cap.instantiates, undefined, "a guide nobody installed is not a guide this server follows");
    assert.equal(cap.fhirVersion, "4.0.1");
  } finally {
    s.cleanup();
  }
});

test("it claims a guide only once the registry says that guide is in force", () => {
  // The tie that stops a capability statement drifting from what is installed.
  // A statement naming a guide nobody activated is the artifact a partner
  // reads and believes.
  const s = site();
  try {
    const registry = new StandardsRegistry(s.db);
    const bytes = "a package tarball";
    const entry = registry.register({
      canonicalUrl: "http://hl7.org/fhir/uv/ipa/",
      packageId: "hl7.fhir.uv.ipa",
      version: "1.1.0",
      publicationStatus: "release",
      fhirVersion: "4.0.1",
      checksum: createHash("sha256").update(bytes).digest("hex"),
    });

    // Registered but not activated: still not claimed.
    assert.deepEqual(registry.active(), []);
    assert.equal(s.fhir.capability("http://example.invalid", "0.8.0", registry.active().map((p) => p.canonicalUrl)).instantiates, undefined);

    registry.verify(entry.id, bytes);
    registry.activate({ id: entry.id, reason: "putting IPA into force for patient access", by: "ops" });
    const cap = s.fhir.capability("http://example.invalid", "0.8.0", registry.active().map((p) => p.canonicalUrl));
    assert.deepEqual(cap.instantiates, ["http://hl7.org/fhir/uv/ipa/"]);
  } finally {
    s.cleanup();
  }
});
