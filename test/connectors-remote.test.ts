import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine } from "../src/core/engine.ts";
import { CronSchedule, minuteKey } from "../src/connectors/cron.ts";
import { toPositional, type SqlClient } from "../src/connectors/sql.ts";
import type { SftpClient, SftpFile } from "../src/connectors/sftp.ts";
import { until } from "./helpers.ts";
import type { ChannelConfig } from "../src/types.ts";

/* --------------------------------- cron --------------------------------- */

const at = (s: string) => new Date(s);

test("cron: fields, steps, ranges and lists", () => {
  const everyMinute = new CronSchedule("* * * * *");
  assert.ok(everyMinute.matches(at("2026-08-05T13:37:00")));

  const topOfHour = new CronSchedule("0 * * * *");
  assert.ok(topOfHour.matches(at("2026-08-05T13:00:00")));
  assert.ok(!topOfHour.matches(at("2026-08-05T13:01:00")));

  const everyQuarter = new CronSchedule("*/15 * * * *");
  for (const m of [0, 15, 30, 45]) assert.ok(everyQuarter.matches(at(`2026-08-05T09:${String(m).padStart(2, "0")}:00`)));
  assert.ok(!everyQuarter.matches(at("2026-08-05T09:16:00")));

  // Nightly at 02:30.
  const nightly = new CronSchedule("30 2 * * *");
  assert.ok(nightly.matches(at("2026-08-05T02:30:00")));
  assert.ok(!nightly.matches(at("2026-08-05T03:30:00")));

  // Weekdays only, business hours. 2026-08-05 is a Wednesday, 08-08 a Saturday.
  const business = new CronSchedule("0 9-17 * * 1-5");
  assert.ok(business.matches(at("2026-08-05T09:00:00")));
  assert.ok(business.matches(at("2026-08-05T17:00:00")));
  assert.ok(!business.matches(at("2026-08-05T18:00:00")));
  assert.ok(!business.matches(at("2026-08-08T09:00:00")));

  const list = new CronSchedule("0,30 * * * *");
  assert.ok(list.matches(at("2026-08-05T11:30:00")));
  assert.ok(!list.matches(at("2026-08-05T11:29:00")));

  // Sunday is both 0 and 7. 2026-08-09 is a Sunday.
  assert.ok(new CronSchedule("0 0 * * 7").matches(at("2026-08-09T00:00:00")));
  assert.ok(new CronSchedule("0 0 * * 0").matches(at("2026-08-09T00:00:00")));
});

test("cron: day-of-month and day-of-week are OR'd when both are restricted", () => {
  // Standard cron behaviour, and the part people get wrong: this fires on the
  // 1st of the month AND on every Monday, not on Mondays that fall on the 1st.
  const s = new CronSchedule("0 0 1 * 1");
  assert.ok(s.matches(at("2026-08-01T00:00:00")), "the 1st, a Saturday");
  assert.ok(s.matches(at("2026-08-03T00:00:00")), "a Monday that is not the 1st");
  assert.ok(!s.matches(at("2026-08-04T00:00:00")), "a Tuesday that is not the 1st");

  // With only one restricted, that one decides.
  const domOnly = new CronSchedule("0 0 1 * *");
  assert.ok(domOnly.matches(at("2026-08-01T00:00:00")));
  assert.ok(!domOnly.matches(at("2026-08-03T00:00:00")));
});

test("cron: malformed expressions are rejected, not silently ignored", () => {
  assert.throws(() => new CronSchedule("* * * *"), /needs 5 fields/);
  assert.throws(() => new CronSchedule("* * * * * *"), /needs 5 fields/);
  assert.throws(() => new CronSchedule("60 * * * *"), /out of range/);
  assert.throws(() => new CronSchedule("* 24 * * *"), /out of range/);
  assert.throws(() => new CronSchedule("* * 0 * *"), /out of range/);
  assert.throws(() => new CronSchedule("abc * * * *"), /bad value/);
  assert.throws(() => new CronSchedule("*/0 * * * *"), /bad step/);
  assert.throws(() => new CronSchedule("5-1 * * * *"), /out of range/);
});

test("cron: minute key is stable within a minute and changes across one", () => {
  assert.equal(minuteKey(at("2026-08-05T13:37:00")), minuteKey(at("2026-08-05T13:37:59")));
  assert.notEqual(minuteKey(at("2026-08-05T13:37:00")), minuteKey(at("2026-08-05T13:38:00")));
});

test("a channel with an invalid cron expression is refused at configuration time", async () => {
  const engine = new Engine({ dbPath: ":memory:", tickMs: 15 });
  await engine.start();
  try {
    await assert.rejects(
      () =>
        engine.addChannel({
          id: "bad-cron",
          name: "bad cron",
          source: { type: "filedrop", dir: "/tmp", cron: "not a cron" },
          destinations: [{ id: "d", type: "fhirstore" }],
        }),
      /cron/
    );
  } finally {
    await engine.stop();
  }
});

/* ------------------------------ sql polling ------------------------------ */

test("postgres placeholder rewriting leaves quoted text alone", () => {
  assert.equal(toPositional("SELECT * FROM r WHERE id > ? ORDER BY id"), "SELECT * FROM r WHERE id > $1 ORDER BY id");
  assert.equal(toPositional("SELECT ? , ?"), "SELECT $1 , $2");
  assert.equal(toPositional("SELECT * FROM r WHERE note = 'why? really' AND id > ?"), "SELECT * FROM r WHERE note = 'why? really' AND id > $1");
  assert.equal(toPositional('SELECT "a?b" FROM r WHERE id > ?'), 'SELECT "a?b" FROM r WHERE id > $1');
  assert.equal(toPositional("SELECT 1"), "SELECT 1");
});

/** In-memory stand-in for a Postgres/MySQL connection. */
function fakeSql(rowsByCursor: (cursor: unknown) => Array<Record<string, unknown>>) {
  const calls: unknown[][] = [];
  let closed = 0;
  const client: SqlClient = {
    async query(_sql, params) {
      calls.push(params);
      return rowsByCursor(params[0]);
    },
    async close() {
      closed++;
    },
  };
  return { client, calls, closed: () => closed };
}

const sqlChannel = (id: string, extra: Record<string, unknown> = {}): ChannelConfig => ({
  id,
  name: id,
  source: {
    type: "sqlpoll",
    driver: "postgres",
    dsn: "postgres://user:pw@localhost:5432/lab",
    query: "SELECT * FROM results WHERE id > ? ORDER BY id",
    cursorColumn: "id",
    pollMs: 20,
    ...extra,
  },
  destinations: [{ id: "facade", type: "fhirstore", ordered: true }],
});

test("sqlpoll follows its cursor and persists it across a restart", async () => {
  const all = [
    { id: 1, resourceType: "Patient", identifier: [{ system: "s", value: "a" }] },
    { id: 2, resourceType: "Patient", identifier: [{ system: "s", value: "b" }] },
    { id: 3, resourceType: "Patient", identifier: [{ system: "s", value: "c" }] },
  ];
  const fake = fakeSql((cursor) => all.filter((r) => r.id > Number(cursor)));

  const engine = new Engine({
    dbPath: ":memory:",
    tickMs: 15,
    connectors: { sql: async () => fake.client },
  });
  await engine.start();
  try {
    await engine.addChannel(sqlChannel("sql-1"));

    await until(() => engine.db.listMessages({ channelId: "sql-1" }).length === 3);
    assert.equal(engine.db.getChannelState("sql-1", "cursor"), "3");

    // The first poll binds the initial cursor; later polls bind what was
    // persisted, so rows are never re-read.
    assert.deepEqual(fake.calls[0], [0]);
    await until(() => fake.calls.length >= 2);
    assert.equal(fake.calls[fake.calls.length - 1][0], 3);

    // Nothing new arrives, so the message count stays put.
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(engine.db.listMessages({ channelId: "sql-1" }).length, 3);
  } finally {
    await engine.stop();
  }
});

test("sqlpoll starts from initialCursor and reconnects after a failure", async () => {
  let attempts = 0;
  const engine = new Engine({
    dbPath: ":memory:",
    tickMs: 15,
    connectors: {
      sql: async () => {
        attempts++;
        // The first connection fails on query, forcing the client to be
        // dropped and rebuilt — the behaviour a flaky link depends on.
        if (attempts === 1) {
          return {
            async query() {
              throw new Error("connection reset");
            },
            async close() {},
          };
        }
        return fakeSql(() => [{ id: 99, resourceType: "Patient", identifier: [{ system: "s", value: "z" }] }]).client;
      },
    },
  });
  await engine.start();
  try {
    await engine.addChannel(sqlChannel("sql-2", { initialCursor: "50" }));
    await until(() => engine.db.listMessages({ channelId: "sql-2" }).length >= 1, 8000);
    assert.ok(attempts >= 2, "a failed poll must drop the client so the next one reconnects");
    assert.equal(engine.db.getChannelState("sql-2", "cursor"), "99");
  } finally {
    await engine.stop();
  }
});

test("sqlpoll configuration is validated", async () => {
  const engine = new Engine({ dbPath: ":memory:", tickMs: 15 });
  await engine.start();
  try {
    const bad = async (source: Record<string, unknown>, re: RegExp) =>
      assert.rejects(
        () =>
          engine.addChannel({
            id: "sql-bad",
            name: "bad",
            source: source as never,
            destinations: [{ id: "d", type: "fhirstore" }],
          }),
        re
      );

    await bad({ type: "sqlpoll", driver: "oracle", dsn: "x", query: "SELECT ?", cursorColumn: "id" }, /postgres or mysql/);
    await bad({ type: "sqlpoll", driver: "postgres", query: "SELECT ?", cursorColumn: "id" }, /requires dsn/);
    await bad(
      { type: "sqlpoll", driver: "postgres", dsn: "x", query: "SELECT 1", cursorColumn: "id" },
      /bind the cursor/
    );
  } finally {
    await engine.stop();
  }
});

/* -------------------------------- sftp ---------------------------------- */

/** In-memory SFTP server: a flat map of path to contents. */
function fakeSftp(initial: Record<string, string>) {
  const files = new Map(Object.entries(initial));
  const client: SftpClient = {
    async list(dir) {
      const out: SftpFile[] = [];
      for (const [path, body] of files) {
        const prefix = `${dir.replace(/\/+$/, "")}/`;
        if (path.startsWith(prefix) && !path.slice(prefix.length).includes("/")) {
          out.push({ name: path.slice(prefix.length), size: body.length });
        }
      }
      return out;
    },
    async get(path) {
      const body = files.get(path);
      if (body === undefined) throw new Error(`no such file: ${path}`);
      return body;
    },
    async rename(from, to) {
      const body = files.get(from);
      if (body === undefined) throw new Error(`no such file: ${from}`);
      files.delete(from);
      files.set(to, body);
    },
    async delete(path) {
      files.delete(path);
    },
    async mkdir() {},
    async close() {},
  };
  return { client, files };
}

test("sftp ingests in filename order, archives, and never re-reads", async () => {
  const remote = fakeSftp({
    "/outbound/b.hl7": "MSH|^~\\&|B",
    "/outbound/a.hl7": "MSH|^~\\&|A",
    "/outbound/c.txt": "not matched",
  });

  const engine = new Engine({
    dbPath: ":memory:",
    tickMs: 15,
    connectors: { sftp: async () => remote.client },
  });
  await engine.start();
  try {
    await engine.addChannel({
      id: "sftp-1",
      name: "sftp",
      source: {
        type: "sftp",
        host: "sftp.example.invalid",
        username: "portage",
        password: "x",
        dir: "/outbound",
        pattern: "\\.hl7$",
        archiveDir: "/archive",
        pollMs: 20,
      },
      destinations: [{ id: "facade", type: "fhirstore", ordered: true }],
    });

    await until(() => engine.db.listMessages({ channelId: "sftp-1" }).length === 2);
    const msgs = engine.db.listMessages({ channelId: "sftp-1" });

    // listMessages returns newest first, so reverse for arrival order: a.hl7
    // must be ingested before b.hl7 despite b being listed first.
    const arrival = [...msgs].reverse();
    assert.match(arrival[0].raw, /\|A$/);
    assert.match(arrival[1].raw, /\|B$/);
    assert.equal(JSON.parse(arrival[0].meta ?? "{}").file, "a.hl7");

    // Matched files moved to the archive; the unmatched one stayed put.
    assert.ok(remote.files.has("/archive/a.hl7"));
    assert.ok(remote.files.has("/archive/b.hl7"));
    assert.ok(!remote.files.has("/outbound/a.hl7"));
    assert.ok(remote.files.has("/outbound/c.txt"), "a file outside the pattern must be left alone");

    // Several more polls run; the archived files must not come back.
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(engine.db.listMessages({ channelId: "sftp-1" }).length, 2);
  } finally {
    await engine.stop();
  }
});

test("sftp deletes after ingest when no archive directory is configured", async () => {
  const remote = fakeSftp({ "/drop/one.hl7": "MSH|^~\\&|ONE" });
  const engine = new Engine({
    dbPath: ":memory:",
    tickMs: 15,
    connectors: { sftp: async () => remote.client },
  });
  await engine.start();
  try {
    await engine.addChannel({
      id: "sftp-2",
      name: "sftp delete",
      source: { type: "sftp", host: "h", username: "u", password: "p", dir: "/drop", pollMs: 20 },
      destinations: [{ id: "facade", type: "fhirstore", ordered: true }],
    });
    await until(() => engine.db.listMessages({ channelId: "sftp-2" }).length === 1);
    assert.equal(remote.files.size, 0);
  } finally {
    await engine.stop();
  }
});

test("sftp configuration is validated", async () => {
  const engine = new Engine({ dbPath: ":memory:", tickMs: 15 });
  await engine.start();
  try {
    const bad = async (source: Record<string, unknown>, re: RegExp) =>
      assert.rejects(
        () =>
          engine.addChannel({
            id: "sftp-bad",
            name: "bad",
            source: source as never,
            destinations: [{ id: "d", type: "fhirstore" }],
          }),
        re
      );

    await bad({ type: "sftp", username: "u", password: "p", dir: "/d" }, /requires host/);
    await bad({ type: "sftp", host: "h", username: "u", dir: "/d" }, /password or privateKeyPath/);
  } finally {
    await engine.stop();
  }
});

test("optional drivers report a usable error when the package is absent", async () => {
  const engine = new Engine({ dbPath: ":memory:", tickMs: 15 });
  await engine.start();
  try {
    // Uses the real connector rather than a fake. Whether or not the optional
    // package happens to be installed here, a channel naming a driver must
    // never crash the engine — it logs and keeps polling.
    await engine.addChannel(sqlChannel("sql-real", { dsn: "postgres://nobody@127.0.0.1:1/none", pollMs: 50 }));
    assert.equal(engine.listChannels().find((c) => c.id === "sql-real")?.running, true);
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(engine.db.listMessages({ channelId: "sql-real" }).length, 0);
  } finally {
    await engine.stop();
  }
});
