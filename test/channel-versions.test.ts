/**
 * Channel configuration as a ledger.
 *
 * The failure this closes: `upsertChannel` overwrote in place, so the
 * configuration deciding how every message is produced was the one thing in
 * the system with no history, no diff, and no way back. A mapping change that
 * starts dropping a segment at 14:00 left an operator an `updated_at`, the
 * current config, and their memory.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { Db } from "../src/db.ts";
import { Engine } from "../src/core/engine.ts";
import { ChannelVersions, type ChannelDocument } from "../src/core/channel-versions.ts";

const CFG = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    id: "adt",
    name: "Admissions",
    source: { type: "http", path: "adt" },
    destinations: [],
    ...over,
  });

test("every change is a version carrying who, when and why", () => {
  const db = new Db(":memory:");
  try {
    const versions = new ChannelVersions(db);
    const first = versions.commit({
      channelId: "adt",
      name: "Admissions",
      enabled: true,
      config: CFG(),
      by: "ops-key",
      note: "initial configuration",
    });
    assert.equal(first.version.version, 1);
    assert.equal(first.changed, true);

    const second = versions.commit({
      channelId: "adt",
      name: "Admissions",
      enabled: true,
      config: CFG({ destinations: [{ type: "http", url: "https://ehr.example/adt" }] }),
      by: "ops-key",
      note: "point at the new EHR endpoint",
    });
    assert.equal(second.version.version, 2);
    assert.equal(second.version.changed_by, "ops-key");
    assert.equal(second.version.note, "point at the new EHR endpoint");
    assert.equal(second.version.origin, "edit");

    // The live row follows the ledger, and knows which version it is.
    const live = db.getChannel("adt")!;
    assert.equal(live.config_version, 2);
    assert.match(live.config, /ehr\.example/);
  } finally {
    db.close();
  }
});

test("an identical shape writes nothing, even reserialised", () => {
  // The clinical record's position, applied to config: interfaces re-save, and
  // a history that grew a version per no-op save would bury the two changes
  // that mattered under four hundred that said nothing.
  const db = new Db(":memory:");
  try {
    const versions = new ChannelVersions(db);
    versions.commit({ channelId: "adt", name: "Admissions", enabled: true, config: CFG(), by: "ops", note: "init" });

    // Same meaning, different key order — written out by hand, because
    // JSON.stringify's array replacer is a key whitelist at every depth and
    // quietly empties nested objects, which is a different config, not a
    // reordered one.
    const c = JSON.parse(CFG()) as Record<string, unknown>;
    const reordered = JSON.stringify({
      source: c.source,
      name: c.name,
      id: c.id,
      destinations: c.destinations,
    });
    const again = versions.commit({
      channelId: "adt",
      name: "Admissions",
      enabled: true,
      config: reordered,
      by: "ops",
      note: "resave",
    });
    assert.equal(again.changed, false);
    assert.equal(versions.history("adt").length, 1);
  } finally {
    db.close();
  }
});

test("the first versioned change captures what was there before it", () => {
  // The upgrade case: a channel written before versioning existed. If the
  // first versioned edit did not capture the prior state, it would destroy
  // the last unversioned config — the exact loss this table exists to end.
  const db = new Db(":memory:");
  try {
    db.upsertChannel("adt", "Admissions", true, CFG());
    const versions = new ChannelVersions(db);
    const r = versions.commit({
      channelId: "adt",
      name: "Admissions",
      enabled: true,
      config: CFG({ source: { type: "http", path: "admissions" } }),
      by: "ops",
      note: "rename the ingest path",
    });
    assert.equal(r.version.version, 2, "the change is version 2");

    const baseline = versions.get("adt", 1)!;
    assert.equal(baseline.origin, "baseline");
    assert.match(baseline.config, /"path":"adt"/, "version 1 is the state versioning found");
    assert.equal(baseline.changed_by, "(pre-versioning)");
  } finally {
    db.close();
  }
});

test("a diff names what changed, at the field", () => {
  const db = new Db(":memory:");
  try {
    const versions = new ChannelVersions(db);
    versions.commit({ channelId: "adt", name: "Admissions", enabled: true, config: CFG(), by: "ops", note: "init" });
    versions.commit({
      channelId: "adt",
      name: "Admissions (deprecated)",
      enabled: false,
      config: CFG({ source: { type: "http", path: "admissions" } }),
      by: "ops",
      note: "wind down",
    });

    const diff = versions.diff("adt", 1, 2);
    const paths = diff.map((d) => d.path).sort();
    assert.deepEqual(paths, ["config.source.path", "enabled", "name"]);
    const path = diff.find((d) => d.path === "config.source.path")!;
    assert.equal(path.from, "adt");
    assert.equal(path.to, "admissions");
  } finally {
    db.close();
  }
});

test("rollback restores old content as a new version, and the history never lies", () => {
  const db = new Db(":memory:");
  try {
    const versions = new ChannelVersions(db);
    versions.commit({ channelId: "adt", name: "Admissions", enabled: true, config: CFG(), by: "ops", note: "v1" });
    versions.commit({
      channelId: "adt",
      name: "Admissions",
      enabled: true,
      config: CFG({ destinations: [{ type: "http", url: "https://wrong.example" }] }),
      by: "ops",
      note: "the bad change",
    });

    const restored = versions.rollback("adt", 1, { actorId: "ops", note: "wrong endpoint, reverting" });
    assert.equal(restored.version, 3, "a new version, not a mutation");
    assert.equal(restored.origin, "rollback");
    assert.equal(restored.rollback_of, 1);

    // The live row is back to v1's content and knows it is version 3.
    const live = db.getChannel("adt")!;
    assert.ok(!live.config.includes("wrong.example"));
    assert.equal(live.config_version, 3);

    // Rolling back to the shape already live is refused, not recorded.
    assert.throws(() => versions.rollback("adt", 1, { actorId: "ops", note: "again" }), /already at the shape/);
  } finally {
    db.close();
  }
});

test("deletion is a marker in the history, and a rollback brings the channel back", () => {
  const db = new Db(":memory:");
  try {
    const versions = new ChannelVersions(db);
    versions.commit({ channelId: "adt", name: "Admissions", enabled: true, config: CFG(), by: "ops", note: "v1" });
    versions.markDeleted("adt", { actorId: "ops", note: "decommissioned with the old EHR" });
    db.deleteChannel("adt");
    assert.equal(db.getChannel("adt"), undefined);

    const history = versions.history("adt");
    assert.equal(history[0].origin, "delete");
    assert.equal(history[0].note, "decommissioned with the old EHR");

    // The marker itself is not restorable — the version before it is.
    assert.throws(() => versions.rollback("adt", 2, { actorId: "ops", note: "oops" }), /deletion marker/);
    const back = versions.rollback("adt", 1, { actorId: "ops", note: "the old EHR came back" });
    assert.equal(back.version, 3);
    assert.ok(db.getChannel("adt"), "the channel exists again");
  } finally {
    db.close();
  }
});

test("a message records which configuration processed it", () => {
  // The lineage claim the rest of the system makes, extended to the config
  // boundary: "which rules were live when this went wrong" becomes a lookup.
  const db = new Db(":memory:");
  try {
    const versions = new ChannelVersions(db);
    versions.commit({ channelId: "adt", name: "Admissions", enabled: true, config: CFG(), by: "ops", note: "v1" });
    const early = db.insertMessage("adt", "http", "text/plain", "MSH|first");

    versions.commit({
      channelId: "adt",
      name: "Admissions",
      enabled: true,
      config: CFG({ source: { type: "http", path: "admissions" } }),
      by: "ops",
      note: "v2",
    });
    const late = db.insertMessage("adt", "http", "text/plain", "MSH|second");

    assert.equal(early.config_version, 1);
    assert.equal(late.config_version, 2);
    assert.equal(db.verifyChain("adt").ok, true, "and the message chain is untouched by the stamp");
  } finally {
    db.close();
  }
});

test("an import is a plan before it is an action, and the dry run writes nothing", () => {
  const db = new Db(":memory:");
  try {
    const versions = new ChannelVersions(db);
    versions.commit({ channelId: "adt", name: "Admissions", enabled: true, config: CFG(), by: "ops", note: "v1" });
    versions.commit({
      channelId: "labs",
      name: "Laboratory",
      enabled: true,
      config: JSON.stringify({ id: "labs", name: "Laboratory", source: { type: "http", path: "labs" }, destinations: [] }),
      by: "ops",
      note: "v1",
    });

    const docs: ChannelDocument[] = [
      // adt changed, oru new; labs deliberately not mentioned.
      { id: "adt", name: "Admissions", enabled: true, config: JSON.parse(CFG({ source: { type: "http", path: "admissions" } })) as Record<string, unknown> },
      { id: "oru", name: "Results", enabled: true, config: { id: "oru", name: "Results", source: { type: "http", path: "oru" }, destinations: [] } },
    ];

    const plan = versions.plan(docs);
    assert.deepEqual(
      plan.entries.map((e) => `${e.channelId}:${e.action}`),
      ["adt:change", "oru:create"]
    );
    assert.deepEqual(plan.absent, ["labs"], "what the document does not mention is reported, never deleted");
    assert.equal(versions.history("adt").length, 1, "the dry run wrote nothing");
    assert.equal(db.getChannel("oru"), undefined);

    const applied = versions.apply(docs, { actorId: "ops", note: "sync from repo" });
    assert.equal(applied.entries.filter((e) => e.action !== "unchanged").length, 2);
    assert.equal(versions.history("adt")[0].origin, "import");
    assert.equal(versions.history("oru")[0].version, 1);
    assert.ok(db.getChannel("oru"));

    // Applying the same document again is a no-op all the way down.
    const again = versions.apply(docs, { actorId: "ops", note: "sync again" });
    assert.ok(again.entries.every((e) => e.action === "unchanged"));
    assert.equal(versions.history("adt").length, 2);
  } finally {
    db.close();
  }
});

test("export round-trips through import as unchanged", () => {
  const db = new Db(":memory:");
  try {
    const versions = new ChannelVersions(db);
    versions.commit({ channelId: "adt", name: "Admissions", enabled: false, config: CFG(), by: "ops", note: "v1" });
    const exported = versions.exportAll();
    const plan = versions.plan(exported);
    assert.ok(plan.entries.every((e) => e.action === "unchanged"), "what you export is what is live");
    assert.equal(exported[0].enabled, false, "enabled state travels with the document");
  } finally {
    db.close();
  }
});

test("versions are confined to their custodian", () => {
  const db = new Db(":memory:");
  try {
    db.createTenant("north", "Northern Health", "Northern Regional Custodian");
    const mine = new ChannelVersions(db);
    const theirs = new ChannelVersions(db.forTenant("north"));
    mine.commit({ channelId: "adt", name: "Admissions", enabled: true, config: CFG(), by: "ops", note: "v1" });

    assert.equal(theirs.history("adt").length, 0);
    theirs.commit({ channelId: "adt", name: "Their admissions", enabled: true, config: CFG(), by: "them", note: "v1" });
    assert.equal(mine.history("adt").length, 1, "same channel id, separate histories");
    assert.equal(mine.history("adt")[0].name, "Admissions");
  } finally {
    db.close();
  }
});

test("the engine records a version on every change, and rollback restarts the channel", async () => {
  // Through the real write path, because a ledger the engine bypasses is a
  // ledger — the organization-identity fix taught this session what a
  // unit-tested collaborator nobody wires is worth.
  const engine = new Engine({ dbPath: ":memory:", tickMs: 15 });
  await engine.start();
  try {
    const DEST = [{ type: "http" as const, url: "http://127.0.0.1:1/sink" }];
    await engine.addChannel(
      { id: "adt", name: "Admissions", source: { type: "http", path: "adt" }, destinations: DEST },
      { by: "ops-key", note: "initial" }
    );
    await engine.addChannel(
      { id: "adt", name: "Admissions", source: { type: "http", path: "admissions" }, destinations: DEST },
      { by: "ops-key", note: "rename the path" }
    );
    assert.equal(engine.channelVersions.history("adt").length, 2);

    const cfg = await engine.rollbackChannel("adt", 1, { by: "ops-key", note: "revert the rename" });
    assert.equal((cfg.source as { path?: string }).path, "adt");
    assert.equal(engine.getChannelConfig("adt")!.source.type, "http");
    assert.equal(engine.channelVersions.history("adt")[0].origin, "rollback");

    await engine.removeChannel("adt", { by: "ops-key", note: "done with it" });
    assert.equal(engine.channelVersions.history("adt")[0].origin, "delete");
  } finally {
    await engine.stop();
  }
});

// ---- regressions from review: the four Bugbot findings on this PR ----------

import { startApi } from "../src/api/admin.ts";

const DOC = (over: Partial<ChannelDocument> = {}): ChannelDocument => ({
  id: "adt",
  name: "Admissions",
  enabled: true,
  config: {
    id: "adt",
    name: "Admissions",
    source: { type: "http", path: "adt" },
    destinations: [{ type: "http", url: "http://127.0.0.1:1/sink" }],
  },
  ...over,
});

async function bootApi() {
  const engine = new Engine({ dbPath: ":memory:", tickMs: 15 });
  await engine.start();
  const api = await startApi(engine, 0, "127.0.0.1");
  const base = `http://127.0.0.1:${api.port}`;
  return {
    engine,
    base,
    post: (p: string, body: unknown) =>
      fetch(`${base}${p}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    close: async () => {
      await api.close();
      await engine.stop();
    },
  };
}

test("an import that disables a channel is not switched back on by its own restart", async () => {
  // Bugbot's High finding, confirmed: the restart loop went through
  // addChannel, which re-derives enabled from the config blob — so applying a
  // document with enabled:false wrote the ledger correctly and then recorded
  // a second version turning the channel back on.
  const s = await bootApi();
  try {
    await s.post("/api/channels/import", { channels: [DOC()], apply: true, note: "bring it up" });
    const res = await s.post("/api/channels/import", {
      channels: [DOC({ enabled: false })],
      apply: true,
      note: "wind it down",
    });
    assert.equal(res.status, 200);

    const live = s.engine.db.getChannel("adt")!;
    assert.equal(live.enabled, 0, "disabled means disabled");
    const history = s.engine.channelVersions.history("adt");
    assert.equal(history[0].enabled, 0);
    assert.equal(history[0].origin, "import", "and no phantom edit version was recorded by the restart");
    assert.equal(history.length, 2);
    assert.ok(!s.engine.listChannels().find((c) => c.id === "adt")!.running, "the runtime followed the row");
  } finally {
    await s.close();
  }
});

test("re-importing a deleted channel's last shape recreates it", async () => {
  // Bugbot's finding, confirmed: the delete marker stores the final shape
  // with enabled off, so re-importing that same disabled shape matched the
  // head, wrote nothing, and left the channel absent while the plan said
  // create.
  const db = new Db(":memory:");
  try {
    const versions = new ChannelVersions(db);
    versions.commit({ channelId: "adt", name: "Admissions", enabled: false, config: CFG(), by: "ops", note: "v1" });
    versions.markDeleted("adt", { actorId: "ops", note: "gone" });
    db.deleteChannel("adt");

    const doc: ChannelDocument = {
      id: "adt",
      name: "Admissions",
      enabled: false,
      config: JSON.parse(CFG()) as Record<string, unknown>,
    };
    const plan = versions.apply([doc], { actorId: "ops", note: "bring it back" });
    assert.equal(plan.entries[0].action, "create");
    assert.ok(db.getChannel("adt"), "the channel exists again — apply did what the plan said");
    assert.equal(versions.history("adt")[0].origin, "import");
  } finally {
    db.close();
  }
});

test("a rollback refusal keeps its status instead of arriving as a 500", async () => {
  const s = await bootApi();
  try {
    await s.post("/api/channels/import", { channels: [DOC()], apply: true });

    const missing = await s.post("/api/channels/adt/rollback", { to: 99 });
    assert.equal(missing.status, 404);
    assert.match(((await missing.json()) as { error: string }).error, /no version 99/);

    const noop = await s.post("/api/channels/adt/rollback", { to: 1 });
    assert.equal(noop.status, 409);
    assert.match(((await noop.json()) as { error: string }).error, /already at the shape/);

    const badDiff = await fetch(`${s.base}/api/channels/adt/diff?from=1&to=99`);
    assert.equal(badDiff.status, 404);
  } finally {
    await s.close();
  }
});

test("an invalid document is refused whole, before anything is planned or written", async () => {
  // Validation used to run inside the restart, after the ledger and live rows
  // were already updated — the worst moment to learn the document is bad.
  const s = await bootApi();
  try {
    await s.post("/api/channels/import", { channels: [DOC()], apply: true, note: "good" });

    const bad = DOC();
    (bad.config as { destinations?: unknown }).destinations = [];
    const res = await s.post("/api/channels/import", { channels: [bad], apply: true, note: "bad" });
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: string }).error, /channel adt: .*destination/i);

    assert.equal(s.engine.channelVersions.history("adt").length, 1, "nothing was written");

    // The dry run refuses the same way: a plan for an unloadable document is
    // not a plan.
    const dry = await s.post("/api/channels/import", { channels: [bad] });
    assert.equal(dry.status, 400);
  } finally {
    await s.close();
  }
});
