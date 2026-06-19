"use client";

/**
 * v1.18.7 — Settings → Labor.
 *
 * The labs customise surface (list view, sort order, biomarker management)
 * was a standalone `ModuleSettingsFrame` page at `/settings/labs`; it now
 * renders as a first-class Settings section. The shell supplies the page
 * chrome (left nav, heading, subtitle) so this body is the labs cards only —
 * the same pattern the other module-gated sections (Medikamente, Coach,
 * Stimmung) follow. The nav entry is module-gated on `labs`.
 */

import { LabsSettings } from "@/components/labs/labs-settings";

export function LabsSection() {
  return (
    <div className="space-y-6">
      <LabsSettings />
    </div>
  );
}
