import { NextRequest } from "next/server";
import { destroySession } from "@/lib/auth/session";
import { revokeBearerAccessToken } from "@/lib/auth/refresh-token";
import { apiSuccess } from "@/lib/api-response";
import { apiHandler } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";

export const POST = apiHandler(async (request: NextRequest) => {
  // Cookie path: clear the browser session (unchanged).
  await destroySession();

  // M-2 hardening: `destroySession()` only clears the cookie. When the
  // request carries `Authorization: Bearer hlk_…` (native/n8n/Health-Connect
  // logging out without the refresh round-trip), also revoke that ApiToken
  // and its paired refresh sibling so the endpoint matches its name for the
  // bearer transport.
  let bearerRevoked = false;
  const authHeader = request.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const rawToken = authHeader.slice(7).trim();
    if (rawToken.startsWith("hlk_")) {
      bearerRevoked = await revokeBearerAccessToken(rawToken);
    }
  }

  annotate({
    action: { name: "auth.logout" },
    meta: { bearer_revoked: bearerRevoked },
  });

  return apiSuccess({ loggedOut: true });
});
