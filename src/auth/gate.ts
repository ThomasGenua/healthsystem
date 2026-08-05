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
import { looksLikeApiKey, type ApiKeyStore } from "./keys.ts";
import { looksLikeJwt, type JwtVerifier } from "./jwt.ts";

export interface Principal {
  kind: "apikey" | "oauth" | "anonymous";
  id: string;
  scopes: Set<Scope>;
}

export type AuthOutcome =
  | { ok: true; principal: Principal }
  | { ok: false; status: 401 | 403; error: string };

const ANONYMOUS: Principal = { kind: "anonymous", id: "anonymous", scopes: new Set(ALL_SCOPES) };

export interface AuthGateOptions {
  keys?: ApiKeyStore;
  jwt?: JwtVerifier;
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
    return this.opts.jwt ? 'Bearer realm="portage"' : 'Bearer realm="portage", scheme="api-key"';
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

    if (!principal.scopes.has(need)) {
      return { ok: false, status: 403, error: `scope '${need}' required` };
    }
    return { ok: true, principal };
  }

  private async resolve(token: string): Promise<Principal | null> {
    if (looksLikeApiKey(token)) {
      if (!this.opts.keys) return null;
      const hit = this.opts.keys.verify(token);
      return hit ? { kind: "apikey", id: hit.row.id, scopes: hit.scopes } : null;
    }
    if (this.opts.jwt && looksLikeJwt(token)) {
      const v = await this.opts.jwt.verify(token);
      return { kind: "oauth", id: v.subject, scopes: v.scopes };
    }
    return null;
  }
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
