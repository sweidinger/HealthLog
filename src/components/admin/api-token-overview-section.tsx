"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, Key, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatDate, formatDateTime } from "@/lib/format";
import { useTranslations } from "@/lib/i18n/context";
import { type ApiTokenInfo } from "./_shared";

export function ApiTokenOverviewSection() {
  const { t } = useTranslations();
  // v1.5 phase-4b moved this to a dedicated route (`/admin/api-tokens`),
  // so the user has already opted into seeing tokens by visiting the
  // page. Default to expanded; the toggle stays as an escape hatch.
  const [expanded, setExpanded] = useState(true);

  const { data: tokens, isLoading } = useQuery({
    queryKey: ["admin", "tokens"],
    queryFn: async () => {
      const res = await fetch("/api/admin/tokens");
      if (!res.ok) throw new Error("Failed");
      return (await res.json()).data as ApiTokenInfo[];
    },
    enabled: expanded,
  });

  return (
    <div className="bg-card border-border rounded-xl border p-4 sm:p-6">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Key className="text-primary h-5 w-5" />
          <div className="text-lg font-semibold">{t("admin.apiTokens")}</div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setExpanded((prev) => !prev)}
          aria-expanded={expanded}
        >
          {expanded ? t("settings.collapse") : t("settings.expand")}
          <ChevronDown
            className={`ml-1 h-4 w-4 transition-transform ${expanded ? "rotate-180" : ""}`}
          />
        </Button>
      </div>

      {expanded && (
        <div className="mt-4">
          {isLoading ? (
            <div className="flex justify-center py-4">
              <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
            </div>
          ) : !tokens?.length ? (
            <p className="text-muted-foreground text-sm">
              {t("admin.noTokens")}
            </p>
          ) : (
            // Mobile fits within the card by hiding lower-priority
            // columns (user, last-used, created) until `sm`. The
            // remaining `overflow-x-auto` is a belt-and-suspenders
            // guard for ultra-narrow viewports — the table still
            // scrolls within its container instead of forcing the
            // page itself to scroll horizontally.
            <div className="-mx-2 overflow-x-auto sm:mx-0">
              <table className="w-full min-w-0 text-sm">
                <thead>
                  <tr className="text-muted-foreground border-b text-xs">
                    <th className="hidden px-3 py-2 text-left font-medium sm:table-cell">
                      {t("admin.tokenUser")}
                    </th>
                    <th className="px-3 py-2 text-left font-medium">
                      {t("admin.tokenName")}
                    </th>
                    <th className="px-3 py-2 text-left font-medium">
                      {t("admin.tokenPermissions")}
                    </th>
                    <th className="px-3 py-2 text-right font-medium">
                      {t("admin.tokenStatus")}
                    </th>
                    <th className="hidden px-3 py-2 text-right font-medium md:table-cell">
                      {t("admin.tokenLastUsed")}
                    </th>
                    <th className="hidden px-3 py-2 text-right font-medium md:table-cell">
                      {t("admin.tokenCreated")}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-border divide-y">
                  {tokens.map((token, i) => {
                    const isExpired =
                      token.expiresAt && new Date(token.expiresAt) < new Date();
                    return (
                      <tr
                        key={token.id}
                        className={i % 2 === 0 ? "bg-muted/30" : ""}
                      >
                        <td className="hidden px-3 py-2 font-medium sm:table-cell">
                          {token.user.username}
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex flex-col gap-0.5">
                            <span>{token.name}</span>
                            {/* On mobile the user column is hidden, so
                                surface the username inline under the
                                token name instead of dropping it. */}
                            <span className="text-muted-foreground text-xs sm:hidden">
                              {token.user.username}
                            </span>
                          </div>
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex flex-wrap gap-1">
                            {token.permissions.map((p) => (
                              <Badge
                                key={p}
                                variant="secondary"
                                className="text-xs"
                              >
                                {p}
                              </Badge>
                            ))}
                          </div>
                        </td>
                        <td className="px-3 py-2 text-right">
                          {token.revoked ? (
                            <Badge variant="destructive" className="text-xs">
                              {t("settings.tokenRevoked")}
                            </Badge>
                          ) : isExpired ? (
                            <Badge variant="destructive" className="text-xs">
                              {t("settings.tokenExpired")}
                            </Badge>
                          ) : (
                            <Badge className="bg-dracula-green/15 text-dracula-green text-xs">
                              {t("common.active")}
                            </Badge>
                          )}
                        </td>
                        <td className="text-muted-foreground hidden px-3 py-2 text-right text-xs whitespace-nowrap md:table-cell">
                          {token.lastUsedAt
                            ? formatDateTime(token.lastUsedAt)
                            : t("admin.tokenNeverUsed")}
                        </td>
                        <td className="text-muted-foreground hidden px-3 py-2 text-right text-xs whitespace-nowrap md:table-cell">
                          {formatDate(token.createdAt)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
