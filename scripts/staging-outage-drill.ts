import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
const execute = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const project = "northstar-alert-drill";
const compose = ["compose", "-p", project, "-f", "deploy/staging/compose.yaml", "-f", "deploy/staging/monitoring.yaml", "--profile", "monitoring"];
let cancelled = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { cancelled = true; });
async function docker(args: string[]) {
  const result = await execute("docker", args, { cwd: root, timeout: 240_000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, NORTHSTAR_STAGING_PORT: "18986" }, windowsHide: true });
  return result.stdout;
}
async function json<T>(url: string): Promise<T> {
  const res = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(3000) });
  if (!res.ok) throw new Error("Local drill service not ready");
  return await res.json() as T;
}
async function until(check: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline && !cancelled) {
    try { if (await check()) return; } catch { /* startup/outage is expected */ }
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
  throw new Error(cancelled ? "Drill interrupted" : `Timed out waiting for ${label}`);
}
async function main() {
  // Refuse existing containers: never stop a pre-existing stack or use a user-supplied project.
  if ((await docker(["ps", "-aq", "--filter", `label=com.docker.compose.project=${project}`])).trim()) {
    throw new Error("Drill project already exists; inspect it before rerunning");
  }
  try {
    console.log("Starting isolated synthetic alert drill (no external notifications)");
    await docker([...compose, "up", "--build", "-d", "--wait", "--wait-timeout", "120", "app", "prometheus", "alertmanager", "alert-sink"]);
    await until(async () => {
      const response = await json<{ data?: { result?: Array<{ value: [number, string] }> } }>("http://127.0.0.1:19090/api/v1/query?query=up%7Bjob%3D%22northstar%22%7D");
      return response.data?.result?.[0]?.value?.[1] === "1";
    }, "successful metrics scrape");
    const baseline = (await json<{ events: unknown[] }>("http://127.0.0.1:19094/events")).events.length;
    console.log("Stopping only the drill app; waiting for a real firing notification");
    await docker([...compose, "stop", "app"]);
    const observed = async (status: string) => {
      const body = await json<{ events: Array<{ name: string; status: string }> }>("http://127.0.0.1:19094/events");
      return body.events.slice(baseline).some((event: { name: string; status: string }) => event.name === "NorthstarServiceDown" && event.status === status);
    };
    await until(() => observed("firing"), "firing notification");
    console.log("Firing received; restarting drill app and waiting for resolved notification");
    await docker([...compose, "start", "app"]);
    await until(() => observed("resolved"), "resolved notification");
    console.log("PASSED: scrape → outage rule → Alertmanager → local receiver → recovery. No operator was notified.");
  } finally {
    await docker([...compose, "down"]); // No -v: retain the dedicated synthetic data volume.
  }
}
main().catch(() => { console.error("Outage drill failed or interrupted; inspect the isolated northstar-alert-drill project. No remote service was modified."); process.exitCode = 1; });
