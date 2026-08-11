/**
 * The clinical platform over HTTP, and the trail it must leave.
 *
 * Section 18 wants every access to patient data on an audit trail. The stores
 * built for sections 1 through 9 were libraries — nothing reached them over a
 * network, so nothing went unrecorded. Exposing them is the moment that
 * changes, and an audit guarantee that depends on each new route remembering
 * to call `audit()` is one that holds until the fiftieth route.
 *
 * So the load-bearing test is the last one. It reads the routing source,
 * extracts every clinical path, drives each, and fails if any of them serves
 * patient data without leaving a row. A route added tomorrow with no trail
 * does not quietly work — it breaks the build.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Engine } from "../src/core/engine.ts";
import { startApi } from "../src/api/admin.ts";
import { AuthGate } from "../src/auth/gate.ts";
import type { AuditRow } from "../src/audit/store.ts";

const P = "NT123456";
const GP = { actorId: "dr-tetso", actorKind: "practitioner" };
const GP_AUTHOR = { authorId: "dr-tetso", authorKind: "practitioner" };

async function boot() {
  const engine = new Engine({ dbPath: ":memory:", tickMs: 15 });
  await engine.start();
  const adminKey = engine.keys.issue("ops", ["admin"]);
  const admin = adminKey.key;
  const reader = engine.keys.issue("consumer", ["read"]).key;
  const api = await startApi(engine, 0, "127.0.0.1", { auth: new AuthGate({ keys: engine.keys }) });
  const base = `http://127.0.0.1:${api.port}`;

  const t = engine.forTenant("default");
  t.clinical.record({
    entryType: "Patient",
    patientId: P,
    content: {
      resourceType: "Patient",
      identifier: [{ system: "urn:jhn", value: P }],
      name: [{ family: "Beaulieu", given: ["Marie"], use: "official" }],
      birthDate: "1984-03-17",
    },
    authorId: "adt-feed",
    authorKind: "device",
  });
  t.meds.recordAllergy({ patientId: P, display: "Penicillin", ingredient: "penicillin", criticality: "high", by: GP });
  t.meds.record({
    patientId: P,
    code: "860975",
    display: "Metformin 500mg",
    ingredient: "metformin",
    source: "prescribed",
    adherence: "taking",
    by: GP,
  });
  const order = t.orders.create({
    patientId: P,
    category: "lab",
    code: "2823-3",
    display: "Potassium",
    indication: "Electrolyte check",
    by: GP,
  });
  t.orders.place(order.id, { ...GP, responsibleId: "dr-tetso" });
  t.orders.report({
    patientId: P,
    orderId: order.id,
    code: "2823-3",
    display: "Potassium",
    value: "7.1",
    abnormalFlag: "critical-high",
    reportedBy: "analyser",
  });
  const ref = t.referrals.create({
    patientId: P,
    fromService: "Primary Care",
    toService: "Nephrology",
    indication: "Rising potassium",
    by: GP,
  });
  t.referrals.send(ref.id, { ...GP, respondBy: "2020-01-01T00:00:00Z" });
  t.tasks.create({ kind: "result-review", title: "Review potassium", by: GP, patientId: P, ownerId: "dr-tetso" });
  const note = t.notes.draft({ patientId: P, noteType: "SOAP", sections: { plan: "Repeat" }, author: GP_AUTHOR });
  t.notes.sign(note.record_id, GP_AUTHOR);

  return {
    engine,
    base,
    admin,
    adminId: adminKey.id,
    reader,
    get: (p: string, key = admin) => fetch(`${base}${p}`, { headers: { authorization: `Bearer ${key}` } }),
    trail: () => engine.forTenant("default").audit.list({ limit: 500 }) as AuditRow[],
    close: async () => {
      await api.close();
      await engine.stop();
    },
  };
}

test("the assembled chart is served, and the read is on the trail", async () => {
  const s = await boot();
  try {
    const before = s.trail().length;
    const res = await s.get(`/api/clinical/chart?patient=${P}`);
    assert.equal(res.status, 200);
    const chart = (await res.json()) as { allergyStatus: string; medications: { items: unknown[] }; complete: boolean };

    assert.equal(chart.allergyStatus, "documented");
    assert.equal(chart.medications.items.length, 1);
    assert.equal(chart.complete, true);

    const rows = s.trail();
    assert.equal(rows.length, before + 1, "one read, one row");
    assert.equal(rows[0].patient, P, "and it names who was looked at");
    assert.equal(rows[0].action, "R");
    assert.equal(rows[0].principal_id, s.adminId, "the credential that looked, not a label");
    assert.equal(rows[0].path, "/api/clinical/chart");
  } finally {
    await s.close();
  }
});

test("a search that finds nobody is still an access", async () => {
  // "Who did you look for" is a question a privacy review asks, and a
  // fruitless search for a well-known name is exactly the one it asks about.
  const s = await boot();
  try {
    const before = s.trail().length;
    const res = await s.get("/api/clinical/patients?family=Trudeau");
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), []);

    const rows = s.trail();
    assert.equal(rows.length, before + 1, "nothing found, and the looking is recorded");
    assert.equal(rows[0].resource_type, "Patient");
    assert.equal(rows[0].count, 0);
  } finally {
    await s.close();
  }
});

test("the allergy endpoint carries the three-valued status, not a bare list", async () => {
  const s = await boot();
  try {
    const res = await s.get(`/api/clinical/allergies?patient=${P}`);
    const body = (await res.json()) as { status: string; allergies: unknown[] };
    assert.equal(body.status, "documented");
    assert.equal(body.allergies.length, 1);

    const other = await s.get("/api/clinical/allergies?patient=NT999");
    const none = (await other.json()) as { status: string; allergies: unknown[] };
    assert.equal(none.allergies.length, 0);
    assert.equal(none.status, "never-asked", "an empty list is not an answer, and the wire says so");
  } finally {
    await s.close();
  }
});

test("the safety check runs over the wire and is audited as a read of the patient", async () => {
  const s = await boot();
  try {
    const before = s.trail().length;
    const res = await fetch(`${s.base}/api/clinical/safety-check`, {
      method: "POST",
      headers: { authorization: `Bearer ${s.admin}`, "content-type": "application/json" },
      body: JSON.stringify({ patient: P, ingredient: "amoxicillin", display: "Amoxicillin 500mg" }),
    });
    assert.equal(res.status, 200);
    const check = (await res.json()) as { clear: boolean; blocking: Array<{ kind: string; severity: string }> };
    assert.equal(check.clear, false);
    assert.equal(check.blocking[0].kind, "allergy");
    assert.equal(check.blocking[0].severity, "contraindicated");

    const rows = s.trail();
    assert.equal(rows.length, before + 1);
    assert.equal(rows[0].patient, P, "consulting a patient's allergies is reading their record");
    assert.match(rows[0].detail ?? "", /safety check: amoxicillin/);
  } finally {
    await s.close();
  }
});

test("the clinical routes need admin, and a refused reach is itself recorded", async () => {
  const s = await boot();
  try {
    const before = s.trail().length;
    const res = await s.get(`/api/clinical/chart?patient=${P}`, s.reader);
    assert.equal(res.status, 403, "a facade read scope is not a licence to open charts");

    const rows = s.trail();
    assert.equal(rows.length, before + 1, "a rejected reach for a patient record is what a trail exists to show");
    assert.notEqual(rows[0].outcome, 0);

    const anon = await fetch(`${s.base}/api/clinical/chart?patient=${P}`);
    assert.equal(anon.status, 401);
  } finally {
    await s.close();
  }
});

test("one custodian's clinical API cannot reach another's charts", async () => {
  const engine = new Engine({ dbPath: ":memory:", tickMs: 15 });
  await engine.start();
  engine.db.createTenant("north", "Northern Health");
  engine.db.createTenant("south", "Southern Health");
  const north = engine.forTenant("north");
  north.meds.recordAllergy({
    patientId: P,
    display: "Penicillin",
    ingredient: "penicillin",
    criticality: "high",
    by: GP,
  });
  const southKey = engine.forTenant("south").keys.issue("south-ops", ["admin"]).key;
  const api = await startApi(engine, 0, "127.0.0.1", { auth: new AuthGate({ keys: engine.keys }) });
  try {
    const res = await fetch(`http://127.0.0.1:${api.port}/api/clinical/allergies?patient=${P}`, {
      headers: { authorization: `Bearer ${southKey}` },
    });
    const body = (await res.json()) as { status: string; allergies: unknown[] };
    assert.equal(body.allergies.length, 0);
    assert.equal(body.status, "never-asked", "not 'documented' — the allergy is the north's");

    // And the attempt is on the south's trail, not the north's.
    assert.equal(engine.forTenant("south").audit.list({ limit: 10 })[0].patient, P);
    assert.equal(engine.forTenant("north").audit.count(), 0);
  } finally {
    await api.close();
    await engine.stop();
  }
});

test("every clinical route leaves an audit row, including ones added later", async () => {
  // The load-bearing test. An audit guarantee that depends on each new route
  // remembering to call audit() is one that holds until somebody forgets, and
  // the forgetting is invisible — the route works, the data is served, and
  // nothing says the trail is short.
  //
  // So the routes are discovered by reading the source rather than listed
  // here. A path added to admin.ts is a path this drives, and if it answers
  // 200 without recording anything, this fails.
  const source = readFileSync(new URL("../src/api/admin.ts", import.meta.url), "utf8");
  const paths = [...new Set([...source.matchAll(/path === "(\/api\/clinical\/[a-z-]+)"/g)].map((m) => m[1]))];
  assert.ok(paths.length >= 16, `expected the clinical routes to be found by scanning, got ${paths.length}`);

  const s = await boot();
  try {
    // Arguments good enough for each route to do real work. A route that
    // needs one not listed here 400s, which this treats as a failure rather
    // than a pass — an untested route is the thing being guarded against.
    const args: Record<string, string> = {
      "/api/clinical/chart": `?patient=${P}`,
      "/api/clinical/worklist": "?clinician=dr-tetso",
      "/api/clinical/patients": "?family=Beaulieu",
      "/api/clinical/medications": `?patient=${P}`,
      "/api/clinical/allergies": `?patient=${P}`,
      "/api/clinical/results": "",
      "/api/clinical/orders": `?patient=${P}`,
      "/api/clinical/referrals": "",
      "/api/clinical/tasks": "?owner=dr-tetso",
      "/api/clinical/notes": `?patient=${P}`,
      "/api/clinical/appointments": `?patient=${P}`,
      "/api/clinical/missed": "",
      "/api/clinical/directives": `?patient=${P}`,
      "/api/clinical/safety-check": "POST",
      "/api/clinical/break-glass": "POST",
      "/api/clinical/gaps": "POST",
      "/api/clinical/measure": "POST",
    };

    /** The body each POST route needs to do real work. */
    const bodies: Record<string, unknown> = {
      "/api/clinical/safety-check": { patient: P, ingredient: "amoxicillin" },
      "/api/clinical/break-glass": {
        patient: P,
        reason: "unconscious, no collateral history, need allergy status before induction",
      },
      "/api/clinical/gaps": {
        cohort: { id: "dm", name: "Diabetes", conditionCodes: ["diabetes"] },
        gap: { id: "hba1c", name: "HbA1c yearly", withinDays: 365, satisfiedByResultCodes: ["4548-4"] },
      },
      "/api/clinical/measure": {
        cohort: { id: "dm", name: "Diabetes", conditionCodes: ["diabetes"] },
        measure: { id: "hba1c-8", name: "HbA1c under 8", withinDays: 365, target: { code: "4548-4", below: 8 } },
      },
    };

    const unlisted = paths.filter((p) => !(p in args));
    assert.deepEqual(unlisted, [], "a clinical route with no case here is one nothing has driven");

    for (const p of paths) {
      const before = s.trail().length;
      const res =
        args[p] === "POST"
          ? await fetch(`${s.base}${p}`, {
              method: "POST",
              headers: { authorization: `Bearer ${s.admin}`, "content-type": "application/json" },
              body: JSON.stringify(bodies[p]),
            })
          : await s.get(`${p}${args[p]}`);

      assert.ok(res.ok, `${p} did not serve: ${res.status} ${await res.text()}`);
      assert.equal(s.trail().length, before + 1, `${p} served patient data without leaving an audit row`);
      const row = s.trail()[0];
      assert.equal(row.path, p);
      assert.ok(row.resource_type, `${p} recorded no resource type`);
    }
  } finally {
    await s.close();
  }
});

test("a patient directive stops the chart at the API, and the refusal is on the trail", () => {
  // A lockbox the chart API ignores is worse than no lockbox, because the
  // system now claims to honour patient directives. This is what makes the
  // claim true: the check is inside phi(), so it covers every route that
  // names a patient rather than the ones somebody remembered.
  return (async () => {
    const s = await boot();
    try {
      const t = s.engine.forTenant("default");
      t.consent.record({
        patientId: P,
        kind: "withhold-all",
        by: { actorId: "privacy-office", actorKind: "practitioner" },
        reason: "patient asked",
      });

      const before = s.trail().length;
      const res = await s.get(`/api/clinical/chart?patient=${P}`);
      assert.equal(res.status, 403);
      const body = (await res.json()) as { error: string; breakGlass: string };
      assert.match(body.error, /withheld by a patient directive/);
      assert.ok(!body.error.includes("patient asked"), "the caller learns that, not why");
      assert.match(body.breakGlass, /break-glass/, "and is told how to declare an emergency");

      const row = s.trail()[0];
      assert.equal(s.trail().length, before + 1, "a directive that stopped somebody is what a privacy office wants to see");
      assert.equal(row.patient, P);
      assert.notEqual(row.outcome, 0);
      assert.match(row.detail ?? "", /withheld by patient directive/);

      // Every patient-scoped route, not just the chart.
      for (const p of ["medications", "allergies", "orders", "notes", "appointments"]) {
        assert.equal((await s.get(`/api/clinical/${p}?patient=${P}`)).status, 403, `${p} honoured the directive`);
      }
    } finally {
      await s.close();
    }
  })();
});

test("declaring an emergency opens the record, and everything about it is recorded", () => {
  return (async () => {
    const s = await boot();
    try {
      const t = s.engine.forTenant("default");
      t.consent.record({ patientId: P, kind: "withhold-all", by: { actorId: "privacy-office", actorKind: "practitioner" } });
      assert.equal((await s.get(`/api/clinical/chart?patient=${P}`)).status, 403);

      // A word is not a reason, over the wire as much as in the store.
      const thin = await fetch(`${s.base}/api/clinical/break-glass`, {
        method: "POST",
        headers: { authorization: `Bearer ${s.admin}`, "content-type": "application/json" },
        body: JSON.stringify({ patient: P, reason: "emergency" }),
      });
      assert.equal(thin.status, 400);
      assert.equal((await s.get(`/api/clinical/chart?patient=${P}`)).status, 403, "and it opened nothing");

      const declared = await fetch(`${s.base}/api/clinical/break-glass`, {
        method: "POST",
        headers: { authorization: `Bearer ${s.admin}`, "content-type": "application/json" },
        body: JSON.stringify({
          patient: P,
          reason: "unconscious, no collateral history, need allergy status before induction",
        }),
      });
      assert.equal(declared.status, 201);

      const opened = await s.get(`/api/clinical/chart?patient=${P}`);
      assert.equal(opened.status, 200, "the lockbox is survivable, which is the point of it being one");

      // Declared, reasoned, queued for notification, queued for review.
      const pending = t.consent.pendingReview();
      assert.equal(pending.length, 1);
      assert.match(pending[0].reason, /before induction/);
      assert.equal(pending[0].subject_id, s.adminId);
      assert.equal(t.consent.pendingNotification().length, 1, "and the patient has not been told yet");

      // The declaration is on the trail before anything was read under it.
      const trail = t.audit.list({ limit: 50 });
      const declaration = trail.find((r) => (r.detail ?? "").startsWith("break-glass declared"));
      assert.ok(declaration, "declaring is itself an event, not just a precondition");
      assert.equal(declaration.patient, P);
    } finally {
      await s.close();
    }
  })();
});

test("a patient can always see the directives standing on their own record", () => {
  // Deliberately outside the withholding check. Refusing to show somebody the
  // directive that stopped them leaves them unable to tell a lockbox from an
  // empty chart, which is the ambiguity the whole design refuses elsewhere.
  return (async () => {
    const s = await boot();
    try {
      const t = s.engine.forTenant("default");
      t.consent.record({
        patientId: P,
        kind: "withhold-from-provider",
        targetId: s.adminId,
        by: { actorId: "privacy-office", actorKind: "practitioner" },
      });

      assert.equal((await s.get(`/api/clinical/chart?patient=${P}`)).status, 403);
      const res = await s.get(`/api/clinical/directives?patient=${P}`);
      assert.equal(res.status, 200, "the directive itself is visible to the person it withholds from");
      const rows = (await res.json()) as Array<{ kind: string }>;
      assert.equal(rows.length, 1);
      assert.equal(rows[0].kind, "withhold-from-provider");
    } finally {
      await s.close();
    }
  })();
});

test("every patient-scoped clinical route consults the directive check", () => {
  // The structural half. phi() is where the check lives, so a route that
  // serves one patient's data without going through phi() has bypassed it —
  // and would work, and serve the record, and say nothing.
  const source = readFileSync(new URL("../src/api/admin.ts", import.meta.url), "utf8");
  const clinical = source.slice(source.indexOf('path.startsWith("/api/clinical/")'));
  const end = clinical.indexOf('return send(res, 404, { error: "not found" });');
  const block = clinical.slice(0, end);

  // Routes that require a patient, found by reading the guard each one uses.
  const patientScoped = [...block.matchAll(/path === "(\/api\/clinical\/[a-z-]+)"[\s\S]{0,200}?patient required/g)].map(
    (m) => m[1]
  );
  assert.ok(patientScoped.length >= 6, `expected patient-scoped routes to be found, got ${patientScoped.length}`);

  for (const route of patientScoped) {
    const i = block.indexOf(`path === "${route}"`);
    const next = block.indexOf('if (path === "', i + 10);
    const body = block.slice(i, next === -1 ? undefined : next);
    assert.ok(
      /\bphi\(/.test(body) || /consent\./.test(body),
      `${route} serves one patient's data without going through phi() or consulting consent directly`
    );
  }
});
