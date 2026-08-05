/**
 * Loads a licensed terminology release into a Portage database.
 *
 *   node scripts/import-terminology.ts --format <fmt> --in <file> [options]
 *
 *   --format      rf2 | loinc | csv | tsv
 *   --in          the release file
 *   --descriptions  rf2 only: the Description snapshot file
 *   --system      canonical system URI, or a shorthand:
 *                 snomed, loinc, icd10ca, pclocd, cci
 *   --pack        pack id recorded for the import (default: the format name)
 *   --db          database to load into (default: ./data/portage.db)
 *   --out         also write the concepts as a pack JSON file
 *   --code-column / --display-column   csv and tsv only
 *   --batch       concepts per write (default 5000)
 *
 * Examples:
 *
 *   node scripts/import-terminology.ts --format rf2 \
 *     --in sct2_Concept_Snapshot_CA1000087_20260501.txt \
 *     --descriptions sct2_Description_Snapshot-en_CA1000087_20260501.txt \
 *     --system snomed --pack snomed-ca
 *
 *   node scripts/import-terminology.ts --format loinc --in Loinc.csv --system loinc
 *
 *   node scripts/import-terminology.ts --format csv --in icd10ca.csv \
 *     --system icd10ca --code-column Code --display-column Description
 *
 * Nothing licensed ships with Portage; this is how an operator loads what
 * their own licence entitles them to.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Db } from "../src/db.ts";
import { TerminologyStore } from "../src/terminology/store.ts";
import { importConcepts, readerFor, SYSTEMS, type LoadedConcept, type ReleaseFormat } from "../src/terminology/loaders/index.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

function resolveSystem(value: string | undefined): string {
  if (!value) throw new Error("--system is required (a URI, or one of: snomed, loinc, icd10ca, pclocd, cci)");
  const shorthand = SYSTEMS[value as keyof typeof SYSTEMS];
  return shorthand ?? value;
}

async function main(): Promise<void> {
  const format = arg("format") as ReleaseFormat | undefined;
  const input = arg("in");
  if (!format || !input) {
    console.error("usage: --format rf2|loinc|csv|tsv --in <file> --system <uri|shorthand> [--pack id] [--db path] [--out pack.json]");
    process.exit(2);
  }

  const system = resolveSystem(arg("system"));
  const packId = arg("pack") ?? format;
  const outPath = arg("out");
  const dbPath = arg("db") ?? join(process.cwd(), "data", "portage.db");
  const batch = Number(arg("batch") ?? 5000);

  const source = readerFor(
    format,
    { input, descriptions: arg("descriptions") },
    { system, codeColumn: arg("code-column"), displayColumn: arg("display-column") }
  );

  const db = new Db(dbPath);
  const store = new TerminologyStore(db);
  console.log(`importing ${format} from ${input} as ${system} into ${dbPath}`);

  // When a pack file is also wanted, tee the stream rather than reading twice.
  const collected: LoadedConcept[] = [];
  const tee = outPath
    ? (async function* () {
        for await (const c of source) {
          collected.push(c);
          yield c;
        }
      })()
    : source;

  const started = Date.now();
  const result = await importConcepts(store, packId, tee, batch, (loaded) => {
    if (loaded % 50_000 === 0) console.log(`  ${loaded} concepts...`);
  });

  if (outPath) {
    writeFileSync(outPath, JSON.stringify({ id: packId, name: `${packId} import`, concepts: collected }, null, 2));
    console.log(`wrote pack ${outPath}`);
  }

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`imported ${result.concepts} concepts in ${result.batches} batches (${secs}s)`);
  console.log("store now holds:", store.stats());
  db.close();
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
