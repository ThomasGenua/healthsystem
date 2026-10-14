import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine } from "../src/core/engine.ts";
import { UploadScanWorker } from "../src/patient/scan-worker.ts";
import { pilotPreflight } from "../src/core/preflight.ts";

test("scan sweeps are bounded and stopping prevents more work", async () => {
  const engine = new Engine({ dbPath: ":memory:", malwareScanner: { scan: () => ({ verdict: "clean" }) } });
  await engine.start();
  const worker = new UploadScanWorker(engine);
  engine.uploadScanWorker = worker;
  try {
    const tenant = engine.forTenant("default");
    tenant.clinical.record({ entryType: "Patient", patientId: "P", content: { resourceType: "Patient", identifier: [{ value: "P" }] }, authorId: "fixture", authorKind: "device" });
    for (let i = 0; i < 12; i++) tenant.uploads.receive({ patientId: "P", filename: "fixture.txt", contentType: "text/plain", data: Buffer.from("synthetic").toString("base64"), by: { actorId: "fixture", actorKind: "patient" } });
    await worker.sweep();
    assert.equal(worker.status().pending, 2);
    assert.equal(tenant.documents.forPatient("P").length, 10);
    await worker.stop();
    await worker.sweep();
    assert.equal(worker.status().pending, 2);
  } finally { await engine.stop(); }
});

test("shutdown waits for the active scan before closing its database", async () => {
  let finish!: (value: { verdict: "clean" }) => void;
  const engine = new Engine({ dbPath: ":memory:", malwareScanner: { scan: () => new Promise(resolve => { finish = resolve; }) } });
  await engine.start();
  const worker = new UploadScanWorker(engine);
  engine.uploadScanWorker = worker;
  const tenant = engine.forTenant("default");
  tenant.clinical.record({ entryType: "Patient", patientId: "P", content: { resourceType: "Patient", identifier: [{ value: "P" }] }, authorId: "fixture", authorKind: "device" });
  tenant.uploads.receive({ patientId: "P", filename: "fixture.txt", contentType: "text/plain", data: Buffer.from("synthetic").toString("base64"), by: { actorId: "fixture", actorKind: "patient" } });
  const scanning = worker.sweep();
  let stopped = false;
  const stopping = engine.stop().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false);
  finish({ verdict: "clean" });
  await scanning;
  await stopping;
  assert.equal(stopped, true);
});

test("preflight fails incomplete and development configuration without leaking values", async () => {
  const checks = await pilotPreflight({ NORTHSTAR_DEV_IDP: "on", NORTHSTAR_DEV_MALWARE_SCANNER: "on", NORTHSTAR_RATE_LIMIT: "off", NORTHSTAR_PORTAL_CLIENT_SECRET_FILE: "private-secret-path", NORTHSTAR_OIDC_ISSUER: "http://private-host" });
  for (const id of ["development", "authentication", "identity", "backup", "scanner-config", "rate-limits"]) assert.equal(checks.find(c => c.id === id)?.status, "blocker");
  assert.ok(checks.some(c => c.status === "review"));
  assert.equal(JSON.stringify(checks).includes("private-"), false);
});

test("preflight respects legacy unsafe settings", async () => {
  const checks = await pilotPreflight({ PORTAGE_DEV_IDP: "on", PORTAGE_RATE_LIMIT: "off" });
  assert.equal(checks.find(c => c.id === "development")?.status, "blocker");
  assert.equal(checks.find(c => c.id === "rate-limits")?.status, "blocker");
});

test("scan worker persists backoff, retries, skips suspended tenants and never overlaps", async () => {
  let available = false;
  let calls = 0;
  const engine = new Engine({ dbPath: ":memory:", malwareScanner: { scan: async () => { calls++; if (!available) throw new Error("synthetic outage"); return { verdict: "clean" }; } } });
  await engine.start();
  const worker = new UploadScanWorker(engine);
  engine.uploadScanWorker = worker;
  try {
    const tenant = engine.forTenant("default");
    tenant.clinical.record({ entryType: "Patient", patientId: "P", content: { resourceType: "Patient", identifier: [{ value: "P" }] }, authorId: "fixture", authorKind: "device" });
    const upload = tenant.uploads.receive({ patientId: "P", filename: "fixture.txt", contentType: "text/plain", data: Buffer.from("synthetic").toString("base64"), by: { actorId: "fixture", actorKind: "patient" } });
    await Promise.all([worker.sweep(), worker.sweep()]);
    assert.equal(calls, 1);
    assert.equal(tenant.uploads.get(upload.id).status, "pending-scan");
    await worker.sweep(); assert.equal(calls, 1);
    const row = engine.db.sql.prepare("SELECT scan_attempts, scan_retry_at FROM intake_uploads WHERE id = ?").get(upload.id) as { scan_attempts: number; scan_retry_at: number };
    assert.equal(row.scan_attempts, 1); assert.ok(row.scan_retry_at > Date.now());
    available = true;
    engine.db.sql.prepare("UPDATE intake_uploads SET scan_retry_at = 0, uploaded_at = ? WHERE id = ?").run(new Date(Date.now() - 3600_000).toISOString(), upload.id);
    assert.equal(worker.status().degraded, true);
    engine.db.sql.exec("UPDATE tenants SET status = 'suspended' WHERE id = 'default'");
    await worker.sweep(); assert.equal(calls, 1);
    engine.db.sql.exec("UPDATE tenants SET status = 'active' WHERE id = 'default'");
    await worker.sweep(); assert.equal(calls, 2);
    assert.equal(tenant.uploads.get(upload.id).status, "clean");
    assert.equal(worker.status().pending, 0);
    assert.equal(tenant.documents.forPatient("P").length, 1);
  } finally { await engine.stop(); }
});
