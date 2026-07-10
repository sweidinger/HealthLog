"use client";

/**
 * The "Read with AI" block of the document detail sheet — one coherent, inviting
 * home for every AI reading action, lifted out of the sheet so the availability
 * gate and the review-first wiring render without the sheet's dialog portal and
 * are pinned by static-render tests.
 *
 * Indexing is AUTOMATIC on upload, so this block never nags a "please index"
 * chore. It shows the document's searchable status (auto-indexed) as a pill, and
 * offers AI reading as a capability the user reaches for when they want more:
 *
 *   - "Read with AI" (prominent) runs a provider read of the document — the
 *     richer pass that also refreshes the searchable index. Labelled "Read
 *     again" once a provider has already read it.
 *   - "Suggest details" drafts a title / type / date to review before saving.
 *   - "Summarise" / "Show text" surface a transient, session-only read-out.
 *
 * Presentational: the sheet owns the mutations + capability probe and passes
 * their state + handlers down. When `aiEnabled` is false the actions collapse to
 * the calm "set up an AI provider" pointer (never an error) — the searchable
 * status pill stays, honestly reflecting any local auto-index, and the manual
 * form below stays fully usable.
 */
import { FileText, WandSparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useTranslations } from "@/lib/i18n/context";
import {
  type DocumentContentIndexSourceValue,
  type DocumentSuggestionDto,
  type DocumentSummaryMode,
} from "@/lib/validations/inbound-documents";

import {
  AiUnavailableHint,
  AssistSuggestionReview,
  DocumentSummaryPanel,
} from "./document-ai-panels";
import type { DocumentDescribeResult } from "./use-document-assist";

export function DocumentAiSection({
  aiEnabled,
  autoReadEnabled = false,
  unavailableReason,
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
}: {
  aiEnabled: boolean;
  /**
   * Whether "read documents automatically with AI" is ON. When true, reading +
   * indexing happen on upload, so the manual per-document action row (Read /
   * Suggest / Summarise) is hidden — only the header + searchable status +
   * content-search chat remain. Defaults to false so an omitting caller keeps
   * the manual controls.
   */
  autoReadEnabled?: boolean;
  indexEnabled: boolean;
  unavailableReason: "no-provider" | "enable-local-ocr" | null;
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
  contentIndexSource: DocumentContentIndexSourceValue | null;
  indexPending: boolean;
  onIndex: () => void;
}) {
  const { t } = useTranslations();

  // The redundant "read with AI / read again" button + the searchable-status
  // pill header have been removed — reading + indexing happen automatically on
  // upload, so this block now only carries the review-first assist actions
  // (Suggest / Summarise / Show text) and their transient panels. With
  // auto-read ON and no active suggestion/summary there is nothing to show, so
  // the whole block collapses rather than render an empty bordered box.
  const hasContent =
    !aiEnabled ||
    !autoReadEnabled ||
    Boolean(suggestErrorKey) ||
    Boolean(suggestion) ||
    Boolean(summaryOutput);
  if (!hasContent) return null;

  return (
    <div
      data-slot="document-ai-section"
      className="border-border bg-muted/30 space-y-3 rounded-lg border p-3 md:p-4"
    >
      {aiEnabled ? (
        <>
          {!autoReadEnabled ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-slot="assist-suggest"
                onClick={onSuggest}
                disabled={suggestPending || actionsDisabled}
              >
                <WandSparkles className="size-4" aria-hidden />
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
          ) : null}

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
        </>
      ) : (
        <AiUnavailableHint reason={unavailableReason} />
      )}
    </div>
  );
}
