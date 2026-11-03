/**
 * Portage became HealthSystem, and what a rename breaks when nobody checks.
 *
 * Every test here is a site that upgrades into the new name and must not
 * notice. That is the whole requirement: a rename is a marketing event, and a
 * marketing event has no business changing which database gets opened, which
 * backups can be found, whether TLS is on, or which tenant a token belongs to.
 *
 * What makes this worth its own file is that none of these failures are loud.
 * A missing environment variable does not error, it defaults. A database file
 * that is not there is created, empty. A snapshot lister that matches the
 * wrong prefix returns `[]`, which reads exactly like a site that has no
 * backups. Each one leaves the engine reporting healthy while doing something
 * nobody asked for, so each one gets pinned here rather than trusted.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import {
  readEnv,
  legacyEnvWarning,
  legacyEnvNamesInUse,
  resetLegacyEnvTracking,
  resolveDbPath,
  legacyDbNotice,
  backupFileName,
  BACKUP_FILE_RE,
  sortSnapshots,
  hl7ApplicationName,
  DB_FILENAME,
  LEGACY_DB_FILENAME,
} from "../src/core/naming.ts";
import { prune } from "../src/core/backup.ts";
import { latestSnapshot } from "../src/core/restore.ts";
import { latestRemoteName } from "../src/core/remote.ts";
import { snapshotTakenAt } from "../src/core/station.ts";
import { scopesFromSmart } from "../src/auth/scopes.ts";
import { JwtVerifier } from "../src/auth/jwt.ts";
import { buildAck, parseHl7 } from "../src/hl7/parser.ts";

function dir(tag: string): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), `healthsystem-rename-${tag}-`));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) };
}

/* ------------------------------------------------------------------ env --- */

test("a deployment still on PORTAGE_* keeps every value it configured", () => {
  // The dangerous half of this is not that the value moves — it is that it
  // goes absent. An unread PORTAGE_TLS_KEY does not throw; it turns TLS off on
  // a site that believed it had configured TLS.
  resetLegacyEnvTracking();
  const env = { PORTAGE_TLS_KEY: "/etc/ssl/site.key", PORTAGE_ENCRYPTED_AT_REST: "yes" };
  assert.equal(readEnv("TLS_KEY", env), "/etc/ssl/site.key");
  assert.equal(readEnv("ENCRYPTED_AT_REST", env), "yes");
  assert.deepEqual(legacyEnvNamesInUse(), ["PORTAGE_ENCRYPTED_AT_REST", "PORTAGE_TLS_KEY"]);
});

test("the new name wins where both are set, so migration can go one at a time", () => {
  resetLegacyEnvTracking();
  const env = { HEALTHSYSTEM_PORT: "9000", PORTAGE_PORT: "8686" };
  assert.equal(readEnv("PORT", env), "9000");
  assert.deepEqual(legacyEnvNamesInUse(), [], "the old one was never consulted, so it is not reported");
});

test("an empty string is a configured value, not an absence", () => {
  // `PORTAGE_BACKUP_REMOTE=` is an operator deliberately clearing a setting.
  // Treating it as unset would fall through to the new name and, if that were
  // also absent, to a default they had explicitly turned off.
  resetLegacyEnvTracking();
  assert.equal(readEnv("BACKUP_REMOTE", { PORTAGE_BACKUP_REMOTE: "" }), "");
  assert.equal(readEnv("NOTHING", {}), undefined);
});

test("the boot notice names the legacy variables rather than nagging about them", () => {
  resetLegacyEnvTracking();
  assert.equal(legacyEnvWarning(), null, "nothing to say when a site is fully migrated");
  readEnv("DATA", { PORTAGE_DATA: "/var/lib/portage" });
  const notice = legacyEnvWarning();
  assert.ok(notice);
  assert.match(notice!, /PORTAGE_DATA/);
  assert.match(notice!, /still work/, "supported, not deprecated-with-a-deadline");
});

/* ----------------------------------------------------------- database --- */

test("an existing portage.db is opened, not shadowed by an empty new one", () => {
  // The worst outcome in the rename. SQLite creates what it cannot open, so
  // the failure is not an error — it is a site that boots clean, reports
  // healthy, and has lost every patient in it.
  const d = dir("db");
  try {
    writeFileSync(join(d.path, LEGACY_DB_FILENAME), "");
    const choice = resolveDbPath(d.path);
    assert.equal(choice.path, join(d.path, LEGACY_DB_FILENAME));
    assert.equal(choice.legacy, true);
    const notice = legacyDbNotice(choice);
    assert.ok(notice);
    assert.match(notice!, /keeps its name and its data/);
    assert.match(notice!, /-wal and -shm/, "the sidecars are the step people skip");
  } finally {
    d.cleanup();
  }
});

test("a fresh install gets the new name", () => {
  const d = dir("fresh");
  try {
    const choice = resolveDbPath(d.path);
    assert.equal(choice.path, join(d.path, DB_FILENAME));
    assert.equal(choice.legacy, false);
    assert.equal(legacyDbNotice(choice), null);
  } finally {
    d.cleanup();
  }
});

test("a directory holding both prefers the new name and says nothing", () => {
  // The state a site lands in after renaming the file by hand. The old one may
  // linger as a copy somebody kept; the live database is the new one.
  const d = dir("both");
  try {
    writeFileSync(join(d.path, LEGACY_DB_FILENAME), "");
    writeFileSync(join(d.path, DB_FILENAME), "");
    const choice = resolveDbPath(d.path);
    assert.equal(choice.path, join(d.path, DB_FILENAME));
    assert.equal(choice.legacy, false);
  } finally {
    d.cleanup();
  }
});

/* ------------------------------------------------------------ backups --- */

test("snapshots taken under the old name are still found", () => {
  assert.ok(BACKUP_FILE_RE.test("portage-2026-01-01T00-00-00.db"));
  assert.ok(BACKUP_FILE_RE.test("healthsystem-2026-01-01T00-00-00.db"));
  assert.ok(!BACKUP_FILE_RE.test("something-else.db"));
  assert.equal(backupFileName("2026-01-01T00-00-00"), "healthsystem-2026-01-01T00-00-00.db");
});

test("mixed prefixes still sort by time, not alphabetically", () => {
  // The trap. Both listers relied on filenames sorting chronologically, which
  // they did while every name shared a prefix. Introduce a second prefix and
  // the property inverts silently: "n" sorts before "p", so today's snapshot
  // lands at the *oldest* end of the list.
  const names = [
    "portage-2026-01-01T00-00-00.db",
    "healthsystem-2026-03-01T00-00-00.db",
    "portage-2026-02-01T00-00-00.db",
  ];
  assert.deepEqual(sortSnapshots(names), [
    "portage-2026-01-01T00-00-00.db",
    "portage-2026-02-01T00-00-00.db",
    "healthsystem-2026-03-01T00-00-00.db",
  ]);
  assert.notDeepEqual(sortSnapshots(names), [...names].sort(), "a plain filename sort gets this wrong");
});

test("retention deletes the oldest across both prefixes, not the newest", () => {
  // Under a plain filename sort this test deletes today's backup and keeps a
  // two-month-old one, and the only symptom is a restore that comes back
  // further in the past than anybody expected.
  const d = dir("prune");
  try {
    const names = [
      "portage-2026-01-01T00-00-00.db",
      "portage-2026-02-01T00-00-00.db",
      "healthsystem-2026-03-01T00-00-00.db",
    ];
    for (const n of names) writeFileSync(join(d.path, n), "x");

    const removed = prune(d.path, 2);
    assert.deepEqual(removed.map((p) => p.split("/").pop()), ["portage-2026-01-01T00-00-00.db"]);
    assert.deepEqual(readdirSync(d.path).sort(), [
      "healthsystem-2026-03-01T00-00-00.db",
      "portage-2026-02-01T00-00-00.db",
    ]);
  } finally {
    d.cleanup();
  }
});

test("the newest snapshot is the newest one, whichever name it carries", () => {
  const d = dir("latest");
  try {
    writeFileSync(join(d.path, "healthsystem-2026-03-01T00-00-00.db"), "x");
    writeFileSync(join(d.path, "portage-2026-08-01T00-00-00.db"), "x");
    assert.ok(
      latestSnapshot(d.path)?.endsWith("portage-2026-08-01T00-00-00.db"),
      "an old-named snapshot taken later is still the later one"
    );
  } finally {
    d.cleanup();
  }
});

test("the remote store finds old-named replicas too", () => {
  const names = ["portage-2026-01-02T00-00-00.db.enc", "healthsystem-2026-01-03T00-00-00.db.enc"];
  assert.equal(latestRemoteName(names), "healthsystem-2026-01-03T00-00-00.db.enc");
  assert.equal(latestRemoteName(["portage-2026-01-02T00-00-00.db.enc"]), "portage-2026-01-02T00-00-00.db.enc");
});

test("a reading station reads the age off an old-named snapshot", () => {
  // Failing to parse the stamp falls back to the file's mtime, which is when
  // the copy was made rather than when the data was current — and that errs
  // toward reporting the chart as fresher than it is.
  const legacy = snapshotTakenAt("/backups/portage-2026-01-01T03-00-00.db");
  assert.equal(legacy.fromName, true);
  assert.equal(legacy.takenAt, "2026-01-01T03:00:00.000Z");
  const current = snapshotTakenAt("/backups/healthsystem-2026-01-01T03-00-00.db");
  assert.deepEqual(current, legacy);
});

/* --------------------------------------------------------------- auth --- */

test("an operator token carrying portage/admin is still an operator", () => {
  // The scope string lives in tokens already issued and in identity-provider
  // configuration this repository does not control. Dropping it would not fail
  // a token; it would silently demote somebody and 403 every admin call.
  assert.ok(scopesFromSmart(["portage/admin"]).has("admin"));
  assert.ok(scopesFromSmart(["healthsystem/admin"]).has("admin"));
  assert.ok(!scopesFromSmart(["someone/admin"]).has("admin"));
});

test("a token asserting portage_tenant still resolves to that tenant", async () => {
  // The one failure in this rename that ends with one site reading another's
  // charts. An unread tenant claim does not throw — it arrives absent, and
  // every downstream check then makes a tenancy decision on an absence.
  const idp = await fakeIdp();
  try {
    const verifier = new JwtVerifier({ issuer: idp.issuer, audience: "healthsystem" });

    const legacy = await verifier.verify(
      idp.sign({ sub: "rn-tetso", aud: "healthsystem", portage_tenant: "gnwt", portage_practitioner: "prac-1" })
    );
    assert.equal(legacy.tenantId, "gnwt");
    assert.equal(legacy.practitionerId, "prac-1");

    const current = await verifier.verify(
      idp.sign({ sub: "rn-tetso", aud: "healthsystem", healthsystem_tenant: "gnwt" })
    );
    assert.equal(current.tenantId, "gnwt");

    // Precedence: the prefixed claims exist for an issuer whose bare `tenant`
    // means something else, so the bare one must not shadow them.
    const both = await verifier.verify(
      idp.sign({ sub: "x", aud: "healthsystem", healthsystem_tenant: "new", portage_tenant: "old", tenant: "bare" })
    );
    assert.equal(both.tenantId, "new");
    const noNew = await verifier.verify(
      idp.sign({ sub: "x", aud: "healthsystem", portage_tenant: "old", tenant: "bare" })
    );
    assert.equal(noNew.tenantId, "old");
  } finally {
    await idp.close();
  }
});

/* ---------------------------------------------------------------- hl7 --- */

test("the rename does not touch what goes out on the wire", () => {
  // MSH-3 is the string a sending facility typed into their own interface
  // configuration. Changing it because the product changed name has a
  // hospital's engine reject our acknowledgements, and the symptom shows up at
  // their end as messages that were never acknowledged.
  const inbound =
    "MSH|^~\\&|WOLF|YKPCC|PORTAGE|GNWT|20260805103000||ADT^A01^ADT_A01|MSG1|P|2.5.1\rEVN|A01|20260805102900\r";
  assert.match(buildAck(parseHl7(inbound), "AA"), /\|PORTAGE\d+\|/, "the control-id prefix is unchanged by default");
  assert.equal(hl7ApplicationName({}), "PORTAGE");
});

test("a deployment that has agreed the change with its partners can move it", () => {
  assert.equal(hl7ApplicationName({ HEALTHSYSTEM_HL7_APPLICATION: "HEALTHSYSTEM" }), "HEALTHSYSTEM");
  assert.equal(hl7ApplicationName({ PORTAGE_HL7_APPLICATION: "SITE-A" }), "SITE-A");
});

/** Mints an RS256 JWT and serves the matching JWKS, standing in for an IdP. */
async function fakeIdp(): Promise<{
  issuer: string;
  sign(claims: Record<string, unknown>): string;
  close(): Promise<void>;
}> {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "test-key", alg: "RS256", use: "sig" };

  const server = createServer((req, res) => {
    if (req.url === "/.well-known/openid-configuration") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ issuer, jwks_uri: `${issuer}/jwks` }));
      return;
    }
    if (req.url === "/jwks") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    res.writeHead(404).end();
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const issuer = `http://127.0.0.1:${port}`;
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

  return {
    issuer,
    sign(claims) {
      const header = b64({ alg: "RS256", kid: "test-key", typ: "JWT" });
      const payload = b64({ iss: issuer, exp: Math.floor(Date.now() / 1000) + 300, ...claims });
      const sig = cryptoSign("sha256", Buffer.from(`${header}.${payload}`), privateKey);
      return `${header}.${payload}.${sig.toString("base64url")}`;
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}


test("Northstar configuration stays active, with explicit HealthSystem values taking precedence", () => {
  resetLegacyEnvTracking();
  assert.equal(readEnv("TLS_KEY", { NORTHSTAR_TLS_KEY: "/existing/tls.key" }), "/existing/tls.key");
  assert.equal(readEnv("HOST", { NORTHSTAR_HOST: "127.0.0.1", PORTAGE_HOST: "0.0.0.0" }), "127.0.0.1");
  assert.deepEqual(legacyEnvNamesInUse(), ["NORTHSTAR_HOST", "NORTHSTAR_TLS_KEY"]);
  assert.match(legacyEnvWarning()!, /HEALTHSYSTEM_/);
  assert.equal(readEnv("PORT", { HEALTHSYSTEM_PORT: "9001", NORTHSTAR_PORT: "9000", PORTAGE_PORT: "8686" }), "9001");
  assert.equal(readEnv("BACKUP_REMOTE", { HEALTHSYSTEM_BACKUP_REMOTE: "", NORTHSTAR_BACKUP_REMOTE: "fs:/old" }), "");
  assert.equal(hl7ApplicationName({ NORTHSTAR_HL7_APPLICATION: "LAB-AGREED" }), "LAB-AGREED");
});

test("HealthSystem reuses northstar.db before portage.db without creating another database", () => {
  const d = dir("northstar-db");
  try {
    writeFileSync(join(d.path, "portage.db"), "old");
    writeFileSync(join(d.path, "northstar.db"), "existing");
    assert.deepEqual(resolveDbPath(d.path), { path: join(d.path, "northstar.db"), legacy: true });
    assert.equal(readdirSync(d.path).length, 2);
    writeFileSync(join(d.path, "healthsystem.db"), "current");
    assert.deepEqual(resolveDbPath(d.path), { path: join(d.path, "healthsystem.db"), legacy: false });
  } finally { d.cleanup(); }
});

test("backups across all three names remain discoverable and retain by timestamp", () => {
  const d = dir("three-backups");
  try {
    const names = ["portage-2026-01-01T00-00-00.db", "healthsystem-2026-02-01T00-00-00.db", "northstar-2026-03-01T00-00-00.db"];
    for (const name of names) {
      writeFileSync(join(d.path, name), "x");
      assert.ok(BACKUP_FILE_RE.test(name));
      assert.equal(snapshotTakenAt(join(d.path, name)).fromName, true);
    }
    assert.deepEqual(sortSnapshots([...names].reverse()), names);
    assert.ok(latestSnapshot(d.path)?.endsWith(names[2]));
    assert.equal(latestRemoteName(names.map(n => n + ".enc")), names[2] + ".enc");
    prune(d.path, 2);
    assert.deepEqual(readdirSync(d.path).sort(), names.slice(1));
  } finally { d.cleanup(); }
});

test("existing Northstar tokens retain scopes and tenant, organization and practitioner bindings", async () => {
  assert.ok(scopesFromSmart(["northstar/admin"]).has("admin"));
  const idp = await fakeIdp();
  try {
    const verifier = new JwtVerifier({ issuer: idp.issuer, audience: "northstar-existing-deployment" });
    const verified = await verifier.verify(idp.sign({ sub: "operator", aud: "northstar-existing-deployment", scope: "northstar/admin",
      northstar_tenant: "existing", northstar_organization: "org", northstar_practitioner: "practitioner" }));
    assert.equal(verified.tenantId, "existing");
    assert.equal(verified.organizationId, "org");
    assert.equal(verified.practitionerId, "practitioner");
    assert.ok(verified.scopes.has("admin"));
    const current = await verifier.verify(idp.sign({ aud: "northstar-existing-deployment",
      healthsystem_tenant: "current", northstar_tenant: "previous", portage_tenant: "old", tenant: "bare" }));
    assert.equal(current.tenantId, "current");
  } finally { await idp.close(); }
});


test("the singular name preserves plural configuration, databases and snapshots", () => {
  resetLegacyEnvTracking();
  assert.equal(readEnv("HOST", { HEALTHSYSTEMS_HOST: "127.0.0.1" }), "127.0.0.1");
  assert.deepEqual(legacyEnvNamesInUse(), ["HEALTHSYSTEMS_HOST"]);
  assert.equal(readEnv("PORT", { HEALTHSYSTEM_PORT: "9001", HEALTHSYSTEMS_PORT: "9000" }), "9001");
  assert.equal(readEnv("BACKUP_REMOTE", { HEALTHSYSTEM_BACKUP_REMOTE: "", HEALTHSYSTEMS_BACKUP_REMOTE: "fs:/old" }), "");
  const d = dir("plural-compat");
  try {
    writeFileSync(join(d.path, "healthsystems.db"), "existing");
    assert.deepEqual(resolveDbPath(d.path), { path: join(d.path, "healthsystems.db"), legacy: true });
    assert.equal(readdirSync(d.path).length, 1);
    writeFileSync(join(d.path, "healthsystem.db"), "current");
    assert.deepEqual(resolveDbPath(d.path), { path: join(d.path, "healthsystem.db"), legacy: false });
  } finally { d.cleanup(); }
  assert.ok(BACKUP_FILE_RE.test("healthsystems-2026-01-01T00-00-00.db"));
  assert.equal(latestRemoteName(["healthsystem-2026-01-01T00-00-00.db.enc", "healthsystems-2026-02-01T00-00-00.db.enc"]), "healthsystems-2026-02-01T00-00-00.db.enc");
  assert.equal(snapshotTakenAt("/backups/healthsystems-2026-01-01T00-00-00.db").fromName, true);
});

test("plural token claims retain their scope and organizational bindings", async () => {
  const idp = await fakeIdp();
  try {
    const verifier = new JwtVerifier({ issuer: idp.issuer, audience: "existing-deployment" });
    const verified = await verifier.verify(idp.sign({ aud: "existing-deployment", scope: "healthsystems/admin",
      healthsystems_tenant: "existing", healthsystems_organization: "org", healthsystems_practitioner: "practitioner" }));
    assert.ok(verified.scopes.has("admin"));
    assert.equal(verified.tenantId, "existing");
    assert.equal(verified.organizationId, "org");
    assert.equal(verified.practitionerId, "practitioner");
    const current = await verifier.verify(idp.sign({ aud: "existing-deployment", healthsystem_tenant: "current", healthsystems_tenant: "old" }));
    assert.equal(current.tenantId, "current");
  } finally { await idp.close(); }
});
