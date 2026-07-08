"use client";

/**
 * v1.27.22 (Document vault P2) — the AI area of the document detail sheet,
 * lifted out of the sheet so the availability gate (toolbar vs. calm pointer)
 * and the review-first wiring render without the sheet's dialog portal and are
 * pinned by static-render tests.
 *
 * Presentational: the sheet owns the mutations + capability probe and passes
 * their state + handlers down. When `aiEnabled` is false the whole area is the
 * calm "set up an AI provider" pointer — never an error, and the manual form
 * below stays fully usable.
 */
import { FileText, ShieldAlert, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useTranslations } from "@/lib/i18n/context";
import type {
  DocumentSuggestionDto,
  DocumentSummaryMode,
} from "@/lib/validations/inbound-documents";

import {
  AiUnavailableHint,
  AssistSuggestionReview,
  ContentIndexStatus,
  DocumentSummaryPanel,
} from "./document-ai-panels";
import type { DocumentDescribeResult } from "./use-document-assist";

export function DocumentAiSection({
  aiEnabled,
  indexEnabled,
  unavailableReason,
  egressExternal,
  actionsDisabled,
  onSuggest,
  suggestPending,
  suggestErrorKey,
  onSummarise,
  summaryPending,
  suggestion,
  suggestionKindLabel,
  suggestionDateLabel,
  appliedFields,
  onUseTitle,
  onUseKind,
  onUseDate,
  onDismissSuggestion,
  summaryOutput,
  summaryResult,
  summaryErrorKey,
  onCloseSummary,
  hasContentIndex,
  indexPending,
  onIndex,
}: {
  aiEnabled: boolean;
  indexEnabled: boolean;
  unavailableReason: "no-provider" | "enable-local-ocr" | null;
  /**
   * True when a document read will egress to a third-party AI service (any
   * provider other than a self-hosted local model). Drives the vendor-blind
   * "this leaves your machine" notice shown before the AI actions.
   */
  egressExternal: boolean;
  /** Capability still resolving — the transport mode isn't known yet. */
  actionsDisabled: boolean;
  onSuggest: () => void;
  suggestPending: boolean;
  suggestErrorKey: string | null;
  onSummarise: (output: DocumentSummaryMode) => void;
  summaryPending: boolean;
  suggestion: DocumentSuggestionDto | null;
  suggestionKindLabel: string | null;
  suggestionDateLabel: string | null;
  appliedFields: { title: boolean; kind: boolean; date: boolean };
  onUseTitle: () => void;
  onUseKind: () => void;
  onUseDate: () => void;
  onDismissSuggestion: () => void;
  summaryOutput: DocumentSummaryMode | null;
  summaryResult: DocumentDescribeResult | null;
  summaryErrorKey: string | null;
  onCloseSummary: () => void;
  hasContentIndex: boolean;
  indexPending: boolean;
  onIndex: () => void;
}) {
  const { t } = useTranslations();

  if (!aiEnabled) {
    return (
      <div className="space-y-3" data-slot="document-ai-section">
        <AiUnavailableHint reason={unavailableReason} />
      </div>
    );
  }

  return (
    <div className="space-y-3" data-slot="document-ai-section">
      {egressExternal ? (
        <div
          data-slot="document-ai-egress-notice"
          role="note"
          className="border-border text-muted-foreground flex items-start gap-2 rounded-lg border border-dashed px-3 py-2.5 text-xs"
        >
          <ShieldAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <p className="min-w-0">{t("documents.ai.egressNotice")}</p>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-slot="assist-suggest"
          onClick={onSuggest}
          disabled={suggestPending || actionsDisabled}
        >
          <Sparkles className="size-4" aria-hidden />
          {suggestPending
            ? t("documents.assist.suggesting")
            : t("documents.assist.suggest")}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onSummarise("summary")}
          disabled={summaryPending || actionsDisabled}
        >
          <FileText className="size-4" aria-hidden />
          {t("documents.summary.summarise")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onSummarise("text")}
          disabled={summaryPending || actionsDisabled}
        >
          {t("documents.summary.showText")}
        </Button>
      </div>

      {suggestErrorKey ? (
        <p role="alert" className="text-destructive text-sm">
          {t(suggestErrorKey)}
        </p>
      ) : null}

      {suggestion ? (
        <AssistSuggestionReview
          suggestion={suggestion}
          kindLabel={suggestionKindLabel}
          dateLabel={suggestionDateLabel}
          applied={appliedFields}
          onUseTitle={onUseTitle}
          onUseKind={onUseKind}
          onUseDate={onUseDate}
          onDismiss={onDismissSuggestion}
        />
      ) : null}

      {summaryOutput ? (
        <DocumentSummaryPanel
          output={summaryOutput}
          result={summaryResult}
          isPending={summaryPending}
          errorKey={summaryErrorKey}
          onClose={onCloseSummary}
        />
      ) : null}

      {indexEnabled ? (
        <ContentIndexStatus
          hasContentIndex={hasContentIndex}
          isPending={indexPending}
          onIndex={onIndex}
        />
      ) : null}
    </div>
  );
}
