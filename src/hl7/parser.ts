/**
 * HL7 v2 ER7 parser.
 *
 * Segments split on carriage return, fields on the separator declared in
 * MSH-1, components on ^, repetitions on ~, subcomponents on &, with the
 * standard escape sequences. MSH is handled per the specification: MSH-1 is
 * the field separator character itself and MSH-2 the encoding characters, so
 * MSH-9 addresses the message type as clinicians expect.
 */
import { hl7ApplicationName } from "../core/naming.ts";

export interface Hl7Delimiters {
  field: string;
  component: string;
  repetition: string;
  escape: string;
  subcomponent: string;
}

export interface Hl7Segment {
  name: string;
  /**
   * fields[fieldIndex][repetition][component][subcomponent] = string.
   * fields[0] holds the segment name. For MSH, fields[1] is the field
   * separator and fields[2] the encoding characters, stored literally.
   */
  fields: string[][][][];
}

export interface Hl7Message {
  delimiters: Hl7Delimiters;
  segments: Hl7Segment[];
}

const PATH_RE = /^([A-Z][A-Z0-9]{2})(?:\[(\d+)\])?-(\d+)(?:\[(\d+)\])?(?:\.(\d+)(?:\.(\d+))?)?$/;

export function parseHl7(raw: string): Hl7Message {
  // No trailing-CR trim. `.replace(/\r+$/, "")` was here and was quadratic:
  // when a non-CR character follows a run of carriage returns, the engine
  // restarts the greedy match at every position in the run and `$` fails
  // every time. 400k CRs took 130 seconds, and the MLLP frame limit is
  // 16 MiB — from an unauthenticated socket, one frame could hold the
  // engine's only thread for days. The empty-segment filter below already
  // removes exactly what the trim removed, in one linear pass.
  const text = raw.replace(/\r\n/g, "\r").replace(/\n/g, "\r");
  const lines = text.split("\r").filter((l) => l.length > 0);
  if (lines.length === 0 || !lines[0].startsWith("MSH")) {
    throw new Error("Not an HL7 v2 message: missing MSH segment");
  }
  const msh = lines[0];
  if (msh.length < 8) throw new Error("MSH segment too short");
  const field = msh[3];
  const enc = msh.split(field)[1] ?? "^~\\&";
  const delimiters: Hl7Delimiters = {
    field,
    component: enc[0] ?? "^",
    repetition: enc[1] ?? "~",
    escape: enc[2] ?? "\\",
    subcomponent: enc[3] ?? "&",
  };

  const segments: Hl7Segment[] = lines.map((line) => {
    const rawFields = line.split(delimiters.field);
    const name = rawFields[0];
    let flat: string[];
    if (name === "MSH") {
      // rawFields: ["MSH", encodingChars, field3, ...]
      flat = ["MSH", delimiters.field, rawFields[1] ?? "", ...rawFields.slice(2)];
    } else {
      flat = rawFields;
    }
    const fields = flat.map((f, i): string[][][] => {
      // MSH-1 and MSH-2 are literal delimiter declarations, never split or unescaped.
      if (name === "MSH" && (i === 1 || i === 2)) return [[[f]]];
      return f
        .split(delimiters.repetition)
        .map((rep) => rep.split(delimiters.component).map((c) => c.split(delimiters.subcomponent)));
    });
    return { name, fields };
  });

  return { delimiters, segments };
}

/** Decode HL7 escape sequences into their literal characters. */
export function unescapeHl7(value: string, d: Hl7Delimiters): string {
  const e = d.escape;
  let out = "";
  let i = 0;
  while (i < value.length) {
    const ch = value[i];
    if (ch !== e) {
      out += ch;
      i++;
      continue;
    }
    const end = value.indexOf(e, i + 1);
    if (end === -1) {
      out += value.slice(i);
      break;
    }
    const code = value.slice(i + 1, end);
    switch (code) {
      case "F":
        out += d.field;
        break;
      case "S":
        out += d.component;
        break;
      case "T":
        out += d.subcomponent;
        break;
      case "R":
        out += d.repetition;
        break;
      case "E":
        out += e;
        break;
      case ".br":
        out += "\n";
        break;
      default:
        // `\X..\` is hex data, and only when it actually is: `parseInt("zz", 16)`
        // is NaN and `String.fromCharCode(NaN)` is U+0000, so an unparseable
        // escape used to become a NUL in the middle of a value. SQLite stores
        // that, JSON serialises it, and every reader afterwards treats it as a
        // character in somebody's name. Anything that is not an even number of
        // hex digits falls through to the same handling as any other escape
        // this does not know: left exactly as it arrived.
        const hex = code.startsWith("X") ? code.slice(1) : "";
        if (hex.length > 0 && hex.length % 2 === 0 && /^[0-9A-Fa-f]+$/.test(hex)) {
          for (let h = 0; h < hex.length; h += 2) {
            out += String.fromCharCode(parseInt(hex.slice(h, h + 2), 16));
          }
        } else {
          out += e + code + e;
        }
    }
    i = end + 1;
  }
  return out;
}

/** Encode literal delimiter characters as HL7 escape sequences. */
export function escapeHl7(value: string, d: Hl7Delimiters): string {
  let out = "";
  for (const ch of value) {
    if (ch === d.escape) out += `${d.escape}E${d.escape}`;
    else if (ch === d.field) out += `${d.escape}F${d.escape}`;
    else if (ch === d.component) out += `${d.escape}S${d.escape}`;
    else if (ch === d.subcomponent) out += `${d.escape}T${d.escape}`;
    else if (ch === d.repetition) out += `${d.escape}R${d.escape}`;
    else if (ch === "\n") out += `${d.escape}.br${d.escape}`;
    else out += ch;
  }
  return out;
}

/**
 * Read a value by path, e.g. "PID-5.1", "PID-3[2].1", "MSH-9", "NK1[2]-2".
 * Segment and repetition indexes are 1-based. Missing paths return "".
 */
export function getHl7(msg: Hl7Message, path: string): string {
  const m = PATH_RE.exec(path.trim());
  if (!m) throw new Error(`Bad HL7 path: ${path}`);
  const [, segName, segRepStr, fieldStr, repStr, compStr, subStr] = m;
  const segRep = segRepStr ? parseInt(segRepStr, 10) : 1;
  const fieldIdx = parseInt(fieldStr, 10);
  const rep = repStr ? parseInt(repStr, 10) : 1;
  const comp = compStr ? parseInt(compStr, 10) : 0;
  const sub = subStr ? parseInt(subStr, 10) : 0;

  const seg = msg.segments.filter((s) => s.name === segName)[segRep - 1];
  if (!seg) return "";
  const fieldReps = seg.fields[fieldIdx];
  if (!fieldReps) return "";

  const join = (reps: string[][][]): string =>
    reps
      .map((r) => r.map((c) => c.join(msg.delimiters.subcomponent)).join(msg.delimiters.component))
      .join(msg.delimiters.repetition);

  if (segName === "MSH" && (fieldIdx === 1 || fieldIdx === 2)) {
    return fieldReps[0]?.[0]?.[0] ?? "";
  }

  let value: string;
  if (comp === 0) {
    value = rep === 1 && !repStr ? join(fieldReps) : join([fieldReps[rep - 1] ?? []]);
  } else {
    const repArr = fieldReps[rep - 1] ?? [];
    const compArr = repArr[comp - 1] ?? [];
    value = sub === 0 ? compArr.join(msg.delimiters.subcomponent) : (compArr[sub - 1] ?? "");
  }
  return unescapeHl7(value, msg.delimiters);
}

/** Count repetitions of a field, e.g. countHl7(msg, "PID-3"). */
export function countHl7(msg: Hl7Message, path: string): number {
  const m = /^([A-Z][A-Z0-9]{2})(?:\[(\d+)\])?-(\d+)$/.exec(path.trim());
  if (!m) throw new Error(`Bad HL7 field path: ${path}`);
  const seg = msg.segments.filter((s) => s.name === m[1])[(m[2] ? parseInt(m[2], 10) : 1) - 1];
  const reps = seg?.fields[parseInt(m[3], 10)];
  if (!reps) return 0;
  return reps.length === 1 && reps[0].length === 1 && reps[0][0].join("") === "" ? 0 : reps.length;
}

/** Serialize a parsed message back to ER7. */
export function serializeHl7(msg: Hl7Message): string {
  const d = msg.delimiters;
  return msg.segments
    .map((seg) => {
      const parts = seg.fields.map((reps, i) => {
        if (seg.name === "MSH" && i === 1) return null; // separator is implicit
        if (seg.name === "MSH" && i === 2) return reps[0][0][0];
        return reps.map((r) => r.map((c) => c.join(d.subcomponent)).join(d.component)).join(d.repetition);
      });
      if (seg.name === "MSH") return ["MSH", ...parts.slice(2)].join(d.field);
      return parts.join(d.field);
    })
    .join("\r");
}

/** Build an ACK for a received message. code AA accepts, AE errors, AR rejects. */
export function buildAck(original: Hl7Message, code: "AA" | "AE" | "AR", text?: string): string {
  const d = original.delimiters;
  const now = hl7Now();
  // Everything below comes from the message being acknowledged, and `getHl7`
  // returns it already unescaped — so a value has to be re-escaped before it
  // goes back out. MSH-10, MSH-9.2, MSH-11 and MSH-12 were not, which let a
  // sender put `\F\` in a control id and have the acknowledgement come back
  // with live field separators in it: `MSA|AA|MSG|AE|INJECTED|`, where the
  // receiving system reads MSA-3 as a value nobody sent.
  const controlId = escapeHl7(getHl7(original, "MSH-10"), d) || "UNKNOWN";
  const trigger = escapeHl7(getHl7(original, "MSH-9.2"), d);
  const msh = [
    "MSH",
    d.component + d.repetition + d.escape + d.subcomponent,
    escapeHl7(getHl7(original, "MSH-5"), d),
    escapeHl7(getHl7(original, "MSH-6"), d),
    escapeHl7(getHl7(original, "MSH-3"), d),
    escapeHl7(getHl7(original, "MSH-4"), d),
    now,
    "",
    trigger ? `ACK${d.component}${trigger}${d.component}ACK` : "ACK",
    `${hl7ApplicationName()}${Date.now()}`,
    escapeHl7(getHl7(original, "MSH-11"), d) || "P",
    escapeHl7(getHl7(original, "MSH-12"), d) || "2.5.1",
  ].join(d.field);
  const msa = ["MSA", code, controlId, text ? escapeHl7(text, d) : ""].join(d.field);
  return `${msh}\r${msa}\r`;
}

export function hl7Now(date: Date = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  );
}

const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** Days in a month, by the calendar rather than by `Date`, whose 0-99 years are 1900+. */
function daysInMonth(year: number, month: number): number {
  if (month === 2 && ((year % 4 === 0 && year % 100 !== 0) || year % 400 === 0)) return 29;
  return MONTH_DAYS[month - 1];
}

/**
 * Convert an HL7 TS (YYYYMMDD[HHMM[SS]]) to ISO 8601. Date-only stays date-only.
 *
 * A date that is not on the calendar is not a date. `20261301` and `20260231`
 * used to come back shaped like timestamps — `2026-13-01`, `2026-02-31` — and
 * be stored as ones, so every reader afterwards got Invalid Date out of a
 * field that looked populated. An empty string is the existing signal for "no
 * usable date here", and it has the advantage of being visibly empty.
 *
 * Seconds are 0-59: a leap second is a valid TS that `Date` cannot represent
 * either, and answering "no date" is the safer of the two wrong answers.
 *
 * Offsets are still dropped, which is deliberate and documented — see
 * `src/orders/hl7.ts`, which reads them properly because a result an hour out
 * is a result on the wrong side of a shift change.
 */
export function hl7DateToIso(ts: string): string {
  const t = ts.trim();
  const m = /^(\d{4})(\d{2})(\d{2})(?:(\d{2})(\d{2})(\d{2})?)?/.exec(t);
  if (!m) return "";
  const [, y, mo, da, h, mi, s] = m;
  const month = Number(mo);
  const day = Number(da);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(Number(y), month)) return "";
  if (!h) return `${y}-${mo}-${da}`;
  if (Number(h) > 23 || Number(mi) > 59 || (s !== undefined && Number(s) > 59)) return "";
  return `${y}-${mo}-${da}T${h}:${mi}:${s ?? "00"}`;
}
