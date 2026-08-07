import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Db } from "../src/db.ts";
import { Engine } from "../src/core/engine.ts";
import { startApi } from "../src/api/admin.ts";
import { RetentionRunner } from "../src/core/retention.ts";
import { until } from "./helpers.ts";
import type { ChannelConfig, MappingDoc } from "../src/types.ts";

const ADT = readFileSync(new URL("../fixtures/adt_a01.hl7", import.meta.url), "utf8");
const MAPPING = JSON.parse(
  readFileSync(new URL("../mappings/adt-patient.json", import.meta.url), "utf8")
) as MappingDoc;

const CHANNEL: ChannelConfig = {
  id: "retain",
  name: "retention",
  source: { type: "http", path: "retain" },
  pipeline: [
    { type: "filter.hl7Type", allow: ["ADT^A01", "ADT^A04"] },
    { type: "transform.mapping", mapping: "adt-patient" },
  ],
  destinations: [{ id: "facade", type: "fhirstore", ordered: true }],
};

/** Backdates rows so a retention cutoff can be exercised without waiting. */
function backdate(db: Db, channelId: string, days: number, limit?: number): void {
  const when = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().replace("T", " ").slice(0, 19);
  const ids = db.sql
    .prepare(`SELECT id FROM messages WHERE channel_id = ? ORDER BY seq${limit ? " LIMIT " + limit : ""}`)
    .all(channelId) as Array<{ id: string }>;
  for (const { id } of ids) db.sql.prepare("UPDATE messages SET received_at = ? WHERE id = ?").run(when, id);
}

async function seed(count: number, retention?: { redactAfterDays?: number; purgeAfterDays?: number }): Promise<Engine> {
  const engine = new Engine({ dbPath: ":memory:", tickMs: 15, retention });
  engine.registerMapping(MAPPING);
  await engine.start();
  await engine.addChannel(CHANNEL);
  for (let i = 0; i < count; i++) engine.ingest("retain", ADT, "x-application/hl7-v2+er7", "test");
  await until(() => engine.db.listDeliveries({ channelId: "retain", state: "delivered" }).length === count);
  return engine;
}

test("the hash chain still verifies in full after payloads are redacted", async () => {
  const engine = await seed(5);
  try {
    const before = engine.db.verifyChain("retain");
    assert.equal(before.ok, true);
    assert.equal(before.checked, 5);
    assert.equal(before.payloadsChecked, 5, "every payload proves its own digest before redaction");
    assert.equal(before.redacted, 0);

    backdate(engine.db, "retain", 40, 3);
    const runner = new RetentionRunner(engine.db, { redactAfterDays: 30 });
    const result = runner.run();
    assert.equal(result.redactedMessages, 3);
    assert.ok(result.redactedDeliveries >= 3, "settled delivery payloads carry the same content and go too");

    // This is the property that makes redaction usable: lineage survives.
    const after = engine.db.verifyChain("retain");
    assert.equal(after.ok, true, "redaction must not break the chain");
    assert.equal(after.checked, 5, "every link still verifies");
    assert.equal(after.redacted, 3);
    assert.equal(after.payloadsChecked, 2, "only the surviving payloads can still prove themselves");

    // The patient data is genuinely gone from the redacted rows.
    const rows = engine.db.listMessages({ channelId: "retain" });
    const redacted = rows.filter((r) => r.raw === "[redacted]");
    assert.equal(redacted.length, 3);
    assert.ok(!redacted.some((r) => r.raw.includes("Beaulieu")));

    // ...but the record that they existed is not.
    assert.equal(rows.length, 5);
    assert.ok(engine.db.getSteps(redacted[0].id).length > 0, "lineage steps survive redaction");
  } finally {
    await engine.stop();
  }
});

test("a redacted payload cannot be silently swapped for a different one", async () => {
  const engine = await seed(3);
  try {
    backdate(engine.db, "retain", 40);
    new RetentionRunner(engine.db, { redactAfterDays: 30 }).run();
    assert.equal(engine.db.verifyChain("retain").ok, true);

    // Someone puts a forged payload back where a redacted one was. The digest
    // recorded at ingest no longer matches, so it is caught.
    const target = engine.db.listMessages({ channelId: "retain" })[0];
    engine.db.sql
      .prepare("UPDATE messages SET raw = ?, redacted_at = NULL WHERE id = ?")
      .run("MSH|^~\\&|FORGED", target.id);

    const check = engine.db.verifyChain("retain");
    assert.equal(check.ok, false, "a substituted payload must be detected");
    assert.equal(check.brokenAt, target.id);
  } finally {
    await engine.stop();
  }
});

test("purging keeps the surviving chain verifiable and says where it now starts", async () => {
  const engine = await seed(6);
  try {
    backdate(engine.db, "retain", 400, 4);

    const runner = new RetentionRunner(engine.db, { purgeAfterDays: 365 });
    const result = runner.run();
    assert.equal(result.purgedMessages, 4);
    assert.deepEqual(result.purgedChannels, ["retain"]);

    assert.equal(engine.db.listMessages({ channelId: "retain" }).length, 2, "old rows are gone");

    // Without the retained tip the survivors would look tampered with, since
    // the first one points at a hash that no longer exists.
    const check = engine.db.verifyChain("retain");
    assert.equal(check.ok, true, "the surviving chain must still verify");
    assert.equal(check.checked, 2);
    assert.ok(check.verifiedFrom, "verification reports where the chain now begins");

    // Steps and deliveries of purged messages go too, rather than dangling.
    const remaining = engine.db.listMessages({ channelId: "retain" }).map((r) => r.id);
    const orphanSteps = engine.db.sql
      .prepare(`SELECT COUNT(*) AS n FROM message_steps WHERE message_id NOT IN (${remaining.map(() => "?").join(",")})`)
      .get(...(remaining as never[])) as { n: number };
    assert.equal(orphanSteps.n, 0, "no orphaned lineage left behind");
  } finally {
    await engine.stop();
  }
});

test("a database written before retention existed keeps verifying", () => {
  // Rows chained over the payload itself, as the previous format did. An
  // upgrade must not make an existing operator's chain look broken.
  const db = new Db(":memory:");
  try {
    db.upsertChannel("legacy", "legacy", true, "{}");
    let prev: string | null = null;
    for (const raw of ["MSH|one", "MSH|two", "MSH|three"]) {
      const hash: string = createHash("sha256")
        .update(prev ?? "")
        .update("|")
        .update("legacy")
        .update("|")
        .update(raw)
        .digest("hex");
      db.sql
        .prepare(
          `INSERT INTO messages (id, channel_id, source_type, content_type, raw, hash, prev_hash)
           VALUES (?, 'legacy', 'test', 'text/plain', ?, ?, ?)`
        )
        .run(`legacy-${raw}`, raw, hash, prev);
      prev = hash;
    }

    const check = db.verifyChain("legacy");
    assert.equal(check.ok, true, "pre-retention rows must still verify");
    assert.equal(check.checked, 3);

    // And tampering with one is still caught under the old formula.
    db.sql.prepare("UPDATE messages SET raw = 'MSH|altered' WHERE id = 'legacy-MSH|two'").run();
    assert.equal(db.verifyChain("legacy").ok, false);
  } finally {
    db.close();
  }
});

test("retention leaves in-flight deliveries alone", async () => {
  // A queued delivery still needs its payload. Redacting it would destroy a
  // message that has not been delivered yet.
  const engine = new Engine({ dbPath: ":memory:", tickMs: 100_000 });
  engine.registerMapping(MAPPING);
  await engine.start();
  try {
    await engine.addChannel({
      ...CHANNEL,
      id: "inflight",
      source: { type: "http", path: "inflight" },
      destinations: [{ id: "remote", type: "http", url: "http://127.0.0.1:1/nowhere", ordered: true }],
    });
    engine.ingest("inflight", ADT, "x-application/hl7-v2+er7", "test");

    backdate(engine.db, "inflight", 40);
    new RetentionRunner(engine.db, { redactAfterDays: 30 }).run();

    const queued = engine.db.listDeliveries({ channelId: "inflight" });
    assert.equal(queued.length, 1);
    assert.notEqual(queued[0].payload, "[redacted]", "an undelivered payload must survive retention");
  } finally {
    await engine.stop();
  }
});

test("retention is off unless configured, and reports what it would touch", async () => {
  const engine = await seed(3);
  try {
    const off = new RetentionRunner(engine.db, {});
    assert.equal(off.enabled, false);
    const noop = off.run();
    assert.equal(noop.redactedMessages, 0);
    assert.equal(noop.purgedMessages, 0);
    assert.equal(engine.db.listMessages({ channelId: "retain" }).length, 3, "nothing is touched by default");

    backdate(engine.db, "retain", 100);
    const runner = new RetentionRunner(engine.db, { redactAfterDays: 30, purgeAfterDays: 365 });
    assert.equal(runner.enabled, true);
    const described = runner.describe();
    assert.equal(described.redactable, 3, "a dry description counts without changing anything");
    assert.equal(described.purgeable, 0, "not yet old enough to purge");
    assert.ok(described.oldest);
    assert.equal(engine.db.listMessages({ channelId: "retain" })[0].raw.startsWith("MSH"), true);
  } finally {
    await engine.stop();
  }
});

test("a retention sweep that destroys data records itself on the audit trail", async () => {
  const engine = await seed(4);
  try {
    backdate(engine.db, "retain", 40);
    const before = engine.audit.count();

    new RetentionRunner(engine.db, { redactAfterDays: 30 }, engine.audit).run();

    const rows = engine.audit.list({ resourceType: "Message" }).filter((r) => r.principal_kind === "system");
    assert.equal(engine.audit.count(), before + 1);
    assert.equal(rows[0].action, "D");
    assert.equal(rows[0].count, 4);
    assert.match(rows[0].detail ?? "", /redacted 4 message/);
    assert.equal(engine.audit.verifyChain().ok, true);

    // A sweep that changes nothing does not add noise.
    const after = engine.audit.count();
    new RetentionRunner(engine.db, { redactAfterDays: 30 }, engine.audit).run();
    assert.equal(engine.audit.count(), after);
  } finally {
    await engine.stop();
  }
});

test("the retention API describes and applies the policy", async () => {
  const engine = await seed(3, { redactAfterDays: 30 });
  const api = await startApi(engine, 0, "127.0.0.1");
  const base = `http://127.0.0.1:${api.port}`;
  try {
    backdate(engine.db, "retain", 40);

    const described = (await (await fetch(`${base}/api/retention`)).json()) as { redactable: number };
    assert.equal(described.redactable, 3);

    const run = (await (await fetch(`${base}/api/retention/run`, { method: "POST" })).json()) as {
      redactedMessages: number;
    };
    assert.equal(run.redactedMessages, 3);
    assert.equal(engine.db.verifyChain("retain").ok, true);
  } finally {
    await api.close();
    await engine.stop();
  }
});
