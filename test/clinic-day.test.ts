/**
 * What "today" and "after hours" mean at the clinic.
 *
 * Every instant below that names a real zone is one on which the runtimes
 * this is tested with agree. They do not agree everywhere: tzdata 2026c
 * (Node 24.21) keeps America/Edmonton — and America/Yellowknife, which it
 * treats as Edmonton — on UTC-06:00 from November 2026, where 2025c (Node
 * 22.22) falls back to UTC-07:00. A test pinned to a date after that would
 * pass on one runtime and fail on the other, and it would be testing the
 * zone database rather than this code. So the transitions used are ones
 * both copies record the same way: Edmonton's spring forward in March 2026
 * and fall back in November 2025, and Havana's two midnight transitions in
 * 2024.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ClinicDay, resolveClinicTimeZone } from "../src/schedule/clinic-day.ts";
import { Engine } from "../src/core/engine.ts";
import { isAfterHours } from "../src/privacy/office.ts";
import { pilotPreflight } from "../src/core/preflight.ts";

const hours = (w: { from: string; to: string }) => (Date.parse(w.to) - Date.parse(w.from)) / 3600_000;
const CLERK = { actorId: "clerk", actorKind: "practitioner" };
const OFFICER = { actorId: "privacy-officer", actorKind: "practitioner" };

// ------------------------------------------------------------ unset and fixed

test("unset is the UTC day, exactly as every today was before", () => {
  for (const unset of [undefined, "", "   "]) {
    assert.deepEqual(ClinicDay.parse(unset).window("2026-03-04T20:00:00.000Z"), {
      date: "2026-03-04", from: "2026-03-04T00:00:00.000Z", to: "2026-03-05T00:00:00.000Z",
    });
  }
  assert.equal(ClinicDay.parse("UTC").kind, "utc");
  assert.equal(ClinicDay.parse("Etc/UTC").kind, "utc");
});

test("a fixed offset is that offset all year, which is its point and its cost", () => {
  const fixed = ClinicDay.parse("-07:00");
  assert.deepEqual(fixed.window("2026-03-04T20:00:00.000Z"), {
    date: "2026-03-04", from: "2026-03-04T07:00:00.000Z", to: "2026-03-05T07:00:00.000Z",
  });
  // In July too: a fixed offset does not spring forward. Right for a clinic
  // that does not observe daylight saving; an hour out for one that does.
  assert.equal(fixed.window("2026-07-15T20:00:00.000Z").from, "2026-07-15T07:00:00.000Z");
  for (const spelling of ["-07:00", "-0700"]) assert.equal(ClinicDay.parse(spelling).configured, "-07:00");
  assert.equal(ClinicDay.parse("+05:45").window("2026-03-04T12:00:00.000Z").from, "2026-03-03T18:15:00.000Z");
});

// -------------------------------------------------------------- a real place

test("a place follows daylight saving: local midnight in winter and in summer", () => {
  const edmonton = ClinicDay.parse("America/Edmonton");
  assert.equal(edmonton.kind, "zone");
  assert.deepEqual(edmonton.window("2026-01-15T20:00:00.000Z"), {
    date: "2026-01-15", from: "2026-01-15T07:00:00.000Z", to: "2026-01-16T07:00:00.000Z",
  });
  assert.deepEqual(edmonton.window("2026-07-15T20:00:00.000Z"), {
    date: "2026-07-15", from: "2026-07-15T06:00:00.000Z", to: "2026-07-16T06:00:00.000Z",
  });
});

test("the two days a year that are not twenty-four hours long are not", () => {
  const edmonton = ClinicDay.parse("America/Edmonton");
  // 8 March 2026: 02:00 becomes 03:00. Twenty-three hours, and a booking at
  // 23:30 that night is still that day's.
  const spring = edmonton.window("2026-03-08T20:00:00.000Z");
  assert.equal(hours(spring), 23);
  assert.equal(edmonton.dateOf("2026-03-09T05:30:00.000Z"), "2026-03-08", "23:30 local is still the 8th");
  assert.equal(edmonton.dateOf("2026-03-09T06:30:00.000Z"), "2026-03-09", "00:30 local is the 9th");
  // 2 November 2025: 02:00 comes twice. Twenty-five hours; the end of the
  // day is the start of the next date, not the start plus twenty-four.
  const autumn = edmonton.window("2025-11-02T20:00:00.000Z");
  assert.deepEqual(autumn, { date: "2025-11-02", from: "2025-11-02T06:00:00.000Z", to: "2025-11-03T07:00:00.000Z" });
  assert.equal(hours(autumn), 25);
});

test("where the clocks change at midnight, the day starts when the calendar first reads it", () => {
  const havana = ClinicDay.parse("America/Havana");
  // 10 March 2024: 23:59:59 on the 9th is followed by 01:00 on the 10th.
  // There is no midnight, so the day starts at 01:00.
  const skipped = havana.window("2024-03-10T12:00:00.000Z");
  assert.deepEqual(skipped, { date: "2024-03-10", from: "2024-03-10T05:00:00.000Z", to: "2024-03-11T04:00:00.000Z" });
  assert.equal(havana.dateOf("2024-03-10T04:59:59.000Z"), "2024-03-09");
  // 3 November 2024: 00:59:59 is followed by 00:00 again. The day starts at
  // the first midnight, so the hour that happens twice is inside it once.
  const repeated = havana.window("2024-11-03T12:00:00.000Z");
  assert.deepEqual(repeated, { date: "2024-11-03", from: "2024-11-03T04:00:00.000Z", to: "2024-11-04T05:00:00.000Z" });
  assert.equal(hours(repeated), 25);

  // East of UTC the same skipped midnight lands the other side of UTC's, and
  // this is the case a single offset lookup gets wrong: the offset in force
  // at 00:00Z on the 31st is already the summer one, which would start the
  // day at 21:00Z -- an hour of the 30th's evening. 31 March 2024 in Beirut
  // goes from 23:59:59 on the 30th to 01:00.
  const beirut = ClinicDay.parse("Asia/Beirut");
  assert.equal(beirut.window("2024-03-31T12:00:00.000Z").from, "2024-03-30T22:00:00.000Z");
  assert.equal(beirut.dateOf("2024-03-30T21:30:00.000Z"), "2024-03-30", "23:30 on the 30th is not the 31st");
});

test("the hour is the clinic's hour", () => {
  const edmonton = ClinicDay.parse("America/Edmonton");
  assert.equal(edmonton.hourOf("2026-01-15T21:00:00.000Z"), 14, "an afternoon in Edmonton");
  assert.equal(edmonton.hourOf("2026-01-15T10:00:00.000Z"), 3, "the middle of the night");
  assert.equal(edmonton.hourOf("2026-07-15T10:00:00.000Z"), 4, "an hour later on the clock in summer");
  assert.equal(ClinicDay.parse("-07:00").hourOf("2026-07-15T10:00:00.000Z"), 3, "a fixed offset does not move");
});

// ----------------------------------------------------------------- refusals

test("anything that is not a place or an offset is refused, and says why", () => {
  const refused: Array<[string, RegExp]> = [
    ["America/Yelowknife", /not in this runtime's time-zone data \(tzdata /],
    // In the zone database, but as fixed offsets: "EST" would be a clinic
    // that never springs forward.
    ["EST", /abbreviation says nothing reliable about daylight saving/],
    ["MST", /abbreviation says nothing reliable about daylight saving/],
    ["CST6CDT", /abbreviation/],
    // UTC-07:00, with the sign the other way round from every other spelling.
    ["Etc/GMT+7", /sign is inverted/],
    ["-7", /a place like America\/Yellowknife or an offset like -07:00/],
    ["-07:75", /out of range/],
    ["-19:00", /out of range/],
  ];
  for (const [value, why] of refused) assert.throws(() => ClinicDay.parse(value), why, value);
});

// ----------------------------------------------------- what it says it means

test("a name the runtime treats as another zone says so, with which copy of the rules said it", () => {
  // Resolved rather than hard-coded: whether America/Yellowknife is an alias
  // is itself a fact about the zone database, and a later copy could split
  // it back out. What must hold is that the line says what the runtime did.
  const day = ClinicDay.parse("America/Yellowknife");
  const resolved = new Intl.DateTimeFormat("en", { timeZone: "America/Yellowknife" }).resolvedOptions().timeZone;
  assert.equal(day.zone, resolved);
  const line = day.describe("2026-09-22T17:00:00.000Z");
  assert.match(line, /^America\/Yellowknife/);
  assert.ok(line.includes(`tzdata ${process.versions.tz}`), "which copy of the rules");
  if (resolved !== "America/Yellowknife") assert.ok(line.includes(`treats as ${resolved}`), "and what it resolved to");
  assert.match(line, /now UTC-0[67]:00, 2026-09-22 at the clinic$/);
  assert.equal(ClinicDay.parse("-07:00").describe("2026-09-22T17:00:00.000Z"), "-07:00, fixed all year; now UTC-07:00, 2026-09-22 at the clinic");
});

test("the setting has one name, and the one it replaced is refused rather than ignored", () => {
  assert.equal(resolveClinicTimeZone({}), undefined);
  assert.equal(resolveClinicTimeZone({ NORTHSTAR_CLINIC_TIMEZONE: " " }), undefined);
  assert.equal(resolveClinicTimeZone({ NORTHSTAR_CLINIC_TIMEZONE: "America/Edmonton" }), "America/Edmonton");
  assert.equal(resolveClinicTimeZone({ PORTAGE_CLINIC_TIMEZONE: "-07:00" }), "-07:00", "the legacy prefix works as it does everywhere");
  // Ignored, it would read as UTC: a board hours out with nothing to say why.
  assert.throws(() => resolveClinicTimeZone({ NORTHSTAR_CLINIC_UTC_OFFSET: "-07:00" }), /renamed before release to NORTHSTAR_CLINIC_TIMEZONE/);
});

// ---------------------------------------------- one calendar for everything

test("the worklist and the board agree about who is expected today", async () => {
  const engine = new Engine({ dbPath: ":memory:", tickMs: 15, orderDispatchIntervalMs: 0, clinicTimeZone: "America/Edmonton" });
  await engine.start();
  try {
    const t = engine.forTenant("default");
    for (const id of ["NT000001", "NT000002"]) {
      t.clinical.record({ entryType: "Patient", patientId: id, content: { resourceType: "Patient" }, authorId: "adt", authorKind: "device" });
    }
    // 15 January 2026: 09:00 and 18:00 in Edmonton. The second is already
    // the 16th in UTC.
    const booked = [["NT000001", "2026-01-15T16:00:00.000Z"], ["NT000002", "2026-01-16T01:00:00.000Z"]].map(([patientId, startsAt]) => {
      const slot = t.schedule.openSlot({ resourceId: "dr-okpik", resourceKind: "practitioner", service: "Family practice",
        startsAt: startsAt!, endsAt: new Date(Date.parse(startsAt!) + 1800_000).toISOString() });
      return t.schedule.book({ slotId: slot.id, patientId: patientId!, reason: "Follow-up", by: CLERK }).id;
    });
    const atOneInTheAfternoon = "2026-01-15T20:00:00.000Z";
    const worklist = t.schedule.today("dr-okpik", atOneInTheAfternoon).map((r) => r.booking.id);
    const board = t.board.waiting(["dr-okpik"], new Date(atOneInTheAfternoon)).map((r) => r.bookingId);
    assert.deepEqual(worklist.sort(), [...booked].sort(), "the clinician's own day, both appointments");
    assert.deepEqual(board.sort(), worklist.sort(), "and the front desk's is the same day");
  } finally {
    await engine.stop();
  }
});

test("after hours is read on the clinic's clocks when it has them, and on UTC's when it does not", () => {
  const hoursWindow = { startHour: 7, endHour: 19 };
  const edmonton = ClinicDay.parse("America/Edmonton");
  // 21:00Z on 15 January is 14:00 in Edmonton: an ordinary afternoon.
  assert.equal(isAfterHours("2026-01-15T21:00:00.000Z", hoursWindow, edmonton), false);
  // 10:00Z is 03:00 there: exactly the read this check exists to notice.
  assert.equal(isAfterHours("2026-01-15T10:00:00.000Z", hoursWindow, edmonton), true);
  // Without a clinic zone both answers are the other way round, which is
  // R-19 and why the default is not good enough anywhere west of UTC.
  assert.equal(isAfterHours("2026-01-15T21:00:00.000Z", hoursWindow), true);
  assert.equal(isAfterHours("2026-01-15T10:00:00.000Z", hoursWindow), false);
});

test("the privacy review uses the engine's clinic clock, and names it on the finding", async () => {
  const engine = new Engine({ dbPath: ":memory:", tickMs: 15, orderDispatchIntervalMs: 0, clinicTimeZone: "+12:00" });
  await engine.start();
  try {
    const t = engine.forTenant("default");
    t.audit.record({ action: "R", principalId: "dr-late", principalKind: "practitioner", method: "GET",
      path: "/api/clinical/chart", patient: "NT000001", resourceType: "Composition", outcome: 0 });
    // Clinic hours chosen around the read's own UTC hour, so on UTC clocks it
    // is inside them and on the clinic's -- twelve hours on -- it is not.
    // Deterministic whenever the suite runs.
    const recordedAt = (t.db.sql.prepare("SELECT recorded_at FROM audit_events WHERE principal_id = 'dr-late'").get() as { recorded_at: string }).recorded_at;
    const utcHour = new Date(recordedAt).getUTCHours();
    const around = { startHour: utcHour, endHour: (utcHour + 1) % 24 || 24 };

    const review = t.privacy.openReview(OFFICER, { hours: around });
    const flag = review.flags.find((f) => f.kind === "after-hours" && f.principalId === "dr-late");
    assert.ok(flag, "on the clinic's clock this read was outside its hours");
    assert.match(flag.detail, /clinic hours \d+–\d+, \+12:00\)/, "and the finding says whose clock it was read on");
  } finally {
    await engine.stop();
  }
});

// ------------------------------------------------------------------ preflight

test("preflight blocks a pilot that has not said where the clinic is, and never echoes the value", async () => {
  const unset = (await pilotPreflight({})).find((c) => c.id === "clinic-timezone");
  assert.equal(unset?.status, "blocker");
  assert.equal((await pilotPreflight({ NORTHSTAR_CLINIC_UTC_OFFSET: "-07:00" })).find((c) => c.id === "clinic-timezone")?.status, "blocker",
    "the retired name is not quietly accepted");
  assert.equal((await pilotPreflight({ NORTHSTAR_CLINIC_TIMEZONE: "Mars/Olympus_Mons" })).find((c) => c.id === "clinic-timezone")?.status, "blocker");

  // Set, it is a review: configuration can say which rules apply, not that
  // they are the clinic's.
  const zone = (await pilotPreflight({ NORTHSTAR_CLINIC_TIMEZONE: "America/Edmonton" })).find((c) => c.id === "clinic-timezone")!;
  assert.equal(zone.status, "review");
  assert.ok(zone.detail.includes(`tzdata ${process.versions.tz}`));
  assert.equal(zone.detail.includes("Edmonton"), false, "configuration values are not echoed into a report people paste into tickets");
  const fixed = (await pilotPreflight({ NORTHSTAR_CLINIC_TIMEZONE: "-07:00" })).find((c) => c.id === "clinic-timezone")!;
  assert.equal(fixed.status, "review");
  assert.match(fixed.detail, /does not observe daylight saving/);
});
