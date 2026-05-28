"use client";

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/hooks/use-auth";
import { useTranslations } from "@/lib/i18n/context";
import {
  invalidateKeys,
  medicationDependentKeys,
  queryKeys,
} from "@/lib/query-keys";
import { parseScheduleRecurrence } from "@/lib/medication-schedule";
import { MedicationWizardDialog } from "@/components/medications/wizard/MedicationWizardDialog";
import type { MedicationPayload } from "@/components/medications/wizard/wizard-payload";
import { MedicationCard } from "@/components/medications/medication-card";
import { Glp1MedicationCard } from "@/components/medications/glp1-medication-card";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  MoreHorizontal,
  Loader2,
  Plus,
  Pill,
  Upload,
  Copy,
  RefreshCw,
  RotateCcw,
} from "lucide-react";

interface Schedule {
  id: string;
  windowStart: string;
  windowEnd: string;
  label: string | null;
  dose: string | null;
  daysOfWeek: string | null;
  /** v1.5 — first-class times-of-day. */
  timesOfDay?: string[];
  /** v1.5 — RFC 5545 RRULE string for calendar-anchored cadences. */
  rrule?: string | null;
  /** v1.5 — flexible-rolling interval in days. */
  rollingIntervalDays?: number | null;
  /** v1.5 — reminder grace window in minutes. */
  reminderGraceMinutes?: number | null;
}

interface Medication {
  id: string;
  name: string;
  dose: string;
  category: string;
  /** v1.4.25 W4d — Prisma treatment class (GENERIC | GLP1). */
  treatmentClass?: string;
  /** v1.4.25 W4d — doses per pen/vial for inventory math. */
  dosesPerUnit?: number | null;
  active: boolean;
  notificationsEnabled: boolean;
  pausedAt: string | null;
  lastTakenAt: string | null;
  /** v1.5 — medication-level course start date (ISO string). */
  startsOn?: string | null;
  /** v1.5 — medication-level course end date (ISO string). */
  endsOn?: string | null;
  /** v1.5 — single-administration medication. */
  oneShot?: boolean;
  schedules: Schedule[];
}

export default function MedicationsPage() {
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const { t } = useTranslations();
  const router = useRouter();
  const searchParams = useSearchParams();
  // v1.5.4 — the retired `/medications/new` route redirects here with
  // `?new=1`, so legacy bookmarks keep landing on the create wizard.
  // The initial open state reads the query param synchronously so the
  // dialog opens on the very first render; a follow-up effect strips
  // the param from the URL so a manual close + refresh stays closed.
  const shouldOpenFromUrl = searchParams?.get("new") === "1";
  const [dialogOpen, setDialogOpen] = useState(shouldOpenFromUrl);
  const [editingMed, setEditingMed] = useState<Medication | null>(null);
  const [importMedId, setImportMedId] = useState<string | null>(null);
  const [apiMed, setApiMed] = useState<{
    id: string;
    name: string;
  } | null>(null);

  useEffect(() => {
    if (shouldOpenFromUrl) {
      // Drop the query param so a refresh after closing the dialog
      // doesn't keep reopening it.
      router.replace("/medications");
    }
  }, [shouldOpenFromUrl, router]);

  const {
    data: medications,
    isLoading,
    isError,
    refetch: refetchMedications,
  } = useQuery({
    queryKey: queryKeys.medications(),
    queryFn: async () => {
      const res = await fetch("/api/medications");
      if (!res.ok) throw new Error("Failed to fetch");
      const json = await res.json();
      return json.data as Medication[];
    },
    enabled: isAuthenticated,
  });

  function openCreate() {
    setEditingMed(null);
    setDialogOpen(true);
  }

  function openEdit(med: Medication) {
    setEditingMed(med);
    setDialogOpen(true);
  }

  function closeDialog() {
    setDialogOpen(false);
    setEditingMed(null);
  }

  if (authLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="text-primary h-6 w-6 animate-spin motion-reduce:animate-none" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="space-y-6">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight">
            {t("medications.title")}
          </h1>
          <p className="text-muted-foreground text-sm">
            {t("medications.loginRequired")}
          </p>
        </div>
      </div>
    );
  }

  const byName = (a: Medication, b: Medication) =>
    a.name.localeCompare(b.name, "de", { sensitivity: "base" });

  // Defensive against stale service-worker responses or any future API
  // shape change: only filter when we actually have an array.
  const medsArray = Array.isArray(medications) ? medications : [];
  const activeMeds = medsArray.filter((m) => m.active).sort(byName);
  const inactiveMeds = medsArray.filter((m) => !m.active).sort(byName);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight">
            {t("medications.title")}
          </h1>
          {/* v1.4.34 IW-G — subtitle stays visible on mobile so the
              H1 isn't an unframed label. */}
          <p className="text-muted-foreground text-xs sm:text-sm">
            {t("medications.subtitle")}
          </p>
        </div>
        <Button onClick={openCreate}>
          <Plus className="mr-2 h-4 w-4" />
          {t("medications.addMedication")}
        </Button>
      </div>

      {isLoading ? (
        <div className="flex h-32 items-center justify-center">
          <Loader2 className="text-primary h-6 w-6 animate-spin motion-reduce:animate-none" />
        </div>
      ) : isError ? (
        <div className="bg-card border-border flex h-64 items-center justify-center rounded-xl border">
          <div className="flex flex-col items-center gap-3">
            <p className="text-muted-foreground text-sm">
              {t("medications.loadFailed")}
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void refetchMedications()}
            >
              {t("medications.retryLoad")}
            </Button>
          </div>
        </div>
      ) : !medications?.length ? (
        // v1.4.15 phase-C5: refactor the inline icon+text+button block
        // to the shared EmptyState primitive so the empty path matches
        // every other list page in the app (role=status, dashed
        // border, consistent icon-bubble + spacing).
        <EmptyState
          icon={<Pill className="size-6" />}
          title={t("medications.emptyTitle")}
          description={t("medications.emptyDescription")}
          action={
            <Button size="sm" onClick={openCreate}>
              <Plus className="mr-1 h-4 w-4" />
              {t("medications.firstMedication")}
            </Button>
          }
        />
      ) : (
        <div className="space-y-6">
          {/* Active medications */}
          {activeMeds.length > 0 && (
            <div className="space-y-3.5">
              <div className="grid gap-4 sm:grid-cols-2">
                {activeMeds.map((med) =>
                  med.treatmentClass === "GLP1" ? (
                    <Glp1MedicationCard
                      key={med.id}
                      medication={med}
                      onEdit={openEdit}
                    />
                  ) : (
                    <MedicationCard
                      key={med.id}
                      medication={med}
                      onEdit={openEdit}
                    />
                  ),
                )}
              </div>
            </div>
          )}

          {/* Inactive medications */}
          {inactiveMeds.length > 0 && (
            <div className="space-y-3.5">
              <h2 className="text-muted-foreground text-sm font-medium">
                {t("common.inactive")} ({inactiveMeds.length})
              </h2>
              <div className="grid gap-4 sm:grid-cols-2">
                {inactiveMeds.map((med) =>
                  med.treatmentClass === "GLP1" ? (
                    <Glp1MedicationCard
                      key={med.id}
                      medication={med}
                      onEdit={openEdit}
                    />
                  ) : (
                    <MedicationCard
                      key={med.id}
                      medication={med}
                      onEdit={openEdit}
                    />
                  ),
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* API Endpoint Dialog */}
      <ApiEndpointDialog medication={apiMed} onClose={() => setApiMed(null)} />

      {/* Import Dialog */}
      <IntakeImportDialog
        medicationId={importMedId}
        onClose={() => setImportMedId(null)}
      />

      {/* v1.5.4 — modal-wizard mount. The same component drives both
          create (no initial) and edit (hydrates from the medication's
          payload). The wizard owns its own ResponsiveSheet shell with
          the dialog/sheet split and the sticky footer. */}
      <MedicationWizardDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        mode={editingMed ? "edit" : "create"}
        initial={editingMed ? medicationToPayload(editingMed) : undefined}
        onSuccess={closeDialog}
      />
    </div>
  );
}

/**
 * Map a `Medication` row from `GET /api/medications` onto the
 * `MedicationPayload` shape the wizard's edit-path hydrator consumes.
 * Mirrors the schedule pass-through the v1.5.3 flat form relied on so
 * legacy cadences round-trip through the bridge cleanly.
 */
function medicationToPayload(med: Medication): MedicationPayload {
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

function IntakeImportDialog({
  medicationId,
  onClose,
}: {
  medicationId: string | null;
  onClose: () => void;
}) {
  const { t } = useTranslations();
  const [jsonText, setJsonText] = useState("");
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [resultType, setResultType] = useState<"success" | "error" | null>(
    null,
  );
  const [selectedFileName, setSelectedFileName] = useState<string | null>(null);
  const [fileInputKey, setFileInputKey] = useState(0);
  const queryClient = useQueryClient();

  function resetImportForm() {
    setJsonText("");
    setResult(null);
    setResultType(null);
    setSelectedFileName(null);
    setFileInputKey((prev) => prev + 1);
  }

  function handleClose() {
    resetImportForm();
    onClose();
  }

  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setResult(null);
    setResultType(null);

    try {
      const content = await file.text();
      JSON.parse(content);
      setJsonText(content);
      setSelectedFileName(file.name);
      setResult(t("medications.importFileLoaded", { name: file.name }));
      setResultType("success");
    } catch {
      setResult(t("medications.importInvalidJson"));
      setResultType("error");
    }
  }

  async function handleImport() {
    if (!medicationId || !jsonText.trim()) return;
    setImporting(true);
    setResult(null);
    setResultType(null);

    try {
      let data = JSON.parse(jsonText.trim());
      // Support both array and object-with-array
      if (!Array.isArray(data)) {
        const arrKey = Object.keys(data).find((k) => Array.isArray(data[k]));
        if (arrKey) data = data[arrKey];
        else throw new Error(t("medications.importNoArray"));
      }

      const res = await fetch(
        `/api/medications/${medicationId}/intake/import`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        },
      );

      const json = await res.json();
      if (res.ok) {
        const d = json.data;
        setResult(
          t("medications.importResult", { imported: d.imported }) +
            (d.skippedDuplicates > 0
              ? `, ${t("medications.importDuplicatesSkipped", { count: d.skippedDuplicates })}`
              : "") +
            (d.skippedInvalid > 0
              ? `, ${t("medications.importInvalidSkipped", { count: d.skippedInvalid })}`
              : ""),
        );
        setResultType("success");
        void invalidateKeys(queryClient, medicationDependentKeys);
      } else {
        setResult(json.error || t("medications.importFailed"));
        setResultType("error");
      }
    } catch (err) {
      setResult(
        err instanceof SyntaxError
          ? t("medications.importInvalidFormat")
          : (err as Error).message || t("medications.importFailed"),
      );
      setResultType("error");
    } finally {
      setImporting(false);
    }
  }

  return (
    <Dialog open={!!medicationId} onOpenChange={() => handleClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("medications.importIntakes")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <p className="text-muted-foreground text-sm">
            {t("medications.importDescription")}
          </p>
          <div className="space-y-1.5">
            <Label htmlFor="intake-import-file" className="text-xs font-medium">
              {t("medications.importUploadFile")}
            </Label>
            <input
              key={fileInputKey}
              id="intake-import-file"
              type="file"
              accept="application/json,.json"
              onChange={handleFileSelect}
              className="border-input bg-background text-foreground file:bg-muted file:text-foreground w-full cursor-pointer rounded-md border text-sm file:mr-2 file:border-0 file:px-3 file:py-2"
            />
            {selectedFileName && (
              <p className="text-muted-foreground text-xs">
                {t("medications.importSelected", { name: selectedFileName })}
              </p>
            )}
          </div>
          <pre className="bg-muted text-muted-foreground rounded-lg p-3 text-xs">
            {`[
  {"datum": "2026-02-14", "uhrzeit": "10:27:43", "zaehler": 523},
  {"datum": "2026-02-14", "uhrzeit": "23:33:42", "zaehler": 524}
]`}
          </pre>
          <Textarea
            value={jsonText}
            onChange={(e) => setJsonText(e.target.value)}
            placeholder={t("medications.importPaste")}
            rows={8}
            // JSON paste — disable sentence-case and spell-check so the
            // primitive defaults don't munge structured input.
            autoCapitalize="none"
            spellCheck={false}
            className="font-mono"
          />
          {result && (
            <p
              className={`text-sm ${resultType === "success" ? "text-dracula-green" : "text-destructive"}`}
            >
              {result}
            </p>
          )}
          <div className="flex items-center justify-between gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="h-9 w-9"
                  disabled={importing}
                  aria-label={t("common.moreOptions")}
                >
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuItem onClick={resetImportForm}>
                  <RotateCcw className="mr-2 h-4 w-4" />
                  {t("common.reset")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                onClick={handleClose}
                disabled={importing}
              >
                {t("common.cancel")}
              </Button>
              <Button
                onClick={handleImport}
                disabled={importing || !jsonText.trim()}
                aria-busy={importing || undefined}
              >
                {/*
                  v1.4.33 IW9 — icon swap (not append) on `importing`
                  to keep the button width stable through the
                  in-flight request. Pre-v1.4.33 both icons painted
                  during loading and the button grew by ~24 px, which
                  showed up as a CLS hit on the medications import
                  dialog.
                */}
                {importing ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" />
                ) : (
                  <Upload className="mr-2 h-4 w-4" />
                )}
                {t("common.import")}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ApiEndpointDialog({
  medication,
  onClose,
}: {
  medication: { id: string; name: string } | null;
  onClose: () => void;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  type ExampleType = "curl" | "wget" | "fetch" | "powershell";

  const apiEndpointKey = ["medication-api-endpoint", medication?.id];

  type ApiEndpointStatus = { enabled: boolean; activeTokenCount: number };

  const {
    data: status,
    isFetching: loadingStatus,
    refetch: refetchStatus,
    error: statusError,
  } = useQuery<ApiEndpointStatus>({
    queryKey: apiEndpointKey,
    queryFn: async () => {
      const res = await fetch(
        `/api/medications/${medication!.id}/api-endpoint`,
      );
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error || t("medications.statusLoadFailed"));
      }
      return {
        enabled: json.data.enabled === true,
        activeTokenCount: json.data.activeTokenCount ?? 0,
      };
    },
    enabled: !!medication,
    staleTime: 0,
    gcTime: 0,
  });

  const enabled = status?.enabled ?? false;
  const activeTokenCount = status?.activeTokenCount ?? 0;

  const [token, setToken] = useState<string | null>(null);
  const [toggling, setToggling] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [exampleType, setExampleType] = useState<ExampleType>("curl");

  const displayMsg =
    msg ?? (statusError instanceof Error ? statusError.message : null);

  function handleClose() {
    queryClient.removeQueries({ queryKey: apiEndpointKey });
    setToken(null);
    setMsg(null);
    setCopied(null);
    setExampleType("curl");
    onClose();
  }

  async function toggleEndpoint(nextEnabled: boolean) {
    if (!medication) return;
    setToggling(true);
    setToken(null);
    setMsg(null);
    try {
      const res = await fetch(
        `/api/medications/${medication.id}/api-endpoint`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: nextEnabled }),
        },
      );
      const json = await res.json();
      if (!res.ok) {
        setMsg(json.error || t("medications.changeFailed"));
        return;
      }

      const nextStatus: ApiEndpointStatus = {
        enabled: json.data.enabled === true,
        activeTokenCount:
          typeof json.data.activeTokenCount === "number"
            ? json.data.activeTokenCount
            : !json.data.enabled
              ? 0
              : (status?.activeTokenCount ?? 0),
      };
      queryClient.setQueryData<ApiEndpointStatus>(apiEndpointKey, nextStatus);

      if (json.data.token) {
        setToken(json.data.token);
      }

      setMsg(
        nextEnabled
          ? t("medications.apiEndpointActivated")
          : t("medications.apiEndpointDeactivated"),
      );
    } catch {
      setMsg(t("medications.changeFailed"));
    } finally {
      setToggling(false);
    }
  }

  async function copyText(text: string, key: string) {
    await navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(null), 2000);
  }

  const baseUrl =
    typeof window !== "undefined" ? window.location.origin : "https://...";
  const endpoint = `${baseUrl}/api/ingest/medication`;
  const payload = `{"medicationName":"${medication?.name ?? ""}","idempotencyKey":"einnahme-202602191230"}`;
  const curlCmd = `curl -X POST ${endpoint} \\
  -H "Authorization: Bearer ${token ?? "DEIN_TOKEN"}" \\
  -H "Content-Type: application/json" \\
  -d '${payload}'`;
  const wgetCmd = `wget --method=POST "${endpoint}" \\
  --header="Authorization: Bearer ${token ?? "DEIN_TOKEN"}" \\
  --header="Content-Type: application/json" \\
  --body-data='${payload}' \\
  -O -`;
  const fetchCmd = `await fetch("${endpoint}", {
  method: "POST",
  headers: {
    "Authorization": "Bearer ${token ?? "DEIN_TOKEN"}",
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    medicationName: "${medication?.name ?? ""}",
    idempotencyKey: "einnahme-" + Date.now()
  })
});`;
  const powershellCmd = `Invoke-RestMethod -Method Post -Uri "${endpoint}" \\
  -Headers @{ Authorization = "Bearer ${token ?? "DEIN_TOKEN"}" } \\
  -ContentType "application/json" \\
  -Body '${payload}'`;

  const exampleMap: Record<ExampleType, { label: string; value: string }> = {
    curl: { label: "cURL", value: curlCmd },
    wget: { label: "wget", value: wgetCmd },
    fetch: { label: "JavaScript fetch", value: fetchCmd },
    powershell: { label: "PowerShell", value: powershellCmd },
  };
  const selectedExample = exampleMap[exampleType];

  return (
    <Dialog open={!!medication} onOpenChange={() => handleClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {t("medications.apiEndpointTitle", {
              name: medication?.name ?? "",
            })}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <p className="text-muted-foreground text-sm">
            {t("medications.apiEndpointDescription")}
          </p>

          <div className="bg-muted/40 rounded-lg border p-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium">
                  {t("medications.apiEndpointActive")}
                </p>
                <p className="text-muted-foreground text-xs">
                  {enabled
                    ? t("medications.apiTokenCount", {
                        count: activeTokenCount,
                      })
                    : t("common.disabled")}
                </p>
              </div>
              <Switch
                checked={enabled}
                disabled={loadingStatus || toggling}
                onCheckedChange={(checked) => {
                  void toggleEndpoint(checked);
                }}
              />
            </div>
          </div>

          {/* Endpoint URL */}
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Endpoint</Label>
            <div className="flex items-center gap-2">
              <code className="bg-muted flex-1 rounded px-3 py-2 font-mono text-xs break-all">
                POST {endpoint}
              </code>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0"
                onClick={() => copyText(endpoint, "url")}
                aria-label={t("common.copy")}
              >
                <Copy className="h-3.5 w-3.5" />
              </Button>
            </div>
            {copied === "url" && (
              <p className="text-dracula-green text-xs">{t("common.copied")}</p>
            )}
          </div>

          {/* Token */}
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">
              {t("medications.apiToken")}
            </Label>
            {token ? (
              <div className="flex items-center gap-2">
                <code className="bg-muted flex-1 rounded px-3 py-2 font-mono text-xs break-all">
                  {token}
                </code>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 shrink-0"
                  onClick={() => copyText(token, "token")}
                  aria-label={t("common.copy")}
                >
                  <Copy className="h-3.5 w-3.5" />
                </Button>
              </div>
            ) : (
              <p className="text-muted-foreground text-xs">
                {enabled
                  ? t("medications.apiTokenActiveHint")
                  : t("medications.apiTokenActivateHint")}
              </p>
            )}
            {token && (
              <p className="text-muted-foreground text-xs">
                {t("medications.apiTokenOnceHint")}
              </p>
            )}
            {copied === "token" && (
              <p className="text-dracula-green text-xs">{t("common.copied")}</p>
            )}
          </div>

          {/* request examples */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <Label className="text-xs font-medium">
                {t("medications.requestExample")}
              </Label>
              <Select
                value={exampleType}
                onValueChange={(value) => setExampleType(value as ExampleType)}
              >
                <SelectTrigger size="sm" className="w-[170px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="end">
                  <SelectItem value="curl">cURL</SelectItem>
                  <SelectItem value="wget">wget</SelectItem>
                  <SelectItem value="fetch">JavaScript fetch</SelectItem>
                  <SelectItem value="powershell">PowerShell</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="relative">
              <pre className="bg-muted rounded-lg p-3 font-mono text-xs break-all whitespace-pre-wrap">
                {selectedExample.value}
              </pre>
              <Button
                variant="ghost"
                size="icon"
                className="absolute top-1 right-1 h-7 w-7"
                onClick={() => copyText(selectedExample.value, "example")}
                aria-label={t("common.copy")}
              >
                <Copy className="h-3 w-3" />
              </Button>
            </div>
            {copied === "example" && (
              <p className="text-dracula-green text-xs">{t("common.copied")}</p>
            )}
          </div>

          {displayMsg && (
            <p
              className={`text-sm ${displayMsg === t("medications.apiEndpointActivated") || displayMsg === t("medications.apiEndpointDeactivated") ? "text-dracula-green" : "text-destructive"}`}
            >
              {displayMsg}
            </p>
          )}

          <div className="flex items-center justify-between gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="h-9 w-9"
                  disabled={loadingStatus || toggling}
                  aria-label={t("common.moreOptions")}
                >
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuItem
                  onClick={() => {
                    void refetchStatus();
                  }}
                  disabled={loadingStatus || toggling}
                >
                  <RefreshCw className="mr-2 h-4 w-4" />
                  {t("medications.retryLoad")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={handleClose}>
                {t("common.cancel")}
              </Button>
              <Button onClick={handleClose}>{t("common.close")}</Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
