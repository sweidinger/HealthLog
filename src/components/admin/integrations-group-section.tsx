"use client";

/**
 * `<IntegrationsGroupSection>` — composite admin route at `/admin/integrations`.
 *
 * Wraps the four standalone integration sub-sections (Umami, GlitchTip, Web
 * Push, Bug Report) under one route so each existing component stays the
 * source of truth for its own settings while admins still get a single
 * landing page mirroring the v1.4 layout.
 */

import { BugReportSection } from "./bug-report-section";
import { GlitchtipSection } from "./glitchtip-section";
import { UmamiSection } from "./umami-section";
import { WebPushVapidSection } from "./web-push-vapid-section";

export function IntegrationsGroupSection() {
  return (
    <div className="space-y-6">
      <UmamiSection />
      <GlitchtipSection />
      <WebPushVapidSection />
      <BugReportSection />
    </div>
  );
}
