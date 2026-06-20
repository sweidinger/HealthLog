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
 *     the daypart free of any client `Intl` work; typographically the
 *     band's anchor, larger and heavier than the verdict so the
 *     personalised line is not drowned by the content below it), the
 *     verdict sentence with its single CTA button, and the dose row;
 *   - right column: the shared `<ScoreRing>` at `sm` geometry, in its
 *     `flat` treatment (no bloom / pulse / sheen / sweep) so the dial
 *     sits as calmly as the surrounding chart cards. A null score
 *     renders the ring's provisional state at the identical
 *     120 px footprint, so the column never collapses. The provisional
 *     label is honest about WHY the score is null: when the snapshot
 *     already carries score inputs (weight / BP summaries, mood
 *     entries, active medications) the rollup tier is merely mid-fold
 *     and the label reads "computing"; only an account with no score
 *     inputs at all gets "not enough data".
 *
 * Defensive contract (cached snapshot): `medsToday.nextDueAt` in the
 * past with `nextDueOverdue: false` means the slot's anchor passed
 * after the snapshot was built. The verdict resolver already falls
 * through (rung 2 keys on the flag, rung 3 requires a future anchor),
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
import { RestModeBanner } from "@/components/insights/rest-mode-banner";
import { BriefingSpotlight } from "@/components/dashboard/hero/briefing-spotlight";
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
  // The dose variants interpolate a medication name; a snapshot can carry
  // none (the resolver emits `""`), and the named sentence would render
  // with a hole ("Eine Dosis  ist überfällig."). Swap to the name-less
  // sibling key instead of patching a generic word into the gap.
  const verdictName =
    typeof verdict.values.name === "string" ? verdict.values.name.trim() : "";
  const messageKey = (variant: Exclude<DashboardVerdictVariant, "briefing">) =>
    variant === "doseOverdue" && verdictName.length === 0
      ? "dashboard.hero.verdict.doseOverdueNoName"
      : variant === "doseUpcoming" && verdictName.length === 0
        ? "dashboard.hero.verdict.doseUpcomingNoName"
        : VERDICT_MESSAGE_KEY[variant];
  const sentence =
    verdict.variant === "briefing"
      ? // Model headline VERBATIM as a plain text child — no key.
        String(verdict.values.headline ?? "")
      : t(messageKey(verdict.variant), {
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

  // ── Provisional score copy ──────────────────────────────────────────
  // The score's four pillars are weight, BP, mood, and medication
  // compliance. When ANY of them already carries data, a null score is
  // a warm-up state (the rollup tier hasn't folded the buckets the
  // warm-phase score rides on yet) — telling an account with weeks of
  // readings "not enough data" would be a lie. Only an account with no
  // score inputs at all keeps the genuine empty-state copy. Cheap
  // heuristic over fields the snapshot already carries; no extra reads.
  const summaries = snapshot.tiles.summaries;
  const hasScoreInputs =
    (summaries.WEIGHT?.count ?? 0) > 0 ||
    (summaries.BLOOD_PRESSURE_SYS?.count ?? 0) > 0 ||
    (summaries.BLOOD_PRESSURE_DIA?.count ?? 0) > 0 ||
    snapshot.tiles.mood.entries.length > 0 ||
    snapshot.medsToday.activeCount > 0;

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
        // The band sits in the same column as the chart cards + tile
        // strip, so it wears the same surface: plain `bg-card` with the
        // shared border + radius + padding (mirrors `<TrendCard>`). No
        // gradient, no glow — it reads as one of the dashboard tiles.
        "bg-card border-border relative isolate overflow-hidden rounded-xl border",
        "min-h-[8.75rem] p-4 md:min-h-[9.5rem] md:p-6",
      )}
    >
      <div className="flex h-full flex-col gap-4">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div className="min-w-0 flex-1 space-y-3">
            {/* Greeting leads the typographic hierarchy: larger + heavier
              than the verdict so the personalised line reads first.
              The verdict keeps its medium weight one step down — still
              the content lead, clearly subordinate to the greeting.
              Both stay on the existing foreground token; the band adds
              no new colour. */}
            <p
              data-slot="dashboard-hero-greeting"
              className="text-foreground text-lg font-semibold tracking-tight sm:text-xl"
            >
              {welcomeText}
            </p>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <p
                data-slot="dashboard-hero-verdict"
                data-verdict-variant={verdict.variant}
                className="text-foreground/90 text-base font-medium"
              >
                {sentence}
              </p>
              {cta !== null && ctaLabelKey ? (
                cta.kind === "link" ? (
                  <Button
                    asChild
                    size="default"
                    variant="outline"
                    className="min-h-11 sm:min-h-9"
                    data-slot="dashboard-hero-cta"
                  >
                    <Link href={cta.href}>{t(ctaLabelKey)}</Link>
                  </Button>
                ) : (
                  <Button
                    size="default"
                    className="min-h-11 sm:min-h-9"
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
              className="bg-muted/50 border-border/60 inline-flex max-w-full items-center gap-2 rounded-xl border px-3 py-2"
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
              flat
              label={
                snapshot.healthScore
                  ? t("dashboard.hero.scoreLabel")
                  : hasScoreInputs
                    ? t("dashboard.hero.scoreComputing")
                    : t("dashboard.hero.scoreProvisional")
              }
            />
          </div>
        </div>
        {/* v1.18.1 — Rest Mode cue beneath the verdict/score row. Self-gating
            (renders nothing unless an episode is active), value-free, and
            untinted so it frames the score without alarming. Closes the
            web↔iOS parity gap: iOS already mirrors `score.restMode`. */}
        <RestModeBanner annotation={snapshot.healthScore?.restMode ?? null} />
        {/* v1.18.11 — briefing spotlight. Lifts the fresh briefing's own
            signals onto the hero so the daily read is always above the
            fold, not buried behind the rung-8 verdict. Self-gating: renders
            nothing unless a fresh (ready, non-stale) briefing carries
            content. The rung-8 `briefing` verdict above still fires when no
            higher rung claims the verdict line; this band is additive and
            does not change which sentence the verdict shows. */}
        <BriefingSpotlight
          briefing={snapshot.briefing}
          briefingState={snapshot.briefingState}
          briefingStale={snapshot.briefingStale}
        />
      </div>
    </section>
  );
}
