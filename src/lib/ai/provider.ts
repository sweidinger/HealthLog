import type { AIProvider, CompletionParams, CompletionResult } from "./types";
import { prisma } from "@/lib/db";
import { decrypt, encrypt } from "@/lib/crypto";
import { CodexClient } from "./codex-client";
import { OpenAIClient } from "./openai-client";
import { AnthropicClient } from "./anthropic-client";
import { LocalOpenAICompatibleClient } from "./local-client";
import { refreshDeviceTokens } from "./codex-oauth";
import { isPublicUrl } from "@/lib/validations/notifications";

const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000; // 5 minutes

class NoProvider implements AIProvider {
  readonly type = "none" as const;

  async generateCompletion(
    _params: CompletionParams,
  ): Promise<CompletionResult> {
    throw new Error(
      "No AI provider configured. Connect ChatGPT or set an API key in settings.",
    );
  }
}

type UserAIRow = {
  aiProvider: string | null;
  aiModel: string | null;
  aiBaseUrl: string | null;
  aiAnthropicKeyEncrypted: string | null;
  aiLocalKeyEncrypted: string | null;
  aiOpenaiKeyEncrypted: string | null;
};

/**
 * Build a provider from a user-level config row. Returns null if the row does
 * not select a usable per-user provider (caller falls back to admin/codex).
 */
function buildUserProvider(row: UserAIRow): AIProvider | null {
  const choice = row.aiProvider?.toUpperCase();
  if (!choice) return null;

  switch (choice) {
    case "ANTHROPIC": {
      if (!row.aiAnthropicKeyEncrypted) return null;
      // Belt-and-braces: even if a stale `aiBaseUrl` from a prior LOCAL
      // configuration survived in the row, refuse to forward an Anthropic
      // key to it. Anthropic has no per-tenant base URL the UI exposes;
      // the SDK default is correct.
      return new AnthropicClient({
        apiKey: decrypt(row.aiAnthropicKeyEncrypted),
        model: row.aiModel ?? "claude-3-5-sonnet-latest",
      });
    }
    case "LOCAL": {
      if (!row.aiBaseUrl) return null;
      return new LocalOpenAICompatibleClient({
        apiKey: row.aiLocalKeyEncrypted
          ? decrypt(row.aiLocalKeyEncrypted)
          : null,
        model: row.aiModel ?? "local-model",
        baseUrl: row.aiBaseUrl,
      });
    }
    case "OPENAI": {
      // v1.4.3: user-level OpenAI key gets first crack — only fall back
      // to the admin key if the user hasn't supplied their own. The
      // model-default mirrors the admin path for consistency so a saved
      // user "OPENAI" without an explicit model still produces an
      // OpenAIClient with `gpt-4o-mini`.
      // Belt-and-braces: ignore any persisted `aiBaseUrl`. The column is
      // shared with LOCAL, so a stale LAN URL there would otherwise
      // redirect the user's OpenAI key to a private host.
      if (!row.aiOpenaiKeyEncrypted) return null;
      return new OpenAIClient({
        apiKey: decrypt(row.aiOpenaiKeyEncrypted),
        model: row.aiModel ?? "gpt-4o-mini",
        baseUrl: "https://api.openai.com/v1",
      });
    }
    case "CHATGPT_OAUTH":
      // Caller handles Codex OAuth via the dedicated branch; signal here.
      return null;
    default:
      return null;
  }
}

async function resolveAdminProvider(): Promise<AIProvider> {
  const settings = await prisma.appSettings.findUnique({
    where: { id: "singleton" },
  });

  if (settings?.adminAiKeyEncrypted) {
    return new OpenAIClient({
      apiKey: decrypt(settings.adminAiKeyEncrypted),
      model: settings.adminAiModel ?? "gpt-4o-mini",
      baseUrl: settings.adminAiBaseUrl ?? "https://api.openai.com/v1",
    });
  }

  return new NoProvider();
}

/**
 * Codex flow (v1.4.8+, device-code path): the user authorised against
 * chatgpt.com/codex/device, we store the resulting OAuth access_token
 * (encrypted) in `codexAccessTokenEncrypted` and the refresh_token in
 * `codexRefreshTokenEncrypted`. The active token is forwarded to
 * `https://chatgpt.com/backend-api/codex/responses` — the same Codex
 * backend the official CLI uses, which bills against the user's
 * ChatGPT subscription. When the access token is about to expire we
 * refresh it transparently using the long-lived refresh token.
 *
 * Note: v1.4.7's authorisation-code-flow path also wrote to these
 * columns, but stored an OpenAI API key (post-RFC-8693 exchange)
 * rather than an OAuth access token. That path is dead in production
 * because Hydra rejects our redirect URI. The device-code path is the
 * canonical replacement.
 */
async function resolveCodexProvider(
  userId: string,
): Promise<AIProvider | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      codexAccessTokenEncrypted: true,
      codexRefreshTokenEncrypted: true,
      codexTokenExpiresAt: true,
      codexConnectionStatus: true,
    },
  });

  if (
    user?.codexConnectionStatus !== "connected" ||
    !user.codexAccessTokenEncrypted ||
    !user.codexRefreshTokenEncrypted
  ) {
    return null;
  }

  const storedAccessToken = decrypt(user.codexAccessTokenEncrypted);
  const storedRefreshToken = decrypt(user.codexRefreshTokenEncrypted);

  let activeAccessToken = storedAccessToken;

  // Proactive refresh if the access token expires within 5 minutes.
  const expiresAt = user.codexTokenExpiresAt?.getTime() ?? 0;
  if (expiresAt < Date.now() + TOKEN_REFRESH_BUFFER_MS) {
    try {
      const fresh = await refreshDeviceTokens(storedRefreshToken);
      activeAccessToken = fresh.accessToken;

      await prisma.user.update({
        where: { id: userId },
        data: {
          codexAccessTokenEncrypted: encrypt(fresh.accessToken),
          codexRefreshTokenEncrypted: encrypt(fresh.refreshToken),
          codexTokenExpiresAt: fresh.expiresAt,
        },
      });
    } catch {
      // Proactive refresh failures fall through — the CodexClient
      // retries via onTokenRefresh on a real 401 and writes the
      // updated tokens then.
    }
  }

  return new CodexClient({
    accessToken: activeAccessToken,
    onTokenRefresh: async () => {
      const freshUser = await prisma.user.findUnique({
        where: { id: userId },
        select: { codexRefreshTokenEncrypted: true },
      });
      if (!freshUser?.codexRefreshTokenEncrypted) {
        throw new Error("No refresh token available");
      }
      const currentRefresh = decrypt(freshUser.codexRefreshTokenEncrypted);
      const fresh = await refreshDeviceTokens(currentRefresh);
      await prisma.user.update({
        where: { id: userId },
        data: {
          codexAccessTokenEncrypted: encrypt(fresh.accessToken),
          codexRefreshTokenEncrypted: encrypt(fresh.refreshToken),
          codexTokenExpiresAt: fresh.expiresAt,
        },
      });
      return fresh.accessToken;
    },
  });
}

/**
 * Resolve the AI provider for a given user.
 *
 * Priority:
 *   1. User selected ANTHROPIC / LOCAL with valid creds → that provider.
 *   2. User selected CHATGPT_OAUTH (or no explicit choice but Codex tokens
 *      are connected) → Codex.
 *   3. User selected OPENAI (or no creds for the chosen provider) → admin
 *      OpenAI key from app_settings.
 *   4. Nothing configured → NoProvider().
 */
export async function resolveProvider(userId: string): Promise<AIProvider> {
  const userRow = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      aiProvider: true,
      aiModel: true,
      aiBaseUrl: true,
      aiAnthropicKeyEncrypted: true,
      aiLocalKeyEncrypted: true,
      aiOpenaiKeyEncrypted: true,
    },
  });

  // 1. Per-user Anthropic / Local
  if (userRow) {
    const userProvider = buildUserProvider(userRow);
    if (userProvider) return userProvider;
  }

  // 2. Codex OAuth (either explicitly selected or implicit fallback)
  const explicitChoice = userRow?.aiProvider?.toUpperCase();
  const tryCodex = explicitChoice === "CHATGPT_OAUTH" || !explicitChoice;
  if (tryCodex) {
    const codex = await resolveCodexProvider(userId);
    if (codex) return codex;
  }

  // 3. Admin OpenAI key (also acts as fallback for user-OPENAI selection)
  return resolveAdminProvider();
}

/**
 * Override that the connection-test endpoint accepts so the user can
 * verify a provider config they have NOT saved yet (dropdown change → test
 * before commit). Plaintext keys never persist.
 */
export type AITestOverride = {
  provider?: string | null;
  model?: string | null;
  baseUrl?: string | null;
  anthropicKey?: string | null;
  localKey?: string | null;
  openaiKey?: string | null;
};

export class AITestConfigError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "AITestConfigError";
    this.status = status;
  }
}

/**
 * Resolve the provider for `/api/ai/test`. Falls back to the persisted user
 * config when the matching override field is empty, so a user with a stored
 * Anthropic key can change the model in the dropdown and test it without
 * re-typing the key. The base URL still goes through the SSRF guard.
 */
export async function resolveProviderForTest(
  userId: string,
  override: AITestOverride = {},
): Promise<AIProvider> {
  const stored = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      aiProvider: true,
      aiModel: true,
      aiBaseUrl: true,
      aiAnthropicKeyEncrypted: true,
      aiLocalKeyEncrypted: true,
      aiOpenaiKeyEncrypted: true,
    },
  });

  const provider = (override.provider ?? stored?.aiProvider ?? "")
    .toString()
    .trim()
    .toUpperCase();
  const model = (override.model ?? stored?.aiModel ?? "").toString().trim();
  const baseUrl = (override.baseUrl ?? stored?.aiBaseUrl ?? "")
    .toString()
    .trim();

  // Empty selection: fall back to Codex → admin OpenAI like the regular path.
  if (!provider) {
    const codex = await resolveCodexProvider(userId);
    if (codex) return codex;
    return resolveAdminProvider();
  }

  switch (provider) {
    case "ANTHROPIC": {
      const apiKey =
        override.anthropicKey?.trim() ||
        (stored?.aiAnthropicKeyEncrypted
          ? decrypt(stored.aiAnthropicKeyEncrypted)
          : "");
      if (!apiKey) {
        throw new AITestConfigError(422, "Anthropic API key not configured");
      }
      // Anthropic has no UI base-URL input. Ignore the merged value to
      // avoid leaking the key to a stale LOCAL URL still parked in the
      // shared column.
      return new AnthropicClient({
        apiKey,
        model: model || "claude-3-5-sonnet-latest",
      });
    }
    case "LOCAL": {
      if (!baseUrl) {
        throw new AITestConfigError(422, "Local provider requires a base URL");
      }
      const allowPrivate = process.env.ALLOW_LOCAL_AI_PRIVATE_HOSTS === "true";
      if (!allowPrivate && !isPublicUrl(baseUrl)) {
        throw new AITestConfigError(
          422,
          "Base URL points to an internal/private host",
        );
      }
      const apiKey =
        override.localKey?.trim() ||
        (stored?.aiLocalKeyEncrypted
          ? decrypt(stored.aiLocalKeyEncrypted)
          : null);
      return new LocalOpenAICompatibleClient({
        apiKey,
        model: model || "local-model",
        baseUrl,
      });
    }
    case "CHATGPT_OAUTH": {
      const codex = await resolveCodexProvider(userId);
      if (codex) return codex;
      throw new AITestConfigError(422, "ChatGPT OAuth is not connected");
    }
    case "OPENAI": {
      // Test path mirrors the persistent resolution: user key first,
      // admin fallback if absent. We accept an `openaiKey` override
      // from the test endpoint so a user can verify a not-yet-saved
      // key dropdown change without persisting anything. Always use
      // the canonical OpenAI base URL — the merged `baseUrl` may carry
      // a stale LOCAL URL through `stored.aiBaseUrl`.
      const userKey =
        override.openaiKey?.trim() ||
        (stored?.aiOpenaiKeyEncrypted
          ? decrypt(stored.aiOpenaiKeyEncrypted)
          : "");
      if (userKey) {
        return new OpenAIClient({
          apiKey: userKey,
          model: model || "gpt-4o-mini",
          baseUrl: "https://api.openai.com/v1",
        });
      }
      const admin = await resolveAdminProvider();
      if (admin.type === "none") {
        throw new AITestConfigError(
          422,
          "OpenAI key not configured (neither user nor admin)",
        );
      }
      return admin;
    }
    default:
      throw new AITestConfigError(422, `Unknown provider: ${provider}`);
  }
}
