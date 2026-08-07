import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine } from "../src/core/engine.ts";
import { startApi } from "../src/api/admin.ts";
import { AuthGate } from "../src/auth/gate.ts";
import { RateLimiter } from "../src/api/ratelimit.ts";

async function boot(rateLimit: Record<string, unknown> = {}, withAuth = true) {
  const engine = new Engine({ dbPath: ":memory:", tickMs: 15 });
  await engine.start();
  const keys = withAuth ? { admin: engine.keys.issue("ops", ["admin"]).key } : { admin: "" };
  const api = await startApi(engine, 0, "127.0.0.1", {
    ...(withAuth ? { auth: new AuthGate({ keys: engine.keys }) } : {}),
    rateLimit,
  });
  return {
    engine,
    api,
    keys,
    base: `http://127.0.0.1:${api.port}`,
    close: async () => {
      await api.close();
      await engine.stop();
    },
  };
}

test("the token bucket admits a burst, then throttles to the sustained rate", () => {
  const limiter = new RateLimiter({ anonymousPerMinute: 60, burstFactor: 2 });

  // 60/min with a burst factor of 2 is a 120-token bucket, starting full.
  let allowed = 0;
  for (let i = 0; i < 200; i++) if (limiter.check("ip:1.2.3.4", false).allowed) allowed++;
  assert.equal(allowed, 120, "the burst is exactly the bucket capacity");

  const refused = limiter.check("ip:1.2.3.4", false);
  assert.equal(refused.allowed, false);
  assert.ok(refused.retryAfterSec >= 1, "a refusal says when to come back");

  // A different caller is unaffected: one client cannot spend another's budget.
  assert.equal(limiter.check("ip:5.6.7.8", false).allowed, true);
});

test("authenticated callers get their own, larger budget", () => {
  const limiter = new RateLimiter({ anonymousPerMinute: 10, authenticatedPerMinute: 100, burstFactor: 1 });

  let anon = 0;
  for (let i = 0; i < 50; i++) if (limiter.check("ip:1.1.1.1", false).allowed) anon++;
  assert.equal(anon, 10);

  let auth = 0;
  for (let i = 0; i < 200; i++) if (limiter.check("principal:key-1", true).allowed) auth++;
  assert.equal(auth, 100);

  // Exhausting the anonymous budget must not touch a credentialed feed.
  assert.equal(limiter.check("principal:key-2", true).allowed, true);
});

test("firstRefusal marks only the request that crosses the threshold", () => {
  const limiter = new RateLimiter({ anonymousPerMinute: 6, burstFactor: 1 });
  for (let i = 0; i < 6; i++) limiter.check("ip:9.9.9.9", false);

  const first = limiter.check("ip:9.9.9.9", false);
  assert.equal(first.allowed, false);
  assert.equal(first.firstRefusal, true, "the crossing request is the one worth recording");

  for (let i = 0; i < 20; i++) {
    assert.equal(limiter.check("ip:9.9.9.9", false).firstRefusal, false, "a sustained flood records once, not per request");
  }
});

test("tokens refill over time", async () => {
  const limiter = new RateLimiter({ anonymousPerMinute: 6_000, burstFactor: 1 });

  // Drain until actually refused rather than assuming a fixed count empties
  // the bucket: tokens refill while the draining loop runs, and under load
  // that made a fixed count leave the bucket non-empty.
  let drained = 0;
  while (limiter.check("ip:refill", false).allowed) {
    if (++drained > 100_000) throw new Error("bucket never drained");
  }
  assert.ok(drained > 0, "the bucket held tokens before draining");
  assert.equal(limiter.check("ip:refill", false).allowed, false, "and is empty now");

  // 6000/min is 0.1 tokens per ms, so 60ms restores several.
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(limiter.check("ip:refill", false).allowed, true, "waiting must restore capacity");
});

test("bucket tracking is bounded, so rotating source addresses cannot grow memory", () => {
  const limiter = new RateLimiter({ anonymousPerMinute: 60 });
  for (let i = 0; i < 12_000; i++) limiter.check(`ip:10.0.${Math.floor(i / 256)}.${i % 256}`, false);
  assert.ok(limiter.describe().tracked <= 10_000, `tracked ${limiter.describe().tracked} buckets, expected a cap`);
});

test("disabling it lets everything through", () => {
  const limiter = new RateLimiter({ enabled: false, anonymousPerMinute: 1 });
  for (let i = 0; i < 500; i++) assert.equal(limiter.check("ip:x", false).allowed, true);
  assert.equal(limiter.enabled, false);
});

test("a flood of refused requests cannot grow the audit trail without bound", async () => {
  // The vector this exists to close: every refused request to a patient-data
  // path writes an audit row, so hammering the facade unauthenticated would
  // otherwise fill the database.
  const { engine, base, close } = await boot({ anonymousPerMinute: 10, burstFactor: 1 });
  try {
    const before = engine.audit.count();

    let refused429 = 0;
    for (let i = 0; i < 200; i++) {
      const res = await fetch(`${base}/fhir/Patient?identifier=NT${i}`);
      if (res.status === 429) refused429++;
    }

    assert.ok(refused429 > 150, `expected most requests to be rate limited, got ${refused429}`);

    // 10 auth refusals were recorded, then one row for the flood itself.
    const written = engine.audit.count() - before;
    assert.ok(written <= 12, `audit trail grew by ${written} rows across 200 requests; the flood must not be recorded per request`);
    assert.ok(written >= 10, "the requests that got through before the limit are still recorded");

    const flood = engine.audit.list({ failuresOnly: true }).find((r) => r.detail === "rate limit exceeded");
    assert.ok(flood, "the flood itself is recorded once");
    assert.equal(flood.outcome, 8);
  } finally {
    await close();
  }
});

test("a 429 carries Retry-After and does not disturb a credentialed caller", async () => {
  const { base, keys, close } = await boot({ anonymousPerMinute: 5, authenticatedPerMinute: 1_000, burstFactor: 1 });
  try {
    let limited: Response | null = null;
    for (let i = 0; i < 30; i++) {
      const res = await fetch(`${base}/fhir/Patient`);
      if (res.status === 429) {
        limited = res;
        break;
      }
    }
    assert.ok(limited, "anonymous traffic must eventually be limited");
    assert.ok(Number(limited.headers.get("retry-after")) >= 1, "a 429 must say when to retry");
    const body = (await limited.json()) as { error: string; retryAfterSec: number };
    assert.match(body.error, /rate limit/);

    // The credentialed feed is on its own budget and keeps working throughout.
    const auth = { authorization: `Bearer ${keys.admin}` };
    for (let i = 0; i < 20; i++) {
      assert.equal((await fetch(`${base}/api/channels`, { headers: auth })).status, 200);
    }
  } finally {
    await close();
  }
});

test("limits are generous enough by default not to trouble ordinary use", async () => {
  const { base, keys, close } = await boot();
  try {
    const auth = { authorization: `Bearer ${keys.admin}` };
    for (let i = 0; i < 100; i++) {
      const res = await fetch(`${base}/api/health`, { headers: auth });
      assert.equal(res.status, 200, `request ${i} was limited under default settings`);
    }
  } finally {
    await close();
  }
});

test("an auth-off deployment is still limited, per source rather than as one pool", async () => {
  // Regression: with authentication disabled every caller resolves to the same
  // synthetic anonymous principal. Keying the bucket on that put unrelated
  // callers in one shared bucket AND handed them the credentialed rate, so an
  // auth-off deployment had no meaningful protection at all.
  const { engine, base, close } = await boot({ anonymousPerMinute: 10, burstFactor: 1 }, false);
  try {
    const before = engine.audit.count();
    let limited = 0;
    for (let i = 0; i < 120; i++) {
      if ((await fetch(`${base}/fhir/Patient?identifier=NT${i}`)).status === 429) limited++;
    }
    assert.ok(limited > 90, `expected the anonymous rate to apply, only ${limited} of 120 were limited`);
    assert.ok(engine.audit.count() - before <= 12, "and the audit trail must not grow per request");
  } finally {
    await close();
  }
});

test("a credentialed caller on a public route is counted per source, not as one pool", async () => {
  // /api/health needs no scope, so the gate returns the anonymous principal
  // even for a valid key. Two different keys polling it must not share, and
  // must not silently receive the credentialed budget.
  const { base, keys, close } = await boot({ anonymousPerMinute: 8, authenticatedPerMinute: 10_000, burstFactor: 1 });
  try {
    let limited = 0;
    for (let i = 0; i < 40; i++) {
      const res = await fetch(`${base}/api/health`, { headers: { authorization: `Bearer ${keys.admin}` } });
      if (res.status === 429) limited++;
    }
    assert.ok(limited > 20, `a public route must use the anonymous budget, only ${limited} of 40 were limited`);

    // ...while a scoped route on the same key uses the credentialed budget.
    for (let i = 0; i < 30; i++) {
      const res = await fetch(`${base}/api/channels`, { headers: { authorization: `Bearer ${keys.admin}` } });
      assert.equal(res.status, 200, "the credentialed budget must be unaffected");
    }
  } finally {
    await close();
  }
});
