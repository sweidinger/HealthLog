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
import { resolveProvider, resolveProviderChain } from "@/lib/ai/provider";
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
  return providerType === "admin-openai" ? ctx.adminModel : ctx.userModel;
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
}

/**
 * Resolve the user's provider chain and find the first entry that can read
 * images. Returns the whole chain (the consent gate needs it) plus the chosen
 * vision entry (or null). Mirrors the Coach's chain-then-legacy fallback so a
 * user served only by the operator's admin key is still covered.
 */
export async function resolveVisionProvider(
  userId: string,
): Promise<VisionProviderPick> {
  const userRow = await prisma.user.findUnique({
    where: { id: userId },
    select: { aiModel: true },
  });
  const settings = await prisma.appSettings.findUnique({
    where: { id: "singleton" },
    select: { adminAiModel: true },
  });
  const ctx: ModelContext = {
    userModel: userRow?.aiModel ?? null,
    adminModel: settings?.adminAiModel ?? null,
  };

  const chain = await resolveProviderChain(userId);
  if (chain.length === 0) {
    // Mirror the Coach: fall back to the legacy single-provider resolution and
    // tag it as the admin-managed entry the consent gate recognises.
    const legacy = await resolveProvider(userId);
    if (legacy.type !== "none") {
      chain.push({ providerType: "admin-openai", instance: legacy });
    }
  }

  for (const entry of chain) {
    const providerType = entry.providerType as VisionProviderType;
    const model = modelForEntry(entry.providerType, ctx);
    if (supportsVisionForConfig(providerType, model)) {
      return {
        chain,
        pick: {
          entry,
          providerType,
          pdfSupported: supportsPdfForProvider(providerType),
        },
      };
    }
  }

  return { chain, pick: null };
}

/**
 * The cheap capability DTO for the probe endpoint: whether scanning is
 * available + why not + whether PDFs are accepted. Built from the same
 * resolution the extract route uses, so the UI never shows an entry the
 * extract route would 422.
 */
export async function resolveOcrCapability(
  userId: string,
): Promise<OcrCapabilityDto> {
  const { chain, pick } = await resolveVisionProvider(userId);
  if (pick) {
    return { available: true, reason: null, pdfSupported: pick.pdfSupported };
  }
  // No vision pick. Distinguish "nothing configured" from "a provider is
  // configured but its model is text-only" so the UI can phrase it.
  const reason = chain.length === 0 ? "no-provider" : "text-only-model";
  return { available: false, reason, pdfSupported: false };
}
