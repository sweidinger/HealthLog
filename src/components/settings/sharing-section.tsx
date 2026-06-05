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
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Loader2, Share2, Trash2 } from "lucide-react";

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
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { useAuth } from "@/hooks/use-auth";
import { formatDate, formatDateTime } from "@/lib/format";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";

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
  expiresAt: string;
  createdAt: string;
  revokedAt: string | null;
  lastAccessAt: string | null;
  accessCount: number;
  active: boolean;
}

export function SharingSection() {
  const { t } = useTranslations();

  return (
    <section
      aria-labelledby="settings-section-sharing-title"
      className="space-y-6"
    >
      <header className="space-y-1">
        <h1
          id="settings-section-sharing-title"
          className="text-2xl font-semibold tracking-tight"
        >
          {t("settings.sections.sharing.title")}
        </h1>
        <p className="text-muted-foreground text-sm">
          {t("settings.sections.sharing.description")}
        </p>
      </header>

      <ShareLinksCard />
    </section>
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
  const [newToken, setNewToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [showRevoked, setShowRevoked] = useState(false);

  const { data: links } = useQuery({
    queryKey: queryKeys.shareLinks(),
    queryFn: async () => {
      const res = await fetch("/api/share-links");
      if (!res.ok) throw new Error("Failed");
      return (await res.json()).data.shareLinks as ShareLinkSummary[];
    },
    enabled: isAuthenticated,
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      const trimmed = label.trim();
      // Surface the same expiry-bound the server enforces before the round
      // trip, so the validation feedback is immediate.
      if (expiryDays < 1 || expiryDays > MAX_DAYS) {
        throw new Error("EXPIRY_RANGE");
      }
      const res = await fetch("/api/share-links", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          label: trimmed,
          rangeStart: isoDaysFromNow(-rangeDays),
          rangeEnd: null,
          resourceTypes,
          allowFhirApi,
          expiresAt: isoDaysFromNow(expiryDays),
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error || "FAILED");
      }
      return json.data as ShareLinkSummary & { token: string };
    },
    onSuccess: (created) => {
      setNewToken(created.token);
      setCopied(false);
      setLabel("");
      setFormError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.shareLinks() });
    },
    onError: (err: Error) => {
      setNewToken(null);
      setFormError(
        err.message === "EXPIRY_RANGE"
          ? t("settings.sharing.expiryInvalid", { max: MAX_DAYS })
          : err.message === "FAILED" || err.message === ""
            ? t("common.error")
            : err.message,
      );
    },
  });

  const revokeMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/share-links/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.shareLinks() });
    },
  });

  function toggleResourceType(type: ResourceType) {
    setResourceTypes((prev) =>
      prev.includes(type)
        ? prev.filter((r) => r !== type)
        : [...prev, type],
    );
  }

  async function copyToken() {
    if (!newToken) return;
    try {
      const origin = window.location.origin;
      await navigator.clipboard.writeText(`${origin}/c/${newToken}`);
      setCopied(true);
    } catch {
      // Clipboard can be unavailable (insecure context); the token stays
      // visible in the card so the owner can copy it by hand.
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
    <div className="bg-card border-border space-y-6 rounded-xl border p-6">
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
            <Label htmlFor="share-expiry">
              {t("settings.sharing.expiry")}
            </Label>
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
        >
          {createMutation.isPending && (
            <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
          )}
          {t("settings.sharing.create")}
        </Button>
      </form>

      {newToken && (
        <div
          className="bg-success/10 space-y-2 rounded-lg p-3 text-sm"
          data-testid="share-token-reveal"
        >
          <p className="text-success font-medium">
            {t("settings.sharing.tokenCreated")}
          </p>
          <p className="text-muted-foreground text-[11px]">
            {t("settings.sharing.tokenOnce")}
          </p>
          <div className="flex items-center gap-2">
            <code className="bg-muted block flex-1 rounded p-2 font-mono text-xs break-all">
              {`${typeof window !== "undefined" ? window.location.origin : ""}/c/${newToken}`}
            </code>
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={copyToken}
              aria-label={t("settings.sharing.copy")}
            >
              <Copy className="h-3.5 w-3.5" />
            </Button>
          </div>
          {copied && (
            <p className="text-success text-[11px]">
              {t("settings.sharing.copied")}
            </p>
          )}
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
                      className="text-destructive border-destructive/30 min-h-11 w-full"
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
    </div>
  );
}
