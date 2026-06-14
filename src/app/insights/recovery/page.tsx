"use client";

import { useTranslations } from "@/lib/i18n/context";
import { SubPageShell } from "@/components/insights/sub-page-shell";
import { RecoverySection } from "@/components/insights/recovery/recovery-section";

/**
 * v1.17.1 — `/insights/recovery`.
 *
 * The render host for the WHOOP / Polar device-native recovery + strain scores
 * that were stored end-to-end but had no page: day strain, workout strain, ANS
 * charge, cardio load, and the day's whole-cycle average / max heart rate and
 * kilojoule energy expenditure. The composite RECOVERY_SCORE keeps its anatomy
 * detail at `/insights/scores/recovery`; this page cross-links to it and
 * surrounds it with the raw signals it never surfaced.
 *
 * Every block is data-gated inside `<RecoverySection>`, so an account without a
 * strap / ring sees only the calm empty note. Server-authoritative: the tiles
 * render stored values, never a recompute.
 */
export default function InsightsRecoveryPage() {
  const { t } = useTranslations();

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
