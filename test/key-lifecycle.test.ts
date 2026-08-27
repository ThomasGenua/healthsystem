/**
 * Credentials that outlive their reason.
 *
 * A key that never expires and that nobody reviews is the ordinary way
 * long-lived access survives the thing it was for. The contractor's
 * integration key still works. The pilot that ended two years ago still has
 * one. Nothing anywhere says so, and a key issued for a purpose that finished
 * is indistinguishable from one somebody else is quietly using — which is the
 * whole difficulty: neither state announces itself, and both are found only by
 * going looking.
 *
 * So the tests here are about what happens with nobody looking: expiry that
 * applies by the clock rather than by a sweep, a rotation whose second half
 * does not depend on anyone coming back to it, and a dormancy query that
 * treats a key never used as dormant from the day it was issued.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../src/db.ts";
import { ApiKeyStore } from "../src/auth/keys.ts";

function vault() {
  const dir = mkdtempSync(join(tmpdir(), "northstar-keys-"));
  const db = new Db(join(dir, "northstar.db"));
  return {
    db,
    keys: new ApiKeyStore(db),
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();
const agoDays = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

test("an expired key stops working by the clock, with nothing having to run", () => {
  // Not by a sweep. A key that expired last night has to be dead this
  // morning whether or not anything has restarted since, or the expiry date
  // is an intention rather than a control.
  const { db, keys, cleanup } = vault();
  try {
    const expiry = inDays(30);
    const k = keys.issue("pilot", ["read"], { expiresAt: expiry });
    assert.equal(k.expiresAt, expiry, "the caller's date, stored as given");
    assert.equal(keys.list().find((r) => r.id === k.id)!.expires_at, expiry);
    assert.ok(keys.verify(k.key), "works today");

    // Reach under the API to move the date, which is what tomorrow looks like.
    db.sql.prepare("UPDATE api_keys SET expires_at = ? WHERE id = ?").run(agoDays(1), k.id);
    assert.equal(keys.verify(k.key), null, "and not the day after it lapsed");

    // The row is still there: who had access when is not something to delete.
    assert.equal(keys.list().find((r) => r.id === k.id)?.revoked_at, null);
    assert.equal(keys.countActive(), 0, "and it does not count as a live credential");
  } finally {
    cleanup();
  }
});

test("a key with no expiry is a choice, not a default", () => {
  const { keys, cleanup } = vault();
  try {
    const forever = keys.issue("adt-feed", ["write"]);
    assert.equal(forever.expiresAt, null);
    assert.ok(keys.verify(forever.key));

    assert.throws(() => keys.issue("late", ["read"], { expiresAt: agoDays(1) }), /already past/);
    assert.equal(keys.list().filter((k) => k.name === "late").length, 0, "and nothing was issued");
  } finally {
    cleanup();
  }
});

test("rotation leaves both keys working, and ends the overlap on a date", () => {
  // A rotation that cut the old key off the instant the new one existed would
  // make every rotation an outage between issuing the credential and getting
  // it deployed — which is why rotation gets deferred and then skipped.
  const { keys, cleanup } = vault();
  try {
    const old = keys.issue("lab-feed", ["write"]);
    const next = keys.rotate(old.id, { overlapDays: 7 });

    assert.equal(next.replaces, old.id);
    assert.notEqual(next.key, old.key);
    assert.ok(keys.verify(old.key), "the deployed credential keeps working");
    assert.ok(keys.verify(next.key), "and so does its replacement");
    assert.deepEqual(keys.verify(next.key)!.row.scopes, "write", "with the same scopes, not more");
    assert.equal(keys.verify(next.key)!.row.name, "lab-feed");

    // And the overlap ends on its own rather than waiting for somebody to
    // come back to it. Two working credentials where there should be one is
    // worse than not having rotated.
    const row = keys.list().find((k) => k.id === old.id)!;
    assert.equal(row.rotated_to, next.id);
    assert.ok(row.expires_at, "the old key now has a retirement date");
    assert.equal(row.expires_at, next.previousRetiresAt);
  } finally {
    cleanup();
  }
});

test("the overlap actually ends", () => {
  const { db, keys, cleanup } = vault();
  try {
    const old = keys.issue("lab-feed", ["write"]);
    const next = keys.rotate(old.id, { overlapDays: 7 });

    db.sql.prepare("UPDATE api_keys SET expires_at = ? WHERE id = ?").run(agoDays(1), old.id);
    assert.equal(keys.verify(old.key), null, "the retired key stops on its date");
    assert.ok(keys.verify(next.key), "and the replacement carries on");
  } finally {
    cleanup();
  }
});

test("a key is rotated once, and a revoked one is not rotated at all", () => {
  const { keys, cleanup } = vault();
  try {
    const old = keys.issue("lab-feed", ["write"]);
    keys.rotate(old.id);
    assert.throws(() => keys.rotate(old.id), /already rotated to/);

    const dead = keys.issue("gone", ["read"]);
    keys.revoke(dead.id);
    assert.throws(() => keys.rotate(dead.id), /revoked; issue a new one/);
    assert.throws(() => keys.rotate("no-such-key"), /no key no-such-key/);
  } finally {
    cleanup();
  }
});

test("a key nobody has used is dormant, and one never used is dormant from birth", () => {
  // The shape that matters most: a key pasted into a ticket and never
  // deployed has no last-used date at all, and a query that filtered on
  // last_used_at would skip exactly those.
  const { db, keys, cleanup } = vault();
  try {
    const busy = keys.issue("adt-feed", ["write"]);
    const idle = keys.issue("old-pilot", ["read"]);
    const neverUsed = keys.issue("pasted-into-a-ticket", ["read"]);

    keys.verify(busy.key);
    db.sql.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(agoDays(200), idle.id);
    db.sql.prepare("UPDATE api_keys SET created_at = ? WHERE id = ?").run(agoDays(300), neverUsed.id);

    const dormant = keys.dormant(90);
    assert.deepEqual(
      dormant.map((k) => k.name).sort(),
      ["old-pilot", "pasted-into-a-ticket"],
      "used yesterday is not dormant; never used at all is"
    );
    assert.equal(dormant[0].name, "pasted-into-a-ticket", "oldest first");
    assert.equal(dormant[0].last_used_at, null);

    assert.equal(keys.dormant(365).length, 0, "and the window is the window");
  } finally {
    cleanup();
  }
});

test("a revoked or already-expired key is not reported as dormant", () => {
  // Dormancy is a list somebody has to act on. Padding it with credentials
  // that are already dead is how a list stops being acted on.
  const { db, keys, cleanup } = vault();
  try {
    const revoked = keys.issue("gone", ["read"]);
    const expired = keys.issue("lapsed", ["read"], { expiresAt: inDays(1) });
    const live = keys.issue("still-here", ["read"]);
    for (const k of [revoked, expired, live]) {
      db.sql.prepare("UPDATE api_keys SET created_at = ? WHERE id = ?").run(agoDays(300), k.id);
    }
    keys.revoke(revoked.id);
    db.sql.prepare("UPDATE api_keys SET expires_at = ? WHERE id = ?").run(agoDays(1), expired.id);

    assert.deepEqual(keys.dormant(90).map((k) => k.name), ["still-here"]);
  } finally {
    cleanup();
  }
});

test("keys about to lapse are surfaced before they do", () => {
  // So a renewal is a decision somebody makes rather than an outage they
  // discover — the same property proxy authority has, for the same reason.
  const { keys, cleanup } = vault();
  try {
    keys.issue("soon", ["read"], { expiresAt: inDays(5) });
    keys.issue("later", ["read"], { expiresAt: inDays(200) });
    keys.issue("never", ["read"]);

    assert.deepEqual(keys.expiring(14).map((k) => k.name), ["soon"]);
    assert.equal(keys.expiring(365).length, 2);
    assert.equal(keys.expiring(1).length, 0);
  } finally {
    cleanup();
  }
});

test("key lifecycle is confined to its tenant", () => {
  const dir = mkdtempSync(join(tmpdir(), "northstar-keys-iso-"));
  const root = new Db(join(dir, "northstar.db"));
  try {
    root.createTenant("north", "Northern Health");
    root.createTenant("south", "Southern Health");
    const north = new ApiKeyStore(root.forTenant("north"));
    const south = new ApiKeyStore(root.forTenant("south"));

    const k = north.issue("north-feed", ["write"], { expiresAt: inDays(5) });
    root.forTenant("north").sql.prepare("UPDATE api_keys SET created_at = ? WHERE id = ?").run(agoDays(300), k.id);

    assert.equal(north.dormant(90).length, 1);
    assert.equal(south.dormant(90).length, 0, "one custodian's credentials are not another's to review");
    assert.equal(south.expiring(365).length, 0);
    assert.equal(north.expiring(365).length, 1);
    assert.throws(() => south.rotate(k.id), /no key/);
    assert.equal(south.revoke(k.id), false, "and not another's to revoke");
    assert.ok(north.verify(k.key), "which did not disturb it");
  } finally {
    root.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an operator can see and act on the two questions over the wire", async () => {
  // A dormancy list nobody can reach is a query, not a control. Both of these
  // are lists somebody acts on, so both are served — and rotating returns the
  // replacement key once, exactly as issuing one does.
  const { Engine } = await import("../src/core/engine.ts");
  const { startApi } = await import("../src/api/admin.ts");
  const { AuthGate } = await import("../src/auth/gate.ts");

  const engine = new Engine({ dbPath: ":memory:", tickMs: 15 });
  await engine.start();
  const admin = engine.keys.issue("ops", ["admin"]).key;
  const stale = engine.keys.issue("old-pilot", ["read"]);
  const soon = engine.keys.issue("expiring-soon", ["read"], { expiresAt: inDays(3) });
  engine.db.sql.prepare("UPDATE api_keys SET created_at = ? WHERE id = ?").run(agoDays(300), stale.id);

  const api = await startApi(engine, 0, "127.0.0.1", { auth: new AuthGate({ keys: engine.keys }) });
  const base = `http://127.0.0.1:${api.port}`;
  const hdr = { authorization: `Bearer ${admin}`, "content-type": "application/json" };
  try {
    const review = (await (await fetch(`${base}/api/keys/review`, { headers: hdr })).json()) as {
      dormant: Array<{ name: string }>;
      expiring: Array<{ name: string }>;
    };
    assert.deepEqual(review.dormant.map((k) => k.name), ["old-pilot"]);
    assert.deepEqual(review.expiring.map((k) => k.name), ["expiring-soon"]);

    const res = await fetch(`${base}/api/keys/${stale.id}/rotate`, {
      method: "POST",
      headers: hdr,
      body: JSON.stringify({ overlapDays: 3 }),
    });
    assert.equal(res.status, 201);
    const next = (await res.json()) as { key: string; replaces: string; previousRetiresAt: string };
    assert.equal(next.replaces, stale.id);
    assert.ok(next.key.startsWith("ptg_"), "shown once, here, like any new key");
    assert.ok(engine.keys.verify(stale.key), "and the deployed one keeps working through the overlap");

    // Rotating it again is refused rather than quietly issuing a third key.
    const again = await fetch(`${base}/api/keys/${stale.id}/rotate`, { method: "POST", headers: hdr, body: "{}" });
    assert.equal(again.status, 400);

    // And the review endpoint is behind admin like the rest of /api.
    const reader = engine.keys.issue("consumer", ["read"]).key;
    const refused = await fetch(`${base}/api/keys/review`, { headers: { authorization: `Bearer ${reader}` } });
    assert.equal(refused.status, 403);
  } finally {
    await api.close();
    await engine.stop();
  }
});
