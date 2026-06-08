"use client";

import { Moon, Sun, Sunrise, Sunset } from "lucide-react";

import { TimesOfDayChips } from "@/components/medications/scheduling/TimesOfDayChips";
import { DoseWindowEditor } from "@/components/medications/scheduling/DoseWindowEditor";
import type { DoseWindowScale } from "@/components/medications/scheduling/dose-window";
import { useTranslations } from "@/lib/i18n/context";

import type { StepProps } from "./Step1Name";

/**
 * Step 7 — Einnahmezeit(en). Reuses the v1.5 `TimesOfDayChips`
 * primitive. The preset row of sunrise / sun / sunset / moon icons
 * toggles 08:00 / 12:00 / 18:00 / 22:00 — same semantics as the
 * chips' own preset row, surfaced here as a visual continuation of
 * the wizard's icon language.
 */
const PRESETS = [
  { time: "08:00", icon: Sunrise, key: "morning" },
  { time: "12:00", icon: Sun, key: "noon" },
  { time: "18:00", icon: Sunset, key: "evening" },
  { time: "22:00", icon: Moon, key: "night" },
] as const;

/**
 * Window scale for the late-tail hint — a weekly / monthly RRULE or a
 * ≥2-day rolling cadence is day-scale (the 4-day rule); everything else
 * is intraday (the ±1h / +3h minute bands).
 */
function scaleForCadence(payload: StepProps["payload"]): DoseWindowScale {
  const rolling = payload.cadence.rollingIntervalDays;
  if (typeof rolling === "number" && rolling >= 2) return "dayScale";
  if (/FREQ=(WEEKLY|MONTHLY|YEARLY)/.test(payload.cadence.rrule ?? "")) {
    return "dayScale";
  }
  return "intraday";
}

export function Step7Times({ payload, applyPartial }: StepProps) {
  const { t } = useTranslations();
  function togglePreset(time: string) {
    const has = payload.timesOfDay.includes(time);
    if (has) {
      applyPartial({
        timesOfDay: payload.timesOfDay.filter((x) => x !== time),
      });
    } else {
      applyPartial({
        timesOfDay: [...payload.timesOfDay, time].sort((a, b) =>
          a.localeCompare(b),
        ),
      });
    }
  }
  return (
    <div className="space-y-3" data-slot="wizard-step7">
      <div
        role="group"
        aria-label={t("medications.wizard.steps.step7.presetsLabel")}
        className="flex flex-wrap gap-1.5"
        data-slot="wizard-preset-row"
      >
        {PRESETS.map(({ time, icon: Icon, key }) => {
          const isOn = payload.timesOfDay.includes(time);
          const label = t(
            `medications.wizard.steps.step7.presets.${key}`,
          );
          return (
            <button
              key={time}
              type="button"
              aria-pressed={isOn}
              aria-label={`${label} ${time}`}
              data-slot="wizard-preset-chip"
              data-preset={key}
              data-active={isOn ? "true" : "false"}
              onClick={() => togglePreset(time)}
              className={[
                "focus-visible:ring-ring inline-flex h-11 items-center gap-1.5 rounded-md border px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2",
                isOn
                  ? "bg-primary text-primary-foreground border-primary"
                  : "border-border bg-background text-foreground hover:bg-muted",
              ].join(" ")}
            >
              <Icon className="h-3.5 w-3.5" aria-hidden="true" />
              <span>{time}</span>
            </button>
          );
        })}
      </div>
      <TimesOfDayChips
        value={payload.timesOfDay}
        onChange={(timesOfDay) => applyPartial({ timesOfDay })}
        maxChips={8}
        // The icon-based preset row above already offers the four
        // suggested times; suppress the chips' own labelled preset row so
        // each suggestion isn't shown twice.
        showPresets={false}
      />

      {/* v1.15.18 — the SAME per-dose window editor the Zeitplan tab uses,
          so a new med sets windows with identical semantics to an edit. */}
      <DoseWindowEditor
        timesOfDay={payload.timesOfDay}
        value={payload.doseWindows}
        onChange={(doseWindows) => applyPartial({ doseWindows })}
        scale={scaleForCadence(payload)}
      />
    </div>
  );
}
