/**
 * Two custodians reaching the API with each other's identifiers.
 *
 * `tenant-isolation.test.ts` proves the stores separate. This is the layer
 * above: a credential is issued by a tenant, and every route it reaches has to
 * be confined to that tenant — resolved from the stored key, never from
 * anything on the request, because a caller who can name their tenant is
 * naming their own authorisation.
 *
 * The identifiers collide throughout, for the same reason as before: the
 * dangerous answer is not an error, it is the *other* custodian's patient
 * returned under a plausible name.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../src/core/engine.ts";
import { startApi } from "../src/api/admin.ts";
import { AuthGate } from "../src/auth/gate.ts";

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), "portage-tapi-"));
  const engine = new Engine({ dbPath: join(dir, "portage.db"), tickMs: 100_000 });
  await engine.start();
  engine.db.createTenant("north", "Northern Health");
  engine.db.createTenant("south", "Southern Health");

  const north = engine.forTenant("north");
  const south = engine.forTenant("south");
  const keys = {
    north: north.keys.issue("north-admin", ["admin"]).key,
    south: south.keys.issue("south-admin", ["admin"]).key,
  };

  // Each custodian holds a patient of the same id, with the same health
  // number, under a different name.
  for (const [view, who] of [
    [north, "north"],
    [south, "south"],
  ] as const) {
    view.db.upsertChannel("adt", "admissions", true, "{}");
    view.db.insertMessage("adt", "mllp", "text/plain", `admission at ${who}`);
    view.fhir.upsert({
      resourceType: "Patient",
      id: "p1",
      identifier: [{ system: "urn:jhn", value: "NT123456" }],
      name: [{ family: who }],
    });
  }

  const api = await startApi(engine, 0, "127.0.0.1", {
    auth: new AuthGate({ keys: engine.keys, tenants: engine.db }),
  });
  const hdr = (key: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${key}`, ...extra });
  return {
    engine,
    keys,
    hdr,
    base: `http://127.0.0.1:${api.port}`,
    close: async () => {
      await api.close();
      await engine.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("a read returns the caller's own patient, not the other custodian's", async () => {
  const { base, keys, hdr, close } = await boot();
  try {
    for (const who of ["north", "south"] as const) {
      const res = await fetch(`${base}/fhir/Patient/p1`, { headers: hdr(keys[who]) });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { name: Array<{ family: string }> };
      assert.equal(body.name[0].family, who, `${who} must be served its own record`);
    }
  } finally {
    await close();
  }
});

test("a search on a health number both custodians hold returns one result each", async () => {
  const { base, keys, hdr, close } = await boot();
  try {
    for (const who of ["north", "south"] as const) {
      const body = (await (
        await fetch(`${base}/fhir/Patient?identifier=NT123456`, { headers: hdr(keys[who]) })
      ).json()) as { total: number; entry: Array<{ resource: { name: Array<{ family: string }> } }> };
      assert.equal(body.total, 1, `${who} must not see the other custodian's patient of the same number`);
      assert.equal(body.entry[0].resource.name[0].family, who);
    }
  } finally {
    await close();
  }
});

test("messages, channels and keys are the caller's own", async () => {
  const { base, keys, hdr, close } = await boot();
  try {
    const msgs = (await (await fetch(`${base}/api/messages`, { headers: hdr(keys.north) })).json()) as Array<{
      raw: string;
    }>;
    assert.deepEqual(msgs.map((m) => m.raw), ["admission at north"]);

    const listed = (await (await fetch(`${base}/api/keys`, { headers: hdr(keys.north) })).json()) as Array<{
      name: string;
    }>;
    assert.deepEqual(listed.map((k) => k.name), ["north-admin"], "and a custodian sees only its own credentials");
  } finally {
    await close();
  }
});

test("an admin key cannot revoke another custodian's key", async () => {
  // Full admin scope, and still confined. Scope says what a caller may do;
  // the tenant says who they may do it to.
  const { engine, base, keys, hdr, close } = await boot();
  try {
    const id = engine.forTenant("south").keys.list()[0].id;

    const res = await fetch(`${base}/api/keys/${id}`, { method: "DELETE", headers: hdr(keys.north) });
    assert.equal(res.status, 404, "reaching across a boundary must fail, not succeed quietly");
    assert.equal(engine.forTenant("south").keys.list()[0].revoked_at, null);
  } finally {
    await close();
  }
});

test("the audit trail records the caller's tenant and answers only for it", async () => {
  const { engine, base, keys, hdr, close } = await boot();
  try {
    await fetch(`${base}/fhir/Patient/p1`, { headers: hdr(keys.north) });
    await fetch(`${base}/fhir/Patient/p1`, { headers: hdr(keys.south) });

    const trail = (await (await fetch(`${base}/api/audit`, { headers: hdr(keys.north) })).json()) as Array<{
      principal_id: string;
    }>;
    const northKeyId = engine.forTenant("north").keys.list()[0].id;
    assert.ok(trail.length >= 1);
    assert.ok(
      trail.every((r) => r.principal_id === northKeyId),
      "one custodian's trail must not disclose that another looked at their own patient"
    );

    // Both trails verify independently.
    assert.equal(engine.forTenant("north").audit.verifyChain().ok, true);
    assert.equal(engine.forTenant("south").audit.verifyChain().ok, true);
  } finally {
    await close();
  }
});

test("a declared purpose of use is recorded, and an invented one is not", async () => {
  const { engine, base, keys, hdr, close } = await boot();
  try {
    await fetch(`${base}/fhir/Patient/p1`, { headers: hdr(keys.north, { "x-purpose-of-use": "TREAT" }) });
    await fetch(`${base}/fhir/Patient/p1`, { headers: hdr(keys.north, { "x-purpose-of-use": "just curious" }) });
    await fetch(`${base}/fhir/Patient/p1`, { headers: hdr(keys.north) });

    const rows = engine.forTenant("north").audit.list({ limit: 10 }).reverse();
    assert.equal(rows[0].purpose_of_use, "TREAT");
    assert.equal(rows[1].purpose_of_use, null, "an unrecognised purpose is dropped, not stored as typed");
    assert.equal(rows[2].purpose_of_use, null, "and declining to say is recorded as declining to say");

    // It is covered by the chain, so it cannot be edited after the fact.
    assert.equal(engine.forTenant("north").audit.verifyChain().ok, true);
    engine.db.sql.exec("UPDATE audit_events SET purpose_of_use = 'HRESCH' WHERE purpose_of_use = 'TREAT'");
    assert.equal(
      engine.forTenant("north").audit.verifyChain().ok,
      false,
      "rewriting why someone looked must break verification"
    );
  } finally {
    await close();
  }
});

test("a suspended custodian's credentials stop working immediately", async () => {
  // Section 13 wants a tenant suspended without touching anyone else. That is
  // worth nothing if its keys keep opening doors until the next restart.
  const { engine, base, keys, hdr, close } = await boot();
  try {
    assert.equal((await fetch(`${base}/fhir/Patient/p1`, { headers: hdr(keys.south) })).status, 200);

    assert.equal(engine.db.setTenantStatus("south", "suspended"), true);

    const refused = await fetch(`${base}/fhir/Patient/p1`, { headers: hdr(keys.south) });
    assert.equal(refused.status, 403);
    assert.match(((await refused.json()) as { error: string }).error, /suspended/);

    // And nobody else is affected.
    assert.equal((await fetch(`${base}/fhir/Patient/p1`, { headers: hdr(keys.north) })).status, 200);

    // Lifting it restores service without a restart.
    engine.db.setTenantStatus("south", "active");
    assert.equal((await fetch(`${base}/fhir/Patient/p1`, { headers: hdr(keys.south) })).status, 200);
  } finally {
    await close();
  }
});

test("a caller cannot choose their own tenant from the request", async () => {
  // The tenant comes from the stored credential. If a header could override
  // it, the whole boundary would be advisory.
  const { base, keys, hdr, close } = await boot();
  try {
    for (const header of ["x-tenant-id", "x-tenant", "tenant"]) {
      const body = (await (
        await fetch(`${base}/fhir/Patient/p1`, { headers: hdr(keys.north, { [header]: "south" }) })
      ).json()) as { name: Array<{ family: string }> };
      assert.equal(body.name[0].family, "north", `${header} must not move the caller`);
    }
  } finally {
    await close();
  }
});
