/**
 * A document the patient supplied is not a note the clinic wrote.
 *
 * DocumentReference already stores SOAP notes. Filing a specialist letter
 * as one of those is how an unsigned "note" appears on the chart, and how
 * a lockbox on counselling notes hides — or fails to hide — a form the
 * patient handed over. An empty panel is never-received, not none. HTML,
 * SVG and executables are refused; a payload over 256 KiB is refused.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../src/db.ts";
import { ClinicalRecord } from "../src/clinical/record.ts";
import { ClinicalNotes } from "../src/clinical/notes.ts";
import { Encounters } from "../src/clinical/encounters.ts";
import { PatientDocuments, DOCUMENT_MAX_BYTES } from "../src/clinical/documents.ts";
import { VisitView } from "../src/workspace/visit.ts";
import { Refusal } from "../src/core/refusal.ts";

function clinic() {
  const dir = mkdtempSync(join(tmpdir(), "northstar-doc-"));
  const db = new Db(join(dir, "northstar.db"));
  const record = new ClinicalRecord(db);
  return {
    db,
    record,
    notes: new ClinicalNotes(record),
    documents: new PatientDocuments(record),
    encounters: new Encounters(db),
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const P = "NT123456";
const CLERK = { authorId: "registration-desk", authorKind: "practitioner" };

test("a document needs a title and when it was received", () => {
  const { documents, cleanup } = clinic();
  try {
    assert.throws(
      () =>
        documents.receive({
          patientId: P,
          title: "  ",
          source: "patient-brought",
          receivedAt: "2026-08-20T10:00:00Z",
          by: CLERK,
        }),
      Refusal
    );
    assert.throws(
      () =>
        documents.receive({
          patientId: P,
          title: "Cardiology letter",
          source: "patient-brought",
          receivedAt: "",
          by: CLERK,
        }),
      (err: unknown) => err instanceof Refusal && /received/.test((err as Error).message)
    );
    const row = documents.receive({
      patientId: P,
      title: "Cardiology letter",
      source: "patient-brought",
      receivedAt: "2026-08-20T10:00:00Z",
      by: CLERK,
    });
    assert.equal(row.title, "Cardiology letter");
    assert.equal(row.hasContent, false, "a clerk can record that paper arrived without scanning it");
    assert.equal(documents.historyStatus(P), "documented");
  } finally {
    cleanup();
  }
});

test("an empty document panel is never-received, not none", () => {
  const { documents, cleanup } = clinic();
  try {
    assert.equal(documents.historyStatus(P), "never-received");
    assert.deepEqual(documents.forPatient(P), []);
    documents.receive({
      patientId: P,
      title: "Advance directive photocopy",
      source: "clinic-scanned",
      receivedAt: "2026-01-15T09:00:00Z",
      contentType: "text/plain",
      data: "photocopy on file at the desk",
      by: CLERK,
    });
    assert.equal(documents.historyStatus(P), "documented");
    assert.equal(documents.forPatient(P)[0].hasContent, true);
    assert.equal(documents.forPatient(P)[0].data, undefined, "the list does not carry the payload");
    assert.equal(documents.get(documents.forPatient(P)[0].recordId)?.data, "photocopy on file at the desk");
  } finally {
    cleanup();
  }
});

test("a patient-supplied document is not a clinical note", () => {
  const { documents, notes, cleanup } = clinic();
  try {
    documents.receive({
      patientId: P,
      title: "Cardiology letter",
      source: "patient-brought",
      receivedAt: "2026-08-20T10:00:00Z",
      by: CLERK,
    });
    notes.draft({
      patientId: P,
      noteType: "SOAP",
      sections: { plan: "Repeat bloods" },
      author: CLERK,
    });
    assert.equal(notes.forPatient(P).length, 1);
    assert.equal(notes.forPatient(P)[0].note.noteType, "SOAP");
    assert.equal(documents.forPatient(P).length, 1);
    assert.equal(documents.forPatient(P)[0].title, "Cardiology letter");
  } finally {
    cleanup();
  }
});

test("an executable or HTML file is not a document", () => {
  const { documents, cleanup } = clinic();
  try {
    assert.throws(
      () =>
        documents.receive({
          patientId: P,
          title: "lab results",
          source: "patient-submitted",
          receivedAt: "2026-08-20T10:00:00Z",
          contentType: "text/html",
          data: "<script>alert(1)</script>",
          by: CLERK,
        }),
      (err: unknown) => err instanceof Refusal && /HTML/.test((err as Error).message)
    );
    assert.throws(
      () =>
        documents.receive({
          patientId: P,
          title: "scan",
          source: "patient-submitted",
          receivedAt: "2026-08-20T10:00:00Z",
          contentType: "image/svg+xml",
          data: "<svg>",
          by: CLERK,
        }),
      Refusal
    );
    assert.throws(
      () =>
        documents.receive({
          patientId: P,
          title: "installer",
          source: "patient-submitted",
          receivedAt: "2026-08-20T10:00:00Z",
          contentType: "application/x-msdownload",
          data: "TVo=",
          by: CLERK,
        }),
      Refusal
    );
  } finally {
    cleanup();
  }
});

test("a document larger than the cap is refused", () => {
  const { documents, cleanup } = clinic();
  try {
    const data = "x".repeat(DOCUMENT_MAX_BYTES + 1);
    assert.throws(
      () =>
        documents.receive({
          patientId: P,
          title: "huge export",
          source: "patient-submitted",
          receivedAt: "2026-08-20T10:00:00Z",
          contentType: "text/plain",
          data,
          by: CLERK,
        }),
      (err: unknown) => err instanceof Refusal && /bytes/.test((err as Error).message)
    );
  } finally {
    cleanup();
  }
});

test("one custodian cannot read another's patient-supplied documents", () => {
  const dir = mkdtempSync(join(tmpdir(), "northstar-doc-iso-"));
  const root = new Db(join(dir, "northstar.db"));
  try {
    root.createTenant("north", "Northern Health");
    root.createTenant("south", "Southern Health");
    const north = new PatientDocuments(new ClinicalRecord(root.forTenant("north")));
    const south = new PatientDocuments(new ClinicalRecord(root.forTenant("south")));
    north.receive({
      patientId: P,
      title: "Cardiology letter",
      source: "patient-brought",
      receivedAt: "2026-08-20T10:00:00Z",
      by: CLERK,
    });
    assert.equal(north.historyStatus(P), "documented");
    assert.equal(south.historyStatus(P), "never-received");
  } finally {
    root.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a document brought to a visit is a visit section, not a note", () => {
  const { documents, notes, encounters, record, cleanup } = clinic();
  try {
    const visit = encounters.open({
      patientId: P,
      class: "in-person",
      reason: "Bring letters",
      by: { actorId: "dr-tetso", actorKind: "practitioner" },
      arrived: true,
    });
    notes.draft({
      patientId: P,
      encounterId: visit.id,
      noteType: "SOAP",
      sections: { plan: "Reviewed the letter" },
      author: CLERK,
    });
    documents.receive({
      patientId: P,
      title: "Cardiology letter",
      source: "patient-brought",
      receivedAt: "2026-08-20T10:00:00Z",
      encounterId: visit.id,
      by: CLERK,
    });
    const summary = new VisitView({ encounters, record }).summarise(visit.id);
    assert.equal(summary.documents.items.length, 1);
    assert.equal(summary.documents.items[0].title, "Cardiology letter");
    assert.equal(summary.notes.items.length, 1);
    assert.equal(JSON.parse(summary.notes.items[0].content).noteType, "SOAP");
  } finally {
    cleanup();
  }
});
