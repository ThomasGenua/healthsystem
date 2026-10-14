import { statSync } from "node:fs";
import { readEnv } from "./naming.ts";
import { ClamAvScanner } from "../patient/clamav.ts";
import { ClinicDay, resolveClinicTimeZone } from "../schedule/clinic-day.ts";

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
  // A review rather than a pass when set: configuration can say which rules
  // the runtime will apply, not that they are the clinic's. The value itself
  // is not echoed, per the rule above; what it resolves to now is evidence.
  try {
    const zone = resolveClinicTimeZone(env);
    if (zone === undefined) {
      check("clinic-timezone", false, "Set NORTHSTAR_CLINIC_TIMEZONE to where the clinic is; unset, the board and worklist use the UTC day and the privacy review reads after hours on UTC clocks.");
    } else {
      const day = ClinicDay.parse(zone);
      checks.push({
        id: "clinic-timezone",
        status: "review",
        detail: day.kind === "offset"
          ? "A fixed offset, the same all year: correct only where the clinic does not observe daylight saving."
          : `A place name, resolved against this runtime's time-zone data (tzdata ${process.versions.tz ?? "unknown"}). ` +
            `Confirm the offset it gives matches the clinic's clocks, and again after any Node upgrade: ${day.now()}.`,
      });
    }
  } catch {
    check("clinic-timezone", false, "NORTHSTAR_CLINIC_TIMEZONE is not a place or offset this runtime accepts, or a retired name is set; boot refuses it.");
  }
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
