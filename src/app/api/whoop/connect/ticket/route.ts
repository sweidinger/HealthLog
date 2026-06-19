import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiError, apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { checkRateLimit } from "@/lib/rate-limit";
import { mintWhoopConnectTicket } from "@/lib/whoop/connect-ticket";
import { getUserWhoopCredentials } from "@/lib/whoop/credentials";

/**
 * Mint a one-time, short-lived WHOOP connect ticket (v1.12.2).
 *
 * Bearer-capable: a purely Bearer-authenticated native client (no web-session
 * cookie) mints a ticket here, then opens
 * `GET /api/whoop/connect?ticket=<opaque>` in an in-app web session to start
 * the WHOOP OAuth handshake. The raw ticket is returned exactly once; only its
 * hash is stored (see `src/lib/whoop/connect-ticket.ts`).
 *
 * Rate-limited per user so a token can't mint an unbounded backlog of tickets.
 */
const TICKET_RATE_LIMIT = 10;
const TICKET_WINDOW_MS = 60_000;

export const POST = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "whoop.connect.ticket.mint" } });

  const rl = await checkRateLimit(
    `whoop:connect:ticket:${user.id}`,
    TICKET_RATE_LIMIT,
    TICKET_WINDOW_MS,
  );
  if (!rl.allowed) {
    annotate({ action: { name: "whoop.connect.ticket.rate_limited" } });
    return apiError(
      "Too many connect-ticket requests. Try again shortly.",
      429,
    );
  }

  // BYO-key gate: a ticket is only useful if the user has WHOOP credentials
  // configured (the connect route would 400 otherwise). Fail fast with a clear
  // error rather than minting a ticket that can't complete.
  const creds = await getUserWhoopCredentials(user.id);
  if (!creds) {
    return apiError(
      "Please configure your WHOOP Client ID and Client Secret in Settings first.",
      400,
    );
  }

  const ticket = await mintWhoopConnectTicket(user.id);
  return apiSuccess({ ticket });
});
