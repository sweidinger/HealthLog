import { apiSuccess } from "@/lib/api-response";
import { apiHandler } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { getOidcConfig, isOidcOnly } from "@/lib/auth/oidc";

export const dynamic = "force-dynamic";

/** Public — the login page reads this pre-session to decide whether to
 * render the SSO button and whether to hide password/passkey login. Pure
 * env reads; nothing here can throw. */
export const GET = apiHandler(async () => {
  annotate({ action: { name: "auth.oidc.status" } });
  const config = getOidcConfig();
  return apiSuccess({
    enabled: config !== null,
    buttonLabel: config?.buttonLabel ?? null,
    only: isOidcOnly(),
  });
});
