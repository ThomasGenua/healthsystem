/**
 * Two custodians on one node, trying to reach each other.
 *
 * `test/tenant-scoping.test.ts` proves no statement *can* omit a tenant. That
 * is the stronger guarantee of the two, because it holds for methods nobody
 * wrote a test for — but it only checks that the word appears in the SQL, not
 * that the resulting queries actually separate anyone. These are the other
 * half: two tenants seeded with colliding identifiers, and every accessor
 * asked whether it leaks.
 *
 * The identifiers collide on purpose. A patient id, a channel id, a message
 * and a subscription are all only meaningful inside the custodian that issued
 * them, so `Patient/p1` existing in two tenants is the normal case, not an
 * edge one — and it is precisely the case where a query that forgets its scope
 * returns the wrong patient rather than no patient. A test using distinct ids
 * everywhere would pass against code with no isolation at all.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db, DEFAULT_TENANT } from "../src/db.ts";
import { FhirStore } from "../src/fhir/store.ts";
import { AuditStore } from "../src/audit/store.ts";

/** Two tenants, each holding a patient and a channel of the same name. */
function twoTenants(): { north: Db; south: Db; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "portage-iso-"));
  const root = new Db(join(dir, "portage.db"));
  root.createTenant("north", "Northern Health", "Northern Regional Custodian");
  root.createTenant("south", "Southern Health", "Southern Regional Custodian");

  const north = root.forTenant("north");
  const south = root.forTenant("south");
  for (const [db, who] of [
    [north, "north"],
    [south, "south"],
  ] as const) {
    db.upsertChannel("adt", "admissions", true, "{}");
    db.insertMessage("adt", "mllp", "text/plain", `admission at ${who}`);
    new FhirStore(db).upsert({
      resourceType: "Patient",
      id: "p1",
      identifier: [{ system: "https://ehealth.gov.nt.ca/fhir/NamingSystem/nwt-hcn", value: "NT123456" }],
      name: [{ family: who }],
    });
    new AuditStore(db).record({
      action: "R",
      principalId: `${who}-clinician`,
      principalKind: "apikey",
      method: "GET",
      path: "/fhir/Patient/p1",
      resourceType: "Patient",
      resourceId: "p1",
      patient: "NT123456",
    });
  }

  return {
    north,
    south,
    cleanup: () => {
      root.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("a message log shows only its own tenant's messages", () => {
  const { north, south, cleanup } = twoTenants();
  try {
    const seen = (db: Db) => db.listMessages({}).map((m) => m.raw);
    assert.deepEqual(seen(north), ["admission at north"]);
    assert.deepEqual(seen(south), ["admission at south"]);

    // And filtering by a channel that exists in both does not widen it.
    assert.deepEqual(
      north.listMessages({ channelId: "adt" }).map((m) => m.raw),
      ["admission at north"]
    );
    assert.equal(north.countMessages("adt"), 1);
  } finally {
    cleanup();
  }
});

test("a patient id that exists in both tenants resolves to the right patient", () => {
  // The case that matters most. With no isolation this returns one custodian's
  // patient to the other under a name that looks entirely plausible.
  const { north, south, cleanup } = twoTenants();
  try {
    const nf = new FhirStore(north);
    const sf = new FhirStore(south);

    assert.equal((nf.get("Patient", "p1") as { name: Array<{ family: string }> }).name[0].family, "north");
    assert.equal((sf.get("Patient", "p1") as { name: Array<{ family: string }> }).name[0].family, "south");

    // Searching by a health number both custodians hold finds one each.
    for (const [store, who] of [
      [nf, "north"],
      [sf, "south"],
    ] as const) {
      const found = store.search("Patient", { identifier: "NT123456" });
      assert.equal(found.total, 1, `${who} must see exactly its own patient`);
      assert.equal((found.resources[0] as { name: Array<{ family: string }> }).name[0].family, who);
    }

    // And the counts an operator sees are their own.
    assert.deepEqual(nf.resourceTypes().find((r) => r.type === "Patient"), { type: "Patient", count: 1 });
  } finally {
    cleanup();
  }
});

test("writing a patient under one tenant does not overwrite the other's", () => {
  // What the primary-key rebuild is for. Before it, the second write replaced
  // the first custodian's record silently and version history looked normal.
  const { north, south, cleanup } = twoTenants();
  try {
    new FhirStore(north).upsert({ resourceType: "Patient", id: "p1", name: [{ family: "north-updated" }] });

    assert.equal(
      (new FhirStore(south).get("Patient", "p1") as { name: Array<{ family: string }> }).name[0].family,
      "south",
      "the other custodian's record must be untouched"
    );
  } finally {
    cleanup();
  }
});

test("an audit trail answers only for its own tenant, and chains separately", () => {
  const { north, south, cleanup } = twoTenants();
  try {
    const na = new AuditStore(north);
    const sa = new AuditStore(south);

    assert.equal(na.count(), 1);
    assert.deepEqual(
      na.list({}).map((r) => r.principal_id),
      ["north-clinician"]
    );
    // Searching by a patient identifier both custodians hold must not disclose
    // that the other one looked at their own patient of the same number.
    assert.deepEqual(
      na.list({ patient: "NT123456" }).map((r) => r.principal_id),
      ["north-clinician"]
    );

    // Each chain verifies on its own terms, and neither counts the other's
    // rows — which is what broke when the check used a shared counter.
    assert.deepEqual(na.verifyChain().ok, true);
    assert.deepEqual(sa.verifyChain().ok, true);
    assert.equal(na.verifyChain().checked, 1);
    assert.notEqual(na.verifyChain().tip, sa.verifyChain().tip, "separate chains, separate tips");
  } finally {
    cleanup();
  }
});

test("hash chains are per tenant even when the channel id is shared", () => {
  const { north, south, cleanup } = twoTenants();
  try {
    assert.equal(north.verifyChain("adt").ok, true);
    assert.equal(north.verifyChain("adt").checked, 1, "one custodian's chain is not lengthened by the other's");
    assert.equal(south.verifyChain("adt").checked, 1);
    assert.notEqual(north.verifyChain("adt").tip, south.verifyChain("adt").tip);
  } finally {
    cleanup();
  }
});

test("a retention sweep in one tenant leaves the other's data alone", () => {
  // A privacy control that reached across custodians would destroy records
  // under a policy their custodian never set.
  const { north, south, cleanup } = twoTenants();
  try {
    const swept = north.redactBefore("2099-01-01T00:00:00Z");
    assert.equal(swept.messages, 1);

    assert.equal(north.listMessages({})[0].raw, "[redacted]");
    assert.equal(south.listMessages({})[0].raw, "admission at south", "the other custodian keeps its record");
  } finally {
    cleanup();
  }
});

test("a purge in one tenant does not delete the other's messages", () => {
  const { north, south, cleanup } = twoTenants();
  try {
    north.sql.exec("UPDATE messages SET received_at = '2020-01-01 00:00:00'");
    const purged = north.purgeBefore("2021-01-01 00:00:00");
    assert.equal(purged.messages, 1);
    assert.equal(south.listMessages({}).length, 1, "the sweep must stop at the boundary");
  } finally {
    cleanup();
  }
});

test("keys, subscriptions and channel state stay inside their tenant", () => {
  const { north, south, cleanup } = twoTenants();
  try {
    north.insertApiKey("k-north", "north key", "hash-north", ["admin"]);
    south.insertApiKey("k-south", "south key", "hash-south", ["read"]);
    assert.deepEqual(
      north.listApiKeys().map((k) => k.id),
      ["k-north"]
    );
    assert.equal(north.countActiveApiKeys(), 1);
    assert.equal(north.revokeApiKey("k-south"), false, "revoking across a boundary must fail, not succeed quietly");
    assert.equal(south.listApiKeys()[0].revoked_at, null);

    north.insertSubscription({ id: "s1", status: "active", criteria: "Patient", endpoint: "http://x/1", payload: "" });
    south.insertSubscription({ id: "s1", status: "active", criteria: "Patient", endpoint: "http://y/1", payload: "" });
    assert.equal(north.getSubscription("s1")!.endpoint, "http://x/1");
    assert.equal(south.getSubscription("s1")!.endpoint, "http://y/1");
    assert.equal(north.listSubscriptions().length, 1);

    north.setChannelState("adt", "cursor", "100");
    south.setChannelState("adt", "cursor", "999");
    assert.equal(north.getChannelState("adt", "cursor"), "100");
    assert.equal(south.getChannelState("adt", "cursor"), "999");
  } finally {
    cleanup();
  }
});

test("statistics and health signals report a tenant's own node, not the platform's", () => {
  const { north, south, cleanup } = twoTenants();
  try {
    const stats = north.stats() as { channels: number; messages: Record<string, number> };
    assert.equal(stats.channels, 1, "a custodian counts its own channels");
    assert.equal(Object.values(stats.messages).reduce((a, b) => a + b, 0), 1);

    assert.equal(north.healthSignals().deadLetters, 0);
    assert.equal(south.listChannels().length, 1);
  } finally {
    cleanup();
  }
});

test("a handle for a tenant that was never created reads nothing rather than everything", () => {
  // The dangerous failure would be a missing tenant matching no predicate and
  // therefore matching everything, or being brought into existence by being
  // asked for.
  const { north, cleanup } = twoTenants();
  try {
    const ghost = north.forTenant("does-not-exist");
    assert.deepEqual(ghost.listMessages({}), []);
    assert.deepEqual(ghost.listChannels(), []);
    assert.equal(ghost.countMessages("adt"), 0);
    assert.equal(new FhirStore(ghost).get("Patient", "p1"), undefined);
    assert.equal(north.getTenant("does-not-exist"), undefined, "and asking must not create it");
  } finally {
    cleanup();
  }
});

test("the default tenant is not a wildcard", () => {
  // It is where pre-tenancy rows land, which makes it the obvious candidate
  // for someone to treat as "all of them".
  const { north, cleanup } = twoTenants();
  try {
    const def = north.forTenant(DEFAULT_TENANT);
    assert.deepEqual(def.listMessages({}), [], "the default tenant sees only its own rows, which here are none");
  } finally {
    cleanup();
  }
});

test("forTenant returns the same handle for the same tenant, and a distinct one otherwise", () => {
  const { north, cleanup } = twoTenants();
  try {
    assert.equal(north.forTenant("north"), north);
    const other = north.forTenant("south");
    assert.notEqual(other, north);
    assert.equal(other.tenantId, "south");
    assert.equal(north.tenantId, "north", "and the original is not mutated");
    // Sharing the connection is the point: one writer, one instance lock.
    assert.equal(other.sql, north.sql);
  } finally {
    cleanup();
  }
});
