"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, Key, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
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
    <div className="bg-card border-border overflow-hidden rounded-xl border p-4 sm:p-6">
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
            // v1.4.15 phase-C5: empty state explains where tokens come
            // from (native client sign-in / Settings → Account) so a
            // fresh admin doesn't think they need to create them here.
            <EmptyState
              icon={<Key className="size-6" />}
              title={t("admin.tokensEmptyTitle")}
              description={t("admin.tokensEmptyDescription")}
            />
          ) : (
            <>
              {/* Desktop table — verbatim layout for md+. The wrapping
                  `hidden md:block` swaps it out for the card-list below
                  on mobile, mirroring the pattern used in
                  `<UserManagementSection>`. The inner `overflow-x-auto`
                  is a belt-and-suspenders guard for medium viewports
                  with extra-long permission lists. */}
              <div className="hidden overflow-x-auto md:block">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-muted-foreground border-b text-xs">
                      <th className="px-3 py-2 text-left font-medium">
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
                      <th className="px-3 py-2 text-right font-medium">
                        {t("admin.tokenLastUsed")}
                      </th>
                      <th className="px-3 py-2 text-right font-medium">
                        {t("admin.tokenCreated")}
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-border divide-y">
                    {tokens.map((token, i) => {
                      const isExpired =
                        token.expiresAt &&
                        new Date(token.expiresAt) < new Date();
                      return (
                        <tr
                          key={token.id}
                          className={i % 2 === 0 ? "bg-muted/30" : ""}
                        >
                          <td className="px-3 py-2 font-medium">
                            {token.user.username}
                          </td>
                          <td className="px-3 py-2">{token.name}</td>
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
                          <td className="text-muted-foreground px-3 py-2 text-right text-xs whitespace-nowrap">
                            {token.lastUsedAt
                              ? formatDateTime(token.lastUsedAt)
                              : t("admin.tokenNeverUsed")}
                          </td>
                          <td className="text-muted-foreground px-3 py-2 text-right text-xs whitespace-nowrap">
                            {formatDate(token.createdAt)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Mobile card list — each token renders as a self-
                  contained card with a stacked meta layout. No
                  horizontal scroll: every cell wraps within the card
                  width. Mirrors `<UserManagementSection>`. */}
              <ul
                className="space-y-2 md:hidden"
                data-testid="admin-tokens-mobile-list"
              >
                {tokens.map((token) => {
                  const isExpired =
                    token.expiresAt && new Date(token.expiresAt) < new Date();
                  return (
                    <li
                      key={token.id}
                      className="bg-muted/30 border-border rounded-lg border p-3"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="truncate font-medium break-all">
                              {token.name}
                            </span>
                            {token.revoked ? (
                              <Badge
                                variant="destructive"
                                className="text-[10px]"
                              >
                                {t("settings.tokenRevoked")}
                              </Badge>
                            ) : isExpired ? (
                              <Badge
                                variant="destructive"
                                className="text-[10px]"
                              >
                                {t("settings.tokenExpired")}
                              </Badge>
                            ) : (
                              <Badge className="bg-dracula-green/15 text-dracula-green text-[10px]">
                                {t("common.active")}
                              </Badge>
                            )}
                          </div>
                          <p className="text-muted-foreground truncate text-xs">
                            {token.user.username}
                          </p>
                        </div>
                      </div>
                      <div className="mt-2 flex flex-wrap gap-1">
                        {token.permissions.map((p) => (
                          <Badge
                            key={p}
                            variant="secondary"
                            className="text-[10px] break-all"
                          >
                            {p}
                          </Badge>
                        ))}
                      </div>
                      <p className="text-muted-foreground mt-2 text-[11px]">
                        {t("admin.tokenLastUsed")}:{" "}
                        {token.lastUsedAt
                          ? formatDateTime(token.lastUsedAt)
                          : t("admin.tokenNeverUsed")}
                      </p>
                      <p className="text-muted-foreground text-[11px]">
                        {t("admin.tokenCreated")}: {formatDate(token.createdAt)}
                      </p>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}
