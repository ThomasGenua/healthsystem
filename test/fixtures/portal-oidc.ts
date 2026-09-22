/** Loopback-only, synthetic OIDC provider for HTTP and real-browser login tests. */
import { createServer } from "node:http";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { Engine } from "../../src/core/engine.ts";
import { startApi } from "../../src/api/admin.ts";
import { AuthGate } from "../../src/auth/gate.ts";
import { JwtVerifier } from "../../src/auth/jwt.ts";
import { PortalLogin, type PortalLoginConfig } from "../../src/auth/portal-login.ts";

export async function portalFixture(options: {
  idClaims?: Record<string, unknown>; accessClaims?: Record<string, unknown>;
  metadata?: Record<string, unknown>; tokenError?: boolean; tokenRedirect?: boolean;
} = {}) {
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const codes = new Map<string, URLSearchParams>();
  let exchanges = 0;
  let issuer = "";
  let base = "";
  const mint = (claims: Record<string, unknown>) => {
    const header = b64({ alg: "RS256", kid: "fixture" });
    const body = b64({ iss: issuer, sub: "synthetic-patient", iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600, ...claims });
    return `${header}.${body}.${sign("sha256", Buffer.from(`${header}.${body}`), keys.privateKey).toString("base64url")}`;
  };
  const idp = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url!, issuer);
      const json = (data: unknown) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
      if (url.pathname === "/.well-known/openid-configuration") return json({
        issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`,
        code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["client_secret_basic"], ...options.metadata,
      });
      if (url.pathname === "/jwks") return json({ keys: [{ ...keys.publicKey.export({ format: "jwk" }), kid: "fixture", alg: "RS256", use: "sig" }] });
      if (url.pathname === "/authorize") {
        const p = url.searchParams;
        if (p.get("redirect_uri") !== `${base}/auth/portal/callback` || p.get("client_id") !== "portal" ||
            p.get("response_type") !== "code" || p.get("code_challenge_method") !== "S256" || !p.get("nonce") || !p.get("state")) {
          res.writeHead(400).end(); return;
        }
        const code = randomUUID(); codes.set(code, p);
        const target = new URL(p.get("redirect_uri")!);
        target.searchParams.set("code", code); target.searchParams.set("state", p.get("state")!); target.searchParams.set("iss", issuer);
        res.writeHead(303, { location: target.href }); res.end(); return;
      }
      if (url.pathname === "/token") {
        exchanges++;
        if (options.tokenError) { res.writeHead(503).end("secret-provider-error"); return; }
        if (options.tokenRedirect) { res.writeHead(307, { location: `${issuer}/stolen` }).end(); return; }
        let text = ""; for await (const chunk of req) text += chunk;
        const form = new URLSearchParams(text);
        const p = codes.get(form.get("code")!); codes.delete(form.get("code")!);
        if (!p || req.headers.authorization !== `Basic ${Buffer.from("portal:fixture-secret").toString("base64")}` ||
            form.get("grant_type") !== "authorization_code" || form.get("redirect_uri") !== p.get("redirect_uri") ||
            createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url") !== p.get("code_challenge")) {
          res.writeHead(400).end(); return;
        }
        return json({ token_type: "Bearer", expires_in: 3600,
          access_token: mint({ aud: "northstar", scope: "patient/*.read", ...options.accessClaims }),
          id_token: mint({ aud: "portal", nonce: p.get("nonce"), ...options.idClaims }),
        });
      }
      res.writeHead(404).end();
    })().catch(() => { res.writeHead(500).end(); });
  });
  await new Promise<void>(r => idp.listen(0, "127.0.0.1", r));
  issuer = `http://127.0.0.1:${(idp.address() as { port: number }).port}`;
  const probe = createServer();
  await new Promise<void>(r => probe.listen(0, "127.0.0.1", r));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>(r => probe.close(() => r()));
  base = `http://127.0.0.1:${port}`;
  const engine = new Engine({ dbPath: ":memory:", tickMs: 15 });
  await engine.start();
  const tenant = engine.forTenant("default");
  const actor = { actorId: "fixture-clerk", actorKind: "practitioner" };
  for (const patientId of ["PATIENT-A", "PATIENT-B"]) {
    tenant.clinical.record({ entryType: "Patient", patientId, content: { resourceType: "Patient", identifier: [{ value: patientId }] },
      authorId: actor.actorId, authorKind: actor.actorKind });
  }
  const grant = tenant.patientAccess.grantSelf("PATIENT-A", "synthetic-patient", actor);
  tenant.orders.report({ patientId: "PATIENT-A", code: "2823-3", display: "Potassium", value: "4.1", unit: "mmol/L", reportedBy: "Synthetic lab" });
  const held = tenant.orders.report({ patientId: "PATIENT-A", code: "held", display: "Held report", value: "SECRET-HELD-VALUE", reportedBy: "Synthetic lab" });
  tenant.patientAccess.hold({ resultId: held.id, category: "clinician-will-discuss", reason: "Review with clinician",
    releaseAt: new Date(Date.now() + 86400_000).toISOString(), by: actor });
  const config: PortalLoginConfig = { issuer, clientId: "portal", clientSecret: "fixture-secret", origin: base,
    audience: "northstar", scopes: "openid patient/*.read", allowLoopbackHttp: true };
  const login = new PortalLogin(config);
  const api = await startApi(engine, port, "127.0.0.1", {
    auth: new AuthGate({ jwt: new JwtVerifier({ issuer, audience: "northstar", jwksUri: `${issuer}/jwks` }), tenants: engine.db }),
    portalLogin: login, rateLimit: { enabled: false },
  });
  return { engine, base, issuer, config, login, grant, actor, mint, get exchanges() { return exchanges; },
    close: async () => { await api.close(); await engine.stop(); await new Promise<void>(r => idp.close(() => r())); },
  };
}

/**
 * A questionnaire and some upcoming appointments, for the intake journey.
 *
 * Separate from `portalFixture()` rather than folded into it: the login and
 * results journey does not need a schedule, and a fixture that seeds
 * everything makes every test pay for the setup of every other one. Hours
 * are relative to now, so "upcoming" stays upcoming however long the suite
 * takes to reach this test.
 */
export function seedIntake(
  engine: Engine,
  opts: { patientId: string; hoursAhead: number[]; resourceId?: string }
): { questionnaireId: string; appointmentIds: string[] } {
  const tenant = engine.forTenant("default");
  const by = { actorId: "fixture-clerk", actorKind: "practitioner" };
  const existing = tenant.questionnaires.get("pre-visit");
  if (!existing) {
    tenant.questionnaires.publish({
      id: "pre-visit",
      title: "Pre-visit check-in",
      questions: [
        { key: "fasting", label: "Have you fasted for 8 hours?", type: "boolean", required: true },
        { key: "notes", label: "Anything else we should know?", type: "text" },
      ],
      by,
    });
  }
  const appointmentIds = opts.hoursAhead.map((hours, index) => {
    const startsAt = new Date(Date.now() + hours * 3600_000).toISOString();
    const slot = tenant.schedule.openSlot({
      resourceId: opts.resourceId ?? "dr-okpik",
      resourceKind: "practitioner",
      service: index === 0 ? "Family practice" : "Diabetes clinic",
      startsAt,
      endsAt: new Date(Date.parse(startsAt) + 1800_000).toISOString(),
    });
    return tenant.schedule.book({ slotId: slot.id, patientId: opts.patientId, reason: "Follow-up", by }).id;
  });
  return { questionnaireId: "pre-visit", appointmentIds };
}

export function responseCookie(response: Response, name: string): string {
  return response.headers.getSetCookie().find(c => c.startsWith(`${name}=`))?.split(";")[0] ?? "";
}
export async function beginLogin(base: string) {
  const start = await fetch(`${base}/auth/portal/login`, { redirect: "manual" });
  const binding = responseCookie(start, "northstar-login");
  if (start.status !== 303) throw new Error(`login start returned ${start.status}`);
  const authorization = await fetch(start.headers.get("location")!, { redirect: "manual" });
  return { binding, callback: authorization.headers.get("location")!, authorizationUrl: start.headers.get("location")! };
}
export async function finishLogin(base: string) {
  const pending = await beginLogin(base);
  const response = await fetch(pending.callback, { redirect: "manual", headers: { cookie: pending.binding } });
  const session = responseCookie(response, "northstar-session");
  const info = await (await fetch(`${base}/auth/portal`, { headers: { cookie: session } })).json() as { authenticated: boolean; csrf: string };
  return { ...pending, response, session, info };
}
