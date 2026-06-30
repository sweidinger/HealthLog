import type { JSX } from "react";

import type { ModuleKey } from "@/lib/modules/registry";
import { DashboardSection } from "./dashboard-section";
import { InsightsSection } from "./insights-section";
import { MedicationsSection } from "./medications-section";
import { MoodSection } from "./mood-section";
import { LabsSection } from "./labs-section";
import { IllnessSection } from "./illness-section";
import { VorsorgeSection } from "./vorsorge-section";

/**
 * v1.25.11 (#148) — single source of truth for the "Appearance" (slug
 * `layout`) hub + its per-module subpages.
 *
 * "How my app looks and is arranged" was scattered across several unrelated
 * settings sections. The `layout` slug is the one front door. v1.25.7 stacked
 * every module's view/sort surface inline on a single page; #148 splits that
 * back into a HUB → SUBPAGE model: `/settings/layout` lists the modules as
 * clickable rows, and each row opens `/settings/layout/<id>`, which renders
 * ONLY that module's section (the same existing section component, verbatim)
 * with a "← Appearance" back-link.
 *
 * This module is intentionally NOT `"use client"`: the client hub
 * (`layout-section.tsx`) AND the server subpage route
 * (`app/settings/layout/[module]/page.tsx`, which reads `LAYOUT_GROUP_IDS` in
 * `generateStaticParams()`) both consume it, so its array values must stay
 * usable on the server. It holds references to the `"use client"` section
 * components, which a server component renders as ordinary client boundaries.
 *
 * Each module section keeps its module-gate: a disabled module's row / subpage
 * does not render, read from the resolved `useAuth().user.modules` map (the
 * same map the nav, the Modules hub, and the Insights pills gate off). The gate
 * fails OPEN (`!== false`) so a stale `/me` payload never blanks an entry.
 * Vorsorge (preventive-care reminders) is not a toggleable module, so it always
 * shows.
 */
export interface LayoutGroup {
  /** Stable id — the subpage path segment (`/settings/layout/<id>`). */
  id: string;
  /** i18n key under `settings.sections.layout.<slug>.title`. */
  titleKey: string;
  /** i18n key under `settings.sections.layout.<slug>.description`. */
  descriptionKey: string;
  Body: () => JSX.Element | null;
  /**
   * When set, the row / subpage renders only while the module is enabled
   * (fail-open, `!== false`). Omitted = always shown.
   */
  moduleGate?: ModuleKey;
}

export const LAYOUT_GROUPS: ReadonlyArray<LayoutGroup> = [
  {
    id: "dashboard",
    titleKey: "settings.sections.layout.dashboard.title",
    descriptionKey: "settings.sections.layout.dashboard.description",
    Body: DashboardSection,
  },
  {
    id: "insights",
    titleKey: "settings.sections.layout.insights.title",
    descriptionKey: "settings.sections.layout.insights.description",
    Body: InsightsSection,
  },
  {
    id: "medications",
    titleKey: "settings.sections.layout.medications.title",
    descriptionKey: "settings.sections.layout.medications.description",
    Body: MedicationsSection,
    moduleGate: "medications",
  },
  {
    id: "mood",
    titleKey: "settings.sections.layout.mood.title",
    descriptionKey: "settings.sections.layout.mood.description",
    Body: MoodSection,
    moduleGate: "mood",
  },
  {
    id: "labs",
    titleKey: "settings.sections.layout.labs.title",
    descriptionKey: "settings.sections.layout.labs.description",
    Body: LabsSection,
    moduleGate: "labs",
  },
  {
    id: "illness",
    titleKey: "settings.sections.layout.illness.title",
    descriptionKey: "settings.sections.layout.illness.description",
    Body: IllnessSection,
    moduleGate: "illness",
  },
  {
    id: "vorsorge",
    titleKey: "settings.sections.layout.vorsorge.title",
    descriptionKey: "settings.sections.layout.vorsorge.description",
    Body: VorsorgeSection,
  },
];

/** Ordered list of the subpage path segments — server-safe for `generateStaticParams()`. */
export const LAYOUT_GROUP_IDS: readonly string[] = LAYOUT_GROUPS.map(
  (group) => group.id,
);

export function isLayoutGroupId(value: string): boolean {
  return LAYOUT_GROUP_IDS.includes(value);
}
