/**
 * A point in time somebody wrote down, read the way the stores compare it.
 *
 * Expiries are stored as text and compared as text — `expires_at > ?`
 * against `new Date().toISOString()` — which is right only when both sides
 * are in the same form. They were stored exactly as the caller typed them.
 * "December 31, 2027" sorts after every ISO timestamp, so a caregiver grant
 * written that way never lapsed; "next year" is not a date at all and was
 * accepted as one, because `new Date("next year")` is NaN and NaN is never
 * "already past"; "12/31/2027" sorts before every ISO timestamp, so that
 * grant never began.
 *
 * So two forms are accepted, the two this codebase's own callers send: a
 * calendar date, `2027-12-31`, read as midnight UTC — exactly how the text
 * comparison always read it — and a full time with its zone. What is stored
 * is the one canonical UTC form. Anything else is refused rather than
 * guessed at: `01/02/2027` is a different day in Toronto and in Texas, and a
 * time with no zone is a different instant on every server. The parts are
 * checked here rather than left to `new Date()`, which turns 30 February
 * into 2 March without a word.
 */
import type { Db } from "../db.ts";
import { refuse } from "./refusal.ts";

const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(?:(Z)|([+-])(\d{2}):(\d{2})))?$/;

/**
 * The canonical UTC form of `value`, or a refusal naming `what` it was
 * meant to be — "an expiry", "a release date".
 */
export function instant(value: unknown, what: string): string {
  const parts = typeof value === "string" ? ISO.exec(value.trim()) : null;
  if (parts) {
    const [, y, mo, d, h, mi, s, frac, , sign, oh, om] = parts;
    const [year, month, day] = [Number(y), Number(mo), Number(d)];
    const [hour, minute, second] = [Number(h ?? 0), Number(mi ?? 0), Number(s ?? 0)];
    const offset = sign ? (sign === "-" ? -1 : 1) * (Number(oh) * 60 + Number(om)) : 0;
    const at = new Date(0);
    at.setUTCFullYear(year, month - 1, day);
    at.setUTCHours(hour, minute, second, Number((frac ?? "").padEnd(3, "0").slice(0, 3)));
    const real =
      at.getUTCFullYear() === year && at.getUTCMonth() === month - 1 && at.getUTCDate() === day &&
      hour <= 23 && minute <= 59 && second <= 59 && Number(oh ?? 0) <= 23 && Number(om ?? 0) <= 59;
    if (real) return new Date(at.getTime() - offset * 60_000).toISOString();
  }
  refuse(`${what} has to be a date like 2027-12-31, or a time with its zone like 2027-12-31T17:00:00-07:00`);
}

/**
 * The shape an expiry the clock can compare starts with, as an SQL GLOB.
 *
 * Every expiry written from here on is canonical. One written before may not
 * be, and a live check that compared it as text would keep honouring
 * "December 31, 2027" forever. A row that does not start like a date is
 * treated as already past — an unreadable end is not an end — and
 * `unreadableExpiries()` counts them so somebody can re-record them.
 * Calendar dates and times with an offset, the forms a correct caller wrote
 * before this, still start this way and still compare as they always did.
 */
export const DATE_LIKE = "[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*";

/**
 * Live grants and keys whose expiry the clock cannot compare, per tenant.
 * They are treated as expired; this is how an operator finds them.
 */
export function unreadableExpiries(db: Db): Array<{
  tenant: string;
  grants: number;
  keys: number;
}> {
  const count = (table: string) =>
    db.sql
      .prepare(
        `SELECT tenant_id AS tenant, COUNT(*) AS n FROM ${table}
          WHERE revoked_at IS NULL AND expires_at IS NOT NULL AND expires_at NOT GLOB ?
          GROUP BY tenant_id`
      )
      .all(DATE_LIKE) as Array<{ tenant: string; n: number }>;
  const byTenant = new Map<string, { tenant: string; grants: number; keys: number }>();
  for (const [field, table] of [["grants", "patient_authority"], ["keys", "api_keys"]] as const) {
    for (const row of count(table)) {
      const entry = byTenant.get(row.tenant) ?? { tenant: row.tenant, grants: 0, keys: 0 };
      entry[field] = Number(row.n);
      byTenant.set(row.tenant, entry);
    }
  }
  return [...byTenant.values()].sort((a, b) => a.tenant.localeCompare(b.tenant));
}

/**
 * What boot says about them, one line per tenant that has any. Without it a
 * caregiver whose access stopped at the upgrade would be a phone call nobody
 * could explain, rather than a list somebody can work through.
 */
export function unreadableExpiryWarnings(db: Db): string[] {
  return unreadableExpiries(db).map(
    (row) =>
      `WARNING: tenant ${row.tenant} has ${row.grants} caregiver grant(s) and ${row.keys} API key(s) whose expiry ` +
      "is not a date the clock can compare. They are treated as expired until somebody records the end again; " +
      'see "Expiries that are not dates" in docs/RUNBOOK.md.'
  );
}
