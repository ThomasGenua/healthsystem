/**
 * What a patient tells the clinic before it tells them anything back.
 *
 * Item 60 bundles four things that look different and fail the same way if
 * they are not kept honest about what they are:
 *
 *   - a questionnaire, versioned so an answer from March still shows the
 *     question that was actually asked after the form changes in April
 *   - a visit concern, and a proposed medication change — both patient
 *     testimony, neither a clinical fact until somebody with authority to
 *     assert one reads it
 *   - a document upload, which is a file from the public internet arriving
 *     inside a chart's trust boundary
 *
 * ## A draft is not a chart entry
 *
 * `ClinicalRecord` has no update path by design — see record.ts — and that
 * is exactly wrong for something typed into over several sittings and a
 * dropped hotel wifi connection. So a submission lives in an ordinary mutable
 * table, the same category `med_reconciliations` already occupies, right up
 * until `submit()`. At that moment, and only then, it is frozen and the one
 * fact that belongs on the chart is written once: what was actually
 * submitted. Saving a draft nine times produces nine updates to one row.
 * Submitting it twice produces one QuestionnaireResponse, because the second
 * call finds nothing left in `draft` to submit and hands back what the first
 * call already produced — the same shape as an interrupted request retried
 * after the reply was lost, which is the ordinary way a patient's connection
 * actually fails.
 *
 * ## Testimony is not a chart update
 *
 * A proposed medication change is stored as exactly that: proposed, by the
 * patient, and read by nobody until a clinician looks at the review task.
 * Nothing here calls into `MedicationStore`. A patient's account of what they
 * take is real information and it is not the same speech act as a clinician
 * reconciling the list — collapsing the two is how a chart ends up saying a
 * patient is on a medication because they mentioned starting it, which
 * nobody with prescribing authority ever confirmed.
 *
 * ## Quarantine means nothing serves the bytes
 *
 * `Uploads.receive()` never marks a file clean — a store cannot honestly
 * vouch for bytes it did not examine, so a file sits `pending-scan` until a
 * configured `MalwareScanner` says otherwise. No scanner configured is not a
 * default of "probably fine"; it is every upload staying quarantined
 * indefinitely, visible as such rather than silently served, which is the
 * same choice src/meds/safety.ts makes about an interaction database nobody
 * configured: unchecked is reported as unchecked, never quietly as clear. An
 * infected verdict does not just set a flag — the bytes are deleted from the
 * row, so no later code path can serve them by forgetting to check status.
 */
import { randomUUID } from "node:crypto";
import type { Db } from "../db.ts";
import { refuse } from "../core/refusal.ts";
import { ClinicalRecord } from "../clinical/record.ts";
import { PatientDocuments, payloadSize } from "../clinical/documents.ts";

export interface Actor {
  actorId: string;
  actorKind: string;
}

/** The minimal shape this needs from TaskStore — see discharge.ts for the same loose coupling. */
export interface ReviewInbox {
  create(input: {
    kind: "portal-submission";
    title: string;
    patientId: string;
    source: string;
    correlationId: string;
    by: Actor;
  }): { id: string };
  complete(taskId: string, by: Actor & { evidence: string }): unknown;
}

// ---------------------------------------------------------------- Questionnaires

export type QuestionType = "text" | "boolean" | "choice" | "number";

export interface Question {
  key: string;
  label: string;
  type: QuestionType;
  required?: boolean;
  /** For type "choice" only. */
  options?: string[];
}

export interface QuestionnaireRow {
  tenant_id: string;
  id: string;
  version: number;
  title: string;
  /** JSON-encoded Question[]. */
  questions: string;
  status: "active" | "retired";
  published_by: string;
  published_at: string;
}

function validateQuestions(questions: Question[]): void {
  if (questions.length === 0) refuse("a questionnaire needs at least one question");
  const keys = new Set<string>();
  for (const q of questions) {
    if (!q.key.trim()) refuse("every question needs a key");
    if (keys.has(q.key)) refuse(`duplicate question key ${q.key}`);
    keys.add(q.key);
    if (!q.label.trim()) refuse(`question ${q.key} needs a label`);
    if (!["text", "boolean", "choice", "number"].includes(q.type)) {
      refuse(`question ${q.key} has an unknown type ${q.type}`);
    }
    if (q.type === "choice" && (!q.options || q.options.length < 2)) {
      refuse(`question ${q.key} is a choice and needs at least two options`);
    }
  }
}

/**
 * Questionnaire definitions, clinic-authored and versioned.
 *
 * `publish()` always inserts a new row; there is no edit. A deployment that
 * wants to fix a typo in question 4 publishes version 2, and every answer
 * already on file keeps pointing at version 1 — the version it actually
 * answered, not a retroactively different one.
 */
export class Questionnaires {
  private db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  publish(input: { id: string; title: string; questions: Question[]; by: Actor }): QuestionnaireRow {
    if (!input.id.trim()) refuse("a questionnaire needs an id");
    if (!input.title.trim()) refuse("a questionnaire needs a title");
    validateQuestions(input.questions);

    return this.db.transaction(() => {
      const latest = this.db.sql
        .prepare("SELECT MAX(version) AS v FROM intake_questionnaires WHERE tenant_id = ? AND id = ?")
        .get(this.db.tenantId, input.id) as { v: number | null };
      const version = (latest?.v ?? 0) + 1;
      const now = new Date().toISOString();
      // The previous version is not deleted or edited — every submission
      // that already named it must keep finding it exactly as it was.
      if (version > 1) {
        this.db.sql
          .prepare(
            "UPDATE intake_questionnaires SET status = 'retired' WHERE tenant_id = ? AND id = ? AND status = 'active'"
          )
          .run(this.db.tenantId, input.id);
      }
      this.db.sql
        .prepare(
          `INSERT INTO intake_questionnaires (tenant_id, id, version, title, questions, status, published_by, published_at)
           VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`
        )
        .run(this.db.tenantId, input.id, version, input.title.trim(), JSON.stringify(input.questions), input.by.actorId, now);
      return this.get(input.id, version)!;
    });
  }

  get(id: string, version?: number): QuestionnaireRow | undefined {
    if (version !== undefined) {
      return this.db.sql
        .prepare("SELECT * FROM intake_questionnaires WHERE tenant_id = ? AND id = ? AND version = ?")
        .get(this.db.tenantId, id, version) as unknown as QuestionnaireRow | undefined;
    }
    return this.db.sql
      .prepare(
        "SELECT * FROM intake_questionnaires WHERE tenant_id = ? AND id = ? AND status = 'active' ORDER BY version DESC LIMIT 1"
      )
      .get(this.db.tenantId, id) as unknown as QuestionnaireRow | undefined;
  }

  /** The active version of every published questionnaire — what a patient is offered to fill in. */
  list(): QuestionnaireRow[] {
    return this.db.sql
      .prepare("SELECT * FROM intake_questionnaires WHERE tenant_id = ? AND status = 'active' ORDER BY title")
      .all(this.db.tenantId) as unknown as QuestionnaireRow[];
  }
}

// ------------------------------------------------------------------ Submissions

export type MedChangeKind = "started" | "stopped" | "changed";
export interface ProposedMedChange {
  change: MedChangeKind;
  description: string;
}

export type SubmissionStatus = "draft" | "submitted" | "reviewed";
export type ReviewOutcome = "accepted" | "noted" | "needs-follow-up";

export interface SubmissionRow {
  tenant_id: string;
  id: string;
  patient_id: string;
  appointment_id: string | null;
  questionnaire_id: string | null;
  questionnaire_version: number | null;
  status: SubmissionStatus;
  answers: string;
  concern: string | null;
  proposed_meds: string | null;
  started_by: string;
  started_at: string;
  updated_at: string;
  submitted_at: string | null;
  record_id: string | null;
  task_id: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_outcome: ReviewOutcome | null;
  review_note: string | null;
}

const MED_CHANGE_KINDS: MedChangeKind[] = ["started", "stopped", "changed"];

export class IntakeSubmissions {
  private db: Db;
  private questionnaires: Questionnaires;
  private clinical: ClinicalRecord;
  private tasks: ReviewInbox | undefined;

  constructor(db: Db, questionnaires: Questionnaires, clinical: ClinicalRecord, tasks?: ReviewInbox) {
    this.db = db;
    this.questionnaires = questionnaires;
    this.clinical = clinical;
    this.tasks = tasks;
  }

  private require(id: string): SubmissionRow {
    const row = this.db.sql
      .prepare("SELECT * FROM intake_submissions WHERE tenant_id = ? AND id = ?")
      .get(this.db.tenantId, id) as unknown as SubmissionRow | undefined;
    if (!row) refuse(`no intake submission ${id}`, 404);
    return row;
  }

  /**
   * Starts or continues a draft. The same (patient, questionnaire,
   * appointment) while a draft is open is the same row — a dropped
   * connection resumes it; it does not fork a second draft nobody merges.
   *
   * Answers merge over what is already saved, because an autosave typically
   * carries one changed field, not the whole form; omitting concern or
   * proposedMeds leaves whatever was saved for them alone.
   */
  saveDraft(input: {
    patientId: string;
    questionnaireId?: string;
    appointmentId?: string;
    answers?: Record<string, unknown>;
    concern?: string;
    proposedMeds?: ProposedMedChange[];
    by: Actor;
  }): SubmissionRow {
    if (!input.patientId.trim()) refuse("a draft needs a patient");
    let questionnaireVersion: number | null = null;
    if (input.questionnaireId) {
      const q = this.questionnaires.get(input.questionnaireId);
      if (!q) refuse(`no active questionnaire ${input.questionnaireId}`);
      questionnaireVersion = q.version;
    }
    if (input.proposedMeds) {
      for (const m of input.proposedMeds) {
        if (!MED_CHANGE_KINDS.includes(m.change)) refuse(`unknown medication change ${m.change}`);
        if (!m.description.trim()) refuse("a proposed medication change needs a description");
      }
    }

    return this.db.transaction(() => {
      const existing = this.db.sql
        .prepare(
          `SELECT * FROM intake_submissions
            WHERE tenant_id = ? AND patient_id = ? AND status = 'draft'
              AND COALESCE(questionnaire_id, '') = COALESCE(?, '')
              AND COALESCE(appointment_id, '') = COALESCE(?, '')`
        )
        .get(this.db.tenantId, input.patientId, input.questionnaireId ?? null, input.appointmentId ?? null) as unknown as
        | SubmissionRow
        | undefined;

      const now = new Date().toISOString();
      if (existing) {
        const mergedAnswers = { ...JSON.parse(existing.answers), ...(input.answers ?? {}) };
        this.db.sql
          .prepare(
            `UPDATE intake_submissions
                SET answers = ?, concern = COALESCE(?, concern), proposed_meds = COALESCE(?, proposed_meds), updated_at = ?
              WHERE tenant_id = ? AND id = ? AND status = 'draft'`
          )
          .run(
            JSON.stringify(mergedAnswers),
            input.concern ?? null,
            input.proposedMeds ? JSON.stringify(input.proposedMeds) : null,
            now,
            this.db.tenantId,
            existing.id
          );
        return this.require(existing.id);
      }

      const id = randomUUID();
      this.db.sql
        .prepare(
          `INSERT INTO intake_submissions
             (tenant_id, id, patient_id, appointment_id, questionnaire_id, questionnaire_version, status,
              answers, concern, proposed_meds, started_by, started_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?)`
        )
        .run(
          this.db.tenantId,
          id,
          input.patientId,
          input.appointmentId ?? null,
          input.questionnaireId ?? null,
          questionnaireVersion,
          JSON.stringify(input.answers ?? {}),
          input.concern ?? null,
          input.proposedMeds ? JSON.stringify(input.proposedMeds) : null,
          input.by.actorId,
          now,
          now
        );
      return this.require(id);
    });
  }

  get(id: string): SubmissionRow {
    return this.require(id);
  }

  forPatient(patientId: string): SubmissionRow[] {
    return this.db.sql
      .prepare("SELECT * FROM intake_submissions WHERE tenant_id = ? AND patient_id = ? ORDER BY started_at DESC")
      .all(this.db.tenantId, patientId) as unknown as SubmissionRow[];
  }

  /**
   * Freezes the draft and raises it for clinician review.
   *
   * Idempotent: a submission that is already submitted or reviewed is
   * returned as-is rather than refused, because the honest reason to call
   * this twice is a client that timed out waiting for the first reply and
   * cannot tell whether it landed. Retrying must not produce a second
   * QuestionnaireResponse or a second review task.
   */
  submit(id: string, by: Actor): SubmissionRow {
    const row = this.require(id);
    if (row.status !== "draft") return row;

    let questions: Question[] = [];
    if (row.questionnaire_id) {
      const q = this.questionnaires.get(row.questionnaire_id, row.questionnaire_version ?? undefined);
      if (!q) refuse(`questionnaire ${row.questionnaire_id} version ${row.questionnaire_version} no longer exists`);
      questions = JSON.parse(q.questions) as Question[];
    }
    const answers = JSON.parse(row.answers) as Record<string, unknown>;
    for (const q of questions) {
      const v = answers[q.key];
      if (q.required && (v === undefined || v === null || v === "")) {
        refuse(`"${q.label}" is required before this can be submitted`);
      }
    }
    if (!row.questionnaire_id && !row.concern?.trim() && !row.proposed_meds) {
      refuse("an intake submission with no questionnaire, concern or proposed medication change is empty");
    }

    return this.db.transaction(() => {
      const now = new Date().toISOString();
      const entry = this.clinical.record({
        entryType: "QuestionnaireResponse",
        patientId: row.patient_id,
        authorId: by.actorId,
        authorKind: by.actorKind,
        content: {
          resourceType: "QuestionnaireResponse",
          status: "completed",
          authored: now,
          ...(row.questionnaire_id
            ? { questionnaire: `${row.questionnaire_id}/${row.questionnaire_version}`, item: answers }
            : {}),
          ...(row.concern ? { concern: row.concern } : {}),
          ...(row.proposed_meds ? { proposedMedicationChanges: JSON.parse(row.proposed_meds) } : {}),
        },
      });

      let taskId: string | null = null;
      if (this.tasks) {
        const task = this.tasks.create({
          kind: "portal-submission",
          title: row.concern ? "Pre-visit intake: patient raised a concern" : "Pre-visit intake submitted",
          patientId: row.patient_id,
          source: "patient-intake",
          correlationId: row.id,
          by,
        });
        taskId = task.id;
      }

      const updated = this.db.sql
        .prepare(
          `UPDATE intake_submissions
              SET status = 'submitted', submitted_at = ?, updated_at = ?, record_id = ?, task_id = ?
            WHERE tenant_id = ? AND id = ? AND status = 'draft'`
        )
        .run(now, now, entry.record_id, taskId, this.db.tenantId, id);
      // Lost the race with another submit() of the same draft. Whichever
      // commits first wins; this call reports that outcome rather than its
      // own — a second QuestionnaireResponse would otherwise exist for
      // testimony the patient only actually gave once.
      if (updated.changes === 0) return this.require(id);
      return this.require(id);
    });
  }

  /**
   * A clinician's disposition of a submitted intake. Completes the review
   * task at the same time, so the worklist and this row cannot disagree
   * about whether somebody looked.
   */
  review(id: string, input: { outcome: ReviewOutcome; note: string; by: Actor }): SubmissionRow {
    const row = this.require(id);
    if (row.status !== "submitted") refuse(`intake submission ${id} is ${row.status}, not awaiting review`);
    if (!input.note.trim()) refuse("reviewing an intake submission needs a written note");
    if (!["accepted", "noted", "needs-follow-up"].includes(input.outcome)) {
      refuse(`unknown review outcome ${input.outcome}`);
    }

    return this.db.transaction(() => {
      if (this.tasks && row.task_id) {
        this.tasks.complete(row.task_id, { ...input.by, evidence: input.note.trim() });
      }
      const now = new Date().toISOString();
      const updated = this.db.sql
        .prepare(
          `UPDATE intake_submissions
              SET status = 'reviewed', reviewed_by = ?, reviewed_at = ?, review_outcome = ?, review_note = ?, updated_at = ?
            WHERE tenant_id = ? AND id = ? AND status = 'submitted'`
        )
        .run(input.by.actorId, now, input.outcome, input.note.trim(), now, this.db.tenantId, id);
      if (updated.changes === 0) refuse(`intake submission ${id} was reviewed by somebody else just now`, 409);
      return this.require(id);
    });
  }

  /** Submitted and waiting — the queue behind the review tasks, for a screen that wants the rows directly. */
  open(): SubmissionRow[] {
    return this.db.sql
      .prepare("SELECT * FROM intake_submissions WHERE tenant_id = ? AND status = 'submitted' ORDER BY submitted_at")
      .all(this.db.tenantId) as unknown as SubmissionRow[];
  }
}

// ---------------------------------------------------------------------- Uploads

/**
 * The EICAR test string: a standard, harmless ASCII file every antivirus
 * vendor recognizes on purpose, published exactly so a scanning pipeline can
 * be exercised without a real virus anywhere near it. See
 * https://www.eicar.org/download-anti-malware-testfile/. SyntheticScanner
 * flags it and nothing else — this is not malware protection.
 */
export const EICAR_TEST_STRING =
  "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

export interface ScanVerdict {
  verdict: "clean" | "infected";
  note?: string;
}

export interface MalwareScanner {
  scan(bytes: Buffer, filename: string): ScanVerdict | Promise<ScanVerdict>;
}

/**
 * A synthetic scanner for development and demonstration. It recognizes
 * exactly the EICAR test string and nothing else, so the infected path can
 * be exercised honestly without shipping or transmitting an actual virus.
 * Wiring this in production in place of a real scanner would make every
 * quarantine claim in this module false; it exists for scripts/portal-demo.ts
 * and for tests, the same way DevIdentityProvider exists for sign-in.
 */
export class SyntheticScanner implements MalwareScanner {
  scan(bytes: Buffer): ScanVerdict {
    if (bytes.includes(EICAR_TEST_STRING, 0, "ascii")) {
      return { verdict: "infected", note: "matched the EICAR antivirus test string" };
    }
    return { verdict: "clean", note: "synthetic scanner: pattern match only, not a real scan" };
  }
}

export const INTAKE_CONTENT_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "text/plain",
  "text/csv",
] as const;
export type IntakeContentType = (typeof INTAKE_CONTENT_TYPES)[number];

/** A phone photo of a form or a pill bottle is the common case; this is generous, not a file server. */
export const INTAKE_UPLOAD_MAX_BYTES = 8 * 1024 * 1024;

export interface UploadRow {
  tenant_id: string;
  id: string;
  patient_id: string;
  submission_id: string | null;
  filename: string;
  content_type: string;
  size: number;
  data: string | null;
  status: "pending-scan" | "clean" | "infected";
  scanned_at: string | null;
  scanner_note: string | null;
  document_record_id: string | null;
  uploaded_by: string;
  uploaded_at: string;
}

export class Uploads {
  private db: Db;
  private documents: PatientDocuments;
  private tasks: ReviewInbox | undefined;
  private scanner: MalwareScanner | undefined;

  constructor(db: Db, documents: PatientDocuments, opts: { tasks?: ReviewInbox; scanner?: MalwareScanner } = {}) {
    this.db = db;
    this.documents = documents;
    this.tasks = opts.tasks;
    this.scanner = opts.scanner;
  }

  private require(id: string): UploadRow {
    const row = this.db.sql
      .prepare("SELECT * FROM intake_uploads WHERE tenant_id = ? AND id = ?")
      .get(this.db.tenantId, id) as unknown as UploadRow | undefined;
    if (!row) refuse(`no upload ${id}`, 404);
    return row;
  }

  /**
   * Stores a file as pending-scan. Never returns anything but pending-scan —
   * receive() is not where a file becomes safe, scanOne()/scanPending() are.
   */
  receive(input: {
    patientId: string;
    submissionId?: string;
    filename: string;
    contentType: string;
    data: string;
    by: Actor;
  }): UploadRow {
    if (!input.filename.trim()) refuse("an upload needs a filename");
    if (!(INTAKE_CONTENT_TYPES as readonly string[]).includes(input.contentType)) {
      refuse(
        `refused content type ${input.contentType}; a chart is not a place for HTML, SVG or executables (allowed: ${INTAKE_CONTENT_TYPES.join(", ")})`
      );
    }
    const size = payloadSize(input.data, input.contentType);
    if (size === 0) refuse("an upload needs content");
    if (size > INTAKE_UPLOAD_MAX_BYTES) {
      refuse(`an upload over ${INTAKE_UPLOAD_MAX_BYTES} bytes is refused, not stored`);
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.sql
      .prepare(
        `INSERT INTO intake_uploads
           (tenant_id, id, patient_id, submission_id, filename, content_type, size, data, status, uploaded_by, uploaded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending-scan', ?, ?)`
      )
      .run(
        this.db.tenantId,
        id,
        input.patientId,
        input.submissionId ?? null,
        input.filename.trim(),
        input.contentType,
        size,
        input.data,
        input.by.actorId,
        now
      );
    return this.require(id);
  }

  /**
   * Runs the configured scanner against one pending upload. Refuses if none
   * is configured, rather than silently leaving the file pending forever
   * with no way for an operator to discover why — the refusal is what makes
   * a missing scanner an operational fact instead of a quiet gap.
   */
  async scanOne(id: string, by: Actor): Promise<UploadRow> {
    if (!this.scanner) refuse("no malware scanner is configured; this upload cannot be scanned");
    const row = this.require(id);
    if (row.status !== "pending-scan") return row;
    if (row.data === null) refuse(`upload ${id} has no content to scan`);

    const result = await this.scanner.scan(Buffer.from(row.data, "base64"), row.filename);
    const now = new Date().toISOString();

    return this.db.transaction(() => {
      if (result.verdict === "infected") {
        this.db.sql
          .prepare(
            `UPDATE intake_uploads SET status = 'infected', data = NULL, scanned_at = ?, scanner_note = ?
              WHERE tenant_id = ? AND id = ? AND status = 'pending-scan'`
          )
          .run(now, result.note ?? "flagged", this.db.tenantId, id);
        return this.require(id);
      }

      // Clean: file it as a chart document and, if it is not riding a
      // submission that will raise its own task on submit, raise one now —
      // an uploaded letter deserves the same "somebody looks at this"
      // guarantee as a submitted questionnaire.
      const filed = this.documents.receive({
        patientId: row.patient_id,
        title: row.filename,
        source: "patient-submitted",
        receivedAt: now,
        by: { authorId: by.actorId, authorKind: by.actorKind },
        contentType: row.content_type,
        data: row.data!,
      });
      let taskId: string | null = null;
      if (this.tasks && !row.submission_id) {
        const task = this.tasks.create({
          kind: "portal-submission",
          title: `Patient uploaded a document: ${row.filename}`,
          patientId: row.patient_id,
          source: "patient-intake",
          correlationId: row.id,
          by,
        });
        taskId = task.id;
      }
      this.db.sql
        .prepare(
          `UPDATE intake_uploads
              SET status = 'clean', scanned_at = ?, scanner_note = ?, document_record_id = ?
            WHERE tenant_id = ? AND id = ? AND status = 'pending-scan'`
        )
        .run(now, result.note ?? null, filed.recordId, this.db.tenantId, id);
      void taskId;
      return this.require(id);
    });
  }

  /** A worker sweep: scans up to `limit` pending uploads with the configured scanner. */
  async scanPending(by: Actor, limit = 50): Promise<{ scanned: number; clean: number; infected: number }> {
    if (!this.scanner) return { scanned: 0, clean: 0, infected: 0 };
    const pending = this.db.sql
      .prepare("SELECT id FROM intake_uploads WHERE tenant_id = ? AND status = 'pending-scan' ORDER BY uploaded_at LIMIT ?")
      .all(this.db.tenantId, limit) as unknown as { id: string }[];
    let clean = 0;
    let infected = 0;
    for (const { id } of pending) {
      const row = await this.scanOne(id, by);
      if (row.status === "clean") clean++;
      else if (row.status === "infected") infected++;
    }
    return { scanned: pending.length, clean, infected };
  }

  /** Metadata only, never the payload — for looking up whose upload this is before acting on it. */
  get(id: string): Omit<UploadRow, "data"> {
    const { data: _data, ...rest } = this.require(id);
    return rest;
  }

  /** Metadata only, for a list — never the payload. Mirrors PatientDocuments.forPatient(). */
  forPatient(patientId: string): Omit<UploadRow, "data">[] {
    return (
      this.db.sql
        .prepare("SELECT * FROM intake_uploads WHERE tenant_id = ? AND patient_id = ? ORDER BY uploaded_at DESC")
        .all(this.db.tenantId, patientId) as unknown as UploadRow[]
    ).map(({ data: _data, ...rest }) => rest);
  }

  /**
   * The bytes, and only the bytes of a file that passed scanning. Every
   * caller of this — including the patient who uploaded it — goes through
   * the same permission and tenant boundary as any other download, because
   * quarantine is a property of the file, not of who is asking.
   */
  download(id: string): { filename: string; contentType: string; data: string } {
    const row = this.require(id);
    if (row.status === "pending-scan") refuse("this file is still being scanned and is not available yet", 409);
    if (row.status === "infected") refuse("this file was flagged and cannot be downloaded", 403);
    if (row.data === null) refuse(`upload ${id} has no content`, 404);
    return { filename: row.filename, contentType: row.content_type, data: row.data };
  }
}
