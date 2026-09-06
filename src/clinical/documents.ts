/**
 * Documents the patient supplied, as distinct from notes the clinic wrote.
 *
 * `DocumentReference` on the clinical record is already how a SOAP note is
 * stored. Treating a specialist letter the patient brought in as one of
 * those notes is how a chart acquires an unsigned "note" nobody attested,
 * and how a lockbox on counselling notes accidentally hides a form the
 * patient handed over — or, worse, the other way around: a letter filed as
 * a note is revised and signed as if the clinic wrote it.
 *
 * So this is a typed surface that writes a DocumentReference the notes
 * module will not read. Category `patient-supplied` is the discriminator,
 * the same way vitals are Observations that a potassium is not. A title
 * and a received date are required; the bytes are optional, because a
 * clerk recording that a paper letter arrived is ordinary, and pretending
 * we scanned it would be a second, false claim.
 *
 * What this is not: a portal, a document-management product, a virus
 * scanner, or a WCAG PDF. HTML, SVG and executables are refused; a payload
 * over 256 KiB is refused. We do not claim the file is safe, only that it
 * is not those things.
 */
import type { ClinicalEntry, ClinicalRecord } from "./record.ts";
import { refuse } from "../core/refusal.ts";

export const DOCUMENT_SOURCES = ["patient-brought", "patient-submitted", "clinic-scanned"] as const;
export type DocumentSource = (typeof DOCUMENT_SOURCES)[number];
export type DocumentHistory = "documented" | "never-received";

export const DOCUMENT_CONTENT_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "text/plain",
  "text/csv",
  "application/json",
] as const;
export type DocumentContentType = (typeof DOCUMENT_CONTENT_TYPES)[number];

/** Hard cap on stored bytes. A chart is not a file server. */
export const DOCUMENT_MAX_BYTES = 256 * 1024;

export interface PatientDocumentInput {
  patientId: string;
  title: string;
  source: DocumentSource;
  receivedAt: string;
  by: { authorId: string; authorKind: string };
  contentType?: string;
  /** UTF-8 for text/* and JSON; base64 for PDF and images. */
  data?: string;
  encounterId?: string;
  sourceMessageId?: string;
}

export interface PatientDocumentView {
  recordId: string;
  patientId: string;
  encounterId: string | null;
  title: string;
  source: DocumentSource;
  contentType: string | null;
  size: number;
  receivedAt: string;
  hasContent: boolean;
  authorId: string;
  recordedAt: string;
  /** Present only on `get()`. Lists never carry the payload. */
  data?: string | null;
}

export function isPatientSuppliedContent(c: Record<string, unknown>): boolean {
  const cats = Array.isArray(c.category) ? c.category : [];
  return cats.some((cat) => {
    if (!cat || typeof cat !== "object") return false;
    const o = cat as Record<string, unknown>;
    if (o.text === "patient-supplied") return true;
    const coding = Array.isArray(o.coding) ? o.coding : [];
    return coding.some((x) => x && typeof x === "object" && (x as { code?: string }).code === "patient-supplied");
  });
}

function parse(entry: ClinicalEntry, includeData: boolean): PatientDocumentView {
  const c = JSON.parse(entry.content) as Record<string, unknown>;
  const contents = Array.isArray(c.content) ? (c.content as Array<Record<string, unknown>>) : [];
  const attachment =
    contents[0]?.attachment && typeof contents[0].attachment === "object"
      ? (contents[0].attachment as Record<string, unknown>)
      : {};
  const data = typeof attachment.data === "string" ? attachment.data : null;
  const source = (DOCUMENT_SOURCES as readonly string[]).includes(String(c.suppliedBy))
    ? (c.suppliedBy as DocumentSource)
    : "patient-brought";
  const view: PatientDocumentView = {
    recordId: entry.record_id,
    patientId: entry.patient_id,
    encounterId: entry.encounter_id,
    title: typeof c.description === "string" ? c.description : typeof attachment.title === "string" ? attachment.title : "",
    source,
    contentType: typeof attachment.contentType === "string" ? attachment.contentType : null,
    size: typeof attachment.size === "number" ? attachment.size : 0,
    receivedAt: typeof c.date === "string" ? c.date : entry.effective_at ?? entry.recorded_at,
    hasContent: data !== null && data.length > 0,
    authorId: entry.author_id,
    recordedAt: entry.recorded_at,
  };
  if (includeData) view.data = data;
  return view;
}

/** Shared with src/patient/intake.ts, which validates an upload the same way. */
export function payloadSize(data: string, contentType: string): number {
  if (contentType.startsWith("text/") || contentType === "application/json") {
    return Buffer.byteLength(data, "utf8");
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length % 4 !== 0) {
    refuse("document data is not valid base64");
  }
  return Buffer.from(data, "base64").length;
}

export class PatientDocuments {
  private clinical: ClinicalRecord;

  constructor(clinical: ClinicalRecord) {
    this.clinical = clinical;
  }

  receive(input: PatientDocumentInput): PatientDocumentView {
    if (!input.title.trim()) refuse("a patient-supplied document needs a title");
    if (!input.receivedAt.trim()) refuse("a patient-supplied document needs the date it was received");
    if (!(DOCUMENT_SOURCES as readonly string[]).includes(input.source)) {
      refuse(`unknown document source ${input.source}; expected one of ${DOCUMENT_SOURCES.join(", ")}`);
    }
    const data = input.data;
    let size = 0;
    let contentType: string | undefined = input.contentType;
    if (data !== undefined && data.length > 0) {
      if (!contentType) refuse("a document with a payload needs a content type");
      if (!(DOCUMENT_CONTENT_TYPES as readonly string[]).includes(contentType)) {
        refuse(
          `refused content type ${contentType}; a chart is not a place for HTML, SVG or executables (allowed: ${DOCUMENT_CONTENT_TYPES.join(", ")})`
        );
      }
      size = payloadSize(data, contentType);
      if (size > DOCUMENT_MAX_BYTES) {
        refuse(`a patient-supplied document over ${DOCUMENT_MAX_BYTES} bytes is refused, not stored`);
      }
    } else if (contentType && !(DOCUMENT_CONTENT_TYPES as readonly string[]).includes(contentType)) {
      refuse(
        `refused content type ${contentType}; a chart is not a place for HTML, SVG or executables (allowed: ${DOCUMENT_CONTENT_TYPES.join(", ")})`
      );
    }

    const content: Record<string, unknown> = {
      resourceType: "DocumentReference",
      status: "current",
      category: [
        {
          coding: [{ code: "patient-supplied" }],
          text: "patient-supplied",
        },
      ],
      type: { text: input.title.trim() },
      description: input.title.trim(),
      date: input.receivedAt.trim(),
      suppliedBy: input.source,
      content: [
        {
          attachment: {
            title: input.title.trim(),
            ...(contentType ? { contentType } : {}),
            size,
            ...(data !== undefined && data.length > 0 ? { data } : {}),
          },
        },
      ],
    };
    const entry = this.clinical.record({
      entryType: "DocumentReference",
      patientId: input.patientId,
      content,
      authorId: input.by.authorId,
      authorKind: input.by.authorKind,
      effectiveAt: input.receivedAt.trim(),
      ...(input.encounterId ? { encounterId: input.encounterId } : {}),
      ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}),
    });
    return parse(entry, false);
  }

  forPatient(patientId: string, opts: { encounterId?: string } = {}): PatientDocumentView[] {
    return this.clinical
      .chart(patientId, { entryType: "DocumentReference", encounterId: opts.encounterId })
      .filter((e) => {
        try {
          return isPatientSuppliedContent(JSON.parse(e.content) as Record<string, unknown>);
        } catch {
          return false;
        }
      })
      .map((e) => parse(e, false));
  }

  get(recordId: string): PatientDocumentView | undefined {
    const entry = this.clinical.current(recordId);
    if (!entry || entry.entry_type !== "DocumentReference" || entry.status === "entered-in-error") return undefined;
    try {
      const c = JSON.parse(entry.content) as Record<string, unknown>;
      if (!isPatientSuppliedContent(c)) return undefined;
    } catch {
      return undefined;
    }
    return parse(entry, true);
  }

  historyStatus(patientId: string): DocumentHistory {
    return this.forPatient(patientId).length === 0 ? "never-received" : "documented";
  }

  retract(recordId: string, by: { authorId: string; authorKind: string; reason: string }): PatientDocumentView {
    return parse(this.clinical.retract(recordId, by), false);
  }
}
