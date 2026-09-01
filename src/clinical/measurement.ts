/**
 * A measured quantity, and the boundary where its units stop mattering.
 *
 * ## The unit that was never stated
 *
 * `POST /api/clinical/score` takes a bare number per criterion, and the unit
 * it is expected in lives in two places, neither of them checked. The field
 * name carries one spelling of it — `ureaMmolL`, `bilirubinMgDl`,
 * `temperatureC` — and `score-definitions.ts` carries another as free prose in
 * `requiredUnits`. Nothing ties them together and nothing compares either to
 * what the caller actually sent.
 *
 * So a laboratory reporting bilirubin in µmol/L, or a device reporting
 * temperature in Fahrenheit, produces a number that is silently scored against
 * thresholds written for a different scale. 98.6 is a normal temperature and a
 * catastrophic one, depending on a fact the request never carried. This is
 * H-140, and naming the required unit in a catalogue does not prevent it: a
 * caller who reads the catalogue was never the one at risk.
 *
 * ## Saying the unit instead of spelling it into the name
 *
 * A `Measurement` is a value together with the unit it was measured in, coded
 * against UCUM rather than written as prose. The scores then take input whose
 * names say only *what* was measured — `temperature`, not `temperatureC` —
 * because the scale now travels with the value instead of in the key.
 *
 * ## Equivalence is not conversion
 *
 * Two things that look similar are kept firmly apart.
 *
 * A **synonym** is another label for the same scale. `Cel`, `°C` and `degC`
 * are one scale spelled three ways, and a value labelled any of them is
 * accepted exactly as sent — no arithmetic is applied, because there is none
 * to apply. Refusing a caller who wrote `mmHg` where UCUM writes `mm[Hg]`
 * would be pedantry with a clinical cost.
 *
 * A **conversion** changes the number. `[degF]` to `Cel` is a real
 * computation, and it happens here, once, at the edge — never inside a
 * scorer, which sees only canonical numbers and cannot tell whether one was
 * converted. Every conversion is recorded and returned with the score, so a
 * reader can check the arithmetic rather than trust it.
 *
 * ## What this deliberately will not convert
 *
 * Only conversions that are pure changes of scale are performed: Fahrenheit
 * to Celsius, µmol/L to mmol/L, hours to days. Each is exact, and none needs
 * to know what substance was measured.
 *
 * Bilirubin in µmol/L against a mg/dL threshold is *not* converted, even
 * though it is the example H-140 names. Going between a molar and a mass
 * concentration requires that substance's molar mass, which is a clinical
 * fact about the analyte and not a property of the units. Choosing one on a
 * caller's behalf is exactly the silent rescaling this module exists to stop,
 * so the mismatch is refused and says why. A deployment that wants that
 * conversion makes it deliberately, upstream, where somebody owns the choice.
 */
import { Refusal } from "../core/refusal.ts";

/** The UCUM code system. The only unit system this contract accepts. */
export const UCUM_SYSTEM = "http://unitsofmeasure.org";

/** The version of this contract, carried on every ingestion record. */
export const MEASUREMENT_CONTRACT = "measurement/1";

export interface Measurement {
  value: number;
  /** A UCUM code, or a label this module accepts as naming the same scale. */
  unit: string;
  /** Defaults to UCUM. Any other system refuses rather than being assumed. */
  system?: string;
}

interface Conversion {
  ucum: string;
  synonyms: readonly string[];
  apply: (value: number) => number;
  /** Recorded on every conversion so the arithmetic can be re-checked. */
  rule: string;
}

interface Incompatible {
  ucum: string;
  synonyms: readonly string[];
  /** Why this system will not do it, in the refusal's own words. */
  because: string;
}

export interface Scale {
  /** The UCUM code the instrument's own thresholds are written in. */
  ucum: string;
  /** What is being measured, so a refusal names something a human can act on. */
  quantity: string;
  /** Other labels for this same scale. Accepted unchanged. */
  synonyms: readonly string[];
  /** Scales reachable by a pure change of scale. */
  convertsFrom?: readonly Conversion[];
  /** Scales a reader might expect to be converted, and the reason none is. */
  refuses?: readonly Incompatible[];
}

const DIMENSIONLESS = (quantity: string): Scale => ({
  ucum: "1",
  quantity,
  synonyms: ["", "1", "{score}", "{count}", "{points}"],
});

const MOLAR_NOT_MASS =
  "converting a molar concentration to a mass concentration needs the analyte's molar mass, which is a " +
  "fact about the substance rather than about the units; this system will not choose one on your behalf. " +
  "Convert it upstream, where somebody owns that decision, and send the result in";

const RATE: Scale = {
  ucum: "/min",
  quantity: "a rate per minute",
  synonyms: ["/min", "1/min", "min-1", "{breaths}/min", "{beats}/min", "bpm", "breaths/min", "beats/min"],
};

const PRESSURE: Scale = {
  ucum: "mm[Hg]",
  quantity: "a pressure",
  synonyms: ["mm[Hg]", "mmHg", "mm Hg", "millimetre of mercury"],
};

const MASS_CONC_MG_DL = (analyte: string): Scale => ({
  ucum: "mg/dL",
  quantity: `a ${analyte} mass concentration`,
  synonyms: ["mg/dL", "mg/dl"],
  convertsFrom: [
    { ucum: "g/dL", synonyms: ["g/dL", "g/dl"], apply: (v) => v * 1000, rule: "1 g/dL = 1000 mg/dL" },
    { ucum: "mg/L", synonyms: ["mg/L", "mg/l"], apply: (v) => v / 10, rule: "1 mg/L = 0.1 mg/dL" },
  ],
  refuses: [
    { ucum: "umol/L", synonyms: ["umol/L", "µmol/L", "umol/l", "μmol/L"], because: MOLAR_NOT_MASS },
    { ucum: "mmol/L", synonyms: ["mmol/L", "mmol/l"], because: MOLAR_NOT_MASS },
  ],
});

/**
 * Every numeric score input, the scorer field it feeds, and the scale its
 * thresholds are written in.
 *
 * The key is what was measured. The field is the parameter the scorers still
 * take, whose name carries a unit for the reason the module header gives —
 * v1 callers depend on those names, so they stay exactly as they are.
 */
export interface MeasuredInput {
  /** The scorer parameter this feeds. */
  field: string;
  scale: Scale;
}

export const SCORE_MEASUREMENTS: Readonly<Record<string, MeasuredInput>> = {
  age: {
    field: "ageYears",
    scale: {
      ucum: "a",
      quantity: "an age",
      synonyms: ["a", "year", "years", "yr", "{years}", "a_j"],
      convertsFrom: [{ ucum: "mo", synonyms: ["mo", "month", "months"], apply: (v) => v / 12, rule: "12 mo = 1 a" }],
    },
  },
  temperature: {
    field: "temperatureC",
    scale: {
      ucum: "Cel",
      quantity: "a temperature",
      synonyms: ["Cel", "°C", "C", "degC", "celsius"],
      convertsFrom: [
        { ucum: "[degF]", synonyms: ["[degF]", "°F", "F", "degF", "fahrenheit"], apply: (v) => ((v - 32) * 5) / 9, rule: "Cel = ([degF] - 32) x 5/9" },
        { ucum: "K", synonyms: ["K", "kelvin"], apply: (v) => v - 273.15, rule: "Cel = K - 273.15" },
      ],
    },
  },
  oxygenSaturation: {
    field: "oxygenSaturation",
    scale: { ucum: "%", quantity: "a percentage saturation", synonyms: ["%", "percent", "{percent}"] },
  },
  respiratoryRate: { field: "respiratoryRate", scale: RATE },
  heartRate: { field: "heartRate", scale: RATE },
  systolicBp: { field: "systolicBp", scale: PRESSURE },
  diastolicBp: { field: "diastolicBp", scale: PRESSURE },
  urea: {
    field: "ureaMmolL",
    scale: {
      ucum: "mmol/L",
      quantity: "a urea molar concentration",
      synonyms: ["mmol/L", "mmol/l"],
      convertsFrom: [
        { ucum: "umol/L", synonyms: ["umol/L", "µmol/L", "umol/l", "μmol/L"], apply: (v) => v / 1000, rule: "1000 umol/L = 1 mmol/L" },
      ],
      refuses: [
        {
          ucum: "mg/dL",
          synonyms: ["mg/dL", "mg/dl"],
          because:
            "blood urea nitrogen in mg/dL and urea in mmol/L are different quantities of different substances, " +
            "and relating them needs a molar mass this system will not choose on your behalf. CURB-65 is scored " +
            "here on urea in mmol/L",
        },
      ],
    },
  },
  creatinine: { field: "creatinineMgDl", scale: MASS_CONC_MG_DL("creatinine") },
  bilirubin: { field: "bilirubinMgDl", scale: MASS_CONC_MG_DL("bilirubin") },
  sodium: {
    field: "sodiumMeqL",
    scale: {
      ucum: "meq/L",
      quantity: "a sodium concentration",
      synonyms: ["meq/L", "mEq/L", "meq/l", "mEq/l"],
      // Sodium is monovalent, so the two scales coincide exactly. The factor
      // is 1 and the number does not move, but it is recorded as a conversion
      // rather than waved through as a synonym: the equality holds because of
      // a fact about sodium, not about the units, and a reader should see that
      // the system relied on it.
      convertsFrom: [
        { ucum: "mmol/L", synonyms: ["mmol/L", "mmol/l"], apply: (v) => v, rule: "sodium is monovalent, so 1 mmol/L = 1 meq/L" },
      ],
    },
  },
  inr: {
    field: "inr",
    scale: { ucum: "1", quantity: "a ratio", synonyms: ["", "1", "{INR}", "{ratio}"] },
  },
  lengthOfStay: {
    field: "lengthOfStayDays",
    scale: {
      ucum: "d",
      quantity: "a length of stay",
      synonyms: ["d", "day", "days"],
      convertsFrom: [
        { ucum: "h", synonyms: ["h", "hour", "hours", "hr"], apply: (v) => v / 24, rule: "24 h = 1 d" },
        { ucum: "min", synonyms: ["min", "minute", "minutes"], apply: (v) => v / 1440, rule: "1440 min = 1 d" },
      ],
    },
  },
  charlsonScore: { field: "charlsonScore", scale: DIMENSIONLESS("a Charlson point total") },
  edVisitsPastSixMonths: { field: "edVisitsPastSixMonths", scale: DIMENSIONLESS("a count of visits") },
  nauseaVomiting: { field: "nauseaVomiting", scale: DIMENSIONLESS("a CIWA-Ar item") },
  tremor: { field: "tremor", scale: DIMENSIONLESS("a CIWA-Ar item") },
  paroxysmalSweats: { field: "paroxysmalSweats", scale: DIMENSIONLESS("a CIWA-Ar item") },
  anxiety: { field: "anxiety", scale: DIMENSIONLESS("a CIWA-Ar item") },
  agitation: { field: "agitation", scale: DIMENSIONLESS("a CIWA-Ar item") },
  tactileDisturbances: { field: "tactileDisturbances", scale: DIMENSIONLESS("a CIWA-Ar item") },
  auditoryDisturbances: { field: "auditoryDisturbances", scale: DIMENSIONLESS("a CIWA-Ar item") },
  visualDisturbances: { field: "visualDisturbances", scale: DIMENSIONLESS("a CIWA-Ar item") },
  headache: { field: "headache", scale: DIMENSIONLESS("a CIWA-Ar item") },
  orientation: { field: "orientation", scale: DIMENSIONLESS("a CIWA-Ar item") },
};

/** Every scorer field reachable through the measurement contract. */
export const MEASURED_FIELDS: ReadonlySet<string> = new Set(
  Object.values(SCORE_MEASUREMENTS).map((m) => m.field)
);

/** What happened to one supplied measurement, so the score can show its working. */
export type Ingested =
  | { input: string; field: string; unit: string; canonical: string; converted: false }
  | {
      input: string;
      field: string;
      converted: true;
      from: { value: number; unit: string };
      to: { value: number; unit: string };
      rule: string;
    };

export interface Ingestion {
  contract: string;
  system: string;
  measurements: Ingested[];
}

const matches = (scale: { ucum: string; synonyms: readonly string[] }, unit: string): boolean =>
  scale.ucum.toLowerCase() === unit.toLowerCase() ||
  scale.synonyms.some((s) => s.toLowerCase() === unit.toLowerCase());

/**
 * Resolves one measurement onto the scale its instrument is written in.
 *
 * The only place a unit turns into a number. Everything downstream of it
 * handles canonical values, which is what keeps a conversion from ever
 * happening inside a scorer.
 */
export function canonicalise(input: string, m: Measurement): { value: number; record: Ingested } {
  const known = SCORE_MEASUREMENTS[input];
  if (known === undefined) {
    throw new Refusal(
      `${input} is not a measured score input; this contract measures ${Object.keys(SCORE_MEASUREMENTS).sort().join(", ")}`,
      400,
    );
  }
  if (m === null || typeof m !== "object" || Array.isArray(m)) {
    throw new Refusal(`${input} must be an object with a value and a unit`, 400);
  }
  if (m.system !== undefined && m.system !== UCUM_SYSTEM) {
    throw new Refusal(
      `${input} states unit system ${m.system}; this contract reads UCUM (${UCUM_SYSTEM}) only, and will not ` +
        "guess what a code means in another system",
      400,
    );
  }
  if (typeof m.value !== "number" || !Number.isFinite(m.value)) {
    throw new Refusal(`${input} must carry a finite numeric value`, 400);
  }
  if (typeof m.unit !== "string") {
    throw new Refusal(
      `${input} must state the unit it was measured in; ${known.scale.quantity} without a unit is not a measurement`,
      400,
    );
  }

  const { scale, field } = known;
  if (matches(scale, m.unit)) {
    // The same scale under another name. Nothing to compute.
    return { value: m.value, record: { input, field, unit: m.unit, canonical: scale.ucum, converted: false } };
  }
  for (const c of scale.convertsFrom ?? []) {
    if (matches(c, m.unit)) {
      const value = c.apply(m.value);
      return {
        value,
        record: {
          input,
          field,
          converted: true,
          from: { value: m.value, unit: m.unit },
          to: { value, unit: scale.ucum },
          rule: c.rule,
        },
      };
    }
  }
  for (const r of scale.refuses ?? []) {
    if (matches(r, m.unit)) {
      throw new Refusal(`${input} was measured in ${m.unit} and this instrument is scored in ${scale.ucum}: ${r.because}`, 400);
    }
  }
  const accepted = [scale.ucum, ...scale.synonyms.filter((s) => s !== "")];
  const convertible = (scale.convertsFrom ?? []).map((c) => c.ucum);
  throw new Refusal(
    `${input} was measured in ${m.unit}, which this system cannot read as ${scale.quantity}. ` +
      `It is scored in ${scale.ucum} (also accepted: ${accepted.join(", ")})` +
      (convertible.length > 0 ? `, and converts from ${convertible.join(", ")}` : "") +
      ".",
    400,
  );
}

/**
 * The ingestion boundary: measurements in, canonical scorer input out.
 *
 * Returns the scorer's own parameters alongside a record of what was accepted
 * as given and what was converted, so the conversion is auditable rather than
 * invisible.
 */
export function ingest(measurements: Readonly<Record<string, Measurement>>): {
  input: Record<string, number>;
  ingestion: Ingestion;
} {
  const input: Record<string, number> = {};
  const records: Ingested[] = [];
  for (const [name, m] of Object.entries(measurements)) {
    const { value, record } = canonicalise(name, m);
    input[record.field] = value;
    records.push(record);
  }
  return {
    input,
    ingestion: { contract: MEASUREMENT_CONTRACT, system: UCUM_SYSTEM, measurements: records },
  };
}

/** The measurement name feeding each scorer parameter. */
export const MEASUREMENT_BY_FIELD: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(SCORE_MEASUREMENTS).map(([name, m]) => [m.field, name])
);

export type RecordedReading =
  | {
      usable: true;
      value: number;
      /** What the chart recorded, or null where it recorded none. */
      recordedUnit: string | null;
      conversion: { from: string; to: string; rule: string } | null;
    }
  | { usable: false; reason: string };

/**
 * Reads a value off the chart onto the scale an instrument is scored in.
 *
 * The chart is the other ingestion boundary, and the more dangerous one: a
 * caller at least knows what they sent, while a value that has been sitting in
 * a record for a week carries whatever unit the interface that wrote it used.
 *
 * Returns a result rather than throwing, because a chart-derived score already
 * has a way to say it could not use something — the input goes `unavailable`
 * with a reason, exactly as a stale or absent one does — and a refusal would
 * fail the whole score where the instrument only needs to report the gap.
 *
 * A reading whose unit is *absent* is passed through unchanged. That is not an
 * endorsement: vitals recorded before this contract carry no unit at all, and
 * refusing them would blind every chart-derived score to the entire existing
 * record. The unit that was found — or its absence — travels with the value
 * into the evidence, so a reader can see which of the two they are looking at.
 * A reading whose unit is present and wrong is refused, because that is the
 * case where the number is confidently on the wrong scale.
 */
export function readRecorded(field: string, value: number, unit: string | null): RecordedReading {
  const name = MEASUREMENT_BY_FIELD[field];
  const known = name === undefined ? undefined : SCORE_MEASUREMENTS[name];
  if (known === undefined) return { usable: true, value, recordedUnit: unit, conversion: null };

  const { scale } = known;
  if (unit === null || unit.trim() === "") {
    return { usable: true, value, recordedUnit: null, conversion: null };
  }
  if (matches(scale, unit)) {
    return { usable: true, value, recordedUnit: unit, conversion: null };
  }
  for (const c of scale.convertsFrom ?? []) {
    if (matches(c, unit)) {
      return {
        usable: true,
        value: c.apply(value),
        recordedUnit: unit,
        conversion: { from: unit, to: scale.ucum, rule: c.rule },
      };
    }
  }
  const why = (scale.refuses ?? []).find((r) => matches(r, unit));
  return {
    usable: false,
    reason:
      `the most recent reading is recorded in ${unit} and this instrument is scored in ${scale.ucum}` +
      (why ? `: ${why.because}` : ", which this system cannot convert without guessing what was meant"),
  };
}
