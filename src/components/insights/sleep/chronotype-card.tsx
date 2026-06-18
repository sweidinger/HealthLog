"use client";

import { useState } from "react";
import { Clock, ChevronDown, ChevronUp } from "lucide-react";

import { useTranslations } from "@/lib/i18n/context";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { LearningGate } from "@/components/ui/learning-gate";
import type { ChronotypeDto } from "./use-sleep-rhythm";

/** Minutes-of-day → "HH:MM" wall-clock label (24 h, zero-padded). */
function clockLabel(minutesOfDay: number): string {
  const wrapped = ((Math.round(minutesOfDay) % 1440) + 1440) % 1440;
  const h = Math.floor(wrapped / 60);
  const m = wrapped - h * 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Whole hours + minutes from a minute total, for the social-jetlag readout. */
function hoursMinutes(totalMinutes: number): { hours: number; minutes: number } {
  const t = Math.round(totalMinutes);
  return { hours: Math.floor(t / 60), minutes: t - Math.floor(t / 60) * 60 };
}

/**
 * v1.17.0 — chronotype card (MCTQ MSF / MSFsc band + social jetlag).
 *
 * Progressive disclosure: the band + mid-sleep clock time show by default; the
 * social-jetlag detail + the sleep-debt-corrected MSFsc sit behind an
 * "advanced" toggle. While `learning` it shows "still learning your rhythm —
 * N of M nights" and asserts NO type. Warm, grounded copy; mobile-first.
 */
export function ChronotypeCard({ chronotype }: { chronotype: ChronotypeDto }) {
  const { t } = useTranslations();
  const [showAdvanced, setShowAdvanced] = useState(false);

  if (chronotype.state === "learning" || chronotype.band == null) {
    const need =
      chronotype.freeNightsCounted + chronotype.freeNightsUntilReady;
    return (
      <Card>
        <CardHeader className="pb-0">
          <div className="flex items-center gap-2">
            <Clock className="text-info h-4 w-4" />
            <CardTitle className="text-base font-semibold">
              {t("insights.sleep.chronotype.title")}
            </CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <LearningGate
            message={t("insights.sleep.chronotype.learning", {
              counted: chronotype.freeNightsCounted,
              total: need,
            })}
          />
        </CardContent>
      </Card>
    );
  }

  const bandLabel = t(`insights.sleep.chronotype.band.${chronotype.band}`);
  const msfClock =
    chronotype.msfMinutes != null ? clockLabel(chronotype.msfMinutes) : null;

  return (
    <Card>
      <CardHeader className="pb-0">
        {/* The resolved chronotype rides the top-right corner as a labelled
            readout — a small "Chronotyp" label over the band value — rather
            than a badge buried in the body. The title stays left; the value
            is the thing the eye should land on first. */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <Clock className="text-info h-4 w-4" />
            <CardTitle className="text-base font-semibold">
              {t("insights.sleep.chronotype.title")}
            </CardTitle>
          </div>
          <div
            className="flex flex-col items-end text-right"
            data-slot="chronotype-corner"
          >
            <span className="text-muted-foreground text-[0.625rem] font-medium tracking-wide uppercase">
              {t("insights.sleep.chronotype.cornerLabel")}
            </span>
            <span className="text-foreground text-sm font-semibold">
              {bandLabel}
            </span>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {msfClock && (
          <p className="text-muted-foreground text-xs">
            {t("insights.sleep.chronotype.midSleepCaption", {
              clock: msfClock,
            })}
          </p>
        )}

        <button
          type="button"
          onClick={() => setShowAdvanced((v) => !v)}
          aria-expanded={showAdvanced}
          aria-controls="chronotype-advanced"
          className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs font-medium transition-colors"
        >
          {showAdvanced ? (
            <ChevronUp className="h-3.5 w-3.5" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5" />
          )}
          {t("insights.sleep.chronotype.advancedToggle")}
        </button>

        {showAdvanced && (
          <div id="chronotype-advanced" className="space-y-2 border-t pt-3">
            {chronotype.socialJetlagMinutes != null &&
              (() => {
                const { hours, minutes } = hoursMinutes(
                  chronotype.socialJetlagMinutes,
                );
                return (
                  <div className="space-y-0.5">
                    <p className="text-sm font-medium">
                      {t("insights.sleep.chronotype.socialJetlagValue", {
                        hours,
                        minutes,
                      })}
                    </p>
                    <p className="text-muted-foreground text-xs">
                      {t("insights.sleep.chronotype.socialJetlagCaption")}
                    </p>
                  </div>
                );
              })()}
            {chronotype.msfScMinutes != null && (
              <div className="space-y-0.5">
                <p className="text-sm font-medium tabular-nums">
                  {t("insights.sleep.chronotype.msfScValue", {
                    clock: clockLabel(chronotype.msfScMinutes),
                  })}
                </p>
                <p className="text-muted-foreground text-xs">
                  {t("insights.sleep.chronotype.msfScCaption")}
                </p>
              </div>
            )}
            <p className="text-muted-foreground text-xs">
              {t("insights.sleep.chronotype.dayTypeNote")}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
