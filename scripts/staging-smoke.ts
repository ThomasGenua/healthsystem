import { stagingSmoke } from "../src/core/staging-smoke.ts";
import { ClamAvScanner } from "../src/patient/clamav.ts";
import { EICAR_TEST_STRING } from "../src/patient/intake.ts";
try {
  const checks = await stagingSmoke(process.argv[2] ?? "http://127.0.0.1:18686");
  if (process.argv.includes("--scanner")) {
    const scanner = new ClamAvScanner({ port: 3310, timeoutMs: 10_000 });
    if ((await scanner.scan(Buffer.from("Northstar synthetic scanner probe"), "probe.txt")).verdict !== "clean" ||
        (await scanner.scan(Buffer.from(EICAR_TEST_STRING), "eicar.txt")).verdict !== "infected") {
      throw new Error("Scanner did not classify the synthetic clean/EICAR probes correctly");
    }
    checks.push("scanner-clean-and-eicar");
  }
  console.log(JSON.stringify({ ok: true, checks, clinicalApproval: false }));
} catch (error) {
  // Never print remote response bodies, which can contain sensitive data.
  console.error(error instanceof Error ? error.message : "Staging smoke failed");
  process.exitCode = 1;
}
