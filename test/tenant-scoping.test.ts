/**
 * Every query against tenant-scoped data names a tenant.
 *
 * This is the test the isolation actually rests on, and it is deliberately not
 * a behavioural one. Behavioural tests prove that the queries someone thought
 * to write a test for are scoped; they say nothing about the fiftieth method,
 * or about the one added next month. A single unscoped `SELECT` is a silent
 * cross-custodian read that returns plausible results and looks like nothing
 * is wrong — which is the failure mode this whole exercise exists to prevent.
 *
 * So this reads the source and checks the property directly: any statement
 * naming a tenant-scoped table must also name `tenant_id`. It is coarse on
 * purpose. A statement that genuinely spans tenants — the migration, the
 * instance lock, a deliberate administrative sweep — declares itself with a
 * `crosses-tenants:` comment giving the reason, so crossing a boundary is
 * always a visible, reviewable act rather than an omission.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { TENANT_SCOPED_TABLES } from "../src/db.ts";

/** Source files that are allowed to contain SQL at all. */
const SQL_SOURCES = [
  "../src/db.ts",
  "../src/audit/store.ts",
  "../src/fhir/store.ts",
  "../src/terminology/store.ts",
  "../src/auth/keys.ts",
  "../src/core/backup.ts",
  "../src/clinical/record.ts",
  "../src/clinical/patients.ts",
  "../src/work/tasks.ts",
  "../src/work/referrals.ts",
  "../src/orders/store.ts",
  "../src/meds/store.ts",
  "../src/workspace/summary.ts",
  "../src/patient/access.ts",
  "../src/population/registry.ts",
  "../src/schedule/store.ts",
  "../src/patient/consent.ts",
  "../src/directory/store.ts",
  "../src/clinical/careteam.ts",
  "../src/clinical/coverage.ts",
  "../src/patient/messaging.ts",
  "../src/patient/enrolment.ts",
  "../src/patient/notice.ts",
  "../src/orders/intake.ts",
  "../src/meds/prescribe.ts",
  "../src/migrate/run.ts",
  "../src/privacy/office.ts",
  "../src/core/retention.ts",
  "../src/schedule/clinics.ts",
  "../src/audit/review.ts",
  "../src/core/channel-versions.ts",
  "../src/core/invariants.ts",
];

/**
 * A table name this scan cannot read.
 *
 * The check below matches literal table names, so a statement that builds its
 * own — `FROM ${table}` — is invisible to it: `touches` comes back empty and
 * the statement is skipped as if it reached nothing tenant-scoped. That is the
 * failure mode this file already fixed twice (a comment that swallowed a third
 * of the source, an exemption borrowed from the method above), and it is worse
 * than either, because a registry-driven query is exactly the kind that sweeps
 * every row of a table.
 *
 * So an unreadable table name is held to the same standard as an unscoped one:
 * name a tenant, or declare that you deliberately cross. The four in
 * `directory/store.ts` name one, and the schema rebuild and the invariant
 * inspection declare that they do not.
 */
const INTERPOLATED_TABLE = /\b(FROM|INTO|UPDATE|JOIN)\s+\$\{/i;

/**
 * Pulls out every SQL statement, in one pass that knows what it is inside.
 *
 * This used to be two steps: blank the comments with a regex, then match
 * quoted strings with another. Both steps are blind to the thing that
 * actually matters — whether a character is inside a string — and the second
 * bug that caused was worse than the first.
 *
 * `SCHEMA` in `db.ts` is a 2,200-line template literal, and one of the SQL
 * comments inside it reads `-- The conformance packs in conformance/*.json`.
 * The `/*` in that glob opened a block comment as far as the stripper was
 * concerned, and the next `*` `/` it found was in a doc comment 270 lines
 * below — so it blanked everything between, including the backtick that
 * closes `SCHEMA` and both backticks of `INDEXES`. From there every backtick
 * paired off by one: code was read as string content and string content as
 * code.
 *
 * The measurable effect was that this scan saw **4 of the 81 statements in
 * `db.ts`** — the schema and the core query layer, the largest SQL source in
 * the repository, 95% invisible to the test its own header calls the one the
 * isolation rests on. It reported no offenders, which is what a check that
 * reads almost nothing looks like from outside.
 *
 * So there is one scanner now. It walks the source once, tracking whether it
 * is in a line comment, a block comment, or a string of each kind, and
 * `${...}` inside a template literal is followed so a nested literal does not
 * end the outer one. A `/*` inside a string is then what it is: text.
 */
function statements(source: string): Array<{ sql: string; line: number }> {
  const out: Array<{ sql: string; line: number }> = [];
  const n = source.length;
  let i = 0;
  let line = 1;
  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === "\n") {
      line++;
      i++;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < n && source[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) {
        if (source[i] === "\n") line++;
        i++;
      }
      i += 2;
      continue;
    }
    if (ch === "`" || ch === '"' || ch === "'") {
      const quote = ch;
      const startLine = line;
      let body = "";
      let depth = 0;
      i++;
      while (i < n) {
        const c = source[i];
        if (c === "\\") {
          body += c + (source[i + 1] ?? "");
          if (source[i + 1] === "\n") line++;
          i += 2;
          continue;
        }
        // Interpolation. Its contents may hold a backtick of their own, and
        // that one closes nothing.
        if (quote === "`" && c === "$" && source[i + 1] === "{") {
          depth++;
          body += "${";
          i += 2;
          continue;
        }
        if (quote === "`" && depth > 0 && c === "}") {
          depth--;
          body += c;
          i++;
          continue;
        }
        if (c === quote && depth === 0) break;
        if (c === "\n") line++;
        body += c;
        i++;
      }
      i++;
      if (/^\s*(SELECT|INSERT|UPDATE|DELETE)\b/i.test(body)) out.push({ sql: body, line: startLine });
      continue;
    }
    i++;
  }
  return out;
}

/**
 * Everything written about the statement at `line`: its enclosing method and
 * that method's comments.
 *
 * The boundary walked back to is the previous method's closing brace, because
 * the unit an exemption is written about is a method — a `crosses-tenants:`
 * note may sit in the doc comment, or directly above the signature, or
 * directly above the statement, and all three are ordinary places to put it.
 * Stopping at the brace also means an exemption cannot be borrowed from the
 * method above, which is the property that keeps this check honest.
 *
 * It used to walk back a fixed fourteen lines. That was wrong twice over: the
 * count is arbitrary, and a declaration that had been reviewed and granted
 * stopped applying when four lines of explanation were added between it and
 * the statement. The failure was in the safe direction — a false positive —
 * but a check that cries wolf when somebody comments their code is one people
 * learn to satisfy by moving comments around.
 */
function precedingComment(source: string, line: number): string {
  const lines = source.split("\n");
  let acc = "";
  // A backstop, so a file without a closing brace above cannot make this walk
  // to the top. Comfortably longer than any doc comment here.
  for (let i = line - 2; i >= 0 && i > line - 90; i--) {
    const text = lines[i].trim();
    if (text === "}" || text === "};") break;
    acc = lines[i] + "\n" + acc;
  }
  return acc;
}

test("no statement reads or writes tenant-scoped data without naming a tenant", () => {
  const offenders: string[] = [];

  for (const rel of SQL_SOURCES) {
    const path = new URL(rel, import.meta.url);
    const raw = readFileSync(path, "utf8");

    for (const { sql, line } of statements(raw)) {
      const touches = TENANT_SCOPED_TABLES.filter((t) =>
        new RegExp(`\\b(FROM|INTO|UPDATE|JOIN)\\s+"?${t}"?\\b`, "i").test(sql)
      );
      const unreadable = INTERPOLATED_TABLE.test(sql);
      if (touches.length === 0 && !unreadable) continue;
      if (/\btenant_id\b/.test(sql)) continue;
      // An explicit, reasoned exemption.
      if (/crosses-tenants:/.test(precedingComment(raw, line))) continue;

      const what = touches.length > 0 ? `touches ${touches.join(", ")}` : "builds its table name, so this scan cannot see what it touches";
      offenders.push(
        `${rel.replace("../", "")}:${line} ${what} without a tenant:\n` +
          `      ${sql.replace(/\s+/g, " ").trim().slice(0, 140)}`
      );
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `statements reaching tenant-scoped data without a tenant predicate:\n\n${offenders.join("\n\n")}\n`
  );
});

const scoped = (src: string) =>
  statements(src).filter((st) =>
    TENANT_SCOPED_TABLES.some((t) => new RegExp(`\\b(FROM|INTO|UPDATE|JOIN)\\s+"?${t}"?\\b`, "i").test(st.sql))
  );

test("the detector actually detects, so a green result means something", () => {
  // A check that greps for a property is worth exactly as much as its ability
  // to fail.
  const bad = `const q = "SELECT * FROM messages WHERE channel_id = ?";`;
  const good = `const q = "SELECT * FROM messages WHERE tenant_id = ? AND channel_id = ?";`;
  const unrelated = `const q = "SELECT * FROM term_concepts WHERE system = ?";`;

  assert.equal(scoped(bad).length, 1, "an unscoped statement must be seen");
  assert.equal(/\btenant_id\b/.test(scoped(bad)[0].sql), false);
  assert.equal(/\btenant_id\b/.test(scoped(good)[0].sql), true, "a scoped one must pass");
  assert.equal(scoped(unrelated).length, 0, "terminology is shared provincial data, not tenant-scoped");
});

test("an apostrophe in prose does not blind the scan", () => {
  // The bug this file shipped with. Everything after the comment vanished,
  // and a check that reports nothing looks exactly like a check that passed.
  const src = [
    "// Walks a channel's hash chain and confirms the sender's view.",
    'const a = "SELECT * FROM messages WHERE channel_id = ?";',
    "/* A delivery's payload is the same content as the message's. */",
    'const b = "SELECT * FROM deliveries WHERE id = ?";',
  ].join("\n");

  assert.equal(scoped(src).length, 2, "both statements must survive the comments around them");
});

test("an exemption applies to its own method and not to the one below it", () => {
  // The property the boundary exists for, and the one worth pinning after
  // rewriting how far back the scan looks. An exemption that leaked into the
  // next method would silently excuse a statement nobody reviewed — which is
  // the exact failure this whole file is written against, arrived at from the
  // other direction.
  const src = [
    "  /**",
    "   * crosses-tenants: the worker drains the whole node.",
    "   */",
    "  dueDeliveries(): Row[] {",
    "    // an explanation somebody added later, between the note and the query",
    "    return this.sql",
    '      .prepare("SELECT * FROM deliveries WHERE state = ?")',
    "      .all(state);",
    "  }",
    "",
    "  listForChannel(id: string): Row[] {",
    '    return this.sql.prepare("SELECT * FROM deliveries WHERE channel_id = ?").all(id);',
    "  }",
  ].join("\n");

  const found = scoped(src);
  assert.equal(found.length, 2, "both statements are seen");

  const exempt = found.map((st) => /crosses-tenants:/.test(precedingComment(src, st.line)));
  assert.deepEqual(
    exempt,
    [true, false],
    "the declared one is excused even with prose between it and the query; the one below it is not"
  );
});

test("a doc comment is not so long that the scan gives up before reaching it", () => {
  // The backstop is a guard against a pathological file, not a limit on how
  // much explanation a decision may carry. This codebase writes long reasons
  // deliberately, and a scan that stopped short would start reporting granted
  // exemptions as offenders again — the regression this replaced.
  const doc = ["  /**", "   * crosses-tenants: a long and carefully argued reason."];
  for (let i = 0; i < 60; i++) doc.push(`   * line ${i} of the argument.`);
  doc.push("   */", "  sweep(): void {", '    this.sql.prepare("SELECT * FROM deliveries").all();', "  }");
  const src = doc.join("\n");

  const [st] = scoped(src);
  assert.ok(st, "the statement is seen");
  assert.ok(/crosses-tenants:/.test(precedingComment(src, st.line)), "and the reason above it still reaches it");
});

test("a glob in a SQL comment does not blind the scan", () => {
  // The bug this file shipped with for a second time, and the more expensive
  // of the two. `conformance/*.json` inside the schema's own SQL comment
  // opened a block comment for the old regex stripper, which then blanked
  // 270 lines of real source looking for the close — taking the backticks
  // that delimit `SCHEMA` and `INDEXES` with it and shifting every string
  // boundary in the file from there on.
  const src = [
    "const SCHEMA = `",
    "-- The conformance packs in conformance/*.json are hand-written.",
    "CREATE TABLE messages (tenant_id TEXT NOT NULL, id TEXT NOT NULL);",
    "`;",
    "const q = `SELECT * FROM messages WHERE channel_id = ?`;",
  ].join("\n");

  const found = statements(src);
  assert.equal(found.length, 1, "the statement after the glob must still be seen");
  assert.match(found[0].sql, /SELECT \* FROM messages/);
});

test("a nested template literal does not end the one containing it", () => {
  const src = "const q = `SELECT * FROM messages WHERE id = ${`${a}-${b}`} AND tenant_id = ?`;";
  const found = statements(src);
  assert.equal(found.length, 1);
  assert.match(found[0].sql, /tenant_id/, "the outer literal must run to its own end");
});

test("the scan sees the whole of the largest SQL source, not a corner of it", () => {
  // A floor rather than an exact count, because statements come and go. The
  // number that matters is the one it used to be: four. A tokenizer that
  // loses its place again fails here rather than reporting a clean sweep of
  // almost nothing.
  const raw = readFileSync(new URL("../src/db.ts", import.meta.url), "utf8");
  const found = statements(raw);
  assert.ok(found.length > 70, `only ${found.length} statements found in db.ts`);
  // And they are SQL, not fragments of code caught between misplaced quotes.
  for (const { sql, line } of found) {
    assert.match(sql, /^\s*(SELECT|INSERT|UPDATE|DELETE)\b/i, `db.ts:${line} is not a statement`);
  }
});
