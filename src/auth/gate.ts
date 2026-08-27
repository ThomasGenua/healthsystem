/**
 * The authentication gate.
 *
 * One entry point, `check()`, called once per request before any route runs.
 * It accepts either an API key or an OAuth 2.0 / SMART bearer token — the
 * `ptg_` prefix decides which without guessing — resolves the caller's scopes,
 * and compares them against what the route requires.
 *
 * mTLS, when configured, is a separate and earlier gate: the TLS layer refuses
 * a client with no trusted certificate before a request is ever parsed. It is
 * transport-level proof of *which host* is calling; this is application-level
 * proof of *what that caller may do*. Both apply.
 */
import type { IncomingHttpHeaders } from "node:http";
import { ALL_SCOPES, requiredScope, type Scope } from "./scopes.ts";
import { DEFAULT_TENANT } from "../db.ts";
import { looksLikeApiKey, type ApiKeyStore } from "./keys.ts";
import { looksLikeJwt, type JwtVerifier } from "./jwt.ts";

export interface Principal {
  kind: "apikey" | "oauth" | "anonymous";
  id: string;
  scopes: Set<Scope>;
  /**
   * The custodian this caller acts within. Every request is confined to it —
   * a credential is issued by a tenant and cannot reach outside the one that
   * issued it, which is what makes many organizations on one platform safe
   * rather than merely tidy.
   */
  tenantId: string;
  /**
   * Why the caller is reaching for the record, as a purpose-of-use code.
   *
   * Required by section 17 and recorded on every audit row, because "who
   * looked" without "why" cannot distinguish treatment from curiosity — which
   * is the distinction a privacy office actually investigates. Taken from a
   * header or a token claim; absent means the caller declined to say, which is
   * itself worth recording rather than guessing at.
   */
  purposeOfUse?: string;
  /**
   * Which organization the caller acts for, as a directory organization id.
   *
   * Deliberately not the tenant. Several organizations operate inside one
   * custodian's tenant — a territorial authority hosting a community clinic
   * and a visiting specialist service — and a patient who withholds their
   * record from one of them has not withheld it from the other.
   *
   * Absent when the credential does not say, which stays fail-closed: a
   * `withhold-from-organization` directive treats a caller that cannot rule
   * itself out as possibly the withheld one. That is over-restrictive rather
   * than permissive, which is the correct direction to be wrong in.
   */
  organizationId?: string;
  /**
   * Which practitioner the caller acts as, as a directory practitioner id.
   *
   * This is what lets an access review ask whether the person who read a chart
   * had any reason to. The clinical stores have always recorded an actor and
   * the audit trail has always recorded a credential; with no join between
   * them, "did anybody with no relationship to this patient read their record"
   * was a question the trail held all the data for and could not answer.
   *
   * Absent for an integration credential, which acts as nobody. That is a real
   * answer rather than a missing one, and a review reports it as such instead
   * of inventing a person to attribute the access to.
   */
  practitionerId?: string;
}

export type AuthOutcome =
  | { ok: true; principal: Principal }
  /**
   * A denial still carries the principal when one was resolved. A scope
   * violation by a known key is a different event from an anonymous probe,
   * and the audit trail has to be able to name who overreached — that
   * attribution is the whole point of recording refusals.
   */
  | { ok: false; status: 401 | 403; error: string; principal?: Principal };

const ANONYMOUS: Principal = {
  kind: "anonymous",
  id: "anonymous",
  scopes: new Set(ALL_SCOPES),
  tenantId: DEFAULT_TENANT,
};

/**
 * Purpose-of-use codes, from HL7 v3 ActReason, which is what FHIR AuditEvent
 * expects. Deliberately a closed set: a free-text purpose is a box people type
 * "work" into, and it cannot be reported on.
 */
export const PURPOSES = ["TREAT", "HPAYMT", "HOPERAT", "HRESCH", "PATRQT", "PUBHLTH", "HLEGAL"] as const;

export interface AuthGateOptions {
  keys?: ApiKeyStore;
  jwt?: JwtVerifier;
  /**
   * Looks a tenant up, so the gate can refuse a credential belonging to one
   * that has been suspended. Section 13 requires suspending a tenant without
   * touching anyone else; that is worth nothing if its keys keep working.
   */
  tenants?: { getTenant(id: string): { status: string } | undefined };
}

export class AuthGate {
  private readonly opts: AuthGateOptions;

  constructor(opts: AuthGateOptions = {}) {
    this.opts = opts;
  }

  /** True when at least one credential scheme is configured. */
  get enabled(): boolean {
    return Boolean(this.opts.keys || this.opts.jwt);
  }

  /** The WWW-Authenticate value to return with a 401. */
  get challenge(): string {
    return this.opts.jwt ? 'Bearer realm="northstar"' : 'Bearer realm="northstar", scheme="api-key"';
  }

  async check(method: string, path: string, headers: IncomingHttpHeaders): Promise<AuthOutcome> {
    const need = requiredScope(method, path);
    if (!this.enabled) return { ok: true, principal: ANONYMOUS };
    if (need === null) return { ok: true, principal: ANONYMOUS };

    const token = bearerToken(headers);
    if (!token) return { ok: false, status: 401, error: "credentials required" };

    let principal: Principal;
    try {
      const resolved = await this.resolve(token);
      if (!resolved) return { ok: false, status: 401, error: "invalid credentials" };
      principal = resolved;
    } catch (err) {
      return { ok: false, status: 401, error: err instanceof Error ? err.message : "invalid credentials" };
    }

    // A suspended custodian's credentials stop working immediately, before
    // scopes are even consulted: suspension is about the organization, not
    // about what any one key was allowed to do.
    const tenant = this.opts.tenants?.getTenant(principal.tenantId);
    if (this.opts.tenants && principal.kind !== "anonymous") {
      if (!tenant) {
        return { ok: false, status: 403, error: "credential belongs to no known tenant", principal };
      }
      if (tenant.status !== "active") {
        return { ok: false, status: 403, error: `tenant '${principal.tenantId}' is ${tenant.status}`, principal };
      }
    }

    if (!principal.scopes.has(need)) {
      return { ok: false, status: 403, error: `scope '${need}' required`, principal };
    }
    // A patient-context scope is useful only when it names a person at an
    // identity provider. API keys identify systems and operators; binding one
    // to patient_authority would turn a copied secret into a person's identity
    // and defeat the boundary this scope exists to create.
    if (need === "patient" && principal.kind !== "oauth") {
      return { ok: false, status: 403, error: "patient access requires an OAuth identity", principal };
    }
    return { ok: true, principal: { ...principal, purposeOfUse: purposeOfUse(headers) } };
  }

  private async resolve(token: string): Promise<Principal | null> {
    if (looksLikeApiKey(token)) {
      if (!this.opts.keys) return null;
      const hit = this.opts.keys.verify(token);
      // The tenant comes from the stored row, never from the request. A caller
      // naming their own tenant would be naming their own authorisation.
      return hit
        ? {
            kind: "apikey",
            id: hit.row.id,
            scopes: hit.scopes,
            tenantId: hit.row.tenant_id ?? DEFAULT_TENANT,
            // Also from the stored row, for the same reason as the tenant: an
            // organization the caller could assert is an organization they
            // could assert their way out of a directive with.
            ...(hit.row.organization_id ? { organizationId: hit.row.organization_id } : {}),
            ...(hit.row.practitioner_id ? { practitionerId: hit.row.practitioner_id } : {}),
          }
        : null;
    }
    if (this.opts.jwt && looksLikeJwt(token)) {
      const v = await this.opts.jwt.verify(token);
      return {
        kind: "oauth",
        id: v.subject,
        scopes: v.scopes,
        tenantId: v.tenantId ?? DEFAULT_TENANT,
        ...(v.organizationId ? { organizationId: v.organizationId } : {}),
        ...(v.practitionerId ? { practitionerId: v.practitionerId } : {}),
      };
    }
    return null;
  }
}

/**
 * The declared purpose of use, if the caller gave one this engine recognises.
 *
 * An unrecognised value is dropped rather than recorded, so the audit trail
 * carries codes a report can group by instead of whatever a client happened to
 * send. Declining to say is recorded as declining to say.
 */
function purposeOfUse(headers: IncomingHttpHeaders): string | undefined {
  const raw = headers["x-purpose-of-use"];
  if (typeof raw !== "string") return undefined;
  const code = raw.trim().toUpperCase();
  return (PURPOSES as readonly string[]).includes(code) ? code : undefined;
}

function bearerToken(headers: IncomingHttpHeaders): string | null {
  const auth = headers.authorization;
  if (typeof auth === "string") {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m) return m[1].trim();
  }
  const key = headers["x-api-key"];
  if (typeof key === "string" && key.trim()) return key.trim();
  return null;
}
