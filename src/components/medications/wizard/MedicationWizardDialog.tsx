"use client";

/**
 * v1.5.4 — Modal medication-creation wizard.
 *
 * Replaces the v1.5.3 `<CreationWizard>` card with a popup that lives
 * inside `<ResponsiveSheet>` (centred dialog on `md+`, bottom sheet on
 * narrow viewports). The dialog renders its own header inside the
 * body — counter + icon plate + title + subline — followed by the
 * step's single focused field, and a sticky footer with Back / Next
 * (or Save / Änderungen speichern).
 *
 * Path tables — visible counter follows the route the user walks:
 *
 *   ONE_SHOT_PATH  = [1, 2, 3, 4, 8]
 *   DAILY_PATH     = [1, 2, 3, 4, 5, 7, 8]
 *   RECURRING_PATH = [1, 2, 3, 4, 5, 6, 7, 8]
 *
 * The same component drives create AND edit. On edit the body
 * hydrates from `MedicationPayload`, the header title flips to
 * "{name} bearbeiten", and the final CTA flips to
 * "Änderungen speichern".
 *
 * i18n namespace: `medications.wizard.*`. Cadence row labels +
 * descriptions live under `medications.wizard.cadence.*` so the
 * locale-integrity guard surfaces every missing key the moment the
 * dialog reaches a new locale.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Bell,
  CalendarRange,
  Clock,
  FlaskConical,
  Loader2,
  Pill,
  Repeat,
  Sparkles,
  Tag,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { useTranslations } from "@/lib/i18n/context";
import { invalidateKeys, medicationDependentKeys } from "@/lib/query-keys";

import { NaturalLanguageExtractor } from "@/components/medications/scheduling/NaturalLanguageExtractor";

import {
  buildCreateBody,
  emptyWizardPayload,
  hydrateWizardPayload,
  type MedicationPayload,
  progressIndices,
  type WizardPayload,
} from "./wizard-payload";
import { Step1Name } from "./steps/Step1Name";
import { Step2Class } from "./steps/Step2Class";
import { Step3Dose } from "./steps/Step3Dose";
import { Step4Window } from "./steps/Step4Window";
import { Step5Cadence } from "./steps/Step5Cadence";
import { Step6SubCadence } from "./steps/Step6SubCadence";
import { Step7Times } from "./steps/Step7Times";
import { Step8Summary } from "./steps/Step8Summary";
import { validateStep } from "./wizard-payload";
import { extractorToWizardPartial } from "./nl-bridge";

export interface MedicationWizardDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "create" | "edit";
  /** Required when `mode === "edit"`. */
  initial?: MedicationPayload;
  /** Fires with the medication id on a successful create / save. */
  onSuccess?: (id: string) => void;
}

const STEP_ICONS = {
  1: Pill,
  2: Tag,
  3: FlaskConical,
  4: CalendarRange,
  5: Repeat,
  6: Repeat,
  7: Clock,
  8: Bell,
} as const;

type StepNumber = keyof typeof STEP_ICONS;

export function MedicationWizardDialog(props: MedicationWizardDialogProps) {
  // Key the inner state container on (open + mode + medication id) so
  // every open gets a fresh state tree. React unmounts the inner
  // component when the key changes, which sidesteps the "setState in
  // useEffect" anti-pattern that resetting on open via an effect
  // would otherwise trigger. The outer shell stays mounted so the
  // dialog's close animation runs cleanly.
  const stateKey = `${props.open ? "open" : "closed"}:${props.mode}:${props.initial?.id ?? "new"}`;
  return <WizardDialogShell key={stateKey} {...props} />;
}

function WizardDialogShell({
  open,
  onOpenChange,
  mode,
  initial,
  onSuccess,
}: MedicationWizardDialogProps) {
  const { t, locale } = useTranslations();
  const router = useRouter();
  const queryClient = useQueryClient();

  const [step, setStep] = useState<StepNumber>(1);
  const [payload, setPayload] = useState<WizardPayload>(() =>
    mode === "edit" && initial
      ? hydrateWizardPayload(initial)
      : emptyWizardPayload(),
  );
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [nlOpen, setNlOpen] = useState(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const isFirstRenderRef = useRef(true);

  const applyPartial = useCallback((partial: Partial<WizardPayload>) => {
    setPayload((prev) => ({ ...prev, ...partial }));
  }, []);

  const stepList = useMemo(
    () => progressIndices(payload.mode, payload.cadence.kind),
    [payload.mode, payload.cadence.kind],
  );
  const totalSteps = stepList.length;
  // The displayed counter prefers the slot the current step lives
  // in. When the step pointer drifts off-path (e.g. picking
  // "Einmalig" on Step 5 collapses the path to `[1, 2, 3, 4, 8]`),
  // the counter pins on the slot whose step number is `<= step` so
  // the body keeps rendering the user's actual current step and
  // the visible counter doesn't jump ahead of them.
  const currentIndex = stepList.indexOf(step);
  const fallbackIndex = (() => {
    if (currentIndex >= 0) return currentIndex;
    let last = 0;
    for (let i = 0; i < stepList.length; i++) {
      if (stepList[i] <= step) last = i;
    }
    return last;
  })();
  const displayStep = fallbackIndex + 1;
  const isLastStep = displayStep === totalSteps;
  const isFirstStep = displayStep === 1;
  const progress = (displayStep / totalSteps) * 100;

  const canContinue = useMemo(
    () => validateStep(payload, step),
    [payload, step],
  );

  const goNext = useCallback(() => {
    if (!canContinue) return;
    const list = progressIndices(payload.mode, payload.cadence.kind);
    // Step the user forward to the next path step that's strictly
    // greater than the current step. If the current step is on the
    // path, that's just the slot after it; if it's off-path (Step 5
    // after picking "Einmalig"), we still land on the first higher
    // step in the path, which is the one-shot summary at step 8.
    const forward = list.find((n) => n > step);
    if (forward !== undefined) {
      setStep(forward as StepNumber);
    }
  }, [canContinue, payload.mode, payload.cadence.kind, step]);

  const goBack = useCallback(() => {
    const list = progressIndices(payload.mode, payload.cadence.kind);
    const backward = [...list].reverse().find((n) => n < step);
    if (backward !== undefined) {
      setStep(backward as StepNumber);
    }
  }, [payload.mode, payload.cadence.kind, step]);

  // Focus the first interactive control on each step change. The
  // initial render skips so opening the dialog does not steal focus
  // from the trigger button.
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
    target?.focus({ preventScroll: true });
  }, [step]);

  const onSubmit = useCallback(async () => {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const body = buildCreateBody(payload);
      const url =
        mode === "edit" && initial
          ? `/api/medications/${initial.id}`
          : "/api/medications";
      const method = mode === "edit" ? "PUT" : "POST";

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as {
        data?: { id: string };
        error?: string;
      };
      const successStatus = mode === "edit" ? 200 : 201;
      if (res.status === successStatus && json.data?.id) {
        await invalidateKeys(queryClient, medicationDependentKeys);
        toast.success(t("common.saved"));
        onSuccess?.(json.data.id);
        onOpenChange(false);
        if (mode === "create") {
          router.push(`/medications/${json.data.id}`);
        }
        return;
      }
      setSubmitError(json.error ?? t("medications.wizard.errors.submitFailed"));
    } catch {
      setSubmitError(t("medications.wizard.errors.submitFailed"));
    } finally {
      setSubmitting(false);
    }
  }, [
    initial,
    mode,
    onOpenChange,
    onSuccess,
    payload,
    queryClient,
    router,
    t,
  ]);

  const Icon = STEP_ICONS[step];

  const headerTitle =
    mode === "edit" && initial
      ? t("medications.wizard.header.editTitle", { name: initial.name })
      : t("medications.wizard.header.createTitle");

  const stepTitle = t(`medications.wizard.steps.step${step}.title`);
  const stepSubline = t(`medications.wizard.steps.step${step}.subline`);
  const stepOf = t("medications.wizard.header.stepOf", {
    current: displayStep,
    total: totalSteps,
  });

  const primaryCtaLabel = isLastStep
    ? mode === "edit"
      ? t("medications.wizard.nav.saveEdit")
      : t("medications.wizard.nav.save")
    : t("medications.wizard.nav.next");

  return (
    <>
      <ResponsiveSheet
        open={open}
        onOpenChange={onOpenChange}
        title={headerTitle}
        hideHeader
        showCloseButton
        className="sm:max-w-md"
        bodyClassName="gap-0 p-0"
        footer={
          <div className="flex w-full items-center justify-between gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={goBack}
              disabled={isFirstStep || submitting}
              data-slot="wizard-back"
              className="h-11"
            >
              {t("medications.wizard.nav.back")}
            </Button>
            {!isLastStep ? (
              <Button
                type="button"
                onClick={goNext}
                disabled={!canContinue}
                data-slot="wizard-next"
                className="h-11"
              >
                {primaryCtaLabel}
              </Button>
            ) : (
              <Button
                type="button"
                onClick={() => void onSubmit()}
                disabled={!canContinue || submitting}
                data-slot="wizard-save"
                aria-busy={submitting || undefined}
                className="h-11"
              >
                {submitting && (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" />
                )}
                {primaryCtaLabel}
              </Button>
            )}
          </div>
        }
      >
        <div
          data-slot="medication-wizard-dialog"
          data-step={step}
          data-display-step={displayStep}
          data-total-steps={totalSteps}
          data-mode={mode}
          aria-busy={submitting || undefined}
          className="flex flex-col"
        >
          {/* Progress + counter */}
          <div className="border-border/70 space-y-1.5 border-b p-4">
            <Progress
              value={progress}
              className="h-1"
              aria-label={stepOf}
            />
            <div className="flex items-center justify-between gap-2">
              <p className="text-muted-foreground text-xs">{stepOf}</p>
              {step === 1 && mode === "create" && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 gap-1 px-2 text-xs"
                  onClick={() => setNlOpen(true)}
                  data-slot="wizard-nl-button"
                  aria-label={t("medications.wizard.nl.button")}
                >
                  <Sparkles
                    className="h-3.5 w-3.5"
                    aria-hidden="true"
                  />
                  {t("medications.wizard.nl.button")}
                </Button>
              )}
            </div>
          </div>

          {/* Step body */}
          <div
            ref={bodyRef}
            className="space-y-4 p-4"
            data-slot="wizard-step-body"
            key={step}
          >
            <div className="flex items-start gap-3">
              <div
                className="bg-card border-border/60 grid h-10 w-10 shrink-0 place-items-center rounded-xl border"
                data-slot="wizard-step-icon"
                aria-hidden="true"
              >
                <Icon className="text-primary h-6 w-6" />
              </div>
              <div className="min-w-0 space-y-1">
                <h2 className="text-foreground text-base font-medium leading-tight">
                  {stepTitle}
                </h2>
                <p className="text-muted-foreground text-sm">
                  {stepSubline}
                </p>
              </div>
            </div>

            <div data-slot="wizard-step-field">
              {step === 1 && (
                <Step1Name payload={payload} applyPartial={applyPartial} />
              )}
              {step === 2 && (
                <Step2Class payload={payload} applyPartial={applyPartial} />
              )}
              {step === 3 && (
                <Step3Dose payload={payload} applyPartial={applyPartial} />
              )}
              {step === 4 && (
                <Step4Window payload={payload} applyPartial={applyPartial} />
              )}
              {step === 5 && (
                <Step5Cadence
                  payload={payload}
                  applyPartial={applyPartial}
                />
              )}
              {step === 6 && (
                <Step6SubCadence
                  payload={payload}
                  applyPartial={applyPartial}
                />
              )}
              {step === 7 && (
                <Step7Times
                  payload={payload}
                  applyPartial={applyPartial}
                />
              )}
              {step === 8 && (
                <Step8Summary
                  payload={payload}
                  applyPartial={applyPartial}
                  mode={mode}
                  initial={initial}
                  submitError={submitError}
                />
              )}
            </div>
          </div>
        </div>
      </ResponsiveSheet>
      {/* Natural-language extractor — same dialog the v1.5.3 page mounted.
          Only available on the create path; edit flows already know
          what the medication looks like. */}
      {mode === "create" && (
        <NaturalLanguageExtractor
          open={nlOpen}
          onClose={() => setNlOpen(false)}
          onPrefill={(partial) => {
            applyPartial(extractorToWizardPartial(partial));
          }}
          locale={locale}
        />
      )}
    </>
  );
}
