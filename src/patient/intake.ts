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
 * ## A visit is a fact the server checks, not a field the caller fills in
 *
 * `appointment_id` decides whether the clinic board reads a visit as prepared
 * — `submittedForAppointments()` answers "which of today's appointments have
 * a form behind them" by that column alone. So it cannot be a string the
 * caller supplies and nothing verifies. A portal that only *offers* the
 * patient their own upcoming visits is a UI, and a UI is not an authorisation
 * boundary: an id typed into the request instead of chosen from the list
 * would attach one person's form to another person's appointment, and the
 * second person would drop off the "coming in with nothing sent in" panel
 * having sent in nothing. That is the exact hazard the per-visit question was
 * added to answer, inverted. So a named appointment is looked up here, in
 * this tenant, and has to be that patient's and not cancelled.
 *
 * ## One form per visit, and a refusal rather than a second opinion
 *
 * `submit()` is idempotent for the same draft, which covers the retry. It
 * does not cover two browser tabs: the second tab was rendered before the
 * first one submitted, so it holds no draft id, opens a *new* draft and
 * submits that — two QuestionnaireResponses and two review tasks for one
 * visit, the later one carrying the older answers. So opening a second draft
 * for a visit that already has a submitted form is refused, at the earliest
 * point it can be, rather than discovered by a clinician reading two
 * conflicting accounts of the same conversation. The refusal names what is
 * already on file; it does not quietly return the old row, because a patient
 * whose newly typed answers were discarded should be told, not reassured.
 *
 * Only when a visit is named. Two general concerns with no appointment
 * between them are two things a patient wanted to say, not one said twice.
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

/**
 * The minimal shape this needs from the schedule — see `ReviewInbox` above
 * for the same loose coupling, and `Actions` in clinical/actions.ts for the
 * same get()-only adapter around a store this one does not otherwise touch.
 *
 * Tenant scoping is the caller's: `Schedule.booking()` is already bound to
 * one tenant, so an id belonging to another custodian resolves to nothing
 * here rather than to somebody else's appointment.
 */
export interface VisitLookup {
  booking(id: string): { id: string; patient_id: string; status: string } | undefined;
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
  private visits: VisitLookup | undefined;

  constructor(
    db: Db,
    questionnaires: Questionnaires,
    clinical: ClinicalRecord,
    tasks?: ReviewInbox,
    visits?: VisitLookup
  ) {
    this.db = db;
    this.questionnaires = questionnaires;
    this.clinical = clinical;
    this.tasks = tasks;
    this.visits = visits;
  }

  /**
   * Resolves the visit a form says it is for, or refuses.
   *
   * One message for "no such appointment" and for "somebody else's
   * appointment", deliberately. The caller here is a patient portal, and two
   * distinguishable answers would let an authenticated patient ask this
   * boundary which arbitrary identifiers exist — an enumeration oracle over
   * other people's bookings, paid for in nothing but a slightly less
   * specific error for the one case nobody hits by accident.
   */
  private requireVisitOf(patientId: string, appointmentId: string): void {
    if (!this.visits) {
      // A deployment with no schedule wired cannot answer the question, and
      // an unverified appointment id is the whole hazard. Storing one
      // anyway would put the board's "prepared" back on the caller's word.
      refuse("this deployment cannot attach an intake form to a visit: no schedule is wired", 409);
    }
    const booking = this.visits.booking(appointmentId);
    if (!booking || booking.patient_id !== patientId) {
      refuse(`no appointment ${appointmentId} for this patient`, 404);
    }
    if (booking.status === "cancelled") {
      refuse(`appointment ${appointmentId} was cancelled; this form is not preparation for it`, 409);
    }
    // Deliberately not refused: an appointment whose start time has passed.
    // A patient filling the form in the waiting room at 09:05 for a 09:00
    // appointment is the ordinary case, and a clock this close to the
    // boundary is the wrong thing to refuse a medication list over. The
    // portal offers only future visits; the server does not turn that
    // presentation choice into a rule.
  }

  private require(id: string): SubmissionRow {
    const row = this.find(id);
    if (!row) refuse(`no intake submission ${id}`, 404);
    return row;
  }

  /**
   * The submission, or undefined. For a caller that decides for itself what
   * to say about an id that is not there — the patient boundary, which must
   * not answer "no such form" to somebody it would answer "not yours" for a
   * real one.
   */
  find(id: string): SubmissionRow | undefined {
    return this.db.sql
      .prepare("SELECT * FROM intake_submissions WHERE tenant_id = ? AND id = ?")
      .get(this.db.tenantId, id) as unknown as SubmissionRow | undefined;
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
    // Before the transaction, because it is a refusal about the request
    // rather than a decision about stored rows, and because the board reads
    // this column as though somebody had checked it.
    if (input.appointmentId) this.requireVisitOf(input.patientId, input.appointmentId);

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

      // No draft open, and a visit named. If a form for this visit has
      // already been sent in, this is a second tab rather than a second
      // conversation — see "One form per visit" at the top of this file.
      if (input.appointmentId) {
        const sent = this.db.sql
          .prepare(
            `SELECT id, status, submitted_at FROM intake_submissions
              WHERE tenant_id = ? AND patient_id = ? AND status != 'draft'
                AND COALESCE(questionnaire_id, '') = COALESCE(?, '')
                AND appointment_id = ?
              ORDER BY submitted_at DESC LIMIT 1`
          )
          .get(this.db.tenantId, input.patientId, input.questionnaireId ?? null, input.appointmentId) as unknown as
          | { id: string; status: SubmissionStatus; submitted_at: string }
          | undefined;
        if (sent) {
          refuse(
            `a form for this visit was already sent in on ${sent.submitted_at} and is ${sent.status}; ` +
              "reload to see it, and send anything further as a message rather than a second form",
            409
          );
        }
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
      // The same rule saveDraft() applies, held again here because this is
      // where the chart document is written. saveDraft() refuses the second
      // tab early, before the patient types more; this is the invariant, and
      // it also covers a draft opened before that check existed -- a patient
      // who had a draft and a submitted form for one visit on the day this
      // shipped would otherwise still produce the duplicate on submit.
      if (row.appointment_id) {
        const sent = this.db.sql
          .prepare(
            `SELECT submitted_at, status FROM intake_submissions
              WHERE tenant_id = ? AND patient_id = ? AND id != ? AND status != 'draft'
                AND COALESCE(questionnaire_id, '') = COALESCE(?, '')
                AND appointment_id = ?
              LIMIT 1`
          )
          .get(this.db.tenantId, row.patient_id, row.id, row.questionnaire_id, row.appointment_id) as unknown as
          | { submitted_at: string; status: SubmissionStatus }
          | undefined;
        if (sent) {
          refuse(
            `a form for this visit was already sent in on ${sent.submitted_at} and is ${sent.status}; ` +
              "this draft was not sent, so there is still one account of the visit on the chart",
            409
          );
        }
      }

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
  /**
   * Which of these appointments already have a submitted intake.
   *
   * Answers the board's half of the question — who is expected and has not
   * sent anything — and answers it per *visit*, because that is what an
   * intake is preparation for. A form submitted before last year's visit
   * says nothing about this one, and counting it would tell a clinician
   * they had a current medication list when they do not.
   *
   * A submission attached to no appointment covers no appointment. Null is
   * not a wildcard here for the same reason it is not one in a
   * patient-scoped search: the conservative direction is a visit that shows
   * as unprepared when a form exists somewhere, not a visit that shows as
   * ready when nothing was sent for it.
   */
  submittedForAppointments(appointmentIds: string[]): Set<string> {
    if (appointmentIds.length === 0) return new Set();
    const rows = this.db.sql
      .prepare(
        `SELECT DISTINCT appointment_id FROM intake_submissions
          WHERE tenant_id = ? AND submitted_at IS NOT NULL
            AND appointment_id IN (${appointmentIds.map(() => "?").join(", ")})`
      )
      .all(this.db.tenantId, ...appointmentIds) as Array<{ appointment_id: string }>;
    return new Set(rows.map((r) => r.appointment_id));
  }

  open(): SubmissionRow[] {
    return this.db.sql
      .prepare("SELECT * FROM intake_submissions WHERE tenant_id = ? AND status = 'submitted' ORDER BY submitted_at")
      .all(this.db.tenantId) as unknown as SubmissionRow[];
  }

  /**
   * Every submission that entered the review queue in a window, whatever has
   * happened to it since — reviewed, or still waiting. A draft never
   * submitted has no reviewer waiting on it and is not part of this
   * question, so it is not here regardless of when it was started.
   */
  submittedBetween(from: string, to: string): SubmissionRow[] {
    return this.db.sql
      .prepare(
        `SELECT * FROM intake_submissions
          WHERE tenant_id = ? AND submitted_at IS NOT NULL AND submitted_at >= ? AND submitted_at <= ?
          ORDER BY submitted_at`
      )
      .all(this.db.tenantId, from, to) as unknown as SubmissionRow[];
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

/** The one thing an upload needs from the forms: whose a submission is. See `VisitLookup`. */
export interface FormLookup {
  find(id: string): { patient_id: string } | undefined;
}

export class Uploads {
  private db: Db;
  private documents: PatientDocuments;
  private tasks: ReviewInbox | undefined;
  private scanner: MalwareScanner | undefined;
  private forms: FormLookup | undefined;

  constructor(
    db: Db,
    documents: PatientDocuments,
    opts: { tasks?: ReviewInbox; scanner?: MalwareScanner; forms?: FormLookup } = {}
  ) {
    this.db = db;
    this.documents = documents;
    this.tasks = opts.tasks;
    this.scanner = opts.scanner;
    this.forms = opts.forms;
  }

  private row(id: string): UploadRow | undefined {
    return this.db.sql
      .prepare("SELECT * FROM intake_uploads WHERE tenant_id = ? AND id = ?")
      .get(this.db.tenantId, id) as unknown as UploadRow | undefined;
  }

  private require(id: string): UploadRow {
    const row = this.row(id);
    if (!row) refuse(`no upload ${id}`, 404);
    return row;
  }

  /**
   * An upload may say which of the patient's forms it goes with, and saying
   * so is what stops it raising its own review task: scanOne() leaves the
   * form's task to cover it. So the form is checked rather than taken on the
   * caller's word. Unchecked, a made-up id or another patient's form was
   * stored as given, and the file went into the chart with no task of its
   * own and no form that would ever raise one.
   *
   * One answer for "no such form" and "somebody else's form", for the
   * reason `requireVisitOf` gives for appointments.
   */
  private requireFormOf(patientId: string, submissionId: string): void {
    if (!this.forms) {
      refuse("this deployment cannot attach an upload to an intake form: no intake store is wired", 409);
    }
    const form = this.forms.find(submissionId);
    if (!form || form.patient_id !== patientId) {
      refuse(`no intake submission ${submissionId} for this patient`, 404);
    }
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
    if (input.submissionId !== undefined) this.requireFormOf(input.patientId, input.submissionId);

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
    if (!result || (result.verdict !== "clean" && result.verdict !== "infected")) {
      refuse("invalid malware scanner verdict; upload remains quarantined");
    }
    const now = new Date().toISOString();

    return this.db.transaction(() => {
      // Another scan may have completed while this one awaited the daemon.
      const current = this.require(id);
      if (current.status !== "pending-scan") return current;
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

  /** As get(), or undefined for an id that is not there. See `IntakeSubmissions.find()`. */
  find(id: string): Omit<UploadRow, "data"> | undefined {
    const row = this.row(id);
    if (!row) return undefined;
    const { data: _data, ...rest } = row;
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
