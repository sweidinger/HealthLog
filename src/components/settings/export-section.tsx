"use client";

/**
 * v1.4.16 phase B7 — Settings → Export.
 *
 * Single surface that consolidates every "give me my data out" path in
 * HealthLog. Replaces the old `<ExportCard>` inside `<AdvancedSection>`
 * (CSV/JSON/Doctor-report buttons crammed onto one row) with one card
 * per export type, each with its own filter inputs and a clear
 * "Download" / "Generate" button.
 *
 *   1. Health Record export        — hero panel at the top of the page
 *                                   (PDF + FHIR R4 + zip package, see
 *                                   `<HealthRecordExportPanel>`)
 *   2. Measurements CSV           — optional `since`/`until`
 *   3. Medications CSV            — optional intake-history toggle
 *   4. Mood CSV                   — optional `since`/`until`
 *   5. Full JSON Backup           — single-file user-scoped dump
 *   6. Doctor Report (PDF)        — small secondary card at the bottom
 *                                   (`<ArztberichtHeroCard>`)
 *
 * v1.12 — the health-record export is the headline "data out" path; it
 * takes the page hero. The doctor-report PDF is demoted to a small
 * secondary card at the bottom of the page — fully functional, just no
 * longer the flagship surface it was in v1.4.37 W7a.
 *
 * Mobile-first: cards stack on `<md`, two-column grid on `>=md`.
 */

import { useState } from "react";
import {
  Download,
  FileJson,
  FileSpreadsheet,
  FileText,
  Loader2,
  Pill,
  Waves,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { DateInput } from "@/components/ui/date-input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { ArztberichtHeroCard } from "@/components/settings/arztbericht-hero-card";
import { HealthRecordExportPanel } from "@/components/settings/health-record-export-panel";
import { useTranslations } from "@/lib/i18n/context";

type ExportFormat = "CSV" | "JSON";

/**
 * Trigger a browser download for a given URL by spinning up an anchor
 * element. Used by every CSV/JSON card so the implementation stays in
 * one place.
 */
async function downloadFromUrl(url: string, filename: string): Promise<void> {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) {
    throw new Error(`Download failed (${res.status})`);
  }
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(objectUrl);
}

export function ExportSection() {
  const { t } = useTranslations();
  return (
    <section
      aria-labelledby="settings-section-export-title"
      className="space-y-6"
    >
      <header className="space-y-1">
        <h1
          id="settings-section-export-title"
          className="text-2xl font-semibold tracking-tight"
        >
          {t("settings.sections.export.title")}
        </h1>
        <p className="text-muted-foreground text-sm">
          {t("settings.sections.export.description")}
        </p>
      </header>

      {/* v1.12 — full health-record export is now the page hero. PDF +
          FHIR R4 + a combined zip package, with grouped data-section
          toggles (collapsed by default) and a format switch. This is the
          headline "data out" path; it carries the primary visual weight. */}
      <HealthRecordExportPanel />

      {/* v1.12 — secondary export options. The four CSV/JSON
          destinations live under a dedicated sub-heading.
          Mobile: single column. Desktop (md+): 2-column grid. */}
      <section
        aria-labelledby="settings-section-export-other-title"
        className="space-y-3"
      >
        <h2
          id="settings-section-export-other-title"
          className="text-base font-semibold tracking-tight"
        >
          {t("settings.sections.export.otherOptionsHeading")}
        </h2>
        <div className="grid gap-4 md:grid-cols-2">
          <MeasurementsCsvCard />
          <MedicationsCsvCard />
          <MoodCsvCard />
          <FullBackupCard />
        </div>
      </section>

      {/* v1.12 — doctor-report PDF, demoted from the former page hero to a
          small secondary card at the bottom. Fully functional — the same
          `<DoctorReportDialog>` + `/api/doctor-report` flow runs from here. */}
      <ArztberichtHeroCard />
    </section>
  );
}

// ─────────────────────────── Card primitives ───────────────────────────

interface ExportCardShellProps {
  testId: string;
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
  format: ExportFormat;
  children?: React.ReactNode;
  /** Footer slot — typically the "Download" button + status text. */
  footer: React.ReactNode;
  /** Extra grid-position classes applied to the outer card div. */
  outerClassName?: string;
}

function ExportCardShell({
  testId,
  icon: Icon,
  title,
  description,
  format,
  children,
  footer,
  outerClassName,
}: ExportCardShellProps) {
  return (
    <div
      data-testid={testId}
      className={`bg-card border-border flex h-full flex-col rounded-xl border p-6${outerClassName ? ` ${outerClassName}` : ""}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <Icon className="text-primary h-5 w-5 shrink-0" />
          <h2 className="text-base font-semibold">{title}</h2>
        </div>
        <span className="border-border text-muted-foreground rounded-full border px-2 py-0.5 text-[11px] font-medium tracking-wide uppercase">
          {format}
        </span>
      </div>
      <p className="text-muted-foreground mt-1 text-xs">{description}</p>
      {children && <div className="mt-3 space-y-3">{children}</div>}
      <div className="mt-4 flex flex-wrap items-center gap-3">{footer}</div>
    </div>
  );
}

// ─────────────────────────── CSV cards ───────────────────────────

interface DateRangeFieldsProps {
  since: string;
  until: string;
  setSince: (v: string) => void;
  setUntil: (v: string) => void;
  idPrefix: string;
}

function DateRangeFields({
  since,
  until,
  setSince,
  setUntil,
  idPrefix,
}: DateRangeFieldsProps) {
  const { t } = useTranslations();
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-since`} className="text-xs">
          {t("settings.sections.export.filters.since")}
        </Label>
        <DateInput
          id={`${idPrefix}-since`}
          value={since}
          onChange={(e) => setSince(e.target.value)}
          max={until || undefined}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-until`} className="text-xs">
          {t("settings.sections.export.filters.until")}
        </Label>
        <DateInput
          id={`${idPrefix}-until`}
          value={until}
          onChange={(e) => setUntil(e.target.value)}
          min={since || undefined}
        />
      </div>
    </div>
  );
}

function buildQueryString(base: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(base)) {
    if (v) params.set(k, v);
  }
  const q = params.toString();
  return q ? `?${q}` : "";
}

interface CsvCardProps {
  testId: string;
  actionTestId: string;
  icon: React.ComponentType<{ className?: string }>;
  titleKey: string;
  descriptionKey: string;
  endpoint: string;
  filenamePrefix: string;
}

function CsvCard({
  testId,
  actionTestId,
  icon,
  titleKey,
  descriptionKey,
  endpoint,
  filenamePrefix,
}: CsvCardProps) {
  const { t } = useTranslations();
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDownload() {
    setBusy(true);
    setError(null);
    try {
      const query = buildQueryString({
        since: since || undefined,
        until: until || undefined,
      });
      const stamp = new Date().toISOString().slice(0, 10);
      const filename = `${filenamePrefix}-${stamp}.csv`;
      await downloadFromUrl(`${endpoint}${query}`, filename);
    } catch {
      setError(t("settings.sections.export.downloadFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ExportCardShell
      testId={testId}
      icon={icon}
      title={t(titleKey)}
      description={t(descriptionKey)}
      format="CSV"
      footer={
        <Button
          data-testid={actionTestId}
          variant="outline"
          size="sm"
          onClick={handleDownload}
          disabled={busy}
        >
          {busy ? (
            <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
          ) : (
            <Download className="mr-1 h-3.5 w-3.5" />
          )}
          {t("settings.sections.export.actions.download")}
        </Button>
      }
    >
      <DateRangeFields
        idPrefix={testId}
        since={since}
        until={until}
        setSince={setSince}
        setUntil={setUntil}
      />
      {error && (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      )}
    </ExportCardShell>
  );
}

function MeasurementsCsvCard() {
  return (
    <CsvCard
      testId="export-card-measurements-csv"
      actionTestId="export-action-measurements-csv"
      icon={FileSpreadsheet}
      titleKey="settings.sections.export.cards.measurementsCsv.title"
      descriptionKey="settings.sections.export.cards.measurementsCsv.description"
      endpoint="/api/export/measurements"
      filenamePrefix="healthlog-measurements"
    />
  );
}

function MedicationsCsvCard() {
  // The intake-history toggle is local state on this card — we read it
  // when the user clicks Download and append `&intake=true` to the URL.
  const { t } = useTranslations();
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");
  const [includeIntake, setIncludeIntake] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDownload() {
    setBusy(true);
    setError(null);
    try {
      const query = buildQueryString({
        since: since || undefined,
        until: until || undefined,
        intake: includeIntake ? "true" : "false",
      });
      const stamp = new Date().toISOString().slice(0, 10);
      await downloadFromUrl(
        `/api/export/medications${query}`,
        `healthlog-medications-${stamp}.csv`,
      );
    } catch {
      setError(t("settings.sections.export.downloadFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ExportCardShell
      testId="export-card-medications-csv"
      icon={Pill}
      title={t("settings.sections.export.cards.medicationsCsv.title")}
      description={t(
        "settings.sections.export.cards.medicationsCsv.description",
      )}
      format="CSV"
      footer={
        <Button
          data-testid="export-action-medications-csv"
          variant="outline"
          size="sm"
          onClick={handleDownload}
          disabled={busy}
        >
          {busy ? (
            <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
          ) : (
            <Download className="mr-1 h-3.5 w-3.5" />
          )}
          {t("settings.sections.export.actions.download")}
        </Button>
      }
    >
      <DateRangeFields
        idPrefix="export-medications-csv"
        since={since}
        until={until}
        setSince={setSince}
        setUntil={setUntil}
      />
      <label
        htmlFor="export-medications-include-intake"
        className="flex min-h-11 cursor-pointer items-center gap-3 text-xs"
      >
        <Switch
          id="export-medications-include-intake"
          data-testid="export-medications-include-intake"
          checked={includeIntake}
          onCheckedChange={setIncludeIntake}
        />
        <span className="text-muted-foreground">
          {t("settings.sections.export.cards.medicationsCsv.includeIntake")}
        </span>
      </label>
      {error && (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      )}
    </ExportCardShell>
  );
}

function MoodCsvCard() {
  return (
    <CsvCard
      testId="export-card-mood-csv"
      actionTestId="export-action-mood-csv"
      icon={Waves}
      titleKey="settings.sections.export.cards.moodCsv.title"
      descriptionKey="settings.sections.export.cards.moodCsv.description"
      endpoint="/api/export/mood"
      filenamePrefix="healthlog-mood"
    />
  );
}

function FullBackupCard() {
  const { t } = useTranslations();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDownload() {
    setBusy(true);
    setError(null);
    try {
      const stamp = new Date().toISOString().slice(0, 10);
      await downloadFromUrl(
        "/api/export/full-backup",
        `healthlog-backup-${stamp}.json`,
      );
    } catch {
      setError(t("settings.sections.export.downloadFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ExportCardShell
      testId="export-card-full-backup"
      icon={FileJson}
      title={t("settings.sections.export.cards.fullBackup.title")}
      description={t("settings.sections.export.cards.fullBackup.description")}
      format="JSON"
      footer={
        <Button
          data-testid="export-action-full-backup"
          variant="outline"
          size="sm"
          onClick={handleDownload}
          disabled={busy}
        >
          {busy ? (
            <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
          ) : (
            <FileText className="mr-1 h-3.5 w-3.5" />
          )}
          {t("settings.sections.export.actions.download")}
        </Button>
      }
    >
      {error && (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      )}
    </ExportCardShell>
  );
}
