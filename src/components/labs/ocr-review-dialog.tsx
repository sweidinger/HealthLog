"use client";

/**
 * v1.18.9 — the Lab-OCR "Scan a report" dialog.
 *
 * Flow: pick a photo / PDF → extract (vision provider) → MANDATORY human review
 * (per-row confirm/edit/discard, duplicate + new-biomarker + low-confidence
 * hints) → commit only the confirmed rows. Nothing writes until the user
 * confirms. Reuses the labs design language via `ResponsiveSheet` + the labs
 * row editor.
 */
import { useMemo, useRef, useState } from "react";

import { Loader2, ScanLine, Upload } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { ApiError } from "@/lib/api/api-fetch";
import { useTranslations } from "@/lib/i18n/context";

import { OcrRowEditor } from "./ocr-row-editor";
import { seedReviewRows, type OcrReviewRow } from "./ocr-review-types";
import {
  useOcrCommit,
  useOcrExtract,
  type OcrCommitRowInput,
} from "./use-ocr-extract";

type Stage = "pick" | "review";

const ACCEPT = "image/jpeg,image/png,image/webp,application/pdf";

/** Map a confirmed review row to the commit payload, or null when invalid. */
function toCommitRow(row: OcrReviewRow): OcrCommitRowInput | null {
  const analyte = row.analyte.trim();
  if (!analyte || !row.takenAt) return null;
  // A calendar day → an ISO instant at noon UTC, avoiding a TZ day-shift.
  const takenAt = new Date(`${row.takenAt}T12:00:00.000Z`);
  if (Number.isNaN(takenAt.getTime())) return null;

  const isQualitative = row.valueText !== null && row.valueText !== undefined;
  if (isQualitative) {
    const valueText = (row.valueText ?? "").trim();
    if (!valueText) return null;
    return { analyte, valueText, takenAt: takenAt.toISOString() };
  }

  if (row.value === null || !Number.isFinite(row.value)) return null;
  const unit = (row.unit ?? "").trim();
  if (!unit) return null;
  return {
    analyte,
    value: row.value,
    unit,
    takenAt: takenAt.toISOString(),
    ...(row.referenceLow !== null ? { referenceLow: row.referenceLow } : {}),
    ...(row.referenceHigh !== null ? { referenceHigh: row.referenceHigh } : {}),
  };
}

/** Translate an extract failure into a friendly, error-code-aware message. */
function extractErrorMessage(err: unknown, t: (key: string) => string): string {
  if (err instanceof ApiError) {
    const code =
      typeof err.meta?.errorCode === "string" ? err.meta.errorCode : null;
    switch (code) {
      case "labs.ocr.providerUnsupported":
        return t("labs.ocr.providerUnsupported");
      case "labs.ocr.rateLimited":
        return t("labs.ocr.rateLimited");
      case "labs.ocr.budgetExceeded":
        return t("labs.ocr.budgetExceeded");
      case "labs.ocr.fileTooLarge":
        return t("labs.ocr.fileTooLarge");
      case "labs.ocr.fileType":
        return t("labs.ocr.fileType");
      case "labs.ocr.pdfNeedsAnthropic":
        return t("labs.ocr.pdfNeedsAnthropic");
      default:
        break;
    }
    if (err.status === 403) return t("labs.ocr.consentRequired");
  }
  return t("labs.ocr.extractFailed");
}

export function OcrReviewDialog({
  open,
  onOpenChange,
  pdfSupported,
  onCommitted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pdfSupported: boolean;
  onCommitted: () => void;
}) {
  const { t } = useTranslations();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [stage, setStage] = useState<Stage>("pick");
  const [rows, setRows] = useState<OcrReviewRow[]>([]);

  const extract = useOcrExtract();
  const commit = useOcrCommit();

  const confirmedCount = useMemo(
    () => rows.filter((r) => r.confirmed).length,
    [rows],
  );

  function reset() {
    setStage("pick");
    setRows([]);
    extract.reset();
    commit.reset();
  }

  function handleClose(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  function onFilePicked(file: File) {
    extract.mutate(file, {
      onSuccess: (data) => {
        const seeded = seedReviewRows(data.rows, data.reportDate);
        if (seeded.length === 0) {
          toast.error(t("labs.ocr.noRows"));
          return;
        }
        setRows(seeded);
        setStage("review");
      },
      onError: (err) => toast.error(extractErrorMessage(err, t)),
    });
  }

  function onSave() {
    const payload = rows
      .filter((r) => r.confirmed)
      .map(toCommitRow)
      .filter((r): r is OcrCommitRowInput => r !== null);
    if (payload.length === 0) {
      toast.error(t("labs.ocr.nothingToSave"));
      return;
    }
    commit.mutate(payload, {
      onSuccess: (result) => {
        toast.success(
          t("labs.ocr.savedToast", { count: result.inserted.length }),
        );
        onCommitted();
        handleClose(false);
      },
      onError: () => toast.error(t("labs.ocr.saveFailed")),
    });
  }

  const busy = extract.isPending || commit.isPending;

  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={handleClose}
      title={t("labs.ocr.reviewTitle")}
      description={
        stage === "pick" ? t("labs.ocr.uploadHint") : t("labs.ocr.reviewHint")
      }
      footer={
        stage === "review" ? (
          <div className="flex w-full justify-between gap-2">
            <Button
              variant="ghost"
              onClick={() => handleClose(false)}
              disabled={busy}
              className="min-h-11 sm:min-h-9"
            >
              {t("labs.ocr.discardAll")}
            </Button>
            <Button
              onClick={onSave}
              disabled={busy || confirmedCount === 0}
              className="min-h-11 sm:min-h-9"
            >
              {commit.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
              ) : null}
              {t("labs.ocr.saveSelected", { count: confirmedCount })}
            </Button>
          </div>
        ) : undefined
      }
    >
      {stage === "pick" ? (
        <div className="space-y-4 py-2">
          <input
            ref={inputRef}
            type="file"
            accept={pdfSupported ? ACCEPT : "image/jpeg,image/png,image/webp"}
            className="sr-only"
            onChange={(e) => {
              const file = e.target.files?.[0];
              // Reset so re-picking the same file fires `change` again.
              e.target.value = "";
              if (file) onFilePicked(file);
            }}
          />
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={extract.isPending}
            className="border-muted-foreground/25 hover:bg-muted/50 focus-visible:ring-ring flex min-h-44 w-full flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-6 text-center transition-colors focus-visible:ring-2 focus-visible:outline-none disabled:opacity-60"
          >
            {extract.isPending ? (
              <>
                <Loader2 className="text-primary h-8 w-8 animate-spin motion-reduce:animate-none" />
                <span className="text-muted-foreground text-sm">
                  {t("labs.ocr.extracting")}
                </span>
              </>
            ) : (
              <>
                <ScanLine
                  className="text-muted-foreground h-8 w-8"
                  aria-hidden
                />
                <span className="text-sm font-medium">
                  {t("labs.ocr.scanButton")}
                </span>
                <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
                  <Upload className="h-3.5 w-3.5" aria-hidden />
                  {pdfSupported
                    ? t("labs.ocr.acceptWithPdf")
                    : t("labs.ocr.acceptImageOnly")}
                </span>
              </>
            )}
          </button>
        </div>
      ) : (
        <div className="space-y-3 py-2">
          <p className="text-muted-foreground text-sm">
            {t("labs.ocr.foundCount", { count: rows.length })}
          </p>
          {rows.map((row) => (
            <OcrRowEditor
              key={row.key}
              row={row}
              onChange={(next) =>
                setRows((prev) =>
                  prev.map((r) => (r.key === next.key ? next : r)),
                )
              }
            />
          ))}
        </div>
      )}
    </ResponsiveSheet>
  );
}
