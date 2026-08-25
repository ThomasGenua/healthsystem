/**
 * The privacy office: queues, clocks, holds, and an assurance catalogue
 * that cannot close a finding by forgetting it.
 *
 * The audit trail records and proves. These tests are the questions a
 * privacy officer actually asks — and the refusals that stop a review,
 * an incident or a finding being marked done with the hard part left blank.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine } from "../src/core/engine.ts";
import { RetentionRunner } from "../src/core/retention.ts";
import { Refusal } from "../src/core/refusal.ts";
import { isAfterHours, ASSURANCE_CONTROLS } from "../src/privacy/office.ts";
import { startApi } from "../src/api/admin.ts";
import { AuthGate } from "../src/auth/gate.ts";
import { readFileSync } from "node:fs";
import { until } from "./helpers.ts";
import type { ChannelConfig, MappingDoc } from "../src/types.ts";

const P = "NT123456";
const OFFICER = { actorId: "privacy-officer", actorKind: "practitioner" };
const GP = { actorId: "dr-tetso", actorKind: "practitioner" };

async function boot() {
  const engine = new Engine({ dbPath: ":memory:", tickMs: 15 });
  await engine.start();
  const t = engine.forTenant("default");
  t.directory.addPractitioner({ id: "dr-tetso", family: "Tetso", given: "Jean" });
  t.directory.addPractitioner({ id: "dr-locum", family: "Locum", given: "Anne" });
  return {
    engine,
    t,
    close: () => engine.stop(),
  };
}

function refuseMatch(re: RegExp) {
  return (err: unknown) => {
    assert.ok(err instanceof Refusal, `expected Refusal, got ${err}`);
    assert.match(err.message, re);
    return true;
  };
}

test("after-hours is decided from a UTC timestamp, not the wall clock", () => {
  const hours = { startHour: 7, endHour: 19 };
  assert.equal(isAfterHours("2026-01-15T03:00:00.000Z", hours), true, "03:00 UTC is before clinic open");
  assert.equal(isAfterHours("2026-01-15T12:00:00.000Z", hours), false, "noon UTC is inside the window");
  assert.equal(isAfterHours("2026-01-15T07:00:00.000Z", hours), false, "the start hour is inside");
  assert.equal(isAfterHours("2026-01-15T19:00:00.000Z", hours), true, "the end hour is after-hours");
  assert.equal(isAfterHours("2026-01-15T12:00:00.000Z", { startHour: 0, endHour: 0 }), true, "equal hours means always");
  assert.equal(isAfterHours("2026-01-15T03:00:00.000Z", { startHour: 0, endHour: 24 }), false, "0–24 means never");
});

test("BACKUP-02 stays partial, and the catalogue is not a SQL seed", () => {
  const backup = ASSURANCE_CONTROLS.find((c) => c.id === "BACKUP-02");
  assert.ok(backup);
  assert.equal(backup.status, "partial");
  assert.ok(ASSURANCE_CONTROLS.every((c) => c.id && c.title && c.evidence));
});

test("closing a review with unaddressed flags is refused", async () => {
  const { t, close } = await boot();
  try {
    t.consent.breakGlass({
      patientId: P,
      by: { actorId: "dr-hale", actorKind: "practitioner" },
      reason: "unconscious, no collateral history, need the allergy list",
    });
    const review = t.privacy.openReview(OFFICER);
    assert.ok(review.flags.some((f) => f.status === "open"));
    assert.throws(
      () => t.privacy.closeReview(review.id, { conclusion: "looks fine to me, closing now" }, OFFICER),
      refuseMatch(/address every flag/)
    );
    assert.equal(t.privacy.getReview(review.id).status, "open");
  } finally {
    await close();
  }
});

test("addressing a flag needs a written reason, and closing needs a conclusion", async () => {
  const { t, close } = await boot();
  try {
    t.consent.breakGlass({
      patientId: P,
      by: { actorId: "dr-hale", actorKind: "practitioner" },
      reason: "unconscious, no collateral history, need the allergy list",
    });
    const review = t.privacy.openReview(OFFICER);
    const flag = review.flags.find((f) => f.status === "open");
    assert.ok(flag);
    assert.throws(
      () => t.privacy.addressFlag(flag.id, { status: "accepted", reason: "ok" }, OFFICER),
      refuseMatch(/written reason/)
    );
    t.privacy.addressFlag(flag.id, { status: "accepted", reason: "reviewed against the ED notes" }, OFFICER);
    for (const f of t.privacy.getReview(review.id).flags.filter((x) => x.status === "open")) {
      t.privacy.addressFlag(f.id, { status: "escalated", reason: "handed to the privacy officer" }, OFFICER);
    }
    assert.throws(
      () => t.privacy.closeReview(review.id, { conclusion: "done" }, OFFICER),
      refuseMatch(/written conclusion/)
    );
    const closed = t.privacy.closeReview(
      review.id,
      { conclusion: "every flag addressed; no further action" },
      OFFICER
    );
    assert.equal(closed.status, "closed");
  } finally {
    await close();
  }
});

test("an active legal hold skips the retention sweep", async () => {
  const ADT = readFileSync(new URL("../fixtures/adt_a01.hl7", import.meta.url), "utf8");
  const mapping = JSON.parse(
    readFileSync(new URL("../mappings/adt-patient.json", import.meta.url), "utf8")
  ) as MappingDoc;
  const channel: ChannelConfig = {
    id: "retain",
    name: "retention",
    source: { type: "http", path: "retain" },
    pipeline: [{ type: "transform.mapping", mapping: "adt-patient" }],
    destinations: [{ id: "facade", type: "fhirstore", ordered: true }],
  };
  const engine = new Engine({ dbPath: ":memory:", tickMs: 15 });
  engine.registerMapping(mapping);
  await engine.start();
  try {
    await engine.addChannel(channel);
    engine.ingest("retain", ADT, "x-application/hl7-v2+er7", "test");
    await until(() => engine.db.listDeliveries({ channelId: "retain", state: "delivered" }).length === 1);
    const when = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString().replace("T", " ").slice(0, 19);
    for (const { id } of engine.db.sql.prepare("SELECT id FROM messages WHERE channel_id = ?").all("retain") as Array<{
      id: string;
    }>) {
      engine.db.sql.prepare("UPDATE messages SET received_at = ? WHERE id = ?").run(when, id);
    }

    const t = engine.forTenant("default");
    t.privacy.placeHold({ reason: "litigation hold on the message log" }, OFFICER);
    const skipped = new RetentionRunner(t.db, { redactAfterDays: 30 }).run();
    assert.equal(skipped.skippedBecause, "active legal hold");
    assert.equal(skipped.redactedMessages, 0);
    const raw = engine.db.listMessages({ channelId: "retain" })[0].raw;
    assert.ok(raw.includes("Beaulieu"), "the payload is still there");

    t.privacy.releaseHold(t.privacy.listHolds()[0].id, { reason: "matter closed, release it" }, OFFICER);
    const ran = new RetentionRunner(t.db, { redactAfterDays: 30 }).run();
    assert.equal(ran.skippedBecause, undefined);
    assert.equal(ran.redactedMessages, 1);
  } finally {
    await engine.stop();
  }
});

test("overdue access requests are a queue, not a hard stop", async () => {
  const { t, close } = await boot();
  try {
    const req = t.patientAccess.submitRequest({
      patientId: P,
      kind: "access",
      detail: "Please provide a copy of my chart.",
      by: { subjectId: P, relationship: "self" },
    });
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    t.db.sql
      .prepare("UPDATE patient_requests SET submitted_at = ? WHERE tenant_id = ? AND id = ?")
      .run(old, t.db.tenantId, req.id);
    const inbox = t.privacy.inbox();
    const overdue = inbox.pendingAccess.find((r) => r.id === req.id);
    assert.ok(overdue?.overdue, "thirty days on, it is on the queue");
    t.privacy.extendDeadline(
      req.id,
      { until: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString(), reason: "patient asked for more time" },
      OFFICER
    );
    const later = t.privacy.inbox().pendingAccess.find((r) => r.id === req.id);
    assert.equal(later?.overdue, false, "an extended clock is still a clock, not a refusal to disclose");
  } finally {
    await close();
  }
});

test("fulfilling an access request records a disclosure", async () => {
  const { t, close } = await boot();
  try {
    const req = t.patientAccess.submitRequest({
      patientId: P,
      kind: "access",
      detail: "Please provide a copy of my chart.",
      by: { subjectId: P, relationship: "self" },
    });
    const result = t.privacy.fulfillAccess(
      req.id,
      { sections: [{ name: "allergies", count: 1 }, { name: "medications", count: 2 }] },
      OFFICER
    );
    assert.equal(result.disclosure.patientId, P);
    assert.equal(result.disclosure.sections.length, 2);
    assert.equal(t.patientAccess.request(req.id)?.status, "completed");
    assert.equal(
      t.privacy.inbox().pendingAccess.some((r) => r.id === req.id && r.completedWithoutDisclosure),
      false
    );
  } finally {
    await close();
  }
});

test("completing access without a disclosure is flagged, not blocked", async () => {
  const { t, close } = await boot();
  try {
    const req = t.patientAccess.submitRequest({
      patientId: P,
      kind: "access",
      detail: "Please provide a copy of my chart.",
      by: { subjectId: P, relationship: "self" },
    });
    t.patientAccess.completeRequest(req.id, { ...OFFICER, outcome: "printed a copy at the desk" });
    const review = t.privacy.openReview(OFFICER);
    assert.ok(review.flags.some((f) => f.kind === "access-without-disclosure" && f.detail.includes(req.id)));
  } finally {
    await close();
  }
});

test("closing an incident without saying whether patients were told is refused", async () => {
  const { t, close } = await boot();
  try {
    const incident = t.privacy.openIncident(OFFICER);
    assert.throws(
      () =>
        t.privacy.closeIncident(
          incident.id,
          {
            whatHappened: "a letter went to the wrong household",
            noneAffected: true,
            notification: "not-told",
          },
          OFFICER
        ),
      refuseMatch(/write why/)
    );
    assert.throws(
      () =>
        t.privacy.closeIncident(
          incident.id,
          {
            whatHappened: "a letter went to the wrong household",
            notification: "told",
          },
          OFFICER
        ),
      refuseMatch(/affected patients|noneAffected/)
    );
    const closed = t.privacy.closeIncident(
      incident.id,
      {
        whatHappened: "a letter went to the wrong household and was retrieved",
        noneAffected: true,
        notification: "not-told",
        notificationReason: "the envelope was unopened",
      },
      OFFICER
    );
    assert.equal(closed.status, "closed");
    assert.equal(closed.notification, "not-told");
  } finally {
    await close();
  }
});

test("an active subprocessor without a hosting region is refused", async () => {
  const { t, close } = await boot();
  try {
    assert.throws(
      () =>
        t.privacy.upsertSubprocessor(
          { name: "Cloud disks", purpose: "object storage", status: "active" },
          OFFICER
        ),
      refuseMatch(/hosting region/)
    );
    const candidate = t.privacy.upsertSubprocessor(
      { name: "Cloud disks", purpose: "object storage", status: "candidate" },
      OFFICER
    );
    assert.equal(candidate.region, null);
    const active = t.privacy.upsertSubprocessor(
      { id: candidate.id, name: "Cloud disks", purpose: "object storage", region: "ca-central-1", status: "active" },
      OFFICER
    );
    assert.equal(active.status, "active");
    assert.equal(active.region, "ca-central-1");
  } finally {
    await close();
  }
});

test("closing a finding without remediation or residual risk is refused", async () => {
  const { t, close } = await boot();
  try {
    const finding = t.privacy.openFinding(
      { controlId: "BACKUP-02", description: "the replica is still an operator copying a file" },
      OFFICER
    );
    assert.throws(() => t.privacy.closeFinding(finding.id, {}, OFFICER), refuseMatch(/remediation or an accepted residual/));
    const closed = t.privacy.closeFinding(
      finding.id,
      { residualRisk: "accepted until a second site is contracted" },
      OFFICER
    );
    assert.equal(closed.status, "closed");
    assert.equal(closed.residualRisk, "accepted until a second site is contracted");
  } finally {
    await close();
  }
});

test("staff not on the care team are flagged, and an empty team is not", async () => {
  const { t, close } = await boot();
  try {
    t.careTeam.assign({ patientId: P, practitionerId: "dr-tetso", role: "primary", by: { actorId: "ops" } });
    t.audit.record({
      action: "R",
      principalId: "dr-locum",
      principalKind: "practitioner",
      method: "GET",
      path: "/api/clinical/chart",
      patient: P,
      resourceType: "Composition",
      outcome: 0,
    });
    t.audit.record({
      action: "R",
      principalId: "dr-alone",
      principalKind: "practitioner",
      method: "GET",
      path: "/api/clinical/chart",
      patient: "NT-none",
      resourceType: "Composition",
      outcome: 0,
    });
    const review = t.privacy.openReview(OFFICER, { hours: { startHour: 0, endHour: 24 } });
    assert.ok(
      review.flags.some((f) => f.kind === "not-on-care-team" && f.principalId === "dr-locum" && f.patientId === P)
    );
    assert.equal(
      review.flags.some((f) => f.kind === "not-on-care-team" && f.patientId === "NT-none"),
      false,
      "an empty care team is not a team somebody is missing from"
    );
  } finally {
    await close();
  }
});

test("one custodian's privacy office cannot see another's reviews or holds", async () => {
  const engine = new Engine({ dbPath: ":memory:", tickMs: 15 });
  await engine.start();
  try {
    engine.db.createTenant("north", "Northern Health");
    engine.db.createTenant("south", "Southern Health");
    const north = engine.forTenant("north");
    const south = engine.forTenant("south");
    north.privacy.placeHold({ reason: "northern litigation, tenant-wide hold" }, OFFICER);
    north.privacy.openIncident(OFFICER);
    assert.equal(south.privacy.listHolds().length, 0);
    assert.equal(south.privacy.listIncidents().length, 0);
    assert.equal(south.privacy.hasActiveHold(), false);
    assert.equal(north.privacy.hasActiveHold(), true);
  } finally {
    await engine.stop();
  }
});

test("privacy-office HTTP reads do not apply a patient lockbox", async () => {
  const engine = new Engine({ dbPath: ":memory:", tickMs: 15 });
  await engine.start();
  const t = engine.forTenant("default");
  t.consent.record({
    patientId: P,
    kind: "withhold-all",
    by: OFFICER,
    reason: "patient asked",
  });
  t.consent.breakGlass({
    patientId: P,
    by: { actorId: "dr-hale", actorKind: "practitioner" },
    reason: "unconscious, no collateral history, need the allergy list",
  });
  const admin = t.keys.issue("ops", ["admin"]).key;
  const api = await startApi(engine, 0, "127.0.0.1", { auth: new AuthGate({ keys: engine.keys }) });
  try {
    const res = await fetch(`http://127.0.0.1:${api.port}/api/clinical/privacy-inbox`, {
      headers: { authorization: `Bearer ${admin}` },
    });
    assert.equal(res.status, 200, "a lockbox must not hide the office from the override it has to review");
    const inbox = (await res.json()) as { unreviewedBreakGlass: Array<{ patient_id: string }> };
    assert.ok(inbox.unreviewedBreakGlass.some((o) => o.patient_id === P));
  } finally {
    await api.close();
    await engine.stop();
  }
});
