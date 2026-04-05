import { NextRequest, NextResponse } from "next/server";
import { apiHandler, requireAuth, HttpError } from "@/lib/api-handler";
import { checkRateLimit } from "@/lib/rate-limit";
import {
  generatePKCE,
  generateState,
  buildAuthorizationUrl,
} from "@/lib/ai/codex-oauth";
import { cookies } from "next/headers";
import { annotate } from "@/lib/logging/context";

export const GET = apiHandler(async (_request: NextRequest) => {
  const { user } = await requireAuth();

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

  const authUrl = buildAuthorizationUrl({
    codeChallenge: challenge,
    state,
    redirectUri,
  });
  annotate({ action: { name: "codex.oauth.authorize" } });

  return NextResponse.redirect(authUrl);
});
