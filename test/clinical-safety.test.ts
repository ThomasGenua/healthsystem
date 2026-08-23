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
