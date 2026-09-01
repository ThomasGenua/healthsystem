/**
 * What this deployment claims to conform to, and where each claim came from.
 *
 * The conformance packs under `conformance/` are hand-written JSON, and they
 * say nothing about their own provenance: which published release they were
 * derived from, at what version, or whether the bytes have changed since
 * somebody wrote them. That is the same failure as a value set carrying a
 * publisher's name and a membership nobody can trace — worse than having
 * none, because it is the one that gets cited.
 *
 * So an implementation guide, terminology release, security profile or schema
 * is recorded here with its canonical URL, package identifier, exact version
 * and a checksum, and nothing is active until an operator activates it.
 *
 * ## A checksum somebody typed in is not a checksum
 *
 * `checksumVerified` is the load-bearing column. A hash copied out of a
 * release note proves that the release note said it; it does not establish
 * that these bytes are those bytes. The flag is set only by `verify()`, which
 * hashes an artifact actually in hand and compares. Everything else leaves it
 * false.
 *
 * This distinction is not academic here. The environment this was built in has
 * no network route to any package registry, so nothing could be fetched and
 * nothing could be hashed — every entry it can create is unverified. Rather
 * than record versions as though they were confirmed, the registry refuses to
 * activate an unverified package in production and says why. The gap is
 * visible and fail-closed instead of invisible and optimistic.
 *
 * ## What is refused, and the one way past it
 *
 * A package is refused activation in production when its checksum is
 * unverified, when its publication status is ballot, draft or unknown, or
 * when its version names a moving target. Each is a reason the claim cannot
 * be relied on: an unhashed artifact is not identified, a ballot is not a
 * standard, and "current" is not a version — what it points at today is not
 * what it pointed at when the claim was made.
 *
 * An operator can override, in writing, with the reason recorded on the row.
 * That exists because a deployment may have good cause — a package fetched
 * over sneakernet, a national extension not yet balloted — and a control with
 * no exit is one people work around instead of through. What it does not do
 * is disappear: an overridden activation says so wherever it is read.
 */
import { createHash, randomUUID } from "node:crypto";
import type { Db } from "../db.ts";
import { Refusal } from "../core/refusal.ts";

export type PublicationStatus = "release" | "trial-use" | "ballot" | "draft" | "unknown";
export type ActivationState = "registered" | "active" | "retired";

export interface PackageEntry {
  id: string;
  canonicalUrl: string;
  packageId: string;
  version: string;
  fhirVersion: string | null;
  license: string | null;
  publicationStatus: PublicationStatus;
  mutableVersion: boolean;
  checksum: string | null;
  checksumVerified: boolean;
  installedAt: string;
  activationState: ActivationState;
  activatedAt: string | null;
  activatedBy: string | null;
  activationReason: string | null;
  overrideReason: string | null;
}

/** Why a package may not be activated. Empty means nothing stands in the way. */
export interface Objection {
  code: "unverified-checksum" | "not-a-release" | "mutable-version";
  detail: string;
}

/**
 * Version strings that name a moving target rather than a release.
 *
 * Conformance to "current" is not a claim that can be checked later, because
 * what it resolved to when the claim was made is gone.
 */
const MOVING = new Set(["current", "latest", "dev", "head", "main", "master", "snapshot", ""]);

export function versionIsMutable(version: string): boolean {
  const v = version.trim().toLowerCase();
  return MOVING.has(v) || v.endsWith("-snapshot") || v.endsWith(".x") || v.includes("+dev");
}

function rowToEntry(r: Record<string, unknown>): PackageEntry {
  return {
    id: String(r.id),
    canonicalUrl: String(r.canonical_url),
    packageId: String(r.package_id),
    version: String(r.version),
    fhirVersion: (r.fhir_version as string | null) ?? null,
    license: (r.license as string | null) ?? null,
    publicationStatus: String(r.publication_status) as PublicationStatus,
    mutableVersion: Number(r.mutable_version) === 1,
    checksum: (r.checksum as string | null) ?? null,
    checksumVerified: Number(r.checksum_verified) === 1,
    installedAt: String(r.installed_at),
    activationState: String(r.activation_state) as ActivationState,
    activatedAt: (r.activated_at as string | null) ?? null,
    activatedBy: (r.activated_by as string | null) ?? null,
    activationReason: (r.activation_reason as string | null) ?? null,
    overrideReason: (r.override_reason as string | null) ?? null,
  };
}

export class StandardsRegistry {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /**
   * Records a package. Never activates one: registering is a statement that
   * this artifact exists and where it came from, not that it governs anything.
   */
  register(input: {
    canonicalUrl: string;
    packageId: string;
    version: string;
    publicationStatus: PublicationStatus;
    fhirVersion?: string;
    license?: string;
    /** The publisher's stated hash, if any. Recorded, but not believed. */
    checksum?: string;
    at?: Date;
  }): PackageEntry {
    for (const [field, value] of [
      ["canonicalUrl", input.canonicalUrl],
      ["packageId", input.packageId],
      ["version", input.version],
    ] as const) {
      if (!value || !String(value).trim()) throw new Refusal(`${field} is required to register a package`, 400);
    }
    const now = (input.at ?? new Date()).toISOString();
    const entry: PackageEntry = {
      id: randomUUID(),
      canonicalUrl: input.canonicalUrl.trim(),
      packageId: input.packageId.trim(),
      version: input.version.trim(),
      fhirVersion: input.fhirVersion ?? null,
      license: input.license ?? null,
      publicationStatus: input.publicationStatus,
      mutableVersion: versionIsMutable(input.version),
      checksum: input.checksum ?? null,
      // A hash the publisher stated is not a hash this system computed.
      checksumVerified: false,
      installedAt: now,
      activationState: "registered",
      activatedAt: null,
      activatedBy: null,
      activationReason: null,
      overrideReason: null,
    };
    this.db.sql
      .prepare(
        `INSERT INTO conformance_packages
           (tenant_id, id, canonical_url, package_id, version, fhir_version, license,
            publication_status, mutable_version, checksum, checksum_verified,
            installed_at, activation_state, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'registered', ?)`
      )
      .run(
        this.db.tenantId, entry.id, entry.canonicalUrl, entry.packageId, entry.version,
        entry.fhirVersion, entry.license, entry.publicationStatus,
        entry.mutableVersion ? 1 : 0, entry.checksum, now, now
      );
    return entry;
  }

  /**
   * Hashes an artifact actually in hand and records whether it matches.
   *
   * The only way `checksumVerified` becomes true. A mismatch is a refusal and
   * leaves the flag false: bytes that are not the bytes the publisher named
   * are not that package, whatever the filename says.
   */
  verify(id: string, bytes: Buffer | Uint8Array | string): PackageEntry {
    const entry = this.require(id);
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (!entry.checksum) {
      throw new Refusal(
        `${entry.packageId}@${entry.version} was registered without a checksum, so there is nothing to verify these bytes against (they hash to ${actual})`,
        400
      );
    }
    if (actual !== entry.checksum.toLowerCase()) {
      throw new Refusal(
        `${entry.packageId}@${entry.version} does not match: expected ${entry.checksum}, these bytes hash to ${actual}`,
        409
      );
    }
    this.db.sql
      .prepare("UPDATE conformance_packages SET checksum_verified = 1 WHERE tenant_id = ? AND id = ?")
      .run(this.db.tenantId, id);
    return this.require(id);
  }

  /** Everything standing between this package and production use. */
  objections(entry: PackageEntry): Objection[] {
    const out: Objection[] = [];
    if (!entry.checksumVerified) {
      out.push({
        code: "unverified-checksum",
        detail: entry.checksum
          ? "the recorded checksum has not been checked against the artifact itself"
          : "no checksum has been recorded, so the artifact is not identified",
      });
    }
    if (entry.publicationStatus !== "release" && entry.publicationStatus !== "trial-use") {
      out.push({
        code: "not-a-release",
        detail: `publication status is ${entry.publicationStatus}; a ballot or draft is not something to conform to`,
      });
    }
    if (entry.mutableVersion) {
      out.push({
        code: "mutable-version",
        detail: `version ${entry.version} names a moving target, so what it points at now is not what it pointed at when the claim was made`,
      });
    }
    return out;
  }

  /**
   * Puts a package into force.
   *
   * Refuses on any objection unless overridden in writing. The override is
   * recorded on the row and travels with the package everywhere it is read,
   * so an exception stays an exception rather than becoming the state of the
   * system.
   */
  activate(input: {
    id: string;
    reason: string;
    by: string;
    override?: string;
    at?: Date;
  }): PackageEntry {
    const entry = this.require(input.id);
    const reason = (input.reason ?? "").trim();
    if (reason.length < 12) {
      throw new Refusal("activating a conformance package requires a written reason of at least 12 characters", 400);
    }
    if (!input.by) throw new Refusal("the operator activating a package must be identified", 400);
    if (entry.activationState === "active") {
      throw new Refusal(`${entry.packageId}@${entry.version} is already active`, 409);
    }

    const objections = this.objections(entry);
    const override = (input.override ?? "").trim();
    if (objections.length > 0 && override.length < 12) {
      throw new Refusal(
        `${entry.packageId}@${entry.version} cannot be activated: ` +
          objections.map((o) => `${o.code} (${o.detail})`).join("; ") +
          ". Supply a written override of at least 12 characters to activate it anyway; it will be recorded.",
        409
      );
    }

    const now = (input.at ?? new Date()).toISOString();
    return this.db.transaction(() => {
      // The partial unique index refuses a second active version of the same
      // package, so this states the intent and the database keeps it true.
      this.db.sql
        .prepare(
          `UPDATE conformance_packages SET activation_state = 'retired'
            WHERE tenant_id = ? AND package_id = ? AND activation_state = 'active'`
        )
        .run(this.db.tenantId, entry.packageId);
      this.db.sql
        .prepare(
          `UPDATE conformance_packages
              SET activation_state = 'active', activated_at = ?, activated_by = ?,
                  activation_reason = ?, override_reason = ?
            WHERE tenant_id = ? AND id = ? AND activation_state = 'registered'`
        )
        .run(now, input.by, reason, objections.length > 0 ? override : null, this.db.tenantId, input.id);
      return this.require(input.id);
    });
  }

  /** Withdraws a package from force. The record stays. */
  retire(id: string): PackageEntry {
    this.db.sql
      .prepare("UPDATE conformance_packages SET activation_state = 'retired' WHERE tenant_id = ? AND id = ?")
      .run(this.db.tenantId, id);
    return this.require(id);
  }

  get(id: string): PackageEntry | undefined {
    const row = this.db.sql
      .prepare("SELECT * FROM conformance_packages WHERE tenant_id = ? AND id = ?")
      .get(this.db.tenantId, id) as unknown as Record<string, unknown> | undefined;
    return row ? rowToEntry(row) : undefined;
  }

  require(id: string): PackageEntry {
    const entry = this.get(id);
    if (!entry) throw new Refusal(`no conformance package ${id}`, 404);
    return entry;
  }

  list(opts: { state?: ActivationState } = {}): PackageEntry[] {
    const rows = opts.state
      ? this.db.sql
          .prepare(
            "SELECT * FROM conformance_packages WHERE tenant_id = ? AND activation_state = ? ORDER BY package_id, version"
          )
          .all(this.db.tenantId, opts.state)
      : this.db.sql
          .prepare("SELECT * FROM conformance_packages WHERE tenant_id = ? ORDER BY package_id, version")
          .all(this.db.tenantId);
    return (rows as unknown as Array<Record<string, unknown>>).map(rowToEntry);
  }

  /** What is actually in force. What the conformance page is generated from. */
  active(): PackageEntry[] {
    return this.list({ state: "active" });
  }

  /**
   * The public statement of what this deployment conforms to.
   *
   * Generated from the registry rather than written by hand, so it cannot
   * drift from what is installed — and it carries the objections alongside
   * each claim, because a conformance page that lists only the good news is
   * the artifact this whole module exists to avoid producing.
   */
  conformanceStatement(): {
    generatedAt: string;
    packages: Array<{
      packageId: string;
      version: string;
      canonicalUrl: string;
      fhirVersion: string | null;
      license: string | null;
      publicationStatus: PublicationStatus;
      checksumVerified: boolean;
      activatedAt: string | null;
      caveats: Objection[];
      overrideReason: string | null;
    }>;
    note: string;
  } {
    const active = this.active();
    return {
      generatedAt: new Date().toISOString(),
      packages: active.map((e) => ({
        packageId: e.packageId,
        version: e.version,
        canonicalUrl: e.canonicalUrl,
        fhirVersion: e.fhirVersion,
        license: e.license,
        publicationStatus: e.publicationStatus,
        checksumVerified: e.checksumVerified,
        activatedAt: e.activatedAt,
        caveats: this.objections(e),
        overrideReason: e.overrideReason,
      })),
      note:
        "Generated from the packages installed on this deployment. Listing a package means its rules are in force " +
        "here; it is not a statement that any external body has tested this implementation against them, and no " +
        "entry on this page should be read as a conformance certification.",
    };
  }
}
