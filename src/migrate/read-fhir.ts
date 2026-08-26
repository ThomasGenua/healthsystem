/**
 * Turning an export into records this system can be honest about.
 *
 * The loader in `run.ts` takes normalised records and reconciles what
 * arrives against what the source said it holds. Something has to produce
 * those records from what a site actually hands over, and that step is where
 * the failure this whole module exists to prevent is easiest to commit: a
 * reader that quietly skips what it does not understand produces a clean run
 * of everything it happened to recognise, and the reconciliation then agrees
 * with itself about a number nobody chose.
 *
 * So the rule here is the same one rule, one layer earlier: **nothing is
 * skipped.** A resource this reader cannot turn into a record is returned in
 * `unreadable` with the reason and the resource itself. A resource it can
 * turn into a record but that the stores will refuse — an allergy with no
 * substance, a condition for a chart that was never migrated — becomes a
 * record anyway and is rejected by the loader, where it lands in the reject
 * queue with its payload. Neither path drops anything on the floor.
 *
 * ## Why FHIR
 *
 * Because it is published, and because this repository can check its reading
 * of it. The conformance packs encode PS-CA, CA:FeX and CA:eReC as data, and
 * a bundle read here can be validated against them; a reader for a vendor's
 * CSV could only be validated against my reading of that vendor's
 * documentation, which is exactly the kind of confident guess that shows up
 * as a missing allergy eighteen months later.
 *
 * What that does **not** claim is that every incumbent exports FHIR. Most
 * legacy systems export a database dump, a delimited file, or whatever the
 * vendor's professional services team writes that quarter. This covers the
 * modern export and the provincial repository extract; anything else needs a
 * per-deployment adapter, and the seam for one is `SourceRecord` — produce
 * those and the whole reconciliation applies unchanged. That adapter is a
 * negotiation with a vendor, not something this repository can pretend to
 * ship.
 */
import type { MigrationRecordType, SourceRecord } from "./run.ts";

/** A resource that could not become a record, kept rather than skipped. */
export interface UnreadableResource {
  resourceType: string | null;
  id: string | null;
  reason: string;
  /** The resource as it arrived, so somebody can go and look at it. */
  raw: unknown;
}

export interface ExtractReading {
  records: SourceRecord[];
  unreadable: UnreadableResource[];
  /**
   * What the export says it holds, from the bundle's own `total`. Null when
   * it does not say — which is not a detail: without it the migration can
   * count what arrived and cannot say whether that is all of it.
   */
  declaredTotal: number | null;
  /** Records produced per type, ready to be declared against the source. */
  counts: Partial<Record<MigrationRecordType, number>>;
}

/**
 * FHIR resource types this reader maps, and what they become.
 *
 * A closed list on purpose. Accepting anything and filing it as a note would
 * turn a resource nobody has thought about into a chart entry nobody can
 * interpret, which is worse than being told it was not understood.
 */
const RESOURCE_TO_RECORD: Record<string, MigrationRecordType> = {
  Patient: "patient",
  AllergyIntolerance: "allergy",
  MedicationStatement: "medication",
  MedicationRequest: "medication",
  Condition: "condition",
  Immunization: "immunization",
  Observation: "observation",
  DocumentReference: "note",
};

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

/**
 * The chart a resource belongs to, from whichever reference field carries it.
 *
 * Returns the bare id: `Patient/OLD-1001` is the reference, `OLD-1001` is the
 * chart, and the loader keys on the latter because that is what the patient
 * resource itself was migrated under.
 */
function subjectId(resource: Record<string, unknown>): string | undefined {
  for (const field of ["subject", "patient"]) {
    const ref = resource[field];
    if (!isObject(ref)) continue;
    const reference = str(ref.reference);
    if (reference) return reference.startsWith("Patient/") ? reference.slice("Patient/".length) : reference;
    // A logical reference — an identifier with no URL — is a real thing in
    // exports from systems that do not mint URLs. Take its value.
    const identifier = ref.identifier;
    if (isObject(identifier)) {
      const value = str(identifier.value);
      if (value) return value;
    }
  }
  return undefined;
}

/** The first display text a coded element carries, checked in FHIR's own order. */
function codedDisplay(element: unknown): string | undefined {
  if (!isObject(element)) return undefined;
  const text = str(element.text);
  if (text) return text;
  const coding = element.coding;
  if (Array.isArray(coding)) {
    for (const c of coding) {
      if (!isObject(c)) continue;
      const display = str(c.display);
      if (display) return display;
    }
  }
  return undefined;
}

/** The first code a coded element carries, with its system. */
function codedCode(element: unknown): { code: string; system?: string } | undefined {
  if (!isObject(element)) return undefined;
  const coding = element.coding;
  if (Array.isArray(coding)) {
    for (const c of coding) {
      if (!isObject(c)) continue;
      const code = str(c.code);
      if (code) return { code, ...(str(c.system) ? { system: str(c.system)! } : {}) };
    }
  }
  return undefined;
}

/** When a resource says it happened, from whichever field its type uses. */
function effectiveAt(resource: Record<string, unknown>): string | undefined {
  for (const field of ["effectiveDateTime", "onsetDateTime", "occurrenceDateTime", "recordedDate", "date"]) {
    const value = str(resource[field]);
    if (value) return value;
  }
  const period = resource.effectivePeriod;
  if (isObject(period)) {
    const start = str(period.start);
    if (start) return start;
  }
  return undefined;
}

/**
 * The source system's own codes, carried through rather than replaced.
 *
 * A migrated record that cannot be traced back to the row it came from cannot
 * be checked against the source system, and checking against the source
 * system is the only way anybody ever finds a mapping error.
 */
function sourceCodes(resource: Record<string, unknown>): Record<string, string> | undefined {
  const codes: Record<string, string> = {};
  const identifiers = resource.identifier;
  if (Array.isArray(identifiers)) {
    for (const [i, id] of identifiers.entries()) {
      if (!isObject(id)) continue;
      const value = str(id.value);
      if (!value) continue;
      codes[str(id.system) ?? `identifier${i > 0 ? i : ""}`] = value;
    }
  }
  const coded = codedCode(resource.code) ?? codedCode(resource.vaccineCode) ?? codedCode(resource.medicationCodeableConcept);
  if (coded) {
    codes[coded.system ?? "code"] = coded.code;
  }
  return Object.keys(codes).length > 0 ? codes : undefined;
}

/** Builds the `content` the loader expects for one record type. */
function contentFor(
  recordType: MigrationRecordType,
  resource: Record<string, unknown>
): Record<string, unknown> {
  if (recordType === "patient") {
    return {
      id: str(resource.id),
      ...(resource.identifier ? { identifier: resource.identifier } : {}),
      ...(resource.name ? { name: resource.name } : {}),
      ...(str(resource.birthDate) ? { birthDate: str(resource.birthDate) } : {}),
      ...(str(resource.gender) ? { gender: str(resource.gender) } : {}),
      ...(resource.address ? { address: resource.address } : {}),
    };
  }

  if (recordType === "allergy") {
    // No display means the loader refuses it — "an allergy needs a substance;
    // an unnamed one cannot be checked against a prescription" — and it lands
    // in the reject queue rather than being invented here.
    const display = codedDisplay(resource.code);
    const reaction = Array.isArray(resource.reaction) && isObject(resource.reaction[0])
      ? codedDisplay((resource.reaction[0] as Record<string, unknown>).manifestation) ??
        (Array.isArray((resource.reaction[0] as Record<string, unknown>).manifestation)
          ? codedDisplay(((resource.reaction[0] as Record<string, unknown>).manifestation as unknown[])[0])
          : undefined)
      : undefined;
    const criticality = str(resource.criticality);
    return {
      ...(display ? { display } : {}),
      ...(reaction ? { reaction } : {}),
      // FHIR's `criticality` is low | high | unable-to-assess; the store takes
      // the first two and treats anything else as unstated, which is the
      // honest reading of "unable to assess".
      ...(criticality === "high" || criticality === "low" ? { criticality } : {}),
    };
  }

  if (recordType === "medication") {
    const coded = codedCode(resource.medicationCodeableConcept);
    const display = codedDisplay(resource.medicationCodeableConcept);
    const dosage = Array.isArray(resource.dosage) ? resource.dosage[0] : undefined;
    const dosageText = isObject(dosage) ? str(dosage.text) : undefined;
    return {
      ...(coded ? { code: coded.code } : {}),
      ...(display ? { display } : {}),
      // The instruction line as written, not parsed into dose and frequency.
      // Splitting "one twice daily with food" into fields is a guess, and a
      // guess about a dose is the wrong place to be clever.
      ...(dosageText ? { dose: dosageText } : {}),
      ...(str(resource.status) ? { sourceStatus: str(resource.status) } : {}),
    };
  }

  // Condition, Immunization, Observation and DocumentReference keep their
  // resource as the content. The clinical record stores them whole, and
  // narrowing them here would discard the parts nobody has needed yet.
  const when = effectiveAt(resource);
  const { resourceType: _drop, ...rest } = resource;
  return { ...rest, ...(when ? { effectiveAt: when } : {}) };
}

/**
 * Reads one FHIR resource into a record, or explains why it cannot.
 *
 * Returns `null` for the unreadable case so the caller records it; there is
 * no third outcome, because a resource that is neither read nor reported is
 * a resource that silently did not migrate.
 */
function readResource(resource: unknown): SourceRecord | UnreadableResource {
  if (!isObject(resource)) {
    return { resourceType: null, id: null, reason: "not a FHIR resource object", raw: resource };
  }
  const resourceType = str(resource.resourceType);
  if (!resourceType) {
    return { resourceType: null, id: str(resource.id) ?? null, reason: "no resourceType", raw: resource };
  }
  const recordType = RESOURCE_TO_RECORD[resourceType];
  if (!recordType) {
    return {
      resourceType,
      id: str(resource.id) ?? null,
      reason: `this reader does not map ${resourceType}; it is reported rather than skipped so somebody decides what it should become`,
      raw: resource,
    };
  }
  const id = str(resource.id);
  if (!id) {
    // Without a stable source id there is nothing to make a re-run idempotent
    // against, so a resumed migration would load it a second time.
    return {
      resourceType,
      id: null,
      reason: "no id; a record with no stable source key cannot be loaded idempotently",
      raw: resource,
    };
  }

  const codes = sourceCodes(resource);
  const subject = recordType === "patient" ? undefined : subjectId(resource);
  return {
    sourceId: id,
    recordType,
    ...(subject ? { sourcePatientId: subject } : {}),
    content: contentFor(recordType, resource),
    ...(codes ? { sourceCodes: codes } : {}),
  };
}

function isUnreadable(v: SourceRecord | UnreadableResource): v is UnreadableResource {
  return "reason" in v;
}

function collect(resources: unknown[], declaredTotal: number | null): ExtractReading {
  const records: SourceRecord[] = [];
  const unreadable: UnreadableResource[] = [];
  const counts: Partial<Record<MigrationRecordType, number>> = {};
  for (const resource of resources) {
    const read = readResource(resource);
    if (isUnreadable(read)) {
      unreadable.push(read);
      continue;
    }
    records.push(read);
    counts[read.recordType] = (counts[read.recordType] ?? 0) + 1;
  }
  // Patients first, whatever order the export used. Everything else is
  // refused against a chart that does not exist yet, and an export that
  // happened to list an allergy before its patient would otherwise reconcile
  // as a pile of rejections that are really one ordering problem.
  records.sort((a, b) => (a.recordType === "patient" ? 0 : 1) - (b.recordType === "patient" ? 0 : 1));
  return { records, unreadable, declaredTotal, counts };
}

/**
 * Reads a FHIR Bundle.
 *
 * `total` is taken as the source's own declaration of size where the bundle
 * carries one. It is not inferred from the entries, because a count derived
 * from what arrived cannot disagree with what arrived, and a number that
 * cannot disagree proves nothing.
 */
export function readFhirBundle(bundle: unknown): ExtractReading {
  if (!isObject(bundle) || bundle.resourceType !== "Bundle") {
    return {
      records: [],
      unreadable: [{ resourceType: null, id: null, reason: "not a FHIR Bundle", raw: bundle }],
      declaredTotal: null,
      counts: {},
    };
  }
  const entries = Array.isArray(bundle.entry) ? bundle.entry : [];
  const resources = entries.map((e) => (isObject(e) && "resource" in e ? e.resource : e));
  const total = typeof bundle.total === "number" && Number.isInteger(bundle.total) ? bundle.total : null;
  return collect(resources, total);
}

/**
 * Reads newline-delimited JSON, the shape a bulk export arrives in.
 *
 * A line that will not parse is unreadable rather than fatal: one corrupt
 * line in a two-gigabyte export should cost that line, not the migration.
 */
export function readFhirNdjson(text: string): ExtractReading {
  const resources: unknown[] = [];
  const broken: UnreadableResource[] = [];
  for (const [i, line] of text.split("\n").entries()) {
    if (!line.trim()) continue;
    try {
      resources.push(JSON.parse(line));
    } catch (err) {
      broken.push({
        resourceType: null,
        id: null,
        reason: `line ${i + 1} is not JSON: ${err instanceof Error ? err.message : String(err)}`,
        raw: line,
      });
    }
  }
  // NDJSON carries no total. That is a real gap and it is reported as one
  // rather than filled in from the line count.
  const reading = collect(resources, null);
  return { ...reading, unreadable: [...broken, ...reading.unreadable] };
}
