/**
 * Clinical documentation: drafts, signatures, co-signatures and addenda.
 *
 * The distinction the whole of section 3 turns on is between a draft and a
 * signature. A draft is working text — a clinician's notes to themselves,
 * revisable, not yet an assertion about a patient. A signature is an
 * attestation: this is what I found, this is what I decided, and my name is on
 * it. After that the text must not change, because a note that can be revised
 * after signature is not evidence of anything — least of all in the review
 * where it matters most, which is always months later and always about a
 * decision somebody now regrets.
 *
 * So the rule is structural rather than procedural: `revise` refuses a signed
 * note, and the only way to say something further is an addendum, which is its
 * own record, separately signed, linked to the note it follows and visible
 * beside it. A reader sees what was signed at the time and what was added
 * afterwards, and can tell which is which.
 *
 * Built on the append-only clinical record, so a draft's earlier text is kept
 * too. That is less obviously necessary and still right: "the draft said
 * something different before the attending saw it" is exactly the kind of
 * question a serious review asks.
 */
import type { ClinicalEntry, ClinicalRecord } from "./record.ts";

export type NoteStatus = "draft" | "signed";

export interface NoteContent extends Record<string, unknown> {
  resourceType: "DocumentReference";
  /** SOAP, consult letter, discharge summary — a template id or free form. */
  noteType: string;
  /** The sections a template defines, e.g. { subjective, objective, … }. */
  sections: Record<string, string>;
  status: NoteStatus;
  /** Who attested, and when. Absent while a draft. */
  signedBy?: string;
  signedAt?: string;
  /** A second attestation, where supervision requires one. */
  cosignedBy?: string;
  cosignedAt?: string;
  /** Set on an addendum: the note it follows. */
  addendumTo?: string;
}

export interface Author {
  authorId: string;
  authorKind: string;
}

export class ClinicalNotes {
  private record: ClinicalRecord;

  constructor(record: ClinicalRecord) {
    this.record = record;
  }

  /** Starts a note. Drafts are working text and carry no attestation. */
  draft(input: {
    patientId: string;
    encounterId?: string;
    noteType: string;
    sections: Record<string, string>;
    author: Author;
  }): ClinicalEntry {
    const content: NoteContent = {
      resourceType: "DocumentReference",
      noteType: input.noteType,
      sections: input.sections,
      status: "draft",
    };
    return this.record.record({
      entryType: "DocumentReference",
      patientId: input.patientId,
      ...(input.encounterId ? { encounterId: input.encounterId } : {}),
      content,
      ...input.author,
    });
  }

  /**
   * Revises a draft. Refused once signed.
   *
   * This is the rule the rest of the module exists to enforce, and it is worth
   * being exact about why it is a refusal rather than a warning: a signed note
   * that can be edited is indistinguishable, afterwards, from one that was
   * always what it now says.
   */
  revise(recordId: string, sections: Record<string, string>, by: Author & { reason?: string }): ClinicalEntry {
    const note = this.read(recordId);
    if (note.status === "signed") {
      throw new Error("a signed note cannot be revised; add an addendum instead");
    }
    return this.record.amend(
      recordId,
      { ...note, sections },
      { authorId: by.authorId, authorKind: by.authorKind, reason: by.reason ?? "draft revised" }
    );
  }

  /**
   * Signs a note. The text is fixed from here.
   *
   * The signature names the person, not the session: an attestation attributed
   * to "the system" is not an attestation.
   */
  sign(recordId: string, by: Author): ClinicalEntry {
    const note = this.read(recordId);
    if (note.status === "signed") throw new Error("this note is already signed");
    const content: NoteContent = {
      ...note,
      status: "signed",
      signedBy: by.authorId,
      signedAt: new Date().toISOString(),
    };
    return this.record.amend(recordId, content, {
      ...by,
      reason: `signed by ${by.authorId}`,
    });
  }

  /**
   * Adds a second attestation, where supervision requires one.
   *
   * Refused before the note is signed and refused from the author: a
   * co-signature is a second person taking responsibility, and one signature
   * counted twice is not that.
   */
  cosign(recordId: string, by: Author): ClinicalEntry {
    const note = this.read(recordId);
    if (note.status !== "signed") throw new Error("a note must be signed before it can be co-signed");
    if (note.cosignedBy) throw new Error("this note is already co-signed");
    if (note.signedBy === by.authorId) throw new Error("a co-signature has to come from someone else");
    return this.record.amend(
      recordId,
      { ...note, cosignedBy: by.authorId, cosignedAt: new Date().toISOString() },
      { ...by, reason: `co-signed by ${by.authorId}` }
    );
  }

  /**
   * Says something further about a signed note.
   *
   * Its own record rather than an edit, so the note reads as it was signed and
   * the addition reads as an addition. A reader can always tell what was known
   * at the time from what was added after.
   */
  addendum(input: {
    recordId: string;
    sections: Record<string, string>;
    author: Author;
    encounterId?: string;
  }): ClinicalEntry {
    const note = this.read(input.recordId);
    if (note.status !== "signed") {
      throw new Error("an addendum follows a signed note; revise the draft instead");
    }
    const original = this.record.current(input.recordId)!;
    const content: NoteContent = {
      resourceType: "DocumentReference",
      noteType: note.noteType,
      sections: input.sections,
      status: "draft",
      addendumTo: input.recordId,
    };
    return this.record.record({
      entryType: "DocumentReference",
      patientId: original.patient_id,
      ...(input.encounterId ?? original.encounter_id ? { encounterId: input.encounterId ?? original.encounter_id! } : {}),
      content,
      ...input.author,
    });
  }

  /** A note and everything added to it, in the order it was written. */
  thread(recordId: string): Array<{ entry: ClinicalEntry; note: NoteContent }> {
    const root = this.record.current(recordId);
    if (!root) return [];
    const out = [{ entry: root, note: JSON.parse(root.content) as NoteContent }];
    for (const e of this.record.chart(root.patient_id, { entryType: "DocumentReference" })) {
      const note = JSON.parse(e.content) as NoteContent;
      if (note.addendumTo === recordId) out.push({ entry: e, note });
    }
    return out;
  }

  /** Notes for a patient, newest first, optionally for one encounter. */
  forPatient(patientId: string, opts: { encounterId?: string } = {}): Array<{ entry: ClinicalEntry; note: NoteContent }> {
    return this.record
      .chart(patientId, { entryType: "DocumentReference", ...opts })
      .map((entry) => ({ entry, note: JSON.parse(entry.content) as NoteContent }))
      .reverse();
  }

  /** Signed notes awaiting a co-signature, for a supervisor's queue. */
  awaitingCosignature(patientId: string): Array<{ entry: ClinicalEntry; note: NoteContent }> {
    return this.forPatient(patientId).filter(
      ({ note }) => note.status === "signed" && !note.cosignedBy && !note.addendumTo
    );
  }

  private read(recordId: string): NoteContent {
    const current = this.record.current(recordId);
    if (!current) throw new Error(`no note ${recordId}`);
    if (current.status === "entered-in-error") throw new Error("this note is marked entered-in-error");
    return JSON.parse(current.content) as NoteContent;
  }
}
