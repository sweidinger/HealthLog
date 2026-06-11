"use client";

/**
 * Settings → AI section wrapper.
 *
 * v1.16.4 — the former 2k-LOC monolith is split into per-provider
 * subcomponents under `src/components/settings/ai/` (one file per
 * provider form, plus the chain / runtime / coach-toggle cards). This
 * file only owns the section frame and the card order; behaviour lives
 * in the parts.
 */

import { AboutMeSection } from "@/components/settings/about-me-section";
import { AiInsightsCard } from "@/components/settings/ai/ai-insights-card";
import { DisableCoachCard } from "@/components/settings/ai/disable-coach-card";
import { CoachMemorySection } from "@/components/settings/coach-memory-section";
import { CoachPrefsSection } from "@/components/settings/coach-prefs-section";
import { useAuth } from "@/hooks/use-auth";
import { useMounted } from "@/hooks/use-mounted";
import { useTranslations } from "@/lib/i18n/context";

export function AiSection() {
  const { t } = useTranslations();
  const { isAuthenticated, user } = useAuth();
  // v1.16.6 — the auth query can resolve before this boundary
  // hydrates; every `disabled={!isAuthenticated}` binding in the child
  // cards would then disagree with the SSR HTML (React #418). Gate the
  // prop on `useMounted()` so the hydration render matches the
  // server-rendered "not yet authenticated" state and the cards enable
  // on the first client re-render.
  const mounted = useMounted();
  const authed = mounted && isAuthenticated;
  // v1.11.2 — the Coach-memory panel rides the same gate as the rest of
  // the Coach surface: when the user has hidden the Coach there is no
  // assistant to remember anything, so the memory controls hide too.
  // (`mounted`-gated like `authed`: SSR renders the panels, so the
  // hydration render must too, even when the user disabled the Coach.)
  const coachEnabled = !mounted || !user?.disableCoach;

  return (
    <section aria-labelledby="settings-section-ai-title" className="space-y-6">
      <header className="space-y-1">
        <h1 id="settings-section-ai-title" className="sr-only">
          {t("settings.sections.ai.title")}
        </h1>
        <p className="text-muted-foreground text-sm">
          {t("settings.sections.ai.description")}
        </p>
      </header>

      <AiInsightsCard isAuthenticated={authed} />

      {/* v1.4.47 W3 — per-user Coach opt-out. Lives below the provider
          card so users who want the surface gone never have to scroll
          through provider configuration before finding the toggle. */}
      <DisableCoachCard isAuthenticated={authed} />

      {/* v1.16.1 — Coach preferences (tone, verbosity, data scope)
          moved here from the in-chat sheet; the chat header gear
          deep-links to this section. Gated on the Coach being
          enabled. */}
      {coachEnabled && <CoachPrefsSection isAuthenticated={authed} />}

      {/* v1.11.2 — "What the Coach remembers": durable-fact review +
          forget controls. Gated on the Coach being enabled. */}
      {coachEnabled && <CoachMemorySection isAuthenticated={authed} />}

      {/* v1.15.20 — user-authored "about me" context for the Coach +
          daily briefing. Not gated on the Coach toggle: the briefing
          reads it too. */}
      <AboutMeSection isAuthenticated={authed} />
    </section>
  );
}
