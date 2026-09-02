/**
 * What the engine says outside the record.
 *
 * The audit trail, the message pipeline and the chart are all places a
 * patient's data belongs: tenant-scoped, access-controlled, and useless
 * without the detail. Everything else the process emits — stdout, an HTTP
 * error body, a Prometheus scrape, a filename on a backup volume — is
 * collected by systems nobody treats as holding PHI, and a copy that lands
 * there is a copy outside every control the record has.
 *
 * The leak was never a deliberate log line. It was `throw new Error(...)`
 * in a store, with the store's input interpolated into the message because
 * that made the message useful; `mapStoreError` classified it as a fault,
 * and a fault printed its message. `${open.length} medication(s) still
 * undecided: ${names}` reached the operator's log every time somebody tried
 * to finish a reconciliation early.
 *
 * So these pin the boundary rather than the individual messages: a fault
 * says where, never what, and hands out an id that reaches the trail row
 * that says what.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { Engine } from "../src/core/engine.ts";
import { startApi } from "../src/api/admin.ts";
import { AuthGate } from "../src/auth/gate.ts";
import { faultLine, mapStoreError, Refusal, routeArea } from "../src/core/refusal.ts";

/** A patient identifier and a drug name, distinctive enough to grep for. */
const PATIENT = "NT123456";
const DRUG = "amlodipine 5 mg";

function captureErr(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]): void => {
    lines.push(args.map((a) => String(a)).join(" "));
  };
  return { lines, restore: () => (console.error = original) };
}

test("a fault line names the class and the code path, never the message", () => {
  const err = new Error(`2 medication(s) still undecided: ${DRUG} for ${PATIENT}`);
  const mapped = mapStoreError(err);
  assert.ok(mapped.faultId, "a fault is issued an id");

  const line = faultLine(mapped.faultId, err);
  assert.ok(!line.includes(DRUG), `the drug reached the log: ${line}`);
  assert.ok(!line.includes(PATIENT), `the patient reached the log: ${line}`);
  assert.ok(line.includes(mapped.faultId), "and the id that reaches the trail is in it");
  assert.match(line, /\bError\b/, "the class is what is left to say");
  assert.match(line, /at .*data-minimisation\.test\.ts/, "with the frame that raised it");

  // The message is not destroyed, only relocated: the trail row keeps it,
  // behind the same id, because an operator holding a fault id has to be
  // able to find out what actually happened.
  assert.ok(mapped.detail.includes(DRUG));
  assert.ok(mapped.detail.includes(mapped.faultId));
});

test("a refusal has no fault id and prints nothing", () => {
  const mapped = mapStoreError(new Refusal(`${DRUG} is already on the list`, 409));
  assert.equal(mapped.status, 409);
  assert.equal(mapped.outcome, 4);
  assert.equal(mapped.faultId, undefined, "nothing to correlate: there is no hidden half");
});

test("routeArea keeps the area and drops every identifier after it", () => {
  // The router's own paths carry ids: `/fhir/Patient/<id>` and
  // `/api/keys/<key>/rotate`. Two segments name the area; anything past
  // them would be somebody's identifier under a format this cannot know.
  assert.equal(routeArea(`/fhir/Patient/${PATIENT}`), "/fhir/Patient");
  assert.equal(routeArea("/api/keys/abcdef0123/rotate"), "/api/keys");
  assert.equal(routeArea(`/patient/${PATIENT}/summary`), "/patient", "the portal names the patient at depth one");
  assert.equal(routeArea("/ingest/lab-feed"), "/ingest");
  assert.equal(routeArea("/api/clinical/encounter-open"), "/api/clinical");
  assert.equal(routeArea("/metrics"), "/metrics");
  assert.equal(routeArea("/"), "/");
  for (const path of [`/fhir/Patient/${PATIENT}`, `/patient/${PATIENT}/summary`, `/fhir/Observation/${PATIENT}-1`]) {
    assert.ok(!routeArea(path).includes(PATIENT), `${path} kept its identifier`);
  }
});

async function boot() {
  const engine = new Engine({ dbPath: ":memory:", tickMs: 15 });
  await engine.start();
  const admin = engine.keys.issue("ops", ["admin"]).key;
  const gate = new AuthGate({ keys: engine.keys });
  const api = await startApi(engine, 0, "127.0.0.1", { auth: gate });
  const t = engine.forTenant("default");
  t.clinical.record({
    entryType: "Patient",
    patientId: PATIENT,
    content: { resourceType: "Patient", identifier: [{ value: PATIENT }] },
    authorId: "adt",
    authorKind: "device",
  });
  return {
    engine,
    t,
    gate,
    admin,
    base: `http://127.0.0.1:${api.port}`,
    close: async () => {
      await api.close();
      await engine.stop();
    },
  };
}

test("a fault log does not echo the request body, and its id reaches the trail row", async () => {
  const s = await boot();
  const cap = captureErr();
  try {
    // A store that interpolates its input into the exception message — the
    // shape the two real leaks had, rather than a contrived string.
    const original = s.t.encounters.open.bind(s.t.encounters);
    s.t.encounters.open = (input: { patientId?: string; reason?: string }) => {
      throw new Error(`cannot open an encounter for ${input.patientId} about ${input.reason} while ${DRUG} is held`);
    };
    try {
      const res = await fetch(`${s.base}/api/clinical/encounter-open`, {
        method: "POST",
        headers: { authorization: `Bearer ${s.admin}`, "content-type": "application/json" },
        body: JSON.stringify({ patient: PATIENT, class: "in-person", reason: "chest pain on exertion" }),
      });
      assert.equal(res.status, 500);
      const body = (await res.json()) as { error: string; faultId?: string };

      // The caller is told it broke and given the one string that is safe to
      // quote back at an operator.
      assert.equal(body.error, "internal error");
      assert.ok(body.faultId, "and an id to report");
      const raw = JSON.stringify(body);
      assert.ok(!raw.includes(PATIENT), "the body echoed the patient");
      assert.ok(!raw.includes("chest pain"), "the body echoed the request");
      assert.ok(!raw.includes(DRUG), "the body echoed the store's message");

      // The log gets the same id and nothing else about the request.
      const faults = cap.lines.filter((l) => l.includes("fault "));
      assert.equal(faults.length, 1, `expected one fault line, got ${JSON.stringify(cap.lines)}`);
      assert.ok(faults[0].includes(body.faultId!), "the log and the caller name the same fault");
      assert.ok(!faults[0].includes(PATIENT), `the log echoed the patient: ${faults[0]}`);
      assert.ok(!faults[0].includes("chest pain"), `the log echoed the request: ${faults[0]}`);
      assert.ok(!faults[0].includes(DRUG), `the log echoed the store's message: ${faults[0]}`);

      // And the trail — which holds PHI by design — keeps the whole thing,
      // reachable from the id the caller was given.
      const row = s.t.audit.list({ limit: 1 })[0];
      assert.equal(row.outcome, 8);
      assert.ok((row.detail ?? "").includes(body.faultId!));
      assert.ok((row.detail ?? "").includes("chest pain"), "the trail lost the detail");
    } finally {
      s.t.encounters.open = original;
    }
  } finally {
    cap.restore();
    await s.close();
  }
});

test("a refused request is not logged at all", async () => {
  const s = await boot();
  const cap = captureErr();
  try {
    const res = await fetch(`${s.base}/api/clinical/encounter-open`, {
      method: "POST",
      headers: { authorization: `Bearer ${s.admin}`, "content-type": "application/json" },
      body: JSON.stringify({ patient: PATIENT, class: "teleport", reason: "chest pain on exertion" }),
    });
    assert.equal(res.status, 400);
    // A decision is not an incident. It is on the trail, with the patient it
    // was about, and the operator's log has no reason to carry either.
    assert.deepEqual(cap.lines.filter((l) => l.includes("fault ")), []);
    assert.deepEqual(cap.lines.filter((l) => l.includes(PATIENT)), []);
    const row = s.t.audit.list({ limit: 1 })[0];
    assert.equal(row.outcome, 4);
    assert.equal(row.patient, PATIENT);
  } finally {
    cap.restore();
    await s.close();
  }
});

test("the net under the router logs an area, not the path a patient is named in", async () => {
  const s = await boot();
  const cap = captureErr();
  try {
    // A throw before any route's own handling — the one path that used to
    // send the exception message straight back to the caller.
    const original = s.gate.check.bind(s.gate);
    (s.gate as { check: unknown }).check = () => {
      throw new Error(`gate exploded reading ${PATIENT}`);
    };
    try {
      const res = await fetch(`${s.base}/fhir/Patient/${PATIENT}`, {
        headers: { authorization: `Bearer ${s.admin}` },
      });
      assert.equal(res.status, 500);
      const raw = JSON.stringify(await res.json());
      assert.ok(!raw.includes(PATIENT), `the caller was told the path: ${raw}`);
      assert.ok(!raw.includes("exploded"), `the caller was told the message: ${raw}`);

      const faults = cap.lines.filter((l) => l.includes("fault "));
      assert.equal(faults.length, 1, JSON.stringify(cap.lines));
      assert.ok(faults[0].includes("/fhir/Patient"), `the area is missing: ${faults[0]}`);
      assert.ok(!faults[0].includes(PATIENT), `the log carried the id in the path: ${faults[0]}`);
      assert.ok(!faults[0].includes("exploded"), `the log carried the message: ${faults[0]}`);
    } finally {
      (s.gate as { check: unknown }).check = original;
    }
  } finally {
    cap.restore();
    await s.close();
  }
});

test("the public health and metrics endpoints name channels, never patients", async () => {
  const s = await boot();
  try {
    for (const path of ["/api/health", "/metrics"]) {
      const res = await fetch(`${s.base}${path}`);
      assert.equal(res.status, 200, path);
      const text = await res.text();
      assert.ok(!text.includes(PATIENT), `${path} named a patient`);
      // Both are unauthenticated. A count is a count; a chart is not.
      assert.ok(!/\bfamily\b|\bbirthDate\b|\bgiven\b/.test(text), `${path} carried a chart field`);
    }
  } finally {
    await s.close();
  }
});

test("no console call in the engine prints a mapped fault's detail", () => {
  // The mistake this guards is the one that was actually made, four times:
  // `console.error(\`... ${mapped.detail}\`)`. `detail` is the field written
  // for the trail, and the trail is the only sink allowed to have it.
  const roots = ["src"];
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (full.endsWith(".ts")) files.push(full);
    }
  };
  for (const r of roots) walk(r);
  // A scanner that silently stops finding files reports a clean bill of
  // health forever. Fail if the sweep collapses.
  assert.ok(files.length > 60, `only ${files.length} source files scanned`);

  const offenders: string[] = [];
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    src.split("\n").forEach((line, i) => {
      if (!/console\.(error|warn|log|info|debug)/.test(line)) return;
      if (/\bmapped\.detail\b|\bmapStoreError\([^)]*\)\.detail\b/.test(line)) {
        offenders.push(`${file}:${i + 1}`);
      }
    });
  }
  assert.deepEqual(offenders, [], `a fault's detail is printed at ${offenders.join(", ")}`);
});
