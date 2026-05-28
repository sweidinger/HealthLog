"use client";

/**
 * v1.5.5 D-3 §6 + §9 — medication detail page.
 *
 * Replaces the v1.5.4 "form retirement" gap that left every action
 * (Pausieren / Beenden / Notifications / API tokens / Phasen / CSV
 * import / Verlauf löschen / Medikament löschen) reachable only
 * through the list-page kebab — which the kebab didn't actually wire
 * up. The detail page surfaces every restored action in section
 * order; one phone-scroll reaches every one of them.
 *
 * Recurring variant: 8 sections (header → today's dose → cadence →
 * dose ladder / phases → intake history preview → notifications →
 * settings → destructive zone).
 *
 * One-shot variant: 5 sections (header → today's-dose-or-logged →
 * cadence static line → intake history single row → destructive
 * zone). Per D-3 §6 the wizard handles cadence edit via the header
 * pencil so the cadence row hides its own edit affordance.
 *
 * Paused variant: same as the recurring/one-shot layout; the header
 * status pill flips and the today's-dose card disables both buttons
 * with a muted helper. Settings and destructive zone keep rendering.
 *
 * Reads:
 *
 *   - `medicationDetail(id)` for the medication snapshot.
 *   - `medicationIntakeList(id, …)` for the last-14-grouped preview
 *     (the v2 list owns its own paging).
 *   - `notificationsStatus()` + `authMe()` on the notifications
 *     section.
 *   - `medicationTitration(id)` on the GLP-1 dose ladder.
 *
 * Mutations all cascade through `medicationDependentKeys` (which now
 * includes the `compliance-chart-inline` prefix per D-3 §10).
 */

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { ArrowLeft, Loader2 } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { useTranslations, useFormatters } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { parseScheduleRecurrence } from "@/lib/medication-schedule";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { DrugLevelChart } from "@/components/medications/DrugLevelChart";
import { TitrationSection } from "@/components/medications/TitrationSection";
import { MedicationDetailHeader } from "@/components/medications/medication-detail-header";
import { TodaysDoseCard } from "@/components/medications/todays-dose-card";
import { CadenceSummaryRow } from "@/components/medications/cadence-summary-row";
import { IntakeHistoryPreview } from "@/components/medications/sections/intake-history-preview";
import { NotificationsSection } from "@/components/medications/sections/notifications-section";
import { SettingsSection } from "@/components/medications/sections/settings-section";
import { DestructiveZoneSection } from "@/components/medications/sections/destructive-zone-section";
import { MedicationWizardDialog } from "@/components/medications/wizard/MedicationWizardDialog";
import type { MedicationPayload } from "@/components/medications/wizard/wizard-payload";

interface ScheduleSnapshot {
  id: string;
  windowStart: string;
  windowEnd: string;
  label: string | null;
  dose: string | null;
  daysOfWeek: string | null;
  timesOfDay?: string[];
  rrule?: string | null;
  rollingIntervalDays?: number | null;
  reminderGraceMinutes?: number | null;
}

interface MedicationDetailSnapshot {
  id: string;
  name: string;
  dose: string;
  category: string;
  treatmentClass?: string;
  active: boolean;
  notificationsEnabled: boolean;
  pausedAt: string | null;
  startsOn?: string | null;
  endsOn?: string | null;
  oneShot?: boolean;
  schedules: ScheduleSnapshot[];
}

interface IntakeListResponse {
  events: Array<{
    id: string;
    scheduledFor: string;
    takenAt: string | null;
    skipped: boolean;
  }>;
  meta: { total: number; limit: number; offset: number };
}

const INTAKE_PREVIEW_PARAMS = {
  sortBy: "takenAt",
  sortDir: "desc" as const,
  limit: 14,
  offset: 0,
  status: "completed",
};

function snapshotToWizardPayload(
  med: MedicationDetailSnapshot,
): MedicationPayload {
  return {
    id: med.id,
    name: med.name,
    dose: med.dose,
    category: med.category,
    treatmentClass: med.treatmentClass,
    notificationsEnabled: med.notificationsEnabled,
    startsOn: med.startsOn ? new Date(med.startsOn) : null,
    endsOn: med.endsOn ? new Date(med.endsOn) : null,
    oneShot: med.oneShot ?? false,
    schedules: med.schedules.map((s) => ({
      id: s.id,
      windowStart: s.windowStart,
      windowEnd: s.windowEnd,
      label: s.label ?? null,
      dose: s.dose ?? null,
      ...parseScheduleRecurrence(s.daysOfWeek),
      timesOfDay: s.timesOfDay,
      rrule: s.rrule ?? null,
      rollingIntervalDays: s.rollingIntervalDays ?? null,
    })),
  };
}

function isToday(iso: string): boolean {
  const d = new Date(iso);
  const today = new Date();
  return (
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate()
  );
}

export default function MedicationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const router = useRouter();
  const { t } = useTranslations();
  const formatters = useFormatters();

  const [wizardOpen, setWizardOpen] = useState(false);
  const [wizardIntent, setWizardIntent] = useState<
    "cadence" | "name" | undefined
  >(undefined);
  const [importOpen, setImportOpen] = useState(false);

  useEffect(() => {
    if (!authLoading && !isAuthenticated) {
      router.push("/auth/login");
    }
  }, [authLoading, isAuthenticated, router]);

  const {
    data: medication,
    isLoading,
    isError,
  } = useQuery<MedicationDetailSnapshot>({
    queryKey: queryKeys.medicationDetail(id),
    queryFn: async () => {
      const res = await fetch(`/api/medications/${id}`);
      if (!res.ok) throw new Error("medication_detail_failed");
      return (await res.json()).data as MedicationDetailSnapshot;
    },
    enabled: isAuthenticated,
  });

  const { data: intakeList } = useQuery<IntakeListResponse>({
    queryKey: queryKeys.medicationIntakeList(id, INTAKE_PREVIEW_PARAMS),
    queryFn: async () => {
      const params = new URLSearchParams({
        sortBy: INTAKE_PREVIEW_PARAMS.sortBy,
        sortDir: INTAKE_PREVIEW_PARAMS.sortDir,
        limit: String(INTAKE_PREVIEW_PARAMS.limit),
        offset: String(INTAKE_PREVIEW_PARAMS.offset),
        status: INTAKE_PREVIEW_PARAMS.status,
      });
      const res = await fetch(
        `/api/medications/${id}/intake?${params.toString()}`,
      );
      if (!res.ok) throw new Error("intake_list_failed");
      return (await res.json()).data as IntakeListResponse;
    },
    enabled: isAuthenticated && !!medication,
  });

  if (authLoading || isLoading) {
    return (
      <div
        className="flex h-64 items-center justify-center"
        role="status"
        aria-busy="true"
        aria-live="polite"
      >
        <Loader2
          aria-hidden="true"
          className="text-primary h-8 w-8 animate-spin motion-reduce:animate-none"
        />
      </div>
    );
  }

  if (isError || !medication) {
    return (
      <div className="space-y-6">
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground -ml-2 gap-1"
          asChild
        >
          <Link href="/medications">
            <ArrowLeft className="h-4 w-4" />
            {t("medications.back")}
          </Link>
        </Button>
        <Card
          className="p-6"
          role="alert"
          aria-live="polite"
          data-slot="medication-detail-error-card"
        >
          <p className="text-destructive text-sm">
            {t("medications.loadFailed")}
          </p>
        </Card>
      </div>
    );
  }

  const oneShot = medication.oneShot === true;
  const todayEvent = intakeList?.events.find(
    (e) =>
      (e.takenAt && isToday(e.takenAt)) ||
      (e.skipped && isToday(e.scheduledFor)),
  );
  const intakeCount = intakeList?.meta.total ?? 0;
  const primaryGrace =
    medication.schedules[0]?.reminderGraceMinutes ?? null;

  function openWizardWithIntent(intent: "cadence" | "name") {
    setWizardIntent(intent);
    setWizardOpen(true);
  }

  function closeWizard() {
    setWizardOpen(false);
    setWizardIntent(undefined);
  }

  return (
    <div className="space-y-6" data-slot="medication-detail-page">
      <Button
        variant="ghost"
        size="sm"
        className="text-muted-foreground -ml-2 gap-1"
        asChild
      >
        <Link href="/medications">
          <ArrowLeft aria-hidden="true" className="h-4 w-4" />
          {t("medications.back")}
        </Link>
      </Button>

      {/* §9.1 — Header band */}
      <MedicationDetailHeader
        name={medication.name}
        dose={medication.dose}
        active={medication.active}
        endsOn={medication.endsOn}
        onEdit={() => openWizardWithIntent("name")}
      />

      {/* §9.2 — Today's dose card */}
      <TodaysDoseCard
        medicationId={id}
        active={medication.active}
        oneShot={oneShot}
        scheduledForToday={!oneShot || !todayEvent}
        alreadyTakenAt={
          todayEvent && !todayEvent.skipped ? todayEvent.takenAt : null
        }
        alreadySkipped={Boolean(todayEvent?.skipped)}
      />

      {/* §9.3 — Cadence summary. One-shot: static line; the
          `hideEdit` flag suppresses the row's own edit affordance
          because the header pencil routes the wizard. */}
      {oneShot ? (
        <Card
          className="p-5 sm:p-6"
          data-slot="medication-detail-one-shot-cadence"
        >
          <p className="text-foreground text-sm">
            {medication.startsOn
              ? t("medications.detail.cadence.oneShotOn", {
                  date: formatters.dateTime(medication.startsOn),
                })
              : t("medications.detail.cadence.oneShotPending")}
          </p>
        </Card>
      ) : (
        <CadenceSummaryRow
          medication={snapshotToWizardPayload(medication)}
          onEdit={() => openWizardWithIntent("cadence")}
        />
      )}

      {/* §9.4 — Dose ladder / Phasen (GLP-1 only, recurring path
          only — one-shot variant drops this) */}
      {!oneShot && medication.treatmentClass === "GLP1" && (
        <>
          <DrugLevelChart
            medication={{
              id: medication.id,
              name: medication.name,
              dose: medication.dose,
            }}
          />
          <TitrationSection medicationId={id} />
        </>
      )}

      {/* §9.5 — Intake history preview */}
      <IntakeHistoryPreview
        medicationId={id}
        importOpen={importOpen}
        onImportOpenChange={setImportOpen}
      />

      {/* §9.6 + §9.7 — Notifications + Settings: recurring path only. */}
      {!oneShot && (
        <>
          <NotificationsSection
            medicationId={id}
            notificationsEnabled={medication.notificationsEnabled}
          />
          <Separator className="opacity-0" />
          <SettingsSection
            medicationId={id}
            medicationName={medication.name}
            treatmentClass={medication.treatmentClass}
            startsOn={medication.startsOn}
            endsOn={medication.endsOn}
            reminderGraceMinutes={primaryGrace}
          />
        </>
      )}

      {/* §9.8 — Verwaltung & Gefahrenzone */}
      <DestructiveZoneSection
        medicationId={id}
        medicationName={medication.name}
        active={medication.active}
        intakeCount={intakeCount}
      />

      {/* Wizard mount — edit-only on the detail page. Intent flips
          between "name" (header pencil → Step 1) and "cadence"
          (cadence row pencil → Step 5). Cancel returns to the detail
          page (the success branch refreshes the medication detail
          via the `medicationDependentKeys` cascade). */}
      <MedicationWizardDialog
        open={wizardOpen}
        onOpenChange={(open) => {
          if (!open) closeWizard();
        }}
        mode="edit"
        initial={snapshotToWizardPayload(medication)}
        landingIntent={wizardIntent}
        onSuccess={() => closeWizard()}
      />
    </div>
  );
}
