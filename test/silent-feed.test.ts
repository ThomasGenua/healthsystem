/**
 * A feed that stops sending.
 *
 * Every other health signal reports on what is in the queue: depth, dead
 * letters, the age of the oldest undelivered message, which channels are
 * stalled. A feed that stops sending puts nothing in the queue, so all of
 * them read healthy — a dead ADT interface and a quiet night are
 * indistinguishable from the outside.
 *
 * That matters more here than the failures already covered. A backlog is
 * loud: it grows, it ages, it eventually dead-letters. Silence is not, and at
 * an unattended community site — where the whole premise is that nobody is
 * watching — it is the failure most likely to run for days before anyone
 * notices the records stopped arriving.
 *
 * The cadence is declared per channel rather than inferred, because no
 * threshold fits both a nursing station admitting four patients a day and a
 * regional lab pushing results every few minutes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../src/core/engine.ts";
import { startApi } from "../src/api/admin.ts";
import type { ChannelConfig } from "../src/types.ts";

const channel = (over: Partial<ChannelConfig> = {}): ChannelConfig => ({
  id: "adt",
  name: "admissions",
  source: { type: "http", path: "adt" },
  destinations: [{ id: "facade", type: "fhirstore", ordered: false }],
  ...over,
});

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), "northstar-silent-"));
  const engine = new Engine({ dbPath: join(dir, "northstar.db"), tickMs: 100_000 });
  await engine.start();
  return {
    engine,
    close: async () => {
      await engine.stop();
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}

test("a channel that has never received anything is reported, not skipped", async () => {
  // The case an operator hits on the day they stand a feed up. Never having
  // started is as much an outage as having stopped, and treating "no rows" as
  // "nothing to say" would hide exactly that.
  const { engine, close } = await boot();
  try {
    await engine.addChannel(channel({ expectMessageEverySec: 3600 }));
    const silent = engine.db.silentChannels();
    assert.equal(silent.length, 1);
    assert.equal(silent[0].channelId, "adt");
    assert.equal(silent[0].lastMessageAgeSec, null, "never is distinguishable from long ago");
    assert.equal(silent[0].expectEverySec, 3600);
  } finally {
    await close();
  }
});

test("a message inside the declared cadence clears it", async () => {
  const { engine, close } = await boot();
  try {
    await engine.addChannel(channel({ expectMessageEverySec: 3600 }));
    engine.ingest("adt", "hello", "text/plain", "test");
    assert.deepEqual(engine.db.silentChannels(), [], "a feed that just sent is not silent");
    assert.ok((engine.db.lastMessageAgeSec("adt") ?? 99) < 5);
  } finally {
    await close();
  }
});

test("a message older than the cadence is silence again", async () => {
  const { engine, close } = await boot();
  try {
    await engine.addChannel(channel({ expectMessageEverySec: 300 }));
    engine.ingest("adt", "hello", "text/plain", "test");
    assert.deepEqual(engine.db.silentChannels(), []);

    // Age the arrival past the threshold. Rewriting the row rather than
    // waiting is the only way to test a five-minute rule in a test suite.
    engine.db.sql.exec("UPDATE messages SET received_at = datetime('now', '-20 minutes')");

    const silent = engine.db.silentChannels();
    assert.equal(silent.length, 1);
    assert.ok(silent[0].lastMessageAgeSec! > 300, `age was ${silent[0].lastMessageAgeSec}`);
  } finally {
    await close();
  }
});

test("a channel that declares no cadence is never reported", async () => {
  // Silence has to be opt-in. Inventing a threshold would make every quiet
  // channel look broken, and an alert that fires constantly is one nobody
  // reads — which is worse than the gap it was meant to close.
  const { engine, close } = await boot();
  try {
    await engine.addChannel(channel());
    assert.deepEqual(engine.db.silentChannels(), [], "no cadence declared, nothing claimed");
    assert.equal(engine.db.healthSignals().silentChannels.length, 0);
  } finally {
    await close();
  }
});

test("a disabled channel is not silent, it is off", async () => {
  const { engine, close } = await boot();
  try {
    await engine.addChannel(channel({ expectMessageEverySec: 60, enabled: false }));
    assert.deepEqual(engine.db.silentChannels(), []);
  } finally {
    await close();
  }
});

test("health reports degraded, and says which feed", async () => {
  // The counters cannot answer "which one", and that is the first thing an
  // operator needs at 2am.
  const { engine, close } = await boot();
  const api = await startApi(engine, 0, "127.0.0.1");
  try {
    await engine.addChannel(channel({ expectMessageEverySec: 60 }));
    const body = (await (await fetch(`http://127.0.0.1:${api.port}/api/health`)).json()) as {
      degraded: boolean;
      signals: { silentChannels: Array<{ channelId: string }>; deadLetters: number };
    };
    assert.equal(body.degraded, true, "a silent feed is a degraded engine");
    assert.equal(body.signals.deadLetters, 0, "with nothing in the queue to explain it");
    assert.deepEqual(
      body.signals.silentChannels.map((c) => c.channelId),
      ["adt"]
    );
  } finally {
    await api.close();
    await close();
  }
});

test("metrics expose the age, so an alert is a threshold on a number", async () => {
  const { engine, close } = await boot();
  const api = await startApi(engine, 0, "127.0.0.1");
  try {
    await engine.addChannel(channel({ expectMessageEverySec: 60 }));
    engine.ingest("adt", "hello", "text/plain", "test");
    engine.db.sql.exec("UPDATE messages SET received_at = datetime('now', '-10 minutes')");

    const text = await (await fetch(`http://127.0.0.1:${api.port}/metrics`)).text();
    assert.match(text, /^# TYPE portage_channel_last_message_age_seconds gauge$/m);
    assert.match(text, /^portage_channel_silent\{channel="adt"\} 1$/m);

    const age = /^portage_channel_last_message_age_seconds\{channel="adt"\} (\d+)$/m.exec(text);
    assert.ok(age, "the age has to be a number a monitor can threshold on");
    assert.ok(Number(age![1]) >= 600, `expected at least 600s, got ${age![1]}`);

    // Still no patient data in something scraped openly.
    assert.ok(!text.includes("hello"));
  } finally {
    await api.close();
    await close();
  }
});

test("a channel whose stored config will not parse does not break the health check", async () => {
  // This runs on every scrape and every dashboard poll. It must not be the
  // thing that throws.
  const { engine, close } = await boot();
  try {
    await engine.addChannel(channel({ expectMessageEverySec: 60 }));
    engine.db.sql.exec("UPDATE channels SET config = 'not json' WHERE id = 'adt'");
    assert.doesNotThrow(() => engine.db.silentChannels());
    assert.doesNotThrow(() => engine.db.healthSignals());
  } finally {
    await close();
  }
});
