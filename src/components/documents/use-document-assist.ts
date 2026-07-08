"use client";

/**
 * v1.27.22 (Document vault P2) — client hooks for the review-first AI layer on
 * a stored document: the shared capability probe, filing-metadata suggestions,
 * and the session-only summary / extracted text.
 *
 * Every affordance is gated on `usage.assistAvailable` at the call site; these
 * hooks only RUN the call once the surface has decided to offer it. The
 * transport (VISION vs local-OCR TEXT) comes from `document-ai-transport`.
 *
 * NOTHING here writes a document row. Suggestions are drafts the detail sheet
 * prefills; the summary is transient. The only mutation is the caller applying
 * a reviewed draft through the existing edit-on-commit machinery.
 */
import { useMutation, useQuery } from "@tanstack/react-query";

import { apiGet, ApiError } from "@/lib/api/api-fetch";
import { queryKeys } from "@/lib/query-keys";
import type {
  DocumentAiCapabilityDto,
  DocumentSuggestionDto,
  DocumentSummaryMode,
} from "@/lib/validations/inbound-documents";

import {
  DocumentAssistClientError,
  runDocumentAi,
  type DocumentAiMode,
  type DocumentAiTarget,
} from "./document-ai-transport";

/** The session-only describe result — a summary XOR the raw extracted text. */
export type DocumentDescribeResult = { summary: string } | { text: string };

/**
 * The document-scoped AI capability probe (`/api/documents/inbound/capability`).
 * Resolved over the DOCUMENT provider order (local-first, codex last), so the
 * transport `mode` + PDF support match what the document routes do, and it
 * carries the vendor-blind `egress` class the detail sheet uses to warn before a
 * read leaves the machine. Availability of the affordance itself is still gated
 * on `usage.assistAvailable`.
 */
export function useDocumentAiCapability(enabled: boolean) {
  return useQuery<DocumentAiCapabilityDto>({
    queryKey: queryKeys.inboundDocumentAiCapability(),
    queryFn: () =>
      apiGet<DocumentAiCapabilityDto>("/api/documents/inbound/capability"),
    enabled,
    staleTime: 60_000,
  });
}

/**
 * Suggest filing metadata for a stored document. Returns DRAFTS only — the
 * detail sheet prefills its edit fields and the user saves; this call writes
 * nothing.
 */
export function useSuggestDetails() {
  return useMutation<
    DocumentSuggestionDto,
    Error,
    { mode: DocumentAiMode; target: DocumentAiTarget }
  >({
    mutationFn: async ({ mode, target }) => {
      const data = await runDocumentAi<{ suggestions: DocumentSuggestionDto }>({
        path: `/api/documents/inbound/${target.documentId}/suggest`,
        mode,
        target,
      });
      return data.suggestions;
    },
  });
}

/**
 * On-demand, session-only summary or extracted text. The result is rendered
 * once and never persisted (P2-D4); closing the panel discards it.
 */
export function useDocumentSummary() {
  return useMutation<
    DocumentDescribeResult,
    Error,
    {
      mode: DocumentAiMode;
      target: DocumentAiTarget;
      output: DocumentSummaryMode;
    }
  >({
    mutationFn: ({ mode, target, output }) =>
      runDocumentAi<DocumentDescribeResult>({
        path: `/api/documents/inbound/${target.documentId}/summary?mode=${output}`,
        mode,
        target,
      }),
  });
}

/**
 * Map an AI error to a translation key. Server errors carry a stable
 * `meta.errorCode`; client-side precondition failures carry a `reason`. The
 * default is the calm "try again" message — never a raw provider string.
 */
export function documentAiErrorKey(err: unknown): string {
  if (err instanceof DocumentAssistClientError) {
    switch (err.reason) {
      case "textImageOnly":
        return "documents.assist.errorTextImageOnly";
      case "ocr":
        return "documents.assist.errorOcr";
      default:
        return "documents.assist.errorGeneric";
    }
  }
  if (err instanceof ApiError) {
    const code =
      typeof err.meta?.errorCode === "string" ? err.meta.errorCode : "";
    switch (code) {
      case "documents.inbound.rateLimited":
        return "documents.assist.errorRateLimited";
      case "documents.inbound.budgetExceeded":
        return "documents.assist.errorBudget";
      case "documents.inbound.pdfNeedsAnthropic":
        return "documents.assist.errorPdfNeedsVision";
      case "documents.inbound.fileType":
        return "documents.assist.errorFileType";
      case "documents.inbound.localOcrDisabled":
        return "documents.assist.errorLocalOcrDisabled";
      case "documents.inbound.providerUnsupported":
        return "documents.assist.errorProvider";
      default:
        return "documents.assist.errorGeneric";
    }
  }
  return "documents.assist.errorGeneric";
}
