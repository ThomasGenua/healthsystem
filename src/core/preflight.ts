import { statSync } from "node:fs";
import { readEnv } from "./naming.ts";
import { ClamAvScanner } from "../patient/clamav.ts";

export interface PreflightCheck { id: string; status: "pass" | "blocker" | "review"; detail: string }
/** Configuration evidence, not certification. Never emit env values or secret paths. */
export async function pilotPreflight(env: NodeJS.ProcessEnv, probeScanner = false): Promise<PreflightCheck[]> {
  const get = (key: string) => readEnv(key, env);
  const checks: PreflightCheck[] = [];
  const check = (id: string, ok: boolean, detail: string) => checks.push({ id, status: ok ? "pass" : "blocker", detail });
  const file = (key: string) => { try { const path = get(key); return !!path && statSync(path).isFile() && statSync(path).size > 0; } catch { return false; } };
  const https = (value?: string) => { try { const url = new URL(value!); return url.protocol === "https:" && !url.username && !url.password && !url.hash; } catch { return false; } };
  check("development", get("DEV_IDP") !== "on" && get("DEV_MALWARE_SCANNER") !== "on", "Development identity and synthetic scanning must be off.");
  check("authentication", (get("AUTH_MODE") ?? "apikey").toLowerCase().split(/[+,\s]+/).includes("oauth"), "Patient pilot requires OAuth authentication.");
  check("identity", https(get("OIDC_ISSUER")) && !!get("OIDC_AUDIENCE") && !!get("PORTAL_CLIENT_ID") && file("PORTAL_CLIENT_SECRET_FILE"), "HTTPS issuer, API audience, portal client and nonempty secret file must be configured.");
  const origin = get("PUBLIC_ORIGIN");
  check("public-origin", https(origin) && new URL(origin!).origin === origin, "Portal public origin must be an exact HTTPS origin without a path.");
  check("rate-limits", get("RATE_LIMIT") !== "off", "Rate limiting must remain enabled.");
  checks.push({ id: "transport", status: file("TLS_CERT") && file("TLS_KEY") ? "pass" : "review", detail: "Verify direct TLS or the site's trusted HTTPS proxy; file presence does not verify certificates." });
  check("backup", !!get("BACKUP_REMOTE") && file("BACKUP_KEY_FILE"), "Remote backup destination and nonempty encryption-key file must be configured.");
  let scanner: ClamAvScanner | undefined;
  try {
    scanner = new ClamAvScanner({ socketPath: get("CLAMD_SOCKET"), port: get("CLAMD_PORT") === undefined ? undefined : Number(get("CLAMD_PORT")), timeoutMs: 3000 });
    check("scanner-config", true, "Local ClamAV endpoint configuration is valid.");
  } catch { check("scanner-config", false, "Configure exactly one valid local ClamAV socket or loopback port."); }
  if (probeScanner && scanner) {
    try { check("scanner-probe", (await scanner.scan(Buffer.from("Northstar synthetic readiness probe"), "probe.txt")).verdict === "clean", "Harmless synthetic scan must return clean; this does not verify signature freshness."); }
    catch { check("scanner-probe", false, "Scanner unavailable or unexpected reply; no clinical data was sent."); }
  } else checks.push({ id: "scanner-probe", status: "review", detail: "Run preflight with --probe-scanner to exercise the configured local daemon." });
  for (const [id, detail] of [
    ["identity-rehearsal", "Exercise actual clinic login, revocation, expiry and logout through HTTPS."],
    ["notification-receipts", "Select a provider and verify authenticated, replay-safe delivery callbacks and contact ownership."],
    ["restore-rehearsal", "Restore an encrypted off-machine copy on a separate clean host; record integrity checks and recovery time."],
    ["at-rest", "Verify volume encryption and recoverable backup keys on the deployment; configuration assertions are not proof."],
    ["independent-review", "Record independent security, accessibility and clinical workflow review and named approval."],
  ]) checks.push({ id, status: "review", detail });
  return checks;
}
