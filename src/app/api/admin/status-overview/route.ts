import { prisma } from "@/lib/db";
import { apiHandler, requireAdmin } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { getWorkerStatus } from "@/lib/jobs/worker-status";

/**
 * Severity tokens map onto §2.6 status taxonomy of `docs/ui-guidelines.md`.
 * Returned as plain strings so the client renders dots + labels — not RAW
 * colours — and never leans on color alone for state.
 */
export type StatusSeverity = "good" | "info" | "caution" | "alert" | "pending";

export interface StatusOverview {
  users: {
    severity: StatusSeverity;
    total: number;
    admins: number;
    newThisWeek: number;
  };
  integrations: {
    severity: StatusSeverity;
    withings: number;
    moodLog: number;
    telegram: number;
    ntfy: number;
    webPush: number;
  };
  monitoring: {
    severity: StatusSeverity;
    glitchtipEnabled: boolean;
    umamiEnabled: boolean;
    wideEventsEnabled: boolean;
    lastErrorAt: string | null;
  };
  backups: {
    severity: StatusSeverity;
    lastBackupAt: string | null;
    backedUpUsers: number;
    retentionDays: number;
  };
  maintenance: {
    severity: StatusSeverity;
    workerRunning: boolean;
    workerUptimeSeconds: number | null;
    lastIdempotencyCleanup: string | null;
    lastAuditLogCleanup: string | null;
  };
  auditLog: {
    severity: StatusSeverity;
    eventsLast30d: number;
    lastLoginAt: string | null;
  };
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function severityForBackup(lastBackupAt: Date | null): StatusSeverity {
  if (!lastBackupAt) return "alert";
  const ageMs = Date.now() - lastBackupAt.getTime();
  if (ageMs > 14 * ONE_DAY_MS) return "alert";
  if (ageMs > 8 * ONE_DAY_MS) return "caution";
  return "good";
}

function severityForMaintenance(workerRunning: boolean): StatusSeverity {
  return workerRunning ? "good" : "alert";
}

function severityForMonitoring(
  glitchtipEnabled: boolean,
  umamiEnabled: boolean,
  recentErrorAt: Date | null,
): StatusSeverity {
  if (recentErrorAt && Date.now() - recentErrorAt.getTime() < ONE_DAY_MS) {
    return "alert";
  }
  if (glitchtipEnabled && umamiEnabled) return "good";
  if (glitchtipEnabled || umamiEnabled) return "caution";
  return "info";
}

function severityForIntegrations(totalConfigured: number): StatusSeverity {
  if (totalConfigured === 0) return "info";
  return "good";
}

export const GET = apiHandler(async () => {
  await requireAdmin();
  annotate({ action: { name: "admin.status-overview" } });

  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * ONE_DAY_MS);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * ONE_DAY_MS);

  // P20: switch from Promise.all to Promise.allSettled so a single
  // failed probe (e.g. a missing index, a transient timeout, an
  // unavailable model) doesn't blank the whole admin overview grid.
  // Each probe is labelled so we can map a rejection back to the
  // overview field it was meant to populate, then surface the failed
  // labels in a Wide Event annotation for ops triage.
  const probes = [
    ["userTotal", () => prisma.user.count()],
    ["userAdmins", () => prisma.user.count({ where: { role: "ADMIN" } })],
    [
      "userNewThisWeek",
      () => prisma.user.count({ where: { createdAt: { gte: sevenDaysAgo } } }),
    ],
    ["withingsCount", () => prisma.withingsConnection.count()],
    [
      "moodLogCount",
      () => prisma.user.count({ where: { moodLogEnabled: true } }),
    ],
    [
      "telegramCount",
      () => prisma.user.count({ where: { telegramEnabled: true } }),
    ],
    [
      "ntfyCount",
      () =>
        prisma.notificationChannel.count({
          where: { type: "NTFY", enabled: true },
        }),
    ],
    ["webPushCount", () => prisma.pushSubscription.count()],
    [
      "appSettings",
      () => prisma.appSettings.findUnique({ where: { id: "singleton" } }),
    ],
    [
      "lastErrorEntry",
      () =>
        prisma.auditLog.findFirst({
          where: { action: { startsWith: "system.error" } },
          orderBy: { createdAt: "desc" },
          select: { createdAt: true },
        }),
    ],
    [
      "latestBackup",
      () =>
        prisma.dataBackup.findFirst({
          orderBy: { createdAt: "desc" },
          select: { createdAt: true },
        }),
    ],
    [
      "backedUpUsers",
      () =>
        prisma.dataBackup
          .findMany({ select: { userId: true }, distinct: ["userId"] })
          .then((rows) => rows.length),
    ],
    [
      "last30dEvents",
      () =>
        prisma.auditLog.count({ where: { createdAt: { gte: thirtyDaysAgo } } }),
    ],
    [
      "lastLoginEntry",
      () =>
        prisma.auditLog.findFirst({
          where: { action: "auth.login" },
          orderBy: { createdAt: "desc" },
          select: { createdAt: true },
        }),
    ],
    [
      "lastIdempotencyCleanup",
      () =>
        prisma.auditLog.findFirst({
          where: { action: "system.cleanup.idempotency" },
          orderBy: { createdAt: "desc" },
          select: { createdAt: true },
        }),
    ],
    [
      "lastAuditLogCleanup",
      () =>
        prisma.auditLog.findFirst({
          where: { action: "system.cleanup.audit-log" },
          orderBy: { createdAt: "desc" },
          select: { createdAt: true },
        }),
    ],
  ] as const;

  const settled = await Promise.allSettled(probes.map(([, run]) => run()));

  const failed: string[] = [];
  const results: Record<string, unknown> = {};
  settled.forEach((r, i) => {
    const label = probes[i][0];
    if (r.status === "fulfilled") {
      results[label] = r.value;
    } else {
      failed.push(label);
      results[label] = null;
    }
  });

  // Pull each probe out in the same shape the overview expects. `?? 0`
  // turns a null (failed-count probe) into a renderable zero so the
  // grid tiles still draw something instead of going blank.
  const userTotal = (results.userTotal as number | null) ?? 0;
  const userAdmins = (results.userAdmins as number | null) ?? 0;
  const userNewThisWeek = (results.userNewThisWeek as number | null) ?? 0;
  const withingsCount = (results.withingsCount as number | null) ?? 0;
  const moodLogCount = (results.moodLogCount as number | null) ?? 0;
  const telegramCount = (results.telegramCount as number | null) ?? 0;
  const ntfyCount = (results.ntfyCount as number | null) ?? 0;
  const webPushCount = (results.webPushCount as number | null) ?? 0;
  const appSettings = results.appSettings as {
    glitchtipEnabled: boolean;
    umamiEnabled: boolean;
  } | null;
  const lastErrorEntry = results.lastErrorEntry as { createdAt: Date } | null;
  const latestBackup = results.latestBackup as { createdAt: Date } | null;
  const backedUpUsers = (results.backedUpUsers as number | null) ?? 0;
  const last30dEvents = (results.last30dEvents as number | null) ?? 0;
  const lastLoginEntry = results.lastLoginEntry as { createdAt: Date } | null;
  const lastIdempotencyCleanup = results.lastIdempotencyCleanup as {
    createdAt: Date;
  } | null;
  const lastAuditLogCleanup = results.lastAuditLogCleanup as {
    createdAt: Date;
  } | null;

  if (failed.length > 0) {
    annotate({ meta: { statusOverviewProbeFailures: failed } });
  }

  const worker = getWorkerStatus();
  const workerUptimeSeconds = worker.startedAt
    ? Math.max(
        0,
        Math.floor(
          (now.getTime() - new Date(worker.startedAt).getTime()) / 1000,
        ),
      )
    : null;

  const integrationsTotal =
    withingsCount + moodLogCount + telegramCount + ntfyCount + webPushCount;

  // Map probe-name → which overview card depends on it. If any probe
  // for a card failed, force the card's severity to "alert" so the UI
  // surfaces the failure instead of showing zeros as if they were real.
  const failedSet = new Set(failed);
  const anyFailed = (...labels: string[]) =>
    labels.some((l) => failedSet.has(l));

  const overview: StatusOverview = {
    users: {
      severity: anyFailed("userTotal", "userAdmins", "userNewThisWeek")
        ? "alert"
        : "good",
      total: userTotal,
      admins: userAdmins,
      newThisWeek: userNewThisWeek,
    },
    integrations: {
      severity: anyFailed(
        "withingsCount",
        "moodLogCount",
        "telegramCount",
        "ntfyCount",
        "webPushCount",
      )
        ? "alert"
        : severityForIntegrations(integrationsTotal),
      withings: withingsCount,
      moodLog: moodLogCount,
      telegram: telegramCount,
      ntfy: ntfyCount,
      webPush: webPushCount,
    },
    monitoring: {
      severity: anyFailed("appSettings", "lastErrorEntry")
        ? "alert"
        : severityForMonitoring(
            Boolean(appSettings?.glitchtipEnabled),
            Boolean(appSettings?.umamiEnabled),
            lastErrorEntry?.createdAt ?? null,
          ),
      glitchtipEnabled: Boolean(appSettings?.glitchtipEnabled),
      umamiEnabled: Boolean(appSettings?.umamiEnabled),
      wideEventsEnabled: true,
      lastErrorAt: lastErrorEntry?.createdAt?.toISOString() ?? null,
    },
    backups: {
      severity: anyFailed("latestBackup", "backedUpUsers")
        ? "alert"
        : severityForBackup(latestBackup?.createdAt ?? null),
      lastBackupAt: latestBackup?.createdAt?.toISOString() ?? null,
      backedUpUsers,
      retentionDays: 90,
    },
    maintenance: {
      severity: anyFailed("lastIdempotencyCleanup", "lastAuditLogCleanup")
        ? "alert"
        : severityForMaintenance(worker.running),
      workerRunning: worker.running,
      workerUptimeSeconds,
      lastIdempotencyCleanup:
        lastIdempotencyCleanup?.createdAt?.toISOString() ?? null,
      lastAuditLogCleanup:
        lastAuditLogCleanup?.createdAt?.toISOString() ?? null,
    },
    auditLog: {
      severity: anyFailed("last30dEvents", "lastLoginEntry") ? "alert" : "info",
      eventsLast30d: last30dEvents,
      lastLoginAt: lastLoginEntry?.createdAt?.toISOString() ?? null,
    },
  };

  return apiSuccess(overview);
});
