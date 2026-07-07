"use client";

/**
 * The vault's upload entry: a dashed drop-target card with a file button.
 * The `accept` list comes verbatim from the usage endpoint (HEIC is
 * deliberately absent so the iOS picker transcodes camera photos to JPEG),
 * `multiple` is on, and there is NO `capture` attribute — mobile Safari
 * then offers camera AND library. Dropping files onto the card feeds the
 * same queue as the picker.
 *
 * The quota bar renders only above 80 % usage — a calm surface until
 * storage actually becomes a topic.
 */
import { UploadCloud } from "lucide-react";
import { useRef, useState, type RefObject } from "react";

import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";
import type { DocumentUsageDto } from "@/lib/validations/inbound-documents";
import { formatBytes } from "./vault-utils";

/** Usage fraction above which the quota bar appears. */
const QUOTA_BAR_THRESHOLD = 0.8;

export function UploadZone({
  usage,
  onFiles,
  inputRef,
}: {
  /** Limits + usage from `GET /api/documents/inbound/usage` (undefined while loading). */
  usage: DocumentUsageDto | undefined;
  onFiles: (files: File[]) => void;
  /** Exposed so the page header's Upload button can open the same picker. */
  inputRef: RefObject<HTMLInputElement | null>;
}) {
  const { t, locale } = useTranslations();
  const [dragOver, setDragOver] = useState(false);
  const dragDepth = useRef(0);

  const accept = usage?.acceptedExtensions.join(",");
  const usedFraction =
    usage && usage.quotaBytes > 0 ? usage.usedBytes / usage.quotaBytes : 0;

  const pickFiles = (list: FileList | null) => {
    if (!list || list.length === 0) return;
    onFiles(Array.from(list));
  };

  return (
    <div data-slot="document-upload-zone" className="space-y-2">
      <div
        onDragEnter={(e) => {
          e.preventDefault();
          dragDepth.current += 1;
          setDragOver(true);
        }}
        onDragOver={(e) => e.preventDefault()}
        onDragLeave={() => {
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (dragDepth.current === 0) setDragOver(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          dragDepth.current = 0;
          setDragOver(false);
          pickFiles(e.dataTransfer.files);
        }}
        className={cn(
          "border-border rounded-xl border-2 border-dashed px-4 py-6 text-center transition-colors",
          dragOver && "border-primary bg-primary/5",
        )}
      >
        <div className="flex flex-col items-center gap-2">
          <UploadCloud
            className={cn(
              "text-muted-foreground size-6",
              dragOver && "text-primary",
            )}
            aria-hidden
          />
          <p className="text-sm font-medium">
            {t("documents.upload.zoneTitle")}
          </p>
          {usage ? (
            <p className="text-muted-foreground text-xs">
              {t("documents.upload.zoneHint", {
                maxSize: formatBytes(usage.maxFileBytes, locale),
              })}
            </p>
          ) : null}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-1"
            onClick={() => inputRef.current?.click()}
          >
            {t("documents.upload.browse")}
          </Button>
        </div>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={accept}
          className="sr-only"
          aria-label={t("documents.upload.browse")}
          onChange={(e) => {
            pickFiles(e.target.files);
            // Allow re-selecting the same file (duplicate flow) immediately.
            e.target.value = "";
          }}
        />
      </div>

      {usage && usedFraction >= QUOTA_BAR_THRESHOLD ? (
        <div data-slot="document-quota-bar" className="space-y-1">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-medium">
              {t("documents.upload.quotaAlmostFull")}
            </p>
            <p className="text-muted-foreground text-xs tabular-nums">
              {t("documents.upload.quotaUsed", {
                used: formatBytes(usage.usedBytes, locale),
                quota: formatBytes(usage.quotaBytes, locale),
              })}
            </p>
          </div>
          <Progress
            value={Math.min(100, usedFraction * 100)}
            aria-label={t("documents.upload.quotaUsed", {
              used: formatBytes(usage.usedBytes, locale),
              quota: formatBytes(usage.quotaBytes, locale),
            })}
          />
        </div>
      ) : null}
    </div>
  );
}
