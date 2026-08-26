/**
 * Value set memberships and concept maps, from what publishers actually ship.
 *
 * Concepts already load from a release: `readRf2`, `readLoinc` and the
 * delimited readers take a licensed distribution and put codes in the store.
 * Memberships and mappings did not — they were hand-written pack JSON, which
 * is fine for a fixture and will not survive contact with a real terminology
 * release, where a single value set is thousands of codes revised quarterly.
 *
 * ## The rule this module is built around
 *
 * **A value set that cannot be fully resolved must not import as if it were
 * complete.**
 *
 * FHIR lets a ValueSet be defined intensionally: "every descendant of
 * 73211009 |Diabetes mellitus|". Expanding that needs a terminology server
 * that knows the hierarchy, and this store deliberately does not — it holds
 * codes and displays, not subsumption. A reader that imported the enumerated
 * concepts from such a definition and ignored the filter would produce a
 * value set that is silently *smaller* than the one it claims to be, under
 * the right name, with no error anywhere. Every membership check against it
 * would then quietly fail open or closed depending on which side of the check
 * the code fell.
 *
 * So an intensional definition is **refused**, by name, with what it would
 * have taken to resolve it. A caller that wants it must obtain the expansion
 * from a terminology server and import that instead — which is the supported
 * path, and the one publishers already provide.
 *
 * ## Mappings say how well they map
 *
 * A ConceptMap's `equivalence` is clinical information: `equivalent` and
 * `wider` are not the same claim, and a map that flattened every relationship
 * to "equivalent" would assert a precision the publisher explicitly declined
 * to. It travels. A target of `unmatched` — the publisher saying *this code
 * does not map* — is real information and is deliberately not imported as a
 * mapping to nothing.
 */
import { readRows } from "./delimited.ts";
import type { TerminologyPack } from "../store.ts";

/** Something in a resource this reader will not guess at. */
export interface UnsupportedDefinition {
  what: string;
  reason: string;
}

export interface ValueSetReading {
  /** The pack fragment, ready for `loadPack()`. Absent when refused. */
  pack?: TerminologyPack;
  /** Members read, for reporting before anything is loaded. */
  memberCount: number;
  /**
   * Why this could not be imported, when it could not. A reading with
   * `refused` set has no pack: partial import is the failure mode this
   * module exists to prevent.
   */
  refused?: UnsupportedDefinition[];
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

/** A ValueSet's identity: its `id`, or the tail of its canonical `url`. */
function valueSetId(resource: Record<string, unknown>): string | undefined {
  const id = str(resource.id);
  if (id) return id;
  const url = str(resource.url);
  if (url) return url.split("/").pop();
  return undefined;
}

/**
 * Reads a FHIR ValueSet.
 *
 * Prefers `expansion.contains` when the resource carries one: a server has
 * already done the hierarchy work, and the result is the authoritative
 * membership rather than this module's reading of a definition.
 *
 * Falls back to `compose.include` **only** where every include is a plain
 * enumeration of concepts. One filter, one `valueSet` reference this store
 * cannot follow, or one exclude that is not a plain enumeration, and the
 * whole thing is refused rather than partially imported.
 */
export function readFhirValueSet(resource: unknown): ValueSetReading {
  if (!isObject(resource) || resource.resourceType !== "ValueSet") {
    return { memberCount: 0, refused: [{ what: "resource", reason: "not a FHIR ValueSet" }] };
  }
  const id = valueSetId(resource);
  if (!id) {
    return { memberCount: 0, refused: [{ what: "resource", reason: "no id or url to name the value set by" }] };
  }

  // The expanded form, when the publisher or server supplies it.
  const expansion = resource.expansion;
  if (isObject(expansion) && Array.isArray(expansion.contains)) {
    const bySystem = new Map<string, string[]>();
    const refused: UnsupportedDefinition[] = [];
    let members = 0;
    for (const entry of expansion.contains) {
      if (!isObject(entry)) continue;
      // A nested `contains` is a grouped expansion — a hierarchy in disguise.
      // Reading only the top level would drop its children silently.
      if (Array.isArray(entry.contains) && entry.contains.length > 0) {
        refused.push({
          what: `expansion entry ${str(entry.code) ?? "(no code)"}`,
          reason: "the expansion is grouped (nested `contains`); flattening it here would drop or duplicate members silently",
        });
        continue;
      }
      const system = str(entry.system);
      const code = str(entry.code);
      if (!system || !code) continue;
      const list = bySystem.get(system) ?? [];
      list.push(code);
      bySystem.set(system, list);
      members++;
    }
    if (refused.length > 0) return { memberCount: members, refused };
    return {
      pack: {
        id: `valueset:${id}`,
        ...(str(resource.name) ? { name: str(resource.name)! } : {}),
        valueSets: [{ id, include: [...bySystem].map(([system, codes]) => ({ system, codes })) }],
      },
      memberCount: members,
    };
  }

  const compose = resource.compose;
  if (!isObject(compose) || !Array.isArray(compose.include)) {
    return {
      memberCount: 0,
      refused: [{ what: id, reason: "no expansion and no compose.include; there is nothing to read" }],
    };
  }

  const refused: UnsupportedDefinition[] = [];
  // An exclude of enumerated concepts could in principle be applied, but an
  // exclude by filter cannot, and getting that wrong makes a value set larger
  // than the publisher said. Both are refused: a value set is not the place
  // to be approximately right.
  if (Array.isArray(compose.exclude) && compose.exclude.length > 0) {
    refused.push({
      what: id,
      reason: "compose.exclude is present; this store cannot evaluate exclusions safely, and applying them wrongly would make the value set larger than published",
    });
  }

  const bySystem = new Map<string, string[]>();
  let members = 0;
  for (const [i, include] of compose.include.entries()) {
    if (!isObject(include)) continue;
    if (Array.isArray(include.filter) && include.filter.length > 0) {
      const first = isObject(include.filter[0]) ? include.filter[0] : {};
      refused.push({
        what: `${id} include[${i}]`,
        reason:
          `defined by filter (${str(first.property) ?? "?"} ${str(first.op) ?? "?"} ${str(first.value) ?? "?"}), which needs a ` +
          "terminology server that knows the hierarchy; import a server-produced expansion instead",
      });
      continue;
    }
    if (Array.isArray(include.valueSet) && include.valueSet.length > 0) {
      refused.push({
        what: `${id} include[${i}]`,
        reason: "composed from another value set by reference, which this store cannot follow; import a server-produced expansion instead",
      });
      continue;
    }
    const system = str(include.system);
    if (!system) {
      refused.push({ what: `${id} include[${i}]`, reason: "no system, so its codes cannot be identified" });
      continue;
    }
    if (!Array.isArray(include.concept)) {
      refused.push({
        what: `${id} include[${i}]`,
        reason: `includes the whole of ${system}, which this store does not enumerate; import a server-produced expansion instead`,
      });
      continue;
    }
    const codes: string[] = [];
    for (const c of include.concept) {
      if (!isObject(c)) continue;
      const code = str(c.code);
      if (code) codes.push(code);
    }
    const existing = bySystem.get(system) ?? [];
    bySystem.set(system, [...existing, ...codes]);
    members += codes.length;
  }

  // Any refusal refuses the whole value set. A partially imported one is the
  // failure this module exists to prevent, and it is worse than none: it
  // carries the right name and the wrong membership.
  if (refused.length > 0) return { memberCount: members, refused };

  return {
    pack: {
      id: `valueset:${id}`,
      ...(str(resource.name) ? { name: str(resource.name)! } : {}),
      valueSets: [{ id, include: [...bySystem].map(([system, codes]) => ({ system, codes })) }],
    },
    memberCount: members,
  };
}

export interface ConceptMapReading {
  pack?: TerminologyPack;
  entryCount: number;
  /**
   * Source codes the publisher says do not map. Not an error and not a
   * mapping: a code recorded as unmatched is the publisher answering the
   * question, and translating it to nothing later is the right outcome.
   */
  unmatched: Array<{ system: string; code: string }>;
  refused?: UnsupportedDefinition[];
}

/**
 * Reads a FHIR ConceptMap.
 *
 * `equivalence` (R4) or `relationship` (R5) travels with every entry, because
 * "this SNOMED code is *wider* than that ICD-10 code" is a different clinical
 * claim from "they are equivalent", and a map that flattened the two would
 * assert a precision the publisher declined to.
 */
export function readFhirConceptMap(resource: unknown): ConceptMapReading {
  if (!isObject(resource) || resource.resourceType !== "ConceptMap") {
    return { entryCount: 0, unmatched: [], refused: [{ what: "resource", reason: "not a FHIR ConceptMap" }] };
  }
  const id = str(resource.id) ?? str(resource.url)?.split("/").pop();
  if (!id) {
    return { entryCount: 0, unmatched: [], refused: [{ what: "resource", reason: "no id or url to name the map by" }] };
  }
  const groups = Array.isArray(resource.group) ? resource.group : [];
  if (groups.length === 0) {
    return { entryCount: 0, unmatched: [], refused: [{ what: id, reason: "no group; there is nothing to read" }] };
  }

  const entries: NonNullable<TerminologyPack["conceptMaps"]>[number]["entries"] = [];
  const unmatched: Array<{ system: string; code: string }> = [];
  const refused: UnsupportedDefinition[] = [];

  for (const [gi, group] of groups.entries()) {
    if (!isObject(group)) continue;
    const sourceSystem = str(group.source);
    const targetSystem = str(group.target);
    if (!sourceSystem || !targetSystem) {
      refused.push({
        what: `${id} group[${gi}]`,
        reason: "no source or target system; a mapping between unnamed systems cannot be applied",
      });
      continue;
    }
    const elements = Array.isArray(group.element) ? group.element : [];
    for (const element of elements) {
      if (!isObject(element)) continue;
      const sourceCode = str(element.code);
      if (!sourceCode) continue;
      const targets = Array.isArray(element.target) ? element.target : [];
      if (targets.length === 0) {
        unmatched.push({ system: sourceSystem, code: sourceCode });
        continue;
      }
      for (const target of targets) {
        if (!isObject(target)) continue;
        // R4 spells it `equivalence`, R5 `relationship`. Both are accepted so
        // a deployment is not forced to normalise its publisher's release.
        const equivalence = str(target.equivalence) ?? str(target.relationship);
        const targetCode = str(target.code);
        if (!targetCode) {
          // A target with no code and an `unmatched`/`no-map` equivalence is
          // the publisher stating that this code does not map. Recorded as
          // that, never as a mapping.
          unmatched.push({ system: sourceSystem, code: sourceCode });
          continue;
        }
        entries.push({
          sourceSystem,
          sourceCode,
          targetSystem,
          targetCode,
          ...(str(target.display) ? { targetDisplay: str(target.display)! } : {}),
          ...(equivalence ? { equivalence } : {}),
        });
      }
    }
  }

  if (refused.length > 0) return { entryCount: entries.length, unmatched, refused };
  return {
    pack: { id: `conceptmap:${id}`, conceptMaps: [{ id, entries }] },
    entryCount: entries.length,
    unmatched,
  };
}

/**
 * SNOMED CT RF2 simple refset — the native way a value set ships in a release.
 *
 * `der2_Refset_SimpleSnapshot` is one row per membership: a refset id and the
 * concept in it. Streamed, because a release's refset files are large and a
 * migration that held one in memory would be a migration that fails on the
 * machine it matters on.
 *
 * Inactive rows are skipped by design and not reported: RF2 snapshots carry
 * the full history of membership, and a row with `active = 0` is the release
 * stating that the concept is *not* a member. Dropping it is reading the
 * file correctly, which is why this is the one place skipping is right.
 */
export async function* readRf2SimpleRefset(
  refsetFile: string,
  system = "http://snomed.info/sct"
): AsyncGenerator<{ valueset: string; system: string; code: string }> {
  for await (const row of readRows(refsetFile, "\t")) {
    if (row.active !== "1") continue;
    const valueset = row.refsetId;
    const code = row.referencedComponentId;
    if (!valueset || !code) continue;
    yield { valueset, system, code };
  }
}

/**
 * SNOMED CT RF2 extended map refset — cross-maps such as SNOMED to ICD-10-CA.
 *
 * `mapTarget` empty is the release saying this concept has no target in the
 * target classification, which is an answer rather than a gap, so it is
 * yielded as `unmatched` rather than dropped or mapped to an empty string.
 */
export async function* readRf2ExtendedMap(
  mapFile: string,
  targetSystem: string,
  sourceSystem = "http://snomed.info/sct"
): AsyncGenerator<{
  map: string;
  sourceSystem: string;
  sourceCode: string;
  targetSystem: string;
  targetCode: string | null;
  priority: number;
}> {
  for await (const row of readRows(mapFile, "\t")) {
    if (row.active !== "1") continue;
    const sourceCode = row.referencedComponentId;
    if (!sourceCode) continue;
    const target = row.mapTarget?.trim() ?? "";
    yield {
      map: row.refsetId ?? "unknown",
      sourceSystem,
      sourceCode,
      targetSystem,
      // A rule can legitimately resolve to no target. Null says so; "" would
      // become a code that looks real and matches nothing.
      targetCode: target === "" ? null : target,
      priority: Number.parseInt(row.mapPriority ?? "1", 10) || 1,
    };
  }
}
