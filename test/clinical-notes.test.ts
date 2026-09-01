/**
 * A signature has to mean something afterwards.
 *
 * The distinction section 3 turns on is between a draft and an attestation. A
 * draft is working text. A signature says: this is what I found, this is what
 * I decided, my name is on it. A note that can be revised after signature is
 * not evidence of anything — and the moment it matters is always months later,
 * in a review of a decision somebody now regrets.
 *
 * So these tests try to change a signed note, in every way the API offers, and
 * require each attempt to be refused rather than warned about.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../src/db.ts";
import { ClinicalRecord } from "../src/clinical/record.ts";
import { ClinicalNotes, type NoteContent } from "../src/clinical/notes.ts";
import { Encounters } from "../src/clinical/encounters.ts";

function desk(): {
  db: Db;
  rec: ClinicalRecord;
  notes: ClinicalNotes;
  enc1: string;
  enc2: string;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "northstar-notes-"));
  const db = new Db(join(dir, "northstar.db"));
  const rec = new ClinicalRecord(db);
  // Real visits, because a note names the encounter it was written at and the
  // record now refuses one that does not exist. The fixture used to invent
  // "enc-1", which is precisely the dangling reference this exists to stop.
  const encounters = new Encounters(db);
  const visit = (reason: string): string =>
    encounters.open({
      patientId: "NT123456",
      class: "in-person",
      reason,
      by: { actorId: "clerk", actorKind: "staff" },
      arrived: true,
    }).id;
  return {
    db,
    rec,
    notes: new ClinicalNotes(rec),
    enc1: visit("Cough"),
    enc2: visit("Consult"),
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const RESIDENT = { authorId: "dr-hale", authorKind: "practitioner" };
const ATTENDING = { authorId: "dr-tetso", authorKind: "practitioner" };

const SOAP = {
  subjective: "Two days of cough, no fever.",
  objective: "Chest clear. Sats 98%.",
  assessment: "Viral URTI.",
  plan: "Supportive care, review if worsening.",
};

function startNote(notes: ClinicalNotes, encounterId: string) {
  return notes.draft({
    patientId: "NT123456",
    encounterId,
    noteType: "SOAP",
    sections: SOAP,
    author: RESIDENT,
  });
}

test("a draft can be revised freely, and every version is kept", () => {
  // Drafts are working text, so revision is normal. Keeping the earlier text
  // is still right: "the draft said something different before the attending
  // saw it" is a question a serious review asks.
  const { rec, notes, enc1, cleanup } = desk();
  try {
    const note = startNote(notes, enc1);
    notes.revise(note.record_id, { ...SOAP, assessment: "Viral URTI, query early pneumonia." }, RESIDENT);
    notes.revise(note.record_id, { ...SOAP, assessment: "Viral URTI." }, RESIDENT);

    const history = rec.history(note.record_id);
    assert.equal(history.length, 3);
    assert.match(JSON.parse(history[1].content).sections.assessment, /query early pneumonia/);
    assert.equal((JSON.parse(history[2].content) as NoteContent).status, "draft");
  } finally {
    cleanup();
  }
});

test("a signed note cannot be revised", () => {
  // The rule the rest of the module exists to enforce. A refusal rather than
  // a warning, because a signed note that can be edited is indistinguishable
  // afterwards from one that was always what it now says.
  const { notes, enc1, enc2, cleanup } = desk();
  try {
    const note = startNote(notes, enc1);
    notes.sign(note.record_id, RESIDENT);

    assert.throws(
      () => notes.revise(note.record_id, { ...SOAP, assessment: "Pneumonia." }, RESIDENT),
      /signed note cannot be revised; add an addendum/
    );
  } finally {
    cleanup();
  }
});

test("a signature names a person and fixes the text", () => {
  const { notes, enc1, enc2, cleanup } = desk();
  try {
    const note = startNote(notes, enc1);
    const signed = notes.sign(note.record_id, RESIDENT);
    const content = JSON.parse(signed.content) as NoteContent;

    assert.equal(content.status, "signed");
    assert.equal(content.signedBy, "dr-hale", "an attestation attributed to the system is not an attestation");
    assert.ok(content.signedAt);
    assert.deepEqual(content.sections, SOAP);
    assert.throws(() => notes.sign(note.record_id, ATTENDING), /already signed/);
  } finally {
    cleanup();
  }
});

test("an addendum is its own record, so the note still reads as it was signed", () => {
  const { notes, enc1, enc2, cleanup } = desk();
  try {
    const note = startNote(notes, enc1);
    notes.sign(note.record_id, RESIDENT);

    const add = notes.addendum({
      recordId: note.record_id,
      sections: { note: "Chest film reported later the same day: no consolidation." },
      author: RESIDENT,
    });
    assert.notEqual(add.record_id, note.record_id, "an addition is not an edit");

    const thread = notes.thread(note.record_id);
    assert.equal(thread.length, 2);
    assert.deepEqual(thread[0].note.sections, SOAP, "the signed note is untouched");
    assert.equal(thread[0].note.status, "signed");
    assert.match(thread[1].note.sections.note, /no consolidation/);
    assert.equal(thread[1].note.addendumTo, note.record_id, "and it says what it follows");
  } finally {
    cleanup();
  }
});

test("an addendum before signature is refused, because there is nothing to add to yet", () => {
  const { notes, enc1, enc2, cleanup } = desk();
  try {
    const note = startNote(notes, enc1);
    assert.throws(
      () => notes.addendum({ recordId: note.record_id, sections: { note: "later" }, author: RESIDENT }),
      /follows a signed note; revise the draft/
    );
  } finally {
    cleanup();
  }
});

test("a co-signature is a second person taking responsibility", () => {
  const { notes, enc1, enc2, cleanup } = desk();
  try {
    const note = startNote(notes, enc1);

    assert.throws(() => notes.cosign(note.record_id, ATTENDING), /must be signed before it can be co-signed/);
    notes.sign(note.record_id, RESIDENT);

    // One signature counted twice is not two people.
    assert.throws(() => notes.cosign(note.record_id, RESIDENT), /has to come from someone else/);

    const cosigned = JSON.parse(notes.cosign(note.record_id, ATTENDING).content) as NoteContent;
    assert.equal(cosigned.signedBy, "dr-hale");
    assert.equal(cosigned.cosignedBy, "dr-tetso");
    assert.ok(cosigned.cosignedAt);
    assert.deepEqual(cosigned.sections, SOAP, "and co-signing does not change the text either");

    assert.throws(() => notes.cosign(note.record_id, ATTENDING), /already co-signed/);
  } finally {
    cleanup();
  }
});

test("a supervisor can see what is waiting on them", () => {
  const { notes, enc1, enc2, cleanup } = desk();
  try {
    const waiting = startNote(notes, enc1);
    notes.sign(waiting.record_id, RESIDENT);

    const done = notes.draft({ patientId: "NT123456", noteType: "SOAP", sections: SOAP, author: RESIDENT });
    notes.sign(done.record_id, RESIDENT);
    notes.cosign(done.record_id, ATTENDING);

    notes.draft({ patientId: "NT123456", noteType: "SOAP", sections: SOAP, author: RESIDENT });

    const queue = notes.awaitingCosignature("NT123456");
    assert.equal(queue.length, 1, "signed and uncosigned only — not drafts, not finished ones");
    assert.equal(queue[0].entry.record_id, waiting.record_id);
  } finally {
    cleanup();
  }
});

test("the signed text is covered by the chart chain", () => {
  // The refusal above stops the API changing a signed note. This stops
  // anything else: a note edited underneath the store breaks verification.
  const { db, rec, notes, enc1, cleanup } = desk();
  try {
    const note = startNote(notes, enc1);
    const signed = notes.sign(note.record_id, RESIDENT);
    assert.equal(rec.verifyChart("NT123456").ok, true);

    const tampered = JSON.stringify({ ...(JSON.parse(signed.content) as NoteContent), sections: { ...SOAP, plan: "Discharged." } });
    db.sql.prepare("UPDATE clinical_entries SET content = ? WHERE version_id = ?").run(tampered, signed.version_id);

    const v = rec.verifyChart("NT123456");
    assert.equal(v.ok, false, "a signed note rewritten in the database must not verify");
    assert.equal(v.brokenAt, signed.version_id);
  } finally {
    cleanup();
  }
});

test("notes are listed per patient and per encounter, newest first", () => {
  const { notes, enc1, enc2, cleanup } = desk();
  try {
    const first = notes.draft({ patientId: "NT123456", encounterId: enc1, noteType: "SOAP", sections: SOAP, author: RESIDENT });
    notes.sign(first.record_id, RESIDENT);
    notes.draft({ patientId: "NT123456", encounterId: enc2, noteType: "Consult", sections: SOAP, author: ATTENDING });
    notes.draft({ patientId: "NT999", noteType: "SOAP", sections: SOAP, author: RESIDENT });

    assert.equal(notes.forPatient("NT123456").length, 2);
    assert.equal(notes.forPatient("NT123456", { encounterId: enc1 }).length, 1);
    assert.equal(notes.forPatient("NT999").length, 1, "and one patient's notes are not another's");
    assert.equal(notes.forPatient("NT123456")[0].note.noteType, "Consult", "newest first");
  } finally {
    cleanup();
  }
});

test("a note retracted by a clinician is out of the working record", () => {
  const { rec, notes, enc1, cleanup } = desk();
  try {
    const note = startNote(notes, enc1);
    notes.sign(note.record_id, RESIDENT);
    rec.retract(note.record_id, { ...ATTENDING, reason: "filed on the wrong patient" });

    assert.equal(notes.forPatient("NT123456").length, 0);
    assert.throws(() => notes.addendum({ recordId: note.record_id, sections: {}, author: RESIDENT }), /entered-in-error/);
    // And still readable for the review that needs it.
    assert.equal(rec.chart("NT123456", { entryType: "DocumentReference", includeRetracted: true }).length, 1);
  } finally {
    cleanup();
  }
});
