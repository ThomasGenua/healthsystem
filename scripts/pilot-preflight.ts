import { pilotPreflight } from "../src/core/preflight.ts";
const checks = await pilotPreflight(process.env, process.argv.includes("--probe-scanner"));
console.log(JSON.stringify({ deploymentApproved: false, checks }, null, 2));
process.exitCode = checks.some(check => check.status === "blocker") ? 1 : 0;
