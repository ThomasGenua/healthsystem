/**
 * A summary that leaves the building, and the five ways a section is empty.
 *
 * A patient summary is read somewhere nobody can ask the sending system a
 * follow-up question. That makes an empty section dangerous in a way it is
 * not on a chart the author is standing next to: an empty allergy list can
 * mean the patient has none, that nobody asked, that somebody asked and the
 * answer is unknown, that a directive withholds it, or that this system does
 * not hold that kind of record. Rendered as an empty list they look identical,
 * and a reader supplies the most comfortable reading, which is "no allergies".
 *
 * So every empty section carries a coded reason and, because the mapping from
 * this system's vocabulary to FHIR's is lossy, the original word beside it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSummary, verifySummary, emptyReasonFor, type SummarySection } from "../src/clinical/summary.ts";
import { Refusal } from "../src/core/refusal.ts";

const KEY = "a-signing-key-for-tests";
const PATIENT = { resourceType: "Patient", id: "NT123456", name: [{ family: "Beaulieu" }] };

const deps = {
  tenantId: "default",
  terminologySystems: () => ["http://snomed.info/sct", "http://loinc.org"],
  activeGuides: () => [] as string[],
};

const section = (title: string, code: string, entries: unknown[], status: string): SummarySection => ({
  title,
  code,
  entries: entries as Array<Record<string, unknown>>,
  status,
  ...(entries.length === 0 ? { emptyReason: emptyReasonFor(status) } : {}),
});

const build = (sections: SummarySection[], key: string | undefined = KEY) =>
  buildSummary("NT123456", PATIENT, sections, deps, key, new Date("2026-09-01T12:00:00.000Z"));

// ── The five empties ──────────────────────────────────────────────────────

test("the five reasons a section is empty stay five different facts", () => {
  const cases: Array<[string, string]> = [
    ["none-documented", "nilknown"],
    ["never-asked", "notasked"],
    ["unknown", "unavailable"],
    ["withheld", "withheld"],
    ["not-applicable", "unavailable"],
  ];
  for (const [status, code] of cases) {
    assert.equal(emptyReasonFor(status), code, `${status} should map to ${code}`);
  }
  // Only one of them means "the patient has none of these".
  assert.equal(emptyReasonFor("none-documented"), "nilknown");
  assert.notEqual(emptyReasonFor("never-asked"), "nilknown", "nobody asked is not the same as none");
});

test("a status the mapping does not recognise never reads as 'the patient has none'", () => {
  // The direction this has to fail in. A state added later and not mapped
  // must not silently become an assertion of absence.
  assert.equal(emptyReasonFor("some-future-state"), "unavailable");
  assert.equal(emptyReasonFor(""), "unavailable");
});

test("an empty section says which word this system used, not only the code", () => {
  // The mapping is lossy: "never-asked" and "never-recorded" both become
  // "notasked", and only the original distinguishes them.
  const { bundle } = build([section("Allergies and intolerances", "48765-2", [], "never-asked")]);
  const composition = (bundle.entry as Array<{ resource: Record<string, unknown> }>)[0].resource;
  const sec = (composition.section as Array<Record<string, unknown>>)[0];
  const reason = sec.emptyReason as { coding: Array<{ code: string }>; text: string };
  assert.equal(reason.coding[0].code, "notasked");
  assert.match(reason.text, /never-asked/, "the originating status travels with the code");
  assert.equal(sec.entry, undefined, "an empty section has no entries, not an empty array of them");
});

test("a section with entries carries them and no empty reason at all", () => {
  const { bundle, manifest } = build([
    section("Allergies and intolerances", "48765-2", [{ resourceType: "AllergyIntolerance", id: "a1" }], "documented"),
  ]);
  const composition = (bundle.entry as Array<{ resource: Record<string, unknown> }>)[0].resource;
  const sec = (composition.section as Array<Record<string, unknown>>)[0];
  assert.equal(sec.emptyReason, undefined);
  assert.equal((sec.entry as unknown[]).length, 1);
  assert.equal(manifest.sections[0].entries, 1);
  assert.equal(manifest.sections[0].emptyReason, undefined);
});

// ── The manifest ──────────────────────────────────────────────────────────

test("the manifest says what it does not know, rather than omitting it", () => {
  const { manifest } = build([section("Immunizations", "11369-6", [], "never-asked")]);

  // Terminology releases carry no version in this system, and the manifest
  // says so. Omitting the field would let a reader assume they were checked.
  assert.equal(manifest.terminology.versions, "unrecorded");
  assert.deepEqual(manifest.terminology.systems, ["http://snomed.info/sct", "http://loinc.org"]);
  assert.match(manifest.terminology.note, /Do not read an absent version as a current one/);

  // Nothing was validated, and that is stated rather than left blank.
  assert.equal(manifest.validation.pack, null);
  assert.match(manifest.validation.note, /has been validated against any profile/);

  // And the document does not claim to be an IPS.
  assert.match(manifest.assurance, /Not IPS-conformant/);
  assert.match(manifest.assurance, /no IPS package has been fetched/);
});

test("the manifest claims only the guides the registry says are in force", () => {
  const { manifest } = build([section("Procedures", "47519-4", [], "never-recorded")]);
  assert.deepEqual(manifest.conformance.claimed, []);
  assert.match(manifest.conformance.note, /not a statement that any external body has tested/);
});

test("a validated document reports what the pack found, and what passing it is not", () => {
  const withPack = {
    ...deps,
    validate: () => ({ pack: "ps-ca", issues: [{ severity: "warning", path: "Patient.identifier" }] }),
  };
  const { manifest } = buildSummary("NT123456", PATIENT, [section("Allergies", "48765-2", [], "never-asked")], withPack, KEY);
  assert.equal(manifest.validation.pack, "ps-ca");
  assert.equal((manifest.validation as { issues: unknown[] }).issues.length, 1);
  assert.match(manifest.validation.note, /working subset and not a published implementation guide/);
  assert.match(manifest.validation.note, /Passing it is not conformance/);
});

// ── Signing ───────────────────────────────────────────────────────────────

test("an export without a signing key is refused, not quietly unsigned", () => {
  // An unsigned summary cannot be told from one edited on the way. Refusing
  // is about the shareable copy; reading one's own chart is a different route
  // and is unaffected.
  for (const key of [undefined, "", "   "]) {
    assert.throws(
      // Directly rather than through the helper: a default parameter treats an
      // explicit undefined as absent and would hand back the real key.
      () => buildSummary("NT123456", PATIENT, [section("Allergies", "48765-2", [], "never-asked")], deps, key),
      (err: unknown) => err instanceof Refusal && err.status === 503 && /cannot be exported without a signing key/.test(err.message),
      `a key of ${JSON.stringify(key)} must not sign anything`,
    );
  }
});

test("the signature and digest verify, and catch either half being altered", () => {
  const { bundle, manifest } = build([
    section("Allergies", "48765-2", [{ resourceType: "AllergyIntolerance", id: "a1", code: { text: "Penicillin" } }], "documented"),
  ]);
  assert.deepEqual(verifySummary(bundle, manifest, KEY), { ok: true });

  // The document altered after signing.
  const tampered = JSON.parse(JSON.stringify(bundle)) as Record<string, unknown>;
  const entries = tampered.entry as Array<{ resource: Record<string, unknown> }>;
  entries[2].resource.code = { text: "Amoxicillin" };
  const docChanged = verifySummary(tampered, manifest, KEY);
  assert.equal(docChanged.ok, false);
  assert.match(docChanged.ok === false ? docChanged.reason : "", /does not match the digest/);

  // The manifest altered after signing.
  // A manifest that claims the allergy section was a positive "none known"
  // when the document says it was documented — the edit somebody would make.
  const lying = { ...manifest, sections: manifest.sections.map((s) => ({ ...s, status: "none-documented", entries: 0 })) };
  const manifestChanged = verifySummary(bundle, lying, KEY);
  assert.equal(manifestChanged.ok, false);
  assert.match(manifestChanged.ok === false ? manifestChanged.reason : "", /signature does not match/);

  // A different key does not verify.
  assert.equal(verifySummary(bundle, manifest, "another-key").ok, false);
});

test("the digest is stable across key order, so a re-serialised document still verifies", () => {
  // A document that fails verification after passing through any JSON library
  // that reorders keys would make the signature useless in practice.
  const { bundle, manifest } = build([section("Allergies", "48765-2", [], "none-documented")]);
  const reordered = JSON.parse(JSON.stringify({ entry: bundle.entry, type: bundle.type, timestamp: bundle.timestamp, resourceType: bundle.resourceType }));
  assert.deepEqual(verifySummary(reordered as Record<string, unknown>, manifest, KEY), { ok: true });
});

// ── The document ──────────────────────────────────────────────────────────

test("a summary of a patient this chart does not hold is refused", () => {
  assert.throws(
    () => buildSummary("NT999999", null, [], deps, KEY),
    (err: unknown) => err instanceof Refusal && err.status === 404 && /summary of nobody/.test(err.message),
  );
});

test("the document is a FHIR document bundle with the composition first", () => {
  const { bundle } = build([
    section("Allergies", "48765-2", [{ resourceType: "AllergyIntolerance", id: "a1" }], "documented"),
    section("Immunizations", "11369-6", [], "never-asked"),
  ]);
  assert.equal(bundle.resourceType, "Bundle");
  assert.equal(bundle.type, "document");
  const entries = bundle.entry as Array<{ resource: Record<string, unknown> }>;
  assert.equal(entries[0].resource.resourceType, "Composition", "a document bundle leads with its composition");
  assert.equal(entries[1].resource.resourceType, "Patient");
  assert.equal(entries[2].resource.resourceType, "AllergyIntolerance");
  // Every section appears, including the empty one: a section omitted is a
  // section a reader never knows was considered.
  const composition = entries[0].resource;
  assert.equal((composition.section as unknown[]).length, 2);
});
