/**
 * The satellite demo. Topology:
 *
 *   [community EMR feed] --MLLP--> Northstar --HTTP over satlink--> Meridian (territorial EHR)
 *
 * Phase A: healthy link, ADT flows end to end.
 * Phase B: outage. The feed keeps sending; Northstar keeps acknowledging AA,
 *          because an AA certifies durable queueing, not remote delivery.
 *          Nothing reaches Meridian; the queue grows.
 * Phase C: link restored. The queue drains in strict arrival order with no
 *          loss and no duplicates, and the hash chain still verifies.
 *
 * Run:  npm run demo
 * Args: --messages-before 5 --messages-during 10 --outage-ms 4000 --latency-ms 120
 *       --jitter-ms 60 --packet-loss-pct 0 --bandwidth-kbps 0
 *
 * A lossy, bandwidth-constrained link is the harder case and the more
 * realistic one. Try:  npm run demo -- --packet-loss-pct 8 --bandwidth-kbps 128
 */
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../src/core/engine.ts";
import { mllpSend } from "../src/hl7/mllp.ts";
import { startMeridianSim } from "./meridian-sim.ts";
import { startSatLink } from "./satlink.ts";
import type { ChannelConfig, MappingDoc } from "../src/types.ts";

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? parseInt(process.argv[i + 1], 10) : fallback;
}

const BEFORE = arg("messages-before", 5);
const DURING = arg("messages-during", 10);
const OUTAGE_MS = arg("outage-ms", 4000);
const LATENCY = arg("latency-ms", 120);
const JITTER = arg("jitter-ms", 60);
const PACKET_LOSS = arg("packet-loss-pct", 0);
const BANDWIDTH = arg("bandwidth-kbps", 0);

const ADT_TEMPLATE = (n: number) =>
  [
    `MSH|^~\\&|WOLF|YKPCC|PORTAGE|GNWT|20260805${String(100000 + n).slice(1)}||ADT^A04^ADT_A01|DEMO${String(n).padStart(4, "0")}|P|2.5.1`,
    `EVN|A04|20260805${String(100000 + n).slice(1)}`,
    `PID|1||NT${String(700000 + n)}^^^NWT^JHN||Demo^Patient^${n}||19900101|F|||${n} Franklin Ave^^Yellowknife^NT^X1A1A1^CA`,
    "PV1|1|O",
  ].join("\r") + "\r";

async function until(cond: () => boolean, ms: number, label: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timeout waiting for: ${label}`);
}

async function main(): Promise<void> {
  console.log("Northstar satellite demo");
  console.log("======================\n");

  const meridian = await startMeridianSim(0);
  const link = await startSatLink({
    listenPort: 0,
    targetHost: "127.0.0.1",
    targetPort: meridian.port,
    latencyMs: LATENCY,
    jitterMs: JITTER,
    packetLossPct: PACKET_LOSS,
    bandwidthKbps: BANDWIDTH,
  });

  const dataDir = mkdtempSync(join(tmpdir(), "northstar-demo-"));
  const engine = new Engine({ dbPath: join(dataDir, "demo.db"), tickMs: 50 });
  engine.registerMapping(
    JSON.parse(readFileSync(new URL("../mappings/adt-patient.json", import.meta.url), "utf8")) as MappingDoc
  );
  await engine.start();

  const channel: ChannelConfig = {
    id: "demo-adt",
    name: "Community ADT over satellite to Meridian",
    source: { type: "mllp", port: 0 },
    pipeline: [
      { type: "filter.hl7Type", allow: ["ADT^A01", "ADT^A04"] },
      { type: "transform.mapping", mapping: "adt-patient" },
    ],
    destinations: [
      {
        id: "meridian",
        type: "http",
        url: `http://127.0.0.1:${link.port}/fhir/Patient`,
        contentType: "application/fhir+json",
        ordered: true,
        maxAttempts: 50,
        backoffBaseMs: 400,
        backoffCapMs: 2000,
        timeoutMs: 4000,
      },
    ],
  };
  await engine.addChannel(channel);
  const mllpPort = engine.mllpPort("demo-adt")!;

  console.log(`meridian-sim (territorial EHR)   :${meridian.port}`);
  const shaping = BANDWIDTH > 0 ? `${BANDWIDTH}kbps` : "unshaped";
  console.log(
    `satlink latency ${LATENCY}ms jitter ${JITTER}ms loss ${PACKET_LOSS}% ${shaping}  :${link.port}`
  );
  console.log(`northstar MLLP (community side)    :${mllpPort}\n`);

  let sent = 0;
  const feed = async (n: number) => {
    for (let i = 0; i < n; i++) {
      sent++;
      const ack = await mllpSend("127.0.0.1", mllpPort, ADT_TEMPLATE(sent), 3000);
      if (!/MSA\|AA/.test(ack)) throw new Error(`expected AA, got: ${ack.slice(0, 120)}`);
    }
  };

  const queued = () => {
    const s = engine.db.stats() as { deliveries?: Record<string, number> };
    return (s.deliveries?.queued ?? 0) + (s.deliveries?.inflight ?? 0);
  };
  const delivered = () => {
    const s = engine.db.stats() as { deliveries?: Record<string, number> };
    return s.deliveries?.delivered ?? 0;
  };

  console.log(`Phase A: healthy link, sending ${BEFORE} admissions`);
  await feed(BEFORE);
  await until(() => meridian.received.length === BEFORE, 30_000, "phase A delivery");
  await until(() => delivered() === BEFORE, 30_000, "phase A confirmation");
  console.log(`  sent ${BEFORE}, acked ${BEFORE}, delivered to Meridian ${meridian.received.length}\n`);

  console.log(`Phase B: OUTAGE for ${OUTAGE_MS}ms, sending ${DURING} admissions into the dark`);
  link.setOutage(true);
  const outageStart = Date.now();
  await feed(DURING);
  const ackedDuring = DURING;
  await new Promise((r) => setTimeout(r, Math.max(0, OUTAGE_MS - (Date.now() - outageStart))));
  console.log(`  sent ${DURING}, acked ${ackedDuring} (AA certifies durable queueing, not remote delivery)`);
  console.log(`  delivered to Meridian during outage: ${meridian.received.length - BEFORE}`);
  console.log(`  queue depth at restore: ${queued()}\n`);

  console.log("Phase C: link restored, draining in order");
  link.setOutage(false);
  const total = BEFORE + DURING;
  await until(() => meridian.received.length === total, 120_000, "phase C drain");
  const drainMs = Date.now() - outageStart - OUTAGE_MS;

  const identifiers = meridian.received.map((r) => r.identifier);
  const expected = Array.from({ length: total }, (_, i) => `NT${700001 + i}`);
  const ordered = JSON.stringify(identifiers) === JSON.stringify(expected);
  const chain = engine.db.verifyChain("demo-adt");

  console.log(`  delivered ${meridian.received.length}/${total} in ${drainMs}ms after restore`);
  console.log(`  strict arrival order preserved: ${ordered ? "yes" : "NO"}`);
  console.log(`  duplicates: ${meridian.received.length - new Set(identifiers).size}`);
  console.log(`  hash chain verified: ${chain.ok ? `yes (${chain.checked} links)` : "NO"}`);
  const linkStats = link.stats();
  console.log(`  link stats: ${JSON.stringify(linkStats)}`);
  if (PACKET_LOSS > 0) {
    console.log(`  retransmissions absorbed: ${linkStats.retransmits}`);
  }
  console.log();

  const ok = ordered && chain.ok && meridian.received.length === total;
  console.log(ok ? "DEMO PASSED: zero loss, zero duplicates, strict order through a dead link." : "DEMO FAILED");

  await engine.stop();
  await link.close();
  await meridian.close();
  rmSync(dataDir, { recursive: true, force: true });
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
