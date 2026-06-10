"use client";

/**
 * v1.15.20 — admin card for registration invites (Users section).
 *
 * Mint an invite (7 / 14 / 30-day lifetime), hand it over as a link or
 * QR code, see the open invites, revoke one. The raw token + URL + QR
 * appear exactly once — straight from the POST response — and are gone
 * after a reload; the list endpoint only ever returns metadata.
 *
 * The QR data-URL is rendered inside the mutation (not in an effect):
 * `qrcode`'s `toDataURL` is async, so folding it into `mutationFn`
 * keeps the component free of setState-in-effect churn.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Loader2, Ticket, Trash2 } from "lucide-react";
import QRCode from "qrcode";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatDate } from "@/lib/format";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";

interface AdminInvite {
  id: string;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  uses: number;
  maxUses: number;
  creator: { id: string; username: string } | null;
  consumer: { id: string; username: string } | null;
}

interface MintedInvite {
  id: string;
  token: string;
  url: string;
  expiresAt: string;
  qrDataUrl: string;
}

type InviteStatus = "active" | "expired" | "exhausted";

function deriveStatus(invite: AdminInvite, now: Date): InviteStatus {
  if (invite.uses >= invite.maxUses) return "exhausted";
  if (new Date(invite.expiresAt).getTime() <= now.getTime()) return "expired";
  return "active";
}

const TTL_CHOICES = [7, 14, 30] as const;

export function InviteTokensSection() {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const [minted, setMinted] = useState<MintedInvite | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AdminInvite | null>(null);

  const { data: invites, isError } = useQuery({
    queryKey: queryKeys.adminInvites(),
    queryFn: async () => {
      const res = await fetch("/api/admin/invites");
      if (!res.ok) throw new Error("Failed");
      return (await res.json()).data as AdminInvite[];
    },
  });

  const create = useMutation({
    mutationKey: queryKeys.adminInvites(),
    mutationFn: async (expiresInDays: number): Promise<MintedInvite> => {
      const res = await fetch("/api/admin/invites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expiresInDays }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()).data as Omit<MintedInvite, "qrDataUrl">;
      const qrDataUrl = await QRCode.toDataURL(data.url, {
        width: 240,
        margin: 1,
      });
      return { ...data, qrDataUrl };
    },
    onSuccess: (invite) => {
      setMinted(invite);
      toast.success(t("admin.invites.createdToast"));
      queryClient.invalidateQueries({ queryKey: queryKeys.adminInvites() });
    },
    onError: () => {
      toast.error(t("admin.invites.createError"));
    },
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/admin/invites/${id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    },
    onSuccess: (_data, id) => {
      toast.success(t("admin.invites.deletedToast"));
      if (minted?.id === id) setMinted(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.adminInvites() });
    },
    onError: () => {
      toast.error(t("admin.invites.deleteError"));
    },
  });

  async function copyUrl(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      toast.success(t("admin.invites.copiedToast"));
    } catch {
      toast.error(t("admin.invites.copyError"));
    }
  }

  const now = new Date();

  return (
    <div
      className="bg-card border-border rounded-xl border p-4 sm:p-6"
      data-testid="admin-invites-card"
    >
      <div className="flex items-center gap-2">
        <Ticket className="text-primary h-5 w-5" aria-hidden="true" />
        <h2 className="text-lg font-semibold">{t("admin.invites.title")}</h2>
      </div>
      <p className="text-muted-foreground mt-1 text-sm">
        {t("admin.invites.description")}
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">
          {t("admin.invites.createLabel")}
        </span>
        {TTL_CHOICES.map((days) => (
          <Button
            key={days}
            type="button"
            variant="outline"
            size="sm"
            disabled={create.isPending}
            onClick={() => create.mutate(days)}
            data-testid={`admin-invites-create-${days}`}
          >
            {create.isPending ? (
              <Loader2
                className="h-4 w-4 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            ) : null}
            {t("admin.invites.createDays", { days })}
          </Button>
        ))}
      </div>

      {minted && (
        <div
          className="border-border bg-background mt-4 space-y-3 rounded-lg border p-4"
          data-testid="admin-invites-minted"
        >
          <p className="text-sm font-medium">{t("admin.invites.tokenTitle")}</p>
          <p className="text-muted-foreground text-xs">
            {t("admin.invites.tokenOnceHint")}
          </p>
          <p className="bg-muted overflow-x-auto rounded-md p-2 font-mono text-xs break-all">
            {minted.url}
          </p>
          <div className="flex flex-wrap items-start gap-4">
            {/* eslint-disable-next-line @next/next/no-img-element -- data-URL QR, no remote loader involved */}
            <img
              src={minted.qrDataUrl}
              alt={t("admin.invites.qrAlt")}
              width={160}
              height={160}
              className="rounded-md bg-white p-2"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => copyUrl(minted.url)}
            >
              <Copy className="h-4 w-4" aria-hidden="true" />
              {t("admin.invites.copyLink")}
            </Button>
          </div>
        </div>
      )}

      <div className="mt-6 space-y-2">
        {isError && (
          <p className="text-destructive text-sm">
            {t("admin.invites.loadError")}
          </p>
        )}
        {invites && invites.length === 0 && (
          <p className="text-muted-foreground text-sm">
            {t("admin.invites.listEmpty")}
          </p>
        )}
        {invites?.map((invite) => {
          const status = deriveStatus(invite, now);
          // Literal keys so the i18n call-site coverage guard sees them.
          const statusLabel =
            status === "active"
              ? t("admin.invites.statusActive")
              : status === "expired"
                ? t("admin.invites.statusExpired")
                : t("admin.invites.statusExhausted");
          return (
            <div
              key={invite.id}
              className="border-border flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3"
            >
              <div className="min-w-0 space-y-0.5">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <Badge
                    variant={status === "active" ? "default" : "secondary"}
                  >
                    {statusLabel}
                  </Badge>
                  <span className="text-muted-foreground text-xs">
                    {t("admin.invites.expires", {
                      date: formatDate(invite.expiresAt),
                    })}
                  </span>
                  <span className="text-muted-foreground text-xs tabular-nums">
                    {t("admin.invites.uses", {
                      used: invite.uses,
                      max: invite.maxUses,
                    })}
                  </span>
                </div>
                <p className="text-muted-foreground text-xs">
                  {t("admin.invites.createdMeta", {
                    date: formatDate(invite.createdAt),
                    by: invite.creator?.username ?? "—",
                  })}
                  {invite.consumer
                    ? ` · ${t("admin.invites.usedBy", {
                        username: invite.consumer.username,
                      })}`
                    : ""}
                </p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-destructive"
                aria-label={t("admin.invites.deleteAria")}
                disabled={remove.isPending}
                onClick={() => setDeleteTarget(invite)}
              >
                <Trash2 className="h-4 w-4" aria-hidden="true" />
              </Button>
            </div>
          );
        })}
      </div>

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("admin.invites.deleteConfirmTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("admin.invites.deleteConfirmBody")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("admin.invites.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (deleteTarget) remove.mutate(deleteTarget.id);
                setDeleteTarget(null);
              }}
            >
              {t("admin.invites.deleteConfirmAction")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
