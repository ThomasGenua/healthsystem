/**
 * Packs this commit twice, from two independent checkouts, and fails if the
 * two tarballs differ.
 *
 *     node scripts/repro-pack.ts [--keep]
 *
 * The attestation added with the SBOM says where an artifact came from. It
 * does not say that anybody else can produce the same one, and those are
 * different claims: provenance is a signature over a build nobody can
 * reproduce, which is worth something but not what "verifiable" usually means
 * to the person asking. This is the other half — and it is a claim that has
 * to be re-earned on every commit rather than established once, because it
 * breaks quietly. A build date written into a file, a generated list ordered
 * by a filesystem, a dependency baked into the package: each produces a
 * tarball that still installs and still passes, and stops matching.
 *
 * Two *checkouts* rather than two runs in one directory, because the usual
 * way this breaks is a timestamp, and a second pack of the same working tree
 * sees the same mtimes. A fresh clone has its own, so a tarball that embeds
 * one fails here.
 *
 * What it does not establish: that a different npm, Node, platform or locale
 * produces the same bytes. It runs whatever is invoking it. The measured
 * conditions are in `docs/STATE_OF_THE_ART_ROADMAP.md` under 56, along with
 * what was checked by hand and what was not.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const keep = process.argv.includes("--keep");

function git(args: string[], cwd = ROOT): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** One checkout of `commit`, packed; returns the tarball's digest and name. */
function packFrom(commit: string, label: string): { digest: string; name: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), `northstar-repro-${label}-`));
  // A local clone, so this works with no network and cannot pick up a
  // different revision than the one being checked.
  execFileSync("git", ["clone", "--quiet", "--no-hardlinks", ROOT, dir], { stdio: ["ignore", "ignore", "pipe"] });
  git(["checkout", "--quiet", commit], dir);
  const out = join(dir, "out");
  // npm writes into this rather than creating it.
  mkdirSync(out, { recursive: true });
  execFileSync("npm", ["pack", "--pack-destination", out], { cwd: dir, stdio: ["ignore", "ignore", "pipe"] });

  const files = readdirSync(out).filter((f) => f.endsWith(".tgz"));
  if (files.length !== 1) throw new Error(`expected one tarball from ${label}, got ${files.length}`);
  const digest = createHash("sha256").update(readFileSync(join(out, files[0]))).digest("hex");
  return { digest, name: files[0], dir };
}

const commit = git(["rev-parse", "HEAD"]);
const dirty = git(["status", "--porcelain"]) !== "";

console.log(`packing ${commit.slice(0, 12)} twice, from two checkouts`);
if (dirty) {
  // Said rather than refused. Both checkouts come from the commit, so the
  // comparison is still valid — it just is not about the tree on disk, and
  // reading the digest as this working copy's would be wrong.
  console.log("note: the working tree has uncommitted changes, which are not in either checkout");
}

const made: string[] = [];
try {
  const first = packFrom(commit, "a");
  made.push(first.dir);
  const second = packFrom(commit, "b");
  made.push(second.dir);

  console.log(`  ${first.name}  ${first.digest}`);
  console.log(`  ${second.name}  ${second.digest}`);

  if (first.digest !== second.digest) {
    console.error(
      "\nthe two tarballs differ, so this commit does not build reproducibly.\n" +
        "Something in the package varies between checkouts — most often a timestamp\n" +
        "written into a file, or a generated list whose order came from a filesystem.\n" +
        `Compare them with:  tar tvf ${join(first.dir, "out", first.name)}`
    );
    process.exit(1);
  }
  console.log(`\nidentical: ${first.digest}`);
} finally {
  if (keep) for (const d of made) console.log(`kept ${d}`);
  else for (const d of made) rmSync(d, { recursive: true, force: true });
}
