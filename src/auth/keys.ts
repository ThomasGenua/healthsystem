/**
 * API keys: issue, verify, revoke.
 *
 * A key is 32 random bytes, base64url, behind a `ptg_` prefix so it is
 * distinguishable from a JWT at a glance (and by the gate, without parsing).
 * Only the SHA-256 is persisted, so a database copy does not yield working
 * credentials and a lost key can only be replaced, never recovered.
 *
 * ## Lifecycle
 *
 * A credential that never expires and that nobody reviews is the ordinary way
 * long-lived access outlives its reason. The contractor's integration key
 * still works, the pilot that ended in 2023 still has one, and nothing
 * anywhere says so — a key issued for a purpose that finished is
 * indistinguishable from one somebody else is quietly using.
 *
 * Three things address that, and none of them relies on anybody remembering:
 *
 *   `expiresAt` is checked against the clock at verification, so a key that
 *   expired last night does not work this morning whether or not anything has
 *   restarted. `expiring()` surfaces the ones about to lapse, so a renewal is
 *   a decision rather than an outage.
 *
 *   `rotate()` issues a replacement and leaves the old key working for an
 *   overlap. A rotation that cut the old key off at the instant the new one
 *   was issued would take an interface down between issuing and deploying,
 *   which is exactly why rotation gets postponed and then skipped.
 *
 *   `dormant()` reports keys nobody has used. That is the query worth having:
 *   dormancy means either nobody needs it or somebody else has it, and both
 *   want it found.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Db } from "../db.ts";
import type { Directory } from "../directory/store.ts";
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
  expiresAt: string | null;
  /** Set on a rotation: the key this one replaces, and when that one stops. */
  replaces?: string;
  previousRetiresAt?: string;
  /** The organization this credential acts for. Null when it does not say. */
  organizationId: string | null;
}

export class ApiKeyStore {
  private readonly db: Db;
  private readonly directory: Directory | null;

  /**
   * The directory is optional in the same way `Meds`' interaction source is:
   * absent, an organization is recorded as given rather than checked. A site
   * that has not populated a directory can still issue keys; one that has gets
   * the typo caught at issue time rather than discovering months later that a
   * directive named `yk-clinic` and every credential says `ykclinic`.
   */
  constructor(db: Db, directory: Directory | null = null) {
    this.db = db;
    this.directory = directory;
  }

  issue(
    name: string,
    scopes: string[] = ALL_SCOPES,
    opts: { expiresAt?: string; organizationId?: string } = {}
  ): IssuedKey {
    // `patient` is deliberately OAuth-only. An API key identifies a service
    // or operator, not a natural person whose subject can be checked against a
    // proxy grant. Silently dropping it while keeping another scope would make
    // a mis-issued key look successful, so refuse the request explicitly.
    if (scopes.includes("patient")) {
      throw new Error("patient scope requires an OAuth identity and cannot be issued on an API key");
    }
    const requested = scopes.filter(isScope);
    if (requested.length === 0) throw new Error(`no valid scopes in [${scopes.join(", ")}]`);
    if (opts.expiresAt && new Date(opts.expiresAt).getTime() <= Date.now()) {
      throw new Error("that expiry is already past");
    }
    // Refused rather than recorded-and-ignored. An organization that resolves
    // to nothing would make the credential look precise while behaving exactly
    // like one that never named an organization at all, and the two need to be
    // distinguishable: one is a deliberate "cannot say", the other is a typo.
    if (opts.organizationId !== undefined && this.directory) {
      const seen = this.directory.resolve("organization", opts.organizationId);
      if (!seen.known) throw new Error(`no organization '${opts.organizationId}' in the directory`);
      if (!seen.active) throw new Error(`organization '${opts.organizationId}' is retired`);
    }
    const id = randomUUID();
    const key = KEY_PREFIX + randomBytes(32).toString("base64url");
    this.db.insertApiKey(id, name, hashKey(key), requested, opts.expiresAt, opts.organizationId);
    return {
      id,
      name,
      scopes: requested,
      key,
      expiresAt: opts.expiresAt ?? null,
      organizationId: opts.organizationId ?? null,
    };
  }

  /**
   * Issues a replacement and retires the old key on a deadline.
   *
   * Both work during the overlap, deliberately. The alternative — the old key
   * stopping the moment the new one exists — means every rotation is an
   * outage window between issuing the credential and getting it deployed to
   * whatever holds it, and a rotation procedure that causes an outage is one
   * that gets deferred until it is never done.
   *
   * The old key's retirement is a date rather than a follow-up task, so the
   * overlap ends on its own. A rotation whose second half depends on somebody
   * coming back to it leaves two working credentials where there should be
   * one, which is worse than not having rotated.
   */
  rotate(id: string, opts: { overlapDays?: number; expiresAt?: string } = {}): IssuedKey {
    const current = this.db.listApiKeys().find((k) => k.id === id);
    if (!current) throw new Error(`no key ${id}`);
    if (current.revoked_at) throw new Error("that key is revoked; issue a new one instead");
    if (current.rotated_to) throw new Error(`that key was already rotated to ${current.rotated_to}`);

    const overlapDays = opts.overlapDays ?? 7;
    const retireAt = new Date(Date.now() + overlapDays * 86_400_000).toISOString();
    return this.db.transaction(() => {
      // The organization travels with the rotation. A replacement that lost it
      // would silently widen what a directive withholds from, which is the
      // failure this whole issue exists to close.
      const replacement = this.issue(current.name, current.scopes.split(/\s+/).filter(Boolean), {
        ...(opts.expiresAt ? { expiresAt: opts.expiresAt } : {}),
        ...(current.organization_id ? { organizationId: current.organization_id } : {}),
      });
      this.db.markApiKeyRotated(id, replacement.id, retireAt);
      return { ...replacement, replaces: id, previousRetiresAt: retireAt };
    });
  }

  /** Keys nobody has used in `days`. See the note at the top of the file. */
  dormant(days = 90, asOf?: string): Array<Omit<ApiKeyRow, "hash">> {
    return this.db.dormantApiKeys(days, asOf).map(({ hash: _hash, ...rest }) => rest);
  }

  /** Keys about to lapse, so a renewal is a decision and not an outage. */
  expiring(withinDays = 14, asOf?: string): Array<Omit<ApiKeyRow, "hash">> {
    return this.db.expiringApiKeys(withinDays, asOf).map(({ hash: _hash, ...rest }) => rest);
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
