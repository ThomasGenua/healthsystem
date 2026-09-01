/**
 * Provenance for clinical scores.
 *
 * These vectors are a second encoding of the cited threshold tables. They
 * catch drift between the governed definition and the arithmetic, but they are
 * not independent clinical validation; the catalogue must keep saying that
 * until a named clinical owner reviews and signs the implementation.
 */
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SCORE_DEFINITIONS,
  SCORE_IDS,
  score,
  type ScoreId,
} from "../src/clinical/scores.ts";

interface GoldenVector {
  id: ScoreId;
  source: string;
  basis: string;
  input: Record<string, unknown>;
  expected: { score: number; band: string };
}

const vectors = JSON.parse(
  readFileSync(new URL("../fixtures/clinical-scores/golden.json", import.meta.url), "utf8")
) as GoldenVector[];

test("every score has one governed definition and one source-linked golden vector", () => {
  assert.deepEqual(vectors.map((v) => v.id).sort(), [...SCORE_IDS].sort());
  assert.deepEqual(Object.keys(SCORE_DEFINITIONS).sort(), [...SCORE_IDS].sort());

  for (const id of SCORE_IDS) {
    const definition = SCORE_DEFINITIONS[id];
    const vector = vectors.find((v) => v.id === id)!;
    assert.equal(definition.id, id);
    assert.equal(vector.source, definition.source.url, `${id} vector and definition must cite the same source`);
    assert.match(definition.implementationVersion, /^portage-[1-9][0-9]*$/);
    assert.ok(definition.instrumentVersion.length > 10);
    assert.ok(definition.intendedPopulation.endsWith("."));
    assert.ok(definition.exclusions.length > 0);
    assert.equal(definition.assurance.independentClinicalReview, false);
    assert.equal(definition.assurance.clinicalOwner, null);
    assert.equal(definition.assurance.reviewedAt, null);
    assert.equal(definition.assurance.reviewDue, null);
  }
});

test("source-linked golden vectors reproduce their governed scores", () => {
  for (const vector of vectors) {
    const result = score(vector.id, vector.input);
    assert.equal(result.complete, true, `${vector.id}: ${vector.basis}`);
    if (!result.complete) continue;
    assert.equal(result.score, vector.expected.score, vector.id);
    assert.equal(result.band, vector.expected.band, vector.id);
    assert.equal(result.definition, SCORE_DEFINITIONS[vector.id]);
    assert.equal(result.definition.source.url, vector.source);
    assert.deepEqual(result.suppliedInputs, Object.fromEntries(Object.entries(vector.input).sort(([a], [b]) => a.localeCompare(b))));
    assert.ok(Number.isFinite(Date.parse(result.calculatedAt)));
  }
});

test("an incomplete calculation still identifies its definition and preserves the supplied evidence", () => {
  const result = score("curb-65", { confusion: false, ureaMmolL: 4 });
  assert.equal(result.complete, false);
  assert.equal(result.definition.instrumentVersion, "Lim et al. 2003 CURB-65");
  assert.deepEqual(result.suppliedInputs, { confusion: false, ureaMmolL: 4 });
  assert.ok(!("score" in result));
});

test("MELD-Na says that it is the historical 2016 formula, not current MELD 3.0", () => {
  const definition = SCORE_DEFINITIONS["meld-na"];
  assert.match(definition.instrumentVersion, /2016/);
  assert.match(definition.instrumentVersion, /not MELD 3\.0/);
  assert.ok(definition.exclusions.some((x) => /current OPTN MELD 3\.0/.test(x)));
});

test("NEWS2 says that only Scale 1 is implemented", () => {
  const definition = SCORE_DEFINITIONS.news2;
  assert.match(definition.instrumentVersion, /Scale 1 only/);
  assert.ok(definition.exclusions.some((x) => /does not implement Scale 2/.test(x)));
});

