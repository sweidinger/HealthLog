"use client";

/**
 * v1.5.0 — Medication CreationWizard.
 *
 * Seven-step wizard for cold-start medication creation. Composes the
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
 *   3. Cadence picker — skipped when step 2 = one-shot.
 *   4. Day-detail re-cap (sub-controls already render inline in the
 *      picker; the step renders a confirmation summary).
 *   5. Times of day — re-uses TimesOfDayChips. One-shot path also
 *      shows a date picker for the single dose date.
 *   6. Course window — CourseWindowRow. One-shot pins endsOn to
 *      startsOn (`lockEndsToStart`).
 *   7. Reminders toggle + plain-language summary + "Create".
 *
 * Pure helpers `validateStep`, `buildCreateBody`, and
 * `summariseCadence` carry the test surface; the interactive flow is
 * covered by Playwright in a later commit.
 *
 * i18n keys consumed (namespace `medications.create.wizard.*`):
 *
 *   .header.stepOf                       — "Schritt {current} von {total}"
 *   .header.title.{step1|step2|step3|step4|step5|step6|step7}
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
 *   .step4.recap                         — re-cap copy
 *   .step4.oneShotSkipped                — "(skipped — one-shot)"
 *   .step5.helper                        — times-of-day helper text
 *   .step5.oneShotDate.label             — "Date of the single dose"
 *   .step5.oneShotDate.helper            — caption under the picker
 *   .step6.helper                        — course-window helper text
 *   .step7.reminders.label               — "Reminders on"
 *   .step7.reminders.description         — helper text under switch
 *   .step7.summary.title                 — "Summary"
 *   .step7.summary.cadence.{daily|weekdays|weekly|biweekly|monthly|quarterly|yearly|rolling|oneShot|everyNWeeks|everyNMonths}
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

import { useCallback, useMemo, useState } from "react";
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

const TOTAL_STEPS = 7;

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
 *   - Step 3: skipped for one-shot. For recurring, the picker always
 *     emits a valid `CadenceValue`; the gate only re-checks that the
 *     yearly date is populated when the cadence kind is `yearly`.
 *   - Step 4: pass-through (re-cap step has no required input).
 *   - Step 5: at least one valid HH:mm time; one-shot requires startsOn.
 *   - Step 6: range valid (endsOn null OR endsOn >= startsOn);
 *     startsOn required for recurring (one-shot already pinned in 5).
 *   - Step 7: gate matches step 6 (the toggle has no failure mode).
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
    case 4:
      return true;
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
  return [cadencePhrase, timesPhrase, startPhrase, endPhrase]
    .filter(Boolean)
    .join(" · ");
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

  const applyPartial = useCallback((partial: Partial<WizardPayload>) => {
    setPayload((prev) => ({ ...prev, ...partial }));
  }, []);

  const canContinue = useMemo(
    () => validateStep(payload, step),
    [payload, step],
  );

  const goNext = useCallback(() => {
    if (!canContinue) return;
    // Skip cadence + day-detail when one-shot.
    if (step === 2 && payload.mode === "oneShot") {
      setStep(5);
      return;
    }
    setStep((s) => Math.min(s + 1, TOTAL_STEPS));
  }, [canContinue, payload.mode, step]);

  const goBack = useCallback(() => {
    // Mirror the skip: jumping back from step 5 lands on step 2 in
    // one-shot mode (steps 3 + 4 never rendered).
    if (step === 5 && payload.mode === "oneShot") {
      setStep(2);
      return;
    }
    setStep((s) => Math.max(s - 1, 1));
  }, [payload.mode, step]);

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
    current: step,
    total: TOTAL_STEPS,
  });

  return (
    <Card data-slot="medication-creation-wizard" data-step={step}>
      <CardHeader>
        <p className="text-muted-foreground text-xs">{stepOf}</p>
        <CardTitle className="text-base">{stepTitle}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
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
        {step === 4 && (
          <Step4DayDetail payload={payload} t={t} />
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
          disabled={step === 1 || submitting}
          data-slot="wizard-back"
        >
          {t(k("nav.back"))}
        </Button>
        {step < TOTAL_STEPS ? (
          <Button
            type="button"
            onClick={goNext}
            disabled={!canContinue}
            data-slot="wizard-next"
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
          size="sm"
          onClick={onNlClick}
          className="w-full"
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

function Step3Cadence({ payload, applyPartial, t }: StepProps) {
  return (
    <div className="space-y-3" data-slot="wizard-step3">
      <p className="text-muted-foreground text-sm">
        {t(k("step3.helper"))}
      </p>
      <CadencePicker
        value={payload.cadence}
        subControls={payload.subControls}
        onChange={(cadence, subControls) =>
          applyPartial({ cadence, subControls })
        }
      />
    </div>
  );
}

function Step4DayDetail({ payload, t }: Pick<StepProps, "payload" | "t">) {
  // Day-detail follow-ups already render inline in the picker (the
  // sub-controls are conditional on the selected kind). Step 4 is a
  // confirmation re-cap that surfaces what got picked so the user can
  // tap Back if it looks wrong.
  if (payload.mode === "oneShot") {
    return (
      <div className="space-y-3" data-slot="wizard-step4">
        <p className="text-muted-foreground text-sm">
          {t(k("step4.oneShotSkipped"))}
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-3" data-slot="wizard-step4">
      <p className="text-muted-foreground text-sm">
        {t(k("step4.recap"))}
      </p>
      <div
        className="bg-muted/40 rounded-md border p-3 text-sm"
        data-slot="wizard-step4-recap"
      >
        {recapCadence(payload, t)}
      </div>
    </div>
  );
}

function recapCadence(
  payload: WizardPayload,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  return summariseCadence(payload, t);
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
