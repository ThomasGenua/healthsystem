import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Engine } from "../src/core/engine.ts";
import { startApi } from "../src/api/admin.ts";
import { tlsFromEnv } from "../src/api/tls.ts";

const SCRIPT = fileURLToPath(new URL("../scripts/gen-dev-certs.sh", import.meta.url));

function haveOpenssl(): boolean {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** One request over TLS, optionally presenting a client certificate. */
function get(
  port: number,
  path: string,
  opts: { ca: Buffer; cert?: Buffer; key?: Buffer }
): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      { host: "localhost", port, path, method: "GET", ca: opts.ca, cert: opts.cert, key: opts.key },
      (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

test("mutual TLS: a trusted client certificate is required to reach the API", { skip: !haveOpenssl() }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "northstar-certs-"));
  try {
    execFileSync("bash", [SCRIPT, dir], { stdio: "ignore" });

    const tls = tlsFromEnv({
      certPath: join(dir, "server.crt"),
      keyPath: join(dir, "server.key"),
      caPath: join(dir, "ca.crt"),
      requireClientCert: true,
    });
    assert.ok(tls, "TLS config should be built from the generated certificates");
    assert.equal(tls.mutual, true);

    const engine = new Engine({ dbPath: ":memory:", tickMs: 15 });
    await engine.start();
    const api = await startApi(engine, 0, "127.0.0.1", { tls });
    assert.equal(api.tls, true);

    const ca = readFileSync(join(dir, "ca.crt"));

    // With the client certificate the handshake completes and the request is
    // served. /api/health is public, so a 200 here is proof of the transport,
    // not of any application-level grant.
    const ok = await get(api.port, "/api/health", {
      ca,
      cert: readFileSync(join(dir, "client.crt")),
      key: readFileSync(join(dir, "client.key")),
    });
    assert.equal(ok.status, 200);

    // Without it, the server rejects at the TLS layer: no HTTP status is ever
    // reached, the socket is torn down.
    await assert.rejects(() => get(api.port, "/api/health", { ca }), /alert|socket|handshake|EPROTO|closed/i);

    await api.close();
    await engine.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TLS configuration is all-or-nothing rather than silently plaintext", () => {
  assert.equal(tlsFromEnv({}), null, "no certificate configured means plain HTTP");

  assert.throws(() => tlsFromEnv({ certPath: "/x/server.crt" }), /must both be set/);
  assert.throws(() => tlsFromEnv({ keyPath: "/x/server.key" }), /must both be set/);

  // Asking for mutual TLS without a listener certificate must fail loudly; the
  // dangerous outcome would be starting anyway, unencrypted.
  assert.throws(() => tlsFromEnv({ requireClientCert: true }), /without NORTHSTAR_TLS_CERT/);
});
