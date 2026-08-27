/**
 * Published clinical risk scores, and the rules that keep their limits visible.
 *
 * These are published, well-established instruments: CURB-65 for pneumonia
 * disposition, CHA₂DS₂-VASc and HAS-BLED for the anticoagulation
 * risk-benefit, Wells for pulmonary embolism, HEART for chest pain, MELD-Na
 * for liver mortality, CIWA-Ar for alcohol withdrawal, Charlson for
 * comorbidity burden, LACE for readmission and NEWS2 for deterioration.
 * Every one is arithmetic over facts a clinician already has.
 *
 * ## A missing input is not a normal one
 *
 * This is the whole of why the module is shaped the way it is.
 *
 * The obvious implementation of CURB-65 asks whether urea is above 7 mmol/L
 * and awards a point if so. Write that as `urea > 7 ? 1 : 0` and a patient
 * whose urea was never drawn scores zero for that criterion — the same as a
 * patient whose urea came back normal. The score is *lower*, the band is
 * milder, and the recommendation moves toward sending them home. The patient
 * looks safer because less is known about them, and nothing anywhere says so.
 *
 * That is the same failure as an allergy list that is empty because nobody
 * asked, and as a quality measure that reads best where care is worst. It is
 * the failure this repository exists to refuse.
 *
 * So a score with a missing input **is not a score**. It returns
 * `{ complete: false, missing: [...] }`, which has no `score` field at all —
 * there is no number to misread, and a caller cannot accidentally render one.
 * Getting the number requires supplying every input the instrument needs, or
 * explicitly saying the finding is absent rather than unknown.
 *
 * ## Absent is a value; unknown is not
 *
 * Each boolean criterion takes `true`, `false`, or `undefined`, and they mean
 * three different things: the finding is present, the finding was looked for
 * and is absent, and nobody has said. Only the third refuses.
 *
 * ## What this is not
 *
 * Decision support, not a decision. Every result carries the instrument's own
 * interpretation, not an instruction, and none of these scores is a substitute
 * for the clinician in front of the patient. Portage is not a certified
 * medical device and makes no such claim; a deployment that intends to rely on
 * these clinically owns that assessment.
 */
import { Refusal } from "../core/refusal.ts";
import {
  SCORE_DEFINITIONS,
  SCORE_IDS,
  type ScoreDefinition,
  type ScoreId,
} from "./score-definitions.ts";

export { SCORE_DEFINITIONS, SCORE_IDS, type ScoreDefinition, type ScoreId } from "./score-definitions.ts";

interface ScoreEvidence {
  /** The exact governed definition used for this calculation. */
  definition: ScoreDefinition;
  /** A copy of what the caller supplied, so the arithmetic can be replayed. */
  suppliedInputs: Readonly<Record<string, unknown>>;
  /** When this calculation ran; chart-derived results separately state their clinical as-of time. */
  calculatedAt: string;
}

/** A score, or the honest absence of one. */
export type ScoreResult =
  | (ScoreEvidence & {
      complete: true;
      id: ScoreId;
      name: string;
      score: number;
      /** The instrument's own risk band. */
      band: string;
      /** What the published instrument says this band means. */
      interpretation: string;
      /** Every criterion and the points it contributed, so the number is auditable. */
      components: Record<string, number>;
    })
  | (ScoreEvidence & {
      complete: false;
      id: ScoreId;
      name: string;
      /** Inputs the instrument needs and nobody has supplied. */
      missing: string[];
      reason: string;
    });

function evidence(id: ScoreId, input: object): ScoreEvidence {
  return {
    definition: SCORE_DEFINITIONS[id],
    suppliedInputs: Object.freeze(Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b)))),
    calculatedAt: new Date().toISOString(),
  };
}

/**
 * Collects the inputs an instrument needs before any arithmetic happens.
 *
 * Deliberately not a validator that returns warnings: the caller cannot
 * proceed past it, because the whole point is that a partial score never
 * reaches anybody.
 */
class Inputs {
  private missing: string[] = [];

  /** A criterion that must be stated present or absent. */
  flag(name: string, value: boolean | undefined): boolean {
    if (value === undefined) {
      this.missing.push(name);
      return false;
    }
    return value;
  }

  /** A measurement that must have a number. */
  num(name: string, value: number | undefined): number {
    if (value === undefined || !Number.isFinite(value)) {
      this.missing.push(name);
      return 0;
    }
    return value;
  }

  /** A graded criterion whose value must be one of a fixed set. */
  pick<T extends string>(name: string, value: T | undefined, allowed: readonly T[]): T | null {
    if (value === undefined) {
      this.missing.push(name);
      return null;
    }
    if (!allowed.includes(value)) {
      throw new Refusal(`${name} must be one of ${allowed.join(", ")}; got ${value}`, 400);
    }
    return value;
  }

  get incomplete(): boolean {
    return this.missing.length > 0;
  }

  /** The refusal, worded so a reader knows the number was withheld deliberately. */
  refuse(id: ScoreId, name: string, input: object): ScoreResult {
    return {
      ...evidence(id, input),
      complete: false,
      id,
      name,
      missing: [...this.missing],
      reason:
        `${name} needs ${this.missing.length} input(s) nobody has stated: ${this.missing.join(", ")}. ` +
        "No score is returned, because treating an unknown finding as an absent one lowers the score " +
        "and makes an unassessed patient read as a lower-risk one.",
    };
  }
}

function band(score: number, bands: Array<{ upTo: number; band: string; says: string }>): { band: string; interpretation: string } {
  for (const b of bands) {
    if (score <= b.upTo) return { band: b.band, interpretation: b.says };
  }
  const last = bands[bands.length - 1];
  return { band: last.band, interpretation: last.says };
}

// ── CURB-65 ────────────────────────────────────────────────────────────────

export interface Curb65Input {
  /** New disorientation in person, place or time. */
  confusion?: boolean;
  /** Serum urea, mmol/L. The published threshold is > 7 mmol/L (BUN > 19 mg/dL). */
  ureaMmolL?: number;
  respiratoryRate?: number;
  systolicBp?: number;
  diastolicBp?: number;
  ageYears?: number;
}

export function curb65(input: Curb65Input): ScoreResult {
  const name = "CURB-65";
  const i = new Inputs();
  const confusion = i.flag("confusion", input.confusion);
  const urea = i.num("ureaMmolL", input.ureaMmolL);
  const rr = i.num("respiratoryRate", input.respiratoryRate);
  const sbp = i.num("systolicBp", input.systolicBp);
  const dbp = i.num("diastolicBp", input.diastolicBp);
  const age = i.num("ageYears", input.ageYears);
  if (i.incomplete) return i.refuse("curb-65", name, input);

  const components = {
    confusion: confusion ? 1 : 0,
    urea: urea > 7 ? 1 : 0,
    respiratoryRate: rr >= 30 ? 1 : 0,
    // Either limb qualifies, which is the published criterion — not systolic alone.
    bloodPressure: sbp < 90 || dbp <= 60 ? 1 : 0,
    age: age >= 65 ? 1 : 0,
  };
  const score = Object.values(components).reduce((a, b) => a + b, 0);
  const { band: b, interpretation } = band(score, [
    { upTo: 1, band: "low", says: "30-day mortality around 1.5%; outpatient management is usually appropriate." },
    { upTo: 2, band: "moderate", says: "30-day mortality around 9%; consider admission or supervised outpatient care." },
    { upTo: 5, band: "severe", says: "30-day mortality 15% or higher; admit, and assess for intensive care." },
  ]);
  return { ...evidence("curb-65", input), complete: true, id: "curb-65", name, score, band: b, interpretation, components };
}

// ── CHA₂DS₂-VASc ───────────────────────────────────────────────────────────

export interface Cha2ds2VascInput {
  congestiveHeartFailure?: boolean;
  hypertension?: boolean;
  ageYears?: number;
  diabetes?: boolean;
  strokeTiaThromboembolism?: boolean;
  vascularDisease?: boolean;
  sexFemale?: boolean;
}

export function cha2ds2Vasc(input: Cha2ds2VascInput): ScoreResult {
  const name = "CHA₂DS₂-VASc";
  const i = new Inputs();
  const chf = i.flag("congestiveHeartFailure", input.congestiveHeartFailure);
  const htn = i.flag("hypertension", input.hypertension);
  const age = i.num("ageYears", input.ageYears);
  const dm = i.flag("diabetes", input.diabetes);
  const stroke = i.flag("strokeTiaThromboembolism", input.strokeTiaThromboembolism);
  const vasc = i.flag("vascularDisease", input.vascularDisease);
  const female = i.flag("sexFemale", input.sexFemale);
  if (i.incomplete) return i.refuse("cha2ds2-vasc", name, input);

  const components = {
    congestiveHeartFailure: chf ? 1 : 0,
    hypertension: htn ? 1 : 0,
    age75OrOver: age >= 75 ? 2 : 0,
    diabetes: dm ? 1 : 0,
    strokeOrTia: stroke ? 2 : 0,
    vascularDisease: vasc ? 1 : 0,
    age65To74: age >= 65 && age < 75 ? 1 : 0,
    sexFemale: female ? 1 : 0,
  };
  const score = Object.values(components).reduce((a, b) => a + b, 0);
  const { band: b, interpretation } = band(score, [
    { upTo: 0, band: "low", says: "Annual stroke risk under 1%; antithrombotic therapy is often not recommended." },
    { upTo: 1, band: "intermediate", says: "Annual stroke risk around 1–2%; anticoagulation may be considered." },
    { upTo: 9, band: "high", says: "Annual stroke risk 2% or higher; anticoagulation is generally recommended." },
  ]);
  return { ...evidence("cha2ds2-vasc", input), complete: true, id: "cha2ds2-vasc", name, score, band: b, interpretation, components };
}

// ── HAS-BLED ───────────────────────────────────────────────────────────────

export interface HasBledInput {
  uncontrolledHypertension?: boolean;
  abnormalRenalFunction?: boolean;
  abnormalLiverFunction?: boolean;
  strokeHistory?: boolean;
  bleedingHistoryOrPredisposition?: boolean;
  labileInr?: boolean;
  ageYears?: number;
  antiplateletOrNsaid?: boolean;
  alcoholExcess?: boolean;
}

export function hasBled(input: HasBledInput): ScoreResult {
  const name = "HAS-BLED";
  const i = new Inputs();
  const htn = i.flag("uncontrolledHypertension", input.uncontrolledHypertension);
  const renal = i.flag("abnormalRenalFunction", input.abnormalRenalFunction);
  const liver = i.flag("abnormalLiverFunction", input.abnormalLiverFunction);
  const stroke = i.flag("strokeHistory", input.strokeHistory);
  const bleeding = i.flag("bleedingHistoryOrPredisposition", input.bleedingHistoryOrPredisposition);
  const inr = i.flag("labileInr", input.labileInr);
  const age = i.num("ageYears", input.ageYears);
  const drugs = i.flag("antiplateletOrNsaid", input.antiplateletOrNsaid);
  const alcohol = i.flag("alcoholExcess", input.alcoholExcess);
  if (i.incomplete) return i.refuse("has-bled", name, input);

  const components = {
    uncontrolledHypertension: htn ? 1 : 0,
    abnormalRenalFunction: renal ? 1 : 0,
    abnormalLiverFunction: liver ? 1 : 0,
    stroke: stroke ? 1 : 0,
    bleeding: bleeding ? 1 : 0,
    labileInr: inr ? 1 : 0,
    elderly: age > 65 ? 1 : 0,
    drugs: drugs ? 1 : 0,
    alcohol: alcohol ? 1 : 0,
  };
  const score = Object.values(components).reduce((a, b) => a + b, 0);
  const { band: b, interpretation } = band(score, [
    { upTo: 2, band: "lower", says: "Major bleeding risk is not elevated enough on its own to withhold anticoagulation." },
    { upTo: 9, band: "high", says: "Major bleeding risk is elevated. This flags modifiable factors for attention; it is not by itself a reason to withhold anticoagulation." },
  ]);
  return { ...evidence("has-bled", input), complete: true, id: "has-bled", name, score, band: b, interpretation, components };
}

// ── Wells (pulmonary embolism) ─────────────────────────────────────────────

export interface WellsPeInput {
  clinicalSignsOfDvt?: boolean;
  peIsLeadingDiagnosis?: boolean;
  heartRate?: number;
  immobilisationOrSurgery?: boolean;
  previousPeOrDvt?: boolean;
  haemoptysis?: boolean;
  malignancy?: boolean;
}

export function wellsPe(input: WellsPeInput): ScoreResult {
  const name = "Wells score for pulmonary embolism";
  const i = new Inputs();
  const dvt = i.flag("clinicalSignsOfDvt", input.clinicalSignsOfDvt);
  const leading = i.flag("peIsLeadingDiagnosis", input.peIsLeadingDiagnosis);
  const hr = i.num("heartRate", input.heartRate);
  const immobile = i.flag("immobilisationOrSurgery", input.immobilisationOrSurgery);
  const previous = i.flag("previousPeOrDvt", input.previousPeOrDvt);
  const haemoptysis = i.flag("haemoptysis", input.haemoptysis);
  const malignancy = i.flag("malignancy", input.malignancy);
  if (i.incomplete) return i.refuse("wells-pe", name, input);

  const components = {
    clinicalSignsOfDvt: dvt ? 3 : 0,
    peIsLeadingDiagnosis: leading ? 3 : 0,
    tachycardia: hr > 100 ? 1.5 : 0,
    immobilisationOrSurgery: immobile ? 1.5 : 0,
    previousPeOrDvt: previous ? 1.5 : 0,
    haemoptysis: haemoptysis ? 1 : 0,
    malignancy: malignancy ? 1 : 0,
  };
  const score = Object.values(components).reduce((a, b) => a + b, 0);
  const { band: b, interpretation } = band(score, [
    { upTo: 1.5, band: "low", says: "PE is unlikely on the three-tier reading; a D-dimer is the usual next step." },
    { upTo: 6, band: "moderate", says: "Intermediate probability; a D-dimer or imaging is indicated depending on the pathway in use." },
    { upTo: 12.5, band: "high", says: "PE is likely; proceed to imaging rather than relying on a D-dimer." },
  ]);
  return { ...evidence("wells-pe", input), complete: true, id: "wells-pe", name, score, band: b, interpretation, components };
}

// ── HEART ──────────────────────────────────────────────────────────────────

const HEART_HISTORY = ["slightly-suspicious", "moderately-suspicious", "highly-suspicious"] as const;
const HEART_ECG = ["normal", "non-specific-repolarisation", "significant-st-deviation"] as const;
const HEART_RISK = ["none", "one-or-two", "three-or-more-or-atherosclerotic-disease"] as const;
const HEART_TROPONIN = ["at-or-below-normal", "one-to-three-times-normal", "above-three-times-normal"] as const;

export interface HeartInput {
  history?: (typeof HEART_HISTORY)[number];
  ecg?: (typeof HEART_ECG)[number];
  ageYears?: number;
  riskFactors?: (typeof HEART_RISK)[number];
  troponin?: (typeof HEART_TROPONIN)[number];
}

export function heart(input: HeartInput): ScoreResult {
  const name = "HEART score";
  const i = new Inputs();
  const history = i.pick("history", input.history, HEART_HISTORY);
  const ecg = i.pick("ecg", input.ecg, HEART_ECG);
  const age = i.num("ageYears", input.ageYears);
  const risk = i.pick("riskFactors", input.riskFactors, HEART_RISK);
  const troponin = i.pick("troponin", input.troponin, HEART_TROPONIN);
  if (i.incomplete) return i.refuse("heart", name, input);

  const components = {
    history: HEART_HISTORY.indexOf(history!),
    ecg: HEART_ECG.indexOf(ecg!),
    age: age >= 65 ? 2 : age >= 45 ? 1 : 0,
    riskFactors: HEART_RISK.indexOf(risk!),
    troponin: HEART_TROPONIN.indexOf(troponin!),
  };
  const score = Object.values(components).reduce((a, b) => a + b, 0);
  const { band: b, interpretation } = band(score, [
    { upTo: 3, band: "low", says: "Around 2% risk of a major adverse cardiac event at six weeks; early discharge is often considered." },
    { upTo: 6, band: "moderate", says: "Around 20% risk at six weeks; admission for observation is usual." },
    { upTo: 10, band: "high", says: "Around 65% or higher risk at six weeks; early invasive management is usually considered." },
  ]);
  return { ...evidence("heart", input), complete: true, id: "heart", name, score, band: b, interpretation, components };
}

// ── MELD-Na ────────────────────────────────────────────────────────────────

export interface MeldNaInput {
  creatinineMgDl?: number;
  bilirubinMgDl?: number;
  inr?: number;
  sodiumMeqL?: number;
  /** Two or more sessions in the past week, or 24h of CVVHD: creatinine is taken as 4.0. */
  dialysisTwiceInPastWeek?: boolean;
}

export function meldNa(input: MeldNaInput): ScoreResult {
  const name = "MELD-Na";
  const i = new Inputs();
  const creatinineRaw = i.num("creatinineMgDl", input.creatinineMgDl);
  const bilirubinRaw = i.num("bilirubinMgDl", input.bilirubinMgDl);
  const inrRaw = i.num("inr", input.inr);
  const sodiumRaw = i.num("sodiumMeqL", input.sodiumMeqL);
  const dialysis = i.flag("dialysisTwiceInPastWeek", input.dialysisTwiceInPastWeek);
  if (i.incomplete) return i.refuse("meld-na", name, input);

  // The published bounds. A laboratory value below 1.0 is set to 1.0 so the
  // logarithm cannot turn a normal result into a negative contribution.
  const atLeastOne = (v: number) => (v < 1 ? 1 : v);
  const creatinine = dialysis ? 4 : Math.min(atLeastOne(creatinineRaw), 4);
  const bilirubin = atLeastOne(bilirubinRaw);
  const inr = atLeastOne(inrRaw);
  const sodium = Math.min(Math.max(sodiumRaw, 125), 137);

  const meld =
    Math.round(
      (0.957 * Math.log(creatinine) + 0.378 * Math.log(bilirubin) + 1.12 * Math.log(inr) + 0.643) * 10 * 10
    ) / 10;

  // Sodium only adjusts above 11, per the UNOS formula.
  let score = meld;
  if (meld > 11) {
    score = meld + 1.32 * (137 - sodium) - 0.033 * meld * (137 - sodium);
  }
  score = Math.min(40, Math.round(score));

  const { band: b, interpretation } = band(score, [
    { upTo: 9, band: "low", says: "Around 2% three-month mortality without transplant." },
    { upTo: 19, band: "moderate", says: "Around 6% three-month mortality without transplant." },
    { upTo: 29, band: "high", says: "Around 20% three-month mortality without transplant." },
    { upTo: 40, band: "very high", says: "50% or greater three-month mortality without transplant." },
  ]);
  return {
    ...evidence("meld-na", input),
    complete: true,
    id: "meld-na",
    name,
    score,
    band: b,
    interpretation,
    components: { meldBeforeSodium: meld, sodiumUsed: sodium, creatinineUsed: creatinine },
  };
}

// ── CIWA-Ar ────────────────────────────────────────────────────────────────

const CIWA_ITEMS = [
  "nauseaVomiting",
  "tremor",
  "paroxysmalSweats",
  "anxiety",
  "agitation",
  "tactileDisturbances",
  "auditoryDisturbances",
  "visualDisturbances",
  "headache",
] as const;

export type CiwaInput = Partial<Record<(typeof CIWA_ITEMS)[number], number>> & {
  /** Scored 0–4, unlike the other items. */
  orientation?: number;
};

export function ciwaAr(input: CiwaInput): ScoreResult {
  const name = "CIWA-Ar";
  const i = new Inputs();
  const components: Record<string, number> = {};
  for (const item of CIWA_ITEMS) {
    const v = i.num(item, input[item]);
    if (v < 0 || v > 7) throw new Refusal(`${item} is scored 0 to 7; got ${v}`, 400);
    components[item] = v;
  }
  const orientation = i.num("orientation", input.orientation);
  if (i.incomplete) return i.refuse("ciwa-ar", name, input);
  if (orientation < 0 || orientation > 4) throw new Refusal(`orientation is scored 0 to 4; got ${orientation}`, 400);
  components.orientation = orientation;

  const score = Object.values(components).reduce((a, b) => a + b, 0);
  const { band: b, interpretation } = band(score, [
    { upTo: 8, band: "minimal", says: "Minimal withdrawal; symptom-triggered medication is usually not required." },
    { upTo: 15, band: "mild", says: "Mild withdrawal; continue monitoring on the local protocol's interval." },
    { upTo: 20, band: "moderate", says: "Moderate withdrawal; medication is usually indicated." },
    { upTo: 67, band: "severe", says: "Severe withdrawal, with a risk of seizure and delirium tremens; urgent treatment is indicated." },
  ]);
  return { ...evidence("ciwa-ar", input), complete: true, id: "ciwa-ar", name, score, band: b, interpretation, components };
}

// ── Charlson comorbidity index ─────────────────────────────────────────────

const CHARLSON_WEIGHTS = {
  myocardialInfarction: 1,
  congestiveHeartFailure: 1,
  peripheralVascularDisease: 1,
  cerebrovascularDisease: 1,
  dementia: 1,
  chronicPulmonaryDisease: 1,
  connectiveTissueDisease: 1,
  pepticUlcerDisease: 1,
  mildLiverDisease: 1,
  diabetesWithoutComplications: 1,
  hemiplegia: 2,
  moderateOrSevereRenalDisease: 2,
  diabetesWithEndOrganDamage: 2,
  tumourWithinFiveYears: 2,
  leukaemia: 2,
  lymphoma: 2,
  moderateOrSevereLiverDisease: 3,
  metastaticSolidTumour: 6,
  aids: 6,
} as const satisfies Record<string, number>;

type CharlsonCondition = keyof typeof CHARLSON_WEIGHTS;

export type CharlsonInput = Partial<Record<CharlsonCondition, boolean>> & { ageYears?: number };

export function charlson(input: CharlsonInput): ScoreResult {
  const name = "Charlson comorbidity index";
  const i = new Inputs();
  const components: Record<string, number> = {};
  for (const [condition, weight] of Object.entries(CHARLSON_WEIGHTS)) {
    const present = i.flag(condition, input[condition as CharlsonCondition]);
    components[condition] = present ? weight : 0;
  }
  const age = i.num("ageYears", input.ageYears);
  if (i.incomplete) return i.refuse("charlson", name, input);

  // One point per decade over 40, to a maximum of four.
  components.age = age >= 50 ? Math.min(4, Math.floor((age - 40) / 10)) : 0;
  const score = Object.values(components).reduce((a, b) => a + b, 0);
  const { band: b, interpretation } = band(score, [
    { upTo: 0, band: "none", says: "No recorded comorbidity burden; around 98% estimated ten-year survival." },
    { upTo: 2, band: "low", says: "Low comorbidity burden; around 90% estimated ten-year survival." },
    { upTo: 4, band: "moderate", says: "Moderate comorbidity burden; around 77% estimated ten-year survival." },
    { upTo: 40, band: "high", says: "High comorbidity burden; estimated ten-year survival under 50%." },
  ]);
  return { ...evidence("charlson", input), complete: true, id: "charlson", name, score, band: b, interpretation, components };
}

// ── LACE ───────────────────────────────────────────────────────────────────

export interface LaceInput {
  lengthOfStayDays?: number;
  acuteEmergentAdmission?: boolean;
  /** The Charlson index, which has its own completeness rules. */
  charlsonScore?: number;
  edVisitsPastSixMonths?: number;
}

export function lace(input: LaceInput): ScoreResult {
  const name = "LACE index";
  const i = new Inputs();
  const los = i.num("lengthOfStayDays", input.lengthOfStayDays);
  const acute = i.flag("acuteEmergentAdmission", input.acuteEmergentAdmission);
  const cci = i.num("charlsonScore", input.charlsonScore);
  const ed = i.num("edVisitsPastSixMonths", input.edVisitsPastSixMonths);
  if (i.incomplete) return i.refuse("lace", name, input);

  const losPoints = los < 1 ? 0 : los <= 3 ? Math.floor(los) : los <= 6 ? 4 : los <= 13 ? 5 : 7;
  const components = {
    lengthOfStay: losPoints,
    acuteAdmission: acute ? 3 : 0,
    comorbidity: cci >= 4 ? 5 : Math.max(0, Math.min(3, Math.floor(cci))),
    edVisits: Math.max(0, Math.min(4, Math.floor(ed))),
  };
  const score = Object.values(components).reduce((a, b) => a + b, 0);
  const { band: b, interpretation } = band(score, [
    { upTo: 4, band: "low", says: "Low risk of unplanned readmission or death within 30 days of discharge." },
    { upTo: 9, band: "moderate", says: "Moderate risk; discharge planning and follow-up warrant attention." },
    { upTo: 19, band: "high", says: "High risk of readmission or death within 30 days; intensive discharge planning is indicated." },
  ]);
  return { ...evidence("lace", input), complete: true, id: "lace", name, score, band: b, interpretation, components };
}

// ── NEWS2 ──────────────────────────────────────────────────────────────────

export interface News2Input {
  respiratoryRate?: number;
  oxygenSaturation?: number;
  onSupplementalOxygen?: boolean;
  systolicBp?: number;
  heartRate?: number;
  /** Alert, or any of confusion, voice, pain, unresponsive. */
  alert?: boolean;
  temperatureC?: number;
}

export function news2(input: News2Input): ScoreResult {
  const name = "NEWS2";
  const i = new Inputs();
  const rr = i.num("respiratoryRate", input.respiratoryRate);
  const spo2 = i.num("oxygenSaturation", input.oxygenSaturation);
  const oxygen = i.flag("onSupplementalOxygen", input.onSupplementalOxygen);
  const sbp = i.num("systolicBp", input.systolicBp);
  const hr = i.num("heartRate", input.heartRate);
  const alert = i.flag("alert", input.alert);
  const temp = i.num("temperatureC", input.temperatureC);
  if (i.incomplete) return i.refuse("news2", name, input);

  const components = {
    respiratoryRate: rr <= 8 ? 3 : rr <= 11 ? 1 : rr <= 20 ? 0 : rr <= 24 ? 2 : 3,
    // Scale 1. A deployment using scale 2 for chronic hypercapnia needs its own
    // thresholds, and silently applying scale 1 to those patients would score
    // an appropriate saturation as a deterioration.
    oxygenSaturation: spo2 <= 91 ? 3 : spo2 <= 93 ? 2 : spo2 <= 95 ? 1 : 0,
    supplementalOxygen: oxygen ? 2 : 0,
    systolicBp: sbp <= 90 ? 3 : sbp <= 100 ? 2 : sbp <= 110 ? 1 : sbp <= 219 ? 0 : 3,
    heartRate: hr <= 40 ? 3 : hr <= 50 ? 1 : hr <= 90 ? 0 : hr <= 110 ? 1 : hr <= 130 ? 2 : 3,
    consciousness: alert ? 0 : 3,
    temperature: temp <= 35 ? 3 : temp <= 36 ? 1 : temp <= 38 ? 0 : temp <= 39 ? 1 : 2,
  };
  const score = Object.values(components).reduce((a, b) => a + b, 0);
  const anyThree = Object.values(components).some((v) => v === 3);

  // A single parameter scoring 3 escalates on its own, even when the total is
  // low — a patient can be profoundly abnormal in one axis and unremarkable in
  // the rest, and the aggregate alone would miss them.
  let b: string;
  let interpretation: string;
  if (score >= 7) {
    b = "high";
    interpretation = "Urgent or emergency response; continuous monitoring and immediate clinical review.";
  } else if (score >= 5) {
    b = "medium";
    interpretation = "Urgent review by a clinician competent in acute illness; increase monitoring frequency.";
  } else if (anyThree) {
    b = "low-medium";
    interpretation = "A single parameter scores 3, which requires urgent review by a ward-based clinician even though the aggregate is low.";
  } else if (score >= 1) {
    b = "low";
    interpretation = "Continue routine monitoring at the ward's usual frequency.";
  } else {
    b = "none";
    interpretation = "No physiological derangement recorded; continue routine monitoring.";
  }
  return { ...evidence("news2", input), complete: true, id: "news2", name, score, band: b, interpretation, components };
}

/** Every score, by id, for a route that dispatches on a name. */
export const SCORERS: Record<ScoreId, (input: never) => ScoreResult> = {
  "curb-65": curb65 as (input: never) => ScoreResult,
  "cha2ds2-vasc": cha2ds2Vasc as (input: never) => ScoreResult,
  "has-bled": hasBled as (input: never) => ScoreResult,
  "wells-pe": wellsPe as (input: never) => ScoreResult,
  heart: heart as (input: never) => ScoreResult,
  "meld-na": meldNa as (input: never) => ScoreResult,
  "ciwa-ar": ciwaAr as (input: never) => ScoreResult,
  charlson: charlson as (input: never) => ScoreResult,
  lace: lace as (input: never) => ScoreResult,
  news2: news2 as (input: never) => ScoreResult,
};

/** Computes one score by id, refusing an unknown one rather than guessing. */
export function score(id: string, input: unknown): ScoreResult {
  if (!(SCORE_IDS as readonly string[]).includes(id)) {
    throw new Refusal(`unknown score ${id}; this system computes ${SCORE_IDS.join(", ")}`, 400);
  }
  return SCORERS[id as ScoreId](input as never);
}
