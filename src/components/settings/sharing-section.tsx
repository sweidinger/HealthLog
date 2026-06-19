"use client";

/**
 * v1.11.0 — Settings → Sharing (Epic C, C7).
 *
 * The OWNER surface for clinician share links. A share link is a time-boxed,
 * scope-frozen, read-only view of the owner's own health record at
 * `/c/<token>`, optionally exposing a scoped read-only FHIR face. The raw
 * `hls_` token is shown EXACTLY ONCE on create — the list never carries it
 * (the server only stores its hash), so the copy-on-create card is the single
 * chance to capture it.
 *
 * Client island: the create form, the active/revoked lists, and the revoke
 * action all need state and mutate via the C4 lifecycle API
 * (`/api/share-links`). Reads unwrap `(await res.json()).data`; the query key
 * comes from the centralised factory. No markdown anywhere — every value
 * renders as escaped React text.
 *
 * v1.18.7 — restored as a first-class Settings section. The visible heading +
 * subtitle now come from the shared shell chrome in the route; this body is
 * the share-links card. Cards paint through `<SettingsCard>` so the surface
 * matches every sibling section 1:1.
 */
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import QRCode from "qrcode";
import { Copy, KeyRound, Loader2, Share2, Trash2 } from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { useAuth } from "@/hooks/use-auth";
import { formatDate, formatDateTime } from "@/lib/format";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { apiDelete, apiGet, apiPost } from "@/lib/api/api-fetch";

/** The FHIR resource types a share link may serve — mirrors C4's enum. */
const RESOURCE_TYPES = [
  "Patient",
  "Observation",
  "MedicationStatement",
  "MedicationAdministration",
] as const;
type ResourceType = (typeof RESOURCE_TYPES)[number];

/** Maximum lifetime, in days — mirrors `SHARE_LINK_MAX_DAYS` on the server. */
const MAX_DAYS = 90;
const DEFAULT_DAYS = 30;

/** Owner-facing shape returned by `GET /api/share-links` (never the token). */
interface ShareLinkSummary {
  id: string;
  label: string;
  rangeStart: string;
  rangeEnd: string | null;
  resourceTypes: string[];
  allowFhirApi: boolean;
  /** v1.18.7 — whether a passphrase second factor guards this link. */
  protected: boolean;
  expiresAt: string;
  createdAt: string;
  revokedAt: string | null;
  lastAccessAt: string | null;
  accessCount: number;
  active: boolean;
}

/**
 * v1.18.7 — the create response. The token, passphrase, and URLs are returned
 * EXACTLY ONCE here; the list query never carries them (the server stores only
 * hashes). `qrUrl` carries the passphrase in the URL fragment (`#k=`).
 */
interface ShareLinkCreated extends ShareLinkSummary {
  token: string;
  passphrase: string;
  shareUrl: string;
  qrUrl: string;
}

export function SharingSection() {
  // v1.18.7 — the visible heading + subtitle come from the shared settings
  // shell chrome in the route; this body is the share-links card only.
  return (
    <div className="space-y-6">
      <ShareLinksCard />
    </div>
  );
}

function isoDaysFromNow(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

function ShareLinksCard() {
  const { t } = useTranslations();
  const { isAuthenticated } = useAuth();
  const queryClient = useQueryClient();

  const [label, setLabel] = useState("");
  const [rangeDays, setRangeDays] = useState(DEFAULT_DAYS);
  const [expiryDays, setExpiryDays] = useState(DEFAULT_DAYS);
  const [allowFhirApi, setAllowFhirApi] = useState(false);
  const [resourceTypes, setResourceTypes] = useState<ResourceType[]>([
    "Patient",
    "Observation",
  ]);
  const [created, setCreated] = useState<ShareLinkCreated | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState<"link" | "passphrase" | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [showRevoked, setShowRevoked] = useState(false);

  // Render the QR from the `#k=` deep link once a link is created. The fragment
  // carries the passphrase, so the QR alone opens the record — it is shown
  // exactly once alongside the passphrase text. The QR is keyed off `qrUrl` so
  // a re-create swaps it; the effect only WRITES on async completion (never a
  // synchronous reset), so it does not trigger a cascading render.
  const qrUrl = created?.qrUrl ?? null;
  useEffect(() => {
    if (!qrUrl) return;
    let cancelled = false;
    QRCode.toDataURL(qrUrl, { margin: 1, width: 220 })
      .then((url) => {
        if (!cancelled) setQrDataUrl(url);
      })
      .catch(() => {
        /* clipboard/QR can fail in some contexts; the link + passphrase text
           are still shown so the owner can share them by hand */
      });
    return () => {
      cancelled = true;
    };
  }, [qrUrl]);

  const { data: links } = useQuery({
    queryKey: queryKeys.shareLinks(),
    queryFn: () =>
      apiGet<{ shareLinks: ShareLinkSummary[] }>("/api/share-links").then(
        (data) => data.shareLinks,
      ),
    enabled: isAuthenticated,
  });

  const createMutation = useMutation({
    mutationFn: () => {
      const trimmed = label.trim();
      // Surface the same expiry-bound the server enforces before the round
      // trip, so the validation feedback is immediate.
      if (expiryDays < 1 || expiryDays > MAX_DAYS) {
        return Promise.reject(new Error("EXPIRY_RANGE"));
      }
      return apiPost<ShareLinkCreated>("/api/share-links", {
        label: trimmed,
        rangeStart: isoDaysFromNow(-rangeDays),
        rangeEnd: null,
        resourceTypes,
        allowFhirApi,
        expiresAt: isoDaysFromNow(expiryDays),
      });
    },
    onSuccess: (result) => {
      // Clear any stale QR before the effect renders the new one.
      setQrDataUrl(null);
      setCreated(result);
      setCopied(null);
      setLabel("");
      setFormError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.shareLinks() });
    },
    onError: (err: Error) => {
      setCreated(null);
      setFormError(
        err.message === "EXPIRY_RANGE"
          ? t("settings.sharing.expiryInvalid", { max: MAX_DAYS })
          : t("common.error"),
      );
    },
  });

  const revokeMutation = useMutation({
    mutationFn: (id: string) => apiDelete(`/api/share-links/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.shareLinks() });
    },
  });

  function toggleResourceType(type: ResourceType) {
    setResourceTypes((prev) =>
      prev.includes(type) ? prev.filter((r) => r !== type) : [...prev, type],
    );
  }

  async function copyValue(value: string, which: "link" | "passphrase") {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(which);
    } catch {
      // Clipboard can be unavailable (insecure context); the values stay
      // visible in the card so the owner can copy them by hand.
    }
  }

  const activeLinks = useMemo(
    () => (links ?? []).filter((l) => l.active),
    [links],
  );
  const inactiveLinks = useMemo(
    () => (links ?? []).filter((l) => !l.active),
    [links],
  );

  return (
    <SettingsCard className="space-y-6">
      <SettingsCardHeader
        icon={Share2}
        title={t("settings.sharing.createTitle")}
        description={t("settings.sharing.createDescription")}
      />

      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          createMutation.mutate();
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor="share-label">{t("settings.sharing.label")}</Label>
          <Input
            id="share-label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={t("settings.sharing.labelPlaceholder")}
            maxLength={120}
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="share-range">{t("settings.sharing.range")}</Label>
            <Input
              id="share-range"
              type="number"
              min={1}
              max={3650}
              value={rangeDays}
              onChange={(e) =>
                setRangeDays(Math.max(1, Number(e.target.value) || 1))
              }
            />
            <p className="text-muted-foreground text-[11px]">
              {t("settings.sharing.rangeHint")}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="share-expiry">{t("settings.sharing.expiry")}</Label>
            <Input
              id="share-expiry"
              type="number"
              min={1}
              max={MAX_DAYS}
              value={expiryDays}
              onChange={(e) =>
                setExpiryDays(Math.max(1, Number(e.target.value) || 1))
              }
              aria-invalid={expiryDays < 1 || expiryDays > MAX_DAYS}
            />
            <p className="text-muted-foreground text-[11px]">
              {t("settings.sharing.expiryHint", { max: MAX_DAYS })}
            </p>
          </div>
        </div>

        <div className="border-border flex items-center justify-between rounded-lg border p-3">
          <div className="space-y-0.5 pr-3">
            <Label htmlFor="share-fhir" className="text-sm font-medium">
              {t("settings.sharing.fhirApi")}
            </Label>
            <p className="text-muted-foreground text-[11px]">
              {t("settings.sharing.fhirApiHint")}
            </p>
          </div>
          <Switch
            id="share-fhir"
            checked={allowFhirApi}
            onCheckedChange={setAllowFhirApi}
          />
        </div>

        {allowFhirApi && (
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">
              {t("settings.sharing.resourceTypes")}
            </legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {RESOURCE_TYPES.map((type) => (
                <label
                  key={type}
                  className="flex items-center gap-2 text-sm"
                  htmlFor={`share-rt-${type}`}
                >
                  <Checkbox
                    id={`share-rt-${type}`}
                    checked={resourceTypes.includes(type)}
                    onCheckedChange={() => toggleResourceType(type)}
                  />
                  <span className="font-mono text-xs">{type}</span>
                </label>
              ))}
            </div>
          </fieldset>
        )}

        {formError && (
          <p role="alert" className="text-destructive text-sm">
            {formError}
          </p>
        )}

        <Button
          type="submit"
          disabled={createMutation.isPending || !label.trim()}
          className="min-h-11 sm:min-h-9"
        >
          {createMutation.isPending && (
            <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
          )}
          {t("settings.sharing.create")}
        </Button>
      </form>

      {created && (
        <div
          className="bg-success/10 space-y-3 rounded-lg p-3 text-sm"
          data-testid="share-token-reveal"
        >
          <p className="text-success font-medium">
            {t("settings.sharing.tokenCreated")}
          </p>
          <p className="text-muted-foreground text-[11px]">
            {t("settings.sharing.shownOnce")}
          </p>

          {/* QR — carries the passphrase in the URL fragment, so scanning it
              opens the record. Shown exactly once with the passphrase text. */}
          {qrDataUrl && (
            <div className="space-y-1">
              <p className="text-foreground text-[11px] font-medium">
                {t("settings.sharing.qrLabel")}
              </p>
              {/* The QR is a transient secret render, not stored content. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={qrDataUrl}
                alt={t("settings.sharing.qrAlt")}
                width={220}
                height={220}
                className="bg-background rounded border p-2"
              />
            </div>
          )}

          {/* The link (no passphrase). On its own it cannot open the record. */}
          <div className="space-y-1">
            <p className="text-foreground text-[11px] font-medium">
              {t("settings.sharing.linkLabel")}
            </p>
            <div className="flex items-center gap-2">
              <code className="bg-muted block flex-1 rounded p-2 font-mono text-xs break-all">
                {created.shareUrl}
              </code>
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="min-h-11 min-w-11 shrink-0 sm:h-9 sm:w-9"
                onClick={() => copyValue(created.shareUrl, "link")}
                aria-label={t("settings.sharing.copyLink")}
              >
                <Copy className="h-3.5 w-3.5" />
              </Button>
            </div>
            {copied === "link" && (
              <p className="text-success text-[11px]">
                {t("settings.sharing.copied")}
              </p>
            )}
          </div>

          {/* The passphrase — the second factor. Shown once; only its hash is
              stored, so it cannot be recovered. */}
          <div className="space-y-1">
            <p className="text-foreground text-[11px] font-medium">
              {t("settings.sharing.passphraseLabel")}
            </p>
            <div className="flex items-center gap-2">
              <code
                className="bg-muted block flex-1 rounded p-2 font-mono text-xs break-all"
                data-testid="share-passphrase"
              >
                {created.passphrase}
              </code>
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="min-h-11 min-w-11 shrink-0 sm:h-9 sm:w-9"
                onClick={() => copyValue(created.passphrase, "passphrase")}
                aria-label={t("settings.sharing.copyPassphrase")}
              >
                <Copy className="h-3.5 w-3.5" />
              </Button>
            </div>
            {copied === "passphrase" && (
              <p className="text-success text-[11px]">
                {t("settings.sharing.copied")}
              </p>
            )}
            <p className="text-muted-foreground text-[11px]">
              {t("settings.sharing.passphraseHint")}
            </p>
          </div>
        </div>
      )}

      <div className="space-y-2">
        <h3 className="text-sm font-medium">
          {t("settings.sharing.activeTitle")}
        </h3>
        {activeLinks.length === 0 ? (
          <p
            className="text-muted-foreground rounded-lg border border-dashed px-3 py-4 text-center text-sm"
            data-testid="share-active-empty"
          >
            {t("settings.sharing.noActive")}
          </p>
        ) : (
          <ul className="space-y-2" data-testid="share-active-list">
            {activeLinks.map((link) => (
              <li
                key={link.id}
                className="bg-muted/30 border-border space-y-2 rounded-lg border p-3"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <p className="min-w-0 flex-1 text-sm font-medium break-words">
                    {link.label}
                  </p>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge className="bg-success/15 text-success text-[10px]">
                      {t("settings.sharing.statusActive")}
                    </Badge>
                    {link.protected && (
                      <Badge
                        variant="outline"
                        className="gap-1 text-[10px]"
                        data-testid="share-protected-badge"
                      >
                        <KeyRound className="h-2.5 w-2.5" />
                        {t("settings.sharing.protected")}
                      </Badge>
                    )}
                    {link.allowFhirApi && (
                      <Badge variant="outline" className="text-[10px]">
                        FHIR
                      </Badge>
                    )}
                  </div>
                </div>
                <p className="text-muted-foreground text-[11px]">
                  <span className="font-medium">
                    {t("settings.sharing.created")}:
                  </span>{" "}
                  {formatDate(link.createdAt)}
                </p>
                <p className="text-muted-foreground text-[11px]">
                  <span className="font-medium">
                    {t("settings.sharing.expires")}:
                  </span>{" "}
                  {formatDateTime(link.expiresAt)}
                </p>
                <p className="text-muted-foreground text-[11px]">
                  <span className="font-medium">
                    {t("settings.sharing.accessCount")}:
                  </span>{" "}
                  {link.accessCount}
                  {link.lastAccessAt
                    ? ` · ${formatDateTime(link.lastAccessAt)}`
                    : ""}
                </p>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      className="text-destructive border-destructive/30 min-h-11 w-full sm:min-h-9"
                    >
                      <Trash2 className="mr-2 h-3.5 w-3.5" />
                      {t("settings.sharing.revoke")}
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>
                        {t("settings.sharing.revoke")}
                      </AlertDialogTitle>
                      <AlertDialogDescription>
                        {t("settings.sharing.revokeDescription")}
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>
                        {t("common.cancel")}
                      </AlertDialogCancel>
                      <AlertDialogAction
                        className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                        onClick={() => revokeMutation.mutate(link.id)}
                      >
                        {t("settings.sharing.revoke")}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </li>
            ))}
          </ul>
        )}
      </div>

      {inactiveLinks.length > 0 && (
        <div className="space-y-2">
          <button
            type="button"
            onClick={() => setShowRevoked((prev) => !prev)}
            className="text-foreground hover:text-primary text-sm font-medium transition-colors"
          >
            {t("settings.sharing.inactiveTitle", {
              count: inactiveLinks.length,
            })}
          </button>
          {showRevoked && (
            <ul className="space-y-2" data-testid="share-inactive-list">
              {inactiveLinks.map((link) => (
                <li
                  key={link.id}
                  className="bg-muted/20 border-border space-y-1.5 rounded-lg border p-3"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <p className="min-w-0 flex-1 text-sm font-medium break-words">
                      {link.label}
                    </p>
                    <Badge variant="secondary" className="text-[10px]">
                      {link.revokedAt
                        ? t("settings.sharing.statusRevoked")
                        : t("settings.sharing.statusExpired")}
                    </Badge>
                  </div>
                  <p className="text-muted-foreground text-[11px]">
                    <span className="font-medium">
                      {t("settings.sharing.accessCount")}:
                    </span>{" "}
                    {link.accessCount}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </SettingsCard>
  );
}
