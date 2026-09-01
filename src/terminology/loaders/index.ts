/**
 * Loaders that turn licensed terminology distributions into the pack shape the
 * terminology store already accepts.
 *
 * No licensed content ships with Northstar. SNOMED CT CA, LOINC, pCLOCD,
 * ICD-10-CA and CCI are licensed distributions an operator obtains and loads
 * themselves; these readers take the files as published and emit concepts, so
 * loading a release is a command rather than a data-entry exercise.
 *
 * Everything streams. A SNOMED snapshot is millions of rows and must never be
 * held in memory as one object, so concepts arrive as an async iterable and go
 * into the store in batches.
 */
import { column, readRows } from "./delimited.ts";
import type { TerminologyStore } from "../store.ts";

export interface LoadedConcept {
  system: string;
  code: string;
  display?: string;
}

/** Canonical system URIs, so every loader emits the same identifiers. */
export const SYSTEMS = {
  snomed: "http://snomed.info/sct",
  loinc: "http://loinc.org",
  icd10ca: "https://fhir.infoway-inforoute.ca/CodeSystem/icd10ca",
  pclocd: "https://fhir.infoway-inforoute.ca/CodeSystem/pCLOCD",
  cci: "https://fhir.infoway-inforoute.ca/CodeSystem/cci",
} as const;

export type ReleaseFormat = "rf2" | "loinc" | "csv" | "tsv";

const RF2_FSN = "900000000000003001";

/**
 * SNOMED CT RF2, from the Concept and Description snapshot files.
 *
 * Two passes: the concept file establishes which concepts are active, then the
 * description file supplies their fully specified names. Only the active
 * concept ids are held in memory (a few hundred thousand strings), never the
 * descriptions, which are the bulk of the release.
 *
 * The FSN carries a trailing semantic tag — "Asthma (disorder)" — which is
 * part of the name in RF2 but noise in a display string, so it is trimmed.
 */
export async function* readRf2(
  conceptFile: string,
  descriptionFile: string,
  system: string = SYSTEMS.snomed
): AsyncGenerator<LoadedConcept, void, unknown> {
  const active = new Set<string>();
  for await (const row of readRows(conceptFile, "\t")) {
    if (column(row, "active") === "1") active.add(column(row, "id") ?? "");
  }

  const seen = new Set<string>();
  for await (const row of readRows(descriptionFile, "\t")) {
    if (column(row, "active") !== "1") continue;
    if (column(row, "typeId") !== RF2_FSN) continue;
    const conceptId = column(row, "conceptId") ?? "";
    if (!active.has(conceptId) || seen.has(conceptId)) continue;
    seen.add(conceptId);
    yield { system, code: conceptId, display: stripSemanticTag(column(row, "term") ?? "") };
  }
}

function stripSemanticTag(term: string): string {
  return term.replace(/\s*\([^()]*\)\s*$/, "").trim() || term;
}

/**
 * LOINC's published Loinc.csv. Inactive codes are skipped when the release
 * carries a STATUS column; older releases omit it, in which case everything
 * is taken.
 */
export async function* readLoinc(
  file: string,
  system: string = SYSTEMS.loinc
): AsyncGenerator<LoadedConcept, void, unknown> {
  for await (const row of readRows(file, ",")) {
    const code = column(row, "LOINC_NUM", "LoincNumber")?.trim();
    if (!code) continue;
    const status = column(row, "STATUS");
    if (status && status.toUpperCase() !== "ACTIVE") continue;
    const display = column(row, "LONG_COMMON_NAME", "SHORTNAME", "COMPONENT")?.trim();
    yield { system, code, display: display || undefined };
  }
}

export interface DelimitedOptions {
  system: string;
  codeColumn?: string;
  displayColumn?: string;
  delimiter?: string;
}

/**
 * Generic two-column reader for the classification releases — ICD-10-CA,
 * pCLOCD, CCI — which are published as plain code/description tables in
 * varying column names and delimiters.
 */
export async function* readDelimitedConcepts(
  file: string,
  opts: DelimitedOptions
): AsyncGenerator<LoadedConcept, void, unknown> {
  const codeCol = opts.codeColumn ?? "code";
  const displayCol = opts.displayColumn ?? "display";
  for await (const row of readRows(file, opts.delimiter ?? ",")) {
    const code = column(row, codeCol)?.trim();
    if (!code) continue;
    const display = column(row, displayCol)?.trim();
    yield { system: opts.system, code, display: display || undefined };
  }
}

export interface ImportResult {
  concepts: number;
  batches: number;
}

/**
 * Streams concepts into the terminology store in batches.
 *
 * loadPack is idempotent — concepts upsert on (system, code) — so a batched
 * import is equivalent to one enormous pack, and re-running a release is safe.
 */
export async function importConcepts(
  store: TerminologyStore,
  packId: string,
  source: AsyncIterable<LoadedConcept>,
  batchSize = 5_000,
  onProgress?: (loaded: number) => void
): Promise<ImportResult> {
  let batch: LoadedConcept[] = [];
  let concepts = 0;
  let batches = 0;

  const flush = (): void => {
    if (batch.length === 0) return;
    store.loadPack({ id: packId, concepts: batch });
    concepts += batch.length;
    batches++;
    batch = [];
    onProgress?.(concepts);
  };

  for await (const concept of source) {
    batch.push(concept);
    if (batch.length >= batchSize) flush();
  }
  flush();

  return { concepts, batches };
}

/** Builds the right reader for a release format. */
export function readerFor(
  format: ReleaseFormat,
  files: { input: string; descriptions?: string },
  opts: { system: string; codeColumn?: string; displayColumn?: string }
): AsyncIterable<LoadedConcept> {
  switch (format) {
    case "rf2":
      if (!files.descriptions) throw new Error("rf2 needs --descriptions pointing at the Description snapshot file");
      return readRf2(files.input, files.descriptions, opts.system);
    case "loinc":
      return readLoinc(files.input, opts.system);
    case "csv":
      return readDelimitedConcepts(files.input, { ...opts, delimiter: "," });
    case "tsv":
      return readDelimitedConcepts(files.input, { ...opts, delimiter: "\t" });
    default:
      throw new Error(`unknown format: ${String(format)}`);
  }
}
