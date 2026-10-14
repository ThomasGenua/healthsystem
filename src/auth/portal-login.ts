/** OIDC authorization-code + PKCE client. Tokens stay in this process, never in the page.
 * Sessions are deliberately single-node and expire on restart or access-token expiry.
 * The normal AuthGate and live patient grants still authorize every patient request.
 */
import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { JwtVerifier } from "./jwt.ts";
import type { AuthOutcome } from "./gate.ts";

export interface PortalLoginConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  origin: string;
  audience: string;
  scopes: string;
  /** Test harnesses only; no environment switch permits HTTP in production. */
  allowLoopbackHttp?: boolean;
}
interface Pending { verifier: string; nonce: string; binding: string; expires: number }
interface Session { token: string; csrf: string; expires: number; idle: number }
const PATH = "/auth/portal";
const random = () => randomBytes(32).toString("base64url");
const digest = (value: string) => createHash("sha256").update(value).digest("base64url");

function trustedUrl(value: string, loopback: boolean): URL {
  const url = new URL(value);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.hash || (url.protocol !== "https:" && !(loopback && local && url.protocol === "http:"))) {
    throw new Error("portal login requires HTTPS URLs without credentials or fragments");
  }
  return url;
}
function cookie(req: IncomingMessage, name: string): string | undefined {
  const matches = (req.headers.cookie ?? "").split(";").map(s => s.trim()).filter(s => s.startsWith(`${name}=`));
  return matches.length === 1 ? matches[0].slice(name.length + 1) : undefined;
}
function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

export class PortalLogin {
  private pending = new Map<string, Pending>();
  private sessions = new Map<string, Session>();
  private config: PortalLoginConfig;
  private metadata?: { authorization: string; token: string; jwks: string };
  private identity?: JwtVerifier;
  private access?: JwtVerifier;
  private readonly sessionCookie: string;
  private readonly loginCookie: string;

  constructor(config: PortalLoginConfig) {
    this.config = { ...config };
    const origin = trustedUrl(config.origin, !!config.allowLoopbackHttp);
    const issuer = trustedUrl(config.issuer, !!config.allowLoopbackHttp);
    if (origin.origin !== config.origin || issuer.search || !config.clientId.trim() || !config.clientSecret.trim() ||
        !config.audience.trim() || !config.scopes.split(/\s+/).includes("openid") || config.scopes.includes("offline_access")) {
      throw new Error("portal login needs an exact public origin, issuer, client id/secret, audience and openid scopes (no offline_access)");
    }
    const prefix = origin.protocol === "https:" ? "__Host-" : "";
    this.sessionCookie = `${prefix}northstar-session`;
    this.loginCookie = `${prefix}northstar-login`;
  }

  private setCookie(res: ServerResponse, name: string, value: string, maxAge: number): void {
    const secure = this.config.origin.startsWith("https:") ? "; Secure" : "";
    const old = res.getHeader("set-cookie");
    res.setHeader("set-cookie", [...(Array.isArray(old) ? old : old ? [String(old)] : []),
      `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`]);
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, value] of this.pending) if (value.expires <= now) this.pending.delete(key);
    for (const [key, value] of this.sessions) if (value.expires <= now || value.idle <= now) this.sessions.delete(key);
  }

  private session(req: IncomingMessage): Session | undefined {
    this.sweep();
    const id = cookie(req, this.sessionCookie);
    return id ? this.sessions.get(digest(id)) : undefined;
  }

  /** Attach only to patient routes. Cookie credentials never authorize admin/FHIR routes. */
  attach(req: IncomingMessage, path: string): Extract<AuthOutcome, { ok: false }> | undefined {
    if (!path.startsWith("/patient/") || req.headers.authorization) return;
    const session = this.session(req);
    if (!session) return;
    // Resolve the ordinary principal even on CSRF denial so the refusal is
    // audited under the session's custodian rather than the default tenant.
    req.headers.authorization = `Bearer ${session.token}`;
    const safe = req.method === "GET" || req.method === "HEAD";
    if (req.headers["sec-fetch-site"] === "cross-site" || (!safe &&
        (req.headers.origin !== this.config.origin || req.headers["x-northstar-csrf"] !== session.csrf))) {
      return { ok: false, status: 403, error: "request origin or CSRF token invalid" };
    }
    session.idle = Date.now() + 15 * 60_000;
  }

  private async fetchJson(url: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
    const response = await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error("identity provider request failed");
    // Bound identity-provider responses, including chunked ones.
    const reader = response.body?.getReader();
    if (!reader) throw new Error("empty identity response");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 128 * 1024) throw new Error("identity response too large");
        chunks.push(value);
      }
    } finally { await reader.cancel(); }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }

  private async discover(): Promise<void> {
    if (this.metadata) return;
    const doc = await this.fetchJson(`${this.config.issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`);
    if (doc.issuer !== this.config.issuer || !Array.isArray(doc.code_challenge_methods_supported) ||
        !doc.code_challenge_methods_supported.includes("S256")) throw new Error("issuer or PKCE discovery mismatch");
    if (Array.isArray(doc.token_endpoint_auth_methods_supported) && !doc.token_endpoint_auth_methods_supported.includes("client_secret_basic")) {
      throw new Error("provider must support client_secret_basic");
    }
    const endpoint = (key: string) => {
      if (typeof doc[key] !== "string") throw new Error("missing provider endpoint");
      return trustedUrl(doc[key], !!this.config.allowLoopbackHttp).href;
    };
    const metadata = { authorization: endpoint("authorization_endpoint"), token: endpoint("token_endpoint"), jwks: endpoint("jwks_uri") };
    this.identity = new JwtVerifier({ issuer: this.config.issuer, audience: this.config.clientId, jwksUri: metadata.jwks, clockSkewSec: 0 });
    this.access = new JwtVerifier({ issuer: this.config.issuer, audience: this.config.audience, jwksUri: metadata.jwks, clockSkewSec: 0 });
    this.metadata = metadata;
  }

  async handle(req: IncomingMessage, res: ServerResponse, path: string, url: URL): Promise<boolean> {
    if (!(path === PATH || path.startsWith(`${PATH}/`))) return false;
    res.setHeader("cache-control", "no-store");
    res.setHeader("referrer-policy", "no-referrer");
    this.sweep();
    const session = this.session(req);
    if (req.method === "GET" && path === PATH) {
      json(res, 200, { enabled: true, authenticated: !!session, ...(session ? { csrf: session.csrf } : {}) });
      return true;
    }
    if (req.method === "POST" && path === `${PATH}/logout`) {
      if (req.headers.origin !== this.config.origin || (session && req.headers["x-northstar-csrf"] !== session.csrf)) {
        json(res, 403, { error: "request origin or CSRF token invalid" });
        return true;
      }
      const id = cookie(req, this.sessionCookie);
      if (id) this.sessions.delete(digest(id));
      this.setCookie(res, this.sessionCookie, "", 0);
      json(res, 200, { signedOut: true });
      return true;
    }
    if (req.method === "GET" && path === `${PATH}/login`) {
      try {
        if (this.pending.size >= 1000) throw new Error("login capacity reached");
        await this.discover();
        if (this.pending.size >= 1000) throw new Error("login capacity reached");
        const state = random(), binding = random(), nonce = random(), verifier = random();
        const prior = cookie(req, this.loginCookie);
        if (prior) for (const [key, p] of this.pending) if (p.binding === digest(prior)) this.pending.delete(key);
        this.pending.set(digest(state), { verifier, nonce, binding: digest(binding), expires: Date.now() + 5 * 60_000 });
        const target = new URL(this.metadata!.authorization);
        target.searchParams.set("client_id", this.config.clientId);
        target.searchParams.set("response_type", "code");
        target.searchParams.set("redirect_uri", `${this.config.origin}${PATH}/callback`);
        target.searchParams.set("scope", this.config.scopes);
        target.searchParams.set("state", state);
        target.searchParams.set("nonce", nonce);
        target.searchParams.set("code_challenge", digest(verifier));
        target.searchParams.set("code_challenge_method", "S256");
        this.setCookie(res, this.loginCookie, binding, 300);
        res.writeHead(303, { location: target.href }); res.end();
      } catch { json(res, 503, { error: "Clinic sign-in is temporarily unavailable. Please try again." }); }
      return true;
    }
    if (req.method === "GET" && path === `${PATH}/callback`) {
      this.setCookie(res, this.loginCookie, "", 0);
      try {
        const params = url.searchParams;
        const one = (name: string) => params.getAll(name).length === 1 ? params.get(name)! : "";
        const state = one("state"), binding = cookie(req, this.loginCookie);
        const pending = this.pending.get(digest(state));
        this.pending.delete(digest(state)); // consume before awaiting any network operation
        if (!pending || !binding || pending.binding !== digest(binding) || params.has("error") || !one("code") ||
            (params.has("iss") && one("iss") !== this.config.issuer)) throw new Error("invalid login response");
        const form = new URLSearchParams({ grant_type: "authorization_code", code: one("code"),
          redirect_uri: `${this.config.origin}${PATH}/callback`, code_verifier: pending.verifier });
        const encode = (v: string) => new URLSearchParams({ v }).toString().slice(2);
        const secret = Buffer.from(`${encode(this.config.clientId)}:${encode(this.config.clientSecret)}`).toString("base64");
        const tokens = await this.fetchJson(this.metadata!.token, { method: "POST", headers: {
          "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${secret}`,
        }, body: form.toString() });
        if (typeof tokens.access_token !== "string" || typeof tokens.id_token !== "string" ||
            typeof tokens.token_type !== "string" || tokens.token_type.toLowerCase() !== "bearer") throw new Error("missing tokens");
        const [id, access] = await Promise.all([this.identity!.verify(tokens.id_token), this.access!.verify(tokens.access_token)]);
        const now = Date.now() / 1000;
        for (const token of [id, access]) {
          if (typeof token.claims.sub !== "string" || !token.claims.sub || typeof token.claims.exp !== "number" ||
              !Number.isFinite(token.claims.exp) || token.claims.exp <= now) throw new Error("invalid token lifetime or subject");
        }
        if (id.claims.nonce !== pending.nonce || id.subject !== access.subject || !access.scopes.has("patient") ||
            typeof id.claims.iat !== "number" || !Number.isFinite(id.claims.iat) || id.claims.iat > now + 60 ||
            ((id.claims.azp !== undefined || (Array.isArray(id.claims.aud) && id.claims.aud.length > 1)) && id.claims.azp !== this.config.clientId)) {
          throw new Error("identity binding failed");
        }
        if (id.claims.at_hash !== undefined) {
          const header = JSON.parse(Buffer.from(tokens.id_token.split(".")[0], "base64url").toString());
          const bits = /^(RS|PS|ES)(256|384|512)$/.exec(header.alg)?.[2];
          if (!bits) throw new Error("unsupported token hash");
          const hash = createHash(`sha${bits}`).update(tokens.access_token).digest();
          if (id.claims.at_hash !== hash.subarray(0, hash.length / 2).toString("base64url")) throw new Error("access token hash mismatch");
        }
        let expires = Math.min(id.claims.exp as number, access.claims.exp as number, now + 8 * 3600);
        if (tokens.expires_in !== undefined) {
          if (typeof tokens.expires_in !== "number" || !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0) throw new Error("invalid expiry");
          expires = Math.min(expires, now + tokens.expires_in);
        }
        if (this.sessions.size >= 1000) throw new Error("session capacity reached");
        const old = cookie(req, this.sessionCookie);
        if (old) this.sessions.delete(digest(old));
        const key = random();
        this.sessions.set(digest(key), { token: tokens.access_token, csrf: random(), expires: expires * 1000, idle: Date.now() + 15 * 60_000 });
        this.setCookie(res, this.sessionCookie, key, Math.floor(expires - now));
        res.writeHead(303, { location: "/me" }); res.end();
      } catch {
        res.writeHead(303, { location: "/me?signin=failed" }); res.end();
      }
      return true;
    }
    json(res, 404, { error: "not found" });
    return true;
  }
}
