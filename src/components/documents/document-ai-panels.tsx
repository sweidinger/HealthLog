"use client";

/**
 * v1.27.22 (Document vault P2) — the presentational AI panels for the document
 * detail sheet. Pure (props in, markup out) so the review-first contract and
 * the session-only note are pinned by static-render tests.
 *
 *   - `AiUnavailableHint` — the calm "set up an AI provider" pointer shown in
 *     place of the AI actions when no provider is configured (never an error).
 *   - `AssistSuggestionReview` — the reviewed DRAFT card: suggested title / type
 *     / date, each applied only by an explicit tap. Nothing is written until the
 *     user applies it (and the title lands in the editable field, not on disk).
 *   - `DocumentSummaryPanel` — the transient summary / extracted-text panel with
 *     the persistent "not saved · not a diagnosis" note.
 *   - `ContentSearchStatus` — the per-document searchable pill reflecting the
 *     auto-index: "Read by AI" (provider read the original), "Searchable"
 *     (locally indexed), "Making searchable…" (a read is running), or the calm
 *     "not searchable yet". A STATUS, never a chore button.
 */
import { Loader2, ScanSearch, Sparkles } from "lucide-react";
import { Check, FileText, X } from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";
import {
  isAiReadSource,
  type DocumentContentIndexSourceValue,
  type DocumentSuggestionDto,
  type DocumentSummaryMode,
} from "@/lib/validations/inbound-documents";

import type { DocumentDescribeResult } from "./use-document-assist";

/**
 * Calm pointer to the AI settings, shown when assist is unavailable. When the
 * document is already searchable (auto-indexed locally) the copy stays honest —
 * it is searchable, an AI provider only adds a richer read.
 */
export function AiUnavailableHint({
  reason,
}: {
  reason: "no-provider" | "enable-local-ocr" | null;
}) {
  const { t } = useTranslations();
  const body =
    reason === "enable-local-ocr"
      ? t("documents.assist.unavailableLocalOcr")
      : t("documents.assist.unavailableBody");
  return (
    <div
      data-slot="assist-unavailable"
      className="border-border text-muted-foreground flex items-start gap-2 rounded-lg border border-dashed px-3 py-2.5 text-xs"
    >
      <Sparkles className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <p className="min-w-0">
        {body}{" "}
        <Link
          href="/settings/ai"
          data-slot="assist-settings-link"
          className="text-primary font-medium underline-offset-4 hover:underline"
        >
          {t("documents.assist.unavailableAction")}
        </Link>
      </p>
    </div>
  );
}

/** One reviewed draft row: a suggested value + an explicit apply control. */
function ReviewRow({
  label,
  value,
  applied,
  onApply,
  applyLabel,
}: {
  label: string;
  value: string;
  applied: boolean;
  onApply: () => void;
  applyLabel: string;
}) {
  const { t } = useTranslations();
  return (
    <div className="flex items-center gap-2">
      <div className="min-w-0 flex-1">
        <p className="text-muted-foreground text-xs">{label}</p>
        <p className="truncate text-sm font-medium">{value}</p>
      </div>
      {applied ? (
        <span className="text-muted-foreground inline-flex items-center gap-1 text-xs">
          <Check className="size-3.5" aria-hidden />
          {t("documents.assist.applied")}
        </span>
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 shrink-0 px-2.5 text-xs"
          onClick={onApply}
        >
          {applyLabel}
        </Button>
      )}
    </div>
  );
}

/**
 * The review-first suggestion card. Suggestions are DRAFTS: applying the title
 * seeds the editable title field (the user still saves it); applying the type
 * or date commits that single field through the existing edit-on-commit path —
 * always an explicit tap, never automatic.
 */
export function AssistSuggestionReview({
  suggestion,
  kindLabel,
  dateLabel,
  applied,
  onUseTitle,
  onUseKind,
  onUseDate,
  onDismiss,
}: {
  suggestion: DocumentSuggestionDto;
  /** Translated label for the suggested kind, or null when none was read. */
  kindLabel: string | null;
  /** Formatted suggested date, or null when none was read. */
  dateLabel: string | null;
  applied: { title: boolean; kind: boolean; date: boolean };
  onUseTitle: () => void;
  onUseKind: () => void;
  onUseDate: () => void;
  onDismiss: () => void;
}) {
  const { t } = useTranslations();
  const hasAny =
    suggestion.title !== null ||
    suggestion.kind !== null ||
    suggestion.documentDate !== null;

  return (
    <div
      data-slot="assist-suggestion-review"
      className="border-primary/30 bg-primary/5 space-y-3 rounded-lg border p-3"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-start gap-2">
          <Sparkles
            className="text-primary mt-0.5 size-4 shrink-0"
            aria-hidden
          />
          <div>
            <p className="text-sm font-medium">
              {t("documents.assist.reviewTitle")}
            </p>
            <p className="text-muted-foreground text-xs">
              {t("documents.assist.reviewHint")}
            </p>
          </div>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          onClick={onDismiss}
          aria-label={t("documents.assist.dismiss")}
        >
          <X className="size-4" aria-hidden />
        </Button>
      </div>

      {hasAny ? (
        <div className="space-y-2.5">
          {suggestion.title !== null ? (
            <ReviewRow
              label={t("documents.assist.suggestedTitle")}
              value={suggestion.title}
              applied={applied.title}
              onApply={onUseTitle}
              applyLabel={t("documents.assist.useTitle")}
            />
          ) : null}
          {suggestion.kind !== null && kindLabel !== null ? (
            <ReviewRow
              label={t("documents.assist.suggestedKind")}
              value={kindLabel}
              applied={applied.kind}
              onApply={onUseKind}
              applyLabel={t("documents.assist.apply")}
            />
          ) : null}
          {suggestion.documentDate !== null && dateLabel !== null ? (
            <ReviewRow
              label={t("documents.assist.suggestedDate")}
              value={dateLabel}
              applied={applied.date}
              onApply={onUseDate}
              applyLabel={t("documents.assist.apply")}
            />
          ) : null}
        </div>
      ) : (
        <p className="text-muted-foreground text-sm">
          {t("documents.assist.empty")}
        </p>
      )}
    </div>
  );
}

/**
 * The transient summary / extracted-text panel. The result is shown once and
 * never persisted; the "not saved · not a diagnosis" note is always present.
 */
export function DocumentSummaryPanel({
  output,
  result,
  isPending,
  errorKey,
  onClose,
}: {
  output: DocumentSummaryMode;
  result: DocumentDescribeResult | null;
  isPending: boolean;
  errorKey: string | null;
  onClose: () => void;
}) {
  const { t } = useTranslations();
  const heading =
    output === "text"
      ? t("documents.summary.textTitle")
      : t("documents.summary.summaryTitle");
  const body =
    result === null ? null : "summary" in result ? result.summary : result.text;

  return (
    <div
      data-slot="document-summary-panel"
      className="border-border bg-muted/40 space-y-2 rounded-lg border p-3"
    >
      <div className="flex items-center justify-between gap-2">
        <p className="inline-flex items-center gap-1.5 text-sm font-medium">
          <FileText className="text-muted-foreground size-4" aria-hidden />
          {heading}
        </p>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          onClick={onClose}
          aria-label={t("documents.summary.close")}
        >
          <X className="size-4" aria-hidden />
        </Button>
      </div>

      {isPending ? (
        <div className="space-y-2" data-slot="document-summary-loading">
          <Skeleton className="h-3.5 w-full" />
          <Skeleton className="h-3.5 w-11/12" />
          <Skeleton className="h-3.5 w-3/4" />
        </div>
      ) : errorKey ? (
        <p role="alert" className="text-destructive text-sm">
          {t(errorKey)}
        </p>
      ) : body !== null ? (
        <p
          className={cn(
            "text-foreground text-sm",
            output === "text" && "font-mono text-xs whitespace-pre-wrap",
          )}
        >
          {body}
        </p>
      ) : null}

      <p className="text-muted-foreground border-border/60 border-t pt-2 text-xs">
        {t("documents.summary.notSaved")}
      </p>
    </div>
  );
}

/**
 * The per-document searchable status pill. Reflects the auto-index (indexing is
 * automatic on upload, so this is a state, never a to-do): a document is "Read
 * by AI" when a provider read the original, "Searchable" when it is only locally
 * indexed, "Making searchable…" while a read runs, and a calm "not searchable
 * yet" otherwise. The AI-read pill is highlighted (primary) — that read is the
 * richer one and worth surfacing.
 */
export function ContentSearchStatus({
  hasContentIndex,
  source,
  isPending,
}: {
  hasContentIndex: boolean;
  source: DocumentContentIndexSourceValue | null;
  /** A read/index is running right now. */
  isPending: boolean;
}) {
  const { t } = useTranslations();

  if (isPending) {
    return (
      <span
        data-slot="content-search-status"
        data-state="indexing"
        className="text-muted-foreground inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs"
      >
        <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden />
        {t("documents.ai.statusIndexing")}
      </span>
    );
  }

  if (!hasContentIndex) {
    return (
      <span
        data-slot="content-search-status"
        data-state="none"
        className="text-muted-foreground inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs"
      >
        <ScanSearch className="size-3.5 shrink-0" aria-hidden />
        {t("documents.ai.statusNotYet")}
      </span>
    );
  }

  if (isAiReadSource(source)) {
    return (
      <span
        data-slot="content-search-status"
        data-state="ai-read"
        className="bg-primary/10 text-primary inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium"
      >
        <Sparkles className="size-3.5 shrink-0" aria-hidden />
        {t("documents.ai.statusAiRead")}
      </span>
    );
  }

  return (
    <span
      data-slot="content-search-status"
      data-state="searchable"
      className="text-muted-foreground inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs"
    >
      <ScanSearch className="size-3.5 shrink-0" aria-hidden />
      {t("documents.ai.statusSearchable")}
    </span>
  );
}
