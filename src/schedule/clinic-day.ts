/**
 * Which instants are "today" at the clinic, and what hour it is there.
 *
 * The clinic board, the wall display, the "coming in unprepared" panel, a
 * clinician's worklist and the privacy office's after-hours review all ask
 * a question about the clinic's own clock, and each used to answer it in
 * UTC. For a clinic west of UTC that is the wrong day for part of every day
 * (H-211), and "after hours" meant midnight to noon locally rather than the
 * night (R-19). This is the one place that answers it, so the board, the
 * worklist and the privacy review cannot disagree about what today is.
 *
 * ## A zone name, or a fixed offset
 *
 * `America/Yellowknife` follows daylight saving: the day starts at local
 * midnight in winter and in summer, and the two days a year that are 23 and
 * 25 hours long are 23 and 25 hours long. The rules come from the time-zone
 * database compiled into the Node runtime. That is no dependency, but it is
 * a dependence: the answer is only as current as the runtime's copy, and two
 * runtimes can disagree. Node 24.21 carries tzdata 2026c, in which
 * America/Edmonton stays on UTC-06:00 from November 2026 — and it treats
 * America/Yellowknife as another name for Edmonton, so Yellowknife does too.
 * Node 22.22 carries 2025c, in which both fall back to UTC-07:00 as before.
 * America/Inuvik, the territory's other zone, falls back in both. Which is
 * right for a given clinic is a fact about the law where it is, not
 * something this module can know — so `describe()` says what the name
 * resolved to and which copy of the rules said so, and the engine prints it
 * at boot where the person who knows can see it (H-214).
 *
 * The exposure is narrower than it sounds. The zone decides where midnight
 * falls and which hour a timestamp is in; an hour's disagreement moves the
 * day's edges from midnight to 23:00 or 01:00, which is not where a clinic
 * books patients. The large error was the old one: at UTC-07:00 the UTC day
 * ends at 17:00.
 *
 * `-07:00` is exactly that, all year. For a clinic that observes daylight
 * saving it is wrong half the year unless somebody changes it twice; for one
 * that does not — or one that would rather not depend on the runtime's copy
 * of the rules — it is exactly right.
 *
 * Abbreviations are refused. `MST` and `EST` are in the zone database, but
 * as fixed offsets, so somebody writing `EST` for "Eastern time" would get a
 * clinic that never springs forward; `Etc/GMT+7` means UTC-07:00, with the
 * sign the other way round from every other spelling here. Neither is a
 * mistake worth making available.
 *
 * Unset is UTC, which is what everything did before. One zone serves a
 * whole deployment; custodians in different zones on one engine would need
 * one each, which does not exist yet (R-19).
 */
import { readEnv } from "../core/naming.ts";

export interface ClinicDayWindow {
  /** The clinic's calendar date, YYYY-MM-DD. */
  date: string;
  /** First instant of that date at the clinic, as an ISO timestamp. */
  from: string;
  /** First instant of the next date: the window is `from <= t < to`. */
  to: string;
}

const OFFSET = /^([+-])(\d{2}):?(\d{2})$/;
/** Area/Location, as the zone database names real places. */
const PLACE = /^[A-Za-z][A-Za-z_-]*(\/[A-Za-z0-9_+-]+)+$/;

const HOUR = 3600_000;

/** The instant as epoch milliseconds, refusing anything that is not one. */
function instant(t: Date | string | number): number {
  const ms = typeof t === "number" ? t : new Date(t).getTime();
  if (!Number.isFinite(ms)) throw new Error(`not an instant: ${String(t)}`);
  return ms;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** "UTC-06:00" from an offset in minutes. */
function offsetLabel(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  return `UTC${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

interface Wall {
  y: number;
  m: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

export class ClinicDay {
  /** How it was configured. */
  readonly kind: "utc" | "offset" | "zone";
  /** As configured, trimmed: `America/Yellowknife`, `-07:00`, or `UTC`. */
  readonly configured: string;
  /** What the runtime resolved it to — for an alias, the zone it names. */
  readonly zone: string;
  private readonly wall: (t: number) => Wall;

  private constructor(kind: ClinicDay["kind"], configured: string, zone: string, wall: (t: number) => Wall) {
    this.kind = kind;
    this.configured = configured;
    this.zone = zone;
    this.wall = wall;
  }

  /** The UTC calendar, which is what every "today" meant before this existed. */
  static utc(): ClinicDay {
    return ClinicDay.fixed("utc", "UTC", 0);
  }

  private static fixed(kind: "utc" | "offset", label: string, minutes: number): ClinicDay {
    const shift = minutes * 60_000;
    return new ClinicDay(kind, label, label, (t) => {
      const d = new Date(t + shift);
      return {
        y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(),
        h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds(),
      };
    });
  }

  /**
   * A clinic calendar from configuration, or a refusal that says what was
   * wrong with it. Unset or blank is UTC.
   */
  static parse(value: string | undefined): ClinicDay {
    if (value === undefined || value.trim() === "") return ClinicDay.utc();
    const v = value.trim();

    const m = OFFSET.exec(v);
    if (m) {
      const minutes = Number(m[2]) * 60 + Number(m[3]);
      if (Number(m[3]) > 59 || minutes > 14 * 60) {
        throw new Error(`clinic time zone offset out of range: ${JSON.stringify(value)}`);
      }
      return ClinicDay.fixed("offset", `${m[1]}${m[2]}:${m[3]}`, m[1] === "-" ? -minutes : minutes);
    }

    if (v.toUpperCase() === "UTC" || v === "Etc/UTC") return ClinicDay.utc();
    if (/^Etc\/GMT[+-]\d+$/i.test(v)) {
      throw new Error(
        `clinic time zone ${JSON.stringify(value)} is a POSIX-style name whose sign is inverted ` +
          "(Etc/GMT+7 is UTC-07:00); write the offset as -07:00, or use a place like America/Yellowknife"
      );
    }
    if (!PLACE.test(v)) {
      throw new Error(
        `clinic time zone must be a place like America/Yellowknife or an offset like -07:00, got ${JSON.stringify(value)}` +
          (/^[A-Za-z]{3,5}\d*([A-Za-z]{3})?$/.test(v)
            ? "; an abbreviation says nothing reliable about daylight saving"
            : "")
      );
    }

    let format: Intl.DateTimeFormat;
    try {
      format = new Intl.DateTimeFormat("en-CA", {
        timeZone: v, hourCycle: "h23",
        year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
      });
    } catch {
      throw new Error(
        `clinic time zone ${JSON.stringify(value)} is not in this runtime's time-zone data ` +
          `(tzdata ${process.versions.tz ?? "unknown"})`
      );
    }
    return new ClinicDay("zone", v, format.resolvedOptions().timeZone, (t) => {
      const p: Record<string, string> = {};
      for (const part of format.formatToParts(new Date(t))) p[part.type] = part.value;
      return { y: Number(p.year), m: Number(p.month), d: Number(p.day), h: Number(p.hour), mi: Number(p.minute), s: Number(p.second) };
    });
  }

  /** The clinic's calendar date at an instant, YYYY-MM-DD. */
  dateOf(t: Date | string | number): string {
    const w = this.wall(instant(t));
    return `${w.y}-${pad(w.m)}-${pad(w.d)}`;
  }

  /** The hour on the clinic's clocks at an instant, 0–23. */
  hourOf(t: Date | string | number): number {
    return this.wall(instant(t)).h;
  }

  /** Minutes the clinic's clocks are ahead of UTC at an instant; negative west of it. */
  offsetMinutesAt(t: Date | string | number): number {
    const ms = Math.floor(instant(t) / 1000) * 1000;
    const w = this.wall(ms);
    return Math.round((Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s) - ms) / 60_000);
  }

  /**
   * The first instant at which the clinic's calendar reads `date`.
   *
   * Usually local midnight. Not always: where a transition happens at
   * midnight the clocks can go from 23:59:59 straight to 01:00, and then the
   * day starts at 01:00; where they go back from 00:59:59 to 00:00, the day
   * starts at the first midnight, not the second. A search for "the first
   * instant whose date is this one" gets every case right without having to
   * know which one it is in.
   *
   * Local midnight is within fourteen hours of UTC midnight either way, so
   * fifteen hours keeps both ends strictly on the correct side of it, and a
   * second's resolution is exact because every offset and transition in the
   * zone database falls on a whole second.
   */
  startOf(date: string): number {
    const utcMidnight = Date.parse(`${date}T00:00:00.000Z`);
    if (!Number.isFinite(utcMidnight)) throw new Error(`not a date: ${date}`);
    let lo = utcMidnight - 15 * HOUR;
    let hi = utcMidnight + 15 * HOUR;
    while (hi - lo > 1000) {
      const mid = lo + Math.floor((hi - lo) / 2000) * 1000;
      if (this.dateOf(mid) >= date) hi = mid;
      else lo = mid;
    }
    return hi;
  }

  /**
   * The clinic's day containing `asOf`, as a half-open UTC window.
   *
   * The end is the start of the next date rather than the start plus
   * twenty-four hours, because two days a year are not twenty-four hours
   * long anywhere that observes daylight saving.
   */
  window(asOf: Date | string | number = Date.now()): ClinicDayWindow {
    const date = this.dateOf(asOf);
    const next = new Date(Date.parse(`${date}T00:00:00.000Z`) + 24 * HOUR).toISOString().slice(0, 10);
    return { date, from: new Date(this.startOf(date)).toISOString(), to: new Date(this.startOf(next)).toISOString() };
  }

  /** What the clinic's clocks read at an instant: "now UTC-06:00, 2026-09-22 at the clinic". */
  now(asOf: Date | string | number = Date.now()): string {
    return `now ${offsetLabel(this.offsetMinutesAt(asOf))}, ${this.dateOf(asOf)} at the clinic`;
  }

  /**
   * One line for a boot log or a preflight report: what was configured, what
   * it means in this runtime, and what the clinic's clocks read now.
   */
  describe(asOf: Date | string | number = Date.now()): string {
    const now = this.now(asOf);
    if (this.kind === "utc") return `UTC; ${now}`;
    if (this.kind === "offset") return `${this.configured}, fixed all year; ${now}`;
    const rules = `tzdata ${process.versions.tz ?? "unknown"}`;
    const alias =
      this.zone === this.configured
        ? `, by this runtime's time-zone data (${rules})`
        : `, which this runtime's time-zone data (${rules}) treats as ${this.zone}`;
    return `${this.configured}${alias}; ${now}`;
  }
}

/**
 * The configured clinic time zone, as written, or undefined.
 *
 * `NORTHSTAR_CLINIC_UTC_OFFSET` was the name for a few hours before this
 * replaced it, and never reached a release. It is refused rather than
 * quietly ignored, because an ignored setting reads as UTC — the board a
 * few hours out, with nothing to say why.
 */
export function resolveClinicTimeZone(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (readEnv("CLINIC_UTC_OFFSET", env) !== undefined) {
    throw new Error(
      "NORTHSTAR_CLINIC_UTC_OFFSET was renamed before release to NORTHSTAR_CLINIC_TIMEZONE, " +
        "which also takes a place like America/Yellowknife; set that instead"
    );
  }
  const value = readEnv("CLINIC_TIMEZONE", env);
  return value === undefined || value.trim() === "" ? undefined : value;
}
