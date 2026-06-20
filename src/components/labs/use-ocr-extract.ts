"use client";

/**
 * v1.18.9 — client hooks for the Lab-OCR ingestion flow.
 *
 *  - `useOcrCapability()` — the cheap capability probe that decides whether the
 *    "Scan a report" affordance shows.
 *  - `useOcrExtract()` — uploads the photo / PDF and returns the proposed rows.
 *    A vision call is slow, so it opts out of the default 15 s fetch timeout in
 *    favour of a generous 90 s window.
 *  - `useOcrCommit()` — writes the user-confirmed rows and invalidates the
 *    labs + biomarker query keys.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiFetch, apiPost } from "@/lib/api/api-fetch";
import { queryKeys } from "@/lib/query-keys";
import type {
  OcrCapabilityDto,
  OcrCommitResponseDto,
  OcrExtractResponseDto,
} from "@/lib/validations/labs-ocr";

import type { LabResultDto } from "./types";

/** Per-row payload the commit endpoint accepts (the human-confirmed shape). */
export interface OcrCommitRowInput {
  analyte: string;
  panel?: string;
  value?: number;
  valueText?: string;
  unit?: string;
  referenceLow?: number;
  referenceHigh?: number;
  takenAt: string;
}

export interface OcrCommitResult extends OcrCommitResponseDto {
  inserted: LabResultDto[];
}

/** Capability probe — refetched when the scan dialog opens. */
export function useOcrCapability(enabled: boolean) {
  return useQuery<OcrCapabilityDto>({
    queryKey: queryKeys.ocrCapability(),
    queryFn: () => apiFetch<OcrCapabilityDto>("/api/labs/ocr/capability"),
    enabled,
    staleTime: 60_000,
  });
}

/** Upload + extract. Resolves with the proposed rows for the review screen. */
export function useOcrExtract() {
  return useMutation<OcrExtractResponseDto, Error, File>({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.append("file", file);
      return apiFetch<OcrExtractResponseDto>("/api/labs/ocr/extract", {
        method: "POST",
        body: form,
        // Vision extraction is slow; a generous ceiling beats the 15 s default.
        signal: AbortSignal.timeout(90_000),
      });
    },
  });
}

/** Commit the confirmed rows and invalidate the dependent reads. */
export function useOcrCommit() {
  const queryClient = useQueryClient();
  return useMutation<OcrCommitResult, Error, OcrCommitRowInput[]>({
    mutationFn: (rows: OcrCommitRowInput[]) =>
      apiPost<OcrCommitResult>("/api/labs/ocr/commit", { rows }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.labResults() });
      queryClient.invalidateQueries({ queryKey: queryKeys.biomarkers() });
    },
  });
}
