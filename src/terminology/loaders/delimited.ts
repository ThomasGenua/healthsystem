/**
 * Streaming reader for delimited release files.
 *
 * Terminology distributions are large — a SNOMED RF2 description snapshot runs
 * to millions of rows — so every reader here streams line by line and never
 * holds the file in memory.
 *
 * The field splitter handles RFC 4180 quoting, which LOINC's CSV needs (long
 * common names contain commas) and which tab-delimited RF2 does not, at no
 * cost when no quotes are present.
 */
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

/** Splits one delimited line, honouring "quoted fields" and "" escapes. */
export function splitLine(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"' && field === "") {
      quoted = true;
    } else if (c === delimiter) {
      out.push(field);
      field = "";
    } else {
      field += c;
    }
  }
  out.push(field);
  return out;
}

/**
 * Yields each data row as a header-keyed record. The first non-empty line is
 * taken as the header, so a caller names columns rather than counting them —
 * release formats add columns between versions.
 */
export async function* readRows(
  path: string,
  delimiter: string
): AsyncGenerator<Record<string, string>, void, unknown> {
  const stream = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let header: string[] | null = null;

  try {
    for await (const raw of lines) {
      const line = raw.replace(/\r$/, "");
      if (!line.trim()) continue;
      const fields = splitLine(line, delimiter);
      if (!header) {
        header = fields.map((h) => h.trim());
        continue;
      }
      const row: Record<string, string> = {};
      for (let i = 0; i < header.length; i++) row[header[i]] = fields[i] ?? "";
      yield row;
    }
  } finally {
    lines.close();
    stream.destroy();
  }
}

/** Case-insensitive column lookup: releases vary the casing between versions. */
export function column(row: Record<string, string>, ...names: string[]): string | undefined {
  for (const name of names) {
    if (row[name] !== undefined) return row[name];
    const hit = Object.keys(row).find((k) => k.toLowerCase() === name.toLowerCase());
    if (hit) return row[hit];
  }
  return undefined;
}
