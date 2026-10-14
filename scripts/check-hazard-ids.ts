/**
 * Fails when this revision spends a hazard identifier the base branch has
 * already spent on something else, or drops one the base branch has.
 *
 * Run in CI on a pull request, where both sides are on disk. Locally:
 *
 *     node scripts/check-hazard-ids.ts [base-ref]
 *
 * The base defaults to `origin/main`. With no such ref — a shallow clone, a
 * fresh repository, a checkout with no remote — it says so and exits 0: the
 * check has nothing to compare against, and reporting a comparison it did
 * not make would be worse than reporting nothing.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { compareHazards, explain, parseHazards } from "../src/safety/hazard-ids.ts";

const LOG = "docs/CLINICAL-SAFETY.md";
const base = process.argv[2] ?? "origin/main";

function atRef(ref: string, path: string): string | undefined {
  try {
    return execFileSync("git", ["show", `${ref}:${path}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return undefined;
  }
}

// Both references are needed, and they answer different questions: a rename
// is judged against the tip this will merge into, a removal against the point
// the branch was taken from. See src/safety/hazard-ids.ts.
let mergeBaseRef = base;
try {
  mergeBaseRef = execFileSync("git", ["merge-base", "HEAD", base], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
} catch {
  /* no common ancestor; the tip is the best available answer to both */
}

const tipLog = atRef(base, LOG);
const mergeBaseLog = atRef(mergeBaseRef, LOG);
if (tipLog === undefined || mergeBaseLog === undefined) {
  console.log(`hazard ids: no ${LOG} at ${base}; nothing to compare against, so nothing checked.`);
  process.exit(0);
}

const revs = {
  mergeBase: parseHazards(mergeBaseLog),
  baseTip: parseHazards(tipLog),
  head: parseHazards(readFileSync(LOG, "utf8")),
};
const collisions = compareHazards(revs);
if (collisions.length === 0) {
  console.log(`hazard ids: ${revs.head.length} rows, none of them reusing an identifier from ${base}.`);
  process.exit(0);
}
console.error(explain(collisions, revs));
process.exit(1);
