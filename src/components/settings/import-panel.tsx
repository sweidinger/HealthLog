"use client";

/**
 * v1.15.7 — Settings → Export & Import → Import area.
 *
 * Web UI for the two existing import backends (issue #281: the routes
 * shipped without a surface). Two clearly-separated controls:
 *
 *   1. Apple Health `export.zip`  — multipart POST to
 *      `/api/import/apple-health-export` (field `file`), then poll
 *      `GET /api/import/apple-health-export/[jobId]/status` on a
 *      `refetchInterval` while the job runs, stopping on a terminal
 *      state (`done` / `failed`). The upload streams server-side so a
 *      multi-GB archive never buffers in the browser beyond the POST.
 *      Idempotent on the file's SHA-256 — re-uploading the same archive
 *      merges rather than duplicating.
 *
 *   2. Generic JSON import        — upload a `.json` file OR paste JSON,
 *      validated client-side for parseability, POSTed to `/api/import`.
 *      A "Download example" button mints a small valid example as a Blob
 *      (no static asset). Returns `{ measurements, moodEntries, skipped }`
 *      counts.
 *
 * Both controls surface rate-limit (429) and error states cleanly and
 * announce progress to assistive tech via `aria-live` regions.
 */

import { useCallback, useId, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertCircle,
  CheckCircle2,
  Download,
  FileJson,
  Loader2,
  Upload,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Textarea } from "@/components/ui/textarea";
import { queryKeys } from "@/lib/query-keys";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";

// ─────────────────────────── Section wrapper ───────────────────────────

export function ImportPanel() {
  const { t } = useTranslations();
  return (
    <section
      aria-labelledby="settings-section-import-title"
      className="space-y-3"
    >
      <div className="space-y-1">
        <h2
          id="settings-section-import-title"
          className="text-base font-semibold tracking-tight"
        >
          {t("settings.sections.export.import.heading")}
        </h2>
        <p className="text-muted-foreground text-xs">
          {t("settings.sections.export.import.description")}
        </p>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <AppleHealthImportCard />
        <JsonImportCard />
      </div>
    </section>
  );
}

// ─────────────────────────── Card shell ───────────────────────────

interface ImportCardShellProps {
  testId: string;
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
  children: React.ReactNode;
}

function ImportCardShell({
  testId,
  icon: Icon,
  title,
  description,
  children,
}: ImportCardShellProps) {
  return (
    <div
      data-testid={testId}
      className="bg-card border-border flex h-full flex-col rounded-xl border p-6"
    >
      <div className="flex items-center gap-2">
        <Icon className="text-primary h-5 w-5 shrink-0" aria-hidden="true" />
        <h3 className="text-base font-semibold">{title}</h3>
      </div>
      <p className="text-muted-foreground mt-1 text-xs">{description}</p>
      <div className="mt-3 flex flex-1 flex-col gap-3">{children}</div>
    </div>
  );
}

// ─────────────────────────── Apple Health import ───────────────────────────

/** Terminal states the status poll stops on. */
const TERMINAL_STATES: readonly string[] = ["done", "failed"];

interface JobStatus {
  jobId: string;
  status: string;
  progress: {
    currentPhase?: string;
    recordsRead?: number;
    rowsUpserted?: number;
    percent?: number | null;
  } | null;
  result: {
    totals?: { recordsRead?: number; rowsUpserted?: number };
    clinical?: { skipped?: number };
  } | null;
  failureReason: string | null;
}

function AppleHealthImportCard() {
  const { t } = useTranslations();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const dropDescId = useId();

  const statusQuery = useQuery({
    queryKey: queryKeys.importJobStatus(jobId ?? "none"),
    enabled: jobId !== null,
    refetchInterval: (query) => {
      const data = query.state.data as JobStatus | undefined;
      if (data && TERMINAL_STATES.includes(data.status)) return false;
      return 2000;
    },
    queryFn: async (): Promise<JobStatus> => {
      const res = await fetch(
        `/api/import/apple-health-export/${jobId}/status`,
        { credentials: "include" },
      );
      if (!res.ok) {
        throw new Error(`status-${res.status}`);
      }
      return (await res.json()).data as JobStatus;
    },
  });

  const upload = useCallback(
    async (file: File) => {
      setUploadError(null);
      setUploading(true);
      setJobId(null);
      try {
        const form = new FormData();
        form.append("file", file);
        const res = await fetch("/api/import/apple-health-export", {
          method: "POST",
          credentials: "include",
          body: form,
        });
        if (res.status === 429) {
          setUploadError(
            t("settings.sections.export.import.appleHealth.rateLimited"),
          );
          return;
        }
        if (res.status === 413) {
          setUploadError(
            t("settings.sections.export.import.appleHealth.tooLarge"),
          );
          return;
        }
        if (!res.ok) {
          setUploadError(
            t("settings.sections.export.import.appleHealth.uploadFailed"),
          );
          return;
        }
        const body = (await res.json()).data as {
          jobId: string;
          status: string;
        };
        if (!body?.jobId) {
          setUploadError(
            t("settings.sections.export.import.appleHealth.uploadFailed"),
          );
          return;
        }
        setJobId(body.jobId);
      } catch {
        setUploadError(
          t("settings.sections.export.import.appleHealth.uploadFailed"),
        );
      } finally {
        setUploading(false);
      }
    },
    [t],
  );

  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) void upload(file);
    // Reset so picking the same file twice re-fires the change event.
    e.target.value = "";
  }

  function onDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragActive(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void upload(file);
  }

  const status = statusQuery.data ?? null;
  const isRunning = status !== null && !TERMINAL_STATES.includes(status.status);
  const isDone = status?.status === "done";
  const isFailed = status?.status === "failed";
  const busy = uploading || isRunning;
  const percent = status?.progress?.percent ?? null;

  return (
    <ImportCardShell
      testId="import-card-apple-health"
      icon={Upload}
      title={t("settings.sections.export.import.appleHealth.title")}
      description={t("settings.sections.export.import.appleHealth.description")}
    >
      {/* Keyboard-operable drop area. The hidden file input does the
          actual file selection; the div forwards Enter/Space to it. */}
      <div
        role="button"
        tabIndex={0}
        aria-describedby={dropDescId}
        aria-disabled={busy}
        onClick={() => !busy && fileInputRef.current?.click()}
        onKeyDown={(e) => {
          if ((e.key === "Enter" || e.key === " ") && !busy) {
            e.preventDefault();
            fileInputRef.current?.click();
          }
        }}
        onDragOver={(e) => {
          e.preventDefault();
          if (!busy) setDragActive(true);
        }}
        onDragLeave={() => setDragActive(false)}
        onDrop={(e) => !busy && onDrop(e)}
        className={cn(
          "border-border bg-muted/20 hover:bg-muted/40 focus-visible:ring-ring/50 flex min-h-24 cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-dashed p-4 text-center transition-colors focus-visible:ring-2 focus-visible:outline-none",
          dragActive && "border-primary bg-primary/5",
          busy && "pointer-events-none opacity-60",
        )}
      >
        <Upload className="text-muted-foreground h-5 w-5" aria-hidden="true" />
        <span className="text-foreground text-sm font-medium">
          {t("settings.sections.export.import.appleHealth.dropLabel")}
        </span>
        <span id={dropDescId} className="text-muted-foreground text-xs">
          {t("settings.sections.export.import.appleHealth.dropHint")}
        </span>
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept=".zip,application/zip"
        className="sr-only"
        aria-label={t(
          "settings.sections.export.import.appleHealth.fileInputLabel",
        )}
        onChange={onFileChange}
      />

      <p className="text-muted-foreground text-xs">
        {t("settings.sections.export.import.appleHealth.idempotencyNote")}
      </p>

      {/* Live progress / outcome — announced to assistive tech. */}
      <div aria-live="polite" className="space-y-2">
        {uploading && (
          <p className="text-muted-foreground flex items-center gap-2 text-xs">
            <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
            {t("settings.sections.export.import.appleHealth.uploading")}
          </p>
        )}
        {isRunning && (
          <div
            data-testid="import-apple-health-progress"
            className="space-y-1.5"
          >
            <p className="text-muted-foreground flex items-center gap-2 text-xs">
              <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
              {t(
                `settings.sections.export.import.appleHealth.phase.${status?.status ?? "queued"}`,
              )}
            </p>
            {typeof percent === "number" && <Progress value={percent} />}
            {typeof status?.progress?.rowsUpserted === "number" && (
              <p className="text-muted-foreground text-xs">
                {t("settings.sections.export.import.appleHealth.rowsImported", {
                  count: status.progress.rowsUpserted,
                })}
              </p>
            )}
          </div>
        )}
        {isDone && (
          <div
            data-testid="import-apple-health-result"
            className="text-foreground flex items-start gap-2 text-xs"
          >
            <CheckCircle2
              className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500"
              aria-hidden="true"
            />
            <span>
              {t("settings.sections.export.import.appleHealth.doneSummary", {
                imported: status?.result?.totals?.rowsUpserted ?? 0,
                read: status?.result?.totals?.recordsRead ?? 0,
                skipped: status?.result?.clinical?.skipped ?? 0,
              })}
            </span>
          </div>
        )}
        {(isFailed || uploadError) && (
          <p
            role="alert"
            className="text-destructive flex items-start gap-2 text-sm"
          >
            <AlertCircle
              className="mt-0.5 h-3.5 w-3.5 shrink-0"
              aria-hidden="true"
            />
            <span>
              {uploadError ??
                status?.failureReason ??
                t("settings.sections.export.import.appleHealth.failed")}
            </span>
          </p>
        )}
      </div>

      <div className="mt-auto flex flex-wrap items-center gap-3 pt-1">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => fileInputRef.current?.click()}
          data-testid="import-action-apple-health"
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
          ) : (
            <Upload className="h-3.5 w-3.5" />
          )}
          {t("settings.sections.export.import.appleHealth.choose")}
        </Button>
      </div>
    </ImportCardShell>
  );
}

// ─────────────────────────── Generic JSON import ───────────────────────────

/**
 * Small valid example payload, minted as a downloadable Blob by the
 * "Download example" button and used by the docs. Exported so a test can
 * assert it stays a valid import body — the button and the route schema
 * must never drift.
 */
export const EXAMPLE_IMPORT = {
  measurements: [
    {
      type: "WEIGHT",
      value: 80.5,
      unit: "kg",
      measuredAt: "2026-05-01T08:00:00.000Z",
      source: "manual",
      notes: "morning",
    },
    {
      type: "BLOOD_PRESSURE_SYS",
      value: 120,
      unit: "mmHg",
      measuredAt: "2026-05-01T08:05:00.000Z",
    },
    {
      type: "BLOOD_PRESSURE_DIA",
      value: 80,
      unit: "mmHg",
      measuredAt: "2026-05-01T08:05:00.000Z",
    },
  ],
  moodEntries: [
    {
      date: "2026-05-01",
      mood: "GUT",
      score: 4,
      tags: "work,exercise",
    },
  ],
};

interface JsonImportResult {
  measurements: number;
  moodEntries: number;
  skipped: number;
}

/**
 * Client-side parse guard for the JSON-import textarea. Returns the
 * parsed value when the text is valid JSON, otherwise a failure marker —
 * we never POST an unparseable body. Exported for unit testing so the
 * guard is covered without a browser.
 */
export function parseImportJson(
  text: string,
): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

function JsonImportCard() {
  const { t } = useTranslations();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<JsonImportResult | null>(null);
  const textareaId = useId();

  async function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setError(null);
    setResult(null);
    try {
      const content = await file.text();
      setText(content);
    } catch {
      setError(t("settings.sections.export.import.json.readFailed"));
    }
  }

  function downloadExample() {
    const blob = new Blob([JSON.stringify(EXAMPLE_IMPORT, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "healthlog-import-example.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  async function handleImport() {
    setError(null);
    setResult(null);
    const parsed = parseImportJson(text);
    if (!parsed.ok) {
      setError(t("settings.sections.export.import.json.invalidJson"));
      return;
    }
    const payload = parsed.value;
    setBusy(true);
    try {
      const res = await fetch("/api/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(payload),
      });
      if (res.status === 429) {
        setError(t("settings.sections.export.import.json.rateLimited"));
        return;
      }
      if (res.status === 422) {
        const body = await res.json().catch(() => null);
        setError(
          body?.error ??
            t("settings.sections.export.import.json.invalidPayload"),
        );
        return;
      }
      if (!res.ok) {
        setError(t("settings.sections.export.import.json.failed"));
        return;
      }
      const data = (await res.json()).data as JsonImportResult;
      setResult({
        measurements: data?.measurements ?? 0,
        moodEntries: data?.moodEntries ?? 0,
        skipped: data?.skipped ?? 0,
      });
    } catch {
      setError(t("settings.sections.export.import.json.failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ImportCardShell
      testId="import-card-json"
      icon={FileJson}
      title={t("settings.sections.export.import.json.title")}
      description={t("settings.sections.export.import.json.description")}
    >
      <div className="space-y-1.5">
        <Label htmlFor={textareaId} className="text-xs">
          {t("settings.sections.export.import.json.pasteLabel")}
        </Label>
        <Textarea
          id={textareaId}
          data-testid="import-json-textarea"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={5}
          spellCheck={false}
          placeholder='{"measurements":[…],"moodEntries":[…]}'
          className="font-mono text-xs"
        />
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept=".json,application/json"
        className="sr-only"
        aria-label={t("settings.sections.export.import.json.fileInputLabel")}
        onChange={onFileChange}
      />

      <p className="text-muted-foreground text-xs">
        {t("settings.sections.export.import.json.schemaHint")}{" "}
        <a
          href="/docs/integrations/data-import"
          className="text-primary underline underline-offset-2"
        >
          {t("settings.sections.export.import.json.docsLink")}
        </a>
      </p>

      <div aria-live="polite" className="space-y-2">
        {result && (
          <p
            data-testid="import-json-result"
            className="text-foreground flex items-start gap-2 text-xs"
          >
            <CheckCircle2
              className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500"
              aria-hidden="true"
            />
            <span>
              {t("settings.sections.export.import.json.resultSummary", {
                measurements: result.measurements,
                moods: result.moodEntries,
                skipped: result.skipped,
              })}
            </span>
          </p>
        )}
        {error && (
          <p
            role="alert"
            className="text-destructive flex items-start gap-2 text-sm"
          >
            <AlertCircle
              className="mt-0.5 h-3.5 w-3.5 shrink-0"
              aria-hidden="true"
            />
            <span>{error}</span>
          </p>
        )}
      </div>

      <div className="mt-auto flex flex-wrap items-center gap-3 pt-1">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => fileInputRef.current?.click()}
          data-testid="import-json-choose-file"
        >
          <Upload className="h-3.5 w-3.5" />
          {t("settings.sections.export.import.json.uploadFile")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={downloadExample}
          data-testid="import-json-download-example"
        >
          <Download className="h-3.5 w-3.5" />
          {t("settings.sections.export.import.json.downloadExample")}
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={busy || text.trim().length === 0}
          onClick={handleImport}
          data-testid="import-action-json"
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
          ) : (
            <FileJson className="h-3.5 w-3.5" />
          )}
          {t("settings.sections.export.import.json.import")}
        </Button>
      </div>
    </ImportCardShell>
  );
}
