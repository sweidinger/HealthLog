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
 *     personalised line is not drowned by the content below it) and the
 *     verdict sentence with its single CTA button;
 *   - right column: the ring row — the health-score `<ScoreRing>` at
 *     `sm` geometry in its `flat` treatment (no bloom / pulse / sheen /
 *     sweep) plus the user-selected score rings the snapshot resolved
 *     server-side (`scoreRings`, max 3: readiness / recovery / sleep in
 *     their wellness-strip hues, medication adherence in band
 *     semantics). v1.27.7 — the ring row replaces the old dose text row;
 *     the adherence ring carries its information role. Selected rings
 *     self-gate: an entry absent from `scoreRings` (no data, disabled
 *     module) renders nothing, exactly like the wellness strip. A null
 *     health score renders the ring's provisional state at the identical
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
 * so the stale state renders as a calm verdict, never as overdue.
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
import { Button } from "@/components/ui/button";
import { ScoreRing } from "@/components/insights/derived/score-ring";
import type { RingHue } from "@/components/insights/derived/ring-hues";
import { RestModeBanner } from "@/components/insights/rest-mode-banner";
import { BriefingSpotlight } from "@/components/dashboard/hero/briefing-spotlight";
import {
  HeroRingCarousel,
  type HeroRingSlide,
} from "@/components/dashboard/hero/hero-ring-carousel";
import { METRIC_HREF } from "@/components/insights/daily-briefing";
import {
  resolveDashboardVerdict,
  type DashboardVerdictVariant,
} from "@/lib/dashboard/verdict";
import type { DashboardSnapshot } from "@/lib/dashboard/snapshot";
import {
  HEALTH_SCORE_RING_ID,
  resolveHeroRingOrder,
  type ScoreRingId,
  type HeroRingId,
} from "@/lib/dashboard-layout";
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

/** Variant → CTA label key. `allQuiet` carries no CTA (cta: null).
 *  `scoreDrop` / `briefing` carry none either: their only destination was
 *  the Insights overview, which the health-score card already links — a
 *  second broad "open Insights" button on the hero was redundant. Only
 *  verdicts with a SPECIFIC destination or action keep a button. */
const CTA_LABEL_KEY: Partial<Record<DashboardVerdictVariant, string>> = {
  doseOverdue: "dashboard.hero.action.takeDose",
  doseUpcoming: "dashboard.hero.action.takeDose",
  bpCritical: "dashboard.hero.action.viewBp",
  weightDrift: "dashboard.hero.action.viewWeight",
  shortNights: "dashboard.hero.action.viewSleep",
  silence: "dashboard.hero.action.logMeasurement",
};

/**
 * Per-ring hue for the selected score rings — the wellness-strip
 * vocabulary, so every hero ring paints EXACTLY the hue its insights
 * sibling paints. MED_COMPLIANCE rides the `meds` hue: the medication
 * family in Insights paints `--primary` on every surface (compliance
 * bars, compliance trend line, drug-level / dose-strength curves), so
 * the dose ring holds that one constant tone — never a band gradient
 * that would flash yellow/red over pending morning doses, and not the
 * green arc the ring system reserves for band semantics.
 */
const RING_HUE_BY_ID: Partial<Record<ScoreRingId, RingHue>> = {
  READINESS: "readiness",
  RECOVERY_SCORE: "recovery",
  SLEEP_SCORE: "sleep",
  MED_COMPLIANCE: "meds",
};

/** Per-ring label key — reuses the existing score labels; the dose ring
 *  names today's tally. */
const RING_LABEL_KEY: Record<ScoreRingId, string> = {
  READINESS: "insights.derived.composite.READINESS.title",
  RECOVERY_SCORE: "insights.derived.scores.recovery",
  SLEEP_SCORE: "insights.derived.composite.SLEEP_SCORE.title",
  MED_COMPLIANCE: "dashboard.hero.ringDoses",
};

/**
 * v1.27.24 — per-ring detail destination. Each hero ring links to the
 * SAME surface its sibling already owns elsewhere in the app, so tapping
 * a ring opens the natural deeper view rather than inventing one:
 *
 *   - the three derived rings route to their score-anatomy detail page
 *     (`/insights/scores/<slug>`) — exactly where the /insights wellness
 *     strip links each ring;
 *   - the dose ring routes to the medications surface (`/medications`) —
 *     the today/intake destination the dashboard dose CTA already uses.
 *
 * The health-score ring is wired separately to the Insights overview
 * (`/insights`, the destination the health-score card carries). A ring
 * with no sensible destination would be left non-interactive; every id
 * in the closed set has one, so the map is total.
 */
const RING_HREF: Record<ScoreRingId, string> = {
  READINESS: "/insights/scores/readiness",
  RECOVERY_SCORE: "/insights/scores/recovery",
  SLEEP_SCORE: "/insights/scores/sleep",
  MED_COMPLIANCE: "/medications",
};

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

  // Link-CTA verdicts WITHOUT a button label (scoreDrop, briefing) make
  // the sentence itself the link — after the broad "open Insights"
  // button was dropped the sentence was a dead end. The briefing
  // sentence deep-links to the picked finding's metric sub-page (the
  // METRIC_HREF map the briefing rows use); metrics without a routed
  // sub-page fall back to the resolver's `/insights` href. Verdicts
  // with their own action (take dose, view BP, …) keep the button.
  const sentenceHref =
    cta !== null && cta.kind === "link" && !ctaLabelKey
      ? verdict.variant === "briefing" &&
        typeof verdict.values.sourceMetric === "string"
        ? (METRIC_HREF[
            verdict.values.sourceMetric as keyof typeof METRIC_HREF
          ] ?? cta.href)
        : cta.href
      : null;

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

  // ── Ring row (v1.27.7) ─────────────────────────────────────────────
  // The snapshot resolves the selected rings server-side; entries absent
  // from the array (no data / disabled module) simply don't render —
  // the wellness-strip self-gating rule. Optional on the type (additive
  // contract), so an older cached snapshot renders the health ring alone.
  const scoreRings = snapshot.scoreRings ?? [];

  // One slide per ring, keyed by its `HeroRingId`. Each score ring links
  // to its natural existing detail surface; a real <Link> (in the
  // carousel) keeps tap-vs-drag native on mobile.
  const scoreRingSlides = new Map<HeroRingId, HeroRingSlide>(
    scoreRings.map((ring) => [
      ring.id,
      {
        key: ring.id,
        ringId: ring.id,
        href: RING_HREF[ring.id],
        linkLabel: t("dashboard.hero.ringLink", {
          metric: t(RING_LABEL_KEY[ring.id]),
        }),
        node:
          // Dose ring — today's tally ("1/3") over the constant med-family
          // arc (`hue="meds"` = --primary, the tone every medication surface
          // in Insights paints); the arc still sweeps on the 0..100 progress
          // `score`. `band="green"` stays as the stable data-band anchor — a
          // pending morning dose is not an alert state — while the hue owns
          // the paint. Falls through to the score render when a cached
          // pre-doses snapshot carries no tally.
          ring.id === "MED_COMPLIANCE" && ring.doses ? (
            <ScoreRing
              score={ring.score}
              band="green"
              hue="meds"
              valueText={`${ring.doses.taken}/${ring.doses.scheduled}`}
              ariaLabel={t("dashboard.hero.ringDosesAria", {
                taken: ring.doses.taken,
                scheduled: ring.doses.scheduled,
              })}
              size="sm"
              flat
              label={t(RING_LABEL_KEY[ring.id])}
            />
          ) : (
            <ScoreRing
              score={ring.score}
              band={ring.band}
              size="sm"
              flat
              hue={RING_HUE_BY_ID[ring.id]}
              label={t(RING_LABEL_KEY[ring.id])}
            />
          ),
      },
    ]),
  );

  const healthScoreSlide: HeroRingSlide = {
    key: "health-score",
    // The health-score ring opens the Insights overview — the same
    // destination the health-score card links (why the hero verdict
    // dropped its redundant "open Insights" button).
    href: "/insights",
    linkLabel: t("dashboard.hero.ringLink", {
      metric: t("dashboard.hero.scoreLabel"),
    }),
    node: (
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
    ),
  };

  // v1.27.27 — the hero ring sequence honours the persisted order (health
  // score + selected rings). The reconciler defaults to health-score-first
  // when the user hasn't customised, drops any ordered id whose ring isn't
  // rendered (no data / disabled module), and appends a rendered ring the
  // order omits — so the order can never hide or duplicate a slide. Feeds
  // the carousel on mobile and the inline row on desktop from a SINGLE
  // render of each ring node.
  const heroRingOrder = resolveHeroRingOrder(
    snapshot.layout?.heroRingOrder,
    scoreRings.map((ring) => ring.id),
  );
  const ringSlides: HeroRingSlide[] = heroRingOrder
    .map((id) =>
      id === HEALTH_SCORE_RING_ID ? healthScoreSlide : scoreRingSlides.get(id),
    )
    .filter((slide): slide is HeroRingSlide => slide !== undefined);

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
      {/* Vertical rhythm: greeting/ring row and the briefing sit one tight
          spacing step apart on desktop (md:gap-2) so the briefing hugs the
          ring row instead of drifting below a floating greeting; mobile
          keeps the roomier gap-4. The top row aligns to its start on
          desktop so the greeting anchors to the top edge instead of
          drifting to the vertical centre of the taller ring column. */}
      <div className="flex h-full flex-col gap-4 md:gap-2">
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
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
              {sentenceHref ? (
                <Link
                  href={sentenceHref}
                  data-slot="dashboard-hero-verdict"
                  data-verdict-variant={verdict.variant}
                  className="text-foreground/90 hover:text-foreground text-base font-medium transition-colors"
                >
                  {sentence}
                </Link>
              ) : (
                <p
                  data-slot="dashboard-hero-verdict"
                  data-verdict-variant={verdict.variant}
                  className="text-foreground/90 text-base font-medium"
                >
                  {sentence}
                </p>
              )}
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
          </div>
          {/* Ring carousel — the selected score rings (max 3, each at the
            fixed 120 px sm footprint, flat) lead into the health-score
            ring on the trailing edge. On mobile they ride a one-ring
            scroll-snap carousel with dot indicators (calmer than the old
            wrap-to-grid row); at `md` and up the SAME nodes revert to the
            right-aligned inline row. A null health score renders the
            ring's provisional state (aria announces "not enough data",
            never 0) at identical geometry, so the column NEVER
            collapses; missing selected rings render nothing. */}
          <HeroRingCarousel slides={ringSlides} />
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
