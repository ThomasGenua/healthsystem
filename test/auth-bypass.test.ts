/**
 * Adversarial probes against the authentication gate.
 *
 * The gate decides scope from the request path, and the router matches routes
 * from the same path, so the danger is any spelling of a URL where those two
 * disagree — a path the gate reads as public or read-only while the router
 * reads it as an admin route. Every case below tries to produce that
 * disagreement.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine } from "../src/core/engine.ts";
import { startApi } from "../src/api/admin.ts";
import { AuthGate } from "../src/auth/gate.ts";
import { requiredScope } from "../src/auth/scopes.ts";

/** Admin-only data that must never appear in a response to an unprivileged caller. */
const SECRET_CHANNEL = "audit-canary-channel";

async function boot() {
  const engine = new Engine({ dbPath: ":memory:", tickMs: 15 });
  await engine.start();
  await engine.addChannel({
    id: SECRET_CHANNEL,
    name: "canary",
    source: { type: "http", path: "canary" },
    destinations: [{ id: "d", type: "fhirstore" }],
  });
  const readKey = engine.keys.issue("reader", ["read"]);
  const api = await startApi(engine, 0, "127.0.0.1", { auth: new AuthGate({ keys: engine.keys }) });
  return {
    engine,
    readKey: readKey.key,
    base: `http://127.0.0.1:${api.port}`,
    close: async () => {
      await api.close();
      await engine.stop();
    },
  };
}

test("no spelling of an admin path reaches admin data without the admin scope", async () => {
  const { base, readKey, close } = await boot();
  try {
    // Each of these resolves to, or tries to smuggle in, /api/channels.
    const attempts = [
      "/api/channels",
      "/api/channels/",
      "/api/channels//",
      "//api/channels",
      "/./api/channels",
      "/foo/../api/channels",
      "/fhir/../api/channels",
      "/fhir/metadata/../../api/channels",
      "/API/channels",
      "/Api/Channels",
      "/api/./channels",
      "/api/channels?x=1",
      "/api%2Fchannels",
      "/%61pi/channels",
      "/api/channels%00",
      "/api/channels.",
      "/api/channels;",
      "/ /api/channels",
    ];

    for (const path of attempts) {
      for (const headers of [{}, { authorization: `Bearer ${readKey}` }]) {
        const res = await fetch(base + path, { headers });
        const text = await res.text();

        assert.ok(
          res.status === 401 || res.status === 403 || res.status === 404 || res.status === 400,
          `${path} (${Object.keys(headers).length ? "read key" : "no key"}) returned ${res.status}, expected a refusal`
        );
        assert.ok(
          !text.includes(SECRET_CHANNEL),
          `${path} leaked admin data with ${Object.keys(headers).length ? "a read-only key" : "no credentials"}`
        );
      }
    }
  } finally {
    await close();
  }
});

test("a read scope cannot write, and no verb trick gets around it", async () => {
  const { base, readKey, close } = await boot();
  try {
    const auth = { authorization: `Bearer ${readKey}` };

    // Writes must be refused outright...
    for (const [method, path] of [
      ["POST", "/fhir/Patient"],
      ["POST", "/ingest/canary"],
      ["POST", "/fhir/Subscription"],
      ["DELETE", "/fhir/Subscription/anything"],
      ["POST", "/api/channels"],
      ["DELETE", "/api/channels/" + SECRET_CHANNEL],
    ] as const) {
      const res = await fetch(base + path, { method, headers: auth, body: method === "POST" ? "{}" : undefined });
      assert.equal(res.status, 403, `${method} ${path} must be refused for a read-only key`);
    }

    // ...including when the real verb is smuggled in a header, which some
    // frameworks honour and this one must not.
    const smuggled = await fetch(`${base}/fhir/Patient`, {
      method: "GET",
      headers: { ...auth, "x-http-method-override": "POST", "x-method-override": "POST" },
    });
    assert.equal(smuggled.status, 200, "the override header must be ignored, leaving a plain GET");

    // The channel is still there: nothing above deleted it.
    const adminView = await fetch(`${base}/api/channels`, { headers: auth });
    assert.equal(adminView.status, 403);
  } finally {
    await close();
  }
});

test("the scope map has no path that falls open", () => {
  // Anything unrecognised must demand admin rather than sail through. This is
  // the property that makes adding a route later safe.
  const oddities = [
    "/",
    "/ui",
    "/api",
    "/apix/channels",
    "/api-channels",
    "/fhir",
    "/fhirx/Patient",
    "/ingest",
    "/ingestx/lab",
    "/unknown",
    "",
    "/..",
    "/%2e%2e",
  ];
  const open = oddities.filter((p) => requiredScope("GET", p) === null);
  assert.deepEqual(open, ["/", "/ui"], `only the UI shell may be public, got: ${open.join(", ")}`);

  // The three genuinely public routes, and nothing else.
  assert.equal(requiredScope("GET", "/api/health"), null);
  assert.equal(requiredScope("GET", "/fhir/metadata"), null);
  // ...and they are public only for GET.
  assert.equal(requiredScope("POST", "/api/health"), "admin");
  assert.equal(requiredScope("DELETE", "/fhir/metadata"), "write");
});

test("credentials in odd shapes are rejected rather than misread", async () => {
  const { base, readKey, close } = await boot();
  try {
    const cases: Array<Record<string, string>> = [
      { authorization: "Bearer" },
      { authorization: "Bearer " },
      { authorization: readKey },
      { authorization: `Basic ${Buffer.from("a:b").toString("base64")}` },
      { authorization: `Bearer ${readKey} ${readKey}` },
      { "x-api-key": "" },
      { "x-api-key": "   " },
      { authorization: "Bearer null" },
      { authorization: "Bearer undefined" },
      // A JWT-shaped token when no OIDC issuer is configured at all.
      { authorization: "Bearer eyJhbGciOiJub25lIn0.eyJzY29wZSI6ImFkbWluIn0." },
    ];

    for (const headers of cases) {
      const res = await fetch(`${base}/fhir/Patient`, { headers });
      assert.equal(res.status, 401, `header ${JSON.stringify(headers)} must not authenticate`);
    }

    // The valid form still works, so the above is rejection and not breakage.
    assert.equal((await fetch(`${base}/fhir/Patient`, { headers: { authorization: `Bearer ${readKey}` } })).status, 200);

    // Surrounding whitespace is tolerated on purpose: keys get copied out of
    // terminals and config files. This is safe rather than sloppy because a
    // key is base64url and contains no whitespace, so trimming can never make
    // two distinct keys collide — the credential still has to match exactly.
    for (const value of [`Bearer ${readKey} `, `Bearer  ${readKey}`, ` Bearer ${readKey} `]) {
      assert.equal(
        (await fetch(`${base}/fhir/Patient`, { headers: { authorization: value } })).status,
        200,
        `padded credential ${JSON.stringify(value)} should still authenticate`
      );
    }
    assert.equal((await fetch(`${base}/fhir/Patient`, { headers: { "x-api-key": ` ${readKey} ` } })).status, 200);
  } finally {
    await close();
  }
});
