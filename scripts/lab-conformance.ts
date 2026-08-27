/**
 * Reads a laboratory's sample messages against a profile and reports.
 *
 *   node scripts/lab-conformance.ts --in <file-or-directory> [options]
 *
 *   --in        an .hl7 file, or a directory of them
 *   --profile   profile id from ./labs (default: the generic reading)
 *   --labs      profile directory (default: ./labs)
 *   --json      emit the report as JSON instead of text
 *
 * This is what you take *into* a connectivity test with a laboratory, not the
 * report written after one. It says what their messages did against a profile:
 * what parsed, what refused, which fields were absent, and which assumptions
 * had to be made — each with the question to put to their integration analyst.
 *
 * It does not conclude that an interface conforms, and it does not write a
 * profile from what it saw. Field locations come from the laboratory's own
 * specification; inferring them from a sample and calling the result a vendor
 * interface is the failure `labs/README.md` exists to refuse.
 *
 * Example:
 *
 *   node scripts/lab-conformance.ts --in ./samples/dynacare --profile generic-oru
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { checkConformance, formatReport } from "../src/orders/conformance.ts";
import type { LabProfile } from "../src/orders/hl7.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

function loadProfile(id: string, dir: string): LabProfile {
  const path = join(dir, `${id}.json`);
  // A named profile that is not there is an error, never a silent fall back to
  // the generic reading: a run that reported against a profile it did not have
  // would be the most misleading output this script could produce.
  const raw = readFileSync(path, "utf8");
  return JSON.parse(raw) as LabProfile;
}

function collect(input: string): { messages: string[]; labels: string[] } {
  const messages: string[] = [];
  const labels: string[] = [];
  const stat = statSync(input);
  const files = stat.isDirectory()
    ? readdirSync(input)
        .filter((f) => /\.(hl7|txt|oru)$/i.test(f))
        .sort()
        .map((f) => join(input, f))
    : [input];
  for (const file of files) {
    messages.push(readFileSync(file, "utf8"));
    labels.push(file);
  }
  return { messages, labels };
}

function main(): void {
  const input = arg("in");
  if (!input) {
    console.error("usage: --in <file-or-directory> [--profile id] [--labs dir] [--json]");
    process.exit(2);
  }

  const { messages, labels } = collect(input);
  if (messages.length === 0) {
    console.error(`no .hl7, .txt or .oru files found under ${input}`);
    process.exit(2);
  }

  const profileId = arg("profile");
  const profile = profileId ? loadProfile(profileId, arg("labs") ?? join(process.cwd(), "labs")) : undefined;
  const report = checkConformance(messages, { ...(profile ? { profile } : {}), labels });

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatReport(report));
  }

  // A blocking finding anywhere means the interface would not work as read.
  // Non-zero so this can gate a pipeline, while notes alone do not.
  const blocking = report.messages.some((m) => m.findings.some((f) => f.blocking));
  process.exit(blocking ? 1 : 0);
}

main();
