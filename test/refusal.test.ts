/**
 * A store saying no is not a store falling over.
 *
 * `phi()` used to map every throw to HTTP 400 and audit outcome 8. These
 * pin the split: a refusal keeps its status and is outcome 4; anything
 * else is 500 with a generic body, and the real message is on the trail.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mapStoreError, Refusal, refuse } from "../src/core/refusal.ts";
import { SlotFull } from "../src/schedule/store.ts";
import { UnknownParty } from "../src/directory/store.ts";
import { EncounterMismatch } from "../src/clinical/encounters.ts";
import { Engine } from "../src/core/engine.ts";
import { startApi } from "../src/api/admin.ts";
import { AuthGate } from "../src/auth/gate.ts";

test("mapStoreError keeps a refusal readable and hides a fault", () => {
  const slot = mapStoreError(new SlotFull("slot-1", 1));
  assert.equal(slot.status, 409);
  assert.equal(slot.outcome, 4);
  assert.match(slot.error, /slot-1 is full/);

  const unknown = mapStoreError(new UnknownParty("no practitioner ghost"));
  assert.equal(unknown.status, 400);
  assert.equal(unknown.outcome, 4);

  const mismatch = mapStoreError(new EncounterMismatch("belongs to a different patient"));
  assert.equal(mismatch.status, 409);
  assert.equal(mismatch.outcome, 4);

  try {
    refuse("an encounter needs a reason for the visit");
  } catch (err) {
    const mapped = mapStoreError(err);
    assert.equal(mapped.status, 400);
    assert.equal(mapped.outcome, 4);
    assert.equal(mapped.error, "an encounter needs a reason for the visit");
  }

  const fault = mapStoreError(new Error("SQLITE_IOERR: disk I/O error on /var/lib/portage/portage.db"));
  assert.equal(fault.status, 500);
  assert.equal(fault.outcome, 8);
  assert.equal(fault.error, "internal error");
  assert.match(fault.detail, /SQLITE_IOERR/);
  assert.ok(fault instanceof Refusal === false);
});

async function boot() {
  const engine = new Engine({ dbPath: ":memory:", tickMs: 15 });
  await engine.start();
  const admin = engine.keys.issue("ops", ["admin"]).key;
  const api = await startApi(engine, 0, "127.0.0.1", { auth: new AuthGate({ keys: engine.keys }) });
  const base = `http://127.0.0.1:${api.port}`;
  const t = engine.forTenant("default");
  t.clinical.record({
    entryType: "Patient",
    patientId: "NT123456",
    content: { resourceType: "Patient", identifier: [{ value: "NT123456" }] },
    authorId: "adt",
    authorKind: "device",
  });
  return {
    engine,
    t,
    admin,
    base,
    close: async () => {
      await api.close();
      await engine.stop();
    },
  };
}

test("a store refusal is 4xx the caller can read, and a fault is a 500 they cannot", async () => {
  const s = await boot();
  try {
    const post = (body: unknown) =>
      fetch(`${s.base}/api/clinical/encounter-open`, {
        method: "POST",
        headers: { authorization: `Bearer ${s.admin}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    const refused = await post({ patient: "NT123456", class: "teleport", reason: "Sore throat" });
    assert.equal(refused.status, 400);
    assert.match(((await refused.json()) as { error: string }).error, /unknown encounter class/);
    const refusalRow = s.engine.forTenant("default").audit.list({ limit: 1 })[0];
    assert.equal(refusalRow.outcome, 4);

    const original = s.t.encounters.open.bind(s.t.encounters);
    s.t.encounters.open = () => {
      throw new Error("EIO: disk failed reading page 4 of portage.db");
    };
    try {
      const fault = await post({ patient: "NT123456", class: "in-person", reason: "Sore throat" });
      assert.equal(fault.status, 500);
      const body = (await fault.json()) as { error: string };
      assert.equal(body.error, "internal error");
      assert.ok(!/portage\.db/.test(JSON.stringify(body)));
      const faultRow = s.engine.forTenant("default").audit.list({ limit: 1 })[0];
      assert.equal(faultRow.outcome, 8);
      assert.match(faultRow.detail ?? "", /EIO: disk failed/);
    } finally {
      s.t.encounters.open = original;
    }
  } finally {
    await s.close();
  }
});

test("a full slot is 409 over HTTP, not a malformed request", async () => {
  const s = await boot();
  try {
    const slot = s.t.schedule.openSlot({
      resourceId: "dr-tetso",
      service: "GP",
      startsAt: "2026-09-01T10:00:00Z",
      endsAt: "2026-09-01T10:30:00Z",
    });
    const book = (patient: string) =>
      fetch(`${s.base}/api/clinical/book`, {
        method: "POST",
        headers: { authorization: `Bearer ${s.admin}`, "content-type": "application/json" },
        body: JSON.stringify({ slot: slot.id, patient, reason: "Follow-up" }),
      });

    const first = await book("NT123456");
    assert.equal(first.status, 200);

    s.t.clinical.record({
      entryType: "Patient",
      patientId: "NT999999",
      content: { resourceType: "Patient", identifier: [{ value: "NT999999" }] },
      authorId: "adt",
      authorKind: "device",
    });
    const second = await book("NT999999");
    assert.equal(second.status, 409);
    assert.match(((await second.json()) as { error: string }).error, /is full/);
    const row = s.engine.forTenant("default").audit.list({ limit: 1 })[0];
    assert.equal(row.outcome, 4);
    assert.equal(row.resource_type, "Appointment");
  } finally {
    await s.close();
  }
});
