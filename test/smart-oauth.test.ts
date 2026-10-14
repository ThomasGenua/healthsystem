/**
 * The ways a bearer token is accepted when it should not be.
 *
 * Northstar is a resource server: it validates tokens a site's own identity
 * provider issued, and does not mint them. So the attacks that matter here
 * are the ones against validation — a token meant for something else, one
 * signed with a key that has been rotated away, one naming an algorithm the
 * server can be talked into, one whose issuer went down at the wrong moment.
 *
 * The one that was real is first. `audience` was optional, and an absent
 * audience skipped the check entirely: every token that issuer had ever
 * signed was accepted. An identity provider serves many applications, so a
 * token for the expenses system, signed by the same directory, was a valid
 * Northstar token — and the deployments that never set the variable were
 * precisely the ones running without the check.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { JwtVerifier } from "../src/auth/jwt.ts";
import { AuthGate } from "../src/auth/gate.ts";

const AUD = "northstar-yellowknife";

/**
 * A cache lifetime that has always already expired.
 *
 * Not 0 and not 1: the freshness check is a strict greater-than against
 * elapsed milliseconds, and these calls complete inside the same millisecond,
 * so any non-negative lifetime leaves the cache fresh and the rotation and
 * outage paths never run. This says "hold nothing" without pretending a
 * millisecond is a duration.
 */
const NEVER_CACHE = -1;

/**
 * An identity provider that can rotate its key, go down, and sign for any
 * audience — the three things a real one does at the wrong moment.
 */
async function idp() {
  const first = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const second = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = (k: typeof first.publicKey, kid: string) => ({
    ...k.export({ format: "jwk" }),
    kid,
    alg: "RS256",
    use: "sig",
  });

  let served: Array<Record<string, unknown>> = [jwk(first.publicKey, "key-1")];
  let down = false;
  let hits = 0;

  const server = createServer((req, res) => {
    if (down) {
      res.writeHead(503).end();
      return;
    }
    if (req.url === "/.well-known/openid-configuration") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ issuer, jwks_uri: `${issuer}/jwks` }));
      return;
    }
    if (req.url === "/jwks") {
      hits++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ keys: served }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  const issuer = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;

  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const mint = (
    claims: Record<string, unknown>,
    opts: { kid?: string; key?: typeof first.privateKey; alg?: string } = {}
  ) => {
    const header = b64({ alg: opts.alg ?? "RS256", kid: opts.kid ?? "key-1", typ: "JWT" });
    const payload = b64({ iss: issuer, aud: AUD, exp: Math.floor(Date.now() / 1000) + 300, ...claims });
    const sig = cryptoSign("sha256", Buffer.from(`${header}.${payload}`), opts.key ?? first.privateKey);
    return `${header}.${payload}.${sig.toString("base64url")}`;
  };

  return {
    get issuer() {
      return issuer;
    },
    mint,
    secondKey: second.privateKey,
    /** Rotate, optionally keeping the old key served alongside the new one. */
    rotate: (overlap: boolean) => {
      served = overlap
        ? [jwk(first.publicKey, "key-1"), jwk(second.publicKey, "key-2")]
        : [jwk(second.publicKey, "key-2")];
    },
    setDown: (v: boolean) => {
      down = v;
    },
    hits: () => hits,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const verifier = (i: Awaited<ReturnType<typeof idp>>, over: Record<string, unknown> = {}) =>
  new JwtVerifier({ issuer: i.issuer, audience: AUD, jwksUri: `${i.issuer}/jwks`, ...over });

// ── The audience ──────────────────────────────────────────────────────────

test("a verifier cannot be built without an audience", () => {
  // The fix, at the only place it cannot be forgotten. Previously this
  // constructed happily and then accepted everything.
  assert.throws(
    () => new JwtVerifier({ issuer: "https://idp.invalid", audience: "" }),
    /an OIDC audience is required/,
  );
  assert.throws(
    () => new JwtVerifier({ issuer: "https://idp.invalid" } as unknown as { issuer: string; audience: string }),
    /every token this issuer has signed is accepted/,
  );
});

test("a token minted for another application at the same issuer is refused", () => {
  return (async () => {
    const i = await idp();
    try {
      const v = verifier(i);
      // Same directory, same signing key, different resource server.
      await assert.rejects(
        () => v.verify(i.mint({ sub: "svc", aud: "expenses-system", scope: "system/Patient.read" })),
        /audience mismatch/,
      );
      // And one that names no audience at all.
      await assert.rejects(
        () => v.verify(i.mint({ sub: "svc", aud: undefined, scope: "system/Patient.read" })),
        /audience mismatch/,
      );
      // An array audience that includes this one is fine, per RFC 7519.
      const ok = await v.verify(i.mint({ sub: "svc", aud: ["expenses-system", AUD], scope: "system/Patient.read" }));
      assert.equal(ok.subject, "svc");
    } finally {
      await i.close();
    }
  })();
});

// ── Signing keys ──────────────────────────────────────────────────────────

test("a token signed by a rotated-away key is refused once the provider drops it", () => {
  return (async () => {
    const i = await idp();
    try {
      const v = verifier(i, { cacheTtlMs: NEVER_CACHE });
      const old = i.mint({ sub: "svc", scope: "system/Patient.read" });
      assert.equal((await v.verify(old)).subject, "svc");

      // The provider rotates and stops serving the old key.
      i.rotate(false);
      await assert.rejects(() => v.verify(old), /no JWKS key for kid key-1/);
    } finally {
      await i.close();
    }
  })();
});

test("overlapping keys during a rotation both verify", () => {
  // The window every provider has. Refusing either would take the site down
  // for the length of the rotation.
  return (async () => {
    const i = await idp();
    try {
      const v = verifier(i, { cacheTtlMs: NEVER_CACHE });
      i.rotate(true);
      const oldKey = i.mint({ sub: "svc-old", scope: "system/Patient.read" });
      const newKey = i.mint({ sub: "svc-new", scope: "system/Patient.read" }, { kid: "key-2", key: i.secondKey });
      assert.equal((await v.verify(oldKey)).subject, "svc-old");
      assert.equal((await v.verify(newKey)).subject, "svc-new");
    } finally {
      await i.close();
    }
  })();
});

test("an unknown kid does not let a caller hammer the provider", () => {
  return (async () => {
    const i = await idp();
    try {
      const v = verifier(i);
      await v.verify(i.mint({ sub: "svc", scope: "system/Patient.read" }));
      const before = i.hits();
      for (let n = 0; n < 5; n++) {
        await assert.rejects(() => v.verify(i.mint({ sub: "x" }, { kid: "not-a-key" })), /no JWKS key/);
      }
      assert.equal(i.hits(), before, "a bogus kid on a fresh cache must not trigger a refetch each time");
    } finally {
      await i.close();
    }
  })();
});

test("an issuer outage fails closed rather than falling back to a stale cache", () => {
  return (async () => {
    const i = await idp();
    try {
      const v = verifier(i, { cacheTtlMs: NEVER_CACHE });
      const token = i.mint({ sub: "svc", scope: "system/Patient.read" });
      assert.equal((await v.verify(token)).subject, "svc");

      // The cache is now stale and the provider is down. A resource server
      // that kept serving on old keys through an outage would keep honouring
      // credentials the provider may have revoked during it.
      i.setDown(true);
      await assert.rejects(() => v.verify(token), /JWKS fetch failed: 503/);
    } finally {
      await i.close();
    }
  })();
});

// ── Algorithm and signature ───────────────────────────────────────────────

test("alg none, and an algorithm the server does not implement, are refused", () => {
  return (async () => {
    const i = await idp();
    try {
      const v = verifier(i);
      for (const alg of ["none", "HS256", "RS1", ""]) {
        await assert.rejects(
          () => v.verify(i.mint({ sub: "attacker", scope: "system/Patient.write" }, { alg })),
          /unsupported alg|signature verification failed/,
          `alg ${alg || "(empty)"} must not verify`,
        );
      }
    } finally {
      await i.close();
    }
  })();
});

test("a tampered payload fails on the signature, not merely on its claims", () => {
  return (async () => {
    const i = await idp();
    try {
      const v = verifier(i);
      const good = i.mint({ sub: "svc", scope: "system/Patient.read" });
      const [h, , sig] = good.split(".");
      const forged = Buffer.from(
        JSON.stringify({ iss: i.issuer, aud: AUD, sub: "attacker", scope: "system/*.write", exp: Math.floor(Date.now() / 1000) + 300 })
      ).toString("base64url");
      await assert.rejects(() => v.verify(`${h}.${forged}.${sig}`), /signature verification failed/);
    } finally {
      await i.close();
    }
  })();
});

// ── Issuer, expiry and scope ──────────────────────────────────────────────

test("a token from a different issuer is refused even when the signature checks out", () => {
  return (async () => {
    const i = await idp();
    try {
      // Same keys, different expected issuer: the mixed-up-issuer case.
      const v = new JwtVerifier({ issuer: "https://other-idp.invalid", audience: AUD, jwksUri: `${i.issuer}/jwks` });
      await assert.rejects(() => v.verify(i.mint({ sub: "svc", scope: "system/Patient.read" })), /issuer mismatch/);
    } finally {
      await i.close();
    }
  })();
});

test("expiry and not-before are enforced, with only the configured skew", () => {
  return (async () => {
    const i = await idp();
    try {
      const v = verifier(i, { clockSkewSec: 30 });
      const now = Math.floor(Date.now() / 1000);
      await assert.rejects(() => v.verify(i.mint({ sub: "x", exp: now - 3600 })), /token expired/);
      await assert.rejects(() => v.verify(i.mint({ sub: "x", nbf: now + 3600 })), /not yet valid/);
      // Just inside the skew still verifies; well outside does not.
      assert.equal((await v.verify(i.mint({ sub: "x", exp: now - 10 }))).subject, "x");
      await assert.rejects(() => v.verify(i.mint({ sub: "x", exp: now - 120 })), /token expired/);
    } finally {
      await i.close();
    }
  })();
});

test("a token cannot claim its way to a scope the issuer did not grant", () => {
  return (async () => {
    const i = await idp();
    try {
      const v = verifier(i);
      const read = await v.verify(i.mint({ sub: "svc", scope: "system/Patient.read" }));
      assert.ok(read.scopes.has("read"));
      assert.ok(!read.scopes.has("write"), "a read token is not a write token");
      assert.ok(!read.scopes.has("admin"), "and it is certainly not an admin token");

      // A patient-compartment token must not become a general read token.
      const patient = await v.verify(i.mint({ sub: "pt-subject", scope: "patient/*.read" }));
      assert.ok(!patient.scopes.has("read"), "patient scope is a separate trust boundary");
    } finally {
      await i.close();
    }
  })();
});

test("tenant, organization and practitioner come from the issuer, never the request", () => {
  return (async () => {
    const i = await idp();
    try {
      const v = verifier(i);
      const t = await v.verify(
        i.mint({ sub: "svc", scope: "system/Patient.read", tenant: "yellowknife", organization: "org-1", practitioner: "dr-tetso" })
      );
      assert.equal(t.tenantId, "yellowknife");
      assert.equal(t.organizationId, "org-1");
      assert.equal(t.practitionerId, "dr-tetso");
    } finally {
      await i.close();
    }
  })();
});

test("launch context is surfaced, and a structured value is not mistaken for an identifier", () => {
  return (async () => {
    const i = await idp();
    try {
      const v = verifier(i);
      const ctx = await v.verify(
        i.mint({ sub: "app", scope: "patient/*.read", patient: "NT123456", encounter: "enc-9", fhirUser: "Practitioner/dr-tetso" })
      );
      assert.equal(ctx.launchPatient, "NT123456");
      assert.equal(ctx.launchEncounter, "enc-9");
      assert.equal(ctx.fhirUser, "Practitioner/dr-tetso");

      // An object where an identifier belongs is dropped, not carried.
      const odd = await v.verify(i.mint({ sub: "app", scope: "patient/*.read", patient: { reference: "Patient/x" } }));
      assert.equal(odd.launchPatient, undefined);
    } finally {
      await i.close();
    }
  })();
});

// ── Nothing sensitive reaches a log or an error ───────────────────────────

test("a refusal never echoes the token, its signature, or its claims", () => {
  return (async () => {
    const i = await idp();
    try {
      const v = verifier(i);
      const token = i.mint({ sub: "svc", aud: "expenses-system", scope: "system/Patient.read", patient: "NT123456" });
      const [header, payload, signature] = token.split(".");
      await assert.rejects(
        () => v.verify(token),
        (err: unknown) => {
          const m = (err as Error).message;
          assert.ok(!m.includes(token), "the token must not appear in the error");
          assert.ok(!m.includes(payload), "nor its payload");
          assert.ok(!m.includes(signature), "nor its signature");
          assert.ok(!m.includes(header), "nor its header");
          assert.ok(!m.includes("NT123456"), "and certainly not a patient identifier from its claims");
          return /audience mismatch/.test(m);
        },
      );
    } finally {
      await i.close();
    }
  })();
});

// ── Discovery ─────────────────────────────────────────────────────────────

test("the SMART configuration is absent when OAuth is not configured", () => {
  assert.equal(new AuthGate({}).smartConfiguration(), undefined);
});

test("the SMART configuration advertises the issuer and only implemented capabilities", () => {
  return (async () => {
    const i = await idp();
    try {
      const gate = new AuthGate({ jwt: verifier(i) });
      const doc = gate.smartConfiguration()!;
      assert.equal(doc.issuer, i.issuer);
      assert.equal(doc.jwks_uri, `${i.issuer}/jwks`);
      assert.deepEqual(doc.code_challenge_methods_supported, ["S256"], "S256 only; plain is not a challenge");

      // Capabilities this server does not implement must not be advertised:
      // a client that reads one here trusts a check that never runs.
      const caps = doc.capabilities as string[];
      for (const absent of ["context-standalone-patient", "context-ehr-patient", "sso-openid-connect", "permission-offline"]) {
        assert.ok(!caps.includes(absent), `${absent} is not implemented and must not be advertised`);
      }
    } finally {
      await i.close();
    }
  })();
});
