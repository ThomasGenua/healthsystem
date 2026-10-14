/**
 * The read path during an outage — the sibling of `demo/satlink.ts`.
 *
 * `satlink.ts` demonstrates what happens to an outbound feed when the
 * satellite link drops: the queue holds, order is preserved, everything drains
 * on reconnection. That is the write path, and it works. This walks the other
 * half, which until now did not exist: a nurse in a community during a
 * forty-hour outage could queue what they wrote and see *nothing* of what was
 * already known.
 *
 * Nine steps, in the order they happen at a real site:
 *
 *   1. the primary holds a chart worth reading
 *   2. a verified snapshot is taken while the link is up
 *   3. the station fills from it and records when the data was true
 *   4. the link drops
 *   5. the chart is served, wearing its age on every panel
 *   6. a clinical write is refused, with somewhere else to go
 *   7. the budget runs out — the station serves nothing and destroys the cache
 *   8. the link returns
 *   9. the offline reads reconcile onto the primary's chain, which still verifies
 *
 * Run it:  node demo/satlink-read.ts
 */
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Db } from "../src/db.ts";
import { ClinicalRecord } from "../src/clinical/record.ts";
import { MedicationStore } from "../src/meds/store.ts";
import { Workspace } from "../src/workspace/summary.ts";
import { AuditStore } from "../src/audit/store.ts";
import { takeBackup } from "../src/core/backup.ts";
import { ReadingStation, fillStation, reconcile } from "../src/core/station.ts";
import { ConsentDirectives } from "../src/patient/consent.ts";

const P = "NT-DEMO-0001";
const NURSE = { actorId: "nurse-tetso", actorKind: "staff" };
const BUDGET_HOURS = 24;

function step(n: number, title: string): void {
  console.log(`\n${"─".repeat(66)}\n${n}. ${title}\n${"─".repeat(66)}`);
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "northstar-satlink-read-"));
  const primary = new Db(join(dir, "primary.db"));
  const stationDb = new Db(join(dir, "station.db"));
  const cachePath = join(dir, "cache.db");

  try {
    step(1, "The primary holds a chart worth reading");
    const record = new ClinicalRecord(primary);
    const meds = new MedicationStore(primary);
    record.record({
      entryType: "Patient",
      patientId: P,
      content: {
        resourceType: "Patient",
        identifier: [{ system: "urn:jhn", value: P }],
        name: [{ family: "Blondin", given: ["Marie"] }],
      },
      authorId: "adt-feed",
      authorKind: "device",
    });
    meds.recordAllergy({
      patientId: P,
      display: "Penicillin",
      ingredient: "penicillin",
      criticality: "high",
      reaction: "anaphylaxis",
      by: NURSE,
    });
    console.log(`   ${P}: high-criticality penicillin allergy, anaphylaxis.`);
    console.log("   This is the fact that has to survive the link going down.");

    step(2, "A verified snapshot, taken while the link is up");
    const snapshot = await takeBackup(primary, { dir: join(dir, "snapshots") });
    console.log(`   ${snapshot.path.split("/").pop()}  (${snapshot.bytes} bytes, ${snapshot.durationMs} ms)`);
    console.log(
      `   verified: ${snapshot.verified.channels} channels, ${snapshot.verified.messages} messages, ` +
        `${snapshot.verified.auditEvents} audit events walked`
    );
    console.log("   The cache is a restore of this. No bespoke sync protocol to trust.");

    step(3, "The station fills, and records when the data was true");
    const fill = fillStation(stationDb, {
      snapshot: snapshot.path,
      cachePath,
      stationId: "nursing-station-01",
      budgetHours: BUDGET_HOURS,
      // A demo on a scratch directory. A real station refuses here unless the
      // volume is encrypted — the primary's posture (H-44), verbatim.
      allowUnencrypted: true,
    });
    const station = new ReadingStation(stationDb);
    console.log(`   station:   ${fill.manifest.stationId}`);
    console.log(`   as of:     ${fill.manifest.takenAt}   (the snapshot's stamp, not the copy's)`);
    console.log(`   budget:    ${fill.manifest.budgetHours} hours`);

    step(4, "The link drops");
    console.log("   The primary is unreachable. Everything below is served from the cache.");

    step(5, "The chart is served — wearing its age on every panel");
    const cache = new Db(cachePath);
    const cacheMeds = new MedicationStore(cache);
    const st = station.state();
    if (!st.serving) throw new Error(`station not serving: ${st.detail}`);
    const chart = new Workspace({ meds: cacheMeds, record: new ClinicalRecord(cache) }).chart(P, { asOf: st.asOf });

    console.log(`   allergies: ${chart.allergies.items.map((a) => a.display).join(", ") || "(none)"}`);
    console.log(`   complete:  ${chart.complete}   <- a cached chart is never complete`);
    console.log(`   panel says: ${chart.allergies.incomplete?.reason} (${chart.stale?.ageHours}h old)`);
    console.log(`   chart says: "${chart.stale?.note}"`);
    console.log("\n   The allergy is there. Nothing pretends it is current.");

    // The read happened, so it goes on the station's own chain — its own
    // genesis, its own hashes, never an append into the primary's copy.
    station.record({
      action: "R",
      outcome: 0,
      principalId: "nurse-tetso",
      principalKind: "apikey",
      method: "GET",
      path: "/api/clinical/chart",
      resourceType: "Composition",
      patient: P,
      detail: "chart read during outage",
    });
    console.log(`   recorded on the station's own chain (${station.pending().length} row pending reconciliation)`);

    step(6, "A clinical write is refused, with somewhere else to go");
    console.log("   POST /api/clinical/immunization-record  ->  405");
    console.log("   \"this is a reading station serving a cached chart; it does not accept");
    console.log("    clinical writes, because a second writable copy of the record is a");
    console.log("    conflict nobody can resolve safely afterwards\"");
    console.log("   remedy: the feed queue and paper — the write path already degrades well.");
    console.log("");
    console.log("   The exception is the emergency: POST /api/clinical/break-glass -> 201.");
    console.log("   The override is honoured from the cache for the rest of the outage,");
    console.log("   a copy survives in the station's own database, and the primary learns");
    console.log("   of it — and queues the patient's notice — at reconciliation.");
    station.recordBreakGlass({
      patient: P,
      reason: "unresponsive on arrival, need the allergy list before giving anything",
      actorId: "nurse-tetso",
      actorKind: "apikey",
    });

    step(7, `The outage outlasts the ${BUDGET_HOURS}-hour budget`);
    const wellPast = new Date(Date.parse(st.asOf) + (BUDGET_HOURS + 16) * 36e5);
    const expired = station.state(wellPast);
    console.log(`   at +${BUDGET_HOURS + 16}h: serving = ${expired.serving}`);
    if (!expired.serving) console.log(`   "${expired.detail}"`);
    const purge = station.expire(wellPast);
    console.log(`   ${purge.detail}`);
    console.log(`   cache file present: ${existsSync(cachePath)}   <- the clinical copy is gone`);
    console.log(`   station trail kept: ${station.pending().length} row   <- the reads still have to reach the primary`);
    cache.close();

    step(8, "The link returns");
    const primaryAudit = new AuditStore(primary);
    const before = primaryAudit.verifyChain();
    console.log(`   primary chain before: ok=${before.ok} over ${before.checked} rows`);

    step(9, "The offline reads reconcile — by appending, never by rewriting");
    const result = reconcile(station, primaryAudit, { principalId: "ops", principalKind: "apikey" }, {
      consent: new ConsentDirectives(primary),
    });
    const after = primaryAudit.verifyChain();
    console.log(`   appended:     ${result.appended} row(s) + 1 reconciliation row`);
    console.log(`   station chain: ok=${result.stationChain.ok} over ${result.stationChain.checked} rows`);
    console.log(`   break-glass replayed: ${result.breakGlassReplayed} — the notice now rides the primary dispatch`);
    console.log(`   primary chain after: ok=${after.ok} over ${after.checked} rows`);

    const onTrail = primaryAudit.list({ patient: P, limit: 5 }).find((r) => /reconciled from station/.test(r.detail ?? ""));
    console.log(`\n   on the patient's trail: "${onTrail?.detail}"`);
    console.log("\n   Dated when the read happened, chained when it arrived. Those are");
    console.log("   different facts and the row says both — so an access review of this");
    console.log("   patient sees the outage read where it belongs in the story.");

    console.log(`\n${"═".repeat(66)}`);
    console.log("The read path now degrades the way the write path always did.");
    console.log(`${"═".repeat(66)}\n`);
  } finally {
    primary.close();
    stationDb.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

await main();
