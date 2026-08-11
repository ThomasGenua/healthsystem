/**
 * OAuth 2.0 / SMART on FHIR bearer token validation against a JWKS.
 *
 * No dependency: node:crypto can build a key from a JWK and verify RSA and
 * ECDSA signatures directly. Works against any OIDC provider — Entra ID,
 * Keycloak, Auth0 — by pointing PORTAGE_OIDC_ISSUER at it; nothing here is
 * provider-specific.
 *
 * The algorithm is chosen from a fixed table keyed by the token header, so an
 * `alg: none` token, or one naming an algorithm Portage does not implement, is
 * rejected before any key material is touched.
 */
import { constants, createPublicKey, verify as cryptoVerify, type KeyObject } from "node:crypto";
import { scopesFromSmart, type Scope } from "./scopes.ts";

export interface OidcConfig {
  issuer: string;
  audience?: string;
  /** Explicit JWKS URI. Discovered from the issuer when omitted. */
  jwksUri?: string;
  /** Tolerance for clock drift between Portage and the identity provider. */
  clockSkewSec?: number;
  /** How long a fetched JWKS is reused before refetching. */
  cacheTtlMs?: number;
}

interface VerifyParams {
  algorithm: string;
  options: Parameters<typeof cryptoVerify>[2];
}

/** Only these reach a key. Anything else — including "none" — is refused. */
function verifyParams(alg: string, key: KeyObject): VerifyParams | null {
  switch (alg) {
    case "RS256":
      return { algorithm: "sha256", options: key };
    case "RS384":
      return { algorithm: "sha384", options: key };
    case "RS512":
      return { algorithm: "sha512", options: key };
    case "PS256":
      return {
        algorithm: "sha256",
        options: { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST },
      };
    case "ES256":
      return { algorithm: "sha256", options: { key, dsaEncoding: "ieee-p1363" } };
    case "ES384":
      return { algorithm: "sha384", options: { key, dsaEncoding: "ieee-p1363" } };
    default:
      return null;
  }
}

export function looksLikeJwt(token: string): boolean {
  return token.split(".").length === 3;
}

function decodeSegment(seg: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(seg, "base64url").toString("utf8")) as Record<string, unknown>;
}

export interface VerifiedToken {
  subject: string;
  scopes: Set<Scope>;
  claims: Record<string, unknown>;
  /**
   * The custodian the token was issued for, from a claim the identity provider
   * controls — never from anything the caller can set on the request. Absent
   * when the provider does not assert one, which leaves the caller in the
   * default tenant rather than in whichever one they would have preferred.
   */
  tenantId?: string;
}

export class JwtVerifier {
  private keys = new Map<string, KeyObject>();
  private fetchedAt = 0;
  private jwksUri: string | undefined;
  private inflight: Promise<void> | null = null;

  private readonly config: OidcConfig;

  constructor(config: OidcConfig) {
    this.config = config;
    this.jwksUri = config.jwksUri;
  }

  private get ttl(): number {
    return this.config.cacheTtlMs ?? 5 * 60_000;
  }

  private async discover(): Promise<string> {
    if (this.jwksUri) return this.jwksUri;
    const base = this.config.issuer.replace(/\/+$/, "");
    const res = await fetch(`${base}/.well-known/openid-configuration`);
    if (!res.ok) throw new Error(`OIDC discovery failed: ${res.status}`);
    const doc = (await res.json()) as { jwks_uri?: string };
    if (!doc.jwks_uri) throw new Error("OIDC discovery document has no jwks_uri");
    this.jwksUri = doc.jwks_uri;
    return this.jwksUri;
  }

  /** Refreshes the key cache. Concurrent callers share one fetch. */
  private async refresh(): Promise<void> {
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      try {
        const uri = await this.discover();
        const res = await fetch(uri);
        if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
        const doc = (await res.json()) as { keys?: Array<Record<string, unknown>> };
        const next = new Map<string, KeyObject>();
        for (const jwk of doc.keys ?? []) {
          const kid = typeof jwk.kid === "string" ? jwk.kid : "";
          if (!kid) continue;
          try {
            next.set(kid, createPublicKey({ key: jwk as never, format: "jwk" }));
          } catch {
            // A JWKS may carry key types this build cannot construct. Skip the
            // key rather than failing the whole set.
          }
        }
        if (next.size === 0) throw new Error("JWKS contained no usable keys");
        this.keys = next;
        this.fetchedAt = Date.now();
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  private async keyFor(kid: string): Promise<KeyObject> {
    const stale = Date.now() - this.fetchedAt > this.ttl;
    if (this.keys.size === 0 || stale) await this.refresh();
    let key = this.keys.get(kid);
    if (!key) {
      // Unknown kid on a fresh cache means the provider rotated. Refetch once,
      // but only if the cache is not already brand new, so a token naming a
      // bogus kid cannot be used to hammer the provider.
      if (Date.now() - this.fetchedAt > 10_000) await this.refresh();
      key = this.keys.get(kid);
    }
    if (!key) throw new Error(`no JWKS key for kid ${kid}`);
    return key;
  }

  async verify(token: string): Promise<VerifiedToken> {
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("malformed token");
    const header = decodeSegment(parts[0]);
    const alg = typeof header.alg === "string" ? header.alg : "";
    const kid = typeof header.kid === "string" ? header.kid : "";
    if (!kid) throw new Error("token header has no kid");

    const key = await this.keyFor(kid);
    const params = verifyParams(alg, key);
    if (!params) throw new Error(`unsupported alg: ${alg || "none"}`);

    const signed = Buffer.from(`${parts[0]}.${parts[1]}`, "utf8");
    const signature = Buffer.from(parts[2], "base64url");
    if (!cryptoVerify(params.algorithm, signed, params.options, signature)) {
      throw new Error("signature verification failed");
    }

    const claims = decodeSegment(parts[1]);
    const skew = this.config.clockSkewSec ?? 60;
    const now = Math.floor(Date.now() / 1000);

    if (claims.iss !== this.config.issuer) throw new Error("issuer mismatch");
    if (typeof claims.exp === "number" && now > claims.exp + skew) throw new Error("token expired");
    if (typeof claims.nbf === "number" && now + skew < claims.nbf) throw new Error("token not yet valid");
    if (this.config.audience !== undefined) {
      const aud = claims.aud;
      const ok = Array.isArray(aud) ? aud.includes(this.config.audience) : aud === this.config.audience;
      if (!ok) throw new Error("audience mismatch");
    }

    // The tenant claim the provider asserts. `tenant` is what most issuers
    // call it; `portage_tenant` is the escape hatch for one that already uses
    // `tenant` for something else.
    const tenantClaim = [claims.portage_tenant, claims.tenant].find((c) => typeof c === "string" && c.length > 0);
    return {
      subject: typeof claims.sub === "string" ? claims.sub : "unknown",
      scopes: scopesFromSmart(rawScopes(claims)),
      claims,
      ...(typeof tenantClaim === "string" ? { tenantId: tenantClaim } : {}),
    };
  }
}

/** Scopes live in `scope` (space-delimited) or `scp` (either form), by provider. */
function rawScopes(claims: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const field of ["scope", "scp", "roles"]) {
    const v = claims[field];
    if (typeof v === "string") out.push(...v.split(/\s+/).filter(Boolean));
    else if (Array.isArray(v)) out.push(...v.filter((x): x is string => typeof x === "string"));
  }
  return out;
}
