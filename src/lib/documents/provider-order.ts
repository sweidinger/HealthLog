/**
 * Document-class AI provider resolution (governance fix, oauth-investigation
 * SYNTHESIS §1).
 *
 * A three-audit investigation found that for uploaded medical DOCUMENTS the
 * app-wide provider chain is the wrong default: `codex` (the
 * ChatGPT-subscription OAuth backend) sits at chain priority 1, ahead of BYOK
 * and local, and OpenAI's consumer policy allows training on that content by
 * default. HealthLog is privacy-first, so a scanned discharge letter must NOT
 * default to the train-by-default backend.
 *
 * The fix is scoped to the DOCUMENT class only — Coach / insights keep the
 * cost-first app-wide order untouched. This module reprioritises the resolved
 * provider chain for the vault's AI surfaces (suggest / summary / extract /
 * index / reindex / backfill):
 *
 *   local (no egress) → BYOK no-train API (openai / anthropic) → operator's
 *   admin key → codex (ChatGPT-subscription OAuth) LAST, as an explicit,
 *   consented opt-in.
 *
 * The reorder only decides WHICH configured provider is preferred; it never
 * invents a provider. Egress consent (`assertDocumentEgressConsent`) and the
 * per-egress vendor-blind UI notice sit on top of this order — the reorder
 * keeps codex from being the silent default, the consent gate keeps any
 * external egress from happening without an active receipt.
 */
import type { ProviderChainResolved } from "@/lib/ai/provider-runner";
import { isExternalDocumentEgress } from "@/lib/ai/consent-guard";
import {
  resolveTextProvider,
  resolveVisionProvider,
  type ChainReorder,
  type VisionProviderPick,
} from "@/lib/labs/ocr-capability";

/**
 * Preference rank for a provider when the payload is a DOCUMENT. Lower wins.
 * Local keeps the document on the machine (rank 0); BYOK no-train API keys are
 * next (rank 1); the operator's shared no-train key follows (rank 2); the
 * ChatGPT-subscription OAuth path (`codex`) is LAST (rank 3) because it trains
 * on consumer content by default and cannot be verified opted-out from here.
 */
function documentProviderRank(providerType: string): number {
  switch (providerType) {
    case "local":
      return 0;
    case "openai":
    case "anthropic":
    case "admin-key":
      return 1;
    case "admin-openai":
      return 2;
    case "codex":
      return 3;
    default:
      return 2;
  }
}

/**
 * Reorder a resolved chain for the document class: stable sort by
 * `documentProviderRank`, so within a rank tier the user's own chain order is
 * preserved (a stable sort keeps insertion order on ties). Pure — returns a new
 * array, never mutates the input.
 */
export const reorderChainForDocumentClass: ChainReorder = (chain) => {
  return [...chain].sort(
    (a, b) =>
      documentProviderRank(a.providerType) -
      documentProviderRank(b.providerType),
  );
};

/**
 * Resolve the vision provider for a DOCUMENT read — local-first, codex last.
 * Same shape as `resolveVisionProvider`; the returned `chain` is already in
 * document order and the `pick` is the first vision-capable entry in it.
 */
export function resolveDocumentVisionProvider(
  userId: string,
): Promise<VisionProviderPick> {
  return resolveVisionProvider(userId, {
    reorder: reorderChainForDocumentClass,
  });
}

/**
 * Resolve the text-mode (browser-OCR) structuring provider for a DOCUMENT —
 * local-first, codex last. The `pick` is the first entry of the reordered
 * chain.
 */
export function resolveDocumentTextProvider(userId: string) {
  return resolveTextProvider(userId, {
    reorder: reorderChainForDocumentClass,
  });
}

/** Where a document read egresses, vendor-blind. */
export type DocumentEgressClass = "local" | "external";

/**
 * Classify a picked provider's egress for the per-egress UI notice. Vendor-blind
 * by design — "local" (stays on the machine) vs "external" (a third-party AI
 * service); the copy never names a vendor.
 */
export function documentEgressClass(providerType: string): DocumentEgressClass {
  return isExternalDocumentEgress(providerType) ? "external" : "local";
}

/**
 * The document-scoped capability probe. Mirrors `resolveOcrCapability` but over
 * the document provider order, and adds the `egress` class so the vault UI can
 * show the "this leaves your machine to a third-party AI" notice BEFORE a read.
 */
export interface DocumentAiCapabilityDto {
  available: boolean;
  mode: "vision" | "text" | null;
  reason: "no-provider" | "enable-local-ocr" | null;
  pdfSupported: boolean;
  /**
   * Where a document read will egress with the current provider order:
   *   - "local":    stays on the operator's machine (self-hosted model).
   *   - "external": leaves the machine to a third-party AI service.
   *   - null:       no read is available (see `reason`).
   */
  egress: DocumentEgressClass | null;
}

/**
 * Resolve the document AI capability for the vault UI. The `mode` /
 * `pdfSupported` / `egress` reflect the DOCUMENT provider order (local-first),
 * so the affordance the UI offers matches exactly what the document routes do.
 */
export async function resolveDocumentAiCapability(
  userId: string,
): Promise<DocumentAiCapabilityDto> {
  const { chain, pick, localOcrEnabled } =
    await resolveDocumentVisionProvider(userId);

  // A vision-capable provider is available — the read runs directly over the
  // stored original. Egress follows the picked provider.
  if (pick) {
    return {
      available: true,
      mode: "vision",
      reason: null,
      pdfSupported: pick.pdfSupported,
      egress: documentEgressClass(pick.providerType),
    };
  }

  // Nothing configured at all — no read, regardless of the local-OCR toggle.
  if (chain.length === 0) {
    return {
      available: false,
      mode: null,
      reason: "no-provider",
      pdfSupported: false,
      egress: null,
    };
  }

  // A text-only provider is configured. Local OCR runs in the browser and only
  // the extracted text is structured by the first provider in document order.
  if (localOcrEnabled) {
    return {
      available: true,
      mode: "text",
      reason: null,
      pdfSupported: false,
      egress: documentEgressClass(chain[0]!.providerType),
    };
  }

  // A text-only provider is configured but local OCR is not enabled.
  return {
    available: false,
    mode: null,
    reason: "enable-local-ocr",
    pdfSupported: false,
    egress: null,
  };
}
