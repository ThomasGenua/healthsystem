/**
 * Checks a database against the things it is supposed to be true of itself.
 *
 *     npm run invariants                 # the configured data directory
 *     node scripts/invariants.ts <path>  # a specific file, e.g. a restored backup
 *
 * Opens the database read-only and runs SELECTs, so it is safe against a
 * live node — and safe to point at a snapshot before restoring it, which is
 * the more useful moment: a backup that carries a cross-tenant reference
 * carries it into whatever you restore it onto.
 *
 * Exit codes are for a cron job that emails on failure:
 *
 *     0  every registered invariant holds
 *     1  at least one is violated
 *     2  at least one could not be evaluated, and an unevaluated check is
 *        not a pass — the database has a schema this registry does not know
 *     3  the database could not be opened at all
 *
 * See docs/RUNBOOK.md, "The database contradicts itself".
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { inspect, render } from "../src/core/invariants.ts";
import { readEnv, resolveDbPath } from "../src/core/naming.ts";

const explicit = process.argv[2];
const dataDir = readEnv("DATA") ?? join(process.cwd(), "data");
const path = explicit ?? resolveDbPath(dataDir).path;

if (!existsSync(path)) {
  console.error(`no database at ${path}`);
  console.error("Pass one explicitly: node scripts/invariants.ts <path-to-db>");
  process.exit(3);
}

let sql: DatabaseSync;
try {
  // Read-only, and stated rather than assumed. Every statement in the
  // inspection is a SELECT; opening this way means a bug that added a write
  // fails loudly here instead of quietly editing an operator's evidence.
  sql = new DatabaseSync(path, { readOnly: true });
} catch (err) {
  console.error(`cannot open ${path}: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(3);
}

try {
  const report = inspect(sql);
  console.log(`${path}`);
  console.log(render(report));
  if (report.violated.length > 0) process.exit(1);
  if (report.unevaluated.length > 0) process.exit(2);
  process.exit(0);
} finally {
  sql.close();
}
