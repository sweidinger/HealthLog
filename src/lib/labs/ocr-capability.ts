/**
 * v1.18.9 — resolve whether a user's configured AI provider can read images,
 * and (for the extract route) pick the first vision-capable provider instance.
 *
 * Capability is a function of (providerType, model). The user's `aiModel`
 * applies to a per-user provider entry; the operator's `adminAiModel` applies
 * to the `admin-openai` fallback entry. We resolve the chain instances via
 * `resolveProviderChain` (so credentials + Codex-token refresh are handled in
 * one place) and pair each surviving entry with the model that drives its
 * vision allowlist.
 */
import type { ProviderChainResolved } from "@/lib/ai/provider-runner";
import { resolveProvider, resolveOcrProviderChain } from "@/lib/ai/provider";
import { resolveCodexVisionSlug } from "@/lib/ai/codex-client";
import { prisma } from "@/lib/db";
import {
  supportsPdfForProvider,
  supportsVisionForConfig,
  type VisionProviderType,
} from "@/lib/ai/vision-capability";
import type { OcrCapabilityDto } from "@/lib/validations/labs-ocr";

interface ModelContext {
  /** The user's selected model (per-user provider entries). */
  userModel: string | null;
  /** The operator's admin-key model (the `admin-openai` chain entry). */
  adminModel: string | null;
}

/** The model that drives a chain entry's vision allowlist. */
function modelForEntry(
  providerType: ProviderChainResolved["providerType"],
  ctx: ModelContext,
): string | null {
  // Codex resolves its working slug at request time from the OAuth slug
  // fallback chain — NOT from the user's `aiModel`. Use the cached/chain-head
  // slug so the codex vision gate tests the model that actually runs.
  if (providerType === "codex") return resolveCodexVisionSlug();
  return providerType === "admin-openai" ? ctx.adminModel : ctx.userModel;
}

/**
 * A transform applied to the resolved provider chain before the vision/text
 * pick is made. Identity by default (labs behaviour unchanged); the document
 * class passes a reorder that demotes external/train-by-default providers below
 * local (see `@/lib/documents/provider-order`).
 */
export type ChainReorder = (
  chain: ProviderChainResolved[],
) => ProviderChainResolved[];

export interface ResolveProviderOptions {
  /** Reorder the resolved chain before picking. Defaults to identity. */
  reorder?: ChainReorder;
}

/** A vision-capable provider pick: its instance, logical tag, and model. */
export interface VisionProviderPick {
  /** The full resolved chain (for `assertConsentForChain`). */
  chain: ProviderChainResolved[];
  /** The first vision-capable entry, or null when none can read images. */
  pick: {
    entry: ProviderChainResolved;
    providerType: VisionProviderType;
    pdfSupported: boolean;
  } | null;
  /** Whether the user opted into local (in-browser) OCR for text-only providers. */
  localOcrEnabled: boolean;
}

/**
 * Resolve the user's provider chain and find the first entry that can read
 * images. Returns the whole chain (the consent gate needs it) plus the chosen
 * vision entry (or null). Mirrors the Coach's chain-then-legacy fallback so a
 * user served only by the operator's admin key is still covered.
 */
export async function resolveVisionProvider(
  userId: string,
  options?: ResolveProviderOptions,
): Promise<VisionProviderPick> {
  const userRow = await prisma.user.findUnique({
    where: { id: userId },
    select: { aiModel: true, labsLocalOcrEnabled: true },
  });
  const settings = await prisma.appSettings.findUnique({
    where: { id: "singleton" },
    select: { adminAiModel: true },
  });

  const localOcrEnabled = userRow?.labsLocalOcrEnabled ?? false;

  // v1.22 (#90) — resolve the OCR chain: the dedicated document-scan provider
  // when the user enabled one, else the main provider chain unchanged. When a
  // dedicated provider is active, ITS model drives the vision allowlist.
  const ocr = await resolveOcrProviderChain(userId);
  const ctx: ModelContext = {
    userModel: ocr.dedicated
      ? (ocr.ocrModelOverride ?? userRow?.aiModel ?? null)
      : (userRow?.aiModel ?? null),
    adminModel: settings?.adminAiModel ?? null,
  };

  const resolvedChain = ocr.chain;
  if (resolvedChain.length === 0) {
    // Mirror the Coach: fall back to the legacy single-provider resolution and
    // tag it as the admin-managed entry the consent gate recognises.
    const legacy = await resolveProvider(userId);
    if (legacy.type !== "none") {
      resolvedChain.push({ providerType: "admin-openai", instance: legacy });
    }
  }

  // Apply the caller's reorder (document class demotes external providers below
  // local) before picking; labs passes no reorder → identity.
  const chain = options?.reorder
    ? options.reorder(resolvedChain)
    : resolvedChain;

  for (const entry of chain) {
    const providerType = entry.providerType as VisionProviderType;
    const model = modelForEntry(entry.providerType, ctx);
    if (supportsVisionForConfig(providerType, model)) {
      return {
        chain,
        localOcrEnabled,
        pick: {
          entry,
          providerType,
          pdfSupported: supportsPdfForProvider(providerType),
        },
      };
    }
  }

  return { chain, localOcrEnabled, pick: null };
}

/**
 * Resolve the provider chain for a TEXT-mode (local-OCR) extract. There is no
 * vision requirement here — ANY configured provider can structure OCR'd text —
 * so this returns the whole chain plus the first entry to drive the structuring
 * call. Returns `null` when nothing is configured.
 */
export async function resolveTextProvider(
  userId: string,
  options?: ResolveProviderOptions,
): Promise<{
  chain: ProviderChainResolved[];
  pick: { entry: ProviderChainResolved; providerType: string } | null;
}> {
  // v1.22 (#90) — use the dedicated document-scan provider when enabled, else
  // the main chain (the text-mode structuring pass needs no vision).
  const resolvedChain = (await resolveOcrProviderChain(userId)).chain;
  if (resolvedChain.length === 0) {
    const legacy = await resolveProvider(userId);
    if (legacy.type !== "none") {
      resolvedChain.push({ providerType: "admin-openai", instance: legacy });
    }
  }
  const chain = options?.reorder
    ? options.reorder(resolvedChain)
    : resolvedChain;
  const entry = chain[0];
  return {
    chain,
    pick: entry ? { entry, providerType: entry.providerType } : null,
  };
}

/**
 * The cheap capability DTO for the probe endpoint: whether scanning is
 * available + why not + whether PDFs are accepted. Built from the same
 * resolution the extract route uses, so the UI never shows an entry the
 * extract route would 422.
 */
export async function resolveOcrCapability(
  userId: string,
  options?: ResolveProviderOptions,
): Promise<OcrCapabilityDto> {
  const { chain, pick, localOcrEnabled } = await resolveVisionProvider(
    userId,
    options,
  );

  // Prefer the native vision path whenever it is available — it is more
  // accurate and the client does not download the OCR WASM.
  if (pick) {
    return {
      available: true,
      mode: "vision",
      reason: null,
      pdfSupported: pick.pdfSupported,
    };
  }

  // No vision pick. Nothing configured at all → no-provider, regardless of the
  // toggle (there is no provider to structure the OCR text).
  if (chain.length === 0) {
    return {
      available: false,
      mode: null,
      reason: "no-provider",
      pdfSupported: false,
    };
  }

  // A provider IS configured but it can't read images. Local OCR is the
  // text-only fallback: in-browser OCR → text → the configured provider. It is
  // available only when the user opted in.
  if (localOcrEnabled) {
    // Text mode is image-only (tesseract.js can't read PDFs).
    return {
      available: true,
      mode: "text",
      reason: null,
      pdfSupported: false,
    };
  }

  // A text-only provider is configured but the user has not enabled local OCR —
  // surface the actionable reason so the UI can point at the toggle.
  return {
    available: false,
    mode: null,
    reason: "enable-local-ocr",
    pdfSupported: false,
  };
}
