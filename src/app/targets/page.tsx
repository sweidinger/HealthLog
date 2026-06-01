"use client";

// DEPRECATED since v1.8.6. Target-range editing moved inline into the
// Insights category pages (the per-metric reference panel now mounts the
// same <TargetEditSheet>), so this standalone page no longer appears in
// the navigation. It stays routable behind the `/zielwerte`→`/targets`
// proxy redirect and is a remove candidate after ~10 releases.
//
// What stays in place because Insights consumes the same API:
//   • GET /api/insights/targets — the read powering this page is the
//     same payload the Insights panel reads (`queryKeys.insightsTargets()`).
//   • PUT/DELETE /api/user/thresholds — the threshold override write the
//     inline <TargetEditSheet> calls.
//   • src/components/targets/* — TargetCard, TargetEditSheet, RangeBar,
//     ConsistencyStrip, TargetStatusPill, source-link helper are all
//     reused by the inline Insights panel.
// Removing the page later is a UI-only change; no data or API moves.

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle, Loader2 } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { Card, CardContent } from "@/components/ui/card";
import { convertGlucose, resolveGlucoseUnit } from "@/lib/glucose";
import {
  TargetCard,
  type TargetCardData,
} from "@/components/targets/target-card";
import { TargetsSummaryHeader } from "@/components/targets/targets-summary-header";
import { getTargetSourceLink } from "@/lib/targets/source-link";
import { CoachDrawer } from "@/components/insights/coach-panel/coach-drawer";
import { useCoachHandoff } from "@/hooks/use-coach-handoff";
import { useFeatureFlags } from "@/hooks/use-feature-flags";

type TargetData = TargetCardData;

interface BpDiastolic {
  current: number | null;
  average30: number | null;
  range: { min: number; max: number } | null;
}

interface TargetPageSummary {
  targetsMetThisWeek: number;
  totalTargets: number;
  streakHighlight: { metric: string; days: number } | null;
}

interface TargetsResponse {
  targets: TargetData[];
  pageSummary?: TargetPageSummary;
  bpDiastolic: BpDiastolic;
  profile: {
    heightCm: number | null;
    age: number | null;
    gender: string | null;
    glucoseUnit?: string | null;
  };
}

/**
 * v1.4.25 W3e — provider-chain status used to gate the per-card Coach
 * CTA. Returns true when at least one provider is configured AND
 * enabled. The Settings → AI surface owns the same query (via
 * `queryKeys.insightsProviderChain()`) so the cache is shared.
 */
interface ProviderChainStatus {
  activeProvider: string | null;
  cachedActiveProvider: string | null;
  configuredChain: Array<{
    providerType: string;
    enabled: boolean;
    available: boolean;
  }>;
}

const GLUCOSE_TYPES = new Set([
  "BLOOD_GLUCOSE_FASTING",
  "BLOOD_GLUCOSE_POSTPRANDIAL",
  "BLOOD_GLUCOSE_RANDOM",
  "BLOOD_GLUCOSE_BEDTIME",
]);

/**
 * Fixed card order per Marc directive — explicitly NOT status-sorted.
 * Marc wants a stable visual hierarchy so the user's eye lands on the
 * same metric in the same place every visit. Cards whose type is not
 * in this list (glucose contexts, future metrics) sort after the
 * core six in their server-emitted order.
 */
const FIXED_TARGET_ORDER: Record<string, number> = {
  BLOOD_PRESSURE: 0,
  BLOOD_PRESSURE_IN_TARGET: 1,
  WEIGHT: 2,
  PULSE: 3,
  BMI: 4,
  MOOD_SCORE: 5,
  MOOD_STABILITY: 6,
  MEDICATION_COMPLIANCE: 7,
  SLEEP_DURATION: 8,
  BODY_FAT: 9,
  ACTIVITY_STEPS: 10,
};

function sortKey(target: TargetData): number {
  return FIXED_TARGET_ORDER[target.type] ?? 100;
}

export default function TargetsPage() {
  const { t } = useTranslations();
  const { isAuthenticated, user } = useAuth();

  const { data, isLoading } = useQuery({
    queryKey: queryKeys.insightsTargets(),
    queryFn: async () => {
      const res = await fetch("/api/insights/targets");
      if (!res.ok) throw new Error(t("targets.loadError"));
      const json = await res.json();
      return json.data as TargetsResponse;
    },
    enabled: isAuthenticated,
  });

  // v1.4.25 W3e — share the cache with Settings → AI section. When the
  // user has no configured provider, `activeProvider` is null and the
  // per-card Coach CTA hides entirely (no broken-button state).
  const { data: chainStatus } = useQuery({
    queryKey: queryKeys.insightsProviderChain(),
    queryFn: async () => {
      const res = await fetch("/api/insights/provider-chain");
      if (!res.ok) return null;
      const json = await res.json();
      return json.data as ProviderChainStatus;
    },
    enabled: isAuthenticated,
  });
  // v1.4.37 W5 — operator's global Coach flag layered on top of the
  // per-user provider chain. Either gate disables every Coach
  // affordance on this page: the per-card CTAs (via `aiEnabled`
  // threaded into <TargetCard>) and the page-level <CoachDrawer> mount
  // below. The flag default is all-on for fresh installs and on any
  // fetch error, so the path stays open by default.
  const flags = useFeatureFlags();
  // v1.4.47 W3 — per-user "Hide Coach" toggle is a peer gate to the
  // operator's master flag. When either is off, the per-card CTAs +
  // the page-level <CoachDrawer> mount below both go dark.
  const coachEnabled = flags.coach && !user?.disableCoach;
  const aiEnabled = coachEnabled && chainStatus?.activeProvider != null;

  // v1.4.25 W3e — Coach drawer state owned by the page. The per-card
  // CTA + summary header both feed the same drawer so the user only
  // ever sees one drawer instance.
  const { coachOpen, setCoachOpen, coachPrefill, coachScope, askCoach } =
    useCoachHandoff();

  const visibleTargets = useMemo(() => {
    if (!data) return [] as TargetData[];
    const displayGlucoseUnit = resolveGlucoseUnit(
      data.profile.glucoseUnit ?? null,
    );
    return data.targets
      .filter((target) => target.current != null)
      .map((target) => {
        if (!GLUCOSE_TYPES.has(target.type)) return target;
        // Server label is an i18n key for glucose; resolve here.
        const label = t(target.label);
        // Convert mg/dL canonical values to the user's display unit.
        const convert = (v: number | null) =>
          v == null ? null : convertGlucose(v, displayGlucoseUnit);
        return {
          ...target,
          label,
          unit: displayGlucoseUnit,
          current: convert(target.current),
          average30: convert(target.average30),
          range: target.range
            ? {
                min: convertGlucose(target.range.min, displayGlucoseUnit),
                max: convertGlucose(target.range.max, displayGlucoseUnit),
              }
            : null,
        };
      })
      .sort((a, b) => sortKey(a) - sortKey(b));
  }, [data, t]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="text-primary h-6 w-6 animate-spin motion-reduce:animate-none" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="text-muted-foreground py-20 text-center">
        {t("common.noData")}
      </div>
    );
  }

  const profileIncomplete = !data.profile.heightCm || !data.profile.age;

  return (
    // v1.4.19 phase A7 — the maintainer reported "relativ viel Platz" wasted
    // between the overview header and the first values on `/targets`.
    // Tighten the rhythm from `space-y-8` (32 px) to `space-y-6`
    // (24 px) — that matches the admin / settings pages.
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{t("targets.title")}</h1>
        <p className="mt-2 text-sm">{t("targets.introText")}</p>
      </div>

      {/* v1.8.6 — single warning banner. Target editing moved inline into
          the Insights category pages; this page stays reachable but will
          be removed in a future release.

          Design Low fix: the deprecation notice and the profile-incomplete
          hint used to stack as two near-identical warning cards. They are
          folded into one card now — the deprecation message stays the
          headline, and the profile-incomplete detail (height / age missing)
          renders as a secondary line beneath it only when relevant, so the
          page never shows two warning banners. */}
      <Card className="border-warning border-l-4" data-slot="targets-deprecation">
        <CardContent className="flex gap-3 py-3">
          <AlertCircle className="text-warning mt-0.5 h-4 w-4 shrink-0" />
          <div className="space-y-2">
            <div>
              <p className="text-sm font-medium">
                {t("targets.deprecation.title")}
              </p>
              <p className="text-muted-foreground text-sm">
                {t("targets.deprecation.body")}
              </p>
            </div>
            {profileIncomplete && (
              <div data-slot="targets-profile-incomplete">
                <p className="text-sm font-medium">
                  {t("targets.profileIncomplete")}
                </p>
                <p className="text-muted-foreground text-sm">
                  {!data.profile.heightCm && !data.profile.age
                    ? t("targets.profileIncompleteHeightAge")
                    : !data.profile.heightCm
                      ? t("targets.profileIncompleteHeight")
                      : t("targets.profileIncompleteAge")}
                </p>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* v1.4.25 W3e — page-level summary line. Renders nothing when
          the API hasn't shipped pageSummary yet (older clients during
          rollout / mocked test fixtures that pre-date this addition). */}
      {data.pageSummary && (
        <TargetsSummaryHeader
          targetsMetThisWeek={data.pageSummary.targetsMetThisWeek}
          totalTargets={data.pageSummary.totalTargets}
          streakHighlight={data.pageSummary.streakHighlight}
        />
      )}

      {/* v1.4.25 W3e — responsive grid. Mobile (default): single
          column. sm (640px+): two columns. lg (1024px+): three columns,
          matching the dashboard / insights rhythm. Cards reflow
          internally too — see <TargetCard>. */}
      {visibleTargets.length > 0 ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 lg:gap-6">
          {visibleTargets.map((target) => (
            <TargetCard
              key={target.type}
              target={target}
              bpDiastolic={
                target.type === "BLOOD_PRESSURE" ? data.bpDiastolic : undefined
              }
              aiEnabled={aiEnabled}
              onAskCoach={askCoach}
              sourceLink={getTargetSourceLink(target)}
            />
          ))}
        </div>
      ) : (
        <div className="text-muted-foreground border-border rounded-xl border p-6 text-sm">
          {t("targets.noMeasurementData")}
        </div>
      )}

      {/* v1.4.25 W3e — Coach drawer mounted at the page level. The
          drawer is fully-controlled; per-card CTAs flip `coachOpen`
          and seed `coachPrefill` via the `askCoach()` hook callback.
          v1.4.37 W5 — short-circuit when the operator turned the
          global Coach flag off so the SSE machinery + Sheet portal
          never mount. The per-card CTAs already hide via `aiEnabled`
          above, so the drawer can never be triggered with the flag
          off; the gate is defence-in-depth. */}
      {coachEnabled && (
        <CoachDrawer
          open={coachOpen}
          onOpenChange={setCoachOpen}
          prefill={coachPrefill}
          key={`coach-drawer-${coachScope?.sources?.join(",") ?? "default"}`}
        />
      )}
    </div>
  );
}
