import type { NextRequest } from "next/server";
import { z } from "zod/v4";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import {
  resolveProviderForTest,
  AITestConfigError,
  type AITestOverride,
} from "@/lib/ai/provider";
import { apiSuccess, apiError, safeJson } from "@/lib/api-response";
import { checkRateLimit } from "@/lib/rate-limit";
import { annotate } from "@/lib/logging/context";

export const dynamic = "force-dynamic";

const overrideSchema = z
  .object({
    provider: z
      .enum(["OPENAI", "ANTHROPIC", "LOCAL", "CHATGPT_OAUTH"])
      .optional()
      .nullable(),
    model: z.string().min(1).max(120).optional().nullable(),
    baseUrl: z.string().url().max(2048).optional().nullable(),
    anthropicKey: z.string().min(1).max(500).optional().nullable(),
    localKey: z.string().min(1).max(500).optional().nullable(),
    openaiKey: z.string().min(1).max(500).optional().nullable(),
  })
  .strict();

export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "ai.test" } });

  const rl = await checkRateLimit(`ai-test:${user.id}`, 5, 60_000);
  if (!rl.allowed) return apiError("Too many test requests", 429);

  // Body is optional. Empty body → behaves like before (test the saved
  // config). Non-empty body → tests the unsaved selection without
  // mutating the user row. Plaintext keys never persist.
  let override: AITestOverride = {};
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > 0) {
    const { data, error } = await safeJson<unknown>(request);
    if (error) return error;
    const parsed = overrideSchema.safeParse(data);
    if (!parsed.success) {
      return apiError("Invalid override payload", 422);
    }
    override = parsed.data;
  }

  let provider;
  try {
    provider = await resolveProviderForTest(user.id, override);
  } catch (e) {
    if (e instanceof AITestConfigError) {
      return apiError(e.message, e.status);
    }
    throw e;
  }

  if (provider.type === "none") {
    return apiError("No AI provider configured", 422);
  }

  try {
    const result = await provider.generateCompletion({
      systemPrompt: "You are a connection-test responder.",
      userPrompt: 'Reply with the JSON object {"ok": true} and nothing else.',
      temperature: 0,
      maxTokens: 32,
    });

    return apiSuccess({
      ok: true,
      providerType: result.providerType,
      model: result.model,
      tokensUsed: result.tokensUsed,
      sample: result.content.slice(0, 200),
    });
  } catch (e) {
    // V3 audit: do not return provider error message + bodyExcerpt to the
    // client (leaks provider URL / partial keys / internal headers).
    // Log full details server-side for the operator and respond with a
    // categorised, generic reason.
    const err = e as Error & { httpStatus?: number; bodyExcerpt?: string };
    annotate({
      meta: {
        ai_test_error: err.message.slice(0, 500),
        ai_test_status: err.httpStatus ?? null,
        ai_test_body_excerpt: err.bodyExcerpt?.slice(0, 500) ?? null,
        ai_test_provider: provider.type,
      },
    });
    // This route MUST NEVER return a 5xx. A 5xx origin response is
    // rewritten by Cloudflare / the reverse proxy to its own HTML error
    // page, so the browser's `res.json()` crashes with
    // `Unexpected token '<', "<!DOCTYPE "` (Safari: "The string did not
    // match the expected pattern"). That is exactly the failure an
    // operator hit re-authenticating a provider whose token came back as
    // an invalidated-session 500. We always reply 200 with a categorised,
    // secret-free `{ ok:false, reason }` the client can show verbatim.
    const reason = classifyTestFailure(err);
    return apiSuccess({ ok: false, providerType: provider.type, reason });
  }
});

/**
 * Map an upstream provider failure to a human-readable, secret-free
 * reason string. Distinguishes credential/auth, rate-limit, provider
 * server-error and network/timeout classes. A 5xx whose body carries an
 * auth signal (invalidated session token, expired key, "sign in again")
 * is reclassified as a credential failure — that is the shape the
 * operator's re-auth produced, where the gateway answered 500 instead of
 * the expected 401.
 */
function classifyTestFailure(
  err: Error & { httpStatus?: number; bodyExcerpt?: string },
): string {
  const status = err.httpStatus ?? 0;
  const haystack = `${err.message} ${err.bodyExcerpt ?? ""}`;
  const looksLikeAuth =
    /authentication|invalidated|expired|sign in again|api key/i.test(haystack);

  if (status === 401 || status === 403 || (status >= 500 && looksLikeAuth)) {
    return "Provider rejected the credentials — re-authenticate in AI settings.";
  }
  if (status === 429) {
    return "Provider rate-limited the request — try again shortly.";
  }
  if (status >= 500) {
    return "The AI provider returned a server error.";
  }
  if (status === 0) {
    return "Could not reach the AI provider.";
  }
  return "Could not reach the AI provider.";
}
