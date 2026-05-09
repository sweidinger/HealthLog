"use client";

import {
  Activity,
  AlertTriangle,
  Bell,
  BellRing,
  Bug,
  Clock,
  Cog,
  Database,
  Globe,
  Key,
  Loader2,
  Server,
  Users,
} from "lucide-react";
import { formatDateTime } from "@/lib/format";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { StatusItem, useSystemStatus } from "./_shared";

export function SystemStatusSection() {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const { data: status, isError } = useSystemStatus();

  return (
    <div className="bg-card border-border rounded-xl border p-6">
      <div className="flex items-center gap-2">
        <Server className="text-primary h-5 w-5" />
        <div className="text-lg font-semibold">{t("admin.systemStatus")}</div>
      </div>
      {status ? (
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatusItem
            icon={Database}
            label={t("admin.database")}
            value={
              status.database === "connected"
                ? t("admin.databaseConnected")
                : t("admin.databaseError")
            }
            className={
              status.database === "connected"
                ? "text-dracula-green"
                : "text-destructive"
            }
          />
          <StatusItem
            icon={Clock}
            label={t("admin.startedAt")}
            value={formatDateTime(status.startTime)}
          />
          <StatusItem
            icon={Users}
            label={t("admin.users")}
            value={String(status.counts.users)}
          />
          <StatusItem
            icon={Activity}
            label={t("admin.measurementsCount")}
            value={fmt.integer(status.counts.measurements)}
          />
          <StatusItem
            icon={Key}
            label={t("admin.activeTokens")}
            value={String(status.counts.activeTokens)}
          />
          <StatusItem
            icon={Globe}
            label={t("admin.activeSessions")}
            value={String(status.counts.activeSessions)}
          />
          <StatusItem
            icon={Cog}
            label={t("admin.workerStatus")}
            value={
              status.worker.running
                ? t("admin.workerRunning")
                : t("admin.workerStopped")
            }
            className={
              status.worker.running ? "text-dracula-green" : "text-destructive"
            }
          />
          {status.worker.lastReminderCheck && (
            <StatusItem
              icon={Bell}
              label={t("admin.lastReminderCheck")}
              value={formatDateTime(status.worker.lastReminderCheck)}
            />
          )}
          {status.integrations.umami && (
            <StatusItem
              icon={Activity}
              label="Umami"
              value={
                status.integrations.umami.enabled
                  ? t("common.active")
                  : t("common.disabled")
              }
              className={
                status.integrations.umami.enabled
                  ? "text-dracula-green"
                  : "text-destructive"
              }
            />
          )}
          {status.integrations.glitchtip && (
            <StatusItem
              icon={AlertTriangle}
              label="GlitchTip"
              value={
                status.integrations.glitchtip.enabled
                  ? t("common.active")
                  : t("common.disabled")
              }
              className={
                status.integrations.glitchtip.enabled
                  ? "text-dracula-green"
                  : "text-destructive"
              }
            />
          )}
          {status.integrations.webPush && (
            <StatusItem
              icon={BellRing}
              label={t("admin.integrationWebPush")}
              value={t("admin.configured")}
              className="text-dracula-green"
            />
          )}
          {status.integrations.bugReport && (
            <StatusItem
              icon={Bug}
              label={t("admin.integrationBugReport")}
              value={t("admin.configured")}
              className="text-dracula-green"
            />
          )}
        </div>
      ) : isError ? (
        // P19: surface load failures inline instead of leaving the
        // section spinning forever. The hook throws on non-OK
        // responses, so isError is true on 500s, network errors, etc.
        <div
          role="alert"
          className="text-destructive bg-destructive/10 border-destructive/30 mt-4 rounded-md border px-3 py-2 text-sm"
        >
          {t("admin.systemStatusLoadError")}
        </div>
      ) : (
        <div className="mt-4 flex items-center gap-2">
          <Loader2 className="text-muted-foreground h-4 w-4 animate-spin" />
          <span className="text-muted-foreground text-sm">
            {t("admin.loadingStatus")}
          </span>
        </div>
      )}
    </div>
  );
}
