/** Provision a local administrator. Credentials arrive on stdin, never in source or argv. */
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { AdminAccounts } from "../src/auth/admin-accounts.ts";
import { readEnv, resolveDbPath } from "../src/core/naming.ts";
console.log("Enter one JSON line containing email and password on stdin.");
if (process.stdin.isTTY) process.stdin.setRawMode(true);
let input = "";
for await (const chunk of process.stdin) { input += chunk; if (/[\r\n]/.test(input)) break; }
if (process.stdin.isTTY) process.stdin.setRawMode(false);
const body = JSON.parse(input);
const sql = new DatabaseSync(resolveDbPath(readEnv("DATA") ?? join(process.cwd(), "data")).path);
try {
  const account = new AdminAccounts(sql).create(body.email, body.password);
  console.log(`Administrator created: ${account.email}`);
} finally { sql.close(); }
