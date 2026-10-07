/**
 * The package builds the same twice.
 *
 * An attestation says where a tarball came from; it says nothing about
 * whether anyone else can produce the same one, and a signature over a build
 * nobody can reproduce is not what "verifiable" means to the person asking.
 * This is the other half, and it has to be re-earned per commit rather than
 * established once: a build date written into a file, a generated list
 * ordered by a filesystem, a dependency baked in at pack time — each leaves a
 * package that still installs and still passes every other test here, and
 * quietly stops matching.
 *
 * The work is in `scripts/repro-pack.ts`, which this runs rather than
 * reimplements, so the thing CI gates on is the thing under test. It packs
 * two independent checkouts of HEAD — not one tree twice, because the usual
 * cause is a timestamp and a second pack of the same tree sees the same
 * mtimes.
 *
 * Skipped outside a git work tree (an installed tarball has no `.git`, and
 * there is nothing to check out twice), rather than quietly asserting
 * nothing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function inGitWorkTree(): boolean {
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: ROOT, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

test(
  "two checkouts of this commit pack to the same bytes",
  { skip: inGitWorkTree() ? false : "not a git work tree; nothing to check out twice", timeout: 120_000 },
  () => {
    const run = spawnSync("node", ["scripts/repro-pack.ts"], { cwd: ROOT, encoding: "utf8" });

    assert.equal(
      run.status,
      0,
      `the package did not build reproducibly:\n${run.stdout}\n${run.stderr}`
    );
    // The digest is the point of running it, so a pass that printed none
    // would mean the script changed shape and this stopped checking the
    // thing it names.
    assert.match(run.stdout, /identical: [0-9a-f]{64}/, `no digest in:\n${run.stdout}`);
  }
);
