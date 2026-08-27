/**
 * The directory, spoken as FHIR.
 *
 * The parties are modelled. These tests pin the other half of #33: a
 * practitioner registered here is a Practitioner on the facade, a role is
 * a PractitionerRole, and a write that arrives as FHIR is ingested when it
 * can be — without failing the upsert that already succeeded.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../src/db.ts";
import { Directory } from "../src/directory/store.ts";
import { FhirStore } from "../src/fhir/store.ts";
import { Engine } from "../src/core/engine.ts";
import { startApi } from "../src/api/admin.ts";
import { ingestFhir } from "../src/directory/fhir.ts";

function region(): { db: Db; dir: Directory; fhir: FhirStore; cleanup: () => void } {
  const d = mkdtempSync(join(tmpdir(), "northstar-dir-fhir-"));
  const db = new Db(join(d, "northstar.db"));
  const dir = new Directory(db);
  return {
    db,
    dir,
    fhir: new FhirStore(db, undefined, dir),
    cleanup: () => {
      db.close();
      rmSync(d, { recursive: true, force: true });
    },
  };
}

test("a registered practitioner is a Practitioner on the facade, with identifiers", () => {
  const { dir, fhir, cleanup } = region();
  try {
    const p = dir.addPractitioner({
      family: "Tetso",
      given: "Marie",
      prefix: "Dr",
      identifiers: [{ system: "urn:nt:licence", value: "NT-4471" }],
    });
    const got = fhir.get("Practitioner", p.id);
    assert.ok(got);
    assert.equal(got.resourceType, "Practitioner");
    assert.equal(got.id, p.id);
    assert.equal(got.active, true);
    const name = (got.name as Array<{ family: string; given: string[]; prefix: string[] }>)[0];
    assert.equal(name.family, "Tetso");
    assert.deepEqual(name.given, ["Marie"]);
    assert.deepEqual(name.prefix, ["Dr"]);
    assert.deepEqual(got.identifier, [{ system: "urn:nt:licence", value: "NT-4471" }]);

    const search = fhir.search("Practitioner", { identifier: "urn:nt:licence|NT-4471" });
    assert.equal(search.total, 1);
    assert.equal(search.resources[0].id, p.id);

    const bare = fhir.search("Practitioner", { identifier: "NT-4471" });
    assert.equal(bare.total, 1);
  } finally {
    cleanup();
  }
});

test("organization, location, service and role project to the FHIR types the facade advertises", () => {
  const { dir, fhir, cleanup } = region();
  try {
    const org = dir.addOrganization({ name: "Yellowknife Primary Care", kind: "clinic" });
    const loc = dir.addLocation({ name: "YK Clinic", organizationId: org.id, community: "Yellowknife" });
    const svc = dir.addService({ name: "General practice", organizationId: org.id, locationId: loc.id, category: "GP" });
    const p = dir.addPractitioner({ family: "Hale" });
    const role = dir.assignRole({
      practitionerId: p.id,
      organizationId: org.id,
      locationId: loc.id,
      serviceId: svc.id,
      role: "locum",
      specialty: "General practice",
    });

    const organization = fhir.get("Organization", org.id)!;
    assert.equal(organization.name, "Yellowknife Primary Care");
    assert.deepEqual(organization.type, [{ text: "clinic" }]);

    const location = fhir.get("Location", loc.id)!;
    assert.equal(location.name, "YK Clinic");
    assert.equal((location.address as { city: string }).city, "Yellowknife");
    assert.equal((location.managingOrganization as { reference: string }).reference, `Organization/${org.id}`);

    const service = fhir.get("HealthcareService", svc.id)!;
    assert.equal(service.name, "General practice");
    assert.equal((service.providedBy as { reference: string }).reference, `Organization/${org.id}`);

    const practitionerRole = fhir.get("PractitionerRole", role.id)!;
    assert.equal((practitionerRole.practitioner as { reference: string }).reference, `Practitioner/${p.id}`);
    assert.deepEqual(practitionerRole.code, [{ text: "locum" }]);
    assert.deepEqual(practitionerRole.specialty, [{ text: "General practice" }]);

    const types = fhir.resourceTypes().map((t) => t.type);
    for (const t of ["Practitioner", "PractitionerRole", "Organization", "Location", "HealthcareService"]) {
      assert.ok(types.includes(t), `capability listing missing ${t}`);
    }
  } finally {
    cleanup();
  }
});

test("a retired party is still a resource, and says it is inactive", () => {
  const { dir, fhir, cleanup } = region();
  try {
    const org = dir.addOrganization({ name: "Hay River Clinic" });
    dir.retire("organization", org.id, "2026-03-31T00:00:00Z");
    const got = fhir.get("Organization", org.id);
    assert.ok(got);
    assert.equal(got.active, false, "the referral sent here in 2024 still has a target to name");
    assert.equal(fhir.search("Organization", {}).total, 1, "retired entries remain searchable");
  } finally {
    cleanup();
  }
});

test("a FHIR write of a Practitioner lands in the directory, and a Patient write does not", () => {
  const { dir, fhir, cleanup } = region();
  try {
    const result = fhir.upsert({
      resourceType: "Practitioner",
      id: "dr-marie",
      identifier: [{ system: "urn:nt:licence", value: "NT-4471" }],
      name: [{ family: "Tetso", given: ["Marie"], prefix: ["Dr"] }],
    });
    // ingest is wired by the engine; here we call it the same way onChange does.
    ingestFhir(dir, fhir.get("Practitioner", result.id)!);
    const found = dir.practitioner("dr-marie");
    assert.ok(found);
    assert.equal(found.family, "Tetso");
    assert.deepEqual(dir.byIdentifier("urn:nt:licence", "NT-4471"), [{ kind: "practitioner", id: "dr-marie" }]);

    ingestFhir(dir, { resourceType: "Patient", id: "p1", name: [{ family: "Beaulieu" }] });
    assert.equal(dir.count("practitioner"), 1, "a Patient is not a party");

    ingestFhir(dir, { resourceType: "Practitioner", id: "no-name" });
    assert.equal(dir.practitioner("no-name"), undefined, "a practitioner without a family name is not invented");
  } finally {
    cleanup();
  }
});

test("the facade serves directory parties over HTTP, and a facade write is ingested", async () => {
  const engine = new Engine({ dbPath: ":memory:", tickMs: 15 });
  await engine.start();
  const api = await startApi(engine, 0, "127.0.0.1");
  const base = `http://127.0.0.1:${api.port}`;
  try {
    const t = engine.forTenant("default");
    const p = t.directory.addPractitioner({
      family: "Tetso",
      given: "Marie",
      identifiers: [{ system: "urn:nt:licence", value: "NT-4471" }],
    });

    const cap = (await (await fetch(`${base}/fhir/metadata`)).json()) as {
      rest: Array<{ resource: Array<{ type: string }> }>;
    };
    const types = cap.rest[0].resource.map((r) => r.type);
    for (const want of ["Practitioner", "PractitionerRole", "Organization", "Location", "HealthcareService"]) {
      assert.ok(types.includes(want), `CapabilityStatement missing ${want}`);
    }

    const one = (await (await fetch(`${base}/fhir/Practitioner/${p.id}`)).json()) as {
      resourceType: string;
      name: Array<{ family: string }>;
    };
    assert.equal(one.resourceType, "Practitioner");
    assert.equal(one.name[0].family, "Tetso");

    const bundle = (await (await fetch(`${base}/fhir/Practitioner?identifier=urn:nt:licence|NT-4471`)).json()) as {
      total: number;
    };
    assert.equal(bundle.total, 1);

    t.fhir.upsert({
      resourceType: "Organization",
      id: "nthssa",
      name: "NTHSSA",
      type: [{ text: "authority" }],
    });
    assert.ok(t.directory.organization("nthssa"), "a facade write of an Organization is in the directory");
    const org = (await (await fetch(`${base}/fhir/Organization/nthssa`)).json()) as { name: string };
    assert.equal(org.name, "NTHSSA");
  } finally {
    await api.close();
    await engine.stop();
  }
});
