"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2 } from "lucide-react";

// ─── Types ────────────────────────────────────────────────

interface InsightStatusCardProps {
  title: string;
  icon: React.ReactNode;
  text: string | null;
  hasProvider: boolean;
  cached: boolean;
  updatedAt: string | null;
  loading?: boolean;
}

// ─── Main Component ───────────────────────────────────────

export function InsightStatusCard({
  title,
  icon,
  text,
  hasProvider,
  cached,
  updatedAt,
  loading = false,
}: InsightStatusCardProps) {
  // ── Loading State ─────────────────────────────────────
  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 className="h-5 w-5 animate-spin text-dracula-purple" />
          <span className="ml-2 text-sm text-muted-foreground">
            {/* TODO: i18n */}
            Wird geladen...
          </span>
        </CardContent>
      </Card>
    );
  }

  // ── No Provider State ─────────────────────────────────
  if (!hasProvider) {
    return (
      <Card className="opacity-60">
        <CardHeader className="pb-2">
          <div className="flex items-center gap-2">
            {icon}
            <CardTitle className="text-base">{title}</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            {/* TODO: i18n */}
            KI-Provider nicht konfiguriert.
          </p>
        </CardContent>
      </Card>
    );
  }

  // ── No Data State ─────────────────────────────────────
  if (!text) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center gap-2">
            {icon}
            <CardTitle className="text-base">{title}</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            {/* TODO: i18n */}
            Noch keine Analyse vorhanden.
          </p>
        </CardContent>
      </Card>
    );
  }

  // ── Populated Card ────────────────────────────────────
  return (
    <Card className="animate-insight-in border-l-2 border-l-dracula-purple">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {icon}
            <CardTitle className="text-base">{title}</CardTitle>
          </div>
          {cached && (
            <span className="text-xs text-muted-foreground">
              {/* TODO: i18n */}
              Zwischengespeichert
            </span>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="text-sm leading-relaxed text-muted-foreground">{text}</p>
        {updatedAt && (
          <p className="text-xs text-muted-foreground">
            {/* TODO: i18n */}
            Zuletzt aktualisiert:{" "}
            {new Date(updatedAt).toLocaleString("de-DE", {
              day: "2-digit",
              month: "2-digit",
              year: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
