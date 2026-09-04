/**
 * The patient portal, end to end, through a real token.
 *
 * The `/patient/*` API was already complete and already tested. What was
 * missing was an application, so what these test is the seam the application
 * needs: a token that the ordinary verifier accepts, arriving at the ordinary
 * boundary, and every way that boundary says no.
 *
 * Nothing here mocks the auth path. A token is minted by the development
 * identity provider, fetched as JWKS over HTTP by `JwtVerifier`, and checked
 * for `kid`, algorithm, signature, issuer, audience and expiry exactly as a
 * token from Entra would be. If the gate stopped enforcing something, these
 * would fail rather than pass against a stub.
 *
 * What these do NOT test is the browser. There is no headless-browser runner
 * in this repository and adding one is a real change to its dependency
 * posture, so the portal document is checked structurally further down and
 * that is said plainly rather than implied to be more.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { Engine } from "../src/core/engine.ts";
import { startApi } from "../src/api/admin.ts";
import { AuthGate } from "../src/auth/gate.ts";
import { JwtVerifier } from "../src/auth/jwt.ts";
import { DevIdentityProvider, devIdpRefusal } from "../src/auth/dev-idp.ts";

const AUDIENCE = "northstar-test";
const PATIENT = "NT123456";
const OTHER = "NT999999";

/** A port nothing is using, so the issuer URL can be built before listening. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const addr = probe.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      probe.close(() => (port ? resolve(port) : reject(new Error("no port"))));
    });
  });
}

async function boot(opts: { tenants?: string[] } = {}) {
  const engine = new Engine({ dbPath: ":memory:", tickMs: 15 });
  await engine.start();
  for (const t of opts.tenants ?? []) engine.db.createTenant(t, t, t);

  const port = await freePort();
  const issuer = `http://127.0.0.1:${port}/dev-idp`;
  const tenantOf = new Map<string, string>();

  const idp = new DevIdentityProvider({
    issuer,
    audience: AUDIENCE,
    liveSubjects: () => {
      const out: Array<{ subject: string; tenantId: string; patients: Array<{ patientId: string; relationship: string }> }> = [];
      for (const tenantId of ["default", ...(opts.tenants ?? [])]) {
        for (const s of engine.forTenant(tenantId).patientAccess.liveSubjects()) {
          out.push({ ...s, tenantId: tenantOf.get(s.subject) ?? tenantId });
        }
      }
      return out;
    },
  });
  const jwt = new JwtVerifier({ issuer, audience: AUDIENCE, jwksUri: `${issuer}/.well-known/jwks.json` });
  const api = await startApi(engine, port, "127.0.0.1", {
    auth: new AuthGate({ keys: engine.keys, jwt, tenants: engine.db }),
    devIdp: idp,
  });

  const base = `http://127.0.0.1:${api.port}`;
  return {
    engine,
    idp,
    base,
    tenantOf,
    /** Signs in the way the portal does: pick a subject, get a token. */
    async signIn(subject: string): Promise<string> {
      const res = await fetch(`${base}/dev-idp/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ subject }),
      });
      const body = (await res.json()) as { access_token?: string; error?: string };
      if (!res.ok) throw new Error(body.error ?? `sign-in failed: ${res.status}`);
      return body.access_token!;
    },
    get: (token: string, path: string) => fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } }),
    post: (token: string, path: string, body: unknown) =>
      fetch(`${base}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    close: async () => {
      await api.close();
      await engine.stop();
    },
  };
}

/** A chart with a released result, a held one, and an appointment. */
function seed(engine: Engine, tenantId = "default", patientId = PATIENT) {
  const t = engine.forTenant(tenantId);
  t.clinical.record({
    entryType: "Patient",
    patientId,
    content: { resourceType: "Patient", identifier: [{ value: patientId }] },
    authorId: "adt",
    authorKind: "device",
  });
  // Unsolicited results, which need no order and are the shorter path to a
  // chart with something on it to read.
  const released = t.orders.report({
    patientId,
    code: "2823-3",
    display: "Potassium",
    value: "4.1",
    unit: "mmol/L",
    reportedBy: "Northern Regional Laboratory",
  });
  const held = t.orders.report({
    patientId,
    code: "36643-5",
    display: "Chest imaging",
    value: "see report",
    reportedBy: "Northern Regional Laboratory",
  });
  t.patientAccess.hold({
    resultId: held.id,
    category: "clinician-will-discuss",
    releaseAt: new Date(Date.now() + 7 * 86400_000).toISOString(),
    reason: "the clinician wants to explain this one first",
    by: { actorId: "dr-tetso", actorKind: "practitioner" },
  });
  return { released, held };
}

test("a patient signs in, reads a released result, and asks a question the clinic receives", async () => {
  // The complete journey this increment exists to make possible.
  const s = await boot();
  try {
    const t = s.engine.forTenant("default");
    seed(s.engine);
    t.patientAccess.grantSelf(PATIENT, "urn:dev:tara", { actorId: "clerk", actorKind: "practitioner" });

    // 1. Sign in. The provider offers only people the clinic has granted.
    const offered = (await (await fetch(`${s.base}/dev-idp/subjects`)).json()) as {
      subjects: Array<{ subject: string; patients: Array<{ patientId: string }> }>;
    };
    assert.deepEqual(offered.subjects.map((x) => x.subject), ["urn:dev:tara"]);
    assert.deepEqual(offered.subjects[0].patients.map((p) => p.patientId), [PATIENT]);
    const token = await s.signIn("urn:dev:tara");

    // 2. The chart picker: which charts, and what may be done with each.
    const auth = (await (await s.get(token, "/patient/authorities")).json()) as {
      authorities: Array<{ patientId: string; relationship: string; permissions: string[] }>;
    };
    assert.equal(auth.authorities.length, 1);
    assert.equal(auth.authorities[0].relationship, "self");
    assert.ok(auth.authorities[0].permissions.includes("results"));

    // 3. Read the released result. The held one is on the same list and
    //    carries no value at all, so a client rendering every field it is
    //    given still cannot show it.
    const results = (await (await s.get(token, `/patient/results?patient=${PATIENT}`)).json()) as Array<
      Record<string, unknown> & { held?: { because: string } }
    >;
    const potassium = results.find((r) => r.display === "Potassium")!;
    assert.equal(potassium.value, "4.1");
    const imaging = results.find((r) => r.display === "Chest imaging")!;
    assert.ok(imaging.held, "the held result must be marked held");
    assert.equal(imaging.value, undefined, "and must carry no value to leak");
    assert.match(imaging.held!.because, /\w/);

    // 4. Ask a question.
    const opened = await s.post(token, "/patient/thread-open", {
      patient: PATIENT,
      subject: "About my potassium",
      body: "Is 4.1 normal? Should I change anything?",
    });
    assert.equal(opened.status, 201);

    // 5. The clinic receives it, in the worklist they already work from.
    const worklist = t.workspace.worklist("dr-tetso");
    const messages = JSON.stringify(worklist);
    assert.match(messages, /About my potassium/, "the question must reach the clinic's worklist");

    // And the chart's access log records the patient's own reads, so the
    // journey is auditable from the patient's side too.
    const log = (await (await s.get(token, `/patient/access-log?patient=${PATIENT}`)).json()) as Array<{
      subject_id: string;
      action: string;
    }>;
    assert.ok(log.some((r) => r.action === "view-results" && r.subject_id === "urn:dev:tara"));
  } finally {
    await s.close();
  }
});

test("a caregiver reaches only the charts and the parts of them they were given", async () => {
  const s = await boot();
  try {
    const t = s.engine.forTenant("default");
    seed(s.engine);
    seed(s.engine, "default", OTHER);
    t.patientAccess.grantSelf(PATIENT, "urn:dev:tara", { actorId: "clerk", actorKind: "practitioner" });
    // A caregiver for one chart, with a narrow grant: appointments only.
    t.patientAccess.grantProxy({
      patientId: PATIENT,
      subjectId: "urn:dev:sam",
      relationship: "representative",
      expiresAt: new Date(Date.now() + 30 * 86400_000).toISOString(),
      permissions: ["appointments"],
      purpose: "driving to appointments",
      by: { actorId: "clerk", actorKind: "practitioner" },
    });

    const token = await s.signIn("urn:dev:sam");
    const auth = (await (await s.get(token, "/patient/authorities")).json()) as {
      authorities: Array<{ patientId: string; permissions: string[] }>;
    };
    // Only the chart they were given, and only what they were given on it.
    assert.deepEqual(auth.authorities.map((a) => a.patientId), [PATIENT]);
    assert.deepEqual(auth.authorities[0].permissions, ["appointments"]);

    assert.equal((await s.get(token, `/patient/appointments?patient=${PATIENT}`)).status, 200);
    // Every capability the grant does not name is refused, not narrowed.
    for (const path of ["results", "summary", "threads", "access-log", "requests", "delegates"]) {
      const res = await s.get(token, `/patient/${path}?patient=${PATIENT}`);
      assert.equal(res.status, 403, `${path} must be refused for a grant that does not include it`);
    }
    // And the other chart is refused entirely, grant or no grant.
    assert.equal((await s.get(token, `/patient/appointments?patient=${OTHER}`)).status, 403);
  } finally {
    await s.close();
  }
});

test("a token from one custodian cannot reach another custodian's chart", async () => {
  const s = await boot({ tenants: ["south"] });
  try {
    // The same person id, enrolled at both sites, on different charts.
    seed(s.engine, "default", PATIENT);
    seed(s.engine, "south", OTHER);
    s.engine.forTenant("default").patientAccess.grantSelf(PATIENT, "urn:dev:north", {
      actorId: "clerk",
      actorKind: "practitioner",
    });
    s.engine.forTenant("south").patientAccess.grantSelf(OTHER, "urn:dev:south", {
      actorId: "clerk",
      actorKind: "practitioner",
    });
    s.tenantOf.set("urn:dev:north", "default");
    s.tenantOf.set("urn:dev:south", "south");

    const north = await s.signIn("urn:dev:north");
    // The token's tenant comes from a claim the issuer controls, never from
    // the request, so naming the southern chart reaches the northern
    // custodian's data and finds nothing to authorise.
    assert.equal((await s.get(north, `/patient/results?patient=${OTHER}`)).status, 403);
    assert.equal((await s.get(north, `/patient/summary?patient=${OTHER}`)).status, 403);

    const authorities = (await (await s.get(north, "/patient/authorities")).json()) as {
      authorities: Array<{ patientId: string }>;
    };
    assert.deepEqual(authorities.authorities.map((a) => a.patientId), [PATIENT]);
  } finally {
    await s.close();
  }
});

test("revoking a caregiver's access takes effect on the next request, not the next login", async () => {
  const s = await boot();
  try {
    const t = s.engine.forTenant("default");
    seed(s.engine);
    const grant = t.patientAccess.grantProxy({
      patientId: PATIENT,
      subjectId: "urn:dev:sam",
      relationship: "representative",
      expiresAt: new Date(Date.now() + 30 * 86400_000).toISOString(),
      permissions: ["appointments", "results"],
      purpose: "helping with appointments",
      by: { actorId: "clerk", actorKind: "practitioner" },
    });

    const token = await s.signIn("urn:dev:sam");
    assert.equal((await s.get(token, `/patient/results?patient=${PATIENT}`)).status, 200);

    // The patient revokes it while the caregiver's tab is still open. The
    // token is still perfectly valid; the authority behind it is not.
    t.patientAccess.revoke(grant.id, {
      actorId: "urn:dev:tara",
      actorKind: "oauth",
      reason: "no longer helping",
    });

    assert.equal((await s.get(token, `/patient/results?patient=${PATIENT}`)).status, 403);
    const after = (await (await s.get(token, "/patient/authorities")).json()) as { authorities: unknown[] };
    assert.deepEqual(after.authorities, [], "and the chart leaves their list");

    // The provider will not mint a new token for them either.
    await assert.rejects(() => s.signIn("urn:dev:sam"), /no live grant/);
  } finally {
    await s.close();
  }
});

test("an expired grant is gone without anybody revoking it", async () => {
  const s = await boot();
  try {
    const t = s.engine.forTenant("default");
    seed(s.engine);
    // Two seconds of access. The expiry is the safeguard, so it has to bite
    // without a sweep, a job, or anybody noticing.
    t.patientAccess.grantProxy({
      patientId: PATIENT,
      subjectId: "urn:dev:sam",
      relationship: "representative",
      expiresAt: new Date(Date.now() + 2000).toISOString(),
      permissions: ["results"],
      purpose: "short-term help",
      by: { actorId: "clerk", actorKind: "practitioner" },
    });
    const token = await s.signIn("urn:dev:sam");
    assert.equal((await s.get(token, `/patient/results?patient=${PATIENT}`)).status, 200);

    await new Promise((r) => setTimeout(r, 2100));
    assert.equal((await s.get(token, `/patient/results?patient=${PATIENT}`)).status, 403);
  } finally {
    await s.close();
  }
});

test("a request that dies in flight leaves nothing half-written", async () => {
  const s = await boot();
  try {
    const t = s.engine.forTenant("default");
    seed(s.engine);
    t.patientAccess.grantSelf(PATIENT, "urn:dev:tara", { actorId: "clerk", actorKind: "practitioner" });
    const token = await s.signIn("urn:dev:tara");

    // Abort while the request is in flight — a dropped satellite link, which
    // is the ordinary condition this is deployed into rather than the
    // exception.
    const controller = new AbortController();
    const inflight = fetch(`${s.base}/patient/thread-open`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ patient: PATIENT, subject: "Dropped", body: "half sent" }),
      signal: controller.signal,
    });
    controller.abort();
    await assert.rejects(() => inflight);

    // Whatever the server managed to do, it did not leave a thread with no
    // access-log row or an access-log row with no thread: both writes share
    // one transaction.
    const threads = t.messaging.forPatient(PATIENT);
    const log = t.patientAccess.accessLog(PATIENT, 100);
    const opens = log.filter((r) => r.action === "open-message-thread" && r.outcome === "allowed");
    assert.equal(threads.length, opens.length, "a thread and its access-log row commit together or not at all");
  } finally {
    await s.close();
  }
});

test("two identical questions are two questions, and the portal is what stops the second", async () => {
  const s = await boot();
  try {
    const t = s.engine.forTenant("default");
    seed(s.engine);
    t.patientAccess.grantSelf(PATIENT, "urn:dev:tara", { actorId: "clerk", actorKind: "practitioner" });
    const token = await s.signIn("urn:dev:tara");

    const body = { patient: PATIENT, subject: "Same question", body: "Sent twice by a double tap" };
    const [a, b] = await Promise.all([
      s.post(token, "/patient/thread-open", body),
      s.post(token, "/patient/thread-open", body),
    ]);
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);

    // Two threads, and that is the honest behaviour of this API today: there
    // is no idempotency key, so the server cannot tell a retry from a second
    // question, and inventing an answer would be worse than saying so. The
    // portal disables its own submit button, which is asserted structurally
    // below; a client that does not is a client that opens two threads.
    assert.equal(t.messaging.forPatient(PATIENT).length, 2);
  } finally {
    await s.close();
  }
});

test("the development provider cannot create authority, and refuses to coexist with a real one", async () => {
  const s = await boot();
  try {
    // Nobody granted, nobody to sign in as.
    const before = (await (await fetch(`${s.base}/dev-idp/subjects`)).json()) as { subjects: unknown[] };
    assert.deepEqual(before.subjects, []);
    await assert.rejects(() => s.signIn("urn:dev:nobody"), /no live grant/);

    // The token endpoint is the only way in, and it will not invent one.
    const res = await s.post("", "/patient/authorities", {});
    assert.equal(res.status, 401);
  } finally {
    await s.close();
  }

  assert.equal(devIdpRefusal({}), "not enabled");
  assert.equal(devIdpRefusal({ devIdp: "on" }), null);
  assert.match(
    devIdpRefusal({ devIdp: "on", oidcIssuer: "https://login.example.gov/tenant" }) ?? "",
    /mutually exclusive/
  );
});

test("a token this provider did not sign is not a patient token", async () => {
  const s = await boot();
  try {
    seed(s.engine);
    s.engine.forTenant("default").patientAccess.grantSelf(PATIENT, "urn:dev:tara", {
      actorId: "clerk",
      actorKind: "practitioner",
    });
    // A second provider, same issuer and audience, different key. The whole
    // point of validating through JWKS is that this fails.
    const impostor = new DevIdentityProvider({
      issuer: s.idp.issuer,
      audience: "northstar-test",
      liveSubjects: () => [{ subject: "urn:dev:tara", tenantId: "default", patients: [] }],
    });
    const forged = impostor.issue("urn:dev:tara").access_token;
    assert.equal((await s.get(forged, "/patient/authorities")).status, 401);

    // And an API key is refused at the patient boundary however it is scoped.
    const key = s.engine.keys.issue("ops", ["admin"]).key;
    assert.equal((await s.get(key, "/patient/authorities")).status, 403);
  } finally {
    await s.close();
  }
});

/* ------------------------------------------------------------------------ */

/**
 * The portal document, read as source.
 *
 * This is not a browser test and must not be read as one. There is no
 * headless-browser runner here, so what follows checks that the properties
 * claimed for the application are present in the file that implements it —
 * which catches a screen that loses its empty state, and does not catch a
 * screen that renders it in the wrong place.
 */
const PORTAL = readFileSync(new URL("../src/api/portal.html", import.meta.url), "utf8");

test("every screen the portal draws has a loading, an error and an empty state", () => {
  const screens = ["Results", "Appointments", "Medications", "Messages", "Team", "Access", "Requests"];
  for (const name of screens) {
    assert.match(PORTAL, new RegExp(`async function screen${name}\\(`), `screen${name} is missing`);
  }
  // One funnel for failures, and it is used by the router for every screen.
  assert.match(PORTAL, /async function guard\(/);
  assert.match(PORTAL, /showLoading\(\)/);
  assert.match(PORTAL, /function showError\(/);
  // Each list screen says something when it has nothing, rather than
  // rendering as though the chart were empty.
  for (const key of ["noResults", "noAppointments", "noMeds", "noTeam", "noAccessLog", "noMessages", "noRequests"]) {
    assert.match(PORTAL, new RegExp(`empty\\("${key}"\\)`), `${key} is never shown`);
  }
});

test("both languages carry every string, so neither falls back silently", () => {
  const block = (lang: string): Set<string> => {
    const start = PORTAL.indexOf(`  ${lang}: {`);
    assert.notEqual(start, -1, `no ${lang} copy block`);
    const end = PORTAL.indexOf("\n  }", start);
    const body = PORTAL.slice(start, end);
    // A key follows the opening brace or a comma. Matching `(\w+):"`
    // anywhere instead reads `covers:` out of the *value* "Your access
    // covers:", and the test then reports a missing French translation for a
    // string that does not exist. Anchoring to the start of a line is the
    // other wrong fix: several of these entries share a line.
    return new Set([...body.matchAll(/[{,]\s*(\w+)\s*:\s*"/g)].map((m) => m[1]));
  };
  const en = block("en");
  const fr = block("fr");
  assert.ok(en.size >= 70, `only ${en.size} strings — the extractor has lost its place`);
  assert.deepEqual([...en].filter((k) => !fr.has(k)), [], "English keys with no French");
  assert.deepEqual([...fr].filter((k) => !en.has(k)), [], "French keys with no English");
});

test("the portal never draws a tab the grant does not cover", () => {
  // A tab that answers 403 teaches a caregiver that the portal is broken
  // rather than that their access is narrower than they thought.
  assert.match(PORTAL, /if \(!a\.permissions\.includes\(tab\.perm\)\) continue;/);
  // And the router refuses to route to one either, so a pasted URL cannot
  // reach a screen the grant does not cover.
  assert.match(PORTAL, /TABS\.find\(\(x\) => x\.id === want && S\.active\.permissions\.includes\(x\.perm\)\)/);
});

test("the portal shows a held result as held, and has no value to show", () => {
  assert.match(PORTAL, /if \(r\.held\)/);
  assert.match(PORTAL, /heldTitle/);
  // The value branch is the else of that, so a held result cannot fall into it.
  const held = PORTAL.indexOf("if (r.held)");
  const value = PORTAL.indexOf("t(\"unitless\")");
  assert.ok(held !== -1 && value > held, "the value branch must come after the held branch returns");
});

test("a submission disables its own button, so a double tap is one question", () => {
  assert.match(PORTAL, /if \(button\.disabled\) return;\s*\n\s*button\.disabled = true;/);
  for (const fn of ["sendNewThread", "sendReply", "sendRequest"]) {
    assert.match(PORTAL, new RegExp(`function ${fn}\\([^)]*\\)\\s*\\{\\s*\\n?\\s*return submitting\\(`), `${fn} does not go through submitting()`);
  }
});

test("a request that never arrives is a sentence, not a spinner", () => {
  // A timeout, so a dropped link ends in a message rather than a page that
  // waits for as long as the operating system will let it.
  assert.match(PORTAL, /new AbortController\(\)/);
  assert.match(PORTAL, /setTimeout\(\(\) => controller\.abort\(\), \d+\)/);
  assert.match(PORTAL, /kind === "expired"/);
  assert.match(PORTAL, /kind === "forbidden"/);
});

test("the portal loads nothing from anywhere else", () => {
  // Satellite and cellular links in the north, and a CDN that is blocked or
  // slow is a blank page. Everything is in the one file.
  assert.ok(!/<script[^>]+src=/i.test(PORTAL), "the portal loads an external script");
  assert.ok(!/<link[^>]+stylesheet/i.test(PORTAL), "the portal loads an external stylesheet");
  assert.ok(!/https?:\/\/(?!127\.0\.0\.1)[a-z]/i.test(PORTAL.replace(/https?:\/\/www\.w3\.org/g, "")),
    "the portal names an external origin");
});

test("the published key set carries the public half and nothing else", async () => {
  // The JWK is derived by exporting the *private* key and keeping `n` and
  // `e`, because Node 22 refuses `export({format:"jwk"})` on an RSA public
  // KeyObject. That is correct — n and e are the public key — and it is one
  // careless spread away from publishing the private exponent to anybody who
  // can reach the discovery endpoint.
  const s = await boot();
  try {
    const jwks = (await (await fetch(`${s.base}/dev-idp/.well-known/jwks.json`)).json()) as {
      keys: Array<Record<string, unknown>>;
    };
    assert.equal(jwks.keys.length, 1);
    const key = jwks.keys[0];
    assert.deepEqual(Object.keys(key).sort(), ["alg", "e", "kid", "kty", "n", "use"]);
    for (const secret of ["d", "p", "q", "dp", "dq", "qi"]) {
      assert.equal(key[secret], undefined, `the key set published ${secret}`);
    }
    // And the whole document, in case a future field carries it another way.
    const raw = JSON.stringify(jwks);
    const priv = s.idp as unknown as { privateKey: { export(o: unknown): Record<string, string> } };
    const full = priv.privateKey.export({ format: "jwk" });
    assert.ok(!raw.includes(full.d), "the private exponent is in the published key set");
  } finally {
    await s.close();
  }
});
