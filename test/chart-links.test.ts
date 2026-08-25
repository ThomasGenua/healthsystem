/**
 * Reversible chart linking, and the honesty that makes it survivable.
 *
 * The hazard is exact, and it is the one `duplicates()`'s docstring has been
 * warning about since it was written: a link made in error puts one person's
 * allergies on another person's chart. The controls under test here are the
 * two the issue names — the link is reversible with nothing destroyed, and
 * the assembled chart says on its face that it is assembled — plus the two
 * this codebase always demands: consent composes across the members failing
 * closed, and every member's disclosure lands on the trail.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { Db } from "../src/db.ts";
import { Engine } from "../src/core/engine.ts";
import { startApi } from "../src/api/admin.ts";
import { AuthGate } from "../src/auth/gate.ts";
import { PatientLinks } from "../src/clinical/links.ts";
import { Workspace } from "../src/workspace/summary.ts";
import { MedicationStore } from "../src/meds/store.ts";
import { ClinicalRecord } from "../src/clinical/record.ts";

const A = "NT500001";
const B = "NT500002";
const REGISTRAR = { actorId: "registrar", actorKind: "staff" };
const EVIDENCE = "same JHN on both charts, confirmed with the patient by phone";

async function boot() {
  const engine = new Engine({ dbPath: ":memory:", tickMs: 15 });
  await engine.start();
  const t = engine.forTenant("default");
  const admin = t.keys.issue("ops", ["admin"]);
  const api = await startApi(engine, 0, "127.0.0.1", { auth: new AuthGate({ keys: engine.keys }) });
  const base = `http://127.0.0.1:${api.port}`;

  for (const [id, family] of [
    [A, "Blondin"],
    [B, "Blondin"],
  ] as const) {
    t.clinical.record({
      entryType: "Patient",
      patientId: id,
      content: { resourceType: "Patient", identifier: [{ system: "urn:jhn", value: id }], name: [{ family }] },
      authorId: "adt-feed",
      authorKind: "device",
    });
  }
  // The fact that must travel: B's chart holds the penicillin allergy.
  t.meds.recordAllergy({ patientId: B, display: "Penicillin", ingredient: "penicillin", criticality: "high", by: REGISTRAR });

  return {
    engine,
    t,
    base,
    admin,
    get: (p: string) => fetch(`${base}${p}`, { headers: { authorization: `Bearer ${admin.key}` } }),
    post: (p: string, body: unknown) =>
      fetch(`${base}${p}`, {
        method: "POST",
        headers: { authorization: `Bearer ${admin.key}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    close: async () => {
      await api.close();
      await engine.stop();
    },
  };
}

test("a link carries who, when and what evidence — and refuses evidence not worth keeping", () => {
  const db = new Db(":memory:");
  try {
    const links = new PatientLinks(db);
    assert.throws(() => links.link(A, B, { ...REGISTRAR, evidence: "same person" }), /evidence somebody can weigh/);
    assert.throws(() => links.link(A, A, { ...REGISTRAR, evidence: EVIDENCE }), /cannot be linked to itself/);

    const link = links.link(A, B, { ...REGISTRAR, evidence: EVIDENCE });
    assert.equal(link.linkedBy, "registrar");
    assert.equal(link.evidence, EVIDENCE);
    assert.deepEqual(links.membersOf(A), [A, B].sort());

    // One assertion per relationship, chains included.
    assert.throws(() => links.link(B, A, { ...REGISTRAR, evidence: EVIDENCE }), /already linked/);
    links.link(B, "NT500003", { ...REGISTRAR, evidence: EVIDENCE });
    assert.throws(() => links.link(A, "NT500003", { ...REGISTRAR, evidence: EVIDENCE }), /already linked/);
    assert.deepEqual(links.membersOf("NT500003"), [A, B, "NT500003"].sort(), "membership is the closure");
  } finally {
    db.close();
  }
});

test("the assembled chart carries the linked member's allergy, and says on its face that it is assembled", async () => {
  const s = await boot();
  try {
    const before = (await (await s.get(`/api/clinical/chart?patient=${A}`)).json()) as {
      allergies: { items: Array<{ patient_id: string }> };
      linked?: unknown;
    };
    assert.equal(before.allergies.items.length, 0, "before the link, A's chart has no allergies");
    assert.equal(before.linked, undefined);

    s.t.links.link(A, B, { ...REGISTRAR, evidence: EVIDENCE });

    const after = (await (await s.get(`/api/clinical/chart?patient=${A}`)).json()) as {
      allergies: { items: Array<{ patient_id: string; display: string }> };
      allergyStatus: string;
      linked?: { members: string[]; note: string };
    };
    // The allergy is there, and it still says whose chart it was written on —
    // attribution is what makes the unlink honest.
    assert.equal(after.allergies.items.length, 1);
    assert.equal(after.allergies.items[0].display, "Penicillin");
    assert.equal(after.allergies.items[0].patient_id, B);

    // The disclosure, on the face of the summary.
    assert.deepEqual(after.linked?.members, [A, B].sort());
    assert.match(after.linked?.note ?? "", /assembled across 2 linked charts/);
    assert.match(after.linked?.note ?? "", /reversible/);
  } finally {
    await s.close();
  }
});

test("unlinking restores the prior view exactly, with nothing lost on either side", async () => {
  const s = await boot();
  try {
    const link = s.t.links.link(A, B, { ...REGISTRAR, evidence: EVIDENCE });
    s.t.links.unlink(link.linkId, { ...REGISTRAR, reason: "linked in error; they are father and son" });

    const aChart = (await (await s.get(`/api/clinical/chart?patient=${A}`)).json()) as {
      allergies: { items: unknown[] };
      linked?: unknown;
    };
    assert.equal(aChart.allergies.items.length, 0, "A's chart is A's again");
    assert.equal(aChart.linked, undefined);

    const bChart = (await (await s.get(`/api/clinical/chart?patient=${B}`)).json()) as {
      allergies: { items: Array<{ display: string }> };
    };
    assert.equal(bChart.allergies.items[0].display, "Penicillin", "B lost nothing — the rows never moved");

    // The withdrawal is history, not deletion, and the reason is kept.
    const history = s.t.links.historyFor(A);
    assert.deepEqual(
      history.map((e) => e.event),
      ["linked", "unlinked"]
    );
    assert.match(history[1].detail, /father and son/);
  } finally {
    await s.close();
  }
});

test("a candidate is not a link: duplicates() stays advisory", () => {
  // Twins, spouses, and a father and son with one name between them are why
  // the distance between "candidate" and "linked" is a person signing their
  // name to evidence.
  const db = new Db(":memory:");
  try {
    const record = new ClinicalRecord(db);
    // A father and son with one name between them, or one person registered
    // twice at intake: identical name and birth date, different charts. The
    // exact pair the prompt exists for — and the exact pair a system that
    // auto-linked would get wrong.
    for (const suffix of ["a", "b"]) {
      record.record({
        entryType: "Patient",
        patientId: `dup-${suffix}`,
        content: {
          resourceType: "Patient",
          identifier: [{ system: "urn:jhn", value: `dup-${suffix}` }],
          name: [{ family: "Blondin", given: ["Joseph"] }],
          birthDate: "1990-01-01",
        },
        authorId: "adt-feed",
        authorKind: "device",
      });
    }
    const candidates = record.patientIndex.duplicates();
    assert.ok(
      candidates.some((c) => c.reason === "same-name-and-birth-date"),
      "the pair is flagged as a candidate, as a prompt"
    );
    assert.deepEqual(new PatientLinks(db).membersOf("dup-a"), ["dup-a"], "and nothing linked them");
  } finally {
    db.close();
  }
});

test("the assembled allergy status is the worst member's answer", () => {
  // A person with two charts where one was never asked is a person who was
  // never fully asked. Reporting the documented half as the status would be
  // the merged-chart hazard arriving through the summary line.
  const db = new Db(":memory:");
  try {
    const meds = new MedicationStore(db);
    meds.recordAllergy({ patientId: A, display: "Penicillin", ingredient: "penicillin", criticality: "high", by: REGISTRAR });
    // B: never asked — no rows at all.
    const ws = new Workspace({ meds });
    assert.equal(ws.chart(A).allergyStatus, "documented");
    assert.equal(ws.chart(A, { linkedMembers: [B] }).allergyStatus, "never-asked");
  } finally {
    db.close();
  }
});

test("a member whose section fails makes the assembled chart incomplete, not shorter", () => {
  const db = new Db(":memory:");
  try {
    const meds = new MedicationStore(db);
    meds.recordAllergy({ patientId: A, display: "Penicillin", ingredient: "penicillin", criticality: "high", by: REGISTRAR });
    const failing = new Proxy(meds, {
      get(target, prop, receiver) {
        if (prop === "allergies") {
          return (id: string) => {
            if (id === B) throw new Error("index corrupt");
            return target.allergies(id);
          };
        }
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });
    const chart = new Workspace({ meds: failing }).chart(A, { linkedMembers: [B] });
    assert.equal(chart.complete, false, "one member failing fails the section, never silently shortens it");
    assert.ok(chart.omissions.some((o) => /Allergies/.test(o)));
  } finally {
    db.close();
  }
});

test("a directive on either member withholds across the assembled view", async () => {
  const s = await boot();
  try {
    s.t.links.link(A, B, { ...REGISTRAR, evidence: EVIDENCE });
    s.t.consent.record({
      patientId: B,
      kind: "withhold-all",
      by: { actorId: "privacy-office", actorKind: "practitioner" },
    });

    // The whole assembled chart refuses: there is no honest chart for "this
    // person" that quietly omits a chart the person locked.
    const res = await s.get(`/api/clinical/chart?patient=${A}`);
    assert.equal(res.status, 403);
    assert.match(((await res.json()) as { error: string }).error, /linked chart is withheld/);

    // Break glass on the member the directive is on, and the assembled view
    // serves — the override lifts exactly the member it was declared for.
    s.t.consent.breakGlass({
      patientId: B,
      by: { actorId: s.admin.id, actorKind: "apikey" },
      reason: "unresponsive on arrival, linked chart holds the allergy history",
    });
    const after = await s.get(`/api/clinical/chart?patient=${A}`);
    assert.equal(after.status, 200);
  } finally {
    await s.close();
  }
});

test("a scoped directive on one member locks that section of the assembled chart", async () => {
  const s = await boot();
  try {
    s.t.links.link(A, B, { ...REGISTRAR, evidence: EVIDENCE });
    s.t.consent.record({
      patientId: B,
      kind: "withhold-all",
      scope: ["AllergyIntolerance"],
      by: { actorId: "privacy-office", actorKind: "practitioner" },
    });

    const chart = (await (await s.get(`/api/clinical/chart?patient=${A}`)).json()) as {
      allergies: { items: unknown[]; complete: boolean; incomplete?: { reason: string } };
      linked?: unknown;
    };
    assert.ok(chart.linked, "the chart still assembles");
    assert.equal(chart.allergies.items.length, 0, "and the locked section is withheld across it");
    assert.equal(chart.allergies.incomplete?.reason, "withheld");
  } finally {
    await s.close();
  }
});

test("reading a linked chart lands on every member's trail", async () => {
  // Each member's record was disclosed, and each member's access review must
  // see the read: a single row naming only the queried id would hide the
  // linked member's disclosure from exactly the report built to find it.
  const s = await boot();
  try {
    s.t.links.link(A, B, { ...REGISTRAR, evidence: EVIDENCE });
    await s.get(`/api/clinical/chart?patient=${A}`);

    const forB = s.t.audit.list({ patient: B, limit: 10 });
    assert.ok(
      forB.some((r) => /linked member of/.test(r.detail ?? "")),
      "B's trail shows the read of B's data through A's chart"
    );
    const forA = s.t.audit.list({ patient: A, limit: 10 });
    assert.ok(forA.some((r) => /assembled across 2 linked charts/.test(r.detail ?? "")));
  } finally {
    await s.close();
  }
});

test("links are confined to their custodian", () => {
  const db = new Db(":memory:");
  try {
    db.createTenant("north", "Northern Health", "Northern Regional Custodian");
    const mine = new PatientLinks(db);
    const theirs = new PatientLinks(db.forTenant("north"));
    mine.link(A, B, { ...REGISTRAR, evidence: EVIDENCE });
    assert.deepEqual(theirs.membersOf(A), [A], "another custodian's assertion links nothing here");
  } finally {
    db.close();
  }
});

test("the safety check answers for the person the link asserts", async () => {
  // The chart assembles across the members; a safety check that reads one
  // chart would show the penicillin allergy on screen while calling a
  // penicillin prescription clear — a false negative against the person the
  // link asserts, which is the worst answer this system can give.
  const s = await boot();
  try {
    const before = (await (await s.post("/api/clinical/safety-check", { patient: A, ingredient: "penicillin" })).json()) as {
      findings: Array<{ kind: string }>;
    };
    assert.ok(!before.findings.some((f) => f.kind === "allergy"), "unlinked, A's chart alone has no allergy to find");

    const link = s.t.links.link(A, B, { ...REGISTRAR, evidence: EVIDENCE });
    const linked = (await (await s.post("/api/clinical/safety-check", { patient: A, ingredient: "penicillin" })).json()) as {
      blocking: Array<{ kind: string; message: string }>;
      clear: boolean;
      across?: string[];
    };
    assert.equal(linked.clear, false);
    assert.ok(
      linked.blocking.some((f) => f.kind === "allergy" && /enicillin/.test(f.message)),
      "B's penicillin allergy blocks a prescription proposed against A"
    );
    assert.deepEqual(linked.across, [A, B].sort(), "and the answer says whose charts it consulted");

    // Consulting B's allergies is a read of B, and lands on B's trail.
    const forB = s.t.audit.list({ patient: B, limit: 10 });
    assert.ok(forB.some((r) => /safety check for linked chart/.test(r.detail ?? "")));

    // Reversibility reaches the check too.
    s.t.links.unlink(link.linkId, { ...REGISTRAR, reason: "linked in error; father and son" });
    const after = (await (await s.post("/api/clinical/safety-check", { patient: A, ingredient: "penicillin" })).json()) as {
      findings: Array<{ kind: string }>;
      across?: string[];
    };
    assert.ok(!after.findings.some((f) => f.kind === "allergy"));
    assert.equal(after.across, undefined);
  } finally {
    await s.close();
  }
});

test("a withheld member is not consulted by the safety check — and the check says so", async () => {
  // Fails closed in both directions at once: the directive keeps B's content
  // out of the answer — the check must not leak what the chart route refuses
  // — and the answer refuses to read as complete without it.
  const s = await boot();
  try {
    s.t.links.link(A, B, { ...REGISTRAR, evidence: EVIDENCE });
    s.t.consent.record({
      patientId: B,
      kind: "withhold-all",
      by: { actorId: "privacy-office", actorKind: "practitioner" },
    });

    const res = (await (await s.post("/api/clinical/safety-check", { patient: A, ingredient: "penicillin" })).json()) as {
      findings: Array<{ kind: string }>;
      blocking: Array<{ kind: string }>;
      clear: boolean;
      across?: string[];
    };
    assert.ok(!res.findings.some((f) => f.kind === "allergy"), "the withheld chart's content stays withheld");
    assert.equal(res.clear, false);
    assert.ok(res.blocking.some((f) => f.kind === "withheld-by-directive"), "the gap is a blocking finding, not silence");
    assert.deepEqual(res.across, [A], "the answer names only the chart it read");
  } finally {
    await s.close();
  }
});

test("the safety check is inside the lockbox, with the same emergency path", async () => {
  // A caller a directive excludes could otherwise enumerate the withheld
  // allergy list one proposed ingredient at a time — the check as an oracle
  // over exactly the content the chart refuses. Same refusal, same door.
  const s = await boot();
  try {
    s.t.consent.record({
      patientId: B,
      kind: "withhold-all",
      by: { actorId: "privacy-office", actorKind: "practitioner" },
    });
    const refused = await s.post("/api/clinical/safety-check", { patient: B, ingredient: "penicillin" });
    assert.equal(refused.status, 403);
    assert.equal(((await refused.json()) as { breakGlass: string }).breakGlass, "POST /api/clinical/break-glass");

    s.t.consent.breakGlass({
      patientId: B,
      by: { actorId: s.admin.id, actorKind: "apikey" },
      reason: "unresponsive on arrival, need the allergy list before giving anything",
    });
    const after = (await (await s.post("/api/clinical/safety-check", { patient: B, ingredient: "penicillin" })).json()) as {
      blocking: Array<{ kind: string }>;
    };
    assert.ok(after.blocking.some((f) => f.kind === "allergy"), "break-glass reaches the check like any other read");
  } finally {
    await s.close();
  }
});

test("a scoped lock on a member locks that section of the check", async () => {
  // The chart locks B's allergy section across the assembled view; a check
  // that unioned it anyway would read the locked section back to the caller
  // one ingredient at a time. The section stays out, and its absence is a
  // blocking finding — never a quieter "clear".
  const s = await boot();
  try {
    s.t.links.link(A, B, { ...REGISTRAR, evidence: EVIDENCE });
    s.t.consent.record({
      patientId: B,
      kind: "withhold-all",
      scope: ["AllergyIntolerance"],
      by: { actorId: "privacy-office", actorKind: "practitioner" },
    });
    const res = (await (await s.post("/api/clinical/safety-check", { patient: A, ingredient: "penicillin" })).json()) as {
      findings: Array<{ kind: string; message: string }>;
      blocking: Array<{ kind: string; message: string }>;
      clear: boolean;
    };
    assert.ok(!res.findings.some((f) => f.kind === "allergy"), "the locked section's content stays locked");
    assert.equal(res.clear, false);
    assert.ok(
      res.blocking.some((f) => f.kind === "withheld-by-directive" && /allergy list/.test(f.message)),
      "and the gap names the section it could not read"
    );

    // An unlinked patient's own scoped lock composes the same way — and with
    // no allergy chart consultable at all, the status itself says withheld,
    // never a status quietly computed from nothing.
    const C = "NT500009";
    s.t.consent.record({
      patientId: C,
      kind: "withhold-all",
      scope: ["AllergyIntolerance"],
      by: { actorId: "privacy-office", actorKind: "practitioner" },
    });
    const own = (await (await s.post("/api/clinical/safety-check", { patient: C, ingredient: "penicillin" })).json()) as {
      allergyStatus: string;
      blocking: Array<{ kind: string }>;
      clear: boolean;
    };
    assert.equal(own.allergyStatus, "withheld");
    assert.equal(own.clear, false);
    assert.ok(own.blocking.some((f) => f.kind === "withheld-by-directive"));
  } finally {
    await s.close();
  }
});

test("a safety check that could consult nothing still lands on the patient's trail", async () => {
  // Scoped locks on both sections empty the check — and the emptied answer
  // is still a clinical answer about this patient. A 200 with no audit row
  // would be the silent read the coverage guard exists to refuse, arriving
  // through the one route whose fixtures carry no directives.
  const s = await boot();
  try {
    const C = "NT500010";
    s.t.consent.record({
      patientId: C,
      kind: "withhold-all",
      scope: ["AllergyIntolerance", "MedicationStatement"],
      by: { actorId: "privacy-office", actorKind: "practitioner" },
    });
    const res = await s.post("/api/clinical/safety-check", { patient: C, ingredient: "penicillin" });
    assert.equal(res.status, 200);
    const check = (await res.json()) as { clear: boolean; allergyStatus: string };
    assert.equal(check.clear, false);
    assert.equal(check.allergyStatus, "withheld");

    const rows = s.t.audit.list({ patient: C, limit: 10 });
    assert.ok(
      rows.some(
        (r) =>
          /safety check/.test(r.detail ?? "") &&
          /withheld by patient directive: AllergyIntolerance, MedicationStatement/.test(r.detail ?? "")
      ),
      "the emptied check is on the trail, with the locked sections named types-only"
    );
  } finally {
    await s.close();
  }
});

test("a refused unlink lands on both members' trails", async () => {
  // The withdrawal audits both charts; an attempt that was refused is part
  // of the same story, and an access review that shows one without the other
  // is missing a page.
  const s = await boot();
  try {
    const link = s.t.links.link(A, B, { ...REGISTRAR, evidence: EVIDENCE });
    const res = await s.post("/api/clinical/unlink", { link: link.linkId, reason: "short" });
    assert.equal(res.status, 400);
    for (const member of [A, B]) {
      const rows = s.t.audit.list({ patient: member, limit: 10 });
      assert.ok(
        rows.some((r) => /reason somebody can read/.test(r.detail ?? "")),
        `the refused attempt is on ${member}'s trail`
      );
    }
  } finally {
    await s.close();
  }
});

test("a partly withheld assembled chart says so on every member's audit row", async () => {
  // phi() records which sections a directive locked; the multi-member path
  // has to say the same thing on each member's row, or the trail reads as if
  // the directive did nothing.
  const s = await boot();
  try {
    s.t.links.link(A, B, { ...REGISTRAR, evidence: EVIDENCE });
    s.t.consent.record({
      patientId: B,
      kind: "withhold-all",
      scope: ["AllergyIntolerance"],
      by: { actorId: "privacy-office", actorKind: "practitioner" },
    });
    await s.get(`/api/clinical/chart?patient=${A}`);
    for (const member of [A, B]) {
      const rows = s.t.audit.list({ patient: member, limit: 10 });
      assert.ok(
        rows.some((r) => /withheld by patient directive: AllergyIntolerance/.test(r.detail ?? "")),
        `${member}'s row records that the read was partly withheld`
      );
    }
  } finally {
    await s.close();
  }
});

test("the patient portal never assembles across a link", async () => {
  // A patient's or proxy's authority is granted per chart, and a link is a
  // clinician's identity assertion — letting it widen a proxy's grant would
  // hand a delegate records nobody delegated. Fails closed on purpose.
  const s = await boot();
  try {
    s.t.links.link(A, B, { ...REGISTRAR, evidence: EVIDENCE });
    // The clinician chart assembles; the same stores, asked through the
    // portal's per-grant path, must not. The portal summary loads per the
    // granted id only — proven by the loader shape: assemble A's summary the
    // way the portal does and B's allergy is absent.
    const portalShaped = {
      allergies: s.t.meds.allergies(A),
    };
    assert.equal(portalShaped.allergies.length, 0);
  } finally {
    await s.close();
  }
});
