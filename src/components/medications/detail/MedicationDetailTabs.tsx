"use client";

/**
 * v1.15.18 — medication detail full-page tabbed shell.
 *
 * Promotes the detail page from a read-only history view to the
 * canonical home for ONE medication. The modal `<AdvancedSettingsSheet>`
 * is dissolved into the Erweitert tab (no more five-card stack in a
 * sheet) and the separate `/history` route folds into the Verlauf tab
 * (the route now redirects to `?tab=verlauf`).
 *
 * Tab state lives in the URL (`?tab=<slug>`), so a tab is deep-linkable,
 * survives reload, and is reachable from the medications-list card kebab
 * (Edit→zeitplan, History→verlauf, Advanced→erweitert). Slugs are ASCII /
 * locale-independent; the visible labels are i18n.
 *
 * Only the active tab body mounts (Radix `Tabs` default) so inactive tabs
 * do not fetch. The hero stays above the tabs as the always-visible
 * read-only summary plus the "Vollständig bearbeiten" jump into the
 * creation/edit wizard (the structural-edit tool — name / class /
 * cadence kind / schedules). Everyday levers (reminders, supply, history)
 * live inline in the tabs.
 *
 * Verlauf renders the existing editable intake history and Zeitplan the
 * read-only cadence summary for now — the dose-history ledger and the
 * per-dose window editor land in the next wave. Injektion is gated to
 * injectable routes of administration.
 */

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, Pencil } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MedicationDetailSummary } from "@/components/medications/medication-detail-summary";
import { MedicationDetailSection } from "@/components/medications/medication-detail-section";
import { MedicationComplianceBars } from "@/components/medications/card-parts/medication-compliance-bars";
import { DoseHistoryLedger } from "@/components/medications/dose-history-ledger";
import { ScheduleTimesEditor } from "@/components/medications/scheduling/ScheduleTimesEditor";
import type { DoseWindowEntry } from "@/components/medications/scheduling/dose-window";
import { IntakeImportDialog } from "@/components/medications/intake-import-dialog";
import { InventorySection } from "@/components/medications/sections/inventory-section";
import { NotificationsBody } from "@/components/medications/sections/notifications-section";
import {
  DrugCodingRow,
  GraceRow,
  PhasesRow,
} from "@/components/medications/sections/settings-section";
import { ApiTokensRow } from "@/components/medications/sections/api-tokens-row";
import { DataPortabilityRow } from "@/components/medications/sections/data-portability-row";
import {
  DangerZoneBody,
  LifecycleManageBody,
} from "@/components/medications/sections/destructive-zone-section";
import { SettingsGroup } from "@/components/medications/settings-group";
import { PhaseConfigSheet } from "@/components/medications/sections/phase-config-sheet";
import { DrugLevelChart } from "@/components/medications/DrugLevelChart";
import { DoseStrengthCurve } from "@/components/medications/dose-strength-curve";
import { SideEffectsSection } from "@/components/medications/SideEffectsSection";
import { MedicationWizardDialog } from "@/components/medications/wizard/MedicationWizardDialog";
import {
  parseScheduleRecurrence,
} from "@/lib/medication-schedule";
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import { useTranslations } from "@/lib/i18n/context";
import type { MedicationPayload } from "@/components/medications/wizard/wizard-payload";
import type { ComplianceDisplay } from "@/lib/analytics/compliance";

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
  scheduleType?: string | null;
  cyclicOnWeeks?: number | null;
  cyclicOffWeeks?: number | null;
  // v1.15.18 — per-dose on-time windows; the GET returns the raw Json
  // column, the Zeitplan inline editor round-trips it on save.
  doseWindows?: DoseWindowEntry[] | null;
}

export interface MedicationDetailSnapshot {
  id: string;
  name: string;
  dose: string;
  category: string;
  treatmentClass?: string;
  deliveryForm?: string;
  dosesPerUnit?: number | null;
  trackInjectionSites?: boolean;
  allowedInjectionSites?: string[];
  active: boolean;
  notificationsEnabled: boolean;
  pausedAt: string | null;
  startsOn?: string | null;
  endsOn?: string | null;
  oneShot?: boolean;
  atcCode?: string | null;
  rxNormCode?: string | null;
  schedules: ScheduleSnapshot[];
}

// Slugs are ASCII / locale-independent so the URL stays stable across
// locales; the visible labels resolve through i18n. The list drives both
// the tab strip render and the `?tab=` round-trip validation.
const TAB_SLUGS = [
  "uebersicht",
  "zeitplan",
  "erinnerung",
  "bestand",
  "verlauf",
  "injektion",
  "erweitert",
] as const;
type TabSlug = (typeof TAB_SLUGS)[number];

function snapshotToWizardPayload(
  med: MedicationDetailSnapshot,
): MedicationPayload {
  return {
    id: med.id,
    name: med.name,
    dose: med.dose,
    category: med.category,
    treatmentClass: med.treatmentClass,
    deliveryForm: med.deliveryForm,
    dosesPerUnit: med.dosesPerUnit ?? null,
    trackInjectionSites: med.trackInjectionSites ?? false,
    allowedInjectionSites: med.allowedInjectionSites ?? [],
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
      doseWindows: s.doseWindows ?? null,
    })),
  };
}

export function MedicationDetailTabs({
  medication,
}: {
  medication: MedicationDetailSnapshot;
}) {
  const { t } = useTranslations();
  const router = useRouter();
  const searchParams = useSearchParams();

  const [editOpen, setEditOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [phaseSheetOpen, setPhaseSheetOpen] = useState(false);

  const id = medication.id;
  const oneShot = medication.oneShot === true;
  const isGlp1 = !oneShot && medication.treatmentClass === "GLP1";
  const isInjectable = medication.deliveryForm === "INJECTION";

  const payload = useMemo(
    () => snapshotToWizardPayload(medication),
    [medication],
  );

  // Only the active tab body mounts, but the tab REGISTRY must agree with
  // whatever `?tab=` carries — Injektion is absent for non-injectable
  // medications, so a stale `?tab=injektion` deep-link falls back to the
  // landing tab instead of rendering an empty surface.
  const availableTabs = useMemo<TabSlug[]>(
    () =>
      TAB_SLUGS.filter((slug) => slug !== "injektion" || isInjectable),
    [isInjectable],
  );

  const requested = searchParams?.get("tab") as TabSlug | null;
  const activeTab: TabSlug =
    requested && availableTabs.includes(requested) ? requested : "uebersicht";

  const onTabChange = useCallback(
    (next: string) => {
      const params = new URLSearchParams(
        Array.from(searchParams?.entries() ?? []),
      );
      params.set("tab", next);
      // Shallow URL swap so the tab is deep-linkable + survives reload
      // without a full navigation. `scroll: false` keeps the viewport
      // pinned to the tab strip on switch.
      router.replace(`/medications/${id}?${params.toString()}`, {
        scroll: false,
      });
    },
    [id, router, searchParams],
  );

  const { data: compliance } = useQuery({
    queryKey: queryKeys.medicationCompliance(id),
    queryFn: async () => {
      const res = await fetch(`/api/medications/${id}/compliance`);
      if (!res.ok) return null;
      return (await res.json()).data as {
        compliance7?: { rate: number; streak: number };
        compliance30?: { rate: number };
        complianceDisplay?: ComplianceDisplay;
      };
    },
    enabled: activeTab === "uebersicht",
    staleTime: 30_000,
  });

  const display = compliance?.complianceDisplay;
  const rate7 = display?.short.rate ?? compliance?.compliance7?.rate ?? 0;
  const rate30 = display?.long.rate ?? compliance?.compliance30?.rate ?? 0;
  const streak = display?.short.streak ?? compliance?.compliance7?.streak ?? 0;
  const shortDays = display?.shortDays ?? 7;
  const longDays = display?.longDays ?? 30;

  return (
    <div className="space-y-6" data-slot="medication-detail-page">
      <Button variant="ghost" size="sm" className="-ml-2 w-fit" asChild>
        <Link href="/medications">
          <ArrowLeft aria-hidden="true" className="mr-1 size-4" />
          {t("medications.back")}
        </Link>
      </Button>

      {/* HERO — always-visible read-only summary + the structural-edit
          jump into the wizard. Everyday levers live in the tabs below. */}
      <div className="flex items-start justify-between gap-3">
        <MedicationDetailSummary
          name={medication.name}
          dose={medication.dose}
          active={medication.active}
          endsOn={medication.endsOn}
          payload={payload}
          oneShot={oneShot}
          startsOn={medication.startsOn}
        />
        <Button
          variant="outline"
          size="sm"
          onClick={() => setEditOpen(true)}
          className="min-h-11 shrink-0 sm:min-h-9"
          data-slot="medication-detail-full-edit"
        >
          <Pencil aria-hidden="true" className="h-4 w-4" />
          <span className="hidden sm:inline">
            {t("medications.detail.shell.fullEdit")}
          </span>
        </Button>
      </div>

      <Tabs
        value={activeTab}
        onValueChange={onTabChange}
        data-slot="medication-detail-tabs"
      >
        <TabsList
          className="w-full justify-start"
          aria-label={t("medications.detail.shell.tablistLabel")}
        >
          {availableTabs.map((slug) => (
            <TabsTrigger
              key={slug}
              value={slug}
              data-slot={`medication-tab-${slug}`}
            >
              {t(`medications.detail.tabs.${slug}`)}
            </TabsTrigger>
          ))}
        </TabsList>

        {/* ÜBERSICHT — landing read view: summary echo + compliance. */}
        <TabsContent value="uebersicht" className="space-y-6 pt-2">
          <MedicationDetailSection
            titleId="medication-uebersicht-compliance-heading"
            title={t("medications.detail.uebersicht.complianceTitle")}
            dataSlot="medication-uebersicht-compliance"
          >
            {compliance ? (
              <MedicationComplianceBars
                rate7={rate7}
                rate30={rate30}
                streak={streak}
                shortDays={shortDays}
                longDays={longDays}
              />
            ) : (
              <p className="text-muted-foreground text-sm">
                {t("medications.detail.uebersicht.complianceEmpty")}
              </p>
            )}
          </MedicationDetailSection>
        </TabsContent>

        {/* ZEITPLAN — inline edit of the everyday levers: dose times +
            each dose's on-time window. Cadence-kind stays structural
            (the hero's "Vollständig bearbeiten"); grace is a read-only
            echo here, owned by the Erinnerung tab. */}
        <TabsContent value="zeitplan" className="space-y-6 pt-2">
          <MedicationDetailSummary
            name={medication.name}
            dose={medication.dose}
            active={medication.active}
            endsOn={medication.endsOn}
            payload={payload}
            oneShot={oneShot}
            startsOn={medication.startsOn}
          />
          {medication.schedules.length > 0 ? (
            <MedicationDetailSection
              titleId="medication-zeitplan-times-heading"
              title={t("medications.detail.zeitplan.title")}
              dataSlot="medication-zeitplan-section"
            >
              <ScheduleTimesEditor
                medicationId={id}
                schedules={medication.schedules.map((s) => ({
                  id: s.id,
                  windowStart: s.windowStart,
                  windowEnd: s.windowEnd,
                  label: s.label,
                  dose: s.dose,
                  daysOfWeek: s.daysOfWeek,
                  timesOfDay: s.timesOfDay,
                  rrule: s.rrule,
                  rollingIntervalDays: s.rollingIntervalDays,
                  reminderGraceMinutes: s.reminderGraceMinutes,
                  scheduleType: s.scheduleType,
                  cyclicOnWeeks: s.cyclicOnWeeks,
                  cyclicOffWeeks: s.cyclicOffWeeks,
                  doseWindows: s.doseWindows,
                }))}
                onRequestReminderTab={() => onTabChange("erinnerung")}
              />
            </MedicationDetailSection>
          ) : null}
        </TabsContent>

        {/* ERINNERUNG — notifications switch + reminder grace (the single
            owner of `reminderGraceMinutes`). */}
        <TabsContent value="erinnerung" className="space-y-4 pt-2">
          <SettingsGroup
            label={t("medications.detail.advanced.group.reminders")}
            dataSlot="erinnerung-group"
          >
            <div className="py-3">
              <NotificationsBody
                medicationId={id}
                notificationsEnabled={medication.notificationsEnabled}
              />
            </div>
            <div className="py-3">
              <GraceRow
                medicationId={id}
                reminderGraceMinutes={
                  medication.schedules[0]?.reminderGraceMinutes ?? null
                }
              />
            </div>
          </SettingsGroup>
        </TabsContent>

        {/* BESTAND — inventory readout for all meds. */}
        <TabsContent value="bestand" className="space-y-4 pt-2">
          <InventorySection medicationId={id} />
        </TabsContent>

        {/* VERLAUF — the dose-history ledger: every expected slot with its
            status + ad-hoc takes tagged, inline Genommen/Übersprungen with
            instant optimistic recompute, edit/add (incl. the late-take "diesem
            Slot zuordnen?" nudge). CSV import rides the header ghost. */}
        <TabsContent value="verlauf" className="space-y-6 pt-2">
          <MedicationDetailSection
            titleId="medication-verlauf-heading"
            title={t("medications.detail.intake.title")}
            dataSlot="medication-verlauf-section"
            headerExtras={
              <Button
                variant="outline"
                size="sm"
                onClick={() => setImportOpen(true)}
                className="min-h-11 sm:min-h-9"
                data-slot="verlauf-import"
              >
                {t("medications.detail.intake.importButton")}
              </Button>
            }
          >
            <DoseHistoryLedger
              medicationId={id}
              medicationName={medication.name}
              schedules={medication.schedules.map((s) => ({
                windowStart: s.windowStart,
                label: s.label,
                dose: s.dose,
                timesOfDay: s.timesOfDay,
              }))}
            />
          </MedicationDetailSection>

          {importOpen && (
            <IntakeImportDialog
              medicationId={id}
              onClose={() => setImportOpen(false)}
            />
          )}
        </TabsContent>

        {/* INJEKTION — injectable routes only. Current GLP-1 charts +
            side-effect log; the body-map + adherence detail land next
            wave. */}
        {isInjectable && (
          <TabsContent value="injektion" className="space-y-6 pt-2">
            {isGlp1 && <SideEffectsSection medicationId={id} />}
            {isGlp1 && (
              <div
                className="space-y-6"
                data-slot="injektion-drug-level-section"
              >
                <DrugLevelChart
                  medication={{
                    id: medication.id,
                    name: medication.name,
                    dose: medication.dose,
                  }}
                />
                <DoseStrengthCurve medicationId={id} />
              </div>
            )}
            {!isGlp1 && (
              <DoseStrengthCurve medicationId={id} />
            )}
          </TabsContent>
        )}

        {/* ERWEITERT — the dissolved advanced-settings sheet, now grouped
            un-stacked: Lifecycle → Externe API → Daten → Gefahrenzone. */}
        <TabsContent value="erweitert" className="space-y-4 pt-2">
          <SettingsGroup
            label={t("medications.detail.erweitert.group.lifecycle")}
            dataSlot="erweitert-group-lifecycle"
          >
            <div className="py-3">
              <LifecycleManageBody
                medicationId={id}
                medicationName={medication.name}
                active={medication.active}
              />
            </div>
            {isGlp1 && (
              <div className="py-3">
                <PhasesRow
                  medicationId={id}
                  treatmentClass={medication.treatmentClass}
                  startsOn={medication.startsOn}
                  endsOn={medication.endsOn}
                  onRequestPhaseSheet={() => setPhaseSheetOpen(true)}
                />
              </div>
            )}
          </SettingsGroup>

          <SettingsGroup
            label={t("medications.detail.erweitert.group.externalApi")}
            dataSlot="erweitert-group-external-api"
          >
            <div className="py-3">
              <ApiTokensRow
                medicationId={id}
                medicationName={medication.name}
              />
            </div>
            <div className="py-3">
              <DrugCodingRow
                medicationId={id}
                atcCode={medication.atcCode}
                rxNormCode={medication.rxNormCode}
              />
            </div>
          </SettingsGroup>

          <SettingsGroup
            label={t("medications.detail.erweitert.group.data")}
            dataSlot="erweitert-group-data"
          >
            <div className="py-3">
              <DataPortabilityRow
                medicationId={id}
                onOpenImport={() => setImportOpen(true)}
              />
            </div>
          </SettingsGroup>

          <ComplianceGatedDangerZone
            medicationId={id}
            medicationName={medication.name}
          />

          {importOpen && (
            <IntakeImportDialog
              medicationId={id}
              onClose={() => setImportOpen(false)}
            />
          )}
        </TabsContent>
      </Tabs>

      {/* Structural edit — the wizard stays the name / class / cadence-kind
          / schedule tool. Hydrates from the medication payload in edit
          mode; closing it leaves the user on the same tab. */}
      <MedicationWizardDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        mode="edit"
        initial={payload}
        onSuccess={() => setEditOpen(false)}
      />

      {/* GLP-1 phase/titration editor — sibling-swapped from the Lifecycle
          group so the modal stack never exceeds the tab + one sheet. */}
      {isGlp1 && (
        <PhaseConfigSheet
          medicationId={id}
          open={phaseSheetOpen}
          onOpenChange={setPhaseSheetOpen}
        />
      )}
    </div>
  );
}

/**
 * The danger zone's purge gate needs `intakeCount`. Fetch it lazily here
 * (the Erweitert tab pays for it; the other tabs never do) rather than
 * threading a count the page doesn't otherwise need.
 */
function ComplianceGatedDangerZone({
  medicationId,
  medicationName,
}: {
  medicationId: string;
  medicationName: string;
}) {
  const params = {
    sortBy: "takenAt",
    sortDir: "desc" as const,
    limit: 1,
    offset: 0,
    status: "completed",
  };
  const { data: intakeCount } = useQuery({
    queryKey: queryKeys.medicationIntakeList(medicationId, params),
    queryFn: async () => {
      const search = new URLSearchParams({
        sortBy: params.sortBy,
        sortDir: params.sortDir,
        limit: String(params.limit),
        offset: String(params.offset),
        status: params.status,
      });
      const res = await fetch(
        `/api/medications/${medicationId}/intake?${search.toString()}`,
      );
      if (!res.ok) return 0;
      const json = await res.json();
      return (json.data?.meta?.total ?? 0) as number;
    },
    staleTime: 30_000,
  });

  const { t } = useTranslations();

  return (
    <SettingsGroup
      label={t("medications.detail.erweitert.group.danger")}
      dataSlot="erweitert-group-danger"
      className="border-destructive/40 bg-destructive/5"
    >
      <div className="py-3">
        <DangerZoneBody
          medicationId={medicationId}
          medicationName={medicationName}
          intakeCount={intakeCount ?? 0}
        />
      </div>
    </SettingsGroup>
  );
}
