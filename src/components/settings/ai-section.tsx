"use client";

/**
 * Settings → AI section wrapper.
 *
 * v1.16.4 — the former 2k-LOC monolith is split into per-provider
 * subcomponents under `src/components/settings/ai/` (one file per
 * provider form, plus the chain / runtime cards). This file only owns
 * the section frame and the card order; behaviour lives in the parts.
 *
 * v1.18.0 (S5) — the Coach preference cards (disable toggle, preferences,
 * memory) moved out to the dedicated Coach section. The AI section keeps
 * only provider / model / BYOK configuration.
 *
 * v1.18.1 (D8) — the "About me" context moved to Settings → Account (under
 * Profil, before Zyklus-Tracking). It is personal medical context the daily
 * briefing reads too, so it belongs with the account profile rather than the
 * provider-configuration screen.
 */

import { AiInsightsCard } from "@/components/settings/ai/ai-insights-card";
import { useAuth } from "@/hooks/use-auth";
import { useMounted } from "@/hooks/use-mounted";
import { useTranslations } from "@/lib/i18n/context";

export function AiSection() {
  const { t } = useTranslations();
  const { isAuthenticated } = useAuth();
  // v1.16.6 — the auth query can resolve before this boundary
  // hydrates; every `disabled={!isAuthenticated}` binding in the child
  // cards would then disagree with the SSR HTML (React #418). Gate the
  // prop on `useMounted()` so the hydration render matches the
  // server-rendered "not yet authenticated" state and the cards enable
  // on the first client re-render.
  const mounted = useMounted();
  const authed = mounted && isAuthenticated;

  return (
    <section aria-labelledby="settings-section-ai-title" className="space-y-6">
      {/* v1.18.1 (D0) — section blurb dropped for consistent top alignment. */}
      <header>
        <h1 id="settings-section-ai-title" className="sr-only">
          {t("settings.sections.ai.title")}
        </h1>
      </header>

      <AiInsightsCard isAuthenticated={authed} />

      {/* v1.18.1 (D8) — the "About me" context moved to Settings → Account
          (under Profil, before Zyklus-Tracking). */}
    </section>
  );
}
