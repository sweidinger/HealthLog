"use client";

/**
 * `<ModulesSection>` — Settings → Module ("Was du trackst") hub. v1.18.0.
 *
 * The one place a user decides which secondary domains HealthLog surfaces.
 * Each toggleable module (mood, sleep, glucose, workouts, recovery, labs,
 * achievements, coach, insights, doctor report, cycle) gets a row with an
 * icon, label, one-line description, and a `<Switch>`. Flipping a switch
 * PATCHes `/api/auth/me/modules` (a DISABLED allowlist; the endpoint refuses
 * core keys) and then invalidates the `authMe()` query so the nav, Insights
 * pills, and dashboard tiles re-gate live off `useAuth().user.modules`.
 *
 * The three CORE domains (weight, blood pressure, pulse) render as a
 * separate read-only "always on" group — locked switches with a short note —
 * so the always-on measurement engine reads as deliberately fixed, never
 * disableable. Palette stays neutral throughout; this is a calm
 * configuration surface, not an alarm panel. (v1.18.1 D3 — medications
 * graduated to the toggleable group above.)
 *
 * State source is `useAuth().user.modules` (the resolved `/auth/me` map).
 * A module is enabled unless its key is explicitly `false` — default-on.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Activity,
  Award,
  Blocks,
  CalendarHeart,
  Droplet,
  Dumbbell,
  FileText,
  HeartPulse,
  Lock,
  MessageCircleHeart,
  Moon,
  Pill,
  Scale,
  Smile,
  Sparkles,
  TestTube,
  Thermometer,
  type LucideIcon,
} from "lucide-react";

import { SettingsCardHeader } from "@/components/settings/_card-header";
import { ModuleToggleRow } from "@/components/settings/module-toggle-row";
import { useAuth } from "@/hooks/use-auth";
import { useTranslations } from "@/lib/i18n/context";
import { apiPatch } from "@/lib/api/api-fetch";
import { queryKeys } from "@/lib/query-keys";
import {
  CORE_DOMAIN_KEYS,
  MODULE_REGISTRY,
  moduleDelegatesTo,
  type CoreDomainKey,
  type ModuleKey,
} from "@/lib/modules/registry";

/** Neutral Lucide glyph per toggleable module. */
const MODULE_ICONS: Record<ModuleKey, LucideIcon> = {
  cycle: CalendarHeart,
  mood: Smile,
  sleep: Moon,
  glucose: Droplet,
  workouts: Dumbbell,
  recovery: Activity,
  labs: TestTube,
  illness: Thermometer,
  achievements: Award,
  coach: MessageCircleHeart,
  insights: Sparkles,
  // v1.18.1 (D3) — medications graduated from CORE to a toggleable module.
  medications: Pill,
  doctorReport: FileText,
};

/** Neutral Lucide glyph per core (always-on) domain. */
const CORE_ICONS: Record<CoreDomainKey, LucideIcon> = {
  weight: Scale,
  bloodPressure: HeartPulse,
  pulse: Activity,
};

export function ModulesSection() {
  const { t } = useTranslations();
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const modules = user?.modules ?? {};
  const moduleAvailability = user?.moduleAvailability ?? {};

  const toggle = useMutation({
    // Factory-routed; the in-repo eslint rule forbids a bare literal here.
    mutationKey: queryKeys.modulesPrefs(),
    mutationFn: async (vars: { key: ModuleKey; enabled: boolean }) => {
      // DISABLED allowlist: send only the single key the user flipped.
      // Delegated keys (cycle/coach) never reach here — they render as
      // read-only deep-link rows, so the PATCH only ever carries a
      // directly-owned key.
      return apiPatch("/api/auth/me/modules", { [vars.key]: vars.enabled });
    },
    onSuccess: () => {
      // Re-gate every surface that reads the module map off /auth/me: nav,
      // Insights pills, dashboard tiles, quick-add, search.
      void queryClient.invalidateQueries({ queryKey: queryKeys.authMe() });
      toast.success(t("settings.sections.modules.saved"));
    },
    onError: () => {
      toast.error(t("settings.sections.modules.error"));
    },
  });

  return (
    <section
      aria-labelledby="settings-section-modules-title"
      className="space-y-6"
    >
      {/* v1.18.6 — restore a short intro line so a new user understands
          that this page drives the nav, tiles and assessments they see.
          (Dropped in v1.18.1 D0 for top alignment; the orientation cost
          outweighed the alignment.) */}
      <header className="space-y-1">
        <h1 id="settings-section-modules-title" className="sr-only">
          {t("settings.sections.modules.title")}
        </h1>
        <p className="text-muted-foreground text-sm leading-relaxed">
          {t("settings.sections.modules.description")}
        </p>
      </header>

      <div className="bg-card border-border rounded-xl border p-4 sm:p-6">
        <SettingsCardHeader
          icon={Blocks}
          title={t("settings.sections.modules.toggleable.title")}
          className="mb-2"
        />
        {/* v1.18.6 — restore the one-line "what this section does" hint. */}
        <p className="text-muted-foreground mb-3 pl-7 text-sm leading-relaxed">
          {t("settings.sections.modules.toggleable.description")}
        </p>
        <div className="divide-border divide-y pl-7">
          {(Object.keys(MODULE_REGISTRY) as ModuleKey[]).map((key) => {
            const def = MODULE_REGISTRY[key];
            // Default-on: a module is enabled unless explicitly `false`.
            const enabled = modules[key] !== false;
            // Delegated modules (cycle/coach) are owned elsewhere — never a
            // live toggle here; deep-link to their real control instead.
            const delegated = moduleDelegatesTo(key) !== undefined;
            // Operator turned this module off server-wide: no per-user
            // toggle can re-enable it, so show a read-only note. Delegated
            // rows already deep-link, so this only matters for owned keys.
            const operatorDisabled =
              !delegated && moduleAvailability[key] === false;
            return (
              <ModuleToggleRow
                key={key}
                moduleKey={key}
                icon={MODULE_ICONS[key]}
                label={t(def.labelKey)}
                description={t(def.descriptionKey)}
                enabled={enabled}
                pending={toggle.isPending}
                managedAt={
                  delegated && def.managedAt
                    ? {
                        href: def.managedAt.href,
                        label: t(def.managedAt.labelKey),
                      }
                    : undefined
                }
                manageLinkLabel={
                  delegated && def.managedAt
                    ? t("settings.sections.modules.manageIn", {
                        section: t(def.managedAt.labelKey),
                      })
                    : undefined
                }
                operatorDisabled={operatorDisabled}
                operatorNote={t("settings.sections.modules.operatorDisabled")}
                onToggle={(next) => toggle.mutate({ key, enabled: next })}
              />
            );
          })}
        </div>
      </div>

      {/* Core domains — always on, read-only */}
      <div className="bg-card border-border rounded-xl border p-4 sm:p-6">
        <SettingsCardHeader
          icon={Lock}
          title={t("settings.sections.modules.core.title")}
          description={t("settings.sections.modules.core.description")}
          className="mb-2"
        />
        <div className="divide-border divide-y pl-7">
          {CORE_DOMAIN_KEYS.map((key) => (
            <ModuleToggleRow
              key={key}
              moduleKey={key}
              icon={CORE_ICONS[key]}
              label={t(`modules.${key}.label`)}
              description={t(`modules.${key}.description`)}
              enabled
              locked
              lockedNote={t("settings.sections.modules.core.note")}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
