"use client";

/**
 * Dashboard hero — the daily-verdict band between the page header and
 * the tile strip.
 *
 * Purely presentational: every input rides in on the already-resolved
 * `DashboardSnapshot`, the verdict is re-derived on render with a fresh
 * `now` (so a cached snapshot ages honestly), and the only callback is
 * the quick-entry opener the page owns. Three blocks:
 *
 *   - left column: greeting line (absorbed from the old header
 *     paragraph — the snapshot's server-computed `greetingHour` keeps
 *     the daypart free of any client `Intl` work), the verdict sentence
 *     with its single CTA button, and the dose row;
 *   - right column: the shared `<ScoreRing>` at `sm` geometry. A null
 *     score renders the ring's provisional state at the identical
 *     120 px footprint, so the column never collapses.
 *
 * Defensive contract (cached snapshot): `medsToday.nextDueAt` in the
 * past with `nextDueOverdue: false` means the slot's anchor passed
 * after the snapshot was built. The verdict resolver already falls
 * through (rung 1 keys on the flag, rung 3 requires a future anchor),
 * and the dose row below only prints "next at" for a FUTURE anchor on
 * the user's local today — the stale state renders as the plain day
 * summary, never as overdue.
 *
 * Rung 8 (`briefing`) renders the model-authored headline VERBATIM as a
 * plain React text child — no i18n key, no HTML, no markdown — per the
 * repo-wide no-markdown-renderer rule.
 *
 * The page h1 stays in `<DashboardHeader>`; this band is supporting
 * content, so it renders non-heading text only (matching the Insights
 * hero strip, which also carries no heading element).
 */
import { useMemo } from "react";
import Link from "next/link";
import { Pill } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScoreRing } from "@/components/insights/derived/score-ring";
import {
  resolveDashboardVerdict,
  type DashboardVerdictVariant,
} from "@/lib/dashboard/verdict";
import type { DashboardSnapshot } from "@/lib/dashboard/snapshot";
import type { QuickEntryDialog } from "@/components/dashboard/quick-entry-sheets";
import { useTranslations, useTimeFormatPreference } from "@/lib/i18n/context";
import { makeFormatters } from "@/lib/format-locale";
import { cn } from "@/lib/utils";

/**
 * Variant → message key. `briefing` is deliberately absent — its
 * sentence is the model headline rendered verbatim, not a translation.
 * The bpCritical rung surfaces under the `bpHigh` copy key.
 */
const VERDICT_MESSAGE_KEY: Record<
  Exclude<DashboardVerdictVariant, "briefing">,
  string
> = {
  doseOverdue: "dashboard.hero.verdict.doseOverdue",
  bpCritical: "dashboard.hero.verdict.bpHigh",
  doseUpcoming: "dashboard.hero.verdict.doseUpcoming",
  weightDrift: "dashboard.hero.verdict.weightDrift",
  shortNights: "dashboard.hero.verdict.shortNights",
  silence: "dashboard.hero.verdict.silence",
  scoreDrop: "dashboard.hero.verdict.scoreDrop",
  allQuiet: "dashboard.hero.verdict.allQuiet",
};

/** Variant → CTA label key. `allQuiet` carries no CTA (cta: null). */
const CTA_LABEL_KEY: Partial<Record<DashboardVerdictVariant, string>> = {
  doseOverdue: "dashboard.hero.action.takeDose",
  doseUpcoming: "dashboard.hero.action.takeDose",
  bpCritical: "dashboard.hero.action.viewBp",
  weightDrift: "dashboard.hero.action.viewWeight",
  shortNights: "dashboard.hero.action.viewSleep",
  silence: "dashboard.hero.action.logMeasurement",
  scoreDrop: "dashboard.hero.action.viewInsights",
  briefing: "dashboard.hero.action.viewInsights",
};

/** YYYY-MM-DD key of `d`'s calendar day in `tz` (mirrors the resolver). */
function dayKeyInTz(d: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

export function DashboardHero({
  snapshot,
  onQuickEntry,
}: {
  snapshot: DashboardSnapshot;
  onQuickEntry: (dialog: NonNullable<QuickEntryDialog>) => void;
}) {
  const { t, locale } = useTranslations();
  const timeFormat = useTimeFormatPreference();
  // Times format in the USER's timezone from the snapshot (the shared
  // `useFormatters()` hook falls back to the display default), honouring
  // the per-user hour-cycle preference like the medication cards do.
  // Only ever invoked post-snapshot, so no pre-paint Intl work.
  const fmt = useMemo(
    () => makeFormatters(locale, snapshot.user.timezone, timeFormat),
    [locale, snapshot.user.timezone, timeFormat],
  );

  // Fresh `now` per snapshot evaluation: the resolver re-derives every
  // freshness window against the current instant, so a snapshot served
  // from cache ages honestly between refetches.
  const verdict = useMemo(
    () => resolveDashboardVerdict(snapshot, new Date()),
    [snapshot],
  );

  // ── Greeting — absorbed from the old header paragraph ──────────────
  // The server-computed wall-clock hour keeps the daypart stable and
  // Intl-free; the hero only mounts once the snapshot resolved (the
  // skeleton carries the footprint before that), so the personalised
  // line can never disagree with SSR output.
  const hour = snapshot.user.greetingHour;
  const timeGreeting =
    hour >= 5 && hour < 12
      ? t("dashboard.greeting.morning")
      : hour >= 12 && hour < 18
        ? t("dashboard.greeting.day")
        : t("dashboard.greeting.evening");
  const name = snapshot.user.username.trim();
  const welcomeText =
    name.length > 0
      ? t("dashboard.welcomeBackWithName", { greeting: timeGreeting, name })
      : t("dashboard.welcomeBack", { greeting: timeGreeting });

  // ── Verdict sentence + CTA ──────────────────────────────────────────
  const sentence =
    verdict.variant === "briefing"
      ? // Model headline VERBATIM as a plain text child — no key.
        String(verdict.values.headline ?? "")
      : t(VERDICT_MESSAGE_KEY[verdict.variant], {
          ...verdict.values,
          // The resolver emits a fixed 24 h wall-clock string; re-format
          // the underlying instant through the user's hour-cycle
          // preference when we still hold it.
          ...(verdict.variant === "doseUpcoming" &&
          snapshot.medsToday.nextDueAt !== null
            ? { time: fmt.time(snapshot.medsToday.nextDueAt) }
            : {}),
          ...(verdict.variant === "shortNights" &&
          typeof verdict.values.hours === "number"
            ? { hours: fmt.number(verdict.values.hours, 1) }
            : {}),
        });
  const cta = verdict.cta;
  const ctaLabelKey = CTA_LABEL_KEY[verdict.variant];

  // ── Dose row ────────────────────────────────────────────────────────
  const meds = snapshot.medsToday;
  const now = new Date();
  const tz = snapshot.user.timezone;
  const unresolvedRemain =
    meds.scheduledToday > meds.takenToday + meds.skippedToday;
  const nextDueMs = meds.nextDueAt !== null ? Date.parse(meds.nextDueAt) : NaN;
  // "Next at" only for a FUTURE anchor on the user's local today. A past
  // anchor with `nextDueOverdue: false` is the documented stale-cache
  // state and must render as the plain summary — never as overdue.
  const showNextAt =
    unresolvedRemain &&
    Number.isFinite(nextDueMs) &&
    nextDueMs >= now.getTime() &&
    dayKeyInTz(new Date(nextDueMs), tz) === dayKeyInTz(now, tz);
  const doseDetail =
    meds.scheduledToday > 0
      ? !unresolvedRemain
        ? t("dashboard.hero.doses.allDone")
        : showNextAt
          ? t("dashboard.hero.doses.nextAt", {
              time: fmt.time(new Date(nextDueMs)),
            })
          : null
      : null;

  return (
    <section
      data-slot="dashboard-hero"
      className={cn(
        // `.hero-gradient` carries its own border tint; deliberately
        // no glow treatment — the band sits above the tile strip and
        // must read calmer than the /insights hero.
        "hero-gradient relative isolate overflow-hidden rounded-xl",
        "min-h-[8.75rem] px-4 py-5 sm:px-6 md:min-h-[9.5rem]",
      )}
    >
      <div className="flex h-full flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0 flex-1 space-y-3">
          <p
            data-slot="dashboard-hero-greeting"
            className="text-muted-foreground text-sm"
          >
            {welcomeText}
          </p>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <p
              data-slot="dashboard-hero-verdict"
              data-verdict-variant={verdict.variant}
              className="text-foreground text-base font-medium"
            >
              {sentence}
            </p>
            {cta !== null && ctaLabelKey ? (
              cta.kind === "link" ? (
                <Button
                  asChild
                  size="sm"
                  variant="outline"
                  data-slot="dashboard-hero-cta"
                >
                  <Link href={cta.href}>{t(ctaLabelKey)}</Link>
                </Button>
              ) : (
                <Button
                  size="sm"
                  data-slot="dashboard-hero-cta"
                  onClick={() => onQuickEntry(cta.target)}
                >
                  {t(ctaLabelKey)}
                </Button>
              )
            ) : null}
          </div>
          <div
            data-slot="dashboard-hero-doses"
            className="bg-card/65 border-border/60 inline-flex max-w-full items-center gap-2 rounded-xl border px-3 py-2 shadow-sm backdrop-blur-sm"
          >
            <Pill
              className="text-muted-foreground h-4 w-4 shrink-0"
              aria-hidden="true"
            />
            <span className="text-foreground truncate text-sm">
              {meds.scheduledToday > 0
                ? t("dashboard.hero.doses.summary", {
                    taken: meds.takenToday,
                    scheduled: meds.scheduledToday,
                  })
                : t("dashboard.hero.doses.none")}
            </span>
            {doseDetail !== null ? (
              <span className="text-muted-foreground shrink-0 text-sm">
                · {doseDetail}
              </span>
            ) : null}
          </div>
        </div>
        {/* Right column — fixed 120 px ring footprint. A null score
            renders the ring's provisional state (aria announces "not
            enough data", never 0) at identical geometry, so the column
            NEVER collapses. */}
        <div className="flex shrink-0 items-center justify-center md:justify-end">
          <ScoreRing
            score={snapshot.healthScore?.score ?? null}
            band={snapshot.healthScore?.band}
            size="sm"
            label={
              snapshot.healthScore
                ? t("dashboard.hero.scoreLabel")
                : t("dashboard.hero.scoreProvisional")
            }
          />
        </div>
      </div>
    </section>
  );
}
