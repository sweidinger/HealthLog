"use client";

/**
 * v1.18.0 (S5) — Settings → Coach.
 *
 * The Coach preference cards moved out of the AI / Assistant section into
 * their own dedicated entry so the AI section owns only provider / model /
 * BYOK configuration. This section gathers the Coach-specific surface:
 *
 *   1. Disable Coach    — the per-user opt-out (kept first so a user who
 *                         wants the surface gone finds it immediately).
 *   2. Coach preferences — tone, verbosity, data scope (`useCoachPrefs`).
 *   3. Coach memory      — durable-fact review + forget controls.
 *
 * The nav entry is module-gated on `coach`. The preference + memory cards
 * keep their own content gate on `!user.disableCoach` (mirrored from the
 * old AI section): hiding the Coach hides its tuning + memory controls too.
 *
 * The "about me" context lives in the AI section, not here — the daily
 * briefing reads it too, so it is not a Coach-only setting.
 */

import { DisableCoachCard } from "@/components/settings/ai/disable-coach-card";
import { CoachMemorySection } from "@/components/settings/coach-memory-section";
import { CoachPrefsSection } from "@/components/settings/coach-prefs-section";
import { useAuth } from "@/hooks/use-auth";
import { useMounted } from "@/hooks/use-mounted";
import { useTranslations } from "@/lib/i18n/context";

export function CoachSection() {
  const { t } = useTranslations();
  const { isAuthenticated, user } = useAuth();
  // Mirror the AI section's hydration-safe gating: the auth query can
  // resolve before this boundary hydrates, so gate the child props on
  // `useMounted()` to keep the hydration render matching the SSR HTML.
  const mounted = useMounted();
  const authed = mounted && isAuthenticated;
  // The preference + memory cards ride the same content gate as the rest
  // of the Coach surface: when the user has hidden the Coach there is no
  // assistant to tune or remember anything. (`mounted`-gated so the SSR +
  // hydration renders agree.)
  const coachEnabled = !mounted || !user?.disableCoach;

  return (
    <section
      aria-labelledby="settings-section-coach-title"
      className="space-y-6"
    >
      <header className="space-y-1">
        <h1 id="settings-section-coach-title" className="sr-only">
          {t("settings.sections.coach.title")}
        </h1>
        <p className="text-muted-foreground text-sm">
          {t("settings.sections.coach.description")}
        </p>
      </header>

      <DisableCoachCard isAuthenticated={authed} />

      {coachEnabled && <CoachPrefsSection isAuthenticated={authed} />}

      {coachEnabled && <CoachMemorySection isAuthenticated={authed} />}
    </section>
  );
}
