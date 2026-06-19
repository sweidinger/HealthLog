"use client";

import { useState } from "react";
import { Activity, Pill, Waves } from "lucide-react";

import { MeasurementForm } from "@/components/measurements/measurement-form";
import { MoodForm } from "@/components/mood/mood-form";
import { MedicationIntakeQuickAdd } from "@/components/dashboard/medication-intake-quick-add";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { useTranslations } from "@/lib/i18n/context";

/**
 * The center "Log" capture action (iOS parity — the bottom bar's
 * middle slot is a capture CTA, not a destination). It opens a small
 * picker that routes to one of three existing quick-entry surfaces:
 *
 *   - Measurement → `<MeasurementForm>` (the `/measurements` add form)
 *   - Medication  → `<MedicationIntakeQuickAdd>` (the dashboard intake
 *                   quick-add)
 *   - Mood        → `<MoodForm>` (the `/mood` add form, 5-face flow)
 *
 * All three forms share the `{ onSuccess, onCancel, footerSlot }`
 * contract and are designed to mount inside `<ResponsiveSheet>`, so the
 * picker reuses them verbatim rather than rebuilding any capture UI.
 *
 * Nothing here orphans a route: the same surfaces remain reachable
 * from their own pages (`/measurements`, `/mood`, dashboard) and from
 * the More hub. The picker is an additional fast path, not a removal.
 */

type CaptureKind = "measurement" | "medication" | "mood";

interface CapturePickerProps {
  /** Whether the picker chooser sheet is open. */
  open: boolean;
  /** Open-state setter for the chooser sheet. */
  onOpenChange: (open: boolean) => void;
}

export function CapturePicker({ open, onOpenChange }: CapturePickerProps) {
  const { t } = useTranslations();
  const [kind, setKind] = useState<CaptureKind | null>(null);
  const [footerEl, setFooterEl] = useState<HTMLDivElement | null>(null);

  function chooseKind(next: CaptureKind) {
    // Close the chooser first, then open the form sheet so only one
    // bottom-sheet is mounted at a time (no stacked backdrops).
    onOpenChange(false);
    setKind(next);
  }

  function closeForm() {
    setKind(null);
  }

  const options: ReadonlyArray<{
    kind: CaptureKind;
    label: string;
    description: string;
    icon: typeof Activity;
  }> = [
    {
      kind: "measurement",
      label: t("nav.capture.measurement"),
      description: t("nav.capture.measurementDescription"),
      icon: Activity,
    },
    {
      kind: "medication",
      label: t("nav.capture.medication"),
      description: t("nav.capture.medicationDescription"),
      icon: Pill,
    },
    {
      kind: "mood",
      label: t("nav.capture.mood"),
      description: t("nav.capture.moodDescription"),
      icon: Waves,
    },
  ];

  const formTitleByKind: Record<CaptureKind, string> = {
    measurement: t("measurements.addMeasurement"),
    medication: t("nav.capture.medication"),
    mood: t("mood.addEntry"),
  };
  // `kind === null` keeps the form sheet closed (the title is unread then);
  // the mood label is the harmless default, matching the prior ternary's
  // else branch.
  const formTitle = kind ? formTitleByKind[kind] : t("mood.addEntry");

  return (
    <>
      {/* The capture-kind chooser. */}
      <ResponsiveSheet
        open={open}
        onOpenChange={onOpenChange}
        title={t("nav.capture.title")}
        description={t("nav.capture.description")}
      >
        <div
          className="grid grid-cols-1 gap-2"
          data-testid="capture-picker-options"
        >
          {options.map((opt) => (
            <button
              key={opt.kind}
              type="button"
              data-testid={`capture-picker-${opt.kind}`}
              onClick={() => chooseKind(opt.kind)}
              className="border-border hover:bg-accent/40 focus-visible:ring-ring/50 flex min-h-14 items-center gap-3 rounded-lg border px-4 py-3 text-left transition-colors focus-visible:ring-2 focus-visible:outline-none"
            >
              <span className="bg-primary/10 text-primary flex h-9 w-9 shrink-0 items-center justify-center rounded-full">
                <opt.icon className="h-5 w-5" aria-hidden="true" />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-medium">{opt.label}</span>
                <span className="text-muted-foreground block text-xs">
                  {opt.description}
                </span>
              </span>
            </button>
          ))}
        </div>
      </ResponsiveSheet>

      {/* The chosen capture surface, reusing the existing form. */}
      <ResponsiveSheet
        open={kind !== null}
        onOpenChange={(next) => {
          if (!next) closeForm();
        }}
        title={formTitle}
        footer={<div ref={setFooterEl} className="flex w-full" />}
      >
        {kind === "measurement" && (
          <MeasurementForm
            onSuccess={closeForm}
            onCancel={closeForm}
            footerSlot={footerEl}
          />
        )}
        {kind === "medication" && (
          <MedicationIntakeQuickAdd
            onSuccess={closeForm}
            onCancel={closeForm}
            footerSlot={footerEl}
          />
        )}
        {kind === "mood" && (
          <MoodForm
            onSuccess={closeForm}
            onCancel={closeForm}
            footerSlot={footerEl}
          />
        )}
      </ResponsiveSheet>
    </>
  );
}
