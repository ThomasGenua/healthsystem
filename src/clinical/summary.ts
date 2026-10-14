/**
 * A patient summary as a signed document, and the five ways a section can be
 * empty.
 *
 * `/patient/summary` already assembles the chart for a patient to read. This
 * is the other thing a summary is for: a document that leaves the building —
 * carried to another clinician, another province, another country — where
 * nobody can ask the sending system a follow-up question. Everything the
 * reader needs to judge it has to be inside it.
 *
 * ## An empty section is five different facts
 *
 * The failure this exists to prevent is the one the whole repository is built
 * around, arriving in a new place. A summary with an empty allergy section can
 * mean the patient has no known allergies, that nobody asked, that the
 * question was asked and the answer is unknown, that a directive withholds
 * the record, or that this system does not hold that kind of information at
 * all. Rendered as an empty list they are identical, and the reader supplies
 * the most comfortable interpretation, which is "no allergies".
 *
 * So each section carries a coded `emptyReason` and — because any mapping
 * from one vocabulary to another loses something — the originating status
 * verbatim beside it. A reader who does not recognise the code can still see
 * exactly what this system said.
 *
 * ## What the manifest is for
 *
 * A summary is evidence, and evidence that cannot be checked is decoration.
 * The manifest states what was included, what was empty and why, which
 * profile pack validated it and what that pack found, which terminology
 * systems the codes came from, which implementation guides this deployment
 * claims, and a digest over the document. Signing binds them together.
 *
 * It also states what is *not* known. Terminology releases carry no version
 * in this system — `term_concepts` records a system and a code and nothing
 * about which release they came from — so the manifest says the versions are
 * unrecorded rather than omitting the field and letting a reader assume they
 * were checked. That gap is item 50 on the roadmap.
 *
 * ## Not a conformance claim
 *
 * The shape follows the International Patient Summary, and this file does not
 * claim conformance to it. No IPS package has been fetched, nothing has been
 * validated against the published profiles, and the manifest says so in
 * words rather than leaving the resemblance to speak for itself.
 */
import { createHash, createHmac } from "node:crypto";
import { Refusal } from "../core/refusal.ts";

/**
 * Why a section carries nothing.
 *
 * Codes are from the FHIR list-empty-reason value set. The mapping from this
 * system's own vocabulary is stated here rather than inferred at each call
 * site, and the original is carried alongside because the mapping is lossy:
 * "never-asked" and "unknown" both land on codes that a reader may collapse,
 * and only the verbatim status distinguishes them.
 */
export type EmptyReason = "nilknown" | "notasked" | "withheld" | "unavailable";

const EMPTY_REASONS: Readonly<Record<string, EmptyReason>> = {
  // The subject is known to have none of these. The only one that means
  // "nothing to report" rather than "nothing recorded".
  "none-documented": "nilknown",
  none: "nilknown",
  // Nobody asked. Distinct from asked-and-unknown, and the distinction is the
  // difference between a gap somebody can close and one they cannot.
  "never-asked": "notasked",
  "never-recorded": "notasked",
  "never-measured": "notasked",
  "never-received": "notasked",
  // A directive withholds it. The section is present and says so, because a
  // withheld section rendered as absent is a lie by omission.
  withheld: "withheld",
  // Asked, and not known; or this system does not hold it.
  unknown: "unavailable",
  unavailable: "unavailable",
  "not-applicable": "unavailable",
};

export interface SummarySection {
  /** The section's title, as a reader sees it. */
  title: string;
  /** LOINC code for the section, from the IPS composition structure. */
  code: string;
  entries: Array<Record<string, unknown>>;
  /** This system's own word for the state of the section. */
  status: string;
  emptyReason?: EmptyReason;
}

export interface SummaryManifest {
  contract: "patient-summary/1";
  generatedAt: string;
  patientId: string;
  tenantId: string;
  sections: Array<{ title: string; code: string; entries: number; status: string; emptyReason?: EmptyReason }>;
  terminology: {
    systems: string[];
    versions: "unrecorded";
    note: string;
  };
  validation:
    | { pack: string; issues: Array<Record<string, unknown>>; note: string }
    | { pack: null; note: string };
  conformance: { claimed: string[]; note: string };
  provenance: { recordedFor: string; note: string };
  digest: string;
  signature: { algorithm: "HMAC-SHA256"; value: string };
  assurance: string;
}

export interface SummaryDeps {
  tenantId: string;
  /** The code systems the codes in this document were drawn from. */
  terminologySystems(): string[];
  /** Implementation guides this deployment has actually put into force. */
  activeGuides(): string[];
  /** Profile validation of the assembled document, where a pack is active. */
  validate?(bundle: Record<string, unknown>): { pack: string; issues: Array<Record<string, unknown>> } | null;
}

/** Deterministic serialisation, so the same document always digests the same. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}

export function emptyReasonFor(status: string): EmptyReason {
  // An unrecognised status is "unavailable" rather than "nilknown": a state
  // this mapping does not know must never render as "the patient has none".
  return EMPTY_REASONS[status] ?? "unavailable";
}

/**
 * Assembles the document and its manifest.
 *
 * Refuses without a signing key. An exported summary is the artifact that
 * leaves the building, and an unsigned one cannot be told from one somebody
 * edited on the way. The read-only `/patient/summary` view is unaffected —
 * this refusal is about the shareable copy, not about a patient seeing their
 * own chart.
 */
export function buildSummary(
  patientId: string,
  patient: Record<string, unknown> | null,
  sections: SummarySection[],
  deps: SummaryDeps,
  signingKey: string | undefined,
  now: Date = new Date()
): { bundle: Record<string, unknown>; manifest: SummaryManifest } {
  if (!signingKey || !signingKey.trim()) {
    throw new Refusal(
      "a patient summary cannot be exported without a signing key: an unsigned summary cannot be told from one " +
        "altered after it left. Set NORTHSTAR_SUMMARY_SIGNING_KEY. Viewing a chart is unaffected.",
      503
    );
  }
  if (!patient) {
    throw new Refusal(`no patient ${patientId} on this chart; a summary of nobody is not a summary`, 404);
  }

  const at = now.toISOString();
  const composition = {
    resourceType: "Composition",
    status: "final",
    type: { coding: [{ system: "http://loinc.org", code: "60591-5", display: "Patient summary Document" }] },
    subject: { reference: `Patient/${patientId}` },
    date: at,
    title: "Patient summary",
    section: sections.map((s) => ({
      title: s.title,
      code: { coding: [{ system: "http://loinc.org", code: s.code }] },
      ...(s.entries.length > 0
        ? { entry: s.entries.map((_, i) => ({ reference: `#${s.code}-${i}` })) }
        : {
            emptyReason: {
              coding: [{ system: "http://terminology.hl7.org/CodeSystem/list-empty-reason", code: s.emptyReason }],
              // The mapping above is lossy, so the originating word travels
              // with the code. A reader who does not recognise "notasked" can
              // still read "never-asked" and know precisely what was meant.
              text: `${s.emptyReason}: this system recorded the section as "${s.status}"`,
            },
          }),
    })),
  };

  const bundle = {
    resourceType: "Bundle",
    type: "document",
    timestamp: at,
    entry: [
      { resource: composition },
      { resource: patient },
      ...sections.flatMap((s) => s.entries.map((resource) => ({ resource }))),
    ],
  };

  const validation = deps.validate?.(bundle) ?? null;
  const digest = createHash("sha256").update(canonical(bundle)).digest("hex");
  const manifestBody = {
    contract: "patient-summary/1" as const,
    generatedAt: at,
    patientId,
    tenantId: deps.tenantId,
    sections: sections.map((s) => ({
      title: s.title,
      code: s.code,
      entries: s.entries.length,
      status: s.status,
      ...(s.entries.length === 0 && s.emptyReason ? { emptyReason: s.emptyReason } : {}),
    })),
    terminology: {
      systems: deps.terminologySystems(),
      versions: "unrecorded" as const,
      note:
        "The code systems these codes were drawn from are listed; their release versions are not, because this " +
        "deployment does not record them. Do not read an absent version as a current one.",
    },
    validation: validation
      ? {
          pack: validation.pack,
          issues: validation.issues,
          note:
            "Validated against this deployment's own profile pack, which is a working subset and not a published " +
            "implementation guide. Passing it is not conformance.",
        }
      : {
          pack: null,
          note: "No profile pack was active, so nothing in this document has been validated against any profile.",
        },
    conformance: {
      claimed: deps.activeGuides(),
      note:
        "Implementation guides this deployment has put into force, from its conformance registry. Listing one " +
        "means its rules are applied here; it is not a statement that any external body has tested this.",
    },
    provenance: {
      recordedFor: `Patient/${patientId}`,
      note: "Per-resource lineage is available from GET /fhir/Provenance?target=Type/id on the issuing system.",
    },
    digest,
    assurance:
      "Shaped after the International Patient Summary. Not IPS-conformant: no IPS package has been fetched and " +
      "nothing here has been validated against the published profiles.",
  };

  const signature = createHmac("sha256", signingKey).update(canonical(manifestBody)).digest("hex");
  return {
    bundle,
    manifest: { ...manifestBody, signature: { algorithm: "HMAC-SHA256", value: signature } },
  };
}

/** Re-checks a manifest against the document and key it claims to describe. */
export function verifySummary(
  bundle: Record<string, unknown>,
  manifest: SummaryManifest,
  signingKey: string
): { ok: true } | { ok: false; reason: string } {
  const { signature, ...body } = manifest;
  const expected = createHmac("sha256", signingKey).update(canonical(body)).digest("hex");
  if (signature.value !== expected) return { ok: false, reason: "the manifest signature does not match its contents" };
  const digest = createHash("sha256").update(canonical(bundle)).digest("hex");
  if (digest !== manifest.digest) {
    return { ok: false, reason: "the document does not match the digest the manifest carries" };
  }
  return { ok: true };
}
