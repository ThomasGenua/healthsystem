/**
 * Loads a licensed terminology release into a Northstar database.
 *
 *   node scripts/import-terminology.ts --format <fmt> --in <file> [options]
 *
 *   --format      rf2 | loinc | csv | tsv | valueset | conceptmap | refset | map
 *   --in          the release file
 *   --descriptions  rf2 only: the Description snapshot file
 *   --system      canonical system URI, or a shorthand:
 *                 snomed, loinc, icd10ca, pclocd, cci
 *   --pack        pack id recorded for the import (default: the format name)
 *   --db          database to load into (default: ./data/northstar.db)
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
 *   node scripts/import-terminology.ts --format valueset --in diabetes-vs.json
 *   node scripts/import-terminology.ts --format conceptmap --in sct-icd10ca.json
 *   node scripts/import-terminology.ts --format refset \
 *     --in der2_Refset_SimpleSnapshot_CA1000087_20260501.txt --system snomed
 *
 * A ValueSet defined by a filter is refused rather than partly imported: this
 * store does not know the hierarchy, and a value set carrying the right name
 * with the wrong membership is worse than none. Obtain the expansion from a
 * terminology server and import that.
 *
 *   node scripts/import-terminology.ts --format csv --in icd10ca.csv \
 *     --system icd10ca --code-column Code --display-column Description
 *
 * Nothing licensed ships with Northstar; this is how an operator loads what
 * their own licence entitles them to.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Db } from "../src/db.ts";
import { TerminologyStore } from "../src/terminology/store.ts";
import { importConcepts, readerFor, SYSTEMS, type LoadedConcept, type ReleaseFormat } from "../src/terminology/loaders/index.ts";
import {
  readFhirValueSet,
  readFhirConceptMap,
  readRf2SimpleRefset,
  readRf2ExtendedMap,
} from "../src/terminology/loaders/valuesets.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

function resolveSystem(value: string | undefined): string {
  if (!value) throw new Error("--system is required (a URI, or one of: snomed, loinc, icd10ca, pclocd, cci)");
  const shorthand = SYSTEMS[value as keyof typeof SYSTEMS];
  return shorthand ?? value;
}

/**
 * Loads a value set, a concept map, or an RF2 refset file.
 *
 * A refusal here exits non-zero and says what would have worked. Importing
 * three-quarters of a value set and reporting success is the failure the
 * reader exists to prevent, and a script that shrugged at it would put the
 * failure back.
 */
async function importMemberships(format: string, input: string): Promise<void> {
  const dbPath = arg("db") ?? join(process.cwd(), "data", "northstar.db");
  const db = new Db(dbPath);
  const store = new TerminologyStore(db);
  try {
    if (format === "valueset" || format === "conceptmap") {
      const resource = JSON.parse(readFileSync(input, "utf8")) as unknown;
      const reading = format === "valueset" ? readFhirValueSet(resource) : readFhirConceptMap(resource);
      if (reading.refused) {
        console.error(`refused to import ${input}:`);
        for (const r of reading.refused) console.error(`  ${r.what}: ${r.reason}`);
        process.exitCode = 1;
        return;
      }
      const counts = store.loadPack(reading.pack!);
      console.log(`imported ${counts.valueSetMembers} members and ${counts.mapEntries} map entries into ${dbPath}`);
      if ("unmatched" in reading && reading.unmatched.length > 0) {
        console.log(`${reading.unmatched.length} source code(s) are published as unmatched and were not mapped`);
      }
      return;
    }

    const system = resolveSystem(arg("system") ?? "snomed");
    if (format === "refset") {
      const bySet = new Map<string, Map<string, string[]>>();
      let total = 0;
      for await (const m of readRf2SimpleRefset(input, system)) {
        const sets = bySet.get(m.valueset) ?? new Map<string, string[]>();
        const codes = sets.get(m.system) ?? [];
        codes.push(m.code);
        sets.set(m.system, codes);
        bySet.set(m.valueset, sets);
        total++;
      }
      store.loadPack({
        id: arg("pack") ?? "rf2-refsets",
        valueSets: [...bySet].map(([id, sets]) => ({
          id,
          include: [...sets].map(([sys, codes]) => ({ system: sys, codes })),
        })),
      });
      console.log(`imported ${total} membership(s) across ${bySet.size} value set(s) into ${dbPath}`);
      return;
    }

    const targetSystem = resolveSystem(arg("target-system"));
    const entries: NonNullable<Parameters<typeof store.loadPack>[0]["conceptMaps"]>[number]["entries"] = [];
    let unmatched = 0;
    let mapId = arg("pack") ?? "rf2-map";
    for await (const row of readRf2ExtendedMap(input, targetSystem, system)) {
      mapId = arg("pack") ?? row.map;
      if (row.targetCode === null) {
        unmatched++;
        continue;
      }
      entries.push({
        sourceSystem: row.sourceSystem,
        sourceCode: row.sourceCode,
        targetSystem: row.targetSystem,
        targetCode: row.targetCode,
      });
    }
    store.loadPack({ id: `conceptmap:${mapId}`, conceptMaps: [{ id: mapId, entries }] });
    console.log(`imported ${entries.length} mapping(s) into ${dbPath}`);
    if (unmatched > 0) console.log(`${unmatched} source code(s) have no target in the release and were not mapped`);
  } finally {
    console.log("store now holds:", store.stats());
    db.close();
  }
}

async function main(): Promise<void> {
  // Widened beyond ReleaseFormat: memberships and mappings are read by a
  // different set of readers and are dispatched before the concept path.
  const format = arg("format") as ReleaseFormat | "valueset" | "conceptmap" | "refset" | "map" | undefined;
  const input = arg("in");
  if (!format || !input) {
    console.error(
      "usage: --format rf2|loinc|csv|tsv|valueset|conceptmap|refset|map --in <file> " +
        "[--system <uri|shorthand>] [--target-system <uri|shorthand>] [--pack id] [--db path] [--out pack.json]"
    );
    process.exit(2);
  }

  // Memberships and mappings are their own thing: they arrive as FHIR
  // resources or RF2 refset files, not as concept lists, and one of them can
  // legitimately refuse to import at all.
  if (format === "valueset" || format === "conceptmap" || format === "refset" || format === "map") {
    await importMemberships(format, input);
    return;
  }

  const system = resolveSystem(arg("system"));
  const packId = arg("pack") ?? format;
  const outPath = arg("out");
  const dbPath = arg("db") ?? join(process.cwd(), "data", "northstar.db");
  const batch = Number(arg("batch") ?? 5000);

  const source = readerFor(
    format as ReleaseFormat,
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
