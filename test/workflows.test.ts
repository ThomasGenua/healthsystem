/**
 * Every workflow pins what it runs, and says what its token may do.
 *
 * ci.yml states both rules at the top: a third-party action is pinned to a
 * commit, because a tag is a pointer its owner can move and these steps hold
 * a checkout and a token; and a job's token is no wider than it needs. The
 * commit that pinned ci.yml and resilience.yml did not touch staging.yml and
 * monitoring.yml, which had been added four days before it — so they went on
 * running `actions/checkout@v4` and `actions/setup-node@v4` by tag, on the
 * runtime the pinning commit had moved everything else off. Nothing checked,
 * so a workflow added next week would have done the same. This checks.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

const DIR = new URL("../.github/workflows/", import.meta.url);
const workflows = readdirSync(DIR)
  .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
  .map((name) => ({ name, text: readFileSync(new URL(name, DIR), "utf8") }));

test("workflows: every action is pinned to a commit, with the release it came from beside it", () => {
  // A scanner that silently matches nothing is worse than no scanner.
  assert.ok(workflows.length >= 4, `expected the workflows, found ${workflows.length}`);
  const found: string[] = [];
  const unpinned: string[] = [];
  for (const { name, text } of workflows) {
    for (const m of text.matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)(.*)$/gm)) {
      const [, ref, rest] = m;
      found.push(`${name}: ${ref}`);
      if (ref.startsWith("./")) continue; // an action in this repository is reviewed with it
      const pinned = /^[\w.-]+\/[\w.-]+(?:\/[\w./-]+)?@[0-9a-f]{40}$/.test(ref) && /^\s*#\s*v\d+(?:\.\d+)*\s*$/.test(rest);
      if (!pinned) unpinned.push(`${name}: uses: ${ref}${rest}`);
    }
  }
  assert.ok(found.length >= 10, `expected every step that uses an action, found ${found.length}`);
  assert.deepEqual(unpinned, [], `pin each to a commit with "# vX.Y.Z" beside it:\n${unpinned.join("\n")}`);
});

test("workflows: every workflow says what its token may do, instead of taking the repository's default", () => {
  const unset = workflows.filter(({ text }) => !/^permissions:\s*$/m.test(text)).map(({ name }) => name);
  assert.deepEqual(unset, [], `add a top-level permissions block (contents: read, unless a job needs more):\n${unset.join("\n")}`);
});
