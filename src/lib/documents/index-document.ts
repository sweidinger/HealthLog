/**
 * Content-index ONE stored document — the shared, AI-first decision tree behind
 * both the per-document auto-index-on-upload job and the corpus backfill.
 *
 * Ordering (maintainer, 2026-07-07 — AI-first, local as fallback):
 *   1. PROVIDER (primary). When a vision-capable AI provider is configured AND
 *      the user has consented, decrypt the stored original and run ONE provider
 *      transcription — rich, handles scanned PDFs + images via vision. Budget-
 *      reserved + reconciled exactly like the interactive index route; owner-
 *      scoped throughout. Codex-over-OAuth is subscription-covered, so this
 *      path carries no per-token API bill (see the research note).
 *   2. LOCAL (fallback). When no provider is usable — none configured, consent
 *      not granted, the provider can't read this file (e.g. a text-layer PDF on
 *      a non-Anthropic account), the daily budget is reached, or the provider
 *      call fails — fall back to server-side text-layer extraction (`pdf-parse`,
 *      no egress, milliseconds). So content search works at a baseline even with
 *      no AI, and every text-layer PDF is searchable regardless of provider.
 *
 * Both paths write the SAME blind, encrypted index via `upsertContentIndex`
 * (AES-256-GCM text + opaque HMAC token tags) — nothing readable at rest. The
 * function NEVER throws for an expected outcome; it returns a tagged result the
 * caller logs, so a bad document can never abort an upload or a batch.
 */
import { Buffer } from "node:buffer";

import { AI_BUDGETS } from "@/lib/ai/ai-budgets";
import {
  assertConsentForChain,
  ConsentRequiredError,
} from "@/lib/ai/consent-guard";
import {
  buildDateKey,
  reconcileSpend,
  reserveBudget,
  resolveDailyCap,
} from "@/lib/ai/coach/budget";
import {
  loadOwnedDocument,
  prepareVisionInput,
  type LoadedDocument,
} from "@/lib/documents/ai-route-support";
import {
  upsertContentIndex,
  type ContentIndexSource,
} from "@/lib/documents/content-index";
import { transcribeDocument } from "@/lib/documents/describe";
import { localExtractText } from "@/lib/documents/local-extract";
import { decryptDocumentContent } from "@/lib/documents/store";
import { detectOcrMimeType } from "@/lib/labs/ocr-upload";
import type { ProviderChainResolved } from "@/lib/ai/provider-runner";
import { resolveVisionProvider } from "@/lib/labs/ocr-capability";

/**
 * Outcome of one document's index attempt. A provider that is not usable (none
 * configured, no consent, budget exhausted, cannot read the file, or errored)
 * is never itself a terminal outcome — the tree always falls through to the
 * free local path, so the terminal reasons are only the local ones.
 */
export type IndexOutcome =
  | { indexed: true; source: ContentIndexSource; tokenCount: number }
  | {
      indexed: false;
      reason:
        "not-found" | "local-empty" | "local-unsupported" | "decrypt-error";
    };

/**
 * A resolved, consent-checked provider context. Resolve ONCE per user and reuse
 * across a batch so the corpus backfill does not re-read the provider chain per
 * document. `usable` is true only when a vision pick exists AND consent passed.
 */
export interface ResolvedIndexProvider {
  chain: ProviderChainResolved[];
  pick: Awaited<ReturnType<typeof resolveVisionProvider>>["pick"];
  consentOk: boolean;
  dailyCap: number;
}

/**
 * Resolve the user's vision provider and pre-check consent once. A missing pick
 * or an un-granted consent both yield an unusable context — the caller then
 * falls straight to the local path. A NON-consent error propagates.
 */
export async function resolveIndexProvider(
  userId: string,
): Promise<ResolvedIndexProvider> {
  const { chain, pick } = await resolveVisionProvider(userId);
  let consentOk = false;
  if (pick) {
    try {
      await assertConsentForChain({ userId, chain, surface: "insights" });
      consentOk = true;
    } catch (err) {
      if (!(err instanceof ConsentRequiredError)) throw err;
    }
  }
  const dailyCap = pick
    ? resolveDailyCap([{ providerType: pick.entry.providerType }])
    : 0;
  return { chain, pick, consentOk, dailyCap };
}

/**
 * Try the PROVIDER (vision) path for one already-loaded document. Returns a
 * terminal outcome on success/budget/provider-error, or `null` to signal
 * "fall through to local" (no usable provider, or the provider cannot read this
 * particular file — e.g. a PDF on a non-Anthropic account).
 */
async function tryProviderIndex(
  userId: string,
  document: LoadedDocument,
  provider: ResolvedIndexProvider,
): Promise<IndexOutcome | null> {
  const { pick } = provider;
  if (!pick || !provider.consentOk) return null;

  const vision = prepareVisionInput(document, pick.pdfSupported);
  if (!vision.ok) {
    // A decrypt failure is terminal (local would fail the same way); anything
    // else (fileType / pdfNeedsAnthropic) falls through to the local path — a
    // text-layer PDF on a non-Anthropic account is read locally for free.
    if (vision.reason === "decryptFailed") {
      return { indexed: false, reason: "decrypt-error" };
    }
    return null;
  }

  const dateKey = buildDateKey();
  const reservation = await reserveBudget(
    userId,
    AI_BUDGETS.documentTranscribe.maxTokens,
    dateKey,
    provider.dailyCap,
  );
  // Budget exhausted → fall through to the free local path rather than stall;
  // a text-layer PDF stays searchable even once the AI allowance is spent.
  if (!reservation.allowed) return null;

  try {
    const { text } = await transcribeDocument({
      provider: pick.entry.instance,
      providerType: pick.providerType,
      images: vision.images,
      documents: vision.documents,
    });
    await reconcileSpend(
      userId,
      reservation.reserved,
      reservation.reserved,
      dateKey,
    );
    const { tokenCount } = await upsertContentIndex({
      userId,
      documentId: document.id,
      text,
      source: "vision",
      providerType: pick.providerType,
    });
    return { indexed: true, source: "vision", tokenCount };
  } catch {
    // Refund the reservation and let the caller fall through to local — a
    // transient provider miss must never leave a text-layer PDF unsearchable.
    await reconcileSpend(userId, reservation.reserved, 0, dateKey);
    return null;
  }
}

/** Try the LOCAL (provider-free) text-layer path for one loaded document. */
async function tryLocalIndex(
  userId: string,
  document: LoadedDocument,
): Promise<IndexOutcome> {
  let buffer: Buffer;
  try {
    buffer = decryptDocumentContent(
      document.contentEncrypted,
      document.contentCodec,
    );
  } catch {
    return { indexed: false, reason: "decrypt-error" };
  }

  // Re-derive the MIME from the bytes (never trust the stored label), matching
  // the provider path's posture; fall back to the stored MIME if unrecognised.
  const mime = detectOcrMimeType(buffer) ?? document.mimeType;
  const result = await localExtractText(buffer, mime);
  if (result.ok) {
    const { tokenCount } = await upsertContentIndex({
      userId,
      documentId: document.id,
      text: result.text,
      source: result.source,
      providerType: null,
    });
    return { indexed: true, source: result.source, tokenCount };
  }
  if (result.reason === "unsupported") {
    return { indexed: false, reason: "local-unsupported" };
  }
  if (result.reason === "error") {
    return { indexed: false, reason: "decrypt-error" };
  }
  return { indexed: false, reason: "local-empty" };
}

/**
 * Index one already-loaded document: provider-first, local-fallback. Reuses a
 * pre-resolved provider context so a batch resolves the chain once.
 */
export async function indexLoadedDocument(
  userId: string,
  document: LoadedDocument,
  provider: ResolvedIndexProvider,
): Promise<IndexOutcome> {
  const providerOutcome = await tryProviderIndex(userId, document, provider);
  if (providerOutcome) return providerOutcome;
  return tryLocalIndex(userId, document);
}

/**
 * Index ONE document by id (owner-scoped): resolve the provider, load the
 * document, then run the provider-first/local-fallback tree. This is the entry
 * point the per-document auto-index-on-upload job calls.
 */
export async function indexDocumentContent(
  userId: string,
  documentId: string,
): Promise<IndexOutcome> {
  const document = await loadOwnedDocument(userId, documentId);
  if (!document) return { indexed: false, reason: "not-found" };
  const provider = await resolveIndexProvider(userId);
  return indexLoadedDocument(userId, document, provider);
}
