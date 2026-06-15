"use client";

/**
 * v1.18.0 (S5) — Settings → Gesundheitsakte (health record).
 *
 * The full health-record export was the hero panel at the top of the
 * Export & Import section. It is a distinct concept — a complete,
 * clinician-ready record (PDF + FHIR R4 + a combined zip package) — and
 * earns its own top-level settings home rather than sharing the page with
 * the generic CSV / JSON data-out paths. Export & Import now keeps only
 * the generic data export/import surfaces.
 *
 * Not module-gated: the health record is always available.
 */

import { HealthRecordExportPanel } from "@/components/settings/health-record-export-panel";
import { useTranslations } from "@/lib/i18n/context";

export function GesundheitsakteSection() {
  const { t } = useTranslations();
  return (
    <section
      aria-labelledby="settings-section-gesundheitsakte-title"
      className="space-y-6"
    >
      <header className="space-y-1">
        <h1
          id="settings-section-gesundheitsakte-title"
          className="sr-only"
        >
          {t("settings.sections.gesundheitsakte.title")}
        </h1>
        <p className="text-muted-foreground text-sm">
          {t("settings.sections.gesundheitsakte.description")}
        </p>
      </header>

      <HealthRecordExportPanel />
    </section>
  );
}
