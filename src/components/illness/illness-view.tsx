"use client";

/**
 * v1.18.2 — the illness / condition-journal surface.
 *
 * A calm, retrospective journal. The episode history reads as a grid of
 * medication-styled cards: a header (label link + neutral type / status
 * badges + an overflow kebab) and a single bottom-pinned "Log a day"
 * primary action — one clear action per card, the most-common one promoted.
 * The list is split into "Active" and "Resolved" groups (active first), and
 * flares nest under their parent condition so the parent relationship the
 * form captures is visible. The cross-episode retrospective summary sits
 * directly under the header so a long list never buries it. Each card
 * navigates to the episode-detail surface (`/illness/[id]`) where the
 * per-day timeline and correlation card live. Retrospective-only copy — a
 * journal, not a medical device, and it does not diagnose.
 */
import { useMemo, useState } from "react";
import Link from "next/link";
import { Plus, Stethoscope } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
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

interface EpisodeCardProps {
  episode: IllnessEpisodeDTO;
  /** Flares that hang off this episode (rendered nested), already filtered. */
  flares?: IllnessEpisodeDTO[];
  onLogDay: (id: string) => void;
  onEdit: (episode: IllnessEpisodeDTO) => void;
  onResolve: (id: string) => void;
  resolving: boolean;
}

function EpisodeCard({
  episode,
  flares,
  onLogDay,
  onEdit,
  onResolve,
  resolving,
}: EpisodeCardProps) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const active = episode.resolvedAt === null;
  const isChronic = episode.lifecycle === "CHRONIC_ONGOING";
  const flareCount = flares?.length ?? 0;

  return (
    <Card className="h-full gap-3 md:gap-3">
      <CardHeader className="pb-0">
        <CardTitle className="min-w-0">
          <Link
            href={`/illness/${episode.id}`}
            className="hover:underline focus-visible:underline"
          >
            <span className="block truncate">{episode.label}</span>
          </Link>
        </CardTitle>
        <CardAction>
          <EpisodeMenu
            episode={episode}
            onEdit={() => onEdit(episode)}
            onResolve={
              active && !isChronic ? () => onResolve(episode.id) : undefined
            }
            resolving={resolving}
          />
        </CardAction>
      </CardHeader>

      <CardContent className="flex h-full flex-col space-y-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="secondary">{t(`illness.type.${episode.type}`)}</Badge>
          <Badge variant="outline">
            {active
              ? isChronic
                ? t("illness.status.ongoing")
                : t("illness.status.active")
              : t("illness.status.recovered")}
          </Badge>
        </div>

        <p className="text-muted-foreground text-xs">
          {t("illness.onsetOn", {
            date: fmt.dateShort(new Date(episode.onsetAt)),
          })}
          {episode.resolvedAt
            ? ` · ${t("illness.recoveredOn", {
                date: fmt.dateShort(new Date(episode.resolvedAt)),
              })}`
            : ""}
        </p>

        {flareCount > 0 ? (
          <div className="space-y-1 border-l-2 pl-3">
            <p className="text-muted-foreground text-xs font-medium">
              {flareCount === 1
                ? t("illness.flares.countOne")
                : t("illness.flares.countOther", { count: flareCount })}
            </p>
            <ul className="space-y-1">
              {flares!.map((flare) => (
                <li key={flare.id}>
                  <Link
                    href={`/illness/${flare.id}`}
                    className="text-foreground/80 hover:text-foreground flex items-center gap-2 text-xs hover:underline"
                  >
                    <span className="truncate">{flare.label}</span>
                    <span className="text-muted-foreground shrink-0">
                      {fmt.dateShort(new Date(flare.onsetAt))}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {/* Bottom-pinned single primary action — the daily-use "log a day"
            flow, promoted from a busy inline cluster. The card navigates to
            the detail surface on its title link; this is the one explicit
            button. */}
        <div className="mt-auto pt-0">
          <Button
            className="min-h-11 w-full sm:min-h-9"
            onClick={() => onLogDay(episode.id)}
          >
            {t("illness.logDay")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function EpisodeGroup({
  title,
  parents,
  childrenByParent,
  onLogDay,
  onEdit,
  onResolve,
  resolving,
}: {
  title: string;
  parents: IllnessEpisodeDTO[];
  childrenByParent: Map<string, IllnessEpisodeDTO[]>;
  onLogDay: (id: string) => void;
  onEdit: (episode: IllnessEpisodeDTO) => void;
  onResolve: (id: string) => void;
  resolving: boolean;
}) {
  if (parents.length === 0) return null;
  return (
    <section className="space-y-3">
      <h2 className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
        {title}
      </h2>
      <div className="grid gap-4 sm:grid-cols-2">
        {parents.map((episode) => (
          <EpisodeCard
            key={episode.id}
            episode={episode}
            flares={childrenByParent.get(episode.id)}
            resolving={resolving}
            onLogDay={onLogDay}
            onEdit={onEdit}
            onResolve={onResolve}
          />
        ))}
      </div>
    </section>
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

  /**
   * Group the flat list into active / resolved, nesting flares under their
   * parent condition. A flare nests only when its parent lives in the same
   * status group (so an active flare under a resolved parent still surfaces as
   * its own active card rather than vanishing); otherwise it renders as a
   * standalone parent card in its own group.
   */
  const grouped = useMemo(() => {
    const list = episodes ?? [];
    const byId = new Map(list.map((e) => [e.id, e]));
    const isActive = (e: IllnessEpisodeDTO) => e.resolvedAt === null;

    const activeParents: IllnessEpisodeDTO[] = [];
    const resolvedParents: IllnessEpisodeDTO[] = [];
    const childrenByParent = new Map<string, IllnessEpisodeDTO[]>();

    for (const e of list) {
      const parent = e.parentConditionId
        ? byId.get(e.parentConditionId)
        : undefined;
      const nestsUnderParent =
        parent !== undefined && isActive(parent) === isActive(e);

      if (nestsUnderParent) {
        const bucket = childrenByParent.get(parent.id) ?? [];
        bucket.push(e);
        childrenByParent.set(parent.id, bucket);
      } else if (isActive(e)) {
        activeParents.push(e);
      } else {
        resolvedParents.push(e);
      }
    }

    return { activeParents, resolvedParents, childrenByParent };
  }, [episodes]);

  const hasEpisodes = (episodes?.length ?? 0) > 0;

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
        <div className={cn("grid gap-4 sm:grid-cols-2")}>
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      ) : hasEpisodes ? (
        <>
          {/* Retrospective summary sits above the list so a long history
              never buries it. */}
          <IllnessInsightsCard />

          <EpisodeGroup
            title={t("illness.section.active")}
            parents={grouped.activeParents}
            childrenByParent={grouped.childrenByParent}
            resolving={resolve.isPending}
            onLogDay={(id) => setLogEpisodeId(id)}
            onEdit={(e) => setEditEpisode(e)}
            onResolve={(id) => resolve.mutate(id)}
          />
          <EpisodeGroup
            title={t("illness.section.resolved")}
            parents={grouped.resolvedParents}
            childrenByParent={grouped.childrenByParent}
            resolving={resolve.isPending}
            onLogDay={(id) => setLogEpisodeId(id)}
            onEdit={(e) => setEditEpisode(e)}
            onResolve={(id) => resolve.mutate(id)}
          />
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
