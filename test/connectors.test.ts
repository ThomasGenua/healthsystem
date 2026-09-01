import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Engine } from "../src/core/engine.ts";
import type { ChannelConfig } from "../src/types.ts";
import { until } from "./helpers.ts";

function collector() {
  const received: string[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      received.push(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(200);
      res.end("ok");
    });
  });
  return new Promise<{ port: number; received: string[]; close: () => Promise<void> }>((resolve) => {
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


test("filedrop source ingests files in name order and archives them", async () => {
  const dir = mkdtempSync(join(tmpdir(), "northstar-drop-"));
  const archive = join(dir, "done");
  writeFileSync(join(dir, "002.txt"), "second");
  writeFileSync(join(dir, "001.txt"), "first");

  const sink = await collector();
  const engine = new Engine({ dbPath: ":memory:", tickMs: 15 });
  const channel: ChannelConfig = {
    id: "t-drop",
    name: "filedrop test",
    source: { type: "filedrop", dir, pattern: "\\.txt$", pollMs: 50, archiveDir: archive },
    destinations: [{ id: "sink", type: "http", url: `http://127.0.0.1:${sink.port}/in`, ordered: true }],
  };
  engine.worker.start();
  await engine.addChannel(channel);

  await until(() => sink.received.length === 2);
  assert.deepEqual(sink.received, ["first", "second"]);

  writeFileSync(join(dir, "003.txt"), "third");
  await until(() => sink.received.length === 3);
  assert.equal(sink.received[2], "third");

  await until(() => readdirSync(archive).length === 3);
  const messages = engine.db.listMessages({ channelId: "t-drop" });
  assert.equal(messages.length, 3);
  assert.match(messages[0].meta ?? "", /003\.txt/);

  await engine.stop();
  await sink.close();
  rmSync(dir, { recursive: true, force: true });
});

test("dbpoll source follows a cursor, persists it, and picks up new rows", async () => {
  const dir = mkdtempSync(join(tmpdir(), "northstar-poll-"));
  const scratchPath = join(dir, "lab.db");
  const scratch = new DatabaseSync(scratchPath);
  scratch.exec("CREATE TABLE results (id INTEGER PRIMARY KEY, test TEXT, value REAL)");
  scratch.prepare("INSERT INTO results (test, value) VALUES (?, ?)").run("HGB", 142);
  scratch.prepare("INSERT INTO results (test, value) VALUES (?, ?)").run("WBC", 7.2);

  const sink = await collector();
  const engine = new Engine({ dbPath: ":memory:", tickMs: 15 });
  const channel: ChannelConfig = {
    id: "t-poll",
    name: "dbpoll test",
    source: {
      type: "dbpoll",
      dbPath: scratchPath,
      query: "SELECT id, test, value FROM results WHERE id > ? ORDER BY id",
      cursorColumn: "id",
      pollMs: 50,
    },
    destinations: [{ id: "sink", type: "http", url: `http://127.0.0.1:${sink.port}/in`, ordered: true }],
  };
  engine.worker.start();
  await engine.addChannel(channel);

  await until(() => sink.received.length === 2);
  const first = JSON.parse(sink.received[0]) as { id: number; test: string };
  assert.equal(first.id, 1);
  assert.equal(first.test, "HGB");
  assert.equal(engine.db.getChannelState("t-poll", "cursor"), "2");

  scratch.prepare("INSERT INTO results (test, value) VALUES (?, ?)").run("GLU", 5.4);
  await until(() => sink.received.length === 3);
  assert.equal((JSON.parse(sink.received[2]) as { test: string }).test, "GLU");
  assert.equal(engine.db.getChannelState("t-poll", "cursor"), "3");
  assert.equal(engine.db.listMessages({ channelId: "t-poll" }).length, 3);

  await engine.stop();
  scratch.close();
  await sink.close();
  rmSync(dir, { recursive: true, force: true });
});
