"use client";

/**
 * `<BackupsSection>` — admin view of the weekly `DataBackup` snapshots.
 *
 * Lists every snapshot row (one per user × backup-type) with size and age,
 * plus a "Run backup now" CTA that enqueues the pg-boss `data-backup` job.
 * The encrypted payload itself is never shipped to the browser; only the
 * size in bytes is surfaced.
 *
 * Folds in v1.4.6 deferred T2.6.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Database, Download, Loader2, PlayCircle, Upload } from "lucide-react";
import { useRef, useState, type ChangeEvent } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/format";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import type { BackupRow, BackupsList } from "@/app/api/admin/backups/route";
import { getApiErrorMessage } from "./_shared";

function formatBytes(bytes: number, fmt: ReturnType<typeof useFormatters>) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) {
    return `${fmt.integer(Math.round(bytes / 1024))} KB`;
  }
  return `${fmt.number(bytes / 1024 / 1024, 2)} MB`;
}

export function BackupsSection() {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const queryClient = useQueryClient();

  const { data, isLoading, isError } = useQuery({
    queryKey: ["admin", "backups"],
    queryFn: async () => {
      const res = await fetch("/api/admin/backups");
      if (!res.ok) throw new Error("Failed");
      return (await res.json()).data as BackupsList;
    },
  });

  const runBackup = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/admin/backups/run", { method: "POST" });
      if (!res.ok) {
        throw new Error(await getApiErrorMessage(res));
      }
      return (await res.json()).data as { jobId: string | null };
    },
    onSuccess: () => {
      toast.success(t("admin.section.backups.runEnqueued"));
      // The job runs async; refetch after a short delay so the new row
      // shows up without leaving the user wondering whether the click
      // did anything.
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ["admin", "backups"] });
      }, 2000);
    },
    onError: (err) => {
      toast.error(
        err instanceof Error && err.message
          ? err.message
          : t("admin.section.backups.runFailed"),
      );
    },
  });

  const rows: BackupRow[] = data?.rows ?? [];

  // Per-row download in-flight state — keyed by backup id so two
  // parallel clicks on different rows don't share a single spinner.
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  // Upload state — single-file flow, drives the file input + button.
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const upload = useMutation({
    mutationFn: async (file: File) => {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/admin/backups/upload", {
        method: "POST",
        body: fd,
      });
      if (!res.ok) {
        throw new Error(await getApiErrorMessage(res));
      }
      return (await res.json()).data as {
        id: string;
        valid: true;
        summary: {
          measurements: number;
          medications: number;
          intakeEvents: number;
          moodEntries: number;
        };
      };
    },
    onSuccess: (data) => {
      const total =
        data.summary.measurements +
        data.summary.medications +
        data.summary.intakeEvents +
        data.summary.moodEntries;
      toast.success(
        t("admin.section.backups.uploadSuccess", { count: String(total) }),
      );
      queryClient.invalidateQueries({ queryKey: ["admin", "backups"] });
    },
    onError: (err) => {
      toast.error(
        err instanceof Error && err.message
          ? err.message
          : t("admin.section.backups.uploadFailed"),
      );
    },
    onSettled: () => {
      // Reset the file input so the same file can be re-selected after a
      // rejected upload (browsers keep the previous selection otherwise).
      if (fileInputRef.current) fileInputRef.current.value = "";
    },
  });

  function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) upload.mutate(file);
  }

  async function handleDownload(row: BackupRow) {
    setDownloadingId(row.id);
    try {
      const res = await fetch(`/api/admin/backups/${row.id}/download`);
      if (!res.ok) {
        throw new Error(await getApiErrorMessage(res));
      }
      // Use the server-provided Content-Disposition filename if present,
      // otherwise fall back to a deterministic client-side name. The
      // server filename is more accurate (uses the actual createdAt).
      const cd = res.headers.get("content-disposition") ?? "";
      const match = cd.match(/filename="?([^";]+)"?/i);
      const fallback = `healthlog-backup-${row.userId}-${row.createdAt.slice(0, 10)}.json`;
      const filename = match?.[1] ?? fallback;

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast.success(t("admin.section.backups.downloadStarted"));
    } catch (err) {
      toast.error(
        err instanceof Error && err.message
          ? err.message
          : t("admin.section.backups.downloadFailed"),
      );
    } finally {
      setDownloadingId(null);
    }
  }

  return (
    <div className="bg-card border-border rounded-xl border p-6">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Database className="text-primary h-5 w-5" />
          <div className="text-lg font-semibold">
            {t("admin.section.backups.title")}
          </div>
          {data && (
            <Badge variant="secondary" className="text-xs">
              {rows.length}
            </Badge>
          )}
        </div>
        <Button
          size="sm"
          disabled={runBackup.isPending}
          onClick={() => runBackup.mutate()}
        >
          {runBackup.isPending ? (
            <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
          ) : (
            <PlayCircle className="mr-1 h-3.5 w-3.5" />
          )}
          {t("admin.section.backups.runNow")}
        </Button>
      </div>
      <p className="text-muted-foreground mt-1 text-xs">
        {t("admin.section.backups.description")}
      </p>

      {/* Upload card — separate from the table so admins can ingest a
          backup file independently of any existing rows. The visible
          button proxies a hidden file input so the layout stays clean
          while keyboard / screen-reader users keep a labelled control. */}
      <div className="bg-muted/30 border-border mt-4 flex flex-col gap-2 rounded-md border p-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="text-sm font-medium">
            {t("admin.section.backups.uploadTitle")}
          </div>
          <p className="text-muted-foreground text-xs">
            {t("admin.section.backups.uploadDescription")}{" "}
            <span className="opacity-80">
              {t("admin.section.backups.uploadHelp")}
            </span>
          </p>
        </div>
        <div>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json,.json"
            className="sr-only"
            onChange={handleFileChange}
            aria-label={t("admin.section.backups.uploadButton")}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={upload.isPending}
            onClick={() => fileInputRef.current?.click()}
          >
            {upload.isPending ? (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Upload className="mr-1 h-3.5 w-3.5" />
            )}
            {t("admin.section.backups.uploadButton")}
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="mt-4 flex items-center gap-2">
          <Loader2 className="text-muted-foreground h-4 w-4 animate-spin" />
          <span className="text-muted-foreground text-sm">
            {t("admin.section.backups.loading")}
          </span>
        </div>
      ) : isError ? (
        <div
          role="alert"
          className="text-destructive bg-destructive/10 border-destructive/30 mt-4 rounded-md border px-3 py-2 text-sm"
        >
          {t("admin.section.backups.loadError")}
        </div>
      ) : rows.length === 0 ? (
        <div className="text-muted-foreground mt-4 text-sm">
          {t("admin.section.backups.empty")}
        </div>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-muted-foreground border-b text-xs">
                <th className="px-3 py-2 text-left font-medium">
                  {t("admin.section.backups.colUser")}
                </th>
                <th className="px-3 py-2 text-left font-medium">
                  {t("admin.section.backups.colType")}
                </th>
                <th className="px-3 py-2 text-right font-medium">
                  {t("admin.section.backups.colSize")}
                </th>
                <th className="px-3 py-2 text-right font-medium">
                  {t("admin.section.backups.colCreatedAt")}
                </th>
                <th className="px-3 py-2 text-right font-medium">
                  {t("admin.section.backups.colActions")}
                </th>
              </tr>
            </thead>
            <tbody className="divide-border divide-y">
              {rows.map((row, i) => (
                <tr key={row.id} className={i % 2 === 0 ? "bg-muted/30" : ""}>
                  <td className="px-3 py-2 font-medium">{row.username}</td>
                  <td className="px-3 py-2">
                    <Badge variant="secondary" className="text-xs">
                      {row.type}
                    </Badge>
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs tabular-nums">
                    {formatBytes(row.sizeBytes, fmt)}
                  </td>
                  <td className="text-muted-foreground px-3 py-2 text-right text-xs whitespace-nowrap">
                    {formatDateTime(row.createdAt)}
                  </td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={downloadingId === row.id}
                      onClick={() => handleDownload(row)}
                      aria-label={t("admin.section.backups.downloadAria", {
                        username: row.username,
                      })}
                    >
                      {downloadingId === row.id ? (
                        <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Download className="mr-1 h-3.5 w-3.5" />
                      )}
                      {t("admin.section.backups.download")}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-muted-foreground mt-2 text-xs">
            {t("admin.section.backups.retentionLabel", {
              days: data!.retentionDays,
            })}
          </p>
        </div>
      )}
    </div>
  );
}
