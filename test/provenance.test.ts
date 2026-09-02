/**
 * Where a resource came from, and why that is not the audit trail.
 *
 * `audit_events` is hash-chained and answers "who reached this record, when,
 * and were they allowed to". It is the right shape for that and the wrong
 * shape for the other question people ask after something goes wrong: where
 * did this value come from. An audit row can say a laboratory feed wrote
 * something at 04:12; it cannot say this potassium was produced by mapping
 * version 3 from message 8812, or that this entry arrived in a migration
 * rather than from a prescriber.
 *
 * The two are separate stores here, and these tests assert they stay separate
 * — because the failure is not that one is missing, it is that somebody reads
 * the one they have as though it answered the other question.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../src/db.ts";
import { FhirStore } from "../src/fhir/store.ts";
import { ProvenanceStore } from "../src/fhir/provenance.ts";

const P = "NT123456";

function site() {
  const dir = mkdtempSync(join(tmpdir(), "northstar-prov-"));
  const db = new Db(join(dir, "northstar.db"));
  const fhir = new FhirStore(db);
  return {
    db,
    fhir,
    prov: fhir.provenance,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}

const potassium = (value: string) => ({
  resourceType: "Observation",
  id: "obs-1",
  status: "final",
  code: { text: "Potassium" },
  subject: { reference: `Patient/${P}` },
  valueQuantity: { value: Number(value), unit: "mmol/L" },
});

const LAB = { agent: { id: "stanton-lab", kind: "device", organizationId: "org-stanton" } } as const;

// ── A write leaves a trace of where it came from ──────────────────────────

test("a create records what made it, and an update records the next step", () => {
  const s = site();
  try {
    s.fhir.upsert(potassium("4.1"), undefined, {
      ...LAB,
      source: { kind: "message", id: "msg-8812" },
      transformation: { id: "lab-oru-to-observation", version: "3" },
    });
    s.fhir.upsert(potassium("7.1"), undefined, {
      ...LAB,
      source: { kind: "message", id: "msg-8899" },
      transformation: { id: "lab-oru-to-observation", version: "3" },
    });

    const lineage = s.prov.forTarget("Observation", "obs-1");
    assert.equal(lineage.length, 2, "both writes are on the record");
    assert.equal(lineage[0].activity, "transform", "a mapped write is a transformation, not a bare update");
    assert.equal(lineage[0].source?.id, "msg-8899", "newest first");
    assert.equal(lineage[1].source?.id, "msg-8812");
    assert.equal(lineage[0].transformation?.version, "3");
    assert.equal(lineage[0].agent?.id, "stanton-lab");
    assert.equal(lineage[0].agent?.organizationId, "org-stanton");
    assert.ok(lineage[0].target.version > lineage[1].target.version, "each names the version it produced");
  } finally {
    s.cleanup();
  }
});

test("the lineage survives the resource being overwritten", () => {
  // The correction replaced the value in fhir_resources. The record of what
  // the first value was made from is still there, which is the whole point.
  const s = site();
  try {
    s.fhir.upsert(potassium("4.1"), undefined, { ...LAB, source: { kind: "message", id: "msg-8812" } });
    s.fhir.upsert(potassium("7.1"), undefined, { ...LAB, source: { kind: "message", id: "msg-8899" } });

    const current = s.fhir.get("Observation", "obs-1")!;
    assert.equal((current as { valueQuantity?: { value?: number } }).valueQuantity?.value, 7.1);
    const sources = s.prov.forTarget("Observation", "obs-1").map((r) => r.source?.id);
    assert.deepEqual(sources, ["msg-8899", "msg-8812"], "the superseded value's origin is still reconstructable");
  } finally {
    s.cleanup();
  }
});

test("a redelivery of identical content does not fabricate a second origin", () => {
  // Retries are ordinary: a delivery is replayed, the bytes are the same, and
  // nothing clinically happened. Recording a second lineage entry would make
  // one result look like two reports of the same value.
  const s = site();
  try {
    s.fhir.upsert(potassium("4.1"), undefined, { ...LAB, source: { kind: "message", id: "msg-8812" } });
    const first = s.prov.forTarget("Observation", "obs-1").length;

    for (let n = 0; n < 3; n++) {
      const again = s.fhir.upsert(potassium("4.1"), undefined, { ...LAB, source: { kind: "message", id: "msg-8812" } });
      assert.equal(again.changed, false, "an identical rewrite changes nothing");
    }
    assert.equal(s.prov.forTarget("Observation", "obs-1").length, first, "and records nothing further");
  } finally {
    s.cleanup();
  }
});

test("a write nothing described is recorded as unattributed, not attributed to nobody in particular", () => {
  // The direction this has to fail in. A lineage naming the wrong author is
  // worse than one admitting it does not know, because the first is believed.
  const s = site();
  try {
    s.fhir.upsert(potassium("4.1"));
    const [row] = s.prov.forTarget("Observation", "obs-1");
    assert.equal(row.agent, null);
    assert.equal(row.source, null);
    assert.equal(row.activity, "create");

    const resource = s.prov.toFhir(row);
    const agent = (resource.agent as Array<{ who?: { display?: string } }>)[0];
    assert.match(agent.who?.display ?? "", /unattributed/, "the projection says so rather than inventing a who");
  } finally {
    s.cleanup();
  }
});

// ── Everything one bad feed produced ──────────────────────────────────────

test("one message's whole output can be traced from the message", () => {
  // The question asked when a feed is found to have been wrong: what did it
  // touch. Answering it by resource means knowing which resources to look at.
  const s = site();
  try {
    for (const id of ["obs-1", "obs-2", "obs-3"]) {
      s.fhir.upsert({ ...potassium("4.1"), id }, undefined, {
        ...LAB,
        source: { kind: "message", id: "msg-8812" },
        transformation: { id: "lab-oru-to-observation", version: "3" },
      });
    }
    s.fhir.upsert({ ...potassium("5.0"), id: "obs-4" }, undefined, {
      ...LAB,
      source: { kind: "message", id: "msg-9000" },
    });

    const fromBadFeed = s.prov.forSource("message", "msg-8812");
    assert.equal(fromBadFeed.length, 3);
    assert.deepEqual(fromBadFeed.map((r) => r.target.id).sort(), ["obs-1", "obs-2", "obs-3"]);
    assert.equal(s.prov.forSource("message", "msg-9000").length, 1);
  } finally {
    s.cleanup();
  }
});

// ── An automated computation ──────────────────────────────────────────────

test("a computed result names the rule and the version that produced it", () => {
  const s = site();
  try {
    s.prov.record({
      target: { type: "RiskAssessment", id: "ra-1", version: 1 },
      activity: "compute",
      agent: { id: "northstar", kind: "system" },
      rule: { id: "curb-65", version: "portage-1" },
      source: { kind: "resource", id: "Patient/NT123456" },
    });
    const [row] = s.prov.forTarget("RiskAssessment", "ra-1");
    assert.equal(row.activity, "compute");
    assert.equal(row.rule?.id, "curb-65");
    assert.equal(row.rule?.version, "portage-1");

    // A score recomputed after the arithmetic changes must be distinguishable
    // from the earlier one, or a review cannot tell which formula ran.
    const projected = s.prov.toFhir(row);
    const performers = (projected.agent as Array<{ who?: { display?: string } }>).map((a) => a.who?.display ?? "");
    assert.ok(performers.some((d) => d.includes("curb-65") && d.includes("portage-1")));
  } finally {
    s.cleanup();
  }
});

// ── Not the audit trail ───────────────────────────────────────────────────

test("provenance and the audit trail answer different questions", () => {
  const s = site();
  try {
    s.fhir.upsert(potassium("4.1"), undefined, { ...LAB, source: { kind: "message", id: "msg-8812" } });

    // The lineage knows where the value came from.
    const [lineage] = s.prov.forTarget("Observation", "obs-1");
    assert.equal(lineage.source?.id, "msg-8812");

    // The audit trail is a separate store and holds no lineage for this write:
    // nobody has read the record yet, so there is nothing for it to say. The
    // two are not substitutes, and this is what that looks like.
    const audited = s.db.sql
      .prepare("SELECT COUNT(*) AS n FROM audit_events WHERE tenant_id = ?")
      .get("default") as { n: number };
    assert.equal(audited.n, 0, "writing a resource is not an access event");

    // And provenance is deliberately not chained: it makes no completeness
    // claim, because a write path that records none would leave a gap a chain
    // would then assert over.
    const cols = s.db.sql.prepare("PRAGMA table_info(provenance)").all() as Array<{ name: string }>;
    assert.ok(!cols.some((c) => /hash|prev|chain/.test(c.name)), "no chain columns, by design");
  } finally {
    s.cleanup();
  }
});

// ── Tenancy ───────────────────────────────────────────────────────────────

test("one tenant's lineage is invisible to another", () => {
  const s = site();
  try {
    s.fhir.upsert(potassium("4.1"), undefined, { ...LAB, source: { kind: "message", id: "msg-8812" } });
    const other = new ProvenanceStore(s.db.forTenant("yellowknife"));
    assert.deepEqual(other.forTarget("Observation", "obs-1"), []);
    assert.deepEqual(other.forSource("message", "msg-8812"), []);
    assert.equal(s.prov.forTarget("Observation", "obs-1").length, 1);
  } finally {
    s.cleanup();
  }
});

// ── The FHIR shape ────────────────────────────────────────────────────────

test("the projection is a Provenance resource pointing at what it explains", () => {
  const s = site();
  try {
    s.fhir.upsert(potassium("4.1"), undefined, {
      ...LAB,
      source: { kind: "message", id: "msg-8812" },
      transformation: { id: "lab-oru-to-observation", version: "3" },
      occurredAt: "2026-09-01T04:12:00.000Z",
    });
    const [row] = s.prov.forTarget("Observation", "obs-1");
    const r = s.prov.toFhir(row, "http://example.invalid/fhir");

    assert.equal(r.resourceType, "Provenance");
    assert.deepEqual(
      (r.target as Array<{ reference?: string }>)[0].reference,
      "http://example.invalid/fhir/Observation/obs-1",
    );
    assert.equal(r.occurredDateTime, "2026-09-01T04:12:00.000Z");
    assert.ok(typeof r.recorded === "string" && r.recorded.length > 0);
    // The mapping that did the work is an agent in its own right, so a reader
    // can tell a machine transformation from a person's entry.
    const displays = (r.agent as Array<{ who?: { display?: string } }>).map((a) => a.who?.display ?? "");
    assert.ok(displays.some((d) => d.includes("lab-oru-to-observation") && d.includes("v3")));
    const entity = (r.entity as Array<{ what?: { identifier?: { value?: string } } }>)[0];
    assert.equal(entity.what?.identifier?.value, "msg-8812");
  } finally {
    s.cleanup();
  }
});
