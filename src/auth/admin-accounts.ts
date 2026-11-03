/** Local operator accounts. Passwords and session tokens are never stored in plaintext. */
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ApiKeyStore } from "./keys.ts";
import { DEFAULT_TENANT } from "../db.ts";

const COOKIE = "healthsystem_admin";
const COOKIE_NAMES = [COOKIE, "healthsystems_admin", "northstar_admin"];
const SESSION_MS = 8 * 60 * 60 * 1000;
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
const dummySalt = randomBytes(16).toString("hex");
const dummyHash = scryptSync(randomBytes(32), dummySalt, 64);
export interface AdminSession { id: string; email: string; tenantId: string; csrf: string }

export class AdminAccounts {
  private readonly attempts = new Map<string, { n: number; until: number }>();
  private readonly sql: DatabaseSync;
  constructor(sql: DatabaseSync) {
    this.sql = sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS admin_users (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, email TEXT UNIQUE NOT NULL,
      salt TEXT NOT NULL, password_hash TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS admin_sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES admin_users(id),
      expires_at INTEGER NOT NULL
    );`);
  }

  create(email: string, password: string, tenantId = DEFAULT_TENANT): { id: string; email: string } {
    email = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("A valid email is required");
    if (password.length < 10 || password.length > 256) throw new Error("Use a password of 10–256 characters");
    const id = randomUUID(), salt = randomBytes(16).toString("hex");
    const hash = scryptSync(password, salt, 64).toString("hex");
    this.sql.prepare("INSERT INTO admin_users (id,tenant_id,email,salt,password_hash,created_at) VALUES (?,?,?,?,?,?)")
      .run(id, tenantId, email, salt, hash, new Date().toISOString());
    return { id, email };
  }

  login(email: string, password: string): { token: string; session: AdminSession } | null {
    const row = this.sql.prepare("SELECT * FROM admin_users WHERE email=? AND active=1")
      .get(email.trim().toLowerCase()) as { id: string; email: string; tenant_id: string; salt: string; password_hash: string } | undefined;
    const candidate = scryptSync(password, row?.salt ?? dummySalt, 64);
    const expected = row ? Buffer.from(row.password_hash, "hex") : dummyHash;
    if (!timingSafeEqual(candidate, expected) || !row) return null;
    this.sql.prepare("DELETE FROM admin_sessions WHERE expires_at<=?").run(Date.now());
    const token = randomBytes(32).toString("base64url");
    this.sql.prepare("INSERT INTO admin_sessions VALUES (?,?,?)").run(digest(token), row.id, Date.now() + SESSION_MS);
    return { token, session: { id: row.id, email: row.email, tenantId: row.tenant_id, csrf: digest("csrf:" + token) } };
  }

  verify(cookie: string | undefined): AdminSession | null {
    const token = this.token(cookie);
    if (!token) return null;
    const row = this.sql.prepare(`SELECT u.id,u.email,u.tenant_id FROM admin_sessions s
      JOIN admin_users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.active=1`)
      .get(digest(token), Date.now()) as { id: string; email: string; tenant_id: string } | undefined;
    return row ? { id: row.id, email: row.email, tenantId: row.tenant_id, csrf: digest("csrf:" + token) } : null;
  }

  private token(cookie: string | undefined): string | undefined {
    const parts = cookie?.split(";").map(s => s.trim()) ?? [];
    for (const name of COOKIE_NAMES) {
      const matches = parts.filter(s => s.startsWith(name + "="));
      if (matches.length > 1) return undefined;
      if (matches.length === 1) return matches[0].slice(name.length + 1);
    }
    return undefined;
  }
  revoke(cookie: string | undefined): void {
    for (const part of cookie?.split(";") ?? []) {
      const value = part.trim();
      if (COOKIE_NAMES.some(name => value.startsWith(name + "="))) {
        this.sql.prepare("DELETE FROM admin_sessions WHERE token_hash=?").run(digest(value.slice(value.indexOf("=") + 1)));
      }
    }
  }
  csrfAllowed(req: IncomingMessage, session: AdminSession): boolean {
    return this.sameOrigin(req) && req.headers["x-csrf-token"] === session.csrf;
  }
  private sameOrigin(req: IncomingMessage): boolean {
    if (req.headers["sec-fetch-site"] === "cross-site") return false;
    if (!req.headers.origin) return true; // Non-browser clients still need the session CSRF token.
    try {
      const origin = new URL(req.headers.origin);
      const protocol = (req.socket as { encrypted?: boolean }).encrypted ? "https:" : "http:";
      return origin.host === req.headers.host && origin.protocol === protocol;
    } catch { return false; }
  }

  async handle(req: IncomingMessage, res: ServerResponse, path: string, keysForTenant: (tenantId: string) => ApiKeyStore,
    audit: (success: boolean, userId?: string) => void): Promise<boolean> {
    if (!["/auth/admin/login", "/auth/admin/session", "/auth/admin/logout"].includes(path)) return false;
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };
    const session = this.verify(req.headers.cookie);
    if (path === "/auth/admin/session" && req.method === "GET") {
      send(200, session ? { authenticated: true, email: session.email, csrf: session.csrf,
        activeKeys: keysForTenant(session.tenantId).countActive() } : { authenticated: false });
      return true;
    }
    if (path === "/auth/admin/logout" && req.method === "POST") {
      if (!session || !this.csrfAllowed(req, session)) { send(403, { error: "Session verification failed" }); return true; }
      this.revoke(req.headers.cookie);
      res.setHeader("set-cookie", COOKIE_NAMES.map(name => `${name}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`));
      send(200, { ok: true }); return true;
    }
    if (path !== "/auth/admin/login" || req.method !== "POST") { send(405, { error: "Method not allowed" }); return true; }
    if (!this.sameOrigin(req) || !req.headers["content-type"]?.startsWith("application/json")) {
      send(403, { error: "Use the sign-in form on this site" }); return true;
    }
    const now = Date.now(), ip = req.socket.remoteAddress ?? "unknown";
    for (const [key, bucket] of this.attempts) if (bucket.until <= now) this.attempts.delete(key);
    const bucket = this.attempts.get(ip) ?? { n: 0, until: now + 15 * 60_000 };
    if (bucket.n >= 10) { res.setHeader("retry-after", String(Math.ceil((bucket.until-now)/1000))); send(429, { error: "Too many attempts. Try again later." }); return true; }
    bucket.n++; this.attempts.set(ip, bucket);
    let size = 0; const chunks: Buffer[] = [];
    for await (const chunk of req) {
      const b = Buffer.from(chunk); size += b.length;
      if (size > 4096) { send(413, { error: "Sign-in request too large" }); return true; }
      chunks.push(b);
    }
    let body: { email?: unknown; password?: unknown };
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { send(400, { error: "Invalid sign-in request" }); return true; }
    if (!body || typeof body.email !== "string" || typeof body.password !== "string" || body.email.length > 254 || body.password.length > 256) {
      send(400, { error: "Enter your email and password" }); return true;
    }
    const hit = this.login(body.email, body.password);
    audit(Boolean(hit), hit?.session.id);
    if (!hit) { send(401, { error: "Email or password is incorrect" }); return true; }
    const secure = (req.socket as { encrypted?: boolean }).encrypted ? "; Secure" : "";
    res.setHeader("set-cookie", `${COOKIE}=${hit.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MS / 1000}${secure}`);
    send(200, { authenticated: true, email: hit.session.email, csrf: hit.session.csrf, activeKeys: keysForTenant(hit.session.tenantId).countActive() });
    return true;
  }
}
