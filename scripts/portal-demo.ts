/**
 * Seeds a database with synthetic people, so the patient portal can be seen
 * working.
 *
 *     node scripts/portal-demo.ts [data-dir]
 *     NORTHSTAR_DEV_IDP=on npm start
 *     open http://127.0.0.1:8686/me
 *
 * Everything written here is invented. The names are obviously not real
 * people's, the health numbers are outside any issued range, and the results
 * are round numbers a laboratory would not produce. That is deliberate: a
 * demo database that looked like real charts is a demo database somebody
 * eventually treats as one.
 *
 * It seeds two things worth seeing and one worth arguing about:
 *
 *   - a patient with a released result and a held one, so the difference
 *     between "your result is here" and "your clinician wants to talk to you
 *     about this first" is visible rather than described;
 *   - a caregiver whose grant covers appointments and nothing else, so the
 *     portal's narrower shape for a delegate is visible too;
 *   - an expiry on that caregiver's grant, because a delegated authority
 *     with no end is the failure the whole design guards against, and a demo
 *     that omitted it would be showing the wrong product.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Engine } from "../src/core/engine.ts";
import { resolveDbPath } from "../src/core/naming.ts";
import { DEFAULT_TENANT } from "../src/db.ts";

const dataDir = process.argv[2] ?? join(process.cwd(), "data");
mkdirSync(dataDir, { recursive: true });
const dbPath = resolveDbPath(dataDir).path;

const PATIENT = "NT000001";
const CAREGIVER_OF = PATIENT;
const CLERK = { actorId: "clerk-avery", actorKind: "practitioner" as const };
const DOCTOR = { actorId: "dr-okpik", actorKind: "practitioner" as const };
const in30Days = new Date(Date.now() + 30 * 86400_000).toISOString();
const in7Days = new Date(Date.now() + 7 * 86400_000).toISOString();
const nextWeek = new Date(Date.now() + 8 * 86400_000);

const engine = new Engine({ dbPath, tickMs: 250 });
await engine.start();
const t = engine.forTenant(DEFAULT_TENANT);

try {
  t.clinical.record({
    entryType: "Patient",
    patientId: PATIENT,
    content: {
      resourceType: "Patient",
      identifier: [{ system: "urn:northstar:demo", value: PATIENT }],
      name: [{ family: "Testperson", given: ["Sunniva"] }],
      birthDate: "1971-04-02",
      communication: [{ language: { coding: [{ code: "en-CA" }] } }],
    },
    authorId: "portal-demo",
    authorKind: "device",
  });

  // Something to read.
  t.orders.report({
    patientId: PATIENT,
    code: "2823-3",
    display: "Potassium",
    value: "4.1",
    unit: "mmol/L",
    referenceRange: "3.5-5.0",
    reportedBy: "Synthetic Regional Laboratory",
  });

  // And something not to read yet, which is the more interesting half.
  const held = t.orders.report({
    patientId: PATIENT,
    code: "24627-2",
    display: "Chest imaging",
    value: "see report",
    reportedBy: "Synthetic Regional Laboratory",
  });
  t.patientAccess.hold({
    resultId: held.id,
    category: "clinician-will-discuss",
    releaseAt: in7Days,
    reason: "Dr Okpik would like to go through this one in person first.",
    by: DOCTOR,
  });

  const slot = t.schedule.openSlot({
    resourceId: "dr-okpik",
    service: "Family practice",
    startsAt: new Date(nextWeek.setHours(10, 0, 0, 0)).toISOString(),
    endsAt: new Date(nextWeek.setHours(10, 30, 0, 0)).toISOString(),
  });
  t.schedule.book({
    slotId: slot.id,
    patientId: PATIENT,
    reason: "Follow-up on last month's results",
    by: DOCTOR,
  });

  // The patient's own access. A clerk writes how they checked identity;
  // nothing here is identity proofing, and the method text says so.
  t.patientAccess.grantSelf(PATIENT, "urn:demo:sunniva", CLERK);

  // A caregiver, narrowly. Appointments only, and it ends.
  t.patientAccess.grantProxy({
    patientId: CAREGIVER_OF,
    subjectId: "urn:demo:kiona",
    relationship: "representative",
    expiresAt: in30Days,
    permissions: ["appointments"],
    purpose: "drives Sunniva to appointments",
    by: CLERK,
  });

  const base = `http://127.0.0.1:${process.env.PORT ?? "8686"}`;
  console.log(
    [
      "",
      `  Seeded ${dbPath} with synthetic people.`,
      "",
      "    urn:demo:sunniva   the patient — a released result, a held one, an appointment",
      "    urn:demo:kiona     a caregiver — appointments only, expiring in 30 days",
      "",
      "  Then:",
      "",
      "    NORTHSTAR_DEV_IDP=on npm start",
      `    open ${base}/me`,
      "",
      "  The sign-in page lists exactly those two, because they are who the clinic",
      "  has granted a chart to. Signing in as the caregiver shows one tab; signing",
      "  in as the patient shows seven, and the held result says why it is held.",
      "",
      "  Everything above is invented. Do not point this at a real person.",
      "",
    ].join("\n")
  );
} finally {
  await engine.stop();
}
