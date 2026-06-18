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
 * The `doctorReport` module governs the data layer, not the Settings
 * entry-point: as of v1.18.6.1 the nav entry always shows (the health record
 * is a flagship export capability and should never silently vanish from
 * Settings). The server-side `/api/export/health-record` route is the hard
 * enforcement — it refuses with a 403 `module.disabled` envelope when the
 * account has opted out, so a disabled doctor-report surface cannot be
 * reached over a Bearer token either.
 */

import { HealthRecordExportPanel } from "@/components/settings/health-record-export-panel";

export function GesundheitsakteSection() {
  // v1.18.6 (W9) — the visible heading + subtitle and the module tour-replay
  // trigger now live in the shared `<SettingsSectionFrame>` in the route; the
  // body is the health-record export panel only.
  return <HealthRecordExportPanel />;
}
