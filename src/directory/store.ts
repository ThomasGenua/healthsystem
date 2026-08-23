/**
 * Who and what the system talks about.
 *
 * A scheduler slot named `dr-tetso`. A referral to "Stanton Orthopaedics". A
 * visit whose participant is the string an API key happened to carry. None of
 * these resolved to anything: the system could not say whether that person
 * existed, was licensed, worked here, or was the same `dr-tetso` who received
 * a referral last week — and a name is not an identity, which is exactly why
 * `withhold-from-organization` could never be enforced (#17).
 *
 * Three positions, each of which was a choice:
 *
 * **Organization is not tenancy.** Several organizations operate inside one
 * custodian's tenant. Conflating them would make a directive withholding a
 * record from one clinic withhold it from the whole territory, which is the
 * deployment that most needs the distinction.
 *
 * **Nothing is deleted.** A clinic that closes must not break the referral
 * sent to it in 2024, and a practitioner who leaves must not vanish from the
 * visits they attended. Entries are effective-dated: `retire()` sets
 * `active_to`, and history keeps resolving afterwards.
 *
 * **Resolution is honest rather than fatal.** `resolve()` answers for any
 * reference, including one that predates this module, and says plainly when it
 * cannot find the party. That is what lets a deployment adopt a directory
 * without a flag day: existing slots and referrals keep working and report
 * themselves as unregistered, rather than a migration that refuses to start
 * until somebody has typed in four hundred clinicians. A caller that wants the
 * strong guarantee passes a typed reference, which *is* validated on write —
 * see `Schedule.openSlot`.
 *
 * What this is deliberately not: a client for an authoritative provincial
 * directory. This is the local registry a deployment maintains. Syncing it
 * from a provincial source is a separate question, and one that should not be
 * designed around before the local shape has settled.
 */
import { randomUUID } from "node:crypto";
import type { Db } from "../db.ts";
import { Refusal } from "../core/refusal.ts";

export type PartyKind = "practitioner" | "organization" | "location" | "service";

const KINDS: readonly PartyKind[] = ["practitioner", "organization", "location", "service"];

/** The table each kind lives in. One place, so a kind added later cannot be
 * half-wired: a `PartyKind` with no row here fails to compile. */
const TABLES: Record<PartyKind, string> = {
  practitioner: "directory_practitioners",
  organization: "directory_organizations",
  location: "directory_locations",
  service: "directory_services",
};

export interface PractitionerRow {
  tenant_id: string;
  id: string;
  family: string;
  given: string | null;
  prefix: string | null;
  active_from: string;
  active_to: string | null;
  created_at: string;
}

export interface OrganizationRow {
  tenant_id: string;
  id: string;
  name: string;
  kind: string | null;
  part_of: string | null;
  active_from: string;
  active_to: string | null;
  created_at: string;
}

export interface LocationRow {
  tenant_id: string;
  id: string;
  name: string;
  organization_id: string | null;
  address: string | null;
  community: string | null;
  active_from: string;
  active_to: string | null;
  created_at: string;
}

export interface ServiceRow {
  tenant_id: string;
  id: string;
  name: string;
  organization_id: string | null;
  location_id: string | null;
  category: string | null;
  active_from: string;
  active_to: string | null;
  created_at: string;
}

export interface RoleRow {
  tenant_id: string;
  id: string;
  practitioner_id: string;
  organization_id: string | null;
  location_id: string | null;
  service_id: string | null;
  role: string;
  specialty: string | null;
  active_from: string;
  active_to: string | null;
  created_at: string;
}

export interface IdentifierRow {
  tenant_id: string;
  party_kind: PartyKind;
  party_id: string;
  system: string;
  value: string;
}

/**
 * What a reference turned out to name.
 *
 * `known: false` is a real answer and not an error. A slot created before this
 * module existed names a resource nobody registered, and the honest report of
 * that is "this is what the row says, and the directory does not know it" —
 * not a blank, and not a crash.
 */
export type Resolution =
  | { known: true; kind: PartyKind; id: string; display: string; active: boolean; retiredAt?: string }
  | { known: false; kind: PartyKind; id: string; display: string };

/** Thrown when a typed reference names a party the directory does not have. */
export class UnknownParty extends Refusal {
  constructor(message: string) {
    super(message, 400);
    this.name = "UnknownParty";
  }
}

function displayOf(kind: PartyKind, row: Record<string, unknown>): string {
  if (kind === "practitioner") {
    const p = row as unknown as PractitionerRow;
    return [p.prefix, p.given, p.family].filter(Boolean).join(" ");
  }
  return String((row as { name?: string }).name ?? "");
}

export class Directory {
  private db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  // ---- registering -------------------------------------------------------

  addPractitioner(input: {
    family: string;
    given?: string;
    prefix?: string;
    id?: string;
    activeFrom?: string;
    identifiers?: Array<{ system: string; value: string }>;
  }): PractitionerRow {
    if (!input.family.trim()) throw new Error("a practitioner needs a family name");
    const id = input.id ?? randomUUID();
    const now = new Date().toISOString();
    this.db.sql
      .prepare(
        `INSERT INTO directory_practitioners
           (tenant_id, id, family, given, prefix, active_from, active_to, created_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`
      )
      .run(this.db.tenantId, id, input.family, input.given ?? null, input.prefix ?? null, input.activeFrom ?? now, now);
    for (const i of input.identifiers ?? []) this.addIdentifier("practitioner", id, i.system, i.value);
    return this.practitioner(id)!;
  }

  addOrganization(input: {
    name: string;
    kind?: string;
    partOf?: string;
    id?: string;
    activeFrom?: string;
    identifiers?: Array<{ system: string; value: string }>;
  }): OrganizationRow {
    if (!input.name.trim()) throw new Error("an organization needs a name");
    // A hierarchy that points at nothing is the same dangling reference this
    // module exists to remove, so the parent is checked rather than trusted.
    if (input.partOf) this.require("organization", input.partOf);
    const id = input.id ?? randomUUID();
    const now = new Date().toISOString();
    this.db.sql
      .prepare(
        `INSERT INTO directory_organizations
           (tenant_id, id, name, kind, part_of, active_from, active_to, created_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`
      )
      .run(this.db.tenantId, id, input.name, input.kind ?? null, input.partOf ?? null, input.activeFrom ?? now, now);
    for (const i of input.identifiers ?? []) this.addIdentifier("organization", id, i.system, i.value);
    return this.organization(id)!;
  }

  addLocation(input: {
    name: string;
    organizationId?: string;
    address?: string;
    community?: string;
    id?: string;
    activeFrom?: string;
  }): LocationRow {
    if (!input.name.trim()) throw new Error("a location needs a name");
    if (input.organizationId) this.require("organization", input.organizationId);
    const id = input.id ?? randomUUID();
    const now = new Date().toISOString();
    this.db.sql
      .prepare(
        `INSERT INTO directory_locations
           (tenant_id, id, name, organization_id, address, community, active_from, active_to, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`
      )
      .run(
        this.db.tenantId,
        id,
        input.name,
        input.organizationId ?? null,
        input.address ?? null,
        input.community ?? null,
        input.activeFrom ?? now,
        now
      );
    return this.location(id)!;
  }

  addService(input: {
    name: string;
    organizationId?: string;
    locationId?: string;
    category?: string;
    id?: string;
    activeFrom?: string;
  }): ServiceRow {
    if (!input.name.trim()) throw new Error("a service needs a name");
    if (input.organizationId) this.require("organization", input.organizationId);
    if (input.locationId) this.require("location", input.locationId);
    const id = input.id ?? randomUUID();
    const now = new Date().toISOString();
    this.db.sql
      .prepare(
        `INSERT INTO directory_services
           (tenant_id, id, name, organization_id, location_id, category, active_from, active_to, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`
      )
      .run(
        this.db.tenantId,
        id,
        input.name,
        input.organizationId ?? null,
        input.locationId ?? null,
        input.category ?? null,
        input.activeFrom ?? now,
        now
      );
    return this.service(id)!;
  }

  /**
   * What a practitioner does, where, and for whom.
   *
   * Separate from the practitioner because one person holds several. A locum
   * covering two clinics is one practitioner and two roles, and a single
   * `organization_id` on the practitioner would lose which hat they were
   * wearing — which is the question #17 has to answer to enforce a directive
   * against one organization and not another.
   */
  assignRole(input: {
    practitionerId: string;
    role: string;
    organizationId?: string;
    locationId?: string;
    serviceId?: string;
    specialty?: string;
    id?: string;
    activeFrom?: string;
  }): RoleRow {
    this.require("practitioner", input.practitionerId);
    if (input.organizationId) this.require("organization", input.organizationId);
    if (input.locationId) this.require("location", input.locationId);
    if (input.serviceId) this.require("service", input.serviceId);
    if (!input.role.trim()) throw new Error("a role needs to say what it is");
    const id = input.id ?? randomUUID();
    const now = new Date().toISOString();
    this.db.sql
      .prepare(
        `INSERT INTO directory_roles
           (tenant_id, id, practitioner_id, organization_id, location_id, service_id, role,
            specialty, active_from, active_to, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`
      )
      .run(
        this.db.tenantId,
        id,
        input.practitionerId,
        input.organizationId ?? null,
        input.locationId ?? null,
        input.serviceId ?? null,
        input.role,
        input.specialty ?? null,
        input.activeFrom ?? now,
        now
      );
    return this.role(id)!;
  }

  addIdentifier(kind: PartyKind, partyId: string, system: string, value: string): IdentifierRow {
    this.require(kind, partyId);
    if (!system.trim() || !value.trim()) throw new Error("an identifier needs both a system and a value");
    this.db.sql
      .prepare(
        `INSERT INTO directory_identifiers (tenant_id, party_kind, party_id, system, value)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(tenant_id, party_kind, party_id, system, value) DO NOTHING`
      )
      .run(this.db.tenantId, kind, partyId, system, value);
    return { tenant_id: this.db.tenantId, party_kind: kind, party_id: partyId, system, value };
  }

  // ---- retiring ----------------------------------------------------------

  /**
   * Takes an entry out of use without removing it.
   *
   * The referral sent to this clinic in 2024 still has to resolve, so the row
   * stays and grows an end date. `resolve()` afterwards reports it as known
   * and inactive, which is a different and more useful answer than either
   * "gone" or "current".
   */
  retire(kind: PartyKind, id: string, at?: string): void {
    this.require(kind, id);
    this.db.sql
      .prepare(`UPDATE ${TABLES[kind]} SET active_to = ? WHERE tenant_id = ? AND id = ?`)
      .run(at ?? new Date().toISOString(), this.db.tenantId, id);
  }

  // ---- reading -----------------------------------------------------------

  /**
   * What a reference names, whether or not the directory has it.
   *
   * The read half of the contract, and the reason a deployment can adopt this
   * incrementally. A slot created before the directory existed names a
   * resource nobody registered; this reports exactly that rather than a blank
   * that reads as "no clinician" or an exception that takes the diary down.
   */
  resolve(kind: PartyKind, id: string): Resolution {
    const row = this.db.sql
      .prepare(`SELECT * FROM ${TABLES[kind]} WHERE tenant_id = ? AND id = ?`)
      .get(this.db.tenantId, id) as unknown as Record<string, unknown> | undefined;
    if (!row) return { known: false, kind, id, display: id };
    const activeTo = row.active_to as string | null;
    return {
      known: true,
      kind,
      id,
      display: displayOf(kind, row),
      active: activeTo === null,
      ...(activeTo ? { retiredAt: activeTo } : {}),
    };
  }

  /** Resolves or throws. What a typed reference on a write goes through. */
  require(kind: PartyKind, id: string): Resolution & { known: true } {
    const r = this.resolve(kind, id);
    if (!r.known) throw new UnknownParty(`no ${kind} ${id} in the directory`);
    return r;
  }

  /** The party carrying an identifier — the join a credential will use (#17). */
  byIdentifier(system: string, value: string): Array<{ kind: PartyKind; id: string }> {
    return (
      this.db.sql
        .prepare("SELECT party_kind, party_id FROM directory_identifiers WHERE tenant_id = ? AND system = ? AND value = ?")
        .all(this.db.tenantId, system, value) as unknown as Array<{ party_kind: PartyKind; party_id: string }>
    ).map((r) => ({ kind: r.party_kind, id: r.party_id }));
  }

  identifiersFor(kind: PartyKind, id: string): IdentifierRow[] {
    return this.db.sql
      .prepare("SELECT * FROM directory_identifiers WHERE tenant_id = ? AND party_kind = ? AND party_id = ? ORDER BY system, value")
      .all(this.db.tenantId, kind, id) as unknown as IdentifierRow[];
  }

  practitioner(id: string): PractitionerRow | undefined {
    return this.db.sql
      .prepare("SELECT * FROM directory_practitioners WHERE tenant_id = ? AND id = ?")
      .get(this.db.tenantId, id) as unknown as PractitionerRow | undefined;
  }

  organization(id: string): OrganizationRow | undefined {
    return this.db.sql
      .prepare("SELECT * FROM directory_organizations WHERE tenant_id = ? AND id = ?")
      .get(this.db.tenantId, id) as unknown as OrganizationRow | undefined;
  }

  location(id: string): LocationRow | undefined {
    return this.db.sql
      .prepare("SELECT * FROM directory_locations WHERE tenant_id = ? AND id = ?")
      .get(this.db.tenantId, id) as unknown as LocationRow | undefined;
  }

  service(id: string): ServiceRow | undefined {
    return this.db.sql
      .prepare("SELECT * FROM directory_services WHERE tenant_id = ? AND id = ?")
      .get(this.db.tenantId, id) as unknown as ServiceRow | undefined;
  }

  role(id: string): RoleRow | undefined {
    return this.db.sql
      .prepare("SELECT * FROM directory_roles WHERE tenant_id = ? AND id = ?")
      .get(this.db.tenantId, id) as unknown as RoleRow | undefined;
  }

  /** Every role a practitioner holds. Retired ones are excluded by default,
   * and included for the review that asks who was working here in March. */
  rolesFor(practitionerId: string, opts: { includeRetired?: boolean } = {}): RoleRow[] {
    return this.db.sql
      .prepare(
        `SELECT * FROM directory_roles
          WHERE tenant_id = ? AND practitioner_id = ?${opts.includeRetired ? "" : " AND active_to IS NULL"}
          ORDER BY active_from`
      )
      .all(this.db.tenantId, practitionerId) as unknown as RoleRow[];
  }

  /**
   * The organizations a practitioner currently acts for.
   *
   * The question #17 has to answer per request. A practitioner with no role is
   * not "in no organization" — they are a party whose affiliation nobody
   * recorded, and the caller must treat that as unknown rather than as an
   * empty set that happens to match nothing.
   */
  organizationsFor(practitionerId: string): string[] {
    return [
      ...new Set(
        this.rolesFor(practitionerId)
          .map((r) => r.organization_id)
          .filter((o): o is string => o !== null)
      ),
    ];
  }

  /** Every role this tenant has recorded. Retired ones are excluded by default. */
  listRoles(opts: { includeRetired?: boolean; limit?: number } = {}): RoleRow[] {
    return this.db.sql
      .prepare(
        `SELECT * FROM directory_roles
          WHERE tenant_id = ?${opts.includeRetired ? "" : " AND active_to IS NULL"}
          ORDER BY created_at LIMIT ?`
      )
      .all(this.db.tenantId, opts.limit ?? 200) as unknown as RoleRow[];
  }

  list(kind: PartyKind, opts: { includeRetired?: boolean; limit?: number } = {}): Array<Record<string, unknown>> {
    return this.db.sql
      .prepare(
        `SELECT * FROM ${TABLES[kind]}
          WHERE tenant_id = ?${opts.includeRetired ? "" : " AND active_to IS NULL"}
          ORDER BY created_at LIMIT ?`
      )
      .all(this.db.tenantId, opts.limit ?? 200) as unknown as Array<Record<string, unknown>>;
  }

  countRoles(opts: { includeRetired?: boolean } = {}): number {
    const r = this.db.sql
      .prepare(
        `SELECT COUNT(*) AS n FROM directory_roles
          WHERE tenant_id = ?${opts.includeRetired ? "" : " AND active_to IS NULL"}`
      )
      .get(this.db.tenantId) as unknown as { n: number };
    return r.n;
  }

  /** How many entries of a kind this tenant has. Used by callers deciding
   * whether the directory has been adopted at all. */
  count(kind: PartyKind): number {
    const r = this.db.sql
      .prepare(`SELECT COUNT(*) AS n FROM ${TABLES[kind]} WHERE tenant_id = ?`)
      .get(this.db.tenantId) as unknown as { n: number };
    return r.n;
  }
}

export { KINDS as DIRECTORY_KINDS };
