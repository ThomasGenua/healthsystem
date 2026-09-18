/**
 * The headers the two pages and the API are served with.
 *
 * The admin console holds an API key in browser storage and attaches it to
 * every request, so script running in that page runs with that key and the
 * authorisation model behind it is beside the point. A Content-Security-Policy
 * is the line that still holds on the day an escaping call is missed — which
 * is not hypothetical here: `test/ui-xss.test.ts` records one that was.
 *
 * So these pin the two properties that make the policy worth having, rather
 * than merely that a header is present. The nonce has to be fresh per
 * response and has to match the script it admits; and `script-src` must never
 * admit inline script, because a policy carrying 'unsafe-inline' reads as
 * enforcement while enforcing nothing against exactly the attack it is here
 * for.
 *
 * The last test is structural rather than behavioural: it reads the pages and
 * refuses an inline event-handler attribute anywhere in either. Nonce-based
 * script-src does already refuse them at runtime, but a handler added back
 * would then fail silently in the browser rather than loudly here, and the
 * next person would reach for 'unsafe-inline' to fix it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Engine } from "../src/core/engine.ts";
import { hstsHeader, startApi } from "../src/api/admin.ts";
import { tlsFromEnv } from "../src/api/tls.ts";

const CERT_SCRIPT = fileURLToPath(new URL("../scripts/gen-dev-certs.sh", import.meta.url));

function haveOpenssl(): boolean {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function boot() {
  const engine = new Engine({ dbPath: ":memory:", tickMs: 15 });
  await engine.start();
  const api = await startApi(engine, 0, "127.0.0.1");
  return {
    base: `http://127.0.0.1:${api.port}`,
    close: async () => {
      await api.close();
      await engine.stop();
    },
  };
}

/** The directives of one policy, by name. */
function directives(policy: string | null): Record<string, string> {
  assert.ok(policy, "no content-security-policy on the response");
  const out: Record<string, string> = {};
  for (const part of policy.split(";")) {
    const [name, ...rest] = part.trim().split(/\s+/);
    if (name) out[name] = rest.join(" ");
  }
  return out;
}

for (const path of ["/", "/ui", "/me"]) {
  test(`${path} is served under a policy naming the nonce its script carries`, async () => {
    const { base, close } = await boot();
    try {
      const r = await fetch(base + path);
      assert.equal(r.status, 200);
      const body = await r.text();
      const d = directives(r.headers.get("content-security-policy"));

      const m = /^'nonce-([A-Za-z0-9+/=]+)'$/.exec(d["script-src"] ?? "");
      assert.ok(m, `script-src should be exactly one nonce, was ${d["script-src"]}`);
      assert.ok(
        body.includes(`<script nonce="${m[1]}">`),
        "the page's script does not carry the nonce the policy admits"
      );
      // The substitution having happened at all, stated separately: a page
      // still carrying the placeholder would fail the line above for the
      // right reason but a future refactor could make it pass for the wrong
      // one.
      assert.ok(!body.includes("{{nonce}}"), "the nonce placeholder reached the browser");

      assert.equal(d["default-src"], "'none'");
      assert.equal(d["frame-ancestors"], "'none'");
      assert.equal(d["base-uri"], "'none'");
      assert.equal(d["form-action"], "'none'");
      assert.equal(r.headers.get("x-content-type-options"), "nosniff");
      assert.equal(r.headers.get("referrer-policy"), "no-referrer");
    } finally {
      await close();
    }
  });
}

test("script-src admits a nonce and never inline script", async () => {
  const { base, close } = await boot();
  try {
    for (const path of ["/", "/me"]) {
      const d = directives((await fetch(base + path)).headers.get("content-security-policy"));
      const src = d["script-src"] ?? "";
      // The whole point. A nonce beside 'unsafe-inline' is not a weaker
      // policy than a nonce alone — for script elements it is the same
      // policy as having none, which is the failure worth a test of its own.
      assert.ok(!src.includes("'unsafe-inline'"), `script-src admits inline script: ${src}`);
      assert.ok(!src.includes("'unsafe-eval'"), `script-src admits eval: ${src}`);
    }
  } finally {
    await close();
  }
});

test("the nonce is minted per response, not once per process", async () => {
  const { base, close } = await boot();
  try {
    const nonce = async () => directives((await fetch(base + "/")).headers.get("content-security-policy"))["script-src"];
    assert.notEqual(await nonce(), await nonce(), "two responses shared a nonce");
  } finally {
    await close();
  }
});

test("a response that is not a document carries the empty policy", async () => {
  const { base, close } = await boot();
  try {
    // A served body, and a refusal. The second is the one worth naming: the
    // error path writes its response from the router's catch rather than from
    // a route, and headers set only by routes would miss it.
    for (const path of ["/api/health", "/api/nothing-here"]) {
      const r = await fetch(base + path);
      const d = directives(r.headers.get("content-security-policy"));
      assert.equal(d["default-src"], "'none'", path);
      assert.equal(d["frame-ancestors"], "'none'", path);
      assert.equal(r.headers.get("x-content-type-options"), "nosniff", path);
      assert.equal(r.headers.get("referrer-policy"), "no-referrer", path);
    }
  } finally {
    await close();
  }
});

test("a node that does not terminate TLS sends no HSTS", async () => {
  const { base, close } = await boot();
  try {
    // Not an omission: over plain HTTP the header is meaningless to a browser,
    // and a node behind a TLS-terminating proxy cannot tell the difference
    // from here except by trusting a forwarded header anyone reaching the port
    // could write. The proxy sends it instead.
    for (const path of ["/", "/api/health"]) {
      assert.equal((await fetch(base + path)).headers.get("strict-transport-security"), null, path);
    }
  } finally {
    await close();
  }
});

test("a node holding its own certificate sends HSTS, without reaching other hostnames", { skip: !haveOpenssl() }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "northstar-hsts-"));
  const engine = new Engine({ dbPath: ":memory:", tickMs: 15 });
  await engine.start();
  let api: Awaited<ReturnType<typeof startApi>> | undefined;
  try {
    execFileSync(CERT_SCRIPT, [dir], { stdio: "ignore" });
    const tls = tlsFromEnv({ certPath: join(dir, "server.crt"), keyPath: join(dir, "server.key") });
    assert.ok(tls, "the dev certificates did not produce a TLS config");
    api = await startApi(engine, 0, "127.0.0.1", { tls });
    assert.equal(api.tls, true);

    const header = await new Promise<string | undefined>((resolve, reject) => {
      const req = httpsRequest(
        {
          host: "localhost",
          port: api!.port,
          path: "/api/health",
          method: "GET",
          ca: readFileSync(join(dir, "ca.crt")),
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.headers["strict-transport-security"] as string | undefined));
        }
      );
      req.on("error", reject);
      req.end();
    });

    assert.equal(header, "max-age=31536000");
    // The two directives deliberately never sent. `includeSubDomains` takes
    // down a sibling hostname serving something else over HTTP, and `preload`
    // is close to irreversible once a browser ships the list — neither is this
    // process's decision to make about a whole domain.
    assert.ok(!/includeSubDomains/i.test(header ?? ""), "HSTS reached hostnames this node does not own");
    assert.ok(!/preload/i.test(header ?? ""), "HSTS asked to be preloaded");
  } finally {
    if (api) await api.close();
    await engine.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the HSTS duration is the deployment's to set, and a bad one stops the node", () => {
  // A site that may have to serve plain HTTP again has to lower this before it
  // ships, because browsers remember the last value they were given.
  assert.equal(hstsHeader({}), "max-age=31536000");
  assert.equal(hstsHeader({ NORTHSTAR_HSTS_MAX_AGE: "600" }), "max-age=600");
  // Zero is how a deployment turns it off, which is different from a typo.
  assert.equal(hstsHeader({ NORTHSTAR_HSTS_MAX_AGE: "0" }), null);
  for (const bad of ["forever", "-1", "1e6", "31536000s", " "]) {
    assert.throws(() => hstsHeader({ NORTHSTAR_HSTS_MAX_AGE: bad }), /whole number of seconds/, bad);
  }
});

test("neither page carries an inline event handler", () => {
  for (const file of ["ui.html", "portal.html"]) {
    const src = readFileSync(new URL(`../src/api/${file}`, import.meta.url), "utf8");
    const found = [...src.matchAll(/\s(on[a-z]+)\s*=\s*["']/g)].map((m) => m[1]);
    assert.deepEqual(
      found,
      [],
      `${file} carries ${found.join(", ")}. An attribute holding JavaScript is HTML-decoded before it is ` +
        `parsed, so escaping a quoted value into one does not keep it inside the string literal — bind it ` +
        `through a data attribute and the handler table instead.`
    );
  }
});
