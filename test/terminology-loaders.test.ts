import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Db } from "../src/db.ts";
import { TerminologyStore } from "../src/terminology/store.ts";
import { splitLine } from "../src/terminology/loaders/delimited.ts";
import {
  SYSTEMS,
  importConcepts,
  readDelimitedConcepts,
  readLoinc,
  readRf2,
  readerFor,
  type LoadedConcept,
} from "../src/terminology/loaders/index.ts";

const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/terminology/${name}`, import.meta.url));

async function collect(source: AsyncIterable<LoadedConcept>): Promise<LoadedConcept[]> {
  const out: LoadedConcept[] = [];
  for await (const c of source) out.push(c);
  return out;
}

test("delimited splitter handles quoting, embedded delimiters and escaped quotes", () => {
  assert.deepEqual(splitLine("a,b,c", ","), ["a", "b", "c"]);
  assert.deepEqual(splitLine('"a","b, still b","c"', ","), ["a", "b, still b", "c"]);
  assert.deepEqual(splitLine('"say ""hi""",x', ","), ['say "hi"', "x"]);
  assert.deepEqual(splitLine("a\tb\tc", "\t"), ["a", "b", "c"]);
  assert.deepEqual(splitLine("a,,c", ","), ["a", "", "c"]);
  assert.deepEqual(splitLine("", ","), [""]);
});

test("RF2: active concepts only, FSN as display, semantic tag stripped", async () => {
  const concepts = await collect(
    readRf2(fixture("rf2-concept-synthetic.txt"), fixture("rf2-description-synthetic.txt"))
  );

  assert.equal(concepts.length, 3, "the inactive concept must not be emitted");
  const byCode = new Map(concepts.map((c) => [c.code, c]));

  assert.equal(byCode.get("195967001")?.display, "Asthma", "the (disorder) semantic tag is trimmed");
  assert.equal(byCode.get("44054006")?.display, "Diabetes mellitus type 2");
  assert.equal(byCode.get("73211009")?.display, "Diabetes mellitus");
  assert.ok(!byCode.has("11111111"), "a concept marked inactive in the concept file is skipped");

  // The retired description for 73211009 must not win over the active one,
  // and the synonym row for 195967001 must not be emitted as a second concept.
  assert.notEqual(byCode.get("73211009")?.display, "Retired name");
  assert.equal(concepts.filter((c) => c.code === "195967001").length, 1);

  for (const c of concepts) assert.equal(c.system, SYSTEMS.snomed);
});

test("LOINC: skips non-active codes and prefers the long common name", async () => {
  const concepts = await collect(readLoinc(fixture("loinc-synthetic.csv")));

  assert.equal(concepts.length, 3);
  const byCode = new Map(concepts.map((c) => [c.code, c]));
  assert.equal(byCode.get("718-7")?.display, "Hemoglobin [Mass/volume] in Blood");
  // This display contains commas, which is exactly why the CSV reader quotes.
  assert.equal(byCode.get("2345-7")?.display, "Glucose [Mass/volume] in Serum, Plasma, or Blood");
  assert.ok(!byCode.has("99999-9"), "a DEPRECATED code must not be loaded");
  for (const c of concepts) assert.equal(c.system, SYSTEMS.loinc);
});

test("generic delimited reader handles the classification releases", async () => {
  const concepts = await collect(
    readDelimitedConcepts(fixture("icd10ca-synthetic.csv"), {
      system: SYSTEMS.icd10ca,
      codeColumn: "Code",
      displayColumn: "Description",
    })
  );

  assert.equal(concepts.length, 3);
  assert.equal(concepts[0].code, "J45");
  assert.equal(concepts[1].display, "Type 2 diabetes mellitus, without complications");
  assert.equal(concepts[2].system, SYSTEMS.icd10ca);
});

test("column lookup is case-insensitive across release versions", async () => {
  // Same file, columns named in the wrong case — releases vary this and a
  // loader that cared would break on a version bump.
  const concepts = await collect(
    readDelimitedConcepts(fixture("icd10ca-synthetic.csv"), {
      system: SYSTEMS.icd10ca,
      codeColumn: "CODE",
      displayColumn: "description",
    })
  );
  assert.equal(concepts.length, 3);
  assert.equal(concepts[0].display, "Asthma");
});

test("imported concepts land in the store and are immediately usable", async () => {
  const db = new Db(":memory:");
  const store = new TerminologyStore(db);
  try {
    const result = await importConcepts(
      store,
      "loinc-test",
      readLoinc(fixture("loinc-synthetic.csv")),
      2 // a small batch, so batching is actually exercised
    );

    assert.equal(result.concepts, 3);
    assert.equal(result.batches, 2, "3 concepts at batch size 2 is two writes");

    const hit = store.lookup(SYSTEMS.loinc, "718-7");
    assert.equal(hit?.display, "Hemoglobin [Mass/volume] in Blood");
    assert.equal(store.lookup(SYSTEMS.loinc, "99999-9"), undefined);

    // Re-importing the same release must not duplicate: loadPack upserts on
    // (system, code), so a repeated load is safe.
    const again = await importConcepts(store, "loinc-test", readLoinc(fixture("loinc-synthetic.csv")), 2);
    assert.equal(again.concepts, 3);
    assert.equal((store.stats() as { concepts: number }).concepts, 3, "a re-import must not duplicate concepts");
  } finally {
    db.close();
  }
});

test("readerFor dispatches by format and refuses an incomplete rf2 request", () => {
  assert.throws(
    () => readerFor("rf2", { input: fixture("rf2-concept-synthetic.txt") }, { system: SYSTEMS.snomed }),
    /--descriptions/
  );
  assert.throws(
    () => readerFor("nonsense" as never, { input: "x" }, { system: "s" }),
    /unknown format/
  );
  assert.ok(readerFor("loinc", { input: fixture("loinc-synthetic.csv") }, { system: SYSTEMS.loinc }));
  assert.ok(readerFor("tsv", { input: fixture("rf2-concept-synthetic.txt") }, { system: "urn:x" }));
});
