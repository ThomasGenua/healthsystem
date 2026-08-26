/**
 * Importing memberships and mappings from what publishers actually ship.
 *
 * The property under test is a refusal. A FHIR ValueSet can be defined
 * intensionally — "every descendant of 73211009" — and expanding that needs a
 * terminology server that knows the hierarchy, which this store deliberately
 * is not. A reader that imported the enumerated part of such a definition and
 * ignored the filter would produce a value set carrying the right name and
 * the wrong membership, with no error anywhere, and every membership check
 * against it would silently be wrong.
 *
 * So the tests that matter are the ones where nothing is imported.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../src/db.ts";
import { TerminologyStore } from "../src/terminology/store.ts";
import {
  readFhirValueSet,
  readFhirConceptMap,
  readRf2SimpleRefset,
  readRf2ExtendedMap,
} from "../src/terminology/loaders/valuesets.ts";

const SCT = "http://snomed.info/sct";

function store() {
  const dir = mkdtempSync(join(tmpdir(), "portage-term-"));
  const db = new Db(join(dir, "portage.db"));
  return {
    db,
    terms: new TerminologyStore(db),
    dir,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const enumerated = {
  resourceType: "ValueSet",
  id: "diabetes-conditions",
  name: "Diabetes conditions",
  compose: {
    include: [
      { system: SCT, concept: [{ code: "44054006" }, { code: "46635009" }] },
      { system: "http://loinc.org", concept: [{ code: "4548-4" }] },
    ],
  },
};

test("a value set defined by a filter is refused, not partially imported", () => {
  // The one that matters. Importing the enumerated half of this would produce
  // "diabetes-conditions" containing two codes when the publisher meant every
  // descendant of the hierarchy — right name, wrong membership, no error.
  const intensional = {
    resourceType: "ValueSet",
    id: "diabetes-all",
    compose: {
      include: [
        { system: SCT, concept: [{ code: "44054006" }] },
        { system: SCT, filter: [{ property: "concept", op: "is-a", value: "73211009" }] },
      ],
    },
  };
  const reading = readFhirValueSet(intensional);
  assert.equal(reading.pack, undefined, "nothing is importable from a definition this store cannot resolve");
  assert.ok(reading.refused);
  assert.match(reading.refused![0].reason, /is-a 73211009/);
  assert.match(reading.refused![0].reason, /server-produced expansion/, "and it says what would work instead");
});

test("an enumerated value set imports, and expands to exactly what was listed", () => {
  const reading = readFhirValueSet(enumerated);
  assert.equal(reading.refused, undefined);
  assert.equal(reading.memberCount, 3);

  const w = store();
  try {
    w.terms.loadPack(reading.pack!);
    const expansion = w.terms.expand("diabetes-conditions");
    assert.equal(expansion.total, 3);
    assert.deepEqual(
      expansion.codes.map((c) => c.code).sort(),
      ["44054006", "4548-4", "46635009"].sort()
    );
  } finally {
    w.cleanup();
  }
});

test("a server-produced expansion is preferred over the definition", () => {
  // The supported path for an intensional value set: somebody who knows the
  // hierarchy did the work, and the result is authoritative.
  const expanded = {
    resourceType: "ValueSet",
    id: "diabetes-all",
    compose: { include: [{ system: SCT, filter: [{ property: "concept", op: "is-a", value: "73211009" }] }] },
    expansion: {
      contains: [
        { system: SCT, code: "44054006", display: "Type 2 diabetes mellitus" },
        { system: SCT, code: "46635009", display: "Type 1 diabetes mellitus" },
      ],
    },
  };
  const reading = readFhirValueSet(expanded);
  assert.equal(reading.refused, undefined, "the filter is not consulted when an expansion is present");
  assert.equal(reading.memberCount, 2);
});

test("a grouped expansion is refused rather than flattened", () => {
  // Nested `contains` is a hierarchy in disguise; reading only the top level
  // drops its children and reading both can duplicate them.
  const grouped = {
    resourceType: "ValueSet",
    id: "grouped",
    expansion: {
      contains: [{ system: SCT, code: "73211009", contains: [{ system: SCT, code: "44054006" }] }],
    },
  };
  const reading = readFhirValueSet(grouped);
  assert.equal(reading.pack, undefined);
  assert.match(reading.refused![0].reason, /grouped/);
});

test("a value set composed from another by reference is refused", () => {
  const composed = {
    resourceType: "ValueSet",
    id: "composed",
    compose: { include: [{ valueSet: ["http://example.org/ValueSet/other"] }] },
  };
  assert.match(readFhirValueSet(composed).refused![0].reason, /another value set by reference/);
});

test("including a whole code system is refused, because this store does not enumerate one", () => {
  const whole = { resourceType: "ValueSet", id: "everything", compose: { include: [{ system: SCT }] } };
  assert.match(readFhirValueSet(whole).refused![0].reason, /includes the whole of/);
});

test("an exclusion refuses the value set rather than being approximated", () => {
  // Applying an exclusion wrongly makes the value set larger than published,
  // which is the direction that matters for a membership check.
  const withExclude = {
    ...enumerated,
    compose: { ...enumerated.compose, exclude: [{ system: SCT, concept: [{ code: "44054006" }] }] },
  };
  assert.match(readFhirValueSet(withExclude).refused![0].reason, /compose.exclude/);
});

test("a concept map keeps how well each code maps", () => {
  // "wider" is not "equivalent", and a map that flattened the two would
  // assert a precision the publisher explicitly declined to.
  const map = {
    resourceType: "ConceptMap",
    id: "sct-to-icd10ca",
    group: [
      {
        source: SCT,
        target: "https://fhir.infoway-inforoute.ca/CodeSystem/icd10ca",
        element: [
          { code: "44054006", target: [{ code: "E11", display: "Type 2 diabetes mellitus", equivalence: "equivalent" }] },
          { code: "46635009", target: [{ code: "E10", equivalence: "wider" }] },
        ],
      },
    ],
  };
  const reading = readFhirConceptMap(map);
  assert.equal(reading.entryCount, 2);

  const w = store();
  try {
    w.terms.loadPack(reading.pack!);
    const [wider] = w.terms.translate({ code: "46635009", map: "sct-to-icd10ca" });
    assert.equal(wider.code, "E10");
    assert.equal(wider.equivalence, "wider", "the publisher's own claim, not an upgrade of it");
  } finally {
    w.cleanup();
  }
});

test("a code the publisher says does not map is recorded as unmatched, not mapped to nothing", () => {
  const map = {
    resourceType: "ConceptMap",
    id: "partial",
    group: [
      {
        source: SCT,
        target: "http://loinc.org",
        element: [
          { code: "44054006", target: [{ equivalence: "unmatched" }] },
          { code: "46635009", target: [] },
        ],
      },
    ],
  };
  const reading = readFhirConceptMap(map);
  assert.equal(reading.entryCount, 0, "neither becomes a mapping");
  assert.equal(reading.unmatched.length, 2, "and both are reported as answered");
  assert.deepEqual(reading.unmatched.map((u) => u.code).sort(), ["44054006", "46635009"]);
});

test("R5 spells the relationship differently and is still read", () => {
  const r5 = {
    resourceType: "ConceptMap",
    id: "r5",
    group: [{ source: SCT, target: "http://loinc.org", element: [{ code: "44054006", target: [{ code: "X", relationship: "source-is-narrower-than-target" }] }] }],
  };
  const reading = readFhirConceptMap(r5);
  assert.equal(reading.pack!.conceptMaps![0].entries[0].equivalence, "source-is-narrower-than-target");
});

test("a group with no source or target system is refused", () => {
  const map = { resourceType: "ConceptMap", id: "nameless", group: [{ element: [{ code: "1", target: [{ code: "2" }] }] }] };
  assert.match(readFhirConceptMap(map).refused![0].reason, /no source or target system/);
});

test("an RF2 simple refset streams memberships and honours the active flag", async () => {
  // An inactive row is the release stating the concept is *not* a member, so
  // dropping it is reading the file correctly rather than skipping data.
  const w = store();
  try {
    const file = join(w.dir, "refset.txt");
    writeFileSync(
      file,
      [
        "id\teffectiveTime\tactive\tmoduleId\trefsetId\treferencedComponentId",
        "a\t20260101\t1\tm\t723264001\t44054006",
        "b\t20260101\t1\tm\t723264001\t46635009",
        "c\t20260101\t0\tm\t723264001\t99999999",
      ].join("\n")
    );
    const members = [];
    for await (const m of readRf2SimpleRefset(file)) members.push(m);
    assert.equal(members.length, 2, "the retired membership is not a member");
    assert.deepEqual(members.map((m) => m.code), ["44054006", "46635009"]);
    assert.equal(members[0].valueset, "723264001");
    assert.equal(members[0].system, SCT);
  } finally {
    w.cleanup();
  }
});

test("an RF2 cross-map reports a rule with no target as no target, not as an empty code", async () => {
  const w = store();
  try {
    const file = join(w.dir, "map.txt");
    writeFileSync(
      file,
      [
        "id\teffectiveTime\tactive\tmoduleId\trefsetId\treferencedComponentId\tmapPriority\tmapTarget",
        "a\t20260101\t1\tm\t447562003\t44054006\t1\tE11",
        "b\t20260101\t1\tm\t447562003\t46635009\t1\t",
      ].join("\n")
    );
    const rows = [];
    for await (const r of readRf2ExtendedMap(file, "https://fhir.infoway-inforoute.ca/CodeSystem/icd10ca")) rows.push(r);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].targetCode, "E11");
    assert.equal(rows[1].targetCode, null, "empty would be a code that looks real and matches nothing");
  } finally {
    w.cleanup();
  }
});

test("something that is not a value set at all is said plainly", () => {
  assert.match(readFhirValueSet({ resourceType: "CodeSystem", id: "x" }).refused![0].reason, /not a FHIR ValueSet/);
  assert.match(readFhirConceptMap({ resourceType: "ValueSet", id: "x" }).refused![0].reason, /not a FHIR ConceptMap/);
});
