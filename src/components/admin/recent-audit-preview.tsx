"use client";

/**
 * `<RecentAuditPreview>` — compact list of the 10 most recent audit
 * entries for the `/admin` overview landing page. The full filterable
 * viewer lives at `/admin/login-overview`.
 *
 * Reuses `/api/admin/audit-log` so the data source matches the
 * detail-page section (`<LoginOverviewSection>`).
 */

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowRight,
  CheckCircle2,
  Loader2,
  ScrollText,
  XCircle,
} from "lucide-react";
import { formatDateTime } from "@/lib/format";
import { useTranslations } from "@/lib/i18n/context";
import { type AdminAuditEntry } from "./_shared";

const PREVIEW_LIMIT = 10;

interface AuditLogResponse {
  entries: AdminAuditEntry[];
  meta: { total: number; limit: number; offset: number };
}

export function RecentAuditPreview() {
  const { t } = useTranslations();

  const { data, isLoading, isError } = useQuery({
    queryKey: ["admin", "audit-log", "overview-preview"],
    queryFn: async () => {
      const res = await fetch(
        `/api/admin/audit-log?limit=${PREVIEW_LIMIT}&filter=auth`,
      );
      if (!res.ok) throw new Error("Failed to load audit log");
      return (await res.json()).data as AuditLogResponse;
    },
    // Avoid hitting the DB on every page focus; the overview is the
    // type of page admins keep open and re-render frequently.
    staleTime: 30_000,
  });

  const AUTH_ACTION_LABELS: Record<string, string> = {
    "auth.register": t("admin.authRegister"),
    "auth.login": t("admin.authLogin"),
    "auth.login.passkey": t("admin.authLoginPasskey"),
    "auth.login.password": t("admin.authLoginPassword"),
    "auth.login.failed": t("admin.authLoginFailed"),
    "auth.logout": t("admin.authLogout"),
    "auth.passkey.register": t("admin.authPasskeyRegister"),
    "auth.passkey.delete": t("admin.authPasskeyDelete"),
  };

  const entries = data?.entries ?? [];

  return (
    <section
      aria-labelledby="admin-overview-audit-heading"
      className="bg-card border-border rounded-xl border p-6"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <ScrollText className="text-primary h-5 w-5" aria-hidden="true" />
          <h2
            id="admin-overview-audit-heading"
            className="text-lg font-semibold"
          >
            {t("admin.overview.auditTitle")}
          </h2>
        </div>
        <Link
          href="/admin/login-overview"
          className="text-primary hover:text-primary/80 inline-flex items-center gap-1 text-sm"
        >
          {t("admin.overview.auditViewAll")}
          <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
        </Link>
      </div>

      <div className="mt-4">
        {isLoading ? (
          <div className="flex items-center gap-2 py-2">
            <Loader2
              className="text-muted-foreground h-4 w-4 animate-spin"
              aria-hidden="true"
            />
            <span className="text-muted-foreground text-sm">
              {t("admin.overview.auditLoading")}
            </span>
          </div>
        ) : isError ? (
          <div
            role="alert"
            className="text-destructive bg-destructive/10 border-destructive/30 rounded-md border px-3 py-2 text-sm"
          >
            {t("admin.overview.auditLoadError")}
          </div>
        ) : entries.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            {t("admin.overview.auditEmpty")}
          </p>
        ) : (
          <ul className="divide-border divide-y">
            {entries.map((entry) => {
              const isFailed = entry.action === "auth.login.failed";
              return (
                <li
                  key={entry.id}
                  className="flex items-center gap-3 py-2 text-sm"
                >
                  <span className="shrink-0" aria-hidden="true">
                    {isFailed ? (
                      <XCircle className="text-destructive h-4 w-4" />
                    ) : (
                      <CheckCircle2 className="text-dracula-green h-4 w-4" />
                    )}
                  </span>
                  <span
                    className={`min-w-0 flex-1 truncate font-medium ${isFailed ? "text-destructive" : ""}`}
                  >
                    {entry.user?.username ?? t("common.unknown")}
                  </span>
                  <span
                    className={`hidden truncate sm:inline ${isFailed ? "text-destructive" : "text-muted-foreground"}`}
                  >
                    {AUTH_ACTION_LABELS[entry.action] ?? entry.action}
                  </span>
                  <span className="text-muted-foreground shrink-0 text-xs whitespace-nowrap">
                    {formatDateTime(entry.createdAt)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
