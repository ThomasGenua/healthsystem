/**
 * The guard that needs two trees.
 *
 * `clinical-safety.test.ts` checks the log in front of it: no duplicate, no
 * gap, every citation resolving. A hazard identifier is allocated by reading
 * the last row and adding one, which is a shared counter with nobody holding
 * it — so two branches taken from a log ending at H-162 both allocate H-163,
 * and each is perfectly clean on its own. The collision exists only between
 * them, and nothing reading one tree can see it.
 *
 * It has happened twice here. The second time, both sides had allocated two.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { compareHazards, explain, nextId, parseHazards, type Revisions } from "../src/safety/hazard-ids.ts";

const HEADER = "| ID | Hazard | Cause | Effect | Sev. | Like. | Control | Evidence |\n|---|---|---|---|---|---|---|---|\n";
/** A log from rows given as [id, name] or [id, name, control]. */
const log = (...rows: Array<[string, string, string?]>): string =>
  HEADER + rows.map(([id, name, control]) => `| ${id} | ${name} | cause | effect | Major | Low | ${control ?? "control"} | evidence |`).join("\n");

const revs = (mergeBase: string, baseTip: string, head: string): Revisions => ({
  mergeBase: parseHazards(mergeBase),
  baseTip: parseHazards(baseTip),
  head: parseHazards(head),
});

test("a hazard is read as an identifier and the name that gives it identity", () => {
  const rows = parseHazards(log(["H-01", "A silent overwrite"], ["H-02", "A result on the wrong chart"]));
  assert.deepEqual(rows, [
    { id: "H-01", name: "A silent overwrite" },
    { id: "H-02", name: "A result on the wrong chart" },
  ]);
  assert.equal(nextId(rows), "H-03");
});

test("two branches allocating one number for two hazards is a collision", () => {
  // The real case, twice over: both branches took a log ending at H-162 and
  // both wrote H-163 and H-164.
  const shared = log(["H-162", "A token minted for another application"]);
  const main = log(["H-162", "A token minted for another application"], ["H-163", "A message that can never be delivered"], ["H-164", "One specimen requisitioned twice"]);
  const branch = log(["H-162", "A token minted for another application"], ["H-163", "A patient's data copied into the log"], ["H-164", "An unreachable source reports itself healthy"]);

  const found = compareHazards(revs(shared, main, branch));
  assert.equal(found.length, 2);
  assert.deepEqual(found.map((c) => [c.kind, c.id]), [["renamed", "H-163"], ["renamed", "H-164"]]);
});

test("a hazard the base branch added after this one was taken is not a deletion", () => {
  // The first version of this reported six hazards as deleted that were
  // simply newer than the branch. Being behind is not the same as dropping
  // something, and a check that cannot tell them apart cries wolf on every
  // branch older than an afternoon.
  const shared = log(["H-01", "A silent overwrite"]);
  const main = log(["H-01", "A silent overwrite"], ["H-02", "Something main added since"]);
  const branch = log(["H-01", "A silent overwrite"], ["H-03", "Something this branch added"]);

  assert.deepEqual(compareHazards(revs(shared, main, branch)), []);
});

test("a hazard that was there when the branch was taken and is gone now is reported", () => {
  // The resolution nothing else catches: a merge conflict settled by keeping
  // one side, which reads afterwards as a clean, gapless, duplicate-free log
  // with a hazard missing the way an unwritten one is missing.
  const shared = log(["H-01", "A silent overwrite"], ["H-02", "A result on the wrong chart"]);
  const branch = log(["H-01", "A silent overwrite"]);

  const found = compareHazards(revs(shared, shared, branch));
  assert.deepEqual(found, [{ kind: "removed", id: "H-02", base: "A result on the wrong chart" }]);
  assert.match(explain(found, revs(shared, shared, branch)), /retired in place/);
});

test("refining a hazard's control and evidence is not a collision", () => {
  // What a live safety case does all day. Only the name is identity; the
  // analysis around it is expected to improve, and a check that fought that
  // would be a check people learn to route around.
  const before = log(["H-01", "A silent overwrite", "append-only"]);
  const after = log(["H-01", "A silent overwrite", "append-only, and a per-patient hash chain"]);

  assert.deepEqual(compareHazards(revs(before, before, after)), []);
});

test("adding hazards is the ordinary case and is never reported", () => {
  const shared = log(["H-01", "A silent overwrite"]);
  const branch = log(["H-01", "A silent overwrite"], ["H-02", "New here"], ["H-03", "Also new here"]);
  assert.deepEqual(compareHazards(revs(shared, shared, branch)), []);
});

test("the number it suggests is free on both branches, not just on this one", () => {
  // Suggesting one free only here would recommend an identifier the base has
  // already spent -- the very mistake being reported, handed back as advice.
  const shared = log(["H-01", "Shared"]);
  const main = log(["H-01", "Shared"], ["H-02", "Main's"], ["H-03", "Main's again"], ["H-04", "And again"]);
  const branch = log(["H-01", "Shared"], ["H-02", "This branch's"]);

  const r = revs(shared, main, branch);
  const message = explain(compareHazards(r), r);
  assert.match(message, /one to H-05/, "H-05 clears both; H-03 would collide again");
  assert.doesNotMatch(message, /one to H-0[34]\b/, "never a number the base branch has already spent");
  // Padded the way the log itself is: advice reading H-5 among H-01s is
  // advice a contributor has to correct before following.
  assert.doesNotMatch(message, /one to H-5\b/);
});
