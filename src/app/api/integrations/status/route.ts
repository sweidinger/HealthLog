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
 * This is the single fetch the Settings → Integrations cards read off
 * — it carries every field the four cards render (Withings activity
 * scope, WHOOP/Fitbit backfill state, moodLog webhook secret + entry
 * count) so the per-card /api/<provider>/status round-trips are gone
 * from the web. The legacy per-provider routes stay for the iOS/test
 * callers; the web cards no longer hit them.
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
import { hasActivityScope } from "@/lib/withings/client";
import { readMoodLogSecret } from "@/lib/moodlog-secret";

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
    moodLogEntryCount,
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
        moodLogWebhookSecret: true,
      },
    }),
    prisma.withingsConnection.findUnique({
      where: { userId: user.id },
      select: {
        tokenExpiresAt: true,
        lastSyncedAt: true,
        createdAt: true,
        scope: true,
      },
    }),
    prisma.whoopConnection.findUnique({
      where: { userId: user.id },
      select: {
        tokenExpiresAt: true,
        lastSyncedAt: true,
        createdAt: true,
        backfillCompletedAt: true,
      },
    }),
    prisma.fitbitConnection.findUnique({
      where: { userId: user.id },
      select: {
        tokenExpiresAt: true,
        lastSyncedAt: true,
        createdAt: true,
        backfillCompletedAt: true,
      },
    }),
    // v1.7.0 sync — exclude tombstoned rows from the entry count.
    prisma.moodEntry.count({
      where: { userId: user.id, deletedAt: null },
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
        // v1.4.25 W5d — `scope` is the comma-separated OAuth scope string;
        // `hasActivityScope` is the derived flag the reconnect banner reads.
        // Null `scope` = legacy connection that predates activity-scope reads.
        scope: withingsConn?.scope ?? null,
        hasActivityScope: hasActivityScope(withingsConn?.scope ?? null),
      } satisfies IntegrationViewModel & WithingsExtras,
      {
        ...moodLogStatus,
        // moodLog "configured" tracks the URL alone (the API key is
        // optional for the webhook-only path), matching the legacy
        // /api/integrations/moodlog/status contract the card relied on.
        configured: !!dbUser?.moodLogUrlEncrypted,
        enabled: dbUser?.moodLogEnabled ?? false,
        legacyLastSyncedAt: dbUser?.moodLogLastSyncedAt?.toISOString() ?? null,
        // V3 audit STILL-V2-C-2: stored secret is AES-GCM encrypted at rest;
        // decrypt for the settings page (legacy plaintext is also handled).
        webhookSecret: readMoodLogSecret(dbUser?.moodLogWebhookSecret ?? null),
        entryCount: moodLogEntryCount,
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
        backfillCompleted: whoopConn ? !!whoopConn.backfillCompletedAt : null,
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
        backfillCompleted: fitbitConn ? !!fitbitConn.backfillCompletedAt : null,
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
  scope: string | null;
  hasActivityScope: boolean;
}

interface MoodLogExtras {
  configured: boolean;
  enabled: boolean;
  legacyLastSyncedAt: string | null;
  webhookSecret: string | null;
  entryCount: number;
}

interface WhoopExtras {
  configured: boolean;
  connected: boolean;
  connectedAt: string | null;
  legacyLastSyncedAt: string | null;
  tokenExpiresAt: string | null;
  tokenExpired: boolean | null;
  backfillCompleted: boolean | null;
}

interface FitbitExtras {
  configured: boolean;
  connected: boolean;
  connectedAt: string | null;
  legacyLastSyncedAt: string | null;
  tokenExpiresAt: string | null;
  tokenExpired: boolean | null;
  backfillCompleted: boolean | null;
}
