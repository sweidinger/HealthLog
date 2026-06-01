"use client";

/**
 * v1.7.0 — Advanced settings sheet.
 * v1.7.2 — widened to `4xl` and re-laid into a responsive two-column
 * grid.
 * v1.8.6 — rebuilt as a single column. The two-column data|reminders
 * grid read as overloaded; the sheet now narrows to `2xl` (~672px) and
 * stacks four bordered section cards in most-used-first order:
 * Reminders → Lifecycle → Data → Danger. One spacing rule throughout —
 * `space-y-4` between cards, `divide-y` + `py-3` rows inside each card
 * (the `<SettingsGroup>` card owns the dividers).
 *
 *   - Reminders: notifications switch + reminder window (grace).
 *   - Lifecycle: pause/resume + end course + phases.
 *   - Data: intake Import + medications CSV Export (co-located) +
 *     external-API endpoint / token.
 *   - Danger zone: purge intake history + delete medication, set off by
 *     its own destructive-tinted card so an irreversible action never
 *     sits next to a routine toggle.
 *
 * Button styling is consistent: reversible / neutral actions are
 * `outline`, destructive actions are `destructive font-semibold`,
 * toggles are switches wrapped in labels.
 *
 * The Phasen button is sibling-swapped, not nested: `onRequestPhaseSheet`
 * closes this sheet first and lets the parent open the phase sheet so
 * the modal stack never exceeds two (D-3 §10 invariant 7). Each control
 * self-saves, so the footer slot stays empty.
 */

import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { SettingsGroup } from "@/components/medications/settings-group";
import { ApiTokensRow } from "@/components/medications/sections/api-tokens-row";
import { DataPortabilityRow } from "@/components/medications/sections/data-portability-row";
import { NotificationsBody } from "@/components/medications/sections/notifications-section";
import {
  GraceRow,
  PhasesRow,
} from "@/components/medications/sections/settings-section";
import {
  DangerZoneBody,
  LifecycleManageBody,
} from "@/components/medications/sections/destructive-zone-section";
import { useTranslations } from "@/lib/i18n/context";

export interface AdvancedSettingsSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  medicationId: string;
  medicationName: string;
  treatmentClass?: string;
  active: boolean;
  startsOn?: string | null;
  endsOn?: string | null;
  notificationsEnabled: boolean;
  reminderGraceMinutes: number | null;
  intakeCount: number;
  /**
   * Sibling-swap the phase sheet: the parent closes this sheet and
   * opens `<PhaseConfigSheet>` so the two never stack (G-1 §5).
   */
  onRequestPhaseSheet?: () => void;
  /**
   * v1.7.0 — opens the page-owned `<IntakeImportDialog>` from the Data
   * group's import button.
   */
  onOpenImport?: () => void;
}

export function AdvancedSettingsSheet({
  open,
  onOpenChange,
  medicationId,
  medicationName,
  treatmentClass,
  active,
  startsOn,
  endsOn,
  notificationsEnabled,
  reminderGraceMinutes,
  intakeCount,
  onRequestPhaseSheet,
  onOpenImport,
}: AdvancedSettingsSheetProps) {
  const { t } = useTranslations();
  const isGlp1 = treatmentClass === "GLP1";

  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={onOpenChange}
      title={t("medications.detail.advanced.title")}
      contentWidth="2xl"
      bodyClassName="gap-4"
    >
      <div className="space-y-4" data-slot="advanced-settings-sheet-body">
        {/* REMINDERS — notifications + reminder window. Most-used group
            first; each row is a padded `<div>` so the group card's
            `divide-y` draws the hairline between them. */}
        <SettingsGroup
          label={t("medications.detail.advanced.group.reminders")}
          dataSlot="advanced-group-reminders"
        >
          <div className="py-3">
            <NotificationsBody
              medicationId={medicationId}
              notificationsEnabled={notificationsEnabled}
            />
          </div>
          <div className="py-3">
            <GraceRow
              medicationId={medicationId}
              reminderGraceMinutes={reminderGraceMinutes}
            />
          </div>
        </SettingsGroup>

        {/* LIFECYCLE — pause/resume + end course + phases */}
        <SettingsGroup
          label={t("medications.detail.advanced.group.lifecycle")}
          dataSlot="advanced-group-lifecycle"
        >
          <div className="py-3">
            <LifecycleManageBody
              medicationId={medicationId}
              medicationName={medicationName}
              active={active}
              onAfterAction={() => onOpenChange(false)}
            />
          </div>
          {isGlp1 && (
            <div className="py-3">
              <PhasesRow
                medicationId={medicationId}
                treatmentClass={treatmentClass}
                startsOn={startsOn}
                endsOn={endsOn}
                onRequestPhaseSheet={onRequestPhaseSheet}
              />
            </div>
          )}
        </SettingsGroup>

        {/* DATA — import + export + external API */}
        <SettingsGroup
          label={t("medications.detail.advanced.group.data")}
          dataSlot="advanced-group-data"
        >
          <div className="py-3">
            <DataPortabilityRow
              medicationId={medicationId}
              onOpenImport={onOpenImport}
            />
          </div>
          <div className="py-3">
            <ApiTokensRow
              medicationId={medicationId}
              medicationName={medicationName}
            />
          </div>
        </SettingsGroup>

        {/* DANGER ZONE — purge + delete. Set off by the destructive-
            tinted card so an irreversible action never sits next to a
            routine toggle. The body supplies its own matched-pair card,
            so it slots in without the neutral group frame. */}
        <DangerZoneBody
          medicationId={medicationId}
          medicationName={medicationName}
          intakeCount={intakeCount}
          onAfterAction={() => onOpenChange(false)}
        />
      </div>
    </ResponsiveSheet>
  );
}
