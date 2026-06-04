/**
 * Combined status endpoint for the Settings → Integrations card.
 *
 * Returns a snapshot per integration containing:
 *   - the IntegrationStatus row (state, last-success, last-attempt,
 *     decrypted last-error, per-kind failure buckets, threshold)
 *   - integration-specific extras the UI already shows (Withings:
 *     credentials configured, token expiry, OAuth-connected; moodLog:
 *     credentials configured, enabled flag)
 *
 * Combining both into one fetch removes a third round-trip from the
 * Settings page. The legacy /api/withings/status and
 * /api/integrations/moodlog/status remain for the existing UI/tests
 * — we add this in addition rather than rewriting them.
 */
import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import {
  getIntegrationStatus,
  getPersistentFailureThreshold,
  type IntegrationKey,
} from "@/lib/integrations/status";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "integrations.status" } });

  const [
    withingsStatus,
    moodLogStatus,
    whoopStatus,
    fitbitStatus,
    dbUser,
    withingsConn,
    whoopConn,
    fitbitConn,
  ] = await Promise.all([
    getIntegrationStatus(user.id, "withings"),
    getIntegrationStatus(user.id, "moodlog"),
    getIntegrationStatus(user.id, "whoop"),
    getIntegrationStatus(user.id, "fitbit"),
    prisma.user.findUnique({
      where: { id: user.id },
      select: {
        withingsClientIdEncrypted: true,
        withingsClientSecretEncrypted: true,
        whoopClientIdEncrypted: true,
        whoopClientSecretEncrypted: true,
        fitbitClientIdEncrypted: true,
        fitbitClientSecretEncrypted: true,
        moodLogUrlEncrypted: true,
        moodLogApiKeyEncrypted: true,
        moodLogEnabled: true,
        moodLogLastSyncedAt: true,
      },
    }),
    prisma.withingsConnection.findUnique({
      where: { userId: user.id },
      select: {
        tokenExpiresAt: true,
        lastSyncedAt: true,
        createdAt: true,
      },
    }),
    prisma.whoopConnection.findUnique({
      where: { userId: user.id },
      select: {
        tokenExpiresAt: true,
        lastSyncedAt: true,
        createdAt: true,
      },
    }),
    prisma.fitbitConnection.findUnique({
      where: { userId: user.id },
      select: {
        tokenExpiresAt: true,
        lastSyncedAt: true,
        createdAt: true,
      },
    }),
  ]);

  const now = Date.now();

  return apiSuccess({
    threshold: getPersistentFailureThreshold(),
    integrations: [
      {
        ...withingsStatus,
        configured:
          !!dbUser?.withingsClientIdEncrypted &&
          !!dbUser?.withingsClientSecretEncrypted,
        connected: !!withingsConn,
        connectedAt: withingsConn?.createdAt?.toISOString() ?? null,
        // Surface the connection row's success time too so the UI
        // can fall back to it when no IntegrationStatus row exists
        // yet (legacy connections established before this feature).
        legacyLastSyncedAt: withingsConn?.lastSyncedAt?.toISOString() ?? null,
        tokenExpiresAt: withingsConn?.tokenExpiresAt?.toISOString() ?? null,
        tokenExpired: withingsConn
          ? withingsConn.tokenExpiresAt.getTime() <= now
          : null,
      } satisfies IntegrationViewModel & WithingsExtras,
      {
        ...moodLogStatus,
        configured:
          !!dbUser?.moodLogUrlEncrypted && !!dbUser?.moodLogApiKeyEncrypted,
        enabled: dbUser?.moodLogEnabled ?? false,
        legacyLastSyncedAt: dbUser?.moodLogLastSyncedAt?.toISOString() ?? null,
      } satisfies IntegrationViewModel & MoodLogExtras,
      {
        ...whoopStatus,
        configured:
          !!dbUser?.whoopClientIdEncrypted &&
          !!dbUser?.whoopClientSecretEncrypted,
        connected: !!whoopConn,
        connectedAt: whoopConn?.createdAt?.toISOString() ?? null,
        legacyLastSyncedAt: whoopConn?.lastSyncedAt?.toISOString() ?? null,
        tokenExpiresAt: whoopConn?.tokenExpiresAt?.toISOString() ?? null,
        tokenExpired: whoopConn
          ? whoopConn.tokenExpiresAt.getTime() <= now
          : null,
      } satisfies IntegrationViewModel & WhoopExtras,
      {
        ...fitbitStatus,
        configured:
          !!dbUser?.fitbitClientIdEncrypted &&
          !!dbUser?.fitbitClientSecretEncrypted,
        connected: !!fitbitConn,
        connectedAt: fitbitConn?.createdAt?.toISOString() ?? null,
        legacyLastSyncedAt: fitbitConn?.lastSyncedAt?.toISOString() ?? null,
        tokenExpiresAt: fitbitConn?.tokenExpiresAt?.toISOString() ?? null,
        tokenExpired: fitbitConn
          ? fitbitConn.tokenExpiresAt.getTime() <= now
          : null,
      } satisfies IntegrationViewModel & FitbitExtras,
    ],
  });
});

interface IntegrationViewModel {
  integration: IntegrationKey;
  state: string;
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  lastError: string | null;
}

interface WithingsExtras {
  configured: boolean;
  connected: boolean;
  connectedAt: string | null;
  legacyLastSyncedAt: string | null;
  tokenExpiresAt: string | null;
  tokenExpired: boolean | null;
}

interface MoodLogExtras {
  configured: boolean;
  enabled: boolean;
  legacyLastSyncedAt: string | null;
}

interface WhoopExtras {
  configured: boolean;
  connected: boolean;
  connectedAt: string | null;
  legacyLastSyncedAt: string | null;
  tokenExpiresAt: string | null;
  tokenExpired: boolean | null;
}

interface FitbitExtras {
  configured: boolean;
  connected: boolean;
  connectedAt: string | null;
  legacyLastSyncedAt: string | null;
  tokenExpiresAt: string | null;
  tokenExpired: boolean | null;
}
