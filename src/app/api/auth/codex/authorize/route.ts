import { NextRequest, NextResponse } from "next/server";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import {
  generatePKCE,
  generateState,
  buildAuthorizationUrl,
} from "@/lib/ai/codex-oauth";
import { cookies } from "next/headers";
import { annotate } from "@/lib/logging/context";

export const GET = apiHandler(async (_request: NextRequest) => {
  await requireAuth();

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
