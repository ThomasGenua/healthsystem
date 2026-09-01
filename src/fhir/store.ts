/**
 * FHIR facade store. Channels route resources here through the "fhirstore"
 * destination; the admin API serves them back as an R4 read and search
 * endpoint. Versioning is content-addressed: an upsert that changes nothing
 * keeps its versionId, a changed body increments it. Resources without an id
 * get a deterministic one derived from their first identifier, so repeated
 * ADT updates converge on one Patient instead of minting duplicates.
 */
import { createHash, randomUUID } from "node:crypto";
import type { Db } from "../db.ts";
import { validateResource, type ConformanceRegistry } from "../conformance/validator.ts";
import type { TerminologyStore } from "../terminology/store.ts";
import type { ConformanceIssue } from "../types.ts";
import { Directory } from "../directory/store.ts";
import {
  DIRECTORY_RESOURCE_TYPES,
  directoryCount,
  directoryGet,
  directorySearch,
  isDirectoryType,
} from "../directory/fhir.ts";

export interface FhirUpsertResult {
  resourceType: string;
  id: string;
  versionId: number;
  created: boolean;
  changed: boolean;
  /** Conformance issues found at write time. Only present in annotate mode. */
  issues?: ConformanceIssue[];
}

/** Which pack to enforce on a write, and whether a failure blocks it. */
export interface FacadeValidation {
  pack?: string;
  mode?: "reject" | "annotate";
}

/**
 * What the store needs to validate. Supplied by the Engine, which owns the
 * registry and the terminology store.
 */
export interface ValidationContext {
  conformance: ConformanceRegistry;
  terminology?: TerminologyStore;
  /** Applied to every write that does not name its own pack. */
  defaultPack?: string;
  defaultMode?: "reject" | "annotate";
}

export interface FhirSearchResult {
  total: number;
  resources: Array<Record<string, unknown>>;
}

/** Types the facade always advertises, whether or not any are stored yet. */
export const CORE_RESOURCE_TYPES = [
  "Patient",
  "Condition",
  "Observation",
  "MedicationRequest",
  ...DIRECTORY_RESOURCE_TYPES,
];

interface Identifier {
  system?: string;
  value?: string;
}

export class FhirStore {
  private db: Db;
  private listeners: Array<(result: FhirUpsertResult, resource: Record<string, unknown>) => void> = [];
  private validation?: ValidationContext;
  private directory?: Directory;

  constructor(db: Db, validation?: ValidationContext, directory?: Directory) {
    this.db = db;
    this.validation = validation;
    this.directory = directory;
  }

  /** Register a change listener, fired after every created or updated upsert. */
  onChange(fn: (result: FhirUpsertResult, resource: Record<string, unknown>) => void): void {
    this.listeners.push(fn);
  }

  upsert(resource: Record<string, unknown>, validate?: FacadeValidation): FhirUpsertResult {
    const type = resource.resourceType;
    if (typeof type !== "string" || !/^[A-Z][A-Za-z]{1,63}$/.test(type)) {
      throw new Error("FHIR resource requires a valid resourceType");
    }
    const idents = readIdentifiers(resource);
    const id =
      typeof resource.id === "string" && /^[A-Za-z0-9.-]{1,64}$/.test(resource.id)
        ? resource.id
        : deriveId(type, idents);

    const body: Record<string, unknown> = { ...resource, id };

    // Validation gates the write, so it must run before anything touches the
    // database — ahead of the unchanged-content short circuit below, not just
    // ahead of the INSERT. A rejected resource is never stored, which is what
    // makes a retry honest: the same delivery re-validates from scratch
    // instead of finding its own earlier write already sitting there.
    const issues = this.runValidation(body, validate);

    const hash = createHash("sha256").update(canonical(stripVolatileMeta(body))).digest("hex");

    const existing = this.db.sql
      .prepare("SELECT version_id, hash FROM fhir_resources WHERE tenant_id = ? AND resource_type = ? AND id = ?")
      .get(this.db.tenantId, type, id) as { version_id: number; hash: string } | undefined;

    if (existing && existing.hash === hash) {
      return {
        resourceType: type,
        id,
        versionId: existing.version_id,
        created: false,
        changed: false,
        ...(issues.length ? { issues } : {}),
      };
    }

    const versionId = existing ? existing.version_id + 1 : 1;
    const meta = (body.meta && typeof body.meta === "object" ? body.meta : {}) as Record<string, unknown>;
    body.meta = { ...meta, versionId: String(versionId), lastUpdated: new Date().toISOString() };

    this.db.sql
      .prepare(
        `INSERT INTO fhir_resources (tenant_id, resource_type, id, version_id, json, hash, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(tenant_id, resource_type, id) DO UPDATE SET
           version_id = excluded.version_id, json = excluded.json,
           hash = excluded.hash, updated_at = datetime('now')`
      )
      .run(this.db.tenantId, type, id, versionId, JSON.stringify(body), hash);

    this.db.sql
      .prepare("DELETE FROM fhir_identifiers WHERE tenant_id = ? AND resource_type = ? AND id = ?")
      .run(this.db.tenantId, type, id);
    const ins = this.db.sql.prepare(
      "INSERT OR IGNORE INTO fhir_identifiers (tenant_id, resource_type, id, system, value) VALUES (?, ?, ?, ?, ?)"
    );
    for (const ident of idents) {
      if (ident.value) ins.run(this.db.tenantId, type, id, ident.system ?? "", ident.value);
    }

    const result: FhirUpsertResult = {
      resourceType: type,
      id,
      versionId,
      created: !existing,
      changed: true,
      ...(issues.length ? { issues } : {}),
    };
    // Listeners (today: rest-hook subscription notification) only ever see
    // resources that passed validation and actually persisted.
    for (const fn of this.listeners) fn(result, body);
    return result;
  }

  /**
   * Runs the configured conformance pack against a resource about to be
   * written. Throws in reject mode; returns the issues in annotate mode.
   *
   * This deliberately re-checks resources a channel pipeline may already have
   * validated. The pipeline runs at ingest; the write happens later off the
   * delivery queue — 250ms later normally, but hours later for a retried or
   * replayed delivery, by which time a pack may have been tightened. This is
   * the check that reflects the rules in force when the data actually lands.
   */
  private runValidation(resource: Record<string, unknown>, validate?: FacadeValidation): ConformanceIssue[] {
    const ctx = this.validation;
    if (!ctx) return [];
    const packId = validate?.pack ?? ctx.defaultPack;
    if (!packId) return [];

    const pack = ctx.conformance.get(packId);
    if (!pack) throw new Error(`Unknown conformance pack: ${packId}`);

    const issues = validateResource(pack, resource, ctx.terminology);
    const errors = issues.filter((i) => i.severity === "error");
    const mode = validate?.mode ?? ctx.defaultMode ?? "reject";
    if (mode === "reject" && errors.length > 0) {
      const more = errors.length > 1 ? ` (+${errors.length - 1} more)` : "";
      throw new Error(`Conformance ${packId}: ${errors[0].message}${more}`);
    }
    return issues;
  }

  get(type: string, id: string): Record<string, unknown> | undefined {
    if (this.directory && isDirectoryType(type)) {
      const projected = directoryGet(this.directory, type, id);
      if (projected) return projected;
    }
    const row = this.db.sql
      .prepare("SELECT json FROM fhir_resources WHERE tenant_id = ? AND resource_type = ? AND id = ?")
      .get(this.db.tenantId, type, id) as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as Record<string, unknown>) : undefined;
  }

  /** Search by identifier token ("system|value" or bare "value"). */
  search(type: string, opts: { identifier?: string; count?: number; offset?: number } = {}): FhirSearchResult {
    const count = Math.min(Math.max(opts.count ?? 20, 1), 100);
    const offset = Math.max(Math.trunc(opts.offset ?? 0), 0);
    const stored = this.searchStored(type, opts, count, offset);
    if (!this.directory || !isDirectoryType(type)) return stored;
    // The directory projection has no offset of its own, so a page past the
    // first is taken by over-fetching and slicing. Honest and bounded: count
    // is capped at 100, so the widest fetch is offset + 100 rows.
    const projected = directorySearch(this.directory, type, { identifier: opts.identifier, count: count + offset });
    const seen = new Set(projected.resources.map((r) => String((r as { id?: unknown }).id ?? "")));
    const extra = stored.resources.filter((r) => !seen.has(String((r as { id?: unknown }).id ?? "")));
    return {
      total: projected.total + extra.length,
      resources: [...projected.resources.slice(offset), ...extra].slice(0, count),
    };
  }

  /**
   * One page of stored resources.
   *
   * The ordering carries a tiebreak on id, and that is load-bearing rather
   * than tidy. `updated_at` has second granularity, so a bulk load writes
   * dozens of resources with identical timestamps; an unbroken tie orders
   * arbitrarily, and SQLite is free to order it differently between two
   * queries. Paging through that skips resources and repeats others, and a
   * client reading a patient's observations would silently miss some.
   */
  private searchStored(
    type: string,
    opts: { identifier?: string; count?: number },
    count: number,
    offset: number
  ): FhirSearchResult {
    if (opts.identifier) {
      const bar = opts.identifier.indexOf("|");
      const system = bar >= 0 ? opts.identifier.slice(0, bar) : null;
      const value = bar >= 0 ? opts.identifier.slice(bar + 1) : opts.identifier;
      // The tenant sits in the statement rather than in the interpolated
      // fragment, so the scope is visible where the query is read.
      const where = system ? "i.resource_type = ? AND i.value = ? AND i.system = ?" : "i.resource_type = ? AND i.value = ?";
      const args = system ? [this.db.tenantId, type, value, system] : [this.db.tenantId, type, value];
      const total = (
        this.db.sql
          .prepare(`SELECT COUNT(DISTINCT i.id) AS n FROM fhir_identifiers i WHERE i.tenant_id = ? AND ${where}`)
          .get(...(args as never[])) as { n: number }
      ).n;
      // The join carries the tenant too. Matching on (resource_type, id) alone
      // would let one custodian's identifier row select another custodian's
      // resource of the same id — the two tables are only jointly meaningful
      // inside a tenant.
      const rows = this.db.sql
        .prepare(
          `SELECT DISTINCT r.json FROM fhir_resources r
           JOIN fhir_identifiers i
             ON i.tenant_id = r.tenant_id AND i.resource_type = r.resource_type AND i.id = r.id
           WHERE i.tenant_id = ? AND ${where} ORDER BY r.updated_at DESC, r.id LIMIT ${count} OFFSET ${offset}`
        )
        .all(...(args as never[])) as Array<{ json: string }>;
      return { total, resources: rows.map((r) => JSON.parse(r.json) as Record<string, unknown>) };
    }

    const total = (
      this.db.sql
        .prepare("SELECT COUNT(*) AS n FROM fhir_resources WHERE tenant_id = ? AND resource_type = ?")
        .get(this.db.tenantId, type) as { n: number }
    ).n;
    const rows = this.db.sql
      .prepare(
        `SELECT json FROM fhir_resources WHERE tenant_id = ? AND resource_type = ?
           ORDER BY updated_at DESC, id LIMIT ${count} OFFSET ${offset}`
      )
      .all(this.db.tenantId, type) as Array<{ json: string }>;
    return { total, resources: rows.map((r) => JSON.parse(r.json) as Record<string, unknown>) };
  }

  resourceTypes(): Array<{ type: string; count: number }> {
    const rows = this.db.sql
      .prepare(
        "SELECT resource_type AS type, COUNT(*) AS count FROM fhir_resources WHERE tenant_id = ? GROUP BY resource_type"
      )
      .all(this.db.tenantId) as Array<{ type: string; count: number }>;
    const seen = new Map(rows.map((r) => [r.type, r.count]));
    for (const t of CORE_RESOURCE_TYPES) if (!seen.has(t)) seen.set(t, 0);
    if (this.directory) {
      for (const t of DIRECTORY_RESOURCE_TYPES) {
        const n = directoryCount(this.directory, t);
        seen.set(t, Math.max(seen.get(t) ?? 0, n));
      }
    }
    return [...seen.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([type, count]) => ({ type, count }));
  }

  /**
   * What this server supports, and which guides it claims to follow.
   *
   * `instantiates` comes from the conformance registry rather than from a
   * literal here, so the statement cannot claim an implementation guide the
   * deployment has not actually put into force. A capability statement naming
   * a guide nobody installed is the same failure as a conformance page
   * written by hand: it is the artifact a partner reads and believes.
   */
  capability(baseUrl: string, version: string, instantiates: readonly string[] = []): Record<string, unknown> {
    return {
      resourceType: "CapabilityStatement",
      status: "active",
      ...(instantiates.length > 0 ? { instantiates: [...instantiates] } : {}),
      date: new Date().toISOString(),
      kind: "instance",
      fhirVersion: "4.0.1",
      format: ["application/fhir+json"],
      implementation: { description: "Northstar FHIR facade", url: `${baseUrl}/fhir` },
      software: { name: "Northstar", version },
      rest: [
        {
          mode: "server",
          resource: this.resourceTypes().map(({ type }) => ({
            type,
            interaction: [{ code: "read" }, { code: "search-type" }, { code: "create" }],
            searchParam: [{ name: "identifier", type: "token" }],
          })),
        },
      ],
    };
  }
}

function readIdentifiers(resource: Record<string, unknown>): Identifier[] {
  if (!Array.isArray(resource.identifier)) return [];
  return resource.identifier
    .filter((i): i is Record<string, unknown> => !!i && typeof i === "object")
    .map((i) => ({
      system: typeof i.system === "string" ? i.system : undefined,
      value: typeof i.value === "string" ? i.value : undefined,
    }));
}

/** Deterministic id from the first usable identifier, else random. */
function deriveId(type: string, idents: Identifier[]): string {
  const first = idents.find((i) => i.value);
  if (!first) return randomUUID();
  return createHash("sha256")
    .update(`${type}|${first.system ?? ""}|${first.value}`)
    .digest("hex")
    .slice(0, 24);
}

/** Hash input: the resource without server-assigned meta fields. */
function stripVolatileMeta(body: Record<string, unknown>): Record<string, unknown> {
  if (!body.meta || typeof body.meta !== "object") return body;
  const meta = { ...(body.meta as Record<string, unknown>) };
  delete meta.versionId;
  delete meta.lastUpdated;
  const out = { ...body };
  if (Object.keys(meta).length === 0) delete out.meta;
  else out.meta = meta;
  return out;
}

/** Stable stringify: object keys sorted at every level. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return (
      "{" +
      Object.keys(o)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + canonical(o[k]))
        .join(",") +
      "}"
    );
  }
  return JSON.stringify(v);
}
