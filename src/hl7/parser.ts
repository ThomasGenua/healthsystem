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
  const text = raw.replace(/\r\n/g, "\r").replace(/\n/g, "\r").replace(/\r+$/, "");
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
        if (code.startsWith("X")) {
          const hex = code.slice(1);
          for (let h = 0; h + 1 < hex.length + 1 && h < hex.length; h += 2) {
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
  const controlId = getHl7(original, "MSH-10") || "UNKNOWN";
  const trigger = getHl7(original, "MSH-9.2");
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
    getHl7(original, "MSH-11") || "P",
    getHl7(original, "MSH-12") || "2.5.1",
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

/** Convert an HL7 TS (YYYYMMDD[HHMM[SS]]) to ISO 8601. Date-only stays date-only. */
export function hl7DateToIso(ts: string): string {
  const t = ts.trim();
  const m = /^(\d{4})(\d{2})(\d{2})(?:(\d{2})(\d{2})(\d{2})?)?/.exec(t);
  if (!m) return "";
  const [, y, mo, da, h, mi, s] = m;
  if (!h) return `${y}-${mo}-${da}`;
  return `${y}-${mo}-${da}T${h}:${mi ?? "00"}:${s ?? "00"}`;
}
