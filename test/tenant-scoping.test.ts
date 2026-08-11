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
];

/**
 * Removes comments before scanning.
 *
 * Not incidental. Prose in this codebase is full of apostrophes — "a channel's
 * chain", "the sender's log" — and an apostrophe reads as a string delimiter,
 * so a scanner that skips this treats everything from the comment to the next
 * apostrophe as one string and silently loses every statement in between. The
 * first version of this file did exactly that and reported a third of the
 * offenders it should have, which for a check whose entire job is completeness
 * is worse than not having it.
 */
function stripComments(source: string): string {
  // Replaced with newlines rather than deleted, so reported line numbers still
  // point at the right place in the original file.
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1: string) => p1 + " ".repeat(Math.max(0, m.length - p1.length)));
}

/**
 * Pulls out anything that looks like a SQL statement: the contents of a
 * template literal or quoted string that starts with a SQL verb.
 */
function statements(source: string): Array<{ sql: string; line: number }> {
  const out: Array<{ sql: string; line: number }> = [];
  // Template literals and ordinary strings, non-greedy, across lines.
  const re = /`([^`]*)`|"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const body = m[1] ?? m[2] ?? m[3] ?? "";
    if (!/^\s*(SELECT|INSERT|UPDATE|DELETE)\b/i.test(body)) continue;
    out.push({ sql: body, line: source.slice(0, m.index).split("\n").length });
  }
  return out;
}

/** The comment lines immediately preceding a line, for opt-out markers. */
function precedingComment(source: string, line: number): string {
  const lines = source.split("\n");
  let i = line - 2;
  let acc = "";
  // Walk back over the statement itself and any comment block above it.
  while (i >= 0 && i > line - 14) {
    acc = lines[i] + "\n" + acc;
    i--;
  }
  return acc;
}

test("no statement reads or writes tenant-scoped data without naming a tenant", () => {
  const offenders: string[] = [];

  for (const rel of SQL_SOURCES) {
    const path = new URL(rel, import.meta.url);
    const raw = readFileSync(path, "utf8");
    const source = stripComments(raw);

    for (const { sql, line } of statements(source)) {
      const touches = TENANT_SCOPED_TABLES.filter((t) =>
        new RegExp(`\\b(FROM|INTO|UPDATE|JOIN)\\s+"?${t}"?\\b`, "i").test(sql)
      );
      if (touches.length === 0) continue;
      if (/\btenant_id\b/.test(sql)) continue;
      // An explicit, reasoned exemption.
      if (/crosses-tenants:/.test(precedingComment(raw, line))) continue;

      offenders.push(
        `${rel.replace("../", "")}:${line} touches ${touches.join(", ")} without a tenant:\n` +
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
  statements(stripComments(src)).filter((st) =>
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
