/**
 * Content-index ONE stored document — the shared, AI-first decision tree behind
 * both the per-document auto-index-on-upload job and the corpus backfill.
 *
 * Provider resolution follows the DOCUMENT order (local-first, codex last —
 * `resolveDocumentVisionProvider`), NOT the cost-first app-wide chain, and the
 * external egress is governed by the per-user `documentsAutoAiRead` opt-in:
 *
 *   1. LOCAL PROVIDER (a self-hosted vision model) — never egresses, so it runs
 *      whenever it is the document-order pick, toggle-independent.
 *   2. EXTERNAL PROVIDER (codex / BYOK openai|anthropic / admin key) — reads a
 *      document off the machine, so the auto-index job only uses it when the
 *      operator opted into `documentsAutoAiRead`. OFF → the job is strictly
 *      local (never egresses on upload, even if an unrelated consent receipt
 *      exists); ON → the document-order external pick reads the original (rich,
 *      handles scanned PDFs + images). Budget-reserved + reconciled exactly like
 *      the interactive index route; owner-scoped throughout.
 *   3. LOCAL TEXT-LAYER (fallback). When no provider is usable — none
 *      configured, the toggle is OFF for an external pick, the provider can't
 *      read this file (e.g. a text-layer PDF on a non-Anthropic account), the
 *      daily budget is reached, or the provider call fails — fall back to
 *      server-side text-layer extraction (`pdf-parse`, no egress, milliseconds).
 *      So content search works at a baseline even with no AI, and every
 *      text-layer PDF is searchable regardless of provider.
 *
 * Both paths write the SAME blind, encrypted index via `upsertContentIndex`
 * (AES-256-GCM text + opaque HMAC token tags) — nothing readable at rest. The
 * function NEVER throws for an expected outcome; it returns a tagged result the
 * caller logs, so a bad document can never abort an upload or a batch.
 */
import { Buffer } from "node:buffer";

import { AI_BUDGETS } from "@/lib/ai/ai-budgets";
import { isExternalDocumentEgress } from "@/lib/ai/consent-guard";
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
import { documentAutoReadEnabled } from "@/lib/documents/document-settings";
import { localExtractText } from "@/lib/documents/local-extract";
import { resolveDocumentVisionProvider } from "@/lib/documents/provider-order";
import { decryptDocumentContent } from "@/lib/documents/store";
import { detectOcrMimeType } from "@/lib/labs/ocr-upload";
import type { ProviderChainResolved } from "@/lib/ai/provider-runner";

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
  pick: Awaited<ReturnType<typeof resolveDocumentVisionProvider>>["pick"];
  consentOk: boolean;
  dailyCap: number;
}

/**
 * Resolve the DOCUMENT-order vision provider and decide egress eligibility once.
 * A local pick is always eligible (it never leaves the machine). An external
 * pick is eligible ONLY when the operator opted into `documentsAutoAiRead` — so
 * the auto-index job never silently egresses a freshly uploaded document unless
 * that toggle is ON. A missing pick or an ineligible external pick both yield an
 * unusable context, and the caller falls straight to the local text-layer path.
 */
export async function resolveIndexProvider(
  userId: string,
): Promise<ResolvedIndexProvider> {
  const { chain, pick } = await resolveDocumentVisionProvider(userId);
  let consentOk = false;
  if (pick) {
    if (!isExternalDocumentEgress(pick.providerType)) {
      // A local (self-hosted) vision pick never egresses — always eligible,
      // toggle-independent.
      consentOk = true;
    } else {
      // An external pick reads the document off the machine. The auto-index job
      // only egresses on upload when the operator opted in; the toggle IS the
      // standing consent (the document consent gate short-circuits on it). OFF
      // → local-only, even if an unrelated receipt exists.
      consentOk = await documentAutoReadEnabled(userId);
    }
  }
  const dailyCap =
    pick && consentOk
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
