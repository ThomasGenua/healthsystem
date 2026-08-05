/**
 * Declarative mapper. A mapping is a list of ops applied in order:
 *   { set, from?, value?, fn?, args?, when? }
 * "from" reads an HL7 path for HL7 input, or a dot path for JSON input.
 * "set" writes a dot path on the output, with [n] array indexes.
 * Empty resolved values are skipped so absent fields never write nulls.
 */
import type { MappingDoc, MappingOp } from "../types.ts";
import { getHl7, hl7DateToIso, parseHl7, type Hl7Message } from "../hl7/parser.ts";

type Input = { kind: "hl7"; msg: Hl7Message } | { kind: "json"; obj: unknown };

/** Optional services handed to mapping functions by the engine. */
export interface MapperContext {
  translate?: (value: unknown, args: Record<string, unknown>) => unknown;
}

export class MappingError extends Error {}

const FN: Record<string, (v: unknown, args: Record<string, unknown>, input: Input, ctx?: MapperContext) => unknown> = {
  trim: (v) => String(v ?? "").trim(),
  upper: (v) => String(v ?? "").toUpperCase(),
  lower: (v) => String(v ?? "").toLowerCase(),
  hl7date: (v) => hl7DateToIso(String(v ?? "")),
  number: (v) => {
    const n = parseFloat(String(v ?? ""));
    return Number.isFinite(n) ? n : "";
  },
  default: (v, args) => {
    const s = v == null ? "" : String(v);
    return s === "" ? args.value : v;
  },
  mapCode: (v, args) => {
    const table = (args.table ?? {}) as Record<string, unknown>;
    const key = String(v ?? "");
    if (key in table) return table[key];
    if ("other" in args) return args.other;
    return "";
  },
  translate: (v, args, _input, ctx) => (ctx?.translate ? ctx.translate(v, args) : ""),
  concat: (_v, args, input) => {
    const parts = (args.parts ?? []) as Array<{ from?: string; value?: unknown }>;
    const sep = String(args.sep ?? "");
    return parts
      .map((p) => (p.from != null ? String(readPath(input, p.from) ?? "") : String(p.value ?? "")))
      .filter((s) => s !== "")
      .join(sep);
  },
};

export function readPath(input: Input, path: string): unknown {
  if (input.kind === "hl7") return getHl7(input.msg, path);
  return getJsonPath(input.obj, path);
}

export function getJsonPath(obj: unknown, path: string): unknown {
  const parts = tokenizePath(path);
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = (cur as Record<string | number, unknown>)[p];
  }
  return cur;
}

export function setJsonPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = tokenizePath(path);
  let cur: Record<string | number, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    pad(cur, key);
    const nextIsIndex = typeof parts[i + 1] === "number";
    if (cur[key] == null || typeof cur[key] !== "object") {
      cur[key] = nextIsIndex ? [] : {};
    }
    cur = cur[key] as Record<string | number, unknown>;
  }
  const last = parts[parts.length - 1];
  pad(cur, last);
  cur[last] = value;
}

/** Keep arrays dense: fill any gap below a numeric index with undefined slots. */
function pad(target: Record<string | number, unknown>, key: string | number): void {
  if (typeof key === "number" && Array.isArray(target)) {
    while (target.length < key) target.push(undefined);
  }
}

function tokenizePath(path: string): Array<string | number> {
  const out: Array<string | number> = [];
  for (const seg of path.split(".")) {
    const re = /([^[\]]+)|\[(\d+)\]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(seg)) !== null) {
      if (m[1] != null) out.push(m[1]);
      else out.push(parseInt(m[2], 10));
    }
  }
  if (out.length === 0) throw new MappingError(`Empty path: ${path}`);
  return out;
}

function checkWhen(input: Input, when: MappingOp["when"]): boolean {
  if (!when) return true;
  const v = readPath(input, when.path);
  if (when.exists !== undefined) {
    const has = v != null && String(v) !== "";
    return when.exists ? has : !has;
  }
  if ("equals" in when) return String(v ?? "") === String(when.equals ?? "");
  return true;
}

export function applyMapping(doc: MappingDoc, rawInput: string | unknown, ctx?: MapperContext): Record<string, unknown> {
  let input: Input;
  if (doc.input === "hl7") {
    const msg = typeof rawInput === "string" ? parseHl7(rawInput) : (rawInput as Hl7Message);
    input = { kind: "hl7", msg };
  } else {
    const obj = typeof rawInput === "string" ? JSON.parse(rawInput) : rawInput;
    input = { kind: "json", obj };
  }

  const out: Record<string, unknown> = {};
  for (const op of doc.ops) {
    if (!checkWhen(input, op.when)) continue;
    let value: unknown = op.from != null ? readPath(input, op.from) : op.value;
    if (op.fn) {
      const fn = FN[op.fn];
      if (!fn) throw new MappingError(`Unknown mapping function: ${op.fn}`);
      value = fn(value, op.args ?? {}, input, ctx);
    }
    if (value == null || value === "") continue;
    setJsonPath(out, op.set, value);
  }
  return out;
}
