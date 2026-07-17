"use client";

/**
 * S2 — the Today hero, the promoted day's read on the dashboard.
 *
 * MARC SIGN-OFF (2026-07-16, decision 1): Today is the dashboard hero
 * promoted to the default read, with the dense tile grid demoted below
 * it on the SAME page — no new nav destination. This band mounts above
 * the existing tile strip and renders the S1 `DailyDigest` DTO verbatim;
 * it recomputes nothing (server-authoritative parity) and fetches no
 * fresh AI (the caller's hook GETs the already-cached digest route).
 *
 * Composition (plan §2.1, top→bottom, all shipped primitives):
 *   - the day's read: the health `ScoreRing` (`flat`, md) with its
 *     server-computed band and an honest provisional/final face — a null
 *     score paints the ring's own provisional state, never a zero;
 *   - the selected score rings (v1.29.0): the user's Settings-picked hero
 *     rings (max 3), resolved + gated by the dashboard snapshot and ordered
 *     by `resolveHeroRingOrder`, as a calm sm-ring cluster beneath the
 *     health ring — the picker configures the web hero again;
 *   - the briefing lead in plain language (via `ProseBlocks`, no markdown)
 *     with a "read the full briefing" affordance, plus the top signal's
 *     present-tense headline + delta when the digest carries one;
 *   - the freshness note: when `sleepPending`, a calm muted "last night's
 *     sleep not yet in" line — it never blocks the hero (plan §2.4);
 *   - the worth-a-look rail: the digest's `PriorityItem[]` as `PriorityCard`s
 *     (S1's one rail primitive), only when non-empty. When the digest is
 *     all-clear, a first-class muted "nothing needs your attention" line
 *     stands in its place — not an alarming empty card.
 *
 * Every `PriorityItem` action carries an `href` (dose.log → /medications,
 * sync.reconnect → /settings/integrations, checkup.view → /checkups), so
 * `PriorityCard` wires each tap as a `<Link>` to its existing destination
 * by construction; S2 invents no new backend action.
 */
import Link from "next/link";
import { Moon } from "lucide-react";

import { ScoreRing } from "@/components/insights/derived/score-ring";
import type { ScoreBand } from "@/components/insights/derived/band-tokens";
import type { RingHue } from "@/components/insights/derived/ring-hues";
import { ProseBlocks } from "@/components/insights/prose-blocks";
import { PriorityCard } from "@/components/daily/priority-card";
import { useCoachCheckinAction } from "@/hooks/use-coach-checkin";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";
import type { ScoreRingId } from "@/lib/dashboard-layout";
import type { DashboardScoreRing } from "@/lib/dashboard/score-rings";
import {
  COACH_CHECKIN_KEEP_INTENT,
  COACH_CHECKIN_LETGO_INTENT,
  type DailyDigest,
} from "@/lib/daily/digest";

/**
 * v1.29.0 — the selected score rings return to the hero. The maps mirror the
 * retired legacy-hero renderer verbatim so every ring paints EXACTLY the hue,
 * label, and destination its insights sibling owns:
 *
 *   - hue: the wellness-strip vocabulary (readiness green / recovery cyan /
 *     sleep purple); `MED_COMPLIANCE` rides `meds` = `--primary`, the one
 *     constant tone every medication surface paints — never a band gradient
 *     that would flash yellow over pending morning doses.
 *   - label: the existing score labels; the dose ring names today's tally.
 *   - href: each ring opens the SAME detail surface the wellness strip /
 *     medications page already own — the picker configures real navigation,
 *     not decoration.
 */
const RING_HUE_BY_ID: Partial<Record<ScoreRingId, RingHue>> = {
  READINESS: "readiness",
  RECOVERY_SCORE: "recovery",
  SLEEP_SCORE: "sleep",
  MED_COMPLIANCE: "meds",
};

const RING_LABEL_KEY: Record<ScoreRingId, string> = {
  READINESS: "insights.derived.composite.READINESS.title",
  RECOVERY_SCORE: "insights.derived.scores.recovery",
  SLEEP_SCORE: "insights.derived.composite.SLEEP_SCORE.title",
  MED_COMPLIANCE: "dashboard.hero.ringDoses",
};

const RING_HREF: Record<ScoreRingId, string> = {
  READINESS: "/insights/scores/readiness",
  RECOVERY_SCORE: "/insights/scores/recovery",
  SLEEP_SCORE: "/insights/scores/sleep",
  MED_COMPLIANCE: "/medications",
};

/** Format the server-computed score delta as a signed, muted chip string. */
function formatDelta(
  delta: number,
  t: ReturnType<typeof useTranslations>["t"],
) {
  const rounded = Math.round(delta);
  if (rounded === 0) return t("daily.today.deltaFlat");
  const signed = rounded > 0 ? `+${rounded}` : `${rounded}`;
  return t("daily.today.deltaVsBaseline", { delta: signed });
}

export function TodayHero({
  digest,
  rings = [],
}: {
  digest: DailyDigest;
  /**
   * v1.29.0 — the user's selected hero score rings (Settings → Dashboard),
   * resolved server-side by the dashboard snapshot (data- and module-gated)
   * and ordered by the caller via `resolveHeroRingOrder`, so the Settings
   * picker's selection + drag order configure the web hero again. The
   * health-score ring stays the hero's fixed anchor; this cluster renders
   * beneath it. Optional and additive — an empty selection (or the legacy
   * non-snapshot path) keeps the hero exactly as before.
   */
  rings?: DashboardScoreRing[];
}) {
  const { t } = useTranslations();
  const { keep, letGo } = useCoachCheckinAction();

  // The coach check-in card's keep / let-go intents carry the plan id after the
  // ":" (a closed two-intent allowlist); adjust is an href handled by the card
  // as a <Link>, so it never lands here. Every other rail kind is pure
  // navigation (dose / sync / preventive), so their taps never call this.
  const handleAction = (intent: string) => {
    const keepPrefix = `${COACH_CHECKIN_KEEP_INTENT}:`;
    const letGoPrefix = `${COACH_CHECKIN_LETGO_INTENT}:`;
    if (intent.startsWith(keepPrefix)) {
      keep.mutate(intent.slice(keepPrefix.length));
    } else if (intent.startsWith(letGoPrefix)) {
      letGo.mutate(intent.slice(letGoPrefix.length));
    }
  };

  const hasScore = digest.score !== null;
  const hasItems = digest.worthALook.length > 0;
  // The briefing lead is the warmest read; the deterministic `line` is the
  // floor a keyless self-hoster still gets. Prefer the lead for the hero.
  const lead = digest.briefingLead ?? digest.line;
  const topSignal = digest.topSignal;

  // Calm degrade (plan §3): a genuinely empty account — no score, no rail
  // items, and no cached briefing lead — surfaces nothing here. The tile
  // strip below carries its own "add your first reading" empty state, so a
  // second alarming empty card on the hero would be noise. The all-clear
  // state (score present, nothing needs attention) is handled inline below.
  if (!hasScore && !hasItems && !digest.briefingLead) {
    return null;
  }

  return (
    <section
      data-slot="today-hero"
      data-phase={digest.phase}
      className={cn(
        // The tile strip's surface plus the ONE sanctioned Today atmosphere:
        // `.today-hero-wash` leans a faint `--primary` mix over the theme
        // `--card` toward the ring corner (the `.wellness-tile` color-mix
        // pattern, softer than the insights hero) so the promoted day's read
        // carries a quiet identity without a banner gradient or glow.
        "bg-card today-hero-wash border-border relative isolate overflow-hidden rounded-xl border",
        "p-4 md:p-6",
      )}
    >
      <div className="flex flex-col gap-4 md:gap-5">
        {/* The day's read — the numeric face on the trailing edge, the
            narrative lead leading. */}
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between md:gap-6">
          <div className="min-w-0 flex-1 space-y-2">
            {/* Hero numeric face: the read leads large in the foreground
                token, calm and legible — the day's read, not a slogan. */}
            <div
              data-slot="today-hero-lead"
              className="text-foreground text-lg leading-snug font-semibold tracking-tight sm:text-xl"
            >
              <ProseBlocks text={lead} strip linkify={false} />
            </div>
            {/* Top signal — present-tense headline + optional delta, one
                muted step down so it supports the lead without competing. */}
            {topSignal ? (
              <p
                data-slot="today-hero-signal"
                className="text-muted-foreground text-sm"
              >
                {topSignal.headline}
                {topSignal.delta ? (
                  <span className="text-muted-foreground/80">
                    {" "}
                    · {topSignal.delta}
                  </span>
                ) : null}
              </p>
            ) : null}
            {/* Read-the-full-briefing affordance — only when a briefing
                actually backs the lead. Routes to the Insights overview. */}
            {digest.briefingLead ? (
              <Link
                href="/insights"
                data-slot="today-hero-briefing-link"
                className="text-primary hover:text-primary/80 inline-flex min-h-9 items-center text-sm font-medium transition-colors"
              >
                {t("daily.today.readFullBriefing")}
              </Link>
            ) : null}
          </div>

          {/* Health score ring — `flat` (no sweep/bloom), server-computed
              band. A null score paints the ring's honest provisional face
              at the same footprint, so the column never collapses. */}
          <div className="flex shrink-0 flex-col items-center gap-1 md:items-end">
            <div data-slot="today-hero-score">
              {/* The ring opens the Insights overview — the destination the
                  health-score card owns — matching the cluster rings' tap
                  behaviour, so every hero ring is a door, not a poster. */}
              <Link
                href="/insights"
                aria-label={t("daily.today.ringLink", {
                  metric: t("daily.today.scoreLabel"),
                })}
                className="focus-visible:ring-ring/50 block rounded-full focus-visible:ring-2 focus-visible:outline-none"
              >
                <ScoreRing
                  score={digest.score?.value ?? null}
                  band={
                    digest.score ? (digest.score.band as ScoreBand) : undefined
                  }
                  size="md"
                  flat
                  label={t("daily.today.scoreLabel")}
                />
              </Link>
            </div>
            {digest.score && digest.score.delta !== null ? (
              <span
                data-slot="today-hero-score-delta"
                className="text-muted-foreground text-xs tabular-nums"
              >
                {formatDelta(digest.score.delta, t)}
              </span>
            ) : null}
          </div>
        </div>

        {/* v1.29.0 — the selected score rings, resurfaced. A calm inline
            cluster beneath the health ring (right-aligned with it on md+,
            centred on mobile), honouring the user's Settings selection and
            drag order. Each ring is the shared `ScoreRing` primitive in its
            wellness hue, `flat` (no sweep) so the cluster paints at once,
            and links to the metric's existing detail surface. Selection
            empty → the row simply isn't there — the hero reads as before. */}
        {rings.length > 0 ? (
          <div
            data-slot="today-hero-ring-cluster"
            className="flex flex-wrap items-start justify-center gap-x-4 gap-y-3 md:justify-end"
          >
            {rings.map((ring) => (
              <Link
                key={ring.id}
                href={RING_HREF[ring.id]}
                data-slot="today-hero-ring"
                data-ring={ring.id}
                aria-label={t("daily.today.ringLink", {
                  metric: t(RING_LABEL_KEY[ring.id]),
                })}
                className="focus-visible:ring-ring/50 rounded-full focus-visible:ring-2 focus-visible:outline-none"
              >
                {ring.id === "MED_COMPLIANCE" && ring.doses ? (
                  // Dose ring — today's tally ("1/3") over the constant
                  // med-family arc; the arc sweeps on the 0..100 progress.
                  // `band="green"` stays the stable data-band anchor — a
                  // pending morning dose is not an alert state.
                  <ScoreRing
                    score={ring.score}
                    band="green"
                    hue="meds"
                    valueText={`${ring.doses.taken}/${ring.doses.scheduled}`}
                    ariaLabel={t("daily.today.ringDosesAria", {
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
                )}
              </Link>
            ))}
          </div>
        ) : null}

        {/* Freshness note (plan §2.4) — provisional day, last night's sleep
            not yet folded in. Muted, non-blocking, refreshes in place when
            the morning job lands. */}
        {digest.sleepPending ? (
          <p
            data-slot="today-hero-sleep-pending"
            className="text-muted-foreground flex items-center gap-1.5 text-xs"
          >
            <Moon className="size-3.5 shrink-0" aria-hidden="true" />
            {t("daily.today.sleepPending")}
          </p>
        ) : null}

        {/* Worth-a-look rail — S1's `PriorityCard`s, bounded 0–3. When the
            digest is all-clear, a first-class muted line stands in for the
            rail (calm inversion of an alarm), never an empty card. */}
        {hasItems ? (
          <div className="space-y-2" data-slot="today-hero-rail">
            <h2 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
              {t("daily.today.worthALook")}
            </h2>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {digest.worthALook.map((item, i) => (
                <PriorityCard
                  key={`${item.kind}-${i}`}
                  item={item}
                  onAction={handleAction}
                />
              ))}
            </div>
          </div>
        ) : (
          <p
            data-slot="today-hero-all-clear"
            className="text-muted-foreground text-sm"
          >
            {t("daily.today.allClear")}
          </p>
        )}
      </div>
    </section>
  );
}
