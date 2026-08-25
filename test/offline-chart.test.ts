/**
 * Staleness as a first-class incompleteness — the vocabulary half of #38.
 *
 * The reading station is a design (docs/OFFLINE-CHART.md) until it is built,
 * but the property it depends on is buildable and testable now: a chart
 * assembled from a cache must carry its age on the face of every panel, in
 * the same vocabulary as `unavailable`, `truncated` and `withheld`. A cached
 * "no known drug allergies" from before this morning's reaction is worse
 * than no chart at all, because a clinician reads it as current and stops
 * asking — so a chart handed an `asOf` is never `complete`, and a cache that
 * cannot establish its own age does not serve.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { Db } from "../src/db.ts";
import { MedicationStore } from "../src/meds/store.ts";
import { Workspace, describe, type Section } from "../src/workspace/summary.ts";

const P = "NT600001";
const REGISTRAR = { actorId: "registrar", actorKind: "staff" };

function hoursAgo(h: number): string {
  return new Date(Date.now() - h * 36e5).toISOString();
}

test("a chart assembled from a cache wears its age on every panel", () => {
  const db = new Db(":memory:");
  try {
    const meds = new MedicationStore(db);
    meds.recordAllergy({ patientId: P, display: "Penicillin", ingredient: "penicillin", criticality: "high", by: REGISTRAR });
    const ws = new Workspace({ meds });

    const fresh = ws.chart(P);
    assert.equal(fresh.stale, undefined);
    assert.equal(fresh.allergies.complete, true, "the primary's chart is unchanged by the vocabulary existing");

    const cached = ws.chart(P, { asOf: hoursAgo(14) });
    assert.equal(cached.complete, false, "complete-as-of-14-hours-ago is not complete");
    assert.equal(cached.allergies.complete, false);
    assert.equal(cached.allergies.incomplete?.reason, "stale");
    if (cached.allergies.incomplete?.reason === "stale") {
      assert.ok(
        Math.abs(cached.allergies.incomplete.ageHours - 14) < 0.2,
        `the panel says how old it is (${cached.allergies.incomplete.ageHours})`
      );
    }
    // The rows themselves still serve — a stale allergy list is far better
    // than none, as long as nothing pretends it is current.
    assert.equal(cached.allergies.items.length, 1);

    assert.ok(cached.stale, "the age is at the top of the summary too");
    assert.match(cached.stale?.note ?? "", /assembled from a cache/);
    assert.ok(
      cached.omissions.some((o) => /Every panel: as of 1[34]/.test(o)),
      "and in the omissions, once for the whole chart"
    );
  } finally {
    db.close();
  }
});

test("staleness never displaces a more specific reason", () => {
  const db = new Db(":memory:");
  try {
    const meds = new MedicationStore(db);
    meds.recordAllergy({ patientId: P, display: "Penicillin", ingredient: "penicillin", criticality: "high", by: REGISTRAR });
    const ws = new Workspace({ meds });

    const cached = ws.chart(P, {
      asOf: hoursAgo(3),
      withheldTypes: new Set(["AllergyIntolerance"]),
    });
    // A lockbox is still a lockbox on a cache: the withheld panel says a
    // directive is why, not that it is old — and a section with no store at
    // all still says it failed to load rather than that it is stale.
    assert.equal(cached.allergies.incomplete?.reason, "withheld");
    assert.equal(cached.problems.incomplete?.reason, "unavailable");
    assert.equal(cached.medications.incomplete?.reason, "stale");
  } finally {
    db.close();
  }
});

test("a cache that cannot establish its own age does not serve", () => {
  const db = new Db(":memory:");
  try {
    const ws = new Workspace({ meds: new MedicationStore(db) });
    assert.throws(() => ws.chart(P, { asOf: "the outage started sometime tuesday" }), /cannot establish its own age/);
  } finally {
    db.close();
  }
});

test("the stale reason reads like a sentence a clinician can act on", () => {
  const s: Section<never> = {
    items: [],
    complete: false,
    incomplete: { reason: "stale", asOf: hoursAgo(14), ageHours: 14 },
  };
  assert.equal(
    describe("Allergies", s),
    "Allergies: as of 14 hours ago — anything recorded since the cache was filled is not here"
  );
});

test("the console renders the cache banner from the chart's stale block", () => {
  // The design's second control is the disclosure at the rendering surface.
  // Source-read like the other console guards: the banner must exist, read
  // the stale block, and escape what it interpolates.
  const ui = readFileSync(new URL("../src/api/ui.html", import.meta.url), "utf8");
  assert.match(ui, /c\.stale\?`<div class="banner bad">/, "a cached chart banners as a warning, before anything else");
  assert.match(ui, /esc\(String\(c\.stale\.ageHours\)\)/, "the age is shown, escaped");
  assert.match(ui, /esc\(c\.stale\.note\)/, "and so is the note");
});
