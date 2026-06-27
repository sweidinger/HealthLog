import { NextRequest } from "next/server";
import { apiHandler, requireAuth, HttpError } from "@/lib/api-handler";
import { prisma } from "@/lib/db";
import { apiSuccess, apiError, safeJson } from "@/lib/api-response";
import { isPublicUrl } from "@/lib/validations/notifications";
import { isLocalAiHostAllowed } from "@/lib/ai/local-host-allowlist";
import { encrypt, decrypt } from "@/lib/crypto";
import { resolveProviderAvailability } from "@/lib/ai/provider";
import { annotate } from "@/lib/logging/context";

export const dynamic = "force-dynamic";

const ALLOWED = new Set(["OPENAI", "ANTHROPIC", "LOCAL", "CHATGPT_OAUTH"]);
// v1.22 (#90) — the dedicated document-scan provider has no OAuth path, so the
// allowlist is the three keyed/self-hosted providers only (no CHATGPT_OAUTH).
const OCR_PROVIDERS = new Set(["OPENAI", "ANTHROPIC", "LOCAL"]);

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "user.ai-provider.get" } });

  const u = await prisma.user.findUnique({
    where: { id: user.id },
    select: {
      aiProvider: true,
      aiModel: true,
      aiBaseUrl: true,
      aiAnthropicKeyEncrypted: true,
      aiLocalKeyEncrypted: true,
      aiOpenaiKeyEncrypted: true,
      // v1.22 (#89 + #90)
      aiResponseTimeoutSeconds: true,
      aiOcrEnabled: true,
      aiOcrProvider: true,
      aiOcrModel: true,
      aiOcrBaseUrl: true,
      aiOcrKeyEncrypted: true,
    },
  });

  // Effective availability: surfaces whether ANY provider can serve this
  // user — including the operator's admin-managed key when the user has set
  // no personal provider. iOS keys its Coach visibility off `aiAvailable` so
  // a server-managed provider is no longer invisible to the client.
  // `managedBy` reports the origin only; no admin keys/endpoints are leaked.
  const { aiAvailable, managedBy } = await resolveProviderAvailability(user.id);

  return apiSuccess({
    provider: u?.aiProvider ?? null,
    model: u?.aiModel ?? null,
    baseUrl: u?.aiBaseUrl ?? null,
    aiAvailable,
    managedBy,
    hasAnthropicKey: Boolean(u?.aiAnthropicKeyEncrypted),
    anthropicKeyPreview: u?.aiAnthropicKeyEncrypted
      ? `...${decrypt(u.aiAnthropicKeyEncrypted).slice(-4)}`
      : null,
    hasLocalKey: Boolean(u?.aiLocalKeyEncrypted),
    hasOpenaiKey: Boolean(u?.aiOpenaiKeyEncrypted),
    openaiKeyPreview: u?.aiOpenaiKeyEncrypted
      ? `...${decrypt(u.aiOpenaiKeyEncrypted).slice(-4)}`
      : null,
    // v1.22 (#89) — per-user response timeout, in seconds (null = default).
    responseTimeoutSeconds: u?.aiResponseTimeoutSeconds ?? null,
    // v1.22 (#90) — dedicated document-scan (Lab-OCR) provider config. Key
    // material is presence + 4-char preview only, like every other provider.
    ocrEnabled: Boolean(u?.aiOcrEnabled),
    ocrProvider: u?.aiOcrProvider ?? null,
    ocrModel: u?.aiOcrModel ?? null,
    ocrBaseUrl: u?.aiOcrBaseUrl ?? null,
    hasOcrKey: Boolean(u?.aiOcrKeyEncrypted),
    ocrKeyPreview: u?.aiOcrKeyEncrypted
      ? `...${decrypt(u.aiOcrKeyEncrypted).slice(-4)}`
      : null,
  });
});

export const PATCH = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "user.ai-provider.update" } });

  const { data: body, error } = await safeJson<Record<string, unknown>>(
    request,
    { maxBytes: 64 * 1024 },
  );
  if (error) return error;

  const updates: Record<string, unknown> = {};

  if (body.provider !== undefined) {
    if (body.provider === null || body.provider === "") {
      updates.aiProvider = null;
    } else if (
      typeof body.provider === "string" &&
      ALLOWED.has(body.provider)
    ) {
      updates.aiProvider = body.provider;
    } else {
      throw new HttpError(422, "Invalid provider");
    }
  }

  if (body.model !== undefined) {
    if (body.model === null || body.model === "") {
      updates.aiModel = null;
    } else if (typeof body.model === "string") {
      updates.aiModel = body.model.trim() || null;
    }
  }

  if (body.baseUrl !== undefined) {
    if (body.baseUrl === null || body.baseUrl === "") {
      updates.aiBaseUrl = null;
    } else if (typeof body.baseUrl === "string") {
      const trimmed = body.baseUrl.trim();
      // SSRF guard: by default reject private/internal hostnames so a
      // compromised user account cannot point the server at the cloud
      // metadata endpoint or internal admin panels. v1.18.7 (SECURITY LOW) —
      // ops opt in via `ALLOW_LOCAL_AI_PRIVATE_HOSTS`, now a host allowlist:
      // `true` permits any private host (legacy), a comma-separated host list
      // permits only those exact hostnames.
      const allowPrivate = isLocalAiHostAllowed(trimmed);
      if (!allowPrivate && !isPublicUrl(trimmed)) {
        return apiError(
          "Base URL points to an internal/private host. Ops must allow it on this instance via ALLOW_LOCAL_AI_PRIVATE_HOSTS — set it to the exact host (e.g. ollama.lan) or to true for any private host (intended for self-hosted Ollama / LM Studio).",
          422,
        );
      }
      updates.aiBaseUrl = trimmed;
    }
  }

  if (body.anthropicKey !== undefined) {
    if (body.anthropicKey === null || body.anthropicKey === "") {
      updates.aiAnthropicKeyEncrypted = null;
    } else if (typeof body.anthropicKey === "string") {
      updates.aiAnthropicKeyEncrypted = encrypt(body.anthropicKey.trim());
    }
  }

  if (body.localKey !== undefined) {
    if (body.localKey === null || body.localKey === "") {
      updates.aiLocalKeyEncrypted = null;
    } else if (typeof body.localKey === "string") {
      updates.aiLocalKeyEncrypted = encrypt(body.localKey.trim());
    }
  }

  if (body.openaiKey !== undefined) {
    if (body.openaiKey === null || body.openaiKey === "") {
      updates.aiOpenaiKeyEncrypted = null;
    } else if (typeof body.openaiKey === "string") {
      updates.aiOpenaiKeyEncrypted = encrypt(body.openaiKey.trim());
    }
  }

  // ── v1.22 (#89) — response timeout (seconds) ──────────────────
  if (body.responseTimeoutSeconds !== undefined) {
    if (body.responseTimeoutSeconds === null) {
      updates.aiResponseTimeoutSeconds = null;
    } else if (
      typeof body.responseTimeoutSeconds === "number" &&
      Number.isInteger(body.responseTimeoutSeconds)
    ) {
      // Sane bounds: 10 s floor (a stricter value just trips the timeout) and
      // 600 s ceiling (a generous cap for a slow self-hosted backend).
      if (
        body.responseTimeoutSeconds < 10 ||
        body.responseTimeoutSeconds > 600
      ) {
        throw new HttpError(
          422,
          "Response timeout must be between 10 and 600 seconds",
        );
      }
      updates.aiResponseTimeoutSeconds = body.responseTimeoutSeconds;
    } else {
      throw new HttpError(422, "Invalid response timeout");
    }
  }

  // ── v1.22 (#90) — dedicated document-scan (Lab-OCR) provider ──
  if (body.ocrEnabled !== undefined) {
    if (typeof body.ocrEnabled === "boolean") {
      updates.aiOcrEnabled = body.ocrEnabled;
    } else {
      throw new HttpError(422, "Invalid ocrEnabled");
    }
  }

  if (body.ocrProvider !== undefined) {
    if (body.ocrProvider === null || body.ocrProvider === "") {
      updates.aiOcrProvider = null;
    } else if (
      typeof body.ocrProvider === "string" &&
      OCR_PROVIDERS.has(body.ocrProvider)
    ) {
      updates.aiOcrProvider = body.ocrProvider;
    } else {
      throw new HttpError(422, "Invalid OCR provider");
    }
  }

  if (body.ocrModel !== undefined) {
    if (body.ocrModel === null || body.ocrModel === "") {
      updates.aiOcrModel = null;
    } else if (typeof body.ocrModel === "string") {
      updates.aiOcrModel = body.ocrModel.trim() || null;
    }
  }

  if (body.ocrBaseUrl !== undefined) {
    if (body.ocrBaseUrl === null || body.ocrBaseUrl === "") {
      updates.aiOcrBaseUrl = null;
    } else if (typeof body.ocrBaseUrl === "string") {
      const trimmed = body.ocrBaseUrl.trim();
      // Same SSRF guard as the main LOCAL base URL: reject private/internal
      // hosts unless the operator opted in via ALLOW_LOCAL_AI_PRIVATE_HOSTS.
      const allowPrivate = isLocalAiHostAllowed(trimmed);
      if (!allowPrivate && !isPublicUrl(trimmed)) {
        return apiError(
          "OCR base URL points to an internal/private host. Ops must allow it on this instance via ALLOW_LOCAL_AI_PRIVATE_HOSTS.",
          422,
        );
      }
      updates.aiOcrBaseUrl = trimmed;
    }
  }

  if (body.ocrKey !== undefined) {
    if (body.ocrKey === null || body.ocrKey === "") {
      updates.aiOcrKeyEncrypted = null;
    } else if (typeof body.ocrKey === "string") {
      updates.aiOcrKeyEncrypted = encrypt(body.ocrKey.trim());
    }
  }

  if (Object.keys(updates).length === 0) {
    throw new HttpError(422, "No valid fields");
  }

  // When the provider switches away from LOCAL, drop any stored
  // `aiBaseUrl`. The column is shared across providers, so without
  // this a user who once configured LOCAL → http://192.168.x.x and
  // then switched to OPENAI/ANTHROPIC would have their cloud key
  // sent to that URL on the next request. Only LOCAL legitimately
  // uses a custom base URL.
  if (
    typeof updates.aiProvider === "string" &&
    updates.aiProvider !== "LOCAL" &&
    !("aiBaseUrl" in updates)
  ) {
    updates.aiBaseUrl = null;
  }

  await prisma.user.update({ where: { id: user.id }, data: updates });

  return apiSuccess({ updated: true });
});
