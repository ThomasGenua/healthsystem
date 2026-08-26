/**
 * The reading station: a chart during an outage, honest about being one.
 *
 * `demo/satlink.ts` proved the write path survives a satellite outage. This is
 * the read path's sibling, and the properties under test are the ones the
 * design (docs/OFFLINE-CHART.md) says make a second copy of the record
 * survivable rather than merely convenient: the age is on the chart, consent
 * still decides, the budget is a hard stop, writes are refused with somewhere
 * to go, the trail survives the purge, and reconciliation appends rather than
 * rewrites.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Db } from "../src/db.ts";
import { Engine } from "../src/core/engine.ts";
import { startApi } from "../src/api/admin.ts";
import { AuthGate } from "../src/auth/gate.ts";
import { AuditStore } from "../src/audit/store.ts";
import { takeBackup } from "../src/core/backup.ts";
import { ReadingStation, fillStation, reconcile, snapshotTakenAt } from "../src/core/station.ts";

const P = "NT700001";
const NURSE = { actorId: "nurse-tetso", actorKind: "staff" };

/**
 * A primary with a chart worth reading, a snapshot of it, and a station
 * filled from that snapshot — the shape every test here starts from.
 */
async function outageRig(opts: { budgetHours?: number; stamp?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "portage-station-"));
  const primaryPath = join(dir, "primary.db");
  const primary = new Db(primaryPath);

  // The facts that must survive the link going down.
  const { ClinicalRecord } = await import("../src/clinical/record.ts");
  const { MedicationStore } = await import("../src/meds/store.ts");
  const record = new ClinicalRecord(primary);
  const meds = new MedicationStore(primary);
  record.record({
    entryType: "Patient",
    patientId: P,
    content: { resourceType: "Patient", identifier: [{ system: "urn:jhn", value: P }], name: [{ family: "Blondin" }] },
    authorId: "adt-feed",
    authorKind: "device",
  });
  meds.recordAllergy({
    patientId: P,
    display: "Penicillin",
    ingredient: "penicillin",
    criticality: "high",
    by: NURSE,
  });

  const snapDir = join(dir, "snapshots");
  const backup = await takeBackup(primary, { dir: snapDir, ...(opts.stamp ? { stamp: opts.stamp } : {}) });

  const stationDb = new Db(join(dir, "station.db"));
  const cachePath = join(dir, "cache.db");
  const fill = fillStation(stationDb, {
    snapshot: backup.path,
    cachePath,
    stationId: "nursing-station-01",
    allowUnencrypted: true,
    ...(opts.budgetHours !== undefined ? { budgetHours: opts.budgetHours } : {}),
  });
  const station = new ReadingStation(stationDb);

  return {
    dir, primary, primaryPath, stationDb, station, cachePath, fill,
    snapshot: backup.path,
    close: () => {
      primary.close();
      stationDb.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** The station's cached database, served through the ordinary API. */
async function serveCache(cachePath: string, station: ReadingStation) {
  const engine = new Engine({ dbPath: cachePath, tickMs: 50 });
  await engine.start();
  const admin = engine.keys.issue("station-console", ["admin"]);
  const api = await startApi(engine, 0, "127.0.0.1", { auth: new AuthGate({ keys: engine.keys }), station });
  const base = `http://127.0.0.1:${api.port}`;
  return {
    engine, api, admin, base,
    get: (p: string) => fetch(`${base}${p}`, { headers: { authorization: `Bearer ${admin.key}` } }),
    post: (p: string, body: unknown) =>
      fetch(`${base}${p}`, {
        method: "POST",
        headers: { authorization: `Bearer ${admin.key}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    close: async () => { await api.close(); await engine.stop(); },
  };
}

test("a station dates its cache from when the data was true, not when the copy landed", () => {
  // A snapshot taken at 02:00 and filled at 06:00 is four hours old the
  // moment it arrives. A chart dated from the copy would understate its own
  // age, which is the one direction staleness must never err in.
  const dir = mkdtempSync(join(tmpdir(), "portage-stamp-"));
  try {
    const named = join(dir, "portage-2026-08-20T03-15-00.db");
    writeFileSync(named, "x");
    const fromName = snapshotTakenAt(named);
    assert.equal(fromName.takenAt, "2026-08-20T03:15:00.000Z");
    assert.equal(fromName.fromName, true);

    // A file that carries no stamp falls back to its mtime and says so, so a
    // caller can tell the difference rather than being handed a guess.
    const unnamed = join(dir, "handed-over-on-a-usb-stick.db");
    writeFileSync(unnamed, "x");
    const fallback = snapshotTakenAt(unnamed);
    assert.equal(fallback.fromName, false);
    assert.ok(Date.parse(fallback.takenAt) > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the cache is a restore, and it carries the chart the link would have served", async () => {
  const rig = await outageRig();
  try {
    // Not a bespoke sync protocol: a verified snapshot, restored. The
    // verification travels with the fill so an operator can see what was in it.
    assert.ok(rig.fill.verified.auditEvents >= 0);
    assert.equal(rig.fill.manifest.stationId, "nursing-station-01");

    const s = await serveCache(rig.cachePath, rig.station);
    try {
      const chart = (await (await s.get(`/api/clinical/chart?patient=${P}`)).json()) as {
        allergies: { items: Array<{ display: string }>; complete: boolean; incomplete?: { reason: string } };
        stale?: { ageHours: number; note: string };
        complete: boolean;
      };
      // The fact that had to survive the outage.
      assert.equal(chart.allergies.items[0]?.display, "Penicillin");
      // And it arrives wearing its age, at both levels.
      assert.equal(chart.complete, false, "a cached chart is never complete");
      assert.equal(chart.allergies.incomplete?.reason, "stale");
      assert.ok(chart.stale, "the chart says on its face that it is a cache");
      assert.match(chart.stale?.note ?? "", /assembled from a cache/);
    } finally {
      await s.close();
    }
  } finally {
    rig.close();
  }
});

test("a station refuses clinical writes, and says where to write instead", async () => {
  // Read-only is scope discipline, not a gap: a second writable copy is a
  // conflict nobody has designed a resolution for. The refusal has to point
  // somewhere, or a nurse mid-outage is simply stuck.
  const rig = await outageRig();
  try {
    const s = await serveCache(rig.cachePath, rig.station);
    try {
      const res = await s.post("/api/clinical/break-glass", { patient: P, reason: "unresponsive on arrival" });
      assert.equal(res.status, 405);
      const body = (await res.json()) as { error: string; remedy: string };
      assert.match(body.error, /does not accept clinical writes/);
      assert.match(body.remedy, /queue holds and drains when the link returns/);

      // And the refusal is on the station's trail — a refused reach for a
      // record is exactly what an audit trail exists to show.
      assert.ok(
        rig.station.audit.list({ limit: 20 }).some((r) => /does not accept clinical writes/.test(r.detail ?? "")),
        "the refused write is recorded"
      );
    } finally {
      await s.close();
    }
  } finally {
    rig.close();
  }
});

test("consent still decides at the station, from the directives the snapshot carried", async () => {
  const rig = await outageRig();
  try {
    // A directive recorded before the snapshot rides it and is enforced
    // offline by the same code the primary runs. The cache changes what is
    // known, never who may see it.
    const { ConsentDirectives } = await import("../src/patient/consent.ts");
    new ConsentDirectives(rig.primary).record({
      patientId: P,
      kind: "withhold-all",
      by: { actorId: "privacy-office", actorKind: "practitioner" },
    });
    const snapDir = join(rig.dir, "snapshots2");
    const withDirective = await takeBackup(rig.primary, { dir: snapDir });
    const cache2 = join(rig.dir, "cache2.db");
    fillStation(rig.stationDb, {
      snapshot: withDirective.path,
      cachePath: cache2,
      stationId: "nursing-station-01",
      allowUnencrypted: true,
    });

    const s = await serveCache(cache2, rig.station);
    try {
      const res = await s.get(`/api/clinical/chart?patient=${P}`);
      assert.equal(res.status, 403, "the lockbox is a lockbox on a cache too");
      assert.match(((await res.json()) as { error: string }).error, /withheld by a patient directive/);
    } finally {
      await s.close();
    }
  } finally {
    rig.close();
  }
});

test("past its budget the station serves nothing, and purges rather than waiting to be asked", async () => {
  // The failure the issue names: a month-old chart served because the outage
  // lasted a month. The budget is the directive-freshness clock — past it,
  // the cache cannot know who may see what, so it serves nothing at all.
  const rig = await outageRig({ budgetHours: 24, stamp: "2026-08-20T00-00-00" });
  try {
    const wellPast = new Date(Date.parse("2026-08-20T00:00:00Z") + 40 * 36e5);
    const st = rig.station.state(wellPast);
    assert.equal(st.serving, false);
    if (!st.serving) {
      assert.equal(st.reason, "expired");
      assert.match(st.detail, /past its 24-hour budget/);
      assert.match(st.detail, /directive issued since the fill cannot be known here/);
    }

    // Serving is refused at the route with the reason and a way forward.
    const s = await serveCache(rig.cachePath, rig.station);
    try {
      // The route asks the real clock, which is well past this fixed stamp.
      const res = await s.get(`/api/clinical/chart?patient=${P}`);
      assert.equal(res.status, 503);
      const body = (await res.json()) as { error: string; station: string; remedy: string };
      assert.equal(body.station, "expired");
      assert.match(body.remedy, /fill this station from a fresh snapshot/);
    } finally {
      await s.close();
    }

    // Expiry destroys the clinical copy and keeps the record that reads
    // happened — those still have to reach the primary.
    assert.ok(existsSync(rig.cachePath), "the cache exists before expiry");
    const purge = rig.station.expire(wellPast);
    assert.equal(purge.purged, true);
    assert.equal(existsSync(rig.cachePath), false, "the clinical cache is destroyed");
    assert.ok(rig.station.manifest(), "the manifest survives, so the station can still say why");
    const afterPurge = rig.station.state(wellPast);
    assert.equal(afterPurge.serving, false);
    if (!afterPurge.serving) {
      assert.equal(afterPurge.reason, "purged");
      assert.match(afterPurge.detail, /destroyed/);
    }
  } finally {
    rig.close();
  }
});

test("a station inside its budget is not purged by asking", async () => {
  const rig = await outageRig({ budgetHours: 72 });
  try {
    const purge = rig.station.expire();
    assert.equal(purge.purged, false);
    assert.match(purge.detail, /still within budget/);
    assert.ok(existsSync(rig.cachePath));
  } finally {
    rig.close();
  }
});

test("offline reads reconcile onto the primary's chain by appending, never by rewriting", async () => {
  const rig = await outageRig();
  try {
    const primaryAudit = new AuditStore(rig.primary);
    primaryAudit.record({
      action: "R", principalId: "dr-hale", principalKind: "apikey",
      method: "GET", path: "/api/clinical/chart", patient: P, detail: "before the outage",
    });
    const beforeHead = primaryAudit.verifyChain();
    const beforeCount = primaryAudit.count();

    // Two reads happen while the link is down.
    const s = await serveCache(rig.cachePath, rig.station);
    try {
      await s.get(`/api/clinical/chart?patient=${P}`);
      await s.get(`/api/clinical/allergies?patient=${P}`);
    } finally {
      await s.close();
    }
    const pending = rig.station.pending();
    assert.ok(pending.length >= 2, "the station recorded its own reads");
    assert.ok(
      pending.every((r) => /\[station nursing-station-01\]/.test(r.detail ?? "")),
      "every station row carries the station's identity"
    );

    const result = reconcile(rig.station, primaryAudit, { principalId: "ops", principalKind: "apikey" });
    assert.equal(result.appended, pending.length);
    assert.equal(result.stationChain.ok, true);

    // The primary's chain still verifies, and grew rather than being rewritten.
    const after = primaryAudit.verifyChain();
    assert.equal(after.ok, true, "the primary's chain verifies after reconciliation");
    assert.ok(after.checked > beforeHead.checked);
    assert.equal(primaryAudit.count(), beforeCount + pending.length + 1, "appended rows plus one reconciliation row");

    // An access review of the patient now sees the offline read, dated when
    // it happened rather than when it arrived.
    const forPatient = primaryAudit.list({ patient: P, limit: 20 });
    const offline = forPatient.find((r) => /reconciled from station/.test(r.detail ?? ""));
    assert.ok(offline, "the offline read is on the patient's trail");
    assert.match(offline?.detail ?? "", /read at \d{4}-\d{2}-\d{2}T/);
    assert.match(offline?.detail ?? "", /station seq \d+/);

    // And reconciliation is resumable: a second run appends nothing new.
    const again = reconcile(rig.station, primaryAudit, { principalId: "ops", principalKind: "apikey" });
    assert.equal(again.appended, 0, "already-reconciled rows are not shipped twice");
  } finally {
    rig.close();
  }
});

test("a station trail that does not verify is an incident, not a silent drop", async () => {
  const rig = await outageRig();
  try {
    const s = await serveCache(rig.cachePath, rig.station);
    try {
      await s.get(`/api/clinical/chart?patient=${P}`);
    } finally {
      await s.close();
    }
    // Tamper with the station's own trail, the way a stolen station's disk
    // might be edited before it is handed back.
    rig.stationDb.sql.prepare("UPDATE audit_events SET patient = 'NT-SOMEBODY-ELSE' WHERE seq = 1").run();

    const primaryAudit = new AuditStore(rig.primary);
    const result = reconcile(rig.station, primaryAudit, { principalId: "ops", principalKind: "apikey" });

    assert.equal(result.stationChain.ok, false);
    assert.ok(result.incident, "a broken station chain is reported");
    assert.match(result.incident ?? "", /did not verify/);
    assert.ok(result.appended > 0, "the rows are kept — the record that reads happened is not optional");
    assert.ok(
      primaryAudit.list({ limit: 10 }).some((r) => /DID NOT VERIFY/.test(r.detail ?? "")),
      "and the primary's trail says the station chain failed"
    );
  } finally {
    rig.close();
  }
});

test("a station that was never filled serves nothing and says so", () => {
  const db = new Db(":memory:");
  try {
    const station = new ReadingStation(db);
    const st = station.state();
    assert.equal(st.serving, false);
    if (!st.serving) {
      assert.equal(st.reason, "never-filled");
      assert.match(st.detail, /never been filled/);
    }
    assert.equal(station.expire().purged, false);
  } finally {
    db.close();
  }
});

test("a station will not fill onto an unencrypted volume", async () => {
  // H-44 verbatim. A station sits in a nursing station rather than a locked
  // server room, so a stolen disk is likelier here than at the primary —
  // which is a reason to apply the check harder, not to relax it.
  const rig = await outageRig();
  try {
    const db = new Db(":memory:");
    try {
      // Not passing allowUnencrypted: the real check runs. On a CI box the
      // data directory is ordinarily unencrypted, so this refuses; where the
      // runner reports encrypted or unknown it fills, and both are correct —
      // the assertion is that "not-encrypted" is never quietly served.
      let refused = false;
      try {
        fillStation(db, {
          snapshot: rig.snapshot,
          cachePath: join(rig.dir, "unencrypted-cache.db"),
          stationId: "test",
        });
      } catch (err) {
        refused = /unencrypted volume/.test((err as Error).message);
        assert.ok(refused, `refused for the right reason: ${(err as Error).message}`);
      }
      const { encryptionAtRest } = await import("../src/core/atrest.ts");
      if (encryptionAtRest(rig.dir).state === "not-encrypted") {
        assert.equal(refused, true, "an unencrypted volume must refuse the fill");
      }
    } finally {
      db.close();
    }
  } finally {
    rig.close();
  }
});

test("filling twice replaces the cache and resets the clock", async () => {
  // The remedy the refusal points at: a fresh fill. It must actually clear an
  // expired state rather than leaving a station permanently dead.
  const rig = await outageRig({ budgetHours: 24, stamp: "2026-08-20T00-00-00" });
  try {
    const wellPast = new Date(Date.parse("2026-08-20T00:00:00Z") + 40 * 36e5);
    assert.equal(rig.station.state(wellPast).serving, false);
    rig.station.expire(wellPast);
    assert.ok(rig.station.manifest()?.purgedAt);

    const fresh = await takeBackup(rig.primary, { dir: join(rig.dir, "snapshots3") });
    fillStation(rig.stationDb, {
      snapshot: fresh.path,
      cachePath: join(rig.dir, "cache3.db"),
      stationId: "nursing-station-01",
      allowUnencrypted: true,
    });
    const st = rig.station.state();
    assert.equal(st.serving, true, "a fresh fill brings the station back");
    assert.equal(rig.station.manifest()?.purgedAt, undefined, "and clears the purge marker");
  } finally {
    rig.close();
  }
});
