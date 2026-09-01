/**
 * What this deployment claims to conform to, and whether the claim is checkable.
 *
 * The failure being prevented is a conformance page that lists a publisher's
 * implementation guide, at a version, as though somebody had confirmed it —
 * when the pack was hand-written from a reading of the spec, the version was
 * typed from memory, and the bytes were never hashed. That page is worse than
 * no page, because it is the one an integration partner cites back at you.
 *
 * So the registry separates three things a conformance claim runs together:
 * that an artifact exists, that these bytes are that artifact, and that
 * somebody decided it governs here. Each is a distinct column and only the
 * second can be established by computation.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../src/db.ts";
import { StandardsRegistry, versionIsMutable } from "../src/conformance/standards.ts";
import { Refusal } from "../src/core/refusal.ts";

const OPS = "ops-lachance";
const BYTES = "a package tarball, as bytes";
const SUM = createHash("sha256").update(BYTES).digest("hex");

function site() {
  const dir = mkdtempSync(join(tmpdir(), "northstar-std-"));
  const db = new Db(join(dir, "northstar.db"));
  return {
    db,
    reg: new StandardsRegistry(db),
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}

const IPA = {
  canonicalUrl: "http://hl7.org/fhir/uv/ipa/",
  packageId: "hl7.fhir.uv.ipa",
  version: "1.1.0",
  publicationStatus: "release" as const,
  fhirVersion: "4.0.1",
  license: "CC0-1.0",
  checksum: SUM,
};

// ── Registering is not activating ─────────────────────────────────────────

test("registering records the artifact and puts nothing into force", () => {
  const s = site();
  try {
    const entry = s.reg.register(IPA);
    assert.equal(entry.activationState, "registered");
    assert.equal(entry.checksumVerified, false, "a checksum the publisher stated is not one this system computed");
    assert.deepEqual(s.reg.active(), [], "nothing is in force merely by being known");
    assert.deepEqual(s.reg.conformanceStatement().packages, []);
  } finally {
    s.cleanup();
  }
});

test("a package cannot be registered without the identity needed to resolve it", () => {
  const s = site();
  try {
    assert.throws(() => s.reg.register({ ...IPA, canonicalUrl: "" }), /canonicalUrl is required/);
    assert.throws(() => s.reg.register({ ...IPA, packageId: "  " }), /packageId is required/);
    assert.throws(() => s.reg.register({ ...IPA, version: "" }), /version is required/);
  } finally {
    s.cleanup();
  }
});

test("the same package version cannot be registered twice", () => {
  // Two rows for one version could disagree about its checksum, and both
  // would look authoritative.
  const s = site();
  try {
    s.reg.register(IPA);
    assert.throws(() => s.reg.register(IPA), /UNIQUE|constraint/i);
  } finally {
    s.cleanup();
  }
});

// ── Verification is computation, not assertion ────────────────────────────

test("a checksum is verified by hashing the artifact, not by being recorded", () => {
  const s = site();
  try {
    const entry = s.reg.register(IPA);
    assert.equal(entry.checksumVerified, false);
    const verified = s.reg.verify(entry.id, BYTES);
    assert.equal(verified.checksumVerified, true);
  } finally {
    s.cleanup();
  }
});

test("bytes that do not match are refused, and leave the package unverified", () => {
  const s = site();
  try {
    const entry = s.reg.register(IPA);
    assert.throws(
      () => s.reg.verify(entry.id, "a different tarball entirely"),
      (err: unknown) => err instanceof Refusal && err.status === 409 && /does not match/.test(err.message),
    );
    assert.equal(s.reg.require(entry.id).checksumVerified, false, "a failed verification proves nothing");
  } finally {
    s.cleanup();
  }
});

test("a package registered without a checksum cannot be verified at all", () => {
  const s = site();
  try {
    const { checksum: _dropped, ...noSum } = IPA;
    const entry = s.reg.register(noSum);
    assert.throws(() => s.reg.verify(entry.id, BYTES), /nothing to verify these bytes against/);
  } finally {
    s.cleanup();
  }
});

// ── What is refused, and the one way past it ──────────────────────────────

test("an unverified package is refused activation, and the refusal says why", () => {
  // The state every entry is in on a deployment that cannot reach a package
  // registry — which is the state this registry was written in.
  const s = site();
  try {
    const entry = s.reg.register(IPA);
    assert.deepEqual(s.reg.objections(entry).map((o) => o.code), ["unverified-checksum"]);
    assert.throws(
      () => s.reg.activate({ id: entry.id, reason: "putting IPA into force here", by: OPS }),
      (err: unknown) => err instanceof Refusal && err.status === 409 && /unverified-checksum/.test(err.message),
    );
    assert.equal(s.reg.require(entry.id).activationState, "registered");
  } finally {
    s.cleanup();
  }
});

test("a ballot or draft is refused, because it is not something to conform to", () => {
  const s = site();
  try {
    for (const status of ["ballot", "draft", "unknown"] as const) {
      const entry = s.reg.register({ ...IPA, version: `9.9.9-${status}`, publicationStatus: status });
      s.reg.verify(entry.id, BYTES);
      assert.ok(
        s.reg.objections(entry).some((o) => o.code === "not-a-release") ||
          s.reg.objections(s.reg.require(entry.id)).some((o) => o.code === "not-a-release"),
        `${status} should object`,
      );
      assert.throws(
        () => s.reg.activate({ id: entry.id, reason: "putting this into force here", by: OPS }),
        /not-a-release/,
      );
    }
  } finally {
    s.cleanup();
  }
});

test("a version that names a moving target is refused", () => {
  // Conformance to "current" cannot be checked later, because what it
  // resolved to when the claim was made is gone.
  for (const v of ["current", "latest", "dev", "main", "1.2.x", "2.0.0-snapshot", ""]) {
    assert.equal(versionIsMutable(v), true, `${v} should be mutable`);
  }
  for (const v of ["1.1.0", "2.0.1", "4.0.1"]) {
    assert.equal(versionIsMutable(v), false, `${v} should be a fixed version`);
  }

  const s = site();
  try {
    const entry = s.reg.register({ ...IPA, version: "current" });
    s.reg.verify(entry.id, BYTES);
    assert.throws(
      () => s.reg.activate({ id: entry.id, reason: "tracking the continuous build", by: OPS }),
      /mutable-version/,
    );
  } finally {
    s.cleanup();
  }
});

test("an override activates over objections, in writing, and the exception stays visible", () => {
  const s = site();
  try {
    const entry = s.reg.register(IPA);
    // Not a way round the written-reason requirement.
    assert.throws(() => s.reg.activate({ id: entry.id, reason: "ok", by: OPS, override: "fine" }), /written reason/);
    assert.throws(
      () => s.reg.activate({ id: entry.id, reason: "putting IPA into force here", by: OPS, override: "yes" }),
      /Supply a written override/,
    );

    const active = s.reg.activate({
      id: entry.id,
      reason: "putting IPA into force for the patient-access slice",
      by: OPS,
      override: "package received on physical media; no registry route from this network",
    });
    assert.equal(active.activationState, "active");
    assert.match(active.overrideReason ?? "", /physical media/);

    // And the public statement carries the caveat rather than only the claim.
    const statement = s.reg.conformanceStatement();
    assert.equal(statement.packages.length, 1);
    assert.equal(statement.packages[0].checksumVerified, false);
    assert.deepEqual(statement.packages[0].caveats.map((c) => c.code), ["unverified-checksum"]);
    assert.match(statement.packages[0].overrideReason ?? "", /physical media/);
    assert.match(statement.note, /not a statement that any external body has tested/);
  } finally {
    s.cleanup();
  }
});

test("a verified release activates with no override at all", () => {
  const s = site();
  try {
    const entry = s.reg.register(IPA);
    s.reg.verify(entry.id, BYTES);
    const active = s.reg.activate({ id: entry.id, reason: "putting IPA into force here", by: OPS });
    assert.equal(active.activationState, "active");
    assert.equal(active.overrideReason, null);
    assert.deepEqual(s.reg.conformanceStatement().packages[0].caveats, []);
  } finally {
    s.cleanup();
  }
});

// ── One version in force at a time ────────────────────────────────────────

test("activating a second version retires the first, and never runs both", () => {
  // Two versions of one guide active at once is not a configuration; it is a
  // question nobody can answer about which rules applied to a given resource.
  const s = site();
  try {
    const first = s.reg.register(IPA);
    s.reg.verify(first.id, BYTES);
    s.reg.activate({ id: first.id, reason: "putting 1.1.0 into force here", by: OPS });

    const second = s.reg.register({ ...IPA, version: "1.2.0" });
    s.reg.verify(second.id, BYTES);
    s.reg.activate({ id: second.id, reason: "upgrading to 1.2.0 after review", by: OPS });

    const active = s.reg.active();
    assert.equal(active.length, 1, "one version of the package in force");
    assert.equal(active[0].version, "1.2.0");
    assert.equal(s.reg.require(first.id).activationState, "retired", "the earlier version is retired, not deleted");
  } finally {
    s.cleanup();
  }
});

test("the database refuses two active versions even if the code were to try", () => {
  const s = site();
  try {
    const first = s.reg.register(IPA);
    s.reg.verify(first.id, BYTES);
    s.reg.activate({ id: first.id, reason: "putting 1.1.0 into force here", by: OPS });
    const second = s.reg.register({ ...IPA, version: "1.2.0" });

    assert.throws(
      () =>
        s.db.sql
          .prepare("UPDATE conformance_packages SET activation_state = 'active' WHERE tenant_id = ? AND id = ?")
          .run("default", second.id),
      /UNIQUE|constraint/i,
    );
  } finally {
    s.cleanup();
  }
});

test("activating something already active is refused rather than repeated", () => {
  const s = site();
  try {
    const entry = s.reg.register(IPA);
    s.reg.verify(entry.id, BYTES);
    s.reg.activate({ id: entry.id, reason: "putting IPA into force here", by: OPS });
    assert.throws(
      () => s.reg.activate({ id: entry.id, reason: "putting IPA into force again", by: OPS }),
      /already active/,
    );
  } finally {
    s.cleanup();
  }
});

// ── Tenancy ───────────────────────────────────────────────────────────────

test("one site's activated package is not another site's", () => {
  const s = site();
  try {
    const entry = s.reg.register(IPA);
    s.reg.verify(entry.id, BYTES);
    s.reg.activate({ id: entry.id, reason: "putting IPA into force here", by: OPS });

    const other = new StandardsRegistry(s.db.forTenant("yellowknife"));
    assert.deepEqual(other.active(), [], "the other site conforms to nothing yet");
    assert.deepEqual(other.list(), []);
    assert.deepEqual(other.conformanceStatement().packages, []);
    assert.throws(() => other.require(entry.id), /no conformance package/);

    // And each site can hold a different version in force.
    const theirs = other.register({ ...IPA, version: "1.0.0" });
    other.verify(theirs.id, BYTES);
    other.activate({ id: theirs.id, reason: "this site is still on 1.0.0", by: "ops-yk" });
    assert.equal(s.reg.active()[0].version, "1.1.0");
    assert.equal(other.active()[0].version, "1.0.0");
  } finally {
    s.cleanup();
  }
});

// ── The generated page ────────────────────────────────────────────────────

test("the conformance page is generated from what is installed, not written by hand", () => {
  const s = site();
  try {
    const entry = s.reg.register(IPA);
    s.reg.verify(entry.id, BYTES);
    s.reg.activate({ id: entry.id, reason: "putting IPA into force here", by: OPS });

    const page = s.reg.conformanceStatement();
    assert.equal(page.packages[0].packageId, "hl7.fhir.uv.ipa");
    assert.equal(page.packages[0].version, "1.1.0");
    assert.equal(page.packages[0].canonicalUrl, "http://hl7.org/fhir/uv/ipa/");
    assert.equal(page.packages[0].fhirVersion, "4.0.1");

    // Retiring it removes the claim, without a second place to edit.
    s.reg.retire(entry.id);
    assert.deepEqual(s.reg.conformanceStatement().packages, []);
  } finally {
    s.cleanup();
  }
});
