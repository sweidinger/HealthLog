import type { AIProvider, CompletionResult } from "./types";
import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { CodexClient } from "./codex-client";
import { OpenAIClient } from "./openai-client";
import { AnthropicClient } from "./anthropic-client";
import { LocalOpenAICompatibleClient } from "./local-client";
import {
  refreshDeviceTokens,
  encryptCodexCreds,
  decryptCodexCreds,
} from "./codex-oauth";
import { isPublicUrl } from "@/lib/validations/notifications";
import { isLocalAiHostAllowed } from "./local-host-allowlist";
import { parseProviderChain, type ProviderChainType } from "./provider-chain";
import type { ProviderChainResolved } from "./provider-runner";

const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000; // 5 minutes

class NoProvider implements AIProvider {
  readonly type = "none" as const;

  async generateCompletion(): Promise<CompletionResult> {
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
        model: row.aiModel ?? "claude-sonnet-4-6",
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
      // OpenAIClient with the current full-size default `gpt-4o`.
      // Belt-and-braces: ignore any persisted `aiBaseUrl`. The column is
      // shared with LOCAL, so a stale LAN URL there would otherwise
      // redirect the user's OpenAI key to a private host.
      if (!row.aiOpenaiKeyEncrypted) return null;
      return new OpenAIClient({
        apiKey: decrypt(row.aiOpenaiKeyEncrypted),
        model: row.aiModel ?? "gpt-4o",
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
      model: settings.adminAiModel ?? "gpt-4o",
      baseUrl: settings.adminAiBaseUrl ?? "https://api.openai.com/v1",
    });
  }

  return new NoProvider();
}

/**
 * Codex provider — device-code path.
 *
 * `codexAccessTokenEncrypted` stores an encrypted JSON blob with the
 * OAuth access token AND the `chatgpt_account_id` claim from the
 * id_token (the latter is mandatory in the `ChatGPT-Account-ID`
 * header). `codexRefreshTokenEncrypted` continues to hold just the
 * refresh token. See `codex-oauth.ts` for the storage codec.
 *
 * Old v1.4.7-v1.4.11 rows that stored a raw token string instead of
 * the JSON envelope cannot be revived (the account id was never
 * captured), so `decryptCodexCreds` returns null and we treat the
 * connection as expired — the user re-runs the connect flow once.
 */
async function resolveCodexProvider(
  userId: string,
): Promise<AIProvider | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      codexAccessTokenEncrypted: true,
      codexRefreshTokenEncrypted: true,
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

  const stored = decryptCodexCreds({
    accessEncrypted: user.codexAccessTokenEncrypted,
    refreshEncrypted: user.codexRefreshTokenEncrypted,
  });
  if (!stored) {
    // Pre-v1.4.12 record without account_id — the token cannot
    // satisfy the ChatGPT-Account-ID header. Mark the row as
    // disconnected so the UI prompts the user to re-link.
    await prisma.user.update({
      where: { id: userId },
      data: { codexConnectionStatus: "expired" },
    });
    return null;
  }

  let active = stored;

  // Proactive refresh if the access token is within 5 min of expiry.
  if (stored.expiresAt.getTime() < Date.now() + TOKEN_REFRESH_BUFFER_MS) {
    try {
      const fresh = await refreshDeviceTokens(stored.refreshToken);
      active = fresh;

      const enc = encryptCodexCreds(fresh);
      await prisma.user.update({
        where: { id: userId },
        data: {
          codexAccessTokenEncrypted: enc.accessEncrypted,
          codexRefreshTokenEncrypted: enc.refreshEncrypted,
          codexTokenExpiresAt: fresh.expiresAt,
        },
      });
    } catch {
      // Fall through — CodexClient will trigger an on-401 refresh
      // and persist there.
    }
  }

  return new CodexClient({
    accessToken: active.accessToken,
    accountId: active.accountId,
    onTokenRefresh: async () => {
      const freshUser = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          codexAccessTokenEncrypted: true,
          codexRefreshTokenEncrypted: true,
        },
      });
      if (
        !freshUser?.codexAccessTokenEncrypted ||
        !freshUser.codexRefreshTokenEncrypted
      ) {
        throw new Error("No refresh token available");
      }
      const decoded = decryptCodexCreds({
        accessEncrypted: freshUser.codexAccessTokenEncrypted,
        refreshEncrypted: freshUser.codexRefreshTokenEncrypted,
      });
      if (!decoded) {
        throw new Error("Codex token storage corrupt; user must re-link");
      }
      const fresh = await refreshDeviceTokens(decoded.refreshToken);
      const enc = encryptCodexCreds(fresh);
      await prisma.user.update({
        where: { id: userId },
        data: {
          codexAccessTokenEncrypted: enc.accessEncrypted,
          codexRefreshTokenEncrypted: enc.refreshEncrypted,
          codexTokenExpiresAt: fresh.expiresAt,
        },
      });
      return { accessToken: fresh.accessToken, accountId: fresh.accountId };
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
 * v1.4.16 phase B5b — resolve a chain of providers in priority order
 * for the multi-provider fallback runner. Each entry pairs a logical
 * `providerType` with a constructed `AIProvider` instance ready to
 * accept `generateCompletion()` calls.
 *
 * Steps:
 *   1. Read `User.aiProviderChain` (or `PROVIDER_CHAIN_DEFAULT` when
 *      null). Already sorted + deduplicated by `parseProviderChain`.
 *   2. For each enabled entry, attempt to materialise the provider
 *      from the user's saved credentials. Drop entries that have no
 *      usable credential (e.g. chain says `anthropic` but
 *      `aiAnthropicKeyEncrypted` is null).
 *   3. Returns the surviving array — possibly empty if the user has
 *      no configured providers anywhere. Caller raises 422 in that
 *      case.
 *
 * Reused by the regular insight-generate route (B5b) AND the v1.4.17
 * feedback-attribution path (B5e) — both need the same resolution
 * semantics. `resolveProvider()` keeps its single-result shape for
 * the legacy `weight-status.ts` / `mood-status.ts` / etc. consumers
 * that have not migrated to the chain runner yet.
 */
export async function resolveProviderChain(
  userId: string,
): Promise<ProviderChainResolved[]> {
  const userRow = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      aiProvider: true,
      aiModel: true,
      aiBaseUrl: true,
      aiAnthropicKeyEncrypted: true,
      aiLocalKeyEncrypted: true,
      aiOpenaiKeyEncrypted: true,
      aiProviderChain: true,
    },
  });

  const rawChain = userRow?.aiProviderChain ?? null;
  const chain = parseProviderChain(rawChain).filter((e) => e.enabled);

  const resolved: ProviderChainResolved[] = [];
  for (const entry of chain) {
    const instance = await resolveProviderForType(entry.providerType, {
      userId,
      userRow,
    });
    if (instance) {
      resolved.push({ providerType: entry.providerType, instance });
    }
  }
  return resolved;
}

/**
 * Credential-presence subset of the `User` row that
 * `userRowHasProviderCredential` evaluates. Mirrors the columns
 * `resolveProviderChain` / `resolveProvider` read, but presence-only —
 * no decrypt, no client construction, no token refresh.
 */
export interface ProviderCredentialRow {
  aiProvider: string | null;
  aiProviderChain: unknown;
  aiAnthropicKeyEncrypted: string | null;
  aiLocalKeyEncrypted: string | null;
  aiOpenaiKeyEncrypted: string | null;
  aiBaseUrl: string | null;
  codexConnectionStatus: string | null;
  codexAccessTokenEncrypted: string | null;
  codexRefreshTokenEncrypted: string | null;
}

/**
 * Cheap, synchronous "is any provider configured?" check over an already
 * loaded credential row. Mirrors the resolution semantics of
 * `resolveProviderChain` + the legacy `resolveProvider` fallback (the
 * exact pair `generateComprehensiveInsight` uses to decide
 * `skipped: no-provider`), but evaluates credential PRESENCE only —
 * it never decrypts a key, constructs a client, or refreshes a Codex
 * token. A `true` here can still resolve to a dead provider at call
 * time (revoked key, unreachable local host); callers use it to decide
 * whether a generation is worth attempting at all, not as a liveness
 * probe.
 *
 * `adminKeyConfigured` is the presence of `appSettings.adminAiKeyEncrypted`
 * — passed in so batch callers can read it once for a whole cohort.
 */
export function userRowHasProviderCredential(
  row: ProviderCredentialRow,
  adminKeyConfigured: boolean,
): boolean {
  const codexConnected =
    row.codexConnectionStatus === "connected" &&
    !!row.codexAccessTokenEncrypted &&
    !!row.codexRefreshTokenEncrypted;

  const chain = parseProviderChain(row.aiProviderChain ?? null).filter(
    (e) => e.enabled,
  );
  for (const entry of chain) {
    switch (entry.providerType) {
      case "codex":
        if (codexConnected) return true;
        break;
      case "openai":
        if (row.aiOpenaiKeyEncrypted) return true;
        break;
      case "anthropic":
        if (row.aiAnthropicKeyEncrypted) return true;
        break;
      case "local":
        if (row.aiBaseUrl) return true;
        break;
      case "admin-openai":
        if (adminKeyConfigured) return true;
        break;
    }
  }

  // Legacy `resolveProvider()` fallback — only reached when the chain
  // resolves empty. Mirrors buildUserProvider → codex → admin in order.
  const choice = row.aiProvider?.toUpperCase();
  if (choice === "ANTHROPIC" && row.aiAnthropicKeyEncrypted) return true;
  if (choice === "LOCAL" && row.aiBaseUrl) return true;
  if (choice === "OPENAI" && row.aiOpenaiKeyEncrypted) return true;
  if ((choice === "CHATGPT_OAUTH" || !choice) && codexConnected) return true;
  return adminKeyConfigured;
}

/**
 * Async single-user variant of `userRowHasProviderCredential`: two
 * narrow presence reads (user credential columns + the admin key flag),
 * no decrypt, no network. Used by read paths that only need to know
 * whether a generation could ever produce provider-backed text (e.g.
 * the dashboard snapshot's `briefingState: "no-provider"`).
 */
export async function hasAnyConfiguredProvider(
  userId: string,
): Promise<boolean> {
  const userRow = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      aiProvider: true,
      aiProviderChain: true,
      aiAnthropicKeyEncrypted: true,
      aiLocalKeyEncrypted: true,
      aiOpenaiKeyEncrypted: true,
      aiBaseUrl: true,
      codexConnectionStatus: true,
      codexAccessTokenEncrypted: true,
      codexRefreshTokenEncrypted: true,
    },
  });
  if (!userRow) return false;
  const settings = await prisma.appSettings.findUnique({
    where: { id: "singleton" },
    select: { adminAiKeyEncrypted: true },
  });
  return userRowHasProviderCredential(
    userRow,
    !!settings?.adminAiKeyEncrypted,
  );
}

/**
 * Origin of the provider that would serve a given user, surfaced to
 * clients that need to show or hide an AI surface (the iOS Coach gate).
 *
 *   - "user"   — a personal cloud credential resolves (Codex OAuth, or a
 *                BYO OpenAI / Anthropic key).
 *   - "local"  — a per-user self-hosted base URL (Ollama / LM Studio).
 *   - "server" — no personal config, but the operator's admin-managed
 *                key serves the user. This is the case iOS #24 missed:
 *                the Coach works server-side yet the client saw `null`.
 *   - null     — nothing configured anywhere; no provider can serve.
 *
 * Presence-only, mirroring `userRowHasProviderCredential`: it never
 * decrypts a key, builds a client, or probes liveness.
 */
export type ProviderManagedBy = "user" | "local" | "server";

function resolveManagedByFromRow(
  row: ProviderCredentialRow,
  adminKeyConfigured: boolean,
): ProviderManagedBy | null {
  const codexConnected =
    row.codexConnectionStatus === "connected" &&
    !!row.codexAccessTokenEncrypted &&
    !!row.codexRefreshTokenEncrypted;

  const chain = parseProviderChain(row.aiProviderChain ?? null).filter(
    (e) => e.enabled,
  );
  for (const entry of chain) {
    switch (entry.providerType) {
      case "codex":
        if (codexConnected) return "user";
        break;
      case "openai":
        if (row.aiOpenaiKeyEncrypted) return "user";
        break;
      case "anthropic":
        if (row.aiAnthropicKeyEncrypted) return "user";
        break;
      case "local":
        if (row.aiBaseUrl) return "local";
        break;
      case "admin-openai":
        if (adminKeyConfigured) return "server";
        break;
    }
  }

  // Legacy `resolveProvider()` fallback — only reached when the chain
  // resolves empty. Mirrors buildUserProvider → codex → admin in order.
  const choice = row.aiProvider?.toUpperCase();
  if (choice === "ANTHROPIC" && row.aiAnthropicKeyEncrypted) return "user";
  if (choice === "LOCAL" && row.aiBaseUrl) return "local";
  if (choice === "OPENAI" && row.aiOpenaiKeyEncrypted) return "user";
  if ((choice === "CHATGPT_OAUTH" || !choice) && codexConnected) return "user";
  return adminKeyConfigured ? "server" : null;
}

/**
 * Effective AI availability for a user: whether any provider can serve
 * them, and which origin manages it. One narrow user read plus the
 * shared admin-key flag — no decrypt, no network. Feeds the
 * `GET /api/user/ai-provider` response so the iOS Coach surfaces even
 * when the operator's admin-managed key is the only thing configured.
 */
export async function resolveProviderAvailability(
  userId: string,
): Promise<{ aiAvailable: boolean; managedBy: ProviderManagedBy | null }> {
  const userRow = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      aiProvider: true,
      aiProviderChain: true,
      aiAnthropicKeyEncrypted: true,
      aiLocalKeyEncrypted: true,
      aiOpenaiKeyEncrypted: true,
      aiBaseUrl: true,
      codexConnectionStatus: true,
      codexAccessTokenEncrypted: true,
      codexRefreshTokenEncrypted: true,
    },
  });
  if (!userRow) return { aiAvailable: false, managedBy: null };
  const settings = await prisma.appSettings.findUnique({
    where: { id: "singleton" },
    select: { adminAiKeyEncrypted: true },
  });
  const managedBy = resolveManagedByFromRow(
    userRow,
    !!settings?.adminAiKeyEncrypted,
  );
  return { aiAvailable: managedBy !== null, managedBy };
}

/**
 * Materialise a single chain entry. Returns null when the user lacks
 * the matching credential — the chain runner skips null entries.
 */
async function resolveProviderForType(
  providerType: ProviderChainType,
  ctx: {
    userId: string;
    userRow: {
      aiAnthropicKeyEncrypted: string | null;
      aiLocalKeyEncrypted: string | null;
      aiOpenaiKeyEncrypted: string | null;
      aiBaseUrl: string | null;
      aiModel: string | null;
    } | null;
  },
): Promise<AIProvider | null> {
  switch (providerType) {
    case "codex": {
      return resolveCodexProvider(ctx.userId);
    }
    case "openai": {
      const enc = ctx.userRow?.aiOpenaiKeyEncrypted;
      if (!enc) return null;
      return new OpenAIClient({
        apiKey: decrypt(enc),
        model: ctx.userRow?.aiModel ?? "gpt-4o",
        baseUrl: "https://api.openai.com/v1",
      });
    }
    case "anthropic": {
      const enc = ctx.userRow?.aiAnthropicKeyEncrypted;
      if (!enc) return null;
      return new AnthropicClient({
        apiKey: decrypt(enc),
        model: ctx.userRow?.aiModel ?? "claude-sonnet-4-6",
      });
    }
    case "local": {
      if (!ctx.userRow?.aiBaseUrl) return null;
      return new LocalOpenAICompatibleClient({
        apiKey: ctx.userRow.aiLocalKeyEncrypted
          ? decrypt(ctx.userRow.aiLocalKeyEncrypted)
          : null,
        model: ctx.userRow.aiModel ?? "local-model",
        baseUrl: ctx.userRow.aiBaseUrl,
      });
    }
    case "admin-openai": {
      const admin = await resolveAdminProvider();
      return admin.type === "none" ? null : admin;
    }
    default:
      return null;
  }
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

  // Empty selection ("test my saved config" — the ai-section calls
  // /api/ai/test with an empty body): resolve via the SAME path generation
  // uses — the first enabled+credentialed entry of `resolveProviderChain`.
  // The legacy codex→admin fallback used to probe a different provider than
  // generation ran (observed: test→admin-key while generation→codex), so a
  // green test gave no signal about whether overnight generation would
  // work. Falling through to the chain keeps the two paths in lock-step.
  if (!provider) {
    const chain = await resolveProviderChain(userId);
    if (chain.length > 0) return chain[0].instance;
    // Chain empty (no enabled+credentialed entry) — mirror the regular
    // single-provider resolution one more time before giving up.
    const legacy = await resolveProvider(userId);
    if (legacy.type !== "none") return legacy;
    throw new AITestConfigError(422, "No AI provider configured");
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
        model: model || "claude-sonnet-4-6",
      });
    }
    case "LOCAL": {
      if (!baseUrl) {
        throw new AITestConfigError(422, "Local provider requires a base URL");
      }
      // v1.18.7 (SECURITY LOW) — host allowlist (`true` = any private host;
      // a comma-separated host list = only those) replaces the binary flag.
      const allowPrivate = isLocalAiHostAllowed(baseUrl);
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
          model: model || "gpt-4o",
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
