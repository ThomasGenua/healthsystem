/**
 * Fills the disk under a running engine and checks what senders are told.
 *
 *   # a genuinely small filesystem, so filling it is quick and contained
 *   sudo mkdir -p /mnt/portage-tiny
 *   sudo mount -t tmpfs -o size=1M tmpfs /mnt/portage-tiny
 *   node scripts/diskfulltest.ts --dir /mnt/portage-tiny
 *   sudo umount /mnt/portage-tiny
 *
 * An AA says the message is on disk. If the engine answers AA when the write
 * failed, the sender believes the message is safe and drops it, and it is
 * gone — silent clinical data loss. The only acceptable answers when the
 * store cannot accept a message are AE, or no answer at all.
 *
 * A full disk is not a hypothetical here. The message log grows with every
 * message (see the retention section of the README), and a community site is
 * not somewhere anyone notices a disk filling up.
 *
 * test/durability.test.ts covers the same property portably by failing the
 * write at the SQL layer; this is the version against a really full
 * filesystem, including whether the engine recovers once space is freed.
 */
import { rmSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Engine } from "../src/core/engine.ts";
import { mllpSend } from "../src/hl7/mllp.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

const DIR = arg("dir");
if (!DIR) {
  console.error("usage: node scripts/diskfulltest.ts --dir <a small, writable filesystem>");
  console.error("this fills the given filesystem, so point it at a scratch mount and not at /");
  process.exit(2);
}

const adt = (n: number): string =>
  [
    `MSH|^~\\&|WOLF|YKPCC|PORTAGE|GNWT|20260805120000||ADT^A04^ADT_A01|FULL${n}|P|2.5.1`,
    `PID|1||NT${700000 + n}^^^NWT^JHN||Disk^Full^${n}||19900101|F`,
    "PV1|1|O",
  ].join("\r") + "\r";

async function main(): Promise<void> {
  const engine = new Engine({ dbPath: join(DIR!, "portage.db"), tickMs: 100_000 });
  await engine.start();
  await engine.addChannel({
    id: "full",
    name: "disk full",
    source: { type: "mllp", port: 0 },
    destinations: [{ id: "facade", type: "fhirstore", ordered: true }],
  });
  const port = engine.mllpPort("full")!;

  const send = async (n: number): Promise<"AA" | "AE" | "none"> => {
    const ack = await mllpSend("127.0.0.1", port, adt(n), 5_000).catch(() => "");
    return /MSA\|AA/.test(ack) ? "AA" : /MSA\|AE/.test(ack) ? "AE" : "none";
  };

  let healthy = 0;
  for (let i = 0; i < 3; i++) if ((await send(i)) === "AA") healthy++;
  console.log(`  before filling: ${healthy}/3 acknowledged AA`);

  let ballast = 0;
  try {
    for (let i = 0; i < 100_000; i++) {
      writeFileSync(join(DIR!, `ballast-${i}`), Buffer.alloc(16 * 1024, 0x41));
      ballast++;
    }
    console.error("  the filesystem never filled — point --dir at a smaller one");
    process.exit(2);
  } catch {
    console.log(`  filesystem full after ${Math.round((ballast * 16) / 1024)} MB of ballast\n`);
  }

  const results = { AA: 0, AE: 0, none: 0 };
  for (let i = 100; i < 110; i++) results[await send(i)]++;
  console.log(`  while full:  AA ${results.AA}   AE ${results.AE}   no ack ${results.none}`);

  const storedWhileFull = engine.db.listMessages({ channelId: "full" }).length;

  // Free the space. A feed must resume once an operator clears the disk,
  // without needing a restart.
  for (const f of readdirSync(DIR!)) if (f.startsWith("ballast-")) rmSync(join(DIR!, f));
  const after = await send(200);
  console.log(`  after freeing space: ${after}`);

  const chain = engine.db.verifyChain("full");
  console.log(`  stored: ${engine.db.listMessages({ channelId: "full" }).length} (was ${storedWhileFull} while full)`);
  console.log(`  db: ${Math.round(statSync(join(DIR!, "portage.db")).size / 1024)} KB`);
  console.log(`  chain: ${chain.ok ? `intact (${chain.checked})` : `BROKEN at ${chain.brokenAt}`}`);

  const ok = results.AA === 0 && chain.ok && after === "AA";
  console.log(
    `\n${ok ? "PASSED" : "FAILED"}: ` +
      (results.AA > 0
        ? "acknowledged AA while unable to write — a sender would have dropped a message that was never stored."
        : after !== "AA"
          ? "did not recover once space was freed."
          : "refused correctly while full, recovered once space was freed, chain intact.")
  );

  await engine.stop();
  process.exit(ok ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
