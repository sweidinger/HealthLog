import { redirect } from "next/navigation";

import { looksLikeInviteToken } from "@/lib/auth/invite-token";

/**
 * v1.17.0 — invite universal-link landing (iOS #16).
 *
 * `https://<host>/invite/<hlv_token>` is the URL encoded in the admin
 * invite QR and the path the AASA `["*"]` matcher hands to the iOS app:
 *   - On an installed iOS app the scene delegate intercepts the
 *     Universal Link before this page ever renders and starts onboarding
 *     registration with the token prefilled. This server component is the
 *     BROWSER fallback only.
 *   - In a browser, the page is a thin, safe redirect onto the existing
 *     `/auth/register?invite=<token>` flow, where the invite banner shows
 *     and the token rides the signup POST exactly as before.
 *
 * Security:
 *   - The `hlv_` shape is validated before the token is ever reflected
 *     into the redirect target — a malformed segment lands on plain
 *     `/auth/register` with no `?invite`, so the page can never echo
 *     attacker-controlled text into the URL.
 *   - The route does NOT touch the database and is NOT an enumeration
 *     oracle: a well-formed-but-unknown token and a well-formed-and-valid
 *     token redirect to the identical target. Whether a token is real is
 *     only ever decided at `POST /api/auth/register`, which keeps its
 *     existing uniform error semantics and rate limit.
 *   - The token is never logged here; the redirect is the only effect.
 *
 * The route is listed in `PUBLIC_PATHS` (`/invite/`) so an unauthenticated
 * visitor reaches it without the auth-gate bounce to `/auth/login`.
 */
export default async function InviteLandingPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  if (looksLikeInviteToken(token)) {
    redirect(`/auth/register?invite=${encodeURIComponent(token)}`);
  }

  // Malformed token: behave exactly like a visitor with no invite. No DB
  // hit, no leak of whether any token exists.
  redirect("/auth/register");
}
