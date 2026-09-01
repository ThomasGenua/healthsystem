/**
 * The governed identity of every clinical score Northstar computes.
 *
 * Arithmetic without this catalogue is not reproducible evidence. A result
 * needs to say which published instrument it means, which version of that
 * instrument the code implements, the population it was derived for, and
 * which units the thresholds expect. The catalogue also says what has *not*
 * happened: these implementations have executable regression vectors, but
 * have not been signed off by an independent clinical safety officer.
 */

export const SCORE_IDS = [
  "curb-65",
  "cha2ds2-vasc",
  "has-bled",
  "wells-pe",
  "heart",
  "meld-na",
  "ciwa-ar",
  "charlson",
  "lace",
  "news2",
] as const;

export type ScoreId = (typeof SCORE_IDS)[number];

export interface ScoreSource {
  title: string;
  citation: string;
  url: string;
}

export interface ScoreDefinition {
  id: ScoreId;
  name: string;
  /** Changes whenever a threshold, weight, band, or interpretation changes. */
  implementationVersion: string;
  instrumentVersion: string;
  source: ScoreSource;
  intendedPopulation: string;
  exclusions: readonly string[];
  /** Units whose omission or implicit conversion can change the result. */
  requiredUnits: Readonly<Record<string, string>>;
  licensing: {
    status: "source-terms-apply" | "attribution-permitted";
    note: string;
  };
  assurance: {
    status: "implementation-tested-not-independently-clinically-validated";
    goldenVectors: string;
    independentClinicalReview: false;
    clinicalOwner: null;
    reviewedAt: null;
    reviewDue: null;
  };
}

const UNREVIEWED = {
  status: "implementation-tested-not-independently-clinically-validated",
  goldenVectors: "fixtures/clinical-scores/golden.json",
  independentClinicalReview: false,
  clinicalOwner: null,
  reviewedAt: null,
  reviewDue: null,
} as const;

const SOURCE_TERMS = {
  status: "source-terms-apply",
  note:
    "Northstar cites the source and implements arithmetic; it asserts no right to redistribute a publisher's instrument text. A deployment must review the source's current terms.",
} as const;

/**
 * Source URLs point to original publications or the instrument steward.
 * Population and exclusion text is deliberately short: it prevents an API
 * consumer from treating a mathematically valid result as clinically valid in
 * any patient who happens to have the required fields.
 */
export const SCORE_DEFINITIONS: Readonly<Record<ScoreId, ScoreDefinition>> = {
  "curb-65": {
    id: "curb-65",
    name: "CURB-65",
    implementationVersion: "portage-1",
    instrumentVersion: "Lim et al. 2003 CURB-65",
    source: {
      title: "Defining community acquired pneumonia severity on presentation to hospital: an international derivation and validation study",
      citation: "Lim WS et al. Thorax. 2003;58:377-382. doi:10.1136/thorax.58.5.377",
      url: "https://pubmed.ncbi.nlm.nih.gov/12728155/",
    },
    intendedPopulation: "Adults presenting to hospital with community-acquired pneumonia.",
    exclusions: [
      "Not a diagnosis of pneumonia.",
      "Not independently validated here for children, pregnancy, or patients outside the derivation setting.",
    ],
    requiredUnits: { ureaMmolL: "mmol/L", respiratoryRate: "breaths/min", systolicBp: "mmHg", diastolicBp: "mmHg", ageYears: "completed years" },
    licensing: SOURCE_TERMS,
    assurance: UNREVIEWED,
  },
  "cha2ds2-vasc": {
    id: "cha2ds2-vasc",
    name: "CHA2DS2-VASc",
    implementationVersion: "portage-1",
    instrumentVersion: "Lip et al. 2010 CHA2DS2-VASc",
    source: {
      title: "Refining clinical risk stratification for predicting stroke and thromboembolism in atrial fibrillation using a novel risk factor-based approach",
      citation: "Lip GYH et al. Chest. 2010;137:263-272. doi:10.1378/chest.09-1584",
      url: "https://pubmed.ncbi.nlm.nih.gov/19762550/",
    },
    intendedPopulation: "Adults with atrial fibrillation being assessed for thromboembolic risk.",
    exclusions: [
      "Not a diagnosis of atrial fibrillation.",
      "The sex-category interpretation is guideline-dependent and must not be used as a treatment order.",
    ],
    requiredUnits: { ageYears: "completed years" },
    licensing: SOURCE_TERMS,
    assurance: UNREVIEWED,
  },
  "has-bled": {
    id: "has-bled",
    name: "HAS-BLED",
    implementationVersion: "portage-1",
    instrumentVersion: "Pisters et al. 2010 HAS-BLED",
    source: {
      title: "A novel user-friendly score (HAS-BLED) to assess 1-year risk of major bleeding in patients with atrial fibrillation",
      citation: "Pisters R et al. Chest. 2010;138:1093-1100. doi:10.1378/chest.10-0134",
      url: "https://pubmed.ncbi.nlm.nih.gov/20299623/",
    },
    intendedPopulation: "Adults with atrial fibrillation for whom bleeding risk during antithrombotic therapy is being assessed.",
    exclusions: ["Not a reason by itself to withhold anticoagulation.", "Risk-factor definitions must follow the source and local guideline."],
    requiredUnits: { ageYears: "completed years" },
    licensing: SOURCE_TERMS,
    assurance: UNREVIEWED,
  },
  "wells-pe": {
    id: "wells-pe",
    name: "Wells score for pulmonary embolism",
    implementationVersion: "portage-1",
    instrumentVersion: "Wells et al. 2000 PE model (three-tier interpretation)",
    source: {
      title: "Derivation of a simple clinical model to categorize patients' probability of pulmonary embolism",
      citation: "Wells PS et al. Thromb Haemost. 2000;83:416-420. PMID:10744147",
      url: "https://pubmed.ncbi.nlm.nih.gov/10744147/",
    },
    intendedPopulation: "Patients with clinically suspected pulmonary embolism before diagnostic testing.",
    exclusions: ["Not a rule-out test on its own.", "Must be combined with the diagnostic pathway and D-dimer strategy in use."],
    requiredUnits: { heartRate: "beats/min" },
    licensing: SOURCE_TERMS,
    assurance: UNREVIEWED,
  },
  heart: {
    id: "heart",
    name: "HEART score",
    implementationVersion: "portage-1",
    instrumentVersion: "Six et al. 2008 HEART",
    source: {
      title: "Chest pain in the emergency room: value of the HEART score",
      citation: "Six AJ et al. Neth Heart J. 2008;16:191-196. doi:10.1007/BF03086144",
      url: "https://pubmed.ncbi.nlm.nih.gov/18665203/",
    },
    intendedPopulation: "Adults presenting to an emergency department with undifferentiated chest pain suspicious for acute coronary syndrome.",
    exclusions: ["Not validated here for patients with a diagnostic STEMI or another established cause requiring immediate treatment.", "Troponin must be graded against the assay's own upper reference limit."],
    requiredUnits: { ageYears: "completed years", troponin: "multiple of the assay upper reference limit" },
    licensing: SOURCE_TERMS,
    assurance: UNREVIEWED,
  },
  "meld-na": {
    id: "meld-na",
    name: "MELD-Na",
    implementationVersion: "portage-1",
    instrumentVersion: "OPTN 2016 MELD-Na formula; not MELD 3.0",
    source: {
      title: "OPTN policy change adding serum sodium to the MELD score",
      citation: "OPTN/UNOS. Adding Serum Sodium to the MELD Score. Implemented 2016.",
      url: "https://optn.transplant.hrsa.gov/media/1575/policynotice_20151101.pdf",
    },
    intendedPopulation: "Adult liver-transplant candidates assessed with the historical 2016 OPTN MELD-Na allocation formula.",
    exclusions: ["Not the current OPTN MELD 3.0 allocation calculation.", "Must not be used to assign transplant priority outside the responsible allocation system."],
    requiredUnits: { creatinineMgDl: "mg/dL", bilirubinMgDl: "mg/dL", inr: "ratio", sodiumMeqL: "mEq/L" },
    licensing: SOURCE_TERMS,
    assurance: UNREVIEWED,
  },
  "ciwa-ar": {
    id: "ciwa-ar",
    name: "CIWA-Ar",
    implementationVersion: "portage-1",
    instrumentVersion: "Sullivan et al. 1989 CIWA-Ar",
    source: {
      title: "Assessment of alcohol withdrawal: the revised clinical institute withdrawal assessment for alcohol scale (CIWA-Ar)",
      citation: "Sullivan JT et al. Br J Addict. 1989;84:1353-1357. doi:10.1111/j.1360-0443.1989.tb00737.x",
      url: "https://pubmed.ncbi.nlm.nih.gov/2597811/",
    },
    intendedPopulation: "Communicative patients being serially assessed for alcohol withdrawal in an appropriate clinical setting.",
    exclusions: ["Symptoms can be confounded by acute illness, intoxication, delirium, language barriers, or inability to communicate.", "Not a diagnosis and not a medication protocol by itself."],
    requiredUnits: { items: "nine items scored 0-7; orientation scored 0-4" },
    licensing: SOURCE_TERMS,
    assurance: UNREVIEWED,
  },
  charlson: {
    id: "charlson",
    name: "Charlson Comorbidity Index",
    implementationVersion: "portage-1",
    instrumentVersion: "Charlson et al. 1987, age-adjusted implementation",
    source: {
      title: "A new method of classifying prognostic comorbidity in longitudinal studies: development and validation",
      citation: "Charlson ME et al. J Chronic Dis. 1987;40:373-383. doi:10.1016/0021-9681(87)90171-8",
      url: "https://pubmed.ncbi.nlm.nih.gov/3558716/",
    },
    intendedPopulation: "Adults whose comorbid conditions have been explicitly assessed for longitudinal mortality-risk adjustment.",
    exclusions: ["Do not infer conditions from an incomplete diagnosis-code mapping.", "Not a bedside treatment recommendation."],
    requiredUnits: { ageYears: "completed years" },
    licensing: SOURCE_TERMS,
    assurance: UNREVIEWED,
  },
  lace: {
    id: "lace",
    name: "LACE index",
    implementationVersion: "portage-1",
    instrumentVersion: "van Walraven et al. 2010 LACE",
    source: {
      title: "Derivation and validation of an index to predict early death or unplanned readmission after discharge from hospital to the community",
      citation: "van Walraven C et al. CMAJ. 2010;182:551-557. doi:10.1503/cmaj.091117",
      url: "https://pubmed.ncbi.nlm.nih.gov/20194559/",
    },
    intendedPopulation: "Medical or surgical patients discharged from hospital to the community, for 30-day death or urgent-readmission risk.",
    exclusions: ["Not independently validated here for other discharge destinations or as a substitute for discharge planning.", "Requires the Charlson score definition used by this implementation."],
    requiredUnits: { lengthOfStayDays: "calendar days", edVisitsPastSixMonths: "count", charlsonScore: "Charlson points" },
    licensing: SOURCE_TERMS,
    assurance: UNREVIEWED,
  },
  news2: {
    id: "news2",
    name: "NEWS2",
    implementationVersion: "portage-1",
    instrumentVersion: "Royal College of Physicians NEWS2 (2017), Scale 1 only",
    source: {
      title: "National Early Warning Score (NEWS) 2: Standardising the assessment of acute-illness severity in the NHS",
      citation: "Royal College of Physicians. London: RCP; 2017. ISBN 978-1-86016-682-2.",
      url: "https://www.rcp.ac.uk/resources/national-early-warning-score-news-2/",
    },
    intendedPopulation: "Adults aged 16 or older, excluding pregnancy, in acute-care assessment and monitoring settings covered by NEWS2 guidance.",
    exclusions: ["This implementation supports oxygen-saturation Scale 1 only; it does not implement Scale 2 for prescribed hypercapnic respiratory failure.", "Not for children or pregnant patients."],
    requiredUnits: { respiratoryRate: "breaths/min", oxygenSaturation: "%", systolicBp: "mmHg", heartRate: "beats/min", temperatureC: "degC" },
    licensing: {
      status: "attribution-permitted",
      note: "RCP permits use with acknowledgement; official charts must not be modified. Northstar does not reproduce the chart artwork.",
    },
    assurance: UNREVIEWED,
  },
};

