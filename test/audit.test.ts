import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Engine } from "../src/core/engine.ts";
import { startApi } from "../src/api/admin.ts";
import { AuthGate } from "../src/auth/gate.ts";
import { until } from "./helpers.ts";
import type { AuditRow } from "../src/audit/store.ts";
import type { ChannelConfig, MappingDoc } from "../src/types.ts";

const ADT = readFileSync(new URL("../fixtures/adt_a01.hl7", import.meta.url), "utf8");
const MAPPING = JSON.parse(
  readFileSync(new URL("../mappings/adt-patient.json", import.meta.url), "utf8")
) as MappingDoc;

const CHANNEL: ChannelConfig = {
  id: "audit-feed",
  name: "audit feed",
  source: { type: "http", path: "audit-feed" },
  pipeline: [
    { type: "filter.hl7Type", allow: ["ADT^A01", "ADT^A04"] },
    { type: "transform.mapping", mapping: "adt-patient" },
  ],
  destinations: [{ id: "facade", type: "fhirstore", ordered: true }],
};

async function boot(withAuth = true) {
  const engine = new Engine({ dbPath: ":memory:", tickMs: 15 });
  engine.registerMapping(MAPPING);
  await engine.start();
  await engine.addChannel(CHANNEL);
  const keys = withAuth
    ? { admin: engine.keys.issue("ops", ["admin"]).key, reader: engine.keys.issue("consumer", ["read"]).key }
    : { admin: "", reader: "" };
  const api = await startApi(engine, 0, "127.0.0.1", withAuth ? { auth: new AuthGate({ keys: engine.keys }) } : {});
  const base = `http://127.0.0.1:${api.port}`;
  const hdr = (k: string) => (k ? { authorization: `Bearer ${k}` } : {});
  return {
    engine,
    base,
    keys,
    hdr,
    close: async () => {
      await api.close();
      await engine.stop();
    },
  };
}

test("every read of patient data is recorded, with who and how many", async () => {
  const { engine, base, keys, hdr, close } = await boot();
  try {
    engine.ingest("audit-feed", ADT, "x-application/hl7-v2+er7", "test");
    await until(() => engine.fhir.search("Patient", {}).total === 1);
    const stored = engine.fhir.search("Patient", {}).resources[0] as { id: string };

    const before = engine.audit.count();

    await fetch(`${base}/fhir/Patient?identifier=NT123456`, { headers: hdr(keys.reader) });
    await fetch(`${base}/fhir/Patient/${stored.id}`, { headers: hdr(keys.reader) });
    await fetch(`${base}/api/messages`, { headers: hdr(keys.admin) });

    const rows = engine.audit.list({ limit: 50 });
    assert.equal(engine.audit.count(), before + 3, "each disclosure is one row");

    const search = rows.find((r) => r.resource_type === "Patient" && r.count === 1 && r.patient === "NT123456");
    assert.ok(search, "the search records which patient was looked for");
    assert.equal(search.action, "R");
    assert.equal(search.outcome, 0);
    assert.equal(search.principal_kind, "apikey");

    const read = rows.find((r) => r.resource_id === stored.id);
    assert.ok(read, "the read records which record was opened");

    const messages = rows.find((r) => r.resource_type === "Message" && r.path === "/api/messages");
    assert.ok(messages, "browsing raw HL7 is a disclosure and must be recorded");
    assert.equal(messages.count, 1);

    // Two different principals acted; the trail must tell them apart.
    const principals = new Set(rows.map((r) => r.principal_id));
    assert.equal(principals.size, 2, "the reader and the operator are distinguishable");

    // Never the payload itself.
    const serialised = JSON.stringify(rows);
    assert.ok(!serialised.includes("Beaulieu"), "the audit trail must not copy the record it protects");
    assert.ok(!serialised.includes("MSH|"), "raw HL7 must never land in the audit trail");
  } finally {
    await close();
  }
});

test("refused attempts are recorded, which is the point of an audit trail", async () => {
  const { engine, base, keys, hdr, close } = await boot();
  try {
    const before = engine.audit.count();

    // No credentials at all.
    await fetch(`${base}/fhir/Patient?identifier=NT123456`);
    // Valid credentials, insufficient scope.
    await fetch(`${base}/api/messages`, { headers: hdr(keys.reader) });
    // A read-only key attempting a write.
    await fetch(`${base}/fhir/Patient`, { method: "POST", headers: hdr(keys.reader), body: "{}" });

    const failures = engine.audit.list({ failuresOnly: true });
    assert.equal(engine.audit.count(), before + 3);
    assert.equal(failures.length, 3, "all three refusals recorded");

    const anonymous = failures.find((r) => r.principal_id === "unauthenticated");
    assert.ok(anonymous, "an unauthenticated attempt is still recorded");
    assert.equal(anonymous.outcome, 4, "401 is a minor failure");

    const forbidden = failures.filter((r) => r.outcome === 8);
    assert.equal(forbidden.length, 2, "403 is a serious failure: valid identity, wrong reach");
    assert.ok(forbidden.every((r) => r.principal_id !== "unauthenticated"));

    // Routine unauthenticated noise on non-PHI routes must not fill the trail.
    const noise = engine.audit.count();
    await fetch(`${base}/api/channels`);
    await fetch(`${base}/api/health`);
    await fetch(`${base}/api/deliveries`);
    assert.equal(engine.audit.count(), noise, "refusals away from patient data are not audited");
  } finally {
    await close();
  }
});

test("the trail is hash-chained: an altered or deleted row breaks verification", async () => {
  const { engine, base, keys, hdr, close } = await boot();
  try {
    for (let i = 0; i < 5; i++) {
      await fetch(`${base}/fhir/Patient?identifier=NT${i}`, { headers: hdr(keys.reader) });
    }

    const clean = engine.audit.verifyChain();
    assert.equal(clean.ok, true);
    assert.equal(clean.checked, 5);

    // Someone edits a row to hide who they looked at.
    const target = engine.audit.list({ limit: 5 })[2];
    engine.db.sql.prepare("UPDATE audit_events SET patient = 'someone-else' WHERE id = ?").run(target.id);
    const tampered = engine.audit.verifyChain();
    assert.equal(tampered.ok, false, "an edited row must break the chain");
    assert.equal(tampered.brokenAt, target.id);

    // Put it back, then try deleting instead.
    engine.db.sql.prepare("UPDATE audit_events SET patient = ? WHERE id = ?").run(target.patient, target.id);
    assert.equal(engine.audit.verifyChain().ok, true, "restoring the value restores the chain");

    engine.db.sql.prepare("DELETE FROM audit_events WHERE id = ?").run(target.id);
    assert.equal(engine.audit.verifyChain().ok, false, "a deleted row must break the chain");
  } finally {
    await close();
  }
});

test("the trail is queryable by patient, principal and time, and served as FHIR", async () => {
  const { engine, base, keys, hdr, close } = await boot();
  try {
    await fetch(`${base}/fhir/Patient?identifier=NT-ALICE`, { headers: hdr(keys.reader) });
    await fetch(`${base}/fhir/Patient?identifier=NT-ALICE`, { headers: hdr(keys.admin) });
    await fetch(`${base}/fhir/Patient?identifier=NT-BOB`, { headers: hdr(keys.reader) });

    // "Who looked at Alice's record?" — the question the law asks.
    const alice = (await (await fetch(`${base}/api/audit?patient=NT-ALICE`, { headers: hdr(keys.admin) })).json()) as AuditRow[];
    assert.equal(alice.length, 2);
    assert.equal(new Set(alice.map((r) => r.principal_id)).size, 2);

    const bob = (await (await fetch(`${base}/api/audit?patient=NT-BOB`, { headers: hdr(keys.admin) })).json()) as AuditRow[];
    assert.equal(bob.length, 1);

    // "What has this key been reaching for?"
    const readerId = alice.find((r) => r.principal_id !== undefined)!.principal_id;
    const byPrincipal = (await (
      await fetch(`${base}/api/audit?principal=${readerId}`, { headers: hdr(keys.admin) })
    ).json()) as AuditRow[];
    assert.ok(byPrincipal.every((r) => r.principal_id === readerId));

    const future = new Date(Date.now() + 60_000).toISOString();
    const none = (await (await fetch(`${base}/api/audit?since=${future}`, { headers: hdr(keys.admin) })).json()) as AuditRow[];
    assert.equal(none.length, 0, "a window in the future is empty, not an error");

    const verify = (await (await fetch(`${base}/api/audit/verify`, { headers: hdr(keys.admin) })).json()) as {
      ok: boolean;
      checked: number;
    };
    assert.equal(verify.ok, true);

    // Standard FHIR shape for consumers that expect AuditEvent.
    const bundle = (await (await fetch(`${base}/fhir/AuditEvent?patient=NT-ALICE`, { headers: hdr(keys.admin) })).json()) as {
      resourceType: string;
      total: number;
      entry: Array<{ resource: Record<string, unknown> }>;
    };
    assert.equal(bundle.resourceType, "Bundle");
    assert.equal(bundle.total, 2);
    const ev = bundle.entry[0].resource;
    assert.equal(ev.resourceType, "AuditEvent");
    assert.equal(ev.action, "R");
    assert.ok(Array.isArray(ev.agent));
    assert.ok(Array.isArray(ev.entity));
  } finally {
    await close();
  }
});

test("the audit trail is admin-only: a read scope cannot read who read what", async () => {
  const { base, keys, hdr, close } = await boot();
  try {
    for (const path of ["/api/audit", "/api/audit/verify", "/fhir/AuditEvent"]) {
      assert.equal((await fetch(base + path)).status, 401, `${path} must require credentials`);
      assert.equal((await fetch(base + path, { headers: hdr(keys.reader) })).status, 403, `${path} must require admin`);
      assert.equal((await fetch(base + path, { headers: hdr(keys.admin) })).status, 200);
    }
  } finally {
    await close();
  }
});

test("reading the audit trail does not itself generate audit noise", async () => {
  // Otherwise each look at the trail appends to it, and a monitoring dashboard
  // polling it would bury the disclosures it exists to surface.
  const { engine, base, keys, hdr, close } = await boot();
  try {
    await fetch(`${base}/fhir/Patient?identifier=NT-SEED`, { headers: hdr(keys.reader) });
    const after = engine.audit.count();

    for (let i = 0; i < 3; i++) {
      await fetch(`${base}/api/audit`, { headers: hdr(keys.admin) });
      await fetch(`${base}/fhir/AuditEvent`, { headers: hdr(keys.admin) });
    }
    assert.equal(engine.audit.count(), after, "reading the trail must not append to it");
  } finally {
    await close();
  }
});

test("key issue and revocation are recorded as access-control changes", async () => {
  const { engine, base, keys, hdr, close } = await boot();
  try {
    const issued = (await (
      await fetch(`${base}/api/keys`, {
        method: "POST",
        headers: { ...hdr(keys.admin), "content-type": "application/json" },
        body: JSON.stringify({ name: "lab", scopes: ["write"] }),
      })
    ).json()) as { id: string; key: string };

    await fetch(`${base}/api/keys/${issued.id}`, { method: "DELETE", headers: hdr(keys.admin) });

    const rows = engine.audit.list({ resourceType: "ApiKey" });
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((r) => r.action).sort(),
      ["C", "D"],
      "both the grant and the revocation are recorded"
    );
    // The key material itself must never reach the trail.
    assert.ok(!JSON.stringify(rows).includes(issued.key));
  } finally {
    await close();
  }
});

test("auditing works with authentication switched off", async () => {
  // A local or air-gapped deployment still wants the trail; it just cannot
  // attribute actions to a credential.
  const { engine, base, close } = await boot(false);
  try {
    await fetch(`${base}/fhir/Patient?identifier=NT-OPEN`);
    const rows = engine.audit.list();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].principal_kind, "anonymous");
    assert.equal(rows[0].patient, "NT-OPEN");
  } finally {
    await close();
  }
});
