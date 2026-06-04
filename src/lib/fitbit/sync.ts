/**
 * Fitbit / Google Health sync service (v1.12.0).
 *
 * This wave (OAuth + credentials) lands the token-management half:
 *   - `getValidToken` decrypts the stored token, refreshes at
 *     `tokenExpiresAt - 5 min`, persists the new access token + expiry, and —
 *     UNLIKE WHOOP — only overwrites the stored refresh token when the response
 *     carries a fresh one (Google does not rotate refresh tokens).
 *   - `recordFitbitSyncFailure` / `classificationToFailureKind` map a
 *     classified API error onto the shared integration-status ledger.
 *
 * The per-resource data sync (`upsertFitbitMeasurements`, `syncUserFitbit`, the
 * collection walkers, and the 403 soft-skip orchestration) lands in a later
 * wave and extends this file.
 */
import { prisma } from "@/lib/db";
import { encrypt, decrypt } from "@/lib/crypto";
import { getEvent } from "@/lib/logging/context";
import {
  recordSyncFailure,
  type FailureKind,
} from "@/lib/integrations/status";
import { refreshAccessToken } from "./client";
import { getUserFitbitCredentials } from "./credentials";
import {
  FitbitApiError,
  classifyFitbitError,
  type FitbitClassification,
} from "./response-classifier";

/** Refresh the access token this many ms before `tokenExpiresAt`. */
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

export interface FitbitTokenInfo {
  accessToken: string;
  connection: { id: string; fitbitUserId: string };
}

/**
 * Resolve a valid Fitbit access token for a user, refreshing if it is within
 * the 5-minute expiry buffer. Returns null when there is no connection, no
 * credentials, or the refresh fails (the failure is recorded so scheduled syncs
 * back off).
 *
 * KEY DELTA vs WHOOP: Google does not rotate refresh tokens. On refresh, persist
 * the new access token + expiry and overwrite the stored `refreshToken` ONLY
 * when the response carries a fresh one — otherwise keep the existing refresh
 * token so the next refresh still authenticates.
 */
export async function getValidToken(
  userId: string,
): Promise<FitbitTokenInfo | null> {
  const connection = await prisma.fitbitConnection.findUnique({
    where: { userId },
  });
  if (!connection) return null;

  const accessToken = decrypt(connection.accessToken);
  const refreshToken = decrypt(connection.refreshToken);

  if (
    connection.tokenExpiresAt.getTime() - TOKEN_REFRESH_BUFFER_MS <
    Date.now()
  ) {
    try {
      const creds = await getUserFitbitCredentials(userId);
      if (!creds) {
        getEvent()?.addWarning(
          `No Fitbit credentials found for user ${userId} during token refresh`,
        );
        await recordSyncFailure({
          userId,
          integration: "fitbit",
          kind: "reauth_required",
          message: "Fitbit credentials missing — token refresh skipped",
          errorCode: "credentials_missing",
        });
        return null;
      }

      const newTokens = await refreshAccessToken(refreshToken, creds);
      const expiresAt = new Date(Date.now() + newTokens.expires_in * 1000);

      // Google does NOT rotate refresh tokens: a routine refresh returns a new
      // access token but usually omits `refresh_token`. Persist the new access
      // token + expiry and only overwrite the stored refresh token when the
      // response actually carries a fresh one — otherwise keep the existing one.
      await prisma.fitbitConnection.update({
        where: { id: connection.id },
        data: {
          accessToken: encrypt(newTokens.access_token),
          tokenExpiresAt: expiresAt,
          ...(newTokens.refresh_token
            ? { refreshToken: encrypt(newTokens.refresh_token) }
            : {}),
        },
      });

      return {
        accessToken: newTokens.access_token,
        connection: {
          id: connection.id,
          fitbitUserId: connection.fitbitUserId,
        },
      };
    } catch (err) {
      getEvent()?.addWarning(
        `Fitbit token refresh failed for user ${userId}: ${err}`,
      );
      await recordFitbitSyncFailure(userId, err);
      return null;
    }
  }

  return {
    accessToken,
    connection: {
      id: connection.id,
      fitbitUserId: connection.fitbitUserId,
    },
  };
}

/**
 * Map a Fitbit response classification onto a `FailureKind` and record it.
 * Shared by the token-refresh path and (later) every per-resource catch block.
 */
export async function recordFitbitSyncFailure(
  userId: string,
  err: unknown,
): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  await recordSyncFailure({
    userId,
    integration: "fitbit",
    kind: classificationToFailureKind(classifyFitbitError(err)),
    message,
    errorCode:
      err instanceof FitbitApiError ? err.httpStatus?.toString() : undefined,
  });
}

export function classificationToFailureKind(
  classification: FitbitClassification,
): FailureKind {
  switch (classification) {
    case "reauth_required":
      return "reauth_required";
    case "persistent":
      return "persistent";
    case "transient":
      return "transient";
    case "success":
      // A caller asking for the FailureKind of a success is a contract bug;
      // surface it as transient so the audit log still records the anomaly.
      return "transient";
  }
}
