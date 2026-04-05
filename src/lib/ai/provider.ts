import type { AIProvider, CompletionParams, CompletionResult } from "./types";
import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { CodexClient } from "./codex-client";
import { OpenAIClient } from "./openai-client";
import { refreshAccessToken, encryptTokens, decryptTokens } from "./codex-oauth";

const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000; // 5 minutes

class NoProvider implements AIProvider {
  readonly type = "none" as const;

  async generateCompletion(_params: CompletionParams): Promise<CompletionResult> {
    throw new Error(
      "No AI provider configured. Connect Codex or set an admin API key.",
    );
  }
}

async function resolveAdminProvider(): Promise<AIProvider> {
  const settings = await prisma.appSettings.findUnique({ where: { id: 1 } });

  if (settings?.adminAiKeyEncrypted) {
    return new OpenAIClient({
      apiKey: decrypt(settings.adminAiKeyEncrypted),
      model: settings.adminAiModel ?? "gpt-4o-mini",
      baseUrl: settings.adminAiBaseUrl ?? "https://api.openai.com/v1",
    });
  }

  return new NoProvider();
}

export async function resolveProvider(userId: string): Promise<AIProvider> {
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
    user?.codexConnectionStatus === "connected" &&
    user.codexAccessTokenEncrypted &&
    user.codexRefreshTokenEncrypted
  ) {
    const { accessToken, refreshToken } = decryptTokens({
      accessEncrypted: user.codexAccessTokenEncrypted,
      refreshEncrypted: user.codexRefreshTokenEncrypted,
    });

    let currentAccessToken = accessToken;

    // Proactive refresh if token expires within 5 minutes
    const expiresAt = user.codexTokenExpiresAt?.getTime() ?? 0;
    if (expiresAt < Date.now() + TOKEN_REFRESH_BUFFER_MS) {
      try {
        const newTokens = await refreshAccessToken(refreshToken);
        currentAccessToken = newTokens.access_token;

        const encrypted = encryptTokens({
          accessToken: newTokens.access_token,
          refreshToken: newTokens.refresh_token,
        });

        await prisma.user.update({
          where: { id: userId },
          data: {
            codexAccessTokenEncrypted: encrypted.accessEncrypted,
            codexRefreshTokenEncrypted: encrypted.refreshEncrypted,
            codexTokenExpiresAt: new Date(
              Date.now() + newTokens.expires_in * 1000,
            ),
          },
        });
      } catch {
        // If proactive refresh fails, still try with current token
        // CodexClient will retry via onTokenRefresh on 401
      }
    }

    return new CodexClient({
      accessToken: currentAccessToken,
      onTokenRefresh: async () => {
        const freshUser = await prisma.user.findUnique({
          where: { id: userId },
          select: {
            codexRefreshTokenEncrypted: true,
          },
        });

        if (!freshUser?.codexRefreshTokenEncrypted) {
          throw new Error("No refresh token available");
        }

        const { refreshToken: currentRefreshToken } = decryptTokens({
          accessEncrypted: "",
          refreshEncrypted: freshUser.codexRefreshTokenEncrypted,
        });

        const newTokens = await refreshAccessToken(currentRefreshToken);
        const encrypted = encryptTokens({
          accessToken: newTokens.access_token,
          refreshToken: newTokens.refresh_token,
        });

        await prisma.user.update({
          where: { id: userId },
          data: {
            codexAccessTokenEncrypted: encrypted.accessEncrypted,
            codexRefreshTokenEncrypted: encrypted.refreshEncrypted,
            codexTokenExpiresAt: new Date(
              Date.now() + newTokens.expires_in * 1000,
            ),
          },
        });

        return newTokens.access_token;
      },
    });
  }

  // Codex not connected (disconnected, expired, or error) — fall back to admin key
  return resolveAdminProvider();
}
