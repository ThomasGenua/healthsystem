/**
 * Faults injected where the engine meets something it does not control.
 *
 * The queue's failure modes are well covered: retries, dead letters, an
 * unclean shutdown, a crash mid-drain. The inbound half was not. Every poll
 * caught its own exception, printed it and returned — and the guard around
 * `readdirSync` did not even print. Nothing was written down, and
 * `/api/health` is assembled from the delivery queue and from cadences a
 * channel declared, so a drop directory that had been unmounted since
 * Tuesday produced `ok: true, degraded: false` and a channel that declared
 * no cadence reported healthy for as long as its source stayed away.
 *
 * That is worse than a crash. A crash is noticed. This is the shape of
 * failure the whole product is built to prevent at an unattended site: the
 * engine believes it is working, says so, and nothing is arriving.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../src/core/engine.ts";
import { startApi } from "../src/api/admin.ts";
import { AuthGate } from "../src/auth/gate.ts";
import { Db } from "../src/db.ts";
import type { ChannelConfig } from "../src/types.ts";
import { until } from "./helpers.ts";

function captureErr(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]): void => {
    lines.push(args.map((a) => String(a)).join(" "));
  };
  return { lines, restore: () => (console.error = original) };
}

/** Somewhere for messages to go. This is about the inbound half; the sink just has to work. */
function collector(): Promise<{ port: number; received: string[]; close: () => Promise<void> }> {
  const received: string[] = [];
  const server = createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      received.push("ok");
      res.writeHead(200);
      res.end("ok");
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({
        port: typeof addr === "object" && addr ? addr.port : 0,
        received,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

function dropChannel(id: string, dir: string, sinkPort: number, archiveDir?: string): ChannelConfig {
  return {
    id,
    name: `${id} drop`,
    source: { type: "filedrop", dir, pattern: "\\.txt$", pollMs: 20, ...(archiveDir ? { archiveDir } : {}) },
    destinations: [{ id: "sink", type: "http", url: `http://127.0.0.1:${sinkPort}/in` }],
  };
}

/** The channel row a unit test needs, without an engine to run it. */
function seedChannel(db: Db, id: string, enabled = true): void {
  db.upsertChannel(id, id, enabled, JSON.stringify({ id, name: id, source: { type: "filedrop", dir: "/nowhere" }, destinations: [] }));
}

test("a source that cannot be read becomes an outage, not silence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "northstar-fault-"));
  writeFileSync(join(dir, "001.txt"), "ADT one");
  const sink = await collector();
  const engine = new Engine({ dbPath: ":memory:", tickMs: 15 });
  const cap = captureErr();
  try {
    engine.worker.start();
    await engine.addChannel(dropChannel("t-drop", dir, sink.port));
    await until(() => engine.db.listMessages({ channelId: "t-drop" }).length === 1);
    assert.equal(engine.db.sourceFailure("t-drop"), undefined, "a working channel has nothing recorded");

    // The fault: the directory goes away under a running channel. An
    // unmounted volume, a renamed share, a permission change.
    rmSync(dir, { recursive: true, force: true });

    await until(() => (engine.db.sourceFailure("t-drop")?.consecutive ?? 0) >= 3);
    const failure = engine.db.sourceFailure("t-drop")!;
    assert.equal(failure.stage, "read");
    assert.match(failure.detail, /ENOENT|no such file/, "the record keeps what actually happened");

    const [reported] = engine.db.failingChannels();
    assert.equal(reported.channelId, "t-drop");
    assert.equal(reported.stage, "read");
    assert.ok(reported.consecutive >= 3);
    assert.equal(reported.degrading, true, "three consecutive failed reads is an outage");
    assert.equal(reported.kind, failure.kind);
    // What health publishes is deliberately not what the record holds.
    assert.equal((reported as { detail?: string }).detail, undefined);

    // And the log said where without saying what.
    const mine = cap.lines.filter((l) => l.includes("channel t-drop:"));
    assert.ok(mine.length >= 3, `expected a line per failure, got ${JSON.stringify(cap.lines)}`);
    assert.match(mine[0], /read failed \d+x/);
    assert.match(mine[0], /fault [0-9a-f-]{36}/, "carrying the id that reaches the record");
    assert.match(mine[0], /ENOENT/, "and the code, which is a vocabulary and not a sentence");
    assert.ok(!mine[0].includes(dir), `the log carried the path: ${mine[0]}`);
  } finally {
    cap.restore();
    await engine.stop();
    await sink.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the source coming back clears the outage without anyone saying so", async () => {
  const dir = mkdtempSync(join(tmpdir(), "northstar-fault-"));
  const sink = await collector();
  const engine = new Engine({ dbPath: ":memory:", tickMs: 15 });
  const cap = captureErr();
  try {
    engine.worker.start();
    rmSync(dir, { recursive: true, force: true });
    await engine.addChannel(dropChannel("t-back", dir, sink.port));
    await until(() => (engine.db.sourceFailure("t-back")?.consecutive ?? 0) >= 3);
    assert.equal(engine.db.failingChannels()[0].degrading, true);

    // The volume is remounted. Nothing is restarted and nobody acknowledges
    // anything: recovery is a poll that worked.
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "002.txt"), "ADT two");

    await until(() => engine.db.sourceFailure("t-back") === undefined);
    assert.deepEqual(engine.db.failingChannels(), [], "and health is clean again");
    assert.equal(engine.db.listMessages({ channelId: "t-back" }).length, 1, "and the file was collected");
  } finally {
    cap.restore();
    await engine.stop();
    await sink.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("one bad file is reported without declaring the link down", async () => {
  const dir = mkdtempSync(join(tmpdir(), "northstar-fault-"));
  // An archive directory that cannot exist: its parent is a regular file.
  // A real misconfiguration, and it fails *after* the message is stored.
  const blocker = join(dir, "blocker");
  writeFileSync(blocker, "not a directory");
  writeFileSync(join(dir, "003.txt"), "ADT three");

  const sink = await collector();
  const engine = new Engine({ dbPath: ":memory:", tickMs: 15 });
  const cap = captureErr();
  try {
    engine.worker.start();
    await engine.addChannel(dropChannel("t-item", dir, sink.port, join(blocker, "done")));
    await until(() => engine.db.sourceFailure("t-item") !== undefined);

    const failure = engine.db.sourceFailure("t-item")!;
    assert.equal(failure.stage, "item", "the directory was read; one thing on it is bad");
    assert.equal(failure.item, "003.txt", "and the record names it");

    const [reported] = engine.db.failingChannels();
    assert.equal(reported.stage, "item");
    assert.equal(reported.degrading, false, "a bad file is not an interface outage");
    assert.equal((reported as { item?: string }).item, undefined, "and health does not publish the name");

    // A drop file is routinely named by the sending system after an
    // accession or a chart number, so the name is recorded and not printed.
    const mine = cap.lines.filter((l) => l.includes("channel t-item:"));
    assert.ok(mine.length >= 1);
    assert.match(mine[0], /item failed \d+x/);
    assert.ok(!mine[0].includes("003.txt"), `the log carried the filename: ${mine[0]}`);

    // The message itself was stored before the archive step, which is why
    // this is an item failure and not lost data.
    assert.equal(engine.db.listMessages({ channelId: "t-item" }).length >= 1, true);
  } finally {
    cap.restore();
    await engine.stop();
    await sink.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a poll that throws synchronously does not take the engine with it", async () => {
  // `Promise.resolve(poll())` evaluates `poll()` before there is a promise
  // to attach `.catch` to, so a synchronous throw escapes the setInterval
  // callback and becomes an unhandled exception. Every poll in the engine
  // guards itself today; this is the net under all of them, and a net that
  // is only correct while nothing needs it is not a net.
  const engine = new Engine({ dbPath: ":memory:", tickMs: 15 });
  const cap = captureErr();
  const rc = { timers: [] as NodeJS.Timeout[] };
  try {
    const schedule = (engine as unknown as {
      schedule: (rc: unknown, id: string, src: unknown, poll: () => void) => void;
    }).schedule.bind(engine);
    schedule(rc, "t-sync", { pollMs: 20 }, () => {
      throw new Error("thrown before there is a promise");
    });
    await until(() => engine.db.sourceFailure("t-sync") !== undefined);
    assert.equal(engine.db.sourceFailure("t-sync")!.stage, "read");
  } finally {
    for (const t of rc.timers) clearInterval(t);
    cap.restore();
    await engine.stop();
  }
});

test("a channel somebody disabled is not an outage, and its history is kept", () => {
  const db = new Db(":memory:");
  try {
    seedChannel(db, "t-off");
    db.recordSourceFailure("t-off", "read", new Error("ECONNREFUSED"));
    assert.equal(db.failingChannels().length, 1);

    seedChannel(db, "t-off", false);
    assert.deepEqual(db.failingChannels(), [], "a channel nobody is running is not failing");
    assert.ok(db.sourceFailure("t-off"), "but turning it back on does not start from a clean slate");

    seedChannel(db, "t-off", true);
    assert.equal(db.failingChannels().length, 1);
  } finally {
    db.close();
  }
});

test("one custodian's outage is not another's", () => {
  const db = new Db(":memory:");
  try {
    const north = db.forTenant("north");
    const south = db.forTenant("south");
    for (const t of [north, south]) seedChannel(t, "lab");
    north.recordSourceFailure("lab", "read", new Error("ECONNREFUSED"));

    assert.equal(north.failingChannels().length, 1);
    assert.deepEqual(south.failingChannels(), [], "the southern site's lab feed is fine");
    assert.equal(south.sourceFailure("lab"), undefined);

    // And clearing one does not clear the other.
    south.recordSourceFailure("lab", "read", new Error("ETIMEDOUT"));
    south.clearSourceFailure("lab");
    assert.equal(north.failingChannels().length, 1);
  } finally {
    db.close();
  }
});

test("a run of failures counts the same failure, and a change of stage starts over", () => {
  const db = new Db(":memory:");
  try {
    seedChannel(db, "c");
    const first = db.recordSourceFailure("c", "read", new Error("ENOENT"));
    assert.equal(first.consecutive, 1);
    const second = db.recordSourceFailure("c", "read", new Error("ENOENT"));
    assert.equal(second.consecutive, 2);
    assert.equal(second.since, first.since, "the run began when it began");
    assert.equal(db.failingChannels()[0].degrading, false, "two is still a blip");

    assert.equal(db.recordSourceFailure("c", "read", new Error("ENOENT")).consecutive, 3);
    assert.equal(db.failingChannels()[0].degrading, true);

    // A directory that came back and then served one bad file is not four
    // failures of one thing.
    const item = db.recordSourceFailure("c", "item", new Error("ENOTDIR"), "004.txt");
    assert.equal(item.consecutive, 1);
    // Not `notEqual(item.since, first.since)`: these four calls can land in
    // one millisecond and ISO timestamps have no more resolution than that,
    // so that assertion passes or fails on how fast the machine is. A run
    // that has just started has its clock set at the failure that started
    // it, which is exact whatever the resolution.
    assert.equal(item.since, item.at, "a new run begins at the failure that began it");
    assert.equal(db.failingChannels()[0].degrading, false);

    // And a bad item never degrades however many times it repeats. The same
    // file failing on every poll is a stuck file; the link is up, the other
    // files on it are being collected, and paging somebody about the
    // interface would send them to the wrong end of it.
    db.recordSourceFailure("c", "item", new Error("ENOTDIR"), "004.txt");
    const stuck = db.recordSourceFailure("c", "item", new Error("ENOTDIR"), "004.txt");
    assert.equal(stuck.consecutive, 3);
    assert.equal(db.failingChannels()[0].degrading, false, "three bad passes at one file is still not an outage");
  } finally {
    db.close();
  }
});

test("a health check does not throw on a record it cannot read", () => {
  // The signal exists to be read during an incident, which is the worst
  // moment for it to be the thing that fails.
  const db = new Db(":memory:");
  try {
    seedChannel(db, "c");
    db.setChannelState("c", "source_failure", "{ this is not json");
    const [row] = db.failingChannels();
    assert.equal(row.channelId, "c");
    assert.equal(row.kind, "Unreadable");
    assert.doesNotThrow(() => db.healthSignals());
  } finally {
    db.close();
  }
});

test("an unreachable source reaches the operator's three surfaces, and the detail only reaches one", async () => {
  const dir = mkdtempSync(join(tmpdir(), "northstar-fault-"));
  rmSync(dir, { recursive: true, force: true });
  const sink = await collector();
  const engine = new Engine({ dbPath: ":memory:", tickMs: 15 });
  const cap = captureErr();
  let api: { port: number; close: () => Promise<void> } | undefined;
  try {
    engine.worker.start();
    await engine.addChannel(dropChannel("t-api", dir, sink.port));
    const key = engine.keys.issue("ops", ["admin"]).key;
    api = await startApi(engine, 0, "127.0.0.1", { auth: new AuthGate({ keys: engine.keys }) });
    const base = `http://127.0.0.1:${api.port}`;
    await until(() => (engine.db.sourceFailure("t-api")?.consecutive ?? 0) >= 3);

    // Open, so it says the class and the count and stops there.
    const health = (await (await fetch(`${base}/api/health`)).json()) as {
      degraded: boolean;
      signals: { failingChannels: Array<Record<string, unknown>> };
    };
    assert.equal(health.degraded, true, "a source nobody can read is not a healthy engine");
    const [failing] = health.signals.failingChannels;
    assert.equal(failing.channelId, "t-api");
    assert.equal(failing.stage, "read");
    assert.equal(failing.degrading, true);
    assert.equal(failing.detail, undefined, "an open endpoint does not carry the message");
    assert.ok(!JSON.stringify(health).includes(dir), "nor the path it came from");

    // Open, so labelled by channel and stage and nothing unbounded.
    const metrics = await (await fetch(`${base}/metrics`)).text();
    assert.match(metrics, /northstar_channel_source_failures\{channel="t-api",stage="read"\} [1-9]/);
    assert.ok(!metrics.includes(dir));

    // Authenticated, so this is where an operator reads what happened.
    const channels = (await (
      await fetch(`${base}/api/channels`, { headers: { authorization: `Bearer ${key}` } })
    ).json()) as Array<{ id: string; sourceFailure?: { detail: string; faultId: string; stage: string } }>;
    const row = channels.find((c) => c.id === "t-api")!;
    assert.ok(row.sourceFailure, "the channel listing carries the failure");
    assert.equal(row.sourceFailure!.stage, "read");
    assert.match(row.sourceFailure!.detail, /ENOENT|no such file/);
    // And the id in the log line is the way from one to the other.
    const logged = cap.lines.filter((l) => l.includes("channel t-api:"));
    assert.ok(logged.some((l) => l.includes(row.sourceFailure!.faultId)));
  } finally {
    cap.restore();
    await api?.close();
    await engine.stop();
    await sink.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
