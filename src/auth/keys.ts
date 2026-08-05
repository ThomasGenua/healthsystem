/**
 * API keys: issue, verify, revoke.
 *
 * A key is 32 random bytes, base64url, behind a `ptg_` prefix so it is
 * distinguishable from a JWT at a glance (and by the gate, without parsing).
 * Only the SHA-256 is persisted, so a database copy does not yield working
 * credentials and a lost key can only be replaced, never recovered.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Db } from "../db.ts";
import type { ApiKeyRow } from "../types.ts";
import { ALL_SCOPES, effectiveScopes, isScope, type Scope } from "./scopes.ts";

export const KEY_PREFIX = "ptg_";

export function looksLikeApiKey(token: string): boolean {
  return token.startsWith(KEY_PREFIX);
}

export function hashKey(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface IssuedKey {
  id: string;
  name: string;
  scopes: Scope[];
  /** Shown once. Not recoverable afterwards. */
  key: string;
}

export class ApiKeyStore {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  issue(name: string, scopes: string[] = ALL_SCOPES): IssuedKey {
    const requested = scopes.filter(isScope);
    if (requested.length === 0) throw new Error(`no valid scopes in [${scopes.join(", ")}]`);
    const id = randomUUID();
    const key = KEY_PREFIX + randomBytes(32).toString("base64url");
    this.db.insertApiKey(id, name, hashKey(key), requested);
    return { id, name, scopes: requested, key };
  }

  /** Returns the granted scopes, or null when the key is unknown or revoked. */
  verify(token: string): { row: ApiKeyRow; scopes: Set<Scope> } | null {
    const row = this.db.findApiKeyByHash(hashKey(token));
    if (!row) return null;
    this.db.touchApiKey(row.id);
    return { row, scopes: effectiveScopes(row.scopes.split(/\s+/).filter(Boolean)) };
  }

  list(): Array<Omit<ApiKeyRow, "hash">> {
    return this.db.listApiKeys().map(({ hash: _hash, ...rest }) => rest);
  }

  revoke(id: string): boolean {
    return this.db.revokeApiKey(id);
  }

  countActive(): number {
    return this.db.countActiveApiKeys();
  }
}
