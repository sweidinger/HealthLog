"use client";

import { ThresholdsEditorSection } from "@/components/settings/thresholds-editor-section";
import { useTranslations } from "@/lib/i18n/context";

/**
 * `<ThresholdsSection>` — route-level wrapper for `/settings/thresholds`
 * (the "Targets" / "Zielwerte" page).
 *
 * v1.8.7.1 — Targets and Sources are two separate settings pages again.
 * This page owns only the per-metric target-range editor
 * (`/api/user/thresholds`); the source-priority ladders moved back onto
 * their own `/settings/sources` page (`<SourcesSection>`). The two were
 * merged into one "Targets & Sources" page in v1.4.34 IW-D, but the
 * combined surface ran long and the two editors drive distinct mutation
 * flows, so each concern is self-contained on its own page.
 *
 * Visual structure on this page:
 *   1. Section header (title + description).
 *   2. `<ThresholdsEditorSection>` — per-metric range inputs. The editor
 *      card keeps its own affordance row (icon, reset-all button).
 *
 * v1.4.16 phase B6: file renamed from the historic
 * `thresholds-settings-section.tsx` (`<ThresholdsSettingsSection>`)
 * so the filename + default export match the slug — every other
 * section in `src/components/settings/` follows the
 * `<slug>-section.tsx` `<SlugSection>` convention. The inner editor
 * card was simultaneously moved out of `thresholds-section.tsx`
 * (where it used to live as `<ThresholdsSection>`) into
 * `thresholds-editor-section.tsx` (`<ThresholdsEditorSection>`) so
 * the names stop clashing.
 */
export function ThresholdsSection() {
  const { t } = useTranslations();

  return (
    <section
      aria-labelledby="settings-section-thresholds-title"
      className="space-y-6"
    >
      <header className="space-y-1">
        <h1 id="settings-section-thresholds-title" className="sr-only">
          {t("settings.sections.thresholds.title")}
        </h1>
        <p className="text-muted-foreground text-sm">
          {t("settings.sections.thresholds.description")}
        </p>
      </header>

      {/* Per-metric threshold ranges. */}
      <ThresholdsEditorSection id="thresholds" />
    </section>
  );
}
