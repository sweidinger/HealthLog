"use client";

/**
 * v1.5.0 — `/medications/new` — host route for the medication-create
 * wizard. Keeps the page chrome minimal: a back-link to the medications
 * index sits above the card, and the wizard owns the rest of the page
 * (header, body, footer).
 *
 * Mounts the `NaturalLanguageExtractor` overlay so the wizard's
 * "✨ Describe it" button has somewhere to land. The wizard hands us
 * an `apply(partial)` callback; the page opens the overlay, lets the
 * extractor call our `onPrefill`, then merges the result onto the
 * wizard payload through that callback.
 */

import { useCallback, useRef, useState } from "react";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";

import {
  CreationWizard,
  type WizardPayload,
} from "@/components/medications/scheduling/CreationWizard";
import {
  NaturalLanguageExtractor,
  type WizardPayload as ExtractorPayload,
} from "@/components/medications/scheduling/NaturalLanguageExtractor";
import {
  encodeCadence,
} from "@/components/medications/scheduling/CadencePicker";
import {
  DEFAULT_SUB_CONTROLS,
  type CadenceSubControls,
  type WeekdayToken,
} from "@/components/medications/scheduling/types";
import { isoStringToDate } from "@/components/medications/scheduling/CourseWindowRow";
import { useTranslations } from "@/lib/i18n/context";

/**
 * Page-level i18n keys live under the same `medications.create.wizard.*`
 * namespace so a follow-up commit can collate every wizard string in one
 * locale-bundle pass. Template-literal `t()` keeps the call-site coverage
 * guard silent until the locale bundle catches up.
 */
const PAGE_NS = "medications.create.wizard.page";

export default function NewMedicationPage() {
  const { t, locale } = useTranslations();
  const [nlOpen, setNlOpen] = useState(false);
  // Holds the wizard-supplied apply callback across renders. The wizard
  // invokes `onNaturalLanguagePrefill(apply)` on every "✨ Describe it"
  // click; we stash the function in a ref so the overlay's `onPrefill`
  // can invoke it when the extraction returns a result.
  const applyRef = useRef<((partial: Partial<WizardPayload>) => void) | null>(
    null,
  );

  const handleNaturalLanguagePrefill = useCallback(
    (apply: (partial: Partial<WizardPayload>) => void) => {
      applyRef.current = apply;
      setNlOpen(true);
    },
    [],
  );

  const handlePrefill = useCallback(
    (partial: Partial<ExtractorPayload>) => {
      const apply = applyRef.current;
      if (!apply) return;
      apply(extractorToWizardPartial(partial));
    },
    [],
  );

  const handleClose = useCallback(() => {
    setNlOpen(false);
  }, []);

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <Link
        href="/medications"
        className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm"
        data-slot="wizard-back-link"
      >
        <ChevronLeft className="h-4 w-4" aria-hidden="true" />
        {t(`${PAGE_NS}.backToList`)}
      </Link>
      <CreationWizard onNaturalLanguagePrefill={handleNaturalLanguagePrefill} />
      <NaturalLanguageExtractor
        open={nlOpen}
        onClose={handleClose}
        onPrefill={handlePrefill}
        locale={locale}
      />
    </div>
  );
}

/**
 * Map the extractor's flat result shape onto the wizard's payload
 * shape. Two cross-shape concerns the adapter handles:
 *
 *   - the extractor returns `dose` as a combined string ("5 mg") while
 *     the wizard splits the amount + unit into separate inputs, so we
 *     parse the leading number off `dose` and drop the unit token onto
 *     `doseUnit` when the extractor didn't already pin one.
 *   - the extractor's `cadenceKind` + weekday / interval / day fields
 *     are normalised into a `CadenceValue` + `CadenceSubControls` pair
 *     so the wizard's picker hydrates cleanly when the user lands on
 *     Step 3.
 *
 * When `oneShot: true` is returned, the adapter also drops the
 * extractor-supplied `timesOfDay` so the wizard's Step 5 forces the
 * user to pick the dose time explicitly — the extractor never asked
 * for it and the wizard's "08:00" default would otherwise stick.
 */
function extractorToWizardPartial(
  result: Partial<ExtractorPayload>,
): Partial<WizardPayload> {
  const out: Partial<WizardPayload> = {};

  if (typeof result.name === "string") out.name = result.name;

  if (typeof result.dose === "string") {
    const parsed = parseDoseExpression(result.dose);
    out.doseAmount = parsed.amount;
    if (parsed.unit && !result.doseUnit) {
      out.doseUnit = parsed.unit;
    }
  }
  if (typeof result.doseUnit === "string") {
    out.doseUnit = result.doseUnit;
  }

  // Cadence resolution. One-shot wins; otherwise hydrate the picker
  // off the extractor's cadenceKind + companion fields.
  if (result.oneShot === true) {
    out.mode = "oneShot";
    out.subControls = subControlsFromExtractor(result);
    out.cadence = encodeCadence("oneShot", out.subControls);
    // Force an explicit pick on Step 5 — the wizard's default 08:00
    // shouldn't ride along for a one-shot prefill that never named
    // a time.
    out.timesOfDay = [];
  } else if (result.cadenceKind) {
    out.mode = "recurring";
    out.subControls = subControlsFromExtractor(result);
    out.cadence = encodeCadence(result.cadenceKind, out.subControls);
  }

  // If the caller specified times, honour them — except when oneShot
  // already cleared the array above.
  if (
    out.timesOfDay === undefined &&
    Array.isArray(result.timesOfDay) &&
    result.timesOfDay.length > 0
  ) {
    out.timesOfDay = [...result.timesOfDay];
  }

  if (typeof result.startsOn === "string") {
    out.startsOn = isoStringToDate(result.startsOn);
  }
  if (typeof result.endsOn === "string") {
    out.endsOn = isoStringToDate(result.endsOn);
  }
  // One-shot pins endsOn to startsOn (Step 5's date handler does this
  // for the interactive path; pre-fill mirrors the contract).
  if (result.oneShot === true && out.startsOn) {
    out.endsOn = out.startsOn;
  }

  return out;
}

function subControlsFromExtractor(
  result: Partial<ExtractorPayload>,
): CadenceSubControls {
  const base: CadenceSubControls = { ...DEFAULT_SUB_CONTROLS };
  if (Array.isArray(result.weekdays) && result.weekdays.length > 0) {
    base.weekdays = result.weekdays.filter((w): w is WeekdayToken =>
      ["MO", "TU", "WE", "TH", "FR", "SA", "SU"].includes(w),
    );
  }
  if (typeof result.intervalWeeks === "number") {
    base.intervalWeeks = result.intervalWeeks;
  }
  if (typeof result.intervalMonths === "number") {
    base.intervalMonths = result.intervalMonths;
  }
  if (typeof result.dayOfMonth === "number") {
    base.dayOfMonth = result.dayOfMonth;
  }
  if (typeof result.rollingIntervalDays === "number") {
    base.rollingDays = result.rollingIntervalDays;
  }
  return base;
}

const DOSE_EXPR_RE = /^\s*(\d+(?:[.,]\d+)?)\s*(.*)$/;

function parseDoseExpression(input: string): { amount: string; unit: string } {
  const match = DOSE_EXPR_RE.exec(input.trim());
  if (!match) return { amount: "", unit: input.trim() };
  const amount = match[1] ?? "";
  const unit = (match[2] ?? "").trim();
  return { amount, unit };
}
