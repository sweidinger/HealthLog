/**
 * v1.5.4 — Medication wizard payload + pure helpers.
 *
 * The wizard is a popup that drives the same eight-step decision in
 * Marc's "one question per breath" cadence. The pure helpers here
 * (state machine, validation gate, request body builder, summary
 * formatter) carry the test surface; the dialog and step components
 * compose them.
 *
 * Step encoding:
 *   1. Name
 *   2. Treatment class / clinical category
 *   3. Dose
 *   4. Course window
 *   5. Cadence
 *   6. Sub-cadence detail (conditional)
 *   7. Times of day
 *   8. Reminders + summary
 *
 * The visible step counter follows the path the user actually walks:
 *
 *   ONE_SHOT_PATH  = [1, 2, 3, 4, 8]       — 5 steps
 *   DAILY_PATH     = [1, 2, 3, 4, 5, 7, 8] — 7 steps
 *   RECURRING_PATH = [1, 2, 3, 4, 5, 6, 7, 8] — 8 steps
 *
 * The mode is set in Step 5: "Einmalig" picks `oneShot`; every other
 * radio picks `recurring`. The cadence kind drives the path between
 * daily (skips Step 6) and the calendar-anchored / rolling shapes.
 *
 * Each row in Step 2 maps to a `(treatmentClass, category)` pair that
 * the request body carries. GLP-1-Injektion is the only row that picks
 * `treatmentClass = "GLP1"`; every other row inherits `GENERIC` and
 * differs only on the clinical-category bucket the analytics layer
 * reads. The mapping table is the single source of truth.
 */

import { encodeCadence } from "@/components/medications/scheduling/CadencePicker";
import {
  dateToIsoString,
  isoStringToDate,
} from "@/components/medications/scheduling/CourseWindowRow";
import {
  type CadenceKind,
  type CadenceSubControls,
  type CadenceValue,
  DEFAULT_SUB_CONTROLS,
} from "@/components/medications/scheduling/types";
import {
  inferCadenceFromLegacy,
  legacyPairFromCadence,
} from "@/components/medications/scheduling/legacy-bridge";
import {
  type MedicationTreatmentClass,
  type MedicationCategoryValue,
} from "@/lib/validations/medication";

// ────────────────────────────────────────────────────────────────────
// Step 2 — treatment-class taxonomy
// ────────────────────────────────────────────────────────────────────

/**
 * Step 2 row identifiers. Distinct from `MedicationCategoryValue` so a
 * single picker row can map onto the orthogonal `(treatmentClass,
 * category)` pair the schema persists.
 */
export type WizardTreatmentRow =
  | "bloodPressure"
  | "diabetes"
  | "hormone"
  | "glp1"
  | "painRelief"
  | "allergy"
  | "vitamin"
  | "supplement"
  | "antibiotic"
  | "other";

/**
 * The ten taxonomy rows in their visible order. Marc-confirmed (D-1
 * §3 Step 2): Blutdruck · Diabetes · Hormone · GLP-1-Injektion ·
 * Schmerz · Allergie · Vitamine · Nahrungsergänzung · Antibiotikum ·
 * Sonstiges.
 */
export const WIZARD_TREATMENT_ROWS: readonly WizardTreatmentRow[] = [
  "bloodPressure",
  "diabetes",
  "hormone",
  "glp1",
  "painRelief",
  "allergy",
  "vitamin",
  "supplement",
  "antibiotic",
  "other",
];

/**
 * Mapping table: Step 2 row → `(treatmentClass, category)` pair the
 * request body carries. GLP-1 is the only row that bends the Prisma
 * treatment-class enum; every other row inherits `GENERIC`.
 */
export const WIZARD_TREATMENT_MAPPING: Record<
  WizardTreatmentRow,
  { treatmentClass: MedicationTreatmentClass; category: MedicationCategoryValue }
> = {
  bloodPressure: { treatmentClass: "GENERIC", category: "BLOOD_PRESSURE" },
  diabetes: { treatmentClass: "GENERIC", category: "DIABETES" },
  hormone: { treatmentClass: "GENERIC", category: "HORMONE" },
  glp1: { treatmentClass: "GLP1", category: "OTHER" },
  painRelief: { treatmentClass: "GENERIC", category: "PAIN_RELIEF" },
  allergy: { treatmentClass: "GENERIC", category: "ALLERGY" },
  vitamin: { treatmentClass: "GENERIC", category: "VITAMIN" },
  supplement: { treatmentClass: "GENERIC", category: "SUPPLEMENT" },
  antibiotic: { treatmentClass: "GENERIC", category: "ANTIBIOTIC" },
  other: { treatmentClass: "GENERIC", category: "OTHER" },
};

/**
 * Reverse-map a `(treatmentClass, category)` pair onto the Step 2 row
 * the wizard pre-selects on edit. GLP-1 takes priority (a GLP-1
 * medication is a GLP-1 row regardless of the side-table value).
 * Unknown categories fall back to "other".
 */
export function rowFromTreatment(
  treatmentClass: string | undefined,
  category: string | undefined,
): WizardTreatmentRow {
  if (treatmentClass === "GLP1") return "glp1";
  switch (category) {
    case "BLOOD_PRESSURE":
      return "bloodPressure";
    case "DIABETES":
      return "diabetes";
    case "HORMONE":
      return "hormone";
    case "PAIN_RELIEF":
      return "painRelief";
    case "ALLERGY":
      return "allergy";
    case "VITAMIN":
      return "vitamin";
    case "SUPPLEMENT":
      return "supplement";
    case "ANTIBIOTIC":
      return "antibiotic";
    default:
      return "other";
  }
}

// ────────────────────────────────────────────────────────────────────
// Wizard payload
// ────────────────────────────────────────────────────────────────────

/**
 * The wizard's working state. The cadence + sub-controls mirror the
 * picker primitives; the treatment row collapses Step 2's
 * `(treatmentClass, category)` decision into a single value the
 * mapping table re-expands at submit time.
 */
export interface WizardPayload {
  name: string;
  doseAmount: string;
  doseUnit: string;
  treatmentRow: WizardTreatmentRow | null;
  /** Set in Step 5. */
  mode: "oneShot" | "recurring" | null;
  cadence: CadenceValue;
  subControls: CadenceSubControls;
  timesOfDay: string[];
  startsOn: Date | null;
  endsOn: Date | null;
  notificationsEnabled: boolean;
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function todayUtc(): Date {
  const now = new Date();
  return new Date(
    Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0),
  );
}

/** Sensible defaults for a fresh wizard. */
export function emptyWizardPayload(): WizardPayload {
  return {
    name: "",
    doseAmount: "",
    doseUnit: "mg",
    treatmentRow: null,
    mode: null,
    cadence: encodeCadence("daily", DEFAULT_SUB_CONTROLS),
    subControls: { ...DEFAULT_SUB_CONTROLS },
    timesOfDay: ["08:00"],
    startsOn: todayUtc(),
    endsOn: null,
    notificationsEnabled: true,
  };
}

// ────────────────────────────────────────────────────────────────────
// Path table — visible step counter
// ────────────────────────────────────────────────────────────────────

const ONE_SHOT_PATH: readonly number[] = [1, 2, 3, 4, 8];
const DAILY_PATH: readonly number[] = [1, 2, 3, 4, 5, 7, 8];
const RECURRING_PATH: readonly number[] = [1, 2, 3, 4, 5, 6, 7, 8];

/**
 * The ordered list of raw step numbers for the active mode + cadence.
 * Mirrors v1.5.3's `progressIndices` shape so the visible counter
 * tracks the path the user actually walks.
 *
 * The mode is set in Step 5. Before that, the wizard renders the
 * recurring path so the displayed counter stays monotone.
 */
export function progressIndices(
  mode: WizardPayload["mode"],
  cadenceKind: CadenceKind,
): readonly number[] {
  if (mode === "oneShot") return ONE_SHOT_PATH;
  if (mode === "recurring" && cadenceKind === "daily") return DAILY_PATH;
  return RECURRING_PATH;
}

// ────────────────────────────────────────────────────────────────────
// validateStep — pure per-step gate
// ────────────────────────────────────────────────────────────────────

/**
 * Returns true when the step's required inputs are populated.
 *
 * Matrix:
 *  - Step 1: name populated.
 *  - Step 2: treatment row picked.
 *  - Step 3: doseAmount populated.
 *  - Step 4: startsOn present + (endsOn null OR endsOn >= startsOn).
 *  - Step 5: mode picked.
 *  - Step 6: cadence-specific (weekdays >= 1; interval >= 1; monthly
 *    day 1..31; rolling 1..365).
 *  - Step 7: >= 1 valid HH:mm time.
 *  - Step 8: mirrors Step 4 (the reminders toggle has no failure mode).
 */
export function validateStep(payload: WizardPayload, step: number): boolean {
  switch (step) {
    case 1:
      return payload.name.trim().length > 0;
    case 2:
      return payload.treatmentRow !== null;
    case 3:
      return payload.doseAmount.trim().length > 0;
    case 4:
      if (payload.startsOn === null) return false;
      if (payload.endsOn === null) return true;
      return payload.endsOn.getTime() >= payload.startsOn.getTime();
    case 5:
      return payload.mode !== null;
    case 6: {
      if (payload.mode !== "recurring") return true;
      switch (payload.cadence.kind) {
        case "weekdays":
          return payload.subControls.weekdays.length >= 1;
        case "everyNWeeks":
          return (
            payload.subControls.weekdays.length >= 1 &&
            payload.subControls.intervalWeeks >= 1
          );
        case "monthly":
          return (
            payload.subControls.dayOfMonth >= 1 &&
            payload.subControls.dayOfMonth <= 31
          );
        case "rolling":
          return (
            payload.subControls.rollingDays >= 1 &&
            payload.subControls.rollingDays <= 365
          );
        default:
          return true;
      }
    }
    case 7: {
      const times = payload.timesOfDay.filter((t) => TIME_RE.test(t));
      return times.length >= 1;
    }
    case 8:
      if (payload.startsOn === null) return false;
      if (payload.endsOn === null) return true;
      return payload.endsOn.getTime() >= payload.startsOn.getTime();
    default:
      return false;
  }
}

// ────────────────────────────────────────────────────────────────────
// buildCreateBody — POST /api/medications request body
// ────────────────────────────────────────────────────────────────────

export interface CreateMedicationBody {
  name: string;
  dose: string;
  category: MedicationCategoryValue;
  treatmentClass: MedicationTreatmentClass;
  notificationsEnabled: boolean;
  startsOn?: string;
  endsOn?: string;
  oneShot: boolean;
  schedules: Array<{
    windowStart: string;
    windowEnd: string;
    timesOfDay: string[];
    rrule?: string;
    rollingIntervalDays?: number;
    daysOfWeek?: number[];
    intervalWeeks?: number;
  }>;
}

function composeDose(amount: string, unit: string): string {
  const a = amount.trim();
  const u = unit.trim();
  if (!a) return u;
  if (!u) return a;
  return `${a} ${u}`;
}

function sortTimes(times: string[]): string[] {
  return [...times]
    .filter((t) => TIME_RE.test(t))
    .sort((a, b) => a.localeCompare(b));
}

function deriveWindow(sortedTimes: string[]): [string, string] {
  if (sortedTimes.length === 0) return ["08:00", "09:00"];
  const start = sortedTimes[0];
  if (sortedTimes.length === 1) return [start, addOneHour(start)];
  return [start, sortedTimes[sortedTimes.length - 1]];
}

function addOneHour(hhmm: string): string {
  const m = TIME_RE.exec(hhmm);
  if (!m) return hhmm;
  const h = Number(m[1]);
  const mm = m[2];
  const next = (h + 1) % 24;
  return `${String(next).padStart(2, "0")}:${mm}`;
}

/**
 * Map a wizard payload onto the `POST /api/medications` body. The
 * route still requires the legacy `windowStart` / `windowEnd` pair for
 * the v1.5.x dual-write window; we derive them from the times.
 *
 * The treatment row drives both `treatmentClass` and `category` through
 * the mapping table. The route writes `category` to the side-table.
 */
export function buildCreateBody(payload: WizardPayload): CreateMedicationBody {
  const dose = composeDose(payload.doseAmount, payload.doseUnit);
  const times = sortTimes(
    payload.mode === "oneShot"
      ? payload.timesOfDay.slice(0, 1)
      : payload.timesOfDay,
  );
  const [windowStart, windowEnd] = deriveWindow(times);

  const isOneShot = payload.mode === "oneShot";
  const mapping =
    payload.treatmentRow !== null
      ? WIZARD_TREATMENT_MAPPING[payload.treatmentRow]
      : WIZARD_TREATMENT_MAPPING.other;

  // Legacy dual-write pair so the route's `serializeScheduleRecurrence`
  // sees a consistent shape — mirrors the edit-form bridge.
  const legacyPair = legacyPairFromCadence(payload.cadence, payload.subControls);

  const schedule: CreateMedicationBody["schedules"][number] = {
    windowStart,
    windowEnd,
    timesOfDay: times,
  };
  if (!isOneShot) {
    if (payload.cadence.rrule !== null) {
      schedule.rrule = payload.cadence.rrule;
    } else if (payload.cadence.rollingIntervalDays !== null) {
      schedule.rollingIntervalDays = payload.cadence.rollingIntervalDays;
    }
    if (legacyPair.daysOfWeek.length > 0) {
      schedule.daysOfWeek = legacyPair.daysOfWeek;
    }
    schedule.intervalWeeks = legacyPair.intervalWeeks;
  }

  const body: CreateMedicationBody = {
    name: payload.name.trim(),
    dose,
    category: mapping.category,
    treatmentClass: mapping.treatmentClass,
    notificationsEnabled: payload.notificationsEnabled,
    oneShot: isOneShot,
    schedules: [schedule],
  };
  if (payload.startsOn) {
    body.startsOn = dateToIsoString(payload.startsOn);
  }
  if (isOneShot && payload.startsOn) {
    body.endsOn = dateToIsoString(payload.startsOn);
  } else if (payload.endsOn) {
    body.endsOn = dateToIsoString(payload.endsOn);
  }
  return body;
}

// ────────────────────────────────────────────────────────────────────
// summariseCadence — plain-language Step 8 line
// ────────────────────────────────────────────────────────────────────

function summaryKeyForCadence(payload: WizardPayload): string {
  if (payload.mode === "oneShot") return "oneShot";
  switch (payload.cadence.kind) {
    case "daily":
      return "daily";
    case "weekdays":
      return "weekdays";
    case "everyNWeeks":
      return payload.subControls.intervalWeeks === 2 ? "biweekly" : "everyNWeeks";
    case "monthly":
      return "monthly";
    case "everyNMonths":
      return payload.subControls.intervalMonths === 3 ? "quarterly" : "everyNMonths";
    case "yearly":
      return "yearly";
    case "rolling":
      return "rolling";
    case "oneShot":
      return "oneShot";
  }
}

function weekdaysDetail(
  tokens: readonly string[],
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  if (tokens.length === 0) return "";
  const names = tokens
    .map((tok) =>
      t(`medications.scheduling.cadence.weekdays.long.${tok.toLowerCase()}`),
    )
    .filter(Boolean);
  if (names.length === 0) return "";
  return t("medications.wizard.summary.weekdaysDetail", {
    days: names.join(", "),
  });
}

function cadenceDetailPhrase(
  payload: WizardPayload,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  if (payload.mode === "oneShot") return "";
  switch (payload.cadence.kind) {
    case "weekdays":
      return weekdaysDetail(payload.subControls.weekdays, t);
    case "everyNWeeks":
      return weekdaysDetail(payload.subControls.weekdays, t);
    case "monthly":
      return t("medications.wizard.summary.dayOfMonthDetail", {
        day: payload.subControls.dayOfMonth,
      });
    default:
      return "";
  }
}

/**
 * Plain-language summary for Step 8. Mirrors v1.5.3's helper shape so
 * the test surface stays familiar. The `t` callback is passed in so
 * the helper stays pure (no React hook coupling).
 */
export function summariseCadence(
  payload: WizardPayload,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  const cadenceKey = summaryKeyForCadence(payload);
  const cadencePhrase = t(
    `medications.wizard.summary.cadence.${cadenceKey}`,
    {
      n:
        payload.cadence.kind === "everyNWeeks"
          ? payload.subControls.intervalWeeks
          : payload.cadence.kind === "rolling"
            ? (payload.cadence.rollingIntervalDays ?? 0)
            : 0,
    },
  );
  const cadenceDetail = cadenceDetailPhrase(payload, t);
  const cadenceLine = cadencePhrase + cadenceDetail;
  const timesPhrase =
    payload.mode !== "oneShot" && payload.timesOfDay.length > 0
      ? t("medications.wizard.summary.times", {
          times: sortTimes(payload.timesOfDay).join(", "),
        })
      : "";
  const startPhrase = payload.startsOn
    ? t("medications.wizard.summary.startsOn", {
        date: dateToIsoString(payload.startsOn),
      })
    : "";
  const endPhrase =
    payload.mode === "oneShot"
      ? ""
      : payload.endsOn
        ? t("medications.wizard.summary.endsOn", {
            date: dateToIsoString(payload.endsOn),
          })
        : t("medications.wizard.summary.noEndDate");
  return [cadenceLine, timesPhrase, startPhrase, endPhrase]
    .filter(Boolean)
    .join(" · ");
}

// ────────────────────────────────────────────────────────────────────
// Hydration — edit-path payload from an existing medication
// ────────────────────────────────────────────────────────────────────

/**
 * Snapshot of a medication's persisted state, as the list page passes
 * it to `<MedicationWizardDialog mode="edit">`. Schedules carry both
 * the v1.5 cadence fields and the legacy `(daysOfWeek, intervalWeeks)`
 * pair so the bridge can hydrate older medications cleanly.
 */
export interface MedicationPayload {
  id: string;
  name: string;
  dose: string;
  category: string;
  treatmentClass?: string;
  notificationsEnabled: boolean;
  startsOn: Date | null;
  endsOn: Date | null;
  oneShot: boolean;
  schedules: Array<{
    windowStart: string;
    windowEnd: string;
    label?: string | null;
    dose?: string | null;
    daysOfWeek?: number[];
    intervalWeeks?: number;
    timesOfDay?: string[];
    rrule?: string | null;
    rollingIntervalDays?: number | null;
  }>;
}

const DOSE_EXPR_RE = /^\s*(\d+(?:[.,]\d+)?)\s*(.*)$/;

/** Try to split "5 mg" into ["5", "mg"]; falls back to ["", input]. */
function parseDoseExpression(input: string): { amount: string; unit: string } {
  const match = DOSE_EXPR_RE.exec(input.trim());
  if (!match) return { amount: "", unit: input.trim() };
  const amount = match[1] ?? "";
  const unit = (match[2] ?? "").trim();
  return { amount, unit };
}

/**
 * Hydrate a `WizardPayload` from a medication snapshot. The legacy
 * bridge (`inferCadenceFromLegacy`) infers a cadence from the
 * `(daysOfWeek, intervalWeeks)` pair when the v1.5 `rrule` /
 * `rollingIntervalDays` fields are absent. The first schedule wins
 * (multi-schedule edit support lands in v1.5.5 — until then the
 * dialog surfaces a "Mehrere Zeitpläne" link that routes back to the
 * legacy flat form).
 */
export function hydrateWizardPayload(initial: MedicationPayload): WizardPayload {
  const base = emptyWizardPayload();
  const parsedDose = parseDoseExpression(initial.dose ?? "");
  const firstSchedule = initial.schedules[0];

  const cadence = firstSchedule
    ? deriveCadenceFromSchedule(firstSchedule, initial.oneShot)
    : { value: base.cadence, subControls: base.subControls };

  const times =
    firstSchedule?.timesOfDay && firstSchedule.timesOfDay.length > 0
      ? [...firstSchedule.timesOfDay]
      : firstSchedule?.windowStart
        ? [firstSchedule.windowStart]
        : base.timesOfDay;

  return {
    ...base,
    name: initial.name ?? "",
    doseAmount: parsedDose.amount,
    doseUnit: parsedDose.unit || base.doseUnit,
    treatmentRow: rowFromTreatment(initial.treatmentClass, initial.category),
    mode: initial.oneShot ? "oneShot" : "recurring",
    cadence: cadence.value,
    subControls: cadence.subControls,
    timesOfDay: times,
    startsOn: initial.startsOn ?? base.startsOn,
    endsOn: initial.endsOn,
    notificationsEnabled: initial.notificationsEnabled ?? true,
  };
}

function deriveCadenceFromSchedule(
  schedule: MedicationPayload["schedules"][number],
  oneShot: boolean,
): { value: CadenceValue; subControls: CadenceSubControls } {
  if (oneShot) {
    const sub = { ...DEFAULT_SUB_CONTROLS };
    return { value: encodeCadence("oneShot", sub), subControls: sub };
  }
  if (typeof schedule.rollingIntervalDays === "number") {
    const sub: CadenceSubControls = {
      ...DEFAULT_SUB_CONTROLS,
      rollingDays: schedule.rollingIntervalDays,
    };
    return { value: encodeCadence("rolling", sub), subControls: sub };
  }
  if (typeof schedule.rrule === "string" && schedule.rrule.length > 0) {
    const sub = subControlsFromRrule(schedule.rrule);
    const kind = kindFromRrule(schedule.rrule);
    return { value: encodeCadence(kind, sub), subControls: sub };
  }
  // Legacy fallback — infer from daysOfWeek + intervalWeeks.
  return inferCadenceFromLegacy({
    daysOfWeek: schedule.daysOfWeek ?? [],
    intervalWeeks: schedule.intervalWeeks ?? 1,
  });
}

function kindFromRrule(rrule: string): CadenceKind {
  // Lightweight inspection — the picker re-encodes the RRULE on every
  // change so the wizard never relies on a perfect parse here.
  if (rrule.includes("FREQ=DAILY")) return "daily";
  if (rrule.includes("FREQ=WEEKLY")) {
    return /INTERVAL=([2-9]|[1-9]\d)/.test(rrule) ? "everyNWeeks" : "weekdays";
  }
  if (rrule.includes("FREQ=MONTHLY")) {
    return /INTERVAL=([2-9]|[1-9]\d)/.test(rrule) ? "everyNMonths" : "monthly";
  }
  if (rrule.includes("FREQ=YEARLY")) return "yearly";
  return "daily";
}

function subControlsFromRrule(rrule: string): CadenceSubControls {
  const sub: CadenceSubControls = { ...DEFAULT_SUB_CONTROLS };
  const byday = /BYDAY=([A-Z,]+)/.exec(rrule);
  if (byday) {
    const tokens = byday[1].split(",").filter((t) =>
      ["MO", "TU", "WE", "TH", "FR", "SA", "SU"].includes(t),
    );
    if (tokens.length > 0) {
      sub.weekdays = tokens as CadenceSubControls["weekdays"];
    }
  }
  const interval = /INTERVAL=(\d{1,3})/.exec(rrule);
  if (interval) {
    const n = Number(interval[1]);
    if (rrule.includes("FREQ=WEEKLY")) sub.intervalWeeks = n;
    else if (rrule.includes("FREQ=MONTHLY")) sub.intervalMonths = n;
  }
  const bymonthday = /BYMONTHDAY=(-?\d{1,2})/.exec(rrule);
  if (bymonthday) {
    const n = Number(bymonthday[1]);
    if (n >= 1 && n <= 31) sub.dayOfMonth = n;
  }
  const bymonth = /BYMONTH=(\d{1,2})/.exec(rrule);
  if (bymonth && bymonthday) {
    const month = Number(bymonth[1]);
    const day = Number(bymonthday[1]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      sub.yearlyDate = `${new Date().getUTCFullYear()}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
  }
  return sub;
}

// ────────────────────────────────────────────────────────────────────
// Re-exports — convenience for the dialog and tests
// ────────────────────────────────────────────────────────────────────

export { dateToIsoString, isoStringToDate };
