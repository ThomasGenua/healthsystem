import { test } from "node:test";
import assert from "node:assert/strict";
import { stagingSmoke } from "../src/core/staging-smoke.ts";
import { Engine } from "../src/core/engine.ts";
import { startApi } from "../src/api/admin.ts";
import { AuthGate } from "../src/auth/gate.ts";

test("staging smoke exercises the real authenticated API without a credential", async () => {
  const engine = new Engine({ dbPath: ":memory:" });
  await engine.start();
  const api = await startApi(engine, 0, "127.0.0.1", { auth: new AuthGate({ keys: engine.keys, tenants: engine.db }) });
  try { assert.equal((await stagingSmoke(`http://127.0.0.1:${api.port}`)).length, 5); }
  finally { await api.close(); await engine.stop(); }
});

test("staging smoke rejects non-loopback plaintext, credentials and non-origin URLs", async () => {
  for (const origin of ["http://example.com", "https://user:secret@example.com", "https://example.com/path", "https://example.com/"]) {
    await assert.rejects(stagingSmoke(origin), /origin/);
  }
});

test("staging smoke fails when an admin route is open and does not print response content", async () => {
  const request = (async (url: string | URL | Request) => {
    if (String(url).endsWith("/api/health")) return Response.json({ ok: true, degraded: false });
    if (String(url).endsWith("/me")) return new Response("document", { headers: { "content-type": "text/html" } });
    return Response.json({ sensitive: "must-not-appear" });
  }) as typeof fetch;
  await assert.rejects(stagingSmoke("http://127.0.0.1", request), error => error instanceof Error && /expected 401/.test(error.message) && !error.message.includes("must-not-appear"));
});

test("staging smoke refuses degraded health", async () => {
  await assert.rejects(stagingSmoke("http://127.0.0.1", (async () => Response.json({ ok: true, degraded: true })) as typeof fetch), /degraded/);
});
