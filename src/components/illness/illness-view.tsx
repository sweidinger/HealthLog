"use client";

/**
 * v1.18.1 — the illness / condition-journal surface.
 *
 * A calm, retrospective journal: the episode history (newest first) with a
 * neutral status Badge (active / recovered — never an alarming colour, the
 * med-card rule generalised), a shared overflow kebab (Edit / Mark recovered /
 * AlertDialog-gated Delete), a "log a day" entry, and the cross-episode
 * retrospective summary. Each row navigates to the episode-detail surface
 * (`/illness/[id]`) for the correlation card. Retrospective-only copy — a
 * journal, not a medical device, and it does not diagnose.
 */
import { useState } from "react";
import Link from "next/link";
import { ChevronRight, Plus, Stethoscope } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useTranslations, useFormatters } from "@/lib/i18n/context";

import { LogDaySheet } from "./log-day-sheet";
import { NewEpisodeSheet } from "./new-episode-sheet";
import { EpisodeMenu } from "./episode-menu";
import { IllnessInsightsCard } from "./illness-insights-card";
import { useIllnessEpisodes, useResolveEpisode } from "./use-illness";
import type { IllnessEpisodeDTO } from "./types";

/** Today as a YYYY-MM-DD string in the viewer's local calendar. */
function todayLocal(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function EpisodeRow({
  episode,
  onLogDay,
  onEdit,
  onResolve,
  resolving,
}: {
  episode: IllnessEpisodeDTO;
  onLogDay: (id: string) => void;
  onEdit: (episode: IllnessEpisodeDTO) => void;
  onResolve: (id: string) => void;
  resolving: boolean;
}) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const active = episode.resolvedAt === null;
  const isChronic = episode.lifecycle === "CHRONIC_ONGOING";

  return (
    <Card className="flex items-center gap-3 p-4">
      <Link href={`/illness/${episode.id}`} className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium">{episode.label}</span>
          <Badge variant="secondary">{t(`illness.type.${episode.type}`)}</Badge>
          <Badge variant="outline">
            {active
              ? isChronic
                ? t("illness.status.ongoing")
                : t("illness.status.active")
              : t("illness.status.recovered")}
          </Badge>
        </div>
        <p className="text-muted-foreground mt-1 text-xs">
          {t("illness.onsetOn", { date: fmt.dateShort(new Date(episode.onsetAt)) })}
          {episode.resolvedAt
            ? ` · ${t("illness.recoveredOn", {
                date: fmt.dateShort(new Date(episode.resolvedAt)),
              })}`
            : ""}
        </p>
      </Link>
      <div className="flex shrink-0 items-center gap-1">
        <Button
          variant="outline"
          size="sm"
          className="min-h-11 sm:min-h-9"
          onClick={() => onLogDay(episode.id)}
        >
          {t("illness.logDay")}
        </Button>
        <EpisodeMenu
          episode={episode}
          onEdit={() => onEdit(episode)}
          onResolve={
            active && !isChronic ? () => onResolve(episode.id) : undefined
          }
          resolving={resolving}
        />
        <ChevronRight
          className="text-muted-foreground hidden h-4 w-4 sm:block"
          aria-hidden
        />
      </div>
    </Card>
  );
}

export function IllnessView() {
  const { t } = useTranslations();
  const { data: episodes, isLoading } = useIllnessEpisodes(true);
  const resolve = useResolveEpisode();

  const today = todayLocal();
  const [newOpen, setNewOpen] = useState(false);
  const [editEpisode, setEditEpisode] = useState<IllnessEpisodeDTO | null>(null);
  const [logEpisodeId, setLogEpisodeId] = useState<string | null>(null);

  const logEpisode = episodes?.find((e) => e.id === logEpisodeId) ?? null;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight">
            {t("illness.title")}
          </h1>
          <p className="text-muted-foreground text-xs sm:text-sm">
            {t("illness.subtitle")}
          </p>
        </div>
        <Button
          onClick={() => setNewOpen(true)}
          className="min-h-11 shrink-0 sm:min-h-9"
        >
          <Plus className="h-4 w-4" />
          {t("illness.newEpisode")}
        </Button>
      </div>

      <p className="text-muted-foreground text-xs">{t("illness.disclaimer")}</p>

      {isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      ) : episodes && episodes.length > 0 ? (
        <>
          <div className="space-y-3">
            {episodes.map((episode) => (
              <EpisodeRow
                key={episode.id}
                episode={episode}
                resolving={resolve.isPending}
                onLogDay={(id) => setLogEpisodeId(id)}
                onEdit={(e) => setEditEpisode(e)}
                onResolve={(id) => resolve.mutate(id)}
              />
            ))}
          </div>
          <IllnessInsightsCard />
        </>
      ) : (
        <EmptyState
          icon={<Stethoscope className="size-6" />}
          title={t("illness.empty.title")}
          description={t("illness.empty.body")}
          ctaSize="lg"
          action={
            <Button onClick={() => setNewOpen(true)}>
              <Plus className="h-4 w-4" />
              {t("illness.newEpisode")}
            </Button>
          }
        />
      )}

      <NewEpisodeSheet open={newOpen} onOpenChange={setNewOpen} today={today} />
      <NewEpisodeSheet
        open={editEpisode !== null}
        onOpenChange={(open) => {
          if (!open) setEditEpisode(null);
        }}
        today={today}
        editEpisode={editEpisode ?? undefined}
      />
      {logEpisodeId ? (
        <LogDaySheet
          open={logEpisodeId !== null}
          onOpenChange={(open) => {
            if (!open) setLogEpisodeId(null);
          }}
          episodeId={logEpisodeId}
          date={today}
          onsetDate={logEpisode?.onsetAt.slice(0, 10)}
        />
      ) : null}
    </div>
  );
}
