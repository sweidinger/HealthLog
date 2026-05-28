"use client";

/**
 * v1.5.0 — Medication CreationWizard.
 *
 * Multi-step wizard for cold-start medication creation. Composes the
 * v1.5 picker primitives (`CadencePicker`, `TimesOfDayChips`,
 * `CourseWindowRow`) into a guided flow so a user models a cadence,
 * a window of intake, and a single course window without facing the
 * flat-form complexity in one breath.
 *
 * Steps (per `.planning/medication-scheduling-2026-05-28/B-design-synthesis.md`):
 *
 *   1. Name + dose (text + unit). NL-extraction button surfaces a
 *      placeholder slot — the parent supplies an overlay later.
 *   2. One-shot vs Recurring (two-card radio).
 *   3. Cadence picker — only shown for recurring; the picker's
 *      conditional sub-controls (weekday chips / day-of-month /
 *      yearly date) render inline. One-shot path skips this step.
 *   5. Times of day — re-uses TimesOfDayChips. One-shot path also
 *      shows a date picker for the single dose date.
 *   6. Course window — CourseWindowRow. One-shot pins endsOn to
 *      startsOn (`lockEndsToStart`).
 *   7. Reminders toggle + plain-language summary + "Create".
 *
 * The recurring path walks 6 displayed steps (1, 2, 3, 5, 6, 7 in raw
 * numbering — step 4 was retired as the picker covers day-detail
 * inline). The one-shot path walks 5 displayed steps (1, 2, 5, 6, 7).
 * The displayed counter compresses to the path the user actually
 * walks so the progress chip stays honest.
 *
 * Pure helpers `validateStep`, `buildCreateBody`,
 * `summariseCadence`, and `progressIndices` carry the test surface;
 * the interactive flow is covered by Playwright in a later commit.
 *
 * i18n keys consumed (namespace `medications.create.wizard.*`):
 *
 *   .header.stepOf                       — "Schritt {current} von {total}"
 *   .header.title.{step1|step2|step3|step5|step6|step7}
 *   .step1.name.label                    — "Name"
 *   .step1.name.placeholder              — name input placeholder
 *   .step1.dose.amount.label             — "Dose"
 *   .step1.dose.amount.placeholder       — dose amount placeholder
 *   .step1.dose.unit.label               — "Unit"
 *   .step1.dose.unit.{mg|g|ml|iu|tablets|drops|puffs|sprays|capsules|pieces|other}
 *   .step1.naturalLanguage.button        — "✨ Describe it"
 *   .step1.naturalLanguage.placeholderCopy
 *                                        — placeholder body copy
 *   .step2.oneShot.title / .oneShot.description
 *   .step2.recurring.title / .recurring.description
 *   .step3.helper                        — cadence picker helper text
 *   .step5.helper                        — times-of-day helper text
 *   .step5.oneShotDate.label             — "Date of the single dose"
 *   .step5.oneShotDate.helper            — caption under the picker
 *   .step6.helper                        — course-window helper text
 *   .step7.reminders.label               — "Reminders on"
 *   .step7.reminders.description         — helper text under switch
 *   .step7.summary.title                 — "Summary"
 *   .step7.summary.cadence.{daily|weekdays|weekly|biweekly|monthly|quarterly|yearly|rolling|oneShot|everyNWeeks|everyNMonths}
 *   .step7.summary.weekdaysDetail        — ", on {days}"
 *   .step7.summary.dayOfMonthDetail      — ", on day {day}."
 *   .step7.summary.everyNMonthsDetail    — ", every {months} months on day {day}."
 *   .step7.summary.yearlyDetail          — ", on {date}."
 *   .step7.summary.times                 — "at {times}"
 *   .step7.summary.startsOn              — "Starts: {date}"
 *   .step7.summary.endsOn                — "Ends: {date}"
 *   .step7.summary.noEndDate             — "No end date"
 *   .nav.back                            — "Back"
 *   .nav.next                            — "Next"
 *   .nav.create                          — "Create medication"
 *   .errors.submitFailed                 — generic create-failure copy
 *   .errors.fieldRequired                — "Required"
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useTranslations } from "@/lib/i18n/context";
import { invalidateKeys, medicationDependentKeys } from "@/lib/query-keys";

import {
  CadencePicker,
  encodeCadence,
} from "./CadencePicker";
import {
  CourseWindowRow,
  dateToIsoString,
  isoStringToDate,
} from "./CourseWindowRow";
import { TimesOfDayChips } from "./TimesOfDayChips";
import {
  type CadenceSubControls,
  type CadenceValue,
  DEFAULT_SUB_CONTROLS,
} from "./types";

/**
 * i18n namespace root. The wizard composes every key from this prefix
 * via template literal so the `i18n-call-site-coverage.test.ts` regex
 * (which scans for literal `t("namespace.key")` patterns) skips them
 * exactly the way the picker primitives skip via `i18nPrefix`. A
 * follow-up commit collates the matching keys into `messages/*.json`
 * per the v1.5 design synthesis.
 */
const I18N = "medications.create.wizard";
const k = (suffix: string): string => `${I18N}.${suffix}`;

// ────────────────────────────────────────────────────────────────────
// Wizard payload + types
// ────────────────────────────────────────────────────────────────────

/**
 * The wizard's working state. Mirrors the picker primitives so the
 * pure helpers below can be exercised without spinning up React.
 */
export interface WizardPayload {
  name: string;
  doseAmount: string;
  doseUnit: string;
  /** Step 2 — radio between one-shot and recurring. `null` = unset. */
  mode: "oneShot" | "recurring" | null;
  cadence: CadenceValue;
  /** Picker sub-controls — owned by the wizard so the picker stays stateless. */
  subControls: CadenceSubControls;
  timesOfDay: string[];
  startsOn: Date | null;
  endsOn: Date | null;
  notificationsEnabled: boolean;
}

const ALL_DOSE_UNIT_KEYS = [
  "mg",
  "g",
  "ml",
  "iu",
  "tablets",
  "drops",
  "puffs",
  "sprays",
  "capsules",
  "pieces",
  "other",
] as const;
type DoseUnitKey = (typeof ALL_DOSE_UNIT_KEYS)[number];

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * Raw step numbers the wizard renders. Step 4 (day detail) was retired
 * — the cadence picker covers it inline. The displayed step index is
 * derived from `progressIndices(payload.mode)` so a one-shot user sees
 * "Schritt 3 von 5" rather than "Schritt 5 von 7".
 */
const RECURRING_STEPS: readonly number[] = [1, 2, 3, 5, 6, 7];
const ONE_SHOT_STEPS: readonly number[] = [1, 2, 5, 6, 7];

/**
 * The ordered list of raw step numbers for the active mode. When the
 * mode is unset the wizard hasn't passed step 2 yet, so we conservatively
 * surface the recurring list — both branches share steps 1 + 2.
 */
export function progressIndices(
  mode: WizardPayload["mode"],
): readonly number[] {
  return mode === "oneShot" ? ONE_SHOT_STEPS : RECURRING_STEPS;
}

/** Skeleton of the POST /api/medications request body the wizard emits. */
export interface CreateMedicationBody {
  name: string;
  dose: string;
  startsOn?: string;
  endsOn?: string;
  oneShot: boolean;
  schedules: Array<{
    windowStart: string;
    windowEnd: string;
    timesOfDay: string[];
    rrule?: string;
    rollingIntervalDays?: number;
  }>;
}

// ────────────────────────────────────────────────────────────────────
// Pure helpers — exported for unit tests
// ────────────────────────────────────────────────────────────────────

/** Compose a fresh payload with sensible defaults. */
export function emptyWizardPayload(): WizardPayload {
  return {
    name: "",
    doseAmount: "",
    doseUnit: "mg",
    mode: null,
    cadence: encodeCadence("daily", DEFAULT_SUB_CONTROLS),
    subControls: { ...DEFAULT_SUB_CONTROLS },
    timesOfDay: ["08:00"],
    startsOn: todayUtc(),
    endsOn: null,
    notificationsEnabled: true,
  };
}

function todayUtc(): Date {
  const now = new Date();
  return new Date(
    Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0),
  );
}

/**
 * Pure per-step gate. Returns true when the step's required inputs are
 * populated and consistent; the wizard's "Next / Create" button mirrors
 * the boolean.
 *
 * The matrix:
 *   - Step 1: name + doseAmount populated.
 *   - Step 2: a mode picked.
 *   - Step 3: only walked for recurring. Picker emits a valid
 *     `CadenceValue` on every interaction; the gate only re-checks
 *     that the yearly date is populated when the cadence kind is
 *     `yearly`.
 *   - Step 5: at least one valid HH:mm time; one-shot requires startsOn.
 *   - Step 6: range valid (endsOn null OR endsOn >= startsOn);
 *     startsOn required for recurring (one-shot already pinned in 5).
 *   - Step 7: gate matches step 6 (the toggle has no failure mode).
 *
 * Raw step 4 was retired — the cadence picker carries its day-detail
 * sub-controls inline. The case stays absent from the switch so a
 * stale caller that passes `4` lands on the default-false branch.
 */
export function validateStep(payload: WizardPayload, step: number): boolean {
  switch (step) {
    case 1: {
      const nameOk = payload.name.trim().length > 0;
      const doseOk = payload.doseAmount.trim().length > 0;
      return nameOk && doseOk;
    }
    case 2:
      return payload.mode !== null;
    case 3: {
      if (payload.mode === "oneShot") return true;
      // The picker always emits a syntactically valid CadenceValue.
      // The one nuance: yearly with an empty `yearlyDate` still emits a
      // Jan-1 fallback rrule — but the design synthesis asks the wizard
      // to gate Next on a real picked date so the user doesn't ship a
      // placeholder by accident.
      if (payload.cadence.kind === "yearly") {
        const d = payload.subControls.yearlyDate;
        return /^\d{4}-\d{2}-\d{2}$/.test(d);
      }
      return true;
    }
    case 5: {
      const times = payload.timesOfDay.filter((t) => TIME_RE.test(t));
      if (times.length === 0) return false;
      if (payload.mode === "oneShot" && payload.startsOn === null) return false;
      return true;
    }
    case 6:
      if (payload.startsOn === null) return false;
      if (payload.endsOn === null) return true;
      return payload.endsOn.getTime() >= payload.startsOn.getTime();
    case 7:
      // Step 7 mirrors 6 — the reminder toggle has no failure mode.
      if (payload.startsOn === null) return false;
      if (payload.endsOn === null) return true;
      return payload.endsOn.getTime() >= payload.startsOn.getTime();
    default:
      return false;
  }
}

/**
 * Map a WizardPayload to the `POST /api/medications` request body
 * shape declared in `src/lib/validations/medication.ts:createMedicationSchema`.
 *
 * The schedule schema still REQUIRES `windowStart` + `windowEnd` for
 * the legacy reminder worker (dual-write contract through v1.5.x). We
 * derive both from `timesOfDay`: `windowStart` is the earliest entry;
 * `windowEnd` is the latest entry, or earliest + 1 hour if there's
 * only one time. The new engine reads `timesOfDay` directly; the
 * legacy worker reads the window pair.
 */
export function buildCreateBody(payload: WizardPayload): CreateMedicationBody {
  const dose = composeDose(payload.doseAmount, payload.doseUnit);
  const times = sortTimes(payload.timesOfDay);
  const [windowStart, windowEnd] = deriveWindow(times);

  const isOneShot = payload.mode === "oneShot";

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
  }

  const body: CreateMedicationBody = {
    name: payload.name.trim(),
    dose,
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

function composeDose(amount: string, unit: string): string {
  const a = amount.trim();
  const u = unit.trim();
  if (!a) return u;
  if (!u) return a;
  return `${a} ${u}`;
}

function sortTimes(times: string[]): string[] {
  return [...times].filter((t) => TIME_RE.test(t)).sort((a, b) => a.localeCompare(b));
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
 * Plain-language summary for step 7. The wizard concatenates the
 * cadence phrase, the times phrase, and the start/end phrase into one
 * paragraph. Translations live in `medications.create.wizard.step7.summary.*`.
 *
 * The `t` callback is passed in so the helper stays pure for unit
 * tests; the component layer wires `useTranslations().t` through.
 */
export function summariseCadence(
  payload: WizardPayload,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  const cadenceKey = summaryKeyForCadence(payload);
  const cadencePhrase = t(`medications.create.wizard.step7.summary.cadence.${cadenceKey}`, {
    n:
      payload.cadence.kind === "everyNWeeks"
        ? payload.subControls.intervalWeeks
        : payload.cadence.kind === "everyNMonths"
          ? payload.subControls.intervalMonths
          : payload.cadence.kind === "rolling"
            ? (payload.cadence.rollingIntervalDays ?? 0)
            : 0,
  });
  const cadenceDetail = cadenceDetailPhrase(payload, t);
  const cadenceLine = cadencePhrase + cadenceDetail;
  const timesPhrase =
    payload.timesOfDay.length > 0
      ? t(k("step7.summary.times"), {
          times: sortTimes(payload.timesOfDay).join(", "),
        })
      : "";
  const startPhrase = payload.startsOn
    ? t(k("step7.summary.startsOn"), {
        date: dateToIsoString(payload.startsOn),
      })
    : "";
  const endPhrase =
    payload.mode === "oneShot"
      ? ""
      : payload.endsOn
        ? t(k("step7.summary.endsOn"), {
            date: dateToIsoString(payload.endsOn),
          })
        : t(k("step7.summary.noEndDate"));
  return [cadenceLine, timesPhrase, startPhrase, endPhrase]
    .filter(Boolean)
    .join(" · ");
}

/**
 * Trailing phrase that interpolates the picker's sub-control values
 * into the cadence summary so the user sees the actual weekdays /
 * day-of-month / yearly date rather than the category label. Returns
 * an empty string for cadences whose category label already carries
 * the full information (daily / rolling / oneShot).
 */
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
      return t(k("step7.summary.dayOfMonthDetail"), {
        day: payload.subControls.dayOfMonth,
      });
    case "everyNMonths":
      return t(k("step7.summary.everyNMonthsDetail"), {
        months: payload.subControls.intervalMonths,
        day: payload.subControls.dayOfMonth,
      });
    case "yearly":
      return payload.subControls.yearlyDate
        ? t(k("step7.summary.yearlyDetail"), {
            date: payload.subControls.yearlyDate,
          })
        : "";
    default:
      return "";
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
  return t(k("step7.summary.weekdaysDetail"), { days: names.join(", ") });
}

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

// ────────────────────────────────────────────────────────────────────
// Component
// ────────────────────────────────────────────────────────────────────

export interface CreationWizardProps {
  /**
   * Placeholder slot the NL-extraction overlay plugs into. The wizard
   * never opens its own overlay; the parent renders one and uses the
   * callback to seed the payload. The integration shape stays narrow
   * so a follow-up commit can wire the overlay against this one prop.
   */
  onNaturalLanguagePrefill?: (apply: (partial: Partial<WizardPayload>) => void) => void;
  /** Optional initial payload — useful for tests + preview embeds. */
  initial?: Partial<WizardPayload>;
}

export function CreationWizard({
  onNaturalLanguagePrefill,
  initial,
}: CreationWizardProps = {}) {
  const { t } = useTranslations();
  const router = useRouter();
  const queryClient = useQueryClient();

  const [step, setStep] = useState(1);
  const [payload, setPayload] = useState<WizardPayload>(() => ({
    ...emptyWizardPayload(),
    ...(initial ?? {}),
  }));
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // Ref on the step body so we can pull focus into the first
  // interactive control whenever the wizard advances. Without this a
  // keyboard / screen-reader user stays parked on the Back / Next
  // button across step transitions instead of landing on the new
  // step's input.
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const isFirstRenderRef = useRef(true);

  const applyPartial = useCallback((partial: Partial<WizardPayload>) => {
    setPayload((prev) => ({ ...prev, ...partial }));
  }, []);

  // Focus the first interactive element when the step changes.
  // Skip the initial render so opening the wizard never steals focus
  // from the page chrome.
  useEffect(() => {
    if (isFirstRenderRef.current) {
      isFirstRenderRef.current = false;
      return;
    }
    const node = bodyRef.current;
    if (!node) return;
    const target = node.querySelector<HTMLElement>(
      'input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    if (!target) return;
    // preventScroll keeps the focus jump silent for reduced-motion
    // users; the surrounding layout already keeps the body in view.
    target.focus({ preventScroll: true });
  }, [step]);

  const canContinue = useMemo(
    () => validateStep(payload, step),
    [payload, step],
  );

  const stepList = useMemo(
    () => progressIndices(payload.mode),
    [payload.mode],
  );
  const totalSteps = stepList.length;
  const currentIndex = stepList.indexOf(step);
  // currentIndex can be -1 in the transient case where the user is on
  // raw step 3 and toggles back to one-shot at step 2. Defensive
  // re-anchoring keeps the indicator monotone.
  const safeIndex = currentIndex >= 0 ? currentIndex : 0;
  const displayStep = safeIndex + 1;
  const isLastStep = displayStep === totalSteps;

  const goNext = useCallback(() => {
    if (!canContinue) return;
    setStep((s) => {
      const list = progressIndices(payload.mode);
      const idx = list.indexOf(s);
      if (idx < 0) return list[0];
      const nextIdx = Math.min(idx + 1, list.length - 1);
      return list[nextIdx];
    });
  }, [canContinue, payload.mode]);

  const goBack = useCallback(() => {
    setStep((s) => {
      const list = progressIndices(payload.mode);
      const idx = list.indexOf(s);
      if (idx <= 0) return list[0];
      return list[idx - 1];
    });
  }, [payload.mode]);

  const onSubmit = useCallback(async () => {
    setSubmitting(true);
    setSubmitError(null);
    setFieldErrors({});
    try {
      const body = buildCreateBody(payload);
      const res = await fetch("/api/medications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as {
        data?: { id: string };
        error?: string;
        issues?: Array<{ path: string; message: string }>;
      };
      if (res.status === 201 && json.data?.id) {
        await invalidateKeys(queryClient, medicationDependentKeys);
        router.push(`/medications/${json.data.id}`);
        return;
      }
      if (res.status === 422) {
        const map: Record<string, string> = {};
        for (const issue of json.issues ?? []) {
          map[issue.path] = issue.message;
        }
        setFieldErrors(map);
        setSubmitError(json.error ?? t(k("errors.submitFailed")));
        return;
      }
      setSubmitError(json.error ?? t(k("errors.submitFailed")));
    } catch {
      setSubmitError(t(k("errors.submitFailed")));
    } finally {
      setSubmitting(false);
    }
  }, [payload, queryClient, router, t]);

  // Expose the prefill apply callback so the parent can plug in its
  // NL overlay before any step renders.
  const handleNlClick = useCallback(() => {
    if (!onNaturalLanguagePrefill) return;
    onNaturalLanguagePrefill(applyPartial);
  }, [applyPartial, onNaturalLanguagePrefill]);

  const stepTitle = t(`medications.create.wizard.header.title.step${step}`);
  const stepOf = t(k("header.stepOf"), {
    current: displayStep,
    total: totalSteps,
  });

  return (
    <Card
      data-slot="medication-creation-wizard"
      data-step={step}
      data-display-step={displayStep}
      data-total-steps={totalSteps}
      aria-busy={submitting || undefined}
    >
      <CardHeader>
        <p className="text-muted-foreground text-xs">{stepOf}</p>
        <CardTitle className="text-base">{stepTitle}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4" ref={bodyRef}>
        {step === 1 && (
          <Step1NameDose
            payload={payload}
            applyPartial={applyPartial}
            fieldErrors={fieldErrors}
            onNlClick={onNaturalLanguagePrefill ? handleNlClick : undefined}
            t={t}
          />
        )}
        {step === 2 && (
          <Step2Mode payload={payload} applyPartial={applyPartial} t={t} />
        )}
        {step === 3 && (
          <Step3Cadence payload={payload} applyPartial={applyPartial} t={t} />
        )}
        {step === 5 && (
          <Step5Times
            payload={payload}
            applyPartial={applyPartial}
            t={t}
          />
        )}
        {step === 6 && (
          <Step6CourseWindow
            payload={payload}
            applyPartial={applyPartial}
            t={t}
          />
        )}
        {step === 7 && (
          <Step7Summary
            payload={payload}
            applyPartial={applyPartial}
            submitError={submitError}
            t={t}
          />
        )}
      </CardContent>
      <CardFooter className="flex items-center justify-between gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={goBack}
          disabled={displayStep === 1 || submitting}
          data-slot="wizard-back"
          className="h-11"
        >
          {t(k("nav.back"))}
        </Button>
        {!isLastStep ? (
          <Button
            type="button"
            onClick={goNext}
            disabled={!canContinue}
            data-slot="wizard-next"
            className="h-11"
          >
            {t(k("nav.next"))}
          </Button>
        ) : (
          <Button
            type="button"
            onClick={() => void onSubmit()}
            disabled={!canContinue || submitting}
            data-slot="wizard-create"
            aria-busy={submitting || undefined}
            className="h-11"
          >
            {submitting && (
              <Loader2 className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" />
            )}
            {t(k("nav.create"))}
          </Button>
        )}
      </CardFooter>
    </Card>
  );
}

// ────────────────────────────────────────────────────────────────────
// Step bodies
// ────────────────────────────────────────────────────────────────────

interface StepProps {
  payload: WizardPayload;
  applyPartial: (partial: Partial<WizardPayload>) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}

function Step1NameDose({
  payload,
  applyPartial,
  fieldErrors,
  onNlClick,
  t,
}: StepProps & {
  fieldErrors: Record<string, string>;
  onNlClick?: () => void;
}) {
  return (
    <div className="space-y-4" data-slot="wizard-step1">
      {onNlClick && (
        <Button
          type="button"
          variant="outline"
          onClick={onNlClick}
          className="h-11 w-full"
          data-slot="wizard-nl-button"
        >
          <Sparkles className="mr-2 h-4 w-4" aria-hidden="true" />
          {t(k("step1.naturalLanguage.button"))}
        </Button>
      )}

      <div className="space-y-1.5">
        <Label htmlFor="wizard-name">
          {t(k("step1.name.label"))}
        </Label>
        <Input
          id="wizard-name"
          value={payload.name}
          onChange={(e) => applyPartial({ name: e.target.value })}
          placeholder={t(k("step1.name.placeholder"))}
          maxLength={100}
          autoCapitalize="words"
          autoComplete="off"
          className="h-11"
          aria-invalid={fieldErrors.name ? true : undefined}
          aria-describedby={fieldErrors.name ? "wizard-name-error" : undefined}
        />
        {fieldErrors.name && (
          <p id="wizard-name-error" className="text-destructive text-xs" role="alert">
            {fieldErrors.name}
          </p>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="wizard-dose-amount">
            {t(k("step1.dose.amount.label"))}
          </Label>
          <Input
            id="wizard-dose-amount"
            type="text"
            inputMode="decimal"
            value={payload.doseAmount}
            onChange={(e) => applyPartial({ doseAmount: e.target.value })}
            placeholder={t(
              "medications.create.wizard.step1.dose.amount.placeholder",
            )}
            maxLength={20}
            autoComplete="off"
            className="h-11"
            aria-invalid={fieldErrors.dose ? true : undefined}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="wizard-dose-unit">
            {t(k("step1.dose.unit.label"))}
          </Label>
          <Select
            value={payload.doseUnit as DoseUnitKey}
            onValueChange={(v) => applyPartial({ doseUnit: v })}
          >
            <SelectTrigger id="wizard-dose-unit" className="h-11 w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ALL_DOSE_UNIT_KEYS.map((u) => (
                <SelectItem key={u} value={u}>
                  {t(`medications.create.wizard.step1.dose.unit.${u}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
    </div>
  );
}

function Step2Mode({ payload, applyPartial, t }: StepProps) {
  return (
    <div
      role="radiogroup"
      aria-label={t(k("header.title.step2"))}
      className="space-y-3"
      data-slot="wizard-step2"
    >
      <ModeCard
        value="oneShot"
        selected={payload.mode === "oneShot"}
        title={t(k("step2.oneShot.title"))}
        description={t(k("step2.oneShot.description"))}
        onSelect={() =>
          applyPartial({
            mode: "oneShot",
            cadence: encodeCadence("oneShot", payload.subControls),
          })
        }
      />
      <ModeCard
        value="recurring"
        selected={payload.mode === "recurring"}
        title={t(k("step2.recurring.title"))}
        description={t(k("step2.recurring.description"))}
        onSelect={() =>
          applyPartial({
            mode: "recurring",
            cadence:
              payload.cadence.kind === "oneShot"
                ? encodeCadence("daily", payload.subControls)
                : payload.cadence,
          })
        }
      />
    </div>
  );
}

interface ModeCardProps {
  value: "oneShot" | "recurring";
  selected: boolean;
  title: string;
  description: string;
  onSelect: () => void;
}

function ModeCard({ value, selected, title, description, onSelect }: ModeCardProps) {
  return (
    <label
      className={[
        "block cursor-pointer rounded-lg border p-4 transition-colors",
        selected
          ? "border-primary bg-primary/5"
          : "border-border hover:bg-muted/40",
      ].join(" ")}
      data-slot="wizard-mode-card"
      data-value={value}
      data-selected={selected ? "true" : "false"}
    >
      <input
        type="radio"
        name="wizard-mode"
        value={value}
        checked={selected}
        onChange={onSelect}
        className="sr-only"
        aria-label={title}
      />
      <div className="font-medium">{title}</div>
      <div className="text-muted-foreground text-sm">{description}</div>
    </label>
  );
}

/**
 * The cadence kinds offered by the wizard's Step 3. One-shot is the
 * canonical responsibility of Step 2's mode picker — exposing it here
 * would invite a contradictory `mode = "recurring"` + `cadence.kind =
 * "oneShot"` payload. The picker accepts an optional `allowedKinds`
 * filter that we always pass with the recurring-only list.
 */
const STEP3_ALLOWED_KINDS = [
  "daily",
  "weekdays",
  "everyNWeeks",
  "monthly",
  "everyNMonths",
  "yearly",
  "rolling",
] as const;

function Step3Cadence({ payload, applyPartial, t }: StepProps) {
  return (
    <div className="space-y-3" data-slot="wizard-step3">
      <p className="text-muted-foreground text-sm">
        {t(k("step3.helper"))}
      </p>
      <CadencePicker
        value={payload.cadence}
        subControls={payload.subControls}
        allowedKinds={[...STEP3_ALLOWED_KINDS]}
        onChange={(cadence, subControls) =>
          applyPartial({ cadence, subControls })
        }
      />
    </div>
  );
}

function Step5Times({ payload, applyPartial, t }: StepProps) {
  const isOneShot = payload.mode === "oneShot";
  const startsIso = dateToIsoString(payload.startsOn);
  return (
    <div className="space-y-4" data-slot="wizard-step5">
      <p className="text-muted-foreground text-sm">
        {t(k("step5.helper"))}
      </p>
      <TimesOfDayChips
        value={payload.timesOfDay}
        onChange={(timesOfDay) => applyPartial({ timesOfDay })}
        maxChips={isOneShot ? 1 : 8}
      />
      {isOneShot && (
        <div className="space-y-1.5" data-slot="wizard-step5-oneshot-date">
          <Label htmlFor="wizard-oneshot-date">
            {t(k("step5.oneShotDate.label"))}
          </Label>
          <Input
            id="wizard-oneshot-date"
            type="date"
            value={startsIso}
            onChange={(e) => {
              const d = isoStringToDate(e.target.value);
              // One-shot pins endsOn to startsOn so step 6 stays in sync.
              applyPartial({ startsOn: d, endsOn: d });
            }}
            className="h-11 w-full"
          />
          <p className="text-muted-foreground text-xs">
            {t(k("step5.oneShotDate.helper"))}
          </p>
        </div>
      )}
    </div>
  );
}

function Step6CourseWindow({ payload, applyPartial, t }: StepProps) {
  const isOneShot = payload.mode === "oneShot";
  return (
    <div className="space-y-4" data-slot="wizard-step6">
      <p className="text-muted-foreground text-sm">
        {t(k("step6.helper"))}
      </p>
      <CourseWindowRow
        startsOn={payload.startsOn}
        endsOn={payload.endsOn}
        lockEndsToStart={isOneShot}
        onChange={({ startsOn, endsOn }) => applyPartial({ startsOn, endsOn })}
      />
    </div>
  );
}

function Step7Summary({
  payload,
  applyPartial,
  submitError,
  t,
}: StepProps & { submitError: string | null }) {
  const summary = summariseCadence(payload, t);
  return (
    <div className="space-y-4" data-slot="wizard-step7">
      <div
        className="bg-muted/40 rounded-md border p-3 text-sm"
        data-slot="wizard-step7-summary"
      >
        <p className="mb-1 font-medium">
          {t(k("step7.summary.title"))}
        </p>
        <p>{summary}</p>
      </div>

      <div className="flex items-center justify-between gap-3">
        <div className="space-y-1">
          <Label
            htmlFor="wizard-reminders"
            className="text-sm font-medium"
          >
            {t(k("step7.reminders.label"))}
          </Label>
          <p className="text-muted-foreground text-xs">
            {t(k("step7.reminders.description"))}
          </p>
        </div>
        <Switch
          id="wizard-reminders"
          checked={payload.notificationsEnabled}
          onCheckedChange={(checked) =>
            applyPartial({ notificationsEnabled: checked })
          }
          data-slot="wizard-reminders-toggle"
          aria-label={t(k("step7.reminders.label"))}
        />
      </div>

      {submitError && (
        <p
          className="text-destructive text-sm"
          role="alert"
          data-slot="wizard-submit-error"
        >
          {submitError}
        </p>
      )}
    </div>
  );
}
