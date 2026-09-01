/**
 * The safety case is only as true as the tests it points at.
 *
 * `docs/CLINICAL-SAFETY.md` is the form a clinical safety officer can open.
 * Its evidence column cites tests by file and by name. A citation that
 * survives a rename or a deletion is the same silent failure the rest of
 * this repository refuses: a control that reports itself in force while
 * pinning nothing.
 *
 * So this reads the log and requires every cited test to still exist.
 * Adding a hazard without a real test fails the build, which is the
 * point of putting the evidence in the document at all.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const CASE = new URL("../docs/CLINICAL-SAFETY.md", import.meta.url);
const CITE = /`([^`]+\.test\.ts)`\s+[—-]\s+"([^"]+)"/g;

test("every hazard-log citation points at a test that still exists", () => {
  const text = readFileSync(CASE, "utf8");
  const cites = [...text.matchAll(CITE)].map((m) => ({ file: m[1], name: m[2] }));
  assert.ok(cites.length >= 30, `expected the log to cite many tests, got ${cites.length}`);

  const missing: string[] = [];
  for (const { file, name } of cites) {
    const path = new URL(`../${file}`, import.meta.url);
    let src: string;
    try {
      src = readFileSync(path, "utf8");
    } catch {
      missing.push(`${file} is gone (cited for "${name}")`);
      continue;
    }
    const found = src.includes(`test("${name}"`) || src.includes(`test('${name}'`);
    if (!found) missing.push(`${file} has no test("${name}")`);
  }
  assert.deepEqual(missing, [], missing.join("\n"));
});

test("every hazard has its own identifier", () => {
  // A hazard id is how a control, a test and a review minute refer to one
  // hazard rather than another. Two rows sharing an id breaks that: a control
  // traced to "H-108" is traced to whichever of them the reader happens to
  // find first, and the safety case stops being able to say which hazard is
  // mitigated.
  //
  // It happens the ordinary way — two branches numbering from the same last
  // row and both merging — so it is not a mistake anybody makes by being
  // careless. Nothing here was checking for it, and a duplicate would have
  // reached `main` looking exactly like a correct log.
  const text = readFileSync(CASE, "utf8");
  const ids = [...text.matchAll(/^\| (H-\d+) \|/gm)].map((m) => m[1]);
  assert.ok(ids.length >= 100, `expected the log to carry many hazards, got ${ids.length}`);

  const seen = new Set<string>();
  const duplicated = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) duplicated.add(id);
    seen.add(id);
  }
  assert.deepEqual(
    [...duplicated].sort(),
    [],
    "two hazards share an identifier; renumber the later branch rather than merging both"
  );
});

test("the hazard numbering has no gaps", () => {
  // A gap is a hazard that was raised and then removed, which is a decision
  // somebody should have to make deliberately. Left unnoticed it also reads as
  // a numbering that can be reused, which is how the duplicate above happens.
  const text = readFileSync(CASE, "utf8");
  const numbers = [...text.matchAll(/^\| H-(\d+) \|/gm)].map((m) => Number(m[1])).sort((a, b) => a - b);
  const gaps: string[] = [];
  for (let i = 1; i < numbers.length; i++) {
    if (numbers[i] !== numbers[i - 1] + 1) gaps.push(`H-${numbers[i - 1]} -> H-${numbers[i]}`);
  }
  assert.deepEqual(gaps, [], "the hazard log skips a number");
});
