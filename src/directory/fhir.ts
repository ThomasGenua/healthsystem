/**
 * The directory, spoken as FHIR.
 *
 * Parties live in `directory_*` tables because a scheduler slot and a
 * referral need to resolve a person, not parse a resource. The facade still
 * has to serve `Practitioner`, `PractitionerRole`, `Organization`,
 * `Location` and `HealthcareService` — CA:eReC and a patient portal both
 * ask in those types, and answering "we have a directory but not those
 * resources" is answering nothing.
 *
 * Mapping is here, SQL stays in `Directory`. A write that arrives as FHIR
 * is ingested when it can be; one that cannot (wrong type, missing name,
 * a parent nobody registered) is ignored rather than failing the upsert
 * that already succeeded. The directory is a projection of what the
 * system knows, not a gate on what the facade will store.
 */
import {
  Directory,
  type IdentifierRow,
  type LocationRow,
  type OrganizationRow,
  type PartyKind,
  type PractitionerRow,
  type RoleRow,
  type ServiceRow,
} from "./store.ts";

export const DIRECTORY_RESOURCE_TYPES = [
  "Practitioner",
  "PractitionerRole",
  "Organization",
  "Location",
  "HealthcareService",
] as const;

export type DirectoryResourceType = (typeof DIRECTORY_RESOURCE_TYPES)[number];

const KIND_BY_TYPE: Record<Exclude<DirectoryResourceType, "PractitionerRole">, PartyKind> = {
  Practitioner: "practitioner",
  Organization: "organization",
  Location: "location",
  HealthcareService: "service",
};

export function isDirectoryType(type: string): type is DirectoryResourceType {
  return (DIRECTORY_RESOURCE_TYPES as readonly string[]).includes(type);
}

function identifiers(directory: Directory, kind: PartyKind, id: string): Array<{ system: string; value: string }> {
  return directory.identifiersFor(kind, id).map((i: IdentifierRow) => ({ system: i.system, value: i.value }));
}

function active(activeTo: string | null): boolean {
  return activeTo === null;
}

export function practitionerToFhir(directory: Directory, row: PractitionerRow): Record<string, unknown> {
  const name: Record<string, unknown> = { family: row.family };
  if (row.given) name.given = [row.given];
  if (row.prefix) name.prefix = [row.prefix];
  return {
    resourceType: "Practitioner",
    id: row.id,
    identifier: identifiers(directory, "practitioner", row.id),
    name: [name],
    active: active(row.active_to),
  };
}

export function organizationToFhir(directory: Directory, row: OrganizationRow): Record<string, unknown> {
  return {
    resourceType: "Organization",
    id: row.id,
    identifier: identifiers(directory, "organization", row.id),
    name: row.name,
    ...(row.kind ? { type: [{ text: row.kind }] } : {}),
    ...(row.part_of ? { partOf: { reference: `Organization/${row.part_of}` } } : {}),
    active: active(row.active_to),
  };
}

export function locationToFhir(directory: Directory, row: LocationRow): Record<string, unknown> {
  const address: Record<string, unknown> = {};
  if (row.address) address.text = row.address;
  if (row.community) address.city = row.community;
  return {
    resourceType: "Location",
    id: row.id,
    name: row.name,
    ...(Object.keys(address).length ? { address } : {}),
    ...(row.organization_id ? { managingOrganization: { reference: `Organization/${row.organization_id}` } } : {}),
    status: active(row.active_to) ? "active" : "inactive",
  };
}

export function serviceToFhir(directory: Directory, row: ServiceRow): Record<string, unknown> {
  return {
    resourceType: "HealthcareService",
    id: row.id,
    name: row.name,
    ...(row.organization_id ? { providedBy: { reference: `Organization/${row.organization_id}` } } : {}),
    ...(row.location_id ? { location: [{ reference: `Location/${row.location_id}` }] } : {}),
    ...(row.category ? { category: [{ text: row.category }] } : {}),
    active: active(row.active_to),
  };
}

export function roleToFhir(_directory: Directory, row: RoleRow): Record<string, unknown> {
  return {
    resourceType: "PractitionerRole",
    id: row.id,
    practitioner: { reference: `Practitioner/${row.practitioner_id}` },
    ...(row.organization_id ? { organization: { reference: `Organization/${row.organization_id}` } } : {}),
    ...(row.location_id ? { location: [{ reference: `Location/${row.location_id}` }] } : {}),
    ...(row.service_id ? { healthcareService: [{ reference: `HealthcareService/${row.service_id}` }] } : {}),
    code: [{ text: row.role }],
    ...(row.specialty ? { specialty: [{ text: row.specialty }] } : {}),
    active: active(row.active_to),
  };
}

export function directoryGet(directory: Directory, type: string, id: string): Record<string, unknown> | undefined {
  if (type === "Practitioner") {
    const row = directory.practitioner(id);
    return row ? practitionerToFhir(directory, row) : undefined;
  }
  if (type === "Organization") {
    const row = directory.organization(id);
    return row ? organizationToFhir(directory, row) : undefined;
  }
  if (type === "Location") {
    const row = directory.location(id);
    return row ? locationToFhir(directory, row) : undefined;
  }
  if (type === "HealthcareService") {
    const row = directory.service(id);
    return row ? serviceToFhir(directory, row) : undefined;
  }
  if (type === "PractitionerRole") {
    const row = directory.role(id);
    return row ? roleToFhir(directory, row) : undefined;
  }
  return undefined;
}

export function directorySearch(
  directory: Directory,
  type: string,
  opts: { identifier?: string; count?: number } = {}
): { total: number; resources: Array<Record<string, unknown>> } {
  const count = Math.min(Math.max(opts.count ?? 20, 1), 100);
  if (!isDirectoryType(type)) return { total: 0, resources: [] };

  if (opts.identifier) {
    const bar = opts.identifier.indexOf("|");
    const system = bar >= 0 ? opts.identifier.slice(0, bar) : null;
    const value = bar >= 0 ? opts.identifier.slice(bar + 1) : opts.identifier;
    const matches = system
      ? directory.byIdentifier(system, value)
      : (["practitioner", "organization", "location", "service"] as PartyKind[]).flatMap((kind) =>
          directory
            .list(kind, { includeRetired: true, limit: 500 })
            .filter((row) => directory.identifiersFor(kind, String(row.id)).some((i) => i.value === value))
            .map((row) => ({ kind, id: String(row.id) }))
        );
    const resources: Array<Record<string, unknown>> = [];
    if (type === "PractitionerRole") {
      for (const hit of matches) {
        if (hit.kind !== "practitioner") continue;
        for (const role of directory.rolesFor(hit.id, { includeRetired: true })) {
          resources.push(roleToFhir(directory, role));
        }
      }
    } else {
      const want = KIND_BY_TYPE[type];
      for (const hit of matches) {
        if (hit.kind !== want) continue;
        const projected = directoryGet(directory, type, hit.id);
        if (projected) resources.push(projected);
      }
    }
    return { total: resources.length, resources: resources.slice(0, count) };
  }

  if (type === "PractitionerRole") {
    const rows = directory.listRoles({ includeRetired: true, limit: count });
    return { total: directory.countRoles({ includeRetired: true }), resources: rows.map((r) => roleToFhir(directory, r)) };
  }

  const kind = KIND_BY_TYPE[type];
  const rows = directory.list(kind, { includeRetired: true, limit: count });
  const total = directory.count(kind);
  return {
    total,
    resources: rows
      .map((row) => directoryGet(directory, type, String(row.id)))
      .filter((r): r is Record<string, unknown> => r !== undefined),
  };
}

export function directoryCount(directory: Directory, type: string): number {
  if (!isDirectoryType(type)) return 0;
  if (type === "PractitionerRole") return directory.countRoles({ includeRetired: true });
  return directory.count(KIND_BY_TYPE[type]);
}

function firstName(resource: Record<string, unknown>): { family?: string; given?: string; prefix?: string } {
  const names = Array.isArray(resource.name) ? resource.name : [];
  const n = names.find((x): x is Record<string, unknown> => !!x && typeof x === "object") ?? {};
  const given = Array.isArray(n.given) ? n.given.find((g) => typeof g === "string") : undefined;
  const prefix = Array.isArray(n.prefix) ? n.prefix.find((p) => typeof p === "string") : undefined;
  return {
    family: typeof n.family === "string" ? n.family : undefined,
    given: typeof given === "string" ? given : undefined,
    prefix: typeof prefix === "string" ? prefix : undefined,
  };
}

function readIdentifiers(resource: Record<string, unknown>): Array<{ system: string; value: string }> {
  if (!Array.isArray(resource.identifier)) return [];
  return resource.identifier
    .filter((i): i is Record<string, unknown> => !!i && typeof i === "object")
    .map((i) => ({
      system: typeof i.system === "string" ? i.system : "",
      value: typeof i.value === "string" ? i.value : "",
    }))
    .filter((i) => i.system && i.value);
}

function refId(ref: unknown): string | undefined {
  if (!ref || typeof ref !== "object") return undefined;
  const reference = (ref as { reference?: unknown }).reference;
  if (typeof reference !== "string") return undefined;
  const slash = reference.lastIndexOf("/");
  return slash >= 0 ? reference.slice(slash + 1) : reference;
}

/**
 * Copy a facade write into the directory when it names a party.
 *
 * Never throws. A Patient, a half-built Practitioner, a role pointing at
 * nobody — none of those may fail the upsert that already landed. The
 * directory either learns the party or it does not, and the caller of
 * `FhirStore.upsert` does not have to know which.
 */
export function ingestFhir(directory: Directory, resource: Record<string, unknown>): void {
  try {
    ingestFhirInner(directory, resource);
  } catch {
    // Swallow: see the note on the function. The facade write already
    // succeeded; a directory that could not ingest is a gap, not a rollback.
  }
}

function ingestFhirInner(directory: Directory, resource: Record<string, unknown>): void {
  const type = resource.resourceType;
  const id = typeof resource.id === "string" ? resource.id : undefined;
  if (type === "Practitioner") {
    const name = firstName(resource);
    if (!name.family) return;
    if (id && directory.practitioner(id)) {
      for (const ident of readIdentifiers(resource)) directory.addIdentifier("practitioner", id, ident.system, ident.value);
      return;
    }
    directory.addPractitioner({
      ...(id ? { id } : {}),
      family: name.family,
      given: name.given,
      prefix: name.prefix,
      identifiers: readIdentifiers(resource),
    });
    return;
  }
  if (type === "Organization") {
    const name = typeof resource.name === "string" ? resource.name : "";
    if (!name.trim()) return;
    if (id && directory.organization(id)) {
      for (const ident of readIdentifiers(resource)) directory.addIdentifier("organization", id, ident.system, ident.value);
      return;
    }
    const typeText = Array.isArray(resource.type)
      ? resource.type
          .map((t) => (t && typeof t === "object" ? (t as { text?: string }).text : undefined))
          .find((t): t is string => typeof t === "string")
      : undefined;
    directory.addOrganization({
      ...(id ? { id } : {}),
      name,
      kind: typeText,
      partOf: refId(resource.partOf),
      identifiers: readIdentifiers(resource),
    });
    return;
  }
  if (type === "Location") {
    const name = typeof resource.name === "string" ? resource.name : "";
    if (!name.trim()) return;
    if (id && directory.location(id)) return;
    const address = resource.address && typeof resource.address === "object" ? (resource.address as Record<string, unknown>) : undefined;
    directory.addLocation({
      ...(id ? { id } : {}),
      name,
      organizationId: refId(resource.managingOrganization),
      address: typeof address?.text === "string" ? address.text : undefined,
      community: typeof address?.city === "string" ? address.city : undefined,
    });
    return;
  }
  if (type === "HealthcareService") {
    const name = typeof resource.name === "string" ? resource.name : "";
    if (!name.trim()) return;
    if (id && directory.service(id)) return;
    const loc = Array.isArray(resource.location) ? resource.location[0] : undefined;
    const cat = Array.isArray(resource.category)
      ? resource.category
          .map((c) => (c && typeof c === "object" ? (c as { text?: string }).text : undefined))
          .find((t): t is string => typeof t === "string")
      : undefined;
    directory.addService({
      ...(id ? { id } : {}),
      name,
      organizationId: refId(resource.providedBy),
      locationId: refId(loc),
      category: cat,
    });
    return;
  }
  if (type === "PractitionerRole") {
    const practitionerId = refId(resource.practitioner);
    if (!practitionerId) return;
    if (id && directory.role(id)) return;
    const code = Array.isArray(resource.code)
      ? resource.code
          .map((c) => (c && typeof c === "object" ? (c as { text?: string }).text : undefined))
          .find((t): t is string => typeof t === "string")
      : undefined;
    if (!code?.trim()) return;
    const loc = Array.isArray(resource.location) ? resource.location[0] : undefined;
    const svc = Array.isArray(resource.healthcareService) ? resource.healthcareService[0] : undefined;
    const spec = Array.isArray(resource.specialty)
      ? resource.specialty
          .map((c) => (c && typeof c === "object" ? (c as { text?: string }).text : undefined))
          .find((t): t is string => typeof t === "string")
      : undefined;
    directory.assignRole({
      ...(id ? { id } : {}),
      practitionerId,
      role: code,
      organizationId: refId(resource.organization),
      locationId: refId(loc),
      serviceId: refId(svc),
      specialty: spec,
    });
  }
}
