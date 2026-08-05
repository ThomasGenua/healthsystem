/**
 * Five-field cron expressions, for polling sources that should run on a
 * schedule rather than every N milliseconds.
 *
 *   minute hour day-of-month month day-of-week
 *
 * Supports *, a, a-b, a,b,c, and any of those with a /step. Day-of-week
 * accepts 0-7 with both 0 and 7 meaning Sunday. Names (JAN, MON) are not
 * accepted — numbers only, which is all a scheduled poller needs.
 *
 * Standard cron semantics: when both day-of-month and day-of-week are
 * restricted, a day matches if *either* does. That surprises people, so it is
 * spelled out in matches() below.
 *
 * Evaluation is minute-granular, so callers tick more often than a minute and
 * use the minute key to fire at most once per matching minute.
 */

const RANGES: Array<[number, number]> = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 7], // day of week (0 and 7 are both Sunday)
];

function parseField(field: string, index: number): Set<number> {
  const [lo, hi] = RANGES[index];
  const out = new Set<number>();

  for (const part of field.split(",")) {
    if (!part) throw new Error(`empty term in cron field "${field}"`);
    const [spec, stepRaw] = part.split("/");
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    if (!Number.isInteger(step) || step < 1) throw new Error(`bad step in cron field "${part}"`);

    let start: number;
    let end: number;
    if (spec === "*") {
      start = lo;
      end = hi;
    } else if (spec.includes("-")) {
      const [a, b] = spec.split("-").map(Number);
      if (!Number.isInteger(a) || !Number.isInteger(b)) throw new Error(`bad range in cron field "${part}"`);
      start = a;
      end = b;
    } else {
      const n = Number(spec);
      if (!Number.isInteger(n)) throw new Error(`bad value in cron field "${part}"`);
      start = n;
      // A bare number with a step means "from n to the end of the range",
      // matching the usual crontab reading of "5/10".
      end = stepRaw === undefined ? n : hi;
    }
    if (start < lo || end > hi || start > end) throw new Error(`cron field "${part}" out of range ${lo}-${hi}`);

    for (let v = start; v <= end; v += step) out.add(v === 7 && index === 4 ? 0 : v);
  }

  return out;
}

export class CronSchedule {
  private readonly minutes: Set<number>;
  private readonly hours: Set<number>;
  private readonly daysOfMonth: Set<number>;
  private readonly months: Set<number>;
  private readonly daysOfWeek: Set<number>;
  private readonly domRestricted: boolean;
  private readonly dowRestricted: boolean;

  constructor(expression: string) {
    const fields = expression.trim().split(/\s+/);
    if (fields.length !== 5) {
      throw new Error(`cron expression needs 5 fields (minute hour day month weekday), got ${fields.length}`);
    }
    this.minutes = parseField(fields[0], 0);
    this.hours = parseField(fields[1], 1);
    this.daysOfMonth = parseField(fields[2], 2);
    this.months = parseField(fields[3], 3);
    this.daysOfWeek = parseField(fields[4], 4);
    this.domRestricted = fields[2] !== "*";
    this.dowRestricted = fields[4] !== "*";
  }

  matches(date: Date): boolean {
    if (!this.minutes.has(date.getMinutes())) return false;
    if (!this.hours.has(date.getHours())) return false;
    if (!this.months.has(date.getMonth() + 1)) return false;

    const domHit = this.daysOfMonth.has(date.getDate());
    const dowHit = this.daysOfWeek.has(date.getDay());

    // Both restricted: either may satisfy the day. Only one restricted: that
    // one decides. Neither restricted: any day.
    if (this.domRestricted && this.dowRestricted) return domHit || dowHit;
    if (this.domRestricted) return domHit;
    if (this.dowRestricted) return dowHit;
    return true;
  }
}

/** Stable per-minute key, so a schedule fires at most once per matching minute. */
export function minuteKey(date: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}T${p(date.getHours())}:${p(date.getMinutes())}`;
}
