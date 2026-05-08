import { NextRequest, NextResponse } from "next/server";
import { apiHandler, requireAuth, HttpError } from "@/lib/api-handler";
import { checkRateLimit } from "@/lib/rate-limit";
import {
  generatePKCE,
  generateState,
  buildAuthorizationUrl,
  CodexOAuthNotConfiguredError,
  isCodexOAuthConfigured,
} from "@/lib/ai/codex-oauth";
import { cookies } from "next/headers";
import { annotate } from "@/lib/logging/context";

export const GET = apiHandler(async (_request: NextRequest) => {
  const { user } = await requireAuth();

  // Surface configuration errors as 503 instead of silently redirecting
  // to a dead chatgpt.com URL. The v1.4.2 build dropped the `client_id`
  // out of the authorize URL — the user landed on the chatgpt.com login
  // page, no callback ever fired, and the connect button "did nothing".
  if (!isCodexOAuthConfigured()) {
    throw new HttpError(
      503,
      "Codex OAuth is not configured on this instance — set CODEX_OAUTH_CLIENT_ID",
    );
  }

  const rl = await checkRateLimit(`codex-authorize:${user.id}`, 5, 60_000);
  if (!rl.allowed) throw new HttpError(429, "Too many requests");

  const { verifier, challenge } = generatePKCE();
  const state = generateState();

  const appUrl = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL;
  if (!appUrl) throw new Error("APP_URL not configured");

  const redirectUri = `${appUrl}/api/auth/codex/callback`;

  const cookieStore = await cookies();
  const cookieOptions = {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: 300,
  };

  cookieStore.set("codex_verifier", verifier, cookieOptions);
  cookieStore.set("codex_state", state, cookieOptions);

  let authUrl: string;
  try {
    authUrl = buildAuthorizationUrl({
      codeChallenge: challenge,
      state,
      redirectUri,
    });
  } catch (err) {
    // Race between the env check above and the URL build — extremely
    // unlikely but the typed error path is cheap insurance.
    if (err instanceof CodexOAuthNotConfiguredError) {
      throw new HttpError(503, err.message);
    }
    throw err;
  }
  annotate({ action: { name: "codex.oauth.authorize" } });

  return NextResponse.redirect(authUrl);
});
