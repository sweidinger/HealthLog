"use client";

import { useAuth } from "@/hooks/use-auth";
import { useTranslations } from "@/lib/i18n/context";
import type { ModuleKey } from "@/lib/modules/registry";
import { DashboardSection } from "./dashboard-section";
import { InsightsSection } from "./insights-section";
import { MedicationsSection } from "./medications-section";
import { MoodSection } from "./mood-section";
import { LabsSection } from "./labs-section";
import { IllnessSection } from "./illness-section";
import { VorsorgeSection } from "./vorsorge-section";

/**
 * v1.17.1 (F-2) — the "Appearance" home (slug stays `layout`).
 *
 * "How my app looks and is arranged" was scattered across several unrelated
 * settings sections with no shared framing. This section is the single front
 * door for every view/arrangement surface.
 *
 * v1.25.7 — the hub stops being a link list and becomes the page itself: the
 * dashboard, insights, and every tracking module's settings render inline as
 * stacked, labelled sections, composing the EXISTING section components
 * verbatim. The per-module settings pages are no longer standalone left-nav
 * entries — their routes 301-redirect to the matching anchor here
 * (`/settings/medications` → `/settings/layout#medications`, …). Each module
 * section keeps its module-gate: a disabled module's section does not render,
 * read from the resolved `useAuth().user.modules` map (the same map the nav,
 * the Modules hub, and the Insights pills gate off). The gate fails OPEN
 * (`!== false`) so a stale `/me` payload never blanks a section. Vorsorge
 * (preventive-care reminders) is not a toggleable module, so it always shows.
 *
 * Each section carries a stable anchor id (`#dashboard`, `#insights`,
 * `#medications`, `#mood`, `#labs`, `#illness`, `#vorsorge`) so deep links and
 * the per-module page-header cogs land on the right block. The inner card
 * anchors inside each module section (`#medications-view`, `#labs-view`, …)
 * keep working too.
 *
 * Visual rhythm mirrors the multi-group Notifications surface 1:1 — outer
 * `space-y-10`, each group a `<section>` with a `space-y-0.5` heading block and
 * the section body below. No new card chrome is introduced; every card paints
 * through its own existing component unchanged.
 */
interface LayoutGroup {
  /** Anchor id + redirect target (`/settings/layout#<id>`). */
  id: string;
  /** i18n key under `settings.sections.layout.<slug>.title`. */
  titleKey: string;
  /** i18n key under `settings.sections.layout.<slug>.description`. */
  descriptionKey: string;
  Body: () => React.JSX.Element | null;
  /**
   * When set, the group renders only while the module is enabled (fail-open,
   * `!== false`). Omitted = always shown.
   */
  moduleGate?: ModuleKey;
}

const LAYOUT_GROUPS: ReadonlyArray<LayoutGroup> = [
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

export function LayoutSection() {
  const { t } = useTranslations();
  const { user } = useAuth();

  // v1.25.7 — per-module gating. Fail OPEN (`!== false`): a missing key, or a
  // not-yet-resolved `/me` payload, reads as enabled so a section never
  // silently disappears. Groups with no `moduleGate` always render.
  const modules = user?.modules;
  const visibleGroups = LAYOUT_GROUPS.filter(
    (group) => !group.moduleGate || modules?.[group.moduleGate] !== false,
  );

  // The visible page heading + subtitle are painted by `SettingsShell` from
  // the section slug; this body stacks the per-surface sections below it.
  return (
    <div className="space-y-10">
      {visibleGroups.map((group) => {
        const { Body } = group;
        return (
          <section
            key={group.id}
            id={group.id}
            className="scroll-mt-28 space-y-4"
          >
            <div className="space-y-0.5">
              <h2 className="text-foreground text-lg font-semibold">
                {t(group.titleKey)}
              </h2>
              <p className="text-muted-foreground text-sm">
                {t(group.descriptionKey)}
              </p>
            </div>
            <Body />
          </section>
        );
      })}
    </div>
  );
}
