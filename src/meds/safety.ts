/**
 * The check that runs before a prescription is signed.
 *
 * The distinction this file exists for is between an allergy list that is
 * empty because somebody asked and the answer was none, and one that is empty
 * because nobody has ever asked. Clinically they are opposite. In most systems
 * they render identically — a blank panel — and a check run against the second
 * returns "no contraindications found", which is a reassuring answer to a
 * question that was never put.
 *
 * So `unknown` is a distinct outcome here, never folded into `clear`. A
 * prescriber who signs anyway may do so — an emergency does not wait for a
 * history — but they sign knowing the check could not be performed, and the
 * override says so on the record.
 *
 * ## What this does and does not contain
 *
 * The mechanism is here. The content is not, and pretending otherwise would be
 * worse than the gap: a drug interaction table that is 80% complete is one a
 * prescriber learns to trust, and the missing 20% is then invisible. Northstar
 * ships a deliberately small rule set covering duplicate therapy and the
 * cross-reactivity classes with the clearest consensus, and takes a licensed
 * interaction database through `InteractionSource` for anything more. A
 * deployment with no source configured reports `unknown` for interactions
 * rather than `clear` — the same refusal to answer a question it cannot.
 */

export type Severity = "contraindicated" | "severe" | "moderate" | "minor";

export type FindingKind =
  | "allergy"
  | "intolerance"
  | "duplicate-therapy"
  | "interaction"
  | "allergy-history-not-taken"
  | "interaction-source-unavailable"
  | "withheld-by-directive";

export interface Finding {
  kind: FindingKind;
  severity: Severity;
  /** What the prescriber needs to read, in one line. */
  message: string;
  /** The medication or allergy this is about, where there is one. */
  against?: string;
}

/**
 * Whether the allergy question has been asked at all.
 *
 * `never-asked` is the outcome the module is built around, and it is not a
 * kind of `none`. `withheld` is its consent twin: the history exists, and a
 * patient directive keeps this caller from reading it — an answer, never a
 * blank, because a check that renders it as "no allergies" is the same
 * hazard wearing a lockbox.
 */
export type AllergyStatus = "documented" | "none-documented" | "never-asked" | "withheld";

export interface SafetyCheck {
  findings: Finding[];
  allergyStatus: AllergyStatus;
  /** True when nothing was found *and* everything could be checked. */
  clear: boolean;
  /** Findings a prescriber must explicitly override to proceed. */
  blocking: Finding[];
  /**
   * When the patient's chart is linked, the member charts this answer
   * consulted — set by the route, so the answer says on its face whose
   * records it speaks for, the same way the assembled chart does.
   */
  across?: string[];
}

/** A licensed interaction database, or a fake in tests. */
export interface InteractionSource {
  /**
   * Interactions between a proposed ingredient and what the patient takes.
   * Returning an empty array means checked and clear; a source that cannot
   * answer must throw, so the caller reports `unknown` rather than `clear`.
   */
  check(proposed: string, current: string[]): Finding[];
}

const SEVERITY_RANK: Record<Severity, number> = {
  contraindicated: 0,
  severe: 1,
  moderate: 2,
  minor: 3,
};

/**
 * Cross-reactivity worth encoding without a licensed source.
 *
 * Deliberately short. Each entry is a class where the relationship is
 * uncontroversial and the consequence is severe; anything requiring judgement
 * belongs in a maintained database, not in a constant in a source file.
 */
const CROSS_REACTIVITY: Record<string, string[]> = {
  penicillin: ["amoxicillin", "ampicillin", "piperacillin", "flucloxacillin", "benzylpenicillin"],
  cephalosporin: ["cefazolin", "cefalexin", "ceftriaxone", "cefuroxime"],
  sulfonamide: ["sulfamethoxazole", "sulfasalazine"],
  nsaid: ["ibuprofen", "naproxen", "diclofenac", "ketorolac", "indometacin"],
};

/** Normalised for comparison: prescribers do not type consistent case. */
export function normalise(s: string): string {
  return s.trim().toLowerCase();
}

/**
 * Whether a proposed ingredient falls under a recorded allergy.
 *
 * Matches the ingredient itself, and the class it belongs to. An allergy
 * recorded as "penicillin" has to catch amoxicillin, because that is how it
 * is written down and how it kills people.
 */
export function crossReacts(allergen: string, proposed: string): boolean {
  const a = normalise(allergen);
  const p = normalise(proposed);
  if (a === p) return true;
  if (CROSS_REACTIVITY[a]?.includes(p)) return true;
  if (CROSS_REACTIVITY[p]?.includes(a)) return true;
  // Both members of the same class: two NSAIDs, where an allergy to one is a
  // reason to think hard about the other.
  for (const members of Object.values(CROSS_REACTIVITY)) {
    if (members.includes(a) && members.includes(p)) return true;
  }
  return false;
}

/**
 * Assembles the check.
 *
 * Pure, and takes everything it needs, so the ordering of findings and the
 * decision about what blocks are both testable without a database.
 */
export function assess(input: {
  proposedIngredient: string;
  proposedDisplay: string;
  allergies: Array<{ ingredient: string | null; display: string | null; criticality: string; reaction: string | null }>;
  allergyStatus: AllergyStatus;
  currentIngredients: Array<{ ingredient: string; display: string }>;
  interactions: InteractionSource | null;
}): SafetyCheck {
  const findings: Finding[] = [];

  if (input.allergyStatus === "never-asked") {
    findings.push({
      kind: "allergy-history-not-taken",
      // Severe rather than minor: the check could not be performed, and a
      // prescriber reading "no contraindications" would be reading a fact
      // this system does not have.
      severity: "severe",
      message: "no allergy history has been recorded for this patient; the allergy check could not be performed",
    });
  }
  if (input.allergyStatus === "withheld") {
    findings.push({
      kind: "withheld-by-directive",
      // The same shape as never-asked, for the same reason: the check could
      // not be performed, and this caller's way through is break-glass, not
      // reading the answer as clear.
      severity: "severe",
      message: "the allergy list is withheld from this caller by a patient directive; the allergy check could not be performed",
    });
  }

  for (const a of input.allergies) {
    const allergen = a.ingredient ?? a.display;
    if (!allergen) continue;
    if (!crossReacts(allergen, input.proposedIngredient)) continue;
    const exact = normalise(allergen) === normalise(input.proposedIngredient);
    findings.push({
      kind: "allergy",
      severity: a.criticality === "high" ? "contraindicated" : "severe",
      against: allergen,
      message:
        `${input.proposedDisplay} ${exact ? "is" : "cross-reacts with"} a recorded ` +
        `${a.criticality === "high" ? "high-criticality " : ""}allergy to ${allergen}` +
        (a.reaction ? ` (${a.reaction})` : ""),
    });
  }

  for (const c of input.currentIngredients) {
    if (normalise(c.ingredient) === normalise(input.proposedIngredient)) {
      findings.push({
        kind: "duplicate-therapy",
        severity: "severe",
        against: c.display,
        message: `the patient is already taking ${c.display}, which is the same ingredient`,
      });
    }
  }

  if (input.interactions) {
    try {
      findings.push(
        ...input.interactions.check(
          input.proposedIngredient,
          input.currentIngredients.map((c) => c.ingredient)
        )
      );
    } catch (err) {
      // A source that cannot answer must not read as one that answered "no".
      findings.push({
        kind: "interaction-source-unavailable",
        severity: "severe",
        message: `the interaction database could not be consulted (${(err as Error).message}); interactions are unchecked`,
      });
    }
  } else if (input.currentIngredients.length > 0) {
    findings.push({
      kind: "interaction-source-unavailable",
      severity: "moderate",
      message: "no interaction database is configured; interactions with current medications are unchecked",
    });
  }

  findings.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  const blocking = findings.filter((f) => f.severity === "contraindicated" || f.severity === "severe");
  return { findings, allergyStatus: input.allergyStatus, clear: findings.length === 0, blocking };
}
