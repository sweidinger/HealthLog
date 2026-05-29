"use client";

/**
 * v1.5.6 G-1 §5 — Advanced settings sheet.
 *
 * Hosts the three settings sections the detail page no longer renders
 * inline: Notifications, Settings (API tokens / CSV stub / Phasen /
 * grace) and the destructive zone, stacked top → bottom in
 * routine → rare → destructive order inside a `<ResponsiveSheet>`.
 *
 * The Phasen button is sibling-swapped, not nested: when the user
 * opens it, `onRequestPhaseSheet` closes this sheet first and lets the
 * parent open the phase sheet so the modal stack never exceeds two
 * (G-1 §5 / D-3 §10 invariant 7). Each moved section saves itself, so
 * the footer slot stays empty. On a non-navigating destructive success
 * the sheet closes; the Tier 3b delete already navigates to
 * `/medications`.
 */

import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { NotificationsSection } from "@/components/medications/sections/notifications-section";
import { SettingsSection } from "@/components/medications/sections/settings-section";
import { DestructiveZoneSection } from "@/components/medications/sections/destructive-zone-section";
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
}: AdvancedSettingsSheetProps) {
  const { t } = useTranslations();

  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={onOpenChange}
      title={t("medications.detail.advanced.title")}
      contentWidth="lg"
      bodyClassName="gap-6"
    >
      <div
        className="space-y-6"
        data-slot="advanced-settings-sheet-body"
      >
        {/* routine */}
        <NotificationsSection
          medicationId={medicationId}
          notificationsEnabled={notificationsEnabled}
        />

        {/* rare */}
        <SettingsSection
          medicationId={medicationId}
          medicationName={medicationName}
          treatmentClass={treatmentClass}
          startsOn={startsOn}
          endsOn={endsOn}
          reminderGraceMinutes={reminderGraceMinutes}
          onRequestPhaseSheet={onRequestPhaseSheet}
        />

        {/* destructive */}
        <DestructiveZoneSection
          medicationId={medicationId}
          medicationName={medicationName}
          active={active}
          intakeCount={intakeCount}
          onAfterAction={() => onOpenChange(false)}
        />
      </div>
    </ResponsiveSheet>
  );
}
