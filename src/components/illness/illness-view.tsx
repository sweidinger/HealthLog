"use client";

/**
 * v1.18.1 — the illness / condition-journal surface.
 *
 * A calm, retrospective journal: the episode history (newest first) with a
 * neutral status Badge (active / recovered — never an alarming colour, the
 * med-card rule generalised), a "log a day" entry into the day-log sheet,
 * and a "mark recovered" one-tap. Retrospective-only copy: this is a
 * journal, not a medical device, and it does not diagnose. No prediction
 * UI by design.
 */
import { useState } from "react";
import { Plus, Stethoscope } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useTranslations } from "@/lib/i18n/context";
import { useFormatters } from "@/lib/i18n/context";

import { LogDaySheet } from "./log-day-sheet";
import { NewEpisodeSheet } from "./new-episode-sheet";
import {
  useDeleteEpisode,
  useIllnessEpisodes,
  useResolveEpisode,
} from "./use-illness";
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
  onResolve,
  onDelete,
  resolving,
}: {
  episode: IllnessEpisodeDTO;
  onLogDay: (id: string) => void;
  onResolve: (id: string) => void;
  onDelete: (id: string) => void;
  resolving: boolean;
}) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const active = episode.resolvedAt === null;
  const isChronic = episode.lifecycle === "CHRONIC_ONGOING";

  return (
    <Card className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
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
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={() => onLogDay(episode.id)}>
          {t("illness.logDay")}
        </Button>
        {active && !isChronic ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={resolving}
            onClick={() => onResolve(episode.id)}
          >
            {t("illness.markRecovered")}
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground"
          onClick={() => onDelete(episode.id)}
        >
          {t("common.delete")}
        </Button>
      </div>
    </Card>
  );
}

export function IllnessView() {
  const { t } = useTranslations();
  const { data: episodes, isLoading } = useIllnessEpisodes(true);
  const resolve = useResolveEpisode();
  const del = useDeleteEpisode();

  const today = todayLocal();
  const [newOpen, setNewOpen] = useState(false);
  const [logEpisodeId, setLogEpisodeId] = useState<string | null>(null);

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
        <p className="text-muted-foreground text-sm">{t("common.loading")}</p>
      ) : episodes && episodes.length > 0 ? (
        <div className="space-y-3">
          {episodes.map((episode) => (
            <EpisodeRow
              key={episode.id}
              episode={episode}
              resolving={resolve.isPending}
              onLogDay={(id) => setLogEpisodeId(id)}
              onResolve={(id) => resolve.mutate(id)}
              onDelete={(id) => del.mutate(id)}
            />
          ))}
        </div>
      ) : (
        <Card className="flex flex-col items-center gap-3 p-10 text-center">
          <Stethoscope className="text-muted-foreground h-8 w-8" />
          <div>
            <p className="font-medium">{t("illness.empty.title")}</p>
            <p className="text-muted-foreground text-sm">
              {t("illness.empty.body")}
            </p>
          </div>
          <Button variant="outline" onClick={() => setNewOpen(true)}>
            <Plus className="h-4 w-4" />
            {t("illness.newEpisode")}
          </Button>
        </Card>
      )}

      <NewEpisodeSheet open={newOpen} onOpenChange={setNewOpen} today={today} />
      {logEpisodeId ? (
        <LogDaySheet
          open={logEpisodeId !== null}
          onOpenChange={(open) => {
            if (!open) setLogEpisodeId(null);
          }}
          episodeId={logEpisodeId}
          date={today}
        />
      ) : null}
    </div>
  );
}
