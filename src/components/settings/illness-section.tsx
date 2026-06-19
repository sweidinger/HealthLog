"use client";

/**
 * v1.18.7 — Settings → Krankheitstagebuch.
 *
 * The illness-journal customise surface (list view + episode order) was a
 * standalone `ModuleSettingsFrame` page at `/settings/illness`; it now
 * renders as a first-class Settings section. The shell supplies the page
 * chrome (left nav, heading, subtitle) so this body is the illness cards
 * only. The nav entry is module-gated on `illness`.
 */

import { IllnessSettings } from "@/components/illness/illness-settings";

export function IllnessSection() {
  return (
    <div className="space-y-6">
      <IllnessSettings />
    </div>
  );
}
