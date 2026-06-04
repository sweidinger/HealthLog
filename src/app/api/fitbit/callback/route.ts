import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate, getEvent } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { encrypt } from "@/lib/crypto";
import {
  exchangeCode,
  fetchProfile,
  resolveFitbitUserId,
  FITBIT_OAUTH_SCOPE,
} from "@/lib/fitbit/client";
import { getUserFitbitCredentials } from "@/lib/fitbit/credentials";
import { FITBIT_OAUTH_STATE_COOKIE } from "@/lib/fitbit/oauth-state";
import { FITBIT_BACKFILL_QUEUE } from "@/lib/jobs/fitbit-backfill";
import { getGlobalBoss } from "@/lib/jobs/boss-instance";
import { markReconnected } from "@/lib/integrations/status";
import { Prisma } from "@/generated/prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";

/**
 * OAuth callback from Google for Fitbit / Google Health (v1.12.0). Mirrors the
 * WHOOP callback: the `state` param is a random base64url nonce keyed against
 * the `FitbitOAuthState` ledger. The in-flight user is resolved via the row's
 * `userId` (never parsed from the cookie value) and cross-checked against the
 * session. The row is consumed (deleted) atomically on every exit branch so a
 * replay of the same nonce fails the second time.
 *
 * Reason tags distinguish the four post-delete branches for the audit trail:
 * `csrf1` (URL/cookie mismatch, short-circuit before delete), `replay` (P2025 —
 * nonce already consumed), `expired` (valid row, TTL elapsed), and `cross_user`
 * (valid row, session userId mismatch).
 *
 * On success: exchange the code, fetch the Google Health profile for the
 * external `fitbitUserId`, persist the encrypted `FitbitConnection`, clear any
 * prior reauth state, and enqueue the self-converging history backfill.
 */
const ERR = (reason: string) =>
  NextResponse.redirect(
    new URL(
      `/settings/integrations?fitbit=error&reason=${reason}`,
      process.env.NEXT_PUBLIC_APP_URL!,
    ),
  );

export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "fitbit.callback" } });

  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const storedState = request.cookies.get(FITBIT_OAUTH_STATE_COOKIE)?.value;

  // CSRF leg 1: URL state must match the cookie state byte-for-byte
  // (timing-safe). Runs BEFORE the atomic delete so a probe with arbitrary
  // state values can't grief legitimate ledger rows.
  if (
    !state ||
    !storedState ||
    state.length !== storedState.length ||
    !timingSafeEqual(Buffer.from(state), Buffer.from(storedState))
  ) {
    annotate({ meta: { reason: "csrf1" } });
    return ERR("csrf1");
  }

  // CSRF leg 2: atomically consume the ledger row. `delete` returns the row on
  // success so the `expiresAt` + `userId` checks run against the consumed
  // payload. P2025 means the nonce was already consumed (replay) or never
  // existed. Atomic at the Postgres row level: two concurrent callbacks with the
  // same nonce can't both pass before either deletes.
  let stateRow: { userId: string; expiresAt: Date } | null = null;
  try {
    stateRow = await prisma.fitbitOAuthState.delete({
      where: { nonce: state },
    });
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2025"
    ) {
      annotate({ meta: { reason: "replay" } });
      return ERR("replay");
    }
    const errName = err instanceof Error ? err.name : "unknown";
    getEvent()?.addWarning(`oauth-state-delete failed: ${errName}`);
    annotate({ meta: { reason: "state" } });
    return ERR("state");
  }

  if (stateRow.expiresAt <= new Date()) {
    annotate({ meta: { reason: "expired" } });
    return ERR("expired");
  }
  if (stateRow.userId !== user.id) {
    annotate({ meta: { reason: "cross_user" } });
    return ERR("cross_user");
  }

  if (!code) {
    return ERR("nocode");
  }

  try {
    const creds = await getUserFitbitCredentials(user.id);
    if (!creds) {
      return ERR("nocreds");
    }

    const tokens = await exchangeCode(code, creds);
    const profile = await fetchProfile(tokens.access_token);
    const fitbitUserId = resolveFitbitUserId(profile);
    const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);

    // The initial code exchange always returns a refresh token (the connect
    // route forces `prompt=consent` + `access_type=offline`). Fall back to the
    // existing stored token defensively if Google ever omits it on a re-consent.
    await prisma.fitbitConnection.upsert({
      where: { userId: user.id },
      update: {
        fitbitUserId,
        accessToken: encrypt(tokens.access_token),
        tokenExpiresAt: expiresAt,
        scope: tokens.scope ?? FITBIT_OAUTH_SCOPE,
        backfillCompletedAt: null,
        ...(tokens.refresh_token
          ? { refreshToken: encrypt(tokens.refresh_token) }
          : {}),
      },
      create: {
        userId: user.id,
        fitbitUserId,
        accessToken: encrypt(tokens.access_token),
        refreshToken: encrypt(tokens.refresh_token ?? ""),
        tokenExpiresAt: expiresAt,
        scope: tokens.scope ?? FITBIT_OAUTH_SCOPE,
      },
    });

    await auditLog("fitbit.connect", {
      userId: user.id,
      details: { fitbitUserId },
    });

    // Re-completing OAuth clears any prior reauth-required state.
    await markReconnected(user.id, "fitbit");

    // Enqueue the self-converging history backfill. Best-effort: the boot-time
    // discovery query (`backfillCompletedAt IS NULL`) is the safety net, so a
    // missing boss instance here doesn't strand the connection.
    const boss = getGlobalBoss();
    if (boss) {
      await boss
        .send(FITBIT_BACKFILL_QUEUE, {
          userId: user.id,
          enqueuedAt: new Date().toISOString(),
        })
        .catch((err) =>
          getEvent()?.addWarning(`fitbit-backfill enqueue failed: ${err}`),
        );
    }

    const response = NextResponse.redirect(
      new URL(
        "/settings/integrations?fitbit=connected",
        process.env.NEXT_PUBLIC_APP_URL!,
      ),
    );
    response.cookies.delete(FITBIT_OAUTH_STATE_COOKIE);
    return response;
  } catch (err) {
    getEvent()?.setError(err);
    return ERR("token");
  }
});
