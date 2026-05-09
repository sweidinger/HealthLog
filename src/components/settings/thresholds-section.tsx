"use client";

import { ThresholdsEditorSection } from "@/components/settings/thresholds-editor-section";
import { useTranslations } from "@/lib/i18n/context";

/**
 * `<ThresholdsSection>` — route-level wrapper for `/settings/thresholds`.
 *
 * v1.4.16 phase B6: file renamed from the historic
 * `thresholds-settings-section.tsx` (`<ThresholdsSettingsSection>`) so the
 * filename + default export match the slug — every other section in
 * `src/components/settings/` follows the `<slug>-section.tsx`
 * `<SlugSection>` convention. The inner editor card was simultaneously
 * moved out of `thresholds-section.tsx` (where it used to live as
 * `<ThresholdsSection>`) into `thresholds-editor-section.tsx`
 * (`<ThresholdsEditorSection>`) so the names stop clashing.
 */
export function ThresholdsSection() {
  const { t } = useTranslations();

  return (
    <section
      aria-labelledby="settings-section-thresholds-title"
      className="space-y-6"
    >
      <header className="space-y-1">
        <h1
          id="settings-section-thresholds-title"
          className="text-2xl font-semibold tracking-tight"
        >
          {t("settings.sections.thresholds.title")}
        </h1>
        <p className="text-muted-foreground text-sm">
          {t("settings.sections.thresholds.description")}
        </p>
      </header>

      <ThresholdsEditorSection id="thresholds" />
    </section>
  );
}
