"use client";

import { Loader2 } from "lucide-react";

import { useTranslations } from "@/lib/i18n/context";
import { useModulePageGuard } from "@/hooks/use-module-page-guard";
import { SubPageShell } from "@/components/insights/sub-page-shell";
import { RecoverySection } from "@/components/insights/recovery/recovery-section";

/**
 * v1.17.1 — `/insights/recovery`.
 *
 * The render host for the WHOOP / Polar device-native recovery + strain scores
 * that were stored end-to-end but had no page: day strain, workout strain, ANS
 * charge, cardio load, and the day's whole-cycle average / max heart rate and
 * kilojoule energy expenditure. The composite RECOVERY_SCORE keeps its anatomy
 * detail at `/insights/scores/recovery`.
 *
 * v1.18.1 (B1–B3) — the page now follows the canonical per-metric structure:
 * each present signal renders a block carrying a short explainer, the
 * max / median / mean stat strip, the same chart with the 7 / 30 / 90 / All
 * toggle, and a per-chart assessment. The redundant top "Recovery score"
 * cross-link is removed (reached from the overview already).
 *
 * Every block is data-gated inside `<RecoverySection>`, so an account without a
 * strap / ring sees only the calm empty note. Server-authoritative: the charts
 * render stored values, never a recompute.
 */
export default function InsightsRecoveryPage() {
  const { t } = useTranslations();
  const { ready } = useModulePageGuard("recovery");

  // v1.18.0 B1 — bounce a direct URL hit on a disabled-recovery account.
  if (!ready) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="text-primary h-8 w-8 animate-spin motion-reduce:animate-none" />
      </div>
    );
  }

  return (
    <SubPageShell
      title={t("insights.recovery.title")}
      description={t("insights.recovery.description")}
      explainerMetric="recoveryPage"
      coachLaunch
    >
      <RecoverySection />
    </SubPageShell>
  );
}
