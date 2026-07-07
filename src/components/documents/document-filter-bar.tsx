"use client";

/**
 * The vault's sticky filter rail: debounced title/filename search, the
 * nine-kind type-chip row (multi-select, OR inside the facet), condition
 * chips (episodes that actually carry links), a year segmenter (years
 * present in the corpus), and a one-tap clear with the active-facet count.
 *
 * Purely presentational — the filter state lives in the page URL and is
 * owned by `documents-view.tsx`; this bar only renders the controls. It
 * sticks below the top edge inside the shell's scroll container (sticky,
 * translucent background, border-b — no viewport-height tricks).
 */
import { Search, X } from "lucide-react";
import type { RefObject } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";
import type { InboundDocumentKindValue } from "@/lib/validations/inbound-documents";
import { DOCUMENT_KIND_ICONS, DOCUMENT_KIND_ORDER } from "./document-kind-meta";

/** Shared chip chrome — mirrors the app-wide FilterBar pill vocabulary. */
const CHIP_CLASSES =
  "border-border bg-card text-foreground inline-flex min-h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-full border px-3 text-sm whitespace-nowrap shadow-xs transition-colors focus-visible:ring-ring/50 focus-visible:ring-[3px] focus-visible:outline-none";
const CHIP_ACTIVE_CLASSES = "border-primary/40 bg-primary/10";

export interface ConditionChip {
  episodeId: string;
  name: string;
}

export function DocumentFilterBar({
  searchValue,
  onSearchChange,
  searchInputRef,
  activeKinds,
  onToggleKind,
  conditionChips,
  activeEpisodeId,
  onToggleEpisode,
  years,
  activeYear,
  onToggleYear,
  activeCount,
  onClearAll,
}: {
  searchValue: string;
  onSearchChange: (value: string) => void;
  /** Focused by the page-level `/` shortcut. */
  searchInputRef: RefObject<HTMLInputElement | null>;
  activeKinds: ReadonlySet<InboundDocumentKindValue>;
  onToggleKind: (kind: InboundDocumentKindValue) => void;
  conditionChips: ConditionChip[];
  activeEpisodeId: string | undefined;
  onToggleEpisode: (episodeId: string) => void;
  years: number[];
  activeYear: number | undefined;
  onToggleYear: (year: number) => void;
  activeCount: number;
  onClearAll: () => void;
}) {
  const { t } = useTranslations();

  return (
    <div
      data-slot="document-filter-bar"
      className="bg-background/95 border-border sticky top-0 z-10 -mx-4 border-b px-4 pt-1 pb-3 backdrop-blur md:-mx-6 md:px-6"
    >
      <div className="flex items-center gap-3">
        <div className="relative w-full max-w-md">
          <Search
            className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
            aria-hidden
          />
          <Input
            ref={searchInputRef}
            type="search"
            value={searchValue}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder={t("documents.filter.searchPlaceholder")}
            aria-label={t("documents.filter.searchLabel")}
            className="pr-8 pl-9"
            aria-keyshortcuts="/"
          />
          <kbd
            aria-hidden
            className="border-border text-muted-foreground pointer-events-none absolute top-1/2 right-2.5 hidden -translate-y-1/2 rounded border px-1.5 font-mono text-xs sm:inline-block"
          >
            /
          </kbd>
        </div>
        {activeCount > 0 ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={onClearAll}
            className="text-muted-foreground shrink-0"
          >
            <X className="size-3.5" aria-hidden />
            {t("documents.filter.clear")}
            {activeCount > 1 ? (
              <span className="tabular-nums">({activeCount})</span>
            ) : null}
          </Button>
        ) : null}
      </div>

      <div
        className="-mx-4 mt-3 flex [scrollbar-width:none] items-center gap-2 overflow-x-auto px-4 md:mx-0 md:flex-wrap md:overflow-visible md:px-0 [&::-webkit-scrollbar]:hidden"
        role="group"
        aria-label={t("documents.filter.groupLabel")}
      >
        <span
          role="group"
          aria-label={t("documents.filter.typeGroup")}
          className="contents"
        >
          {DOCUMENT_KIND_ORDER.map((kind) => {
            const Icon = DOCUMENT_KIND_ICONS[kind];
            const active = activeKinds.has(kind);
            return (
              <button
                key={kind}
                type="button"
                aria-pressed={active}
                onClick={() => onToggleKind(kind)}
                className={cn(CHIP_CLASSES, active && CHIP_ACTIVE_CLASSES)}
              >
                <Icon className="size-3.5 shrink-0" aria-hidden />
                {t(`documents.kind.${kind}`)}
              </button>
            );
          })}
        </span>

        {conditionChips.length > 0 ? (
          <>
            <span
              aria-hidden
              className="bg-border mx-1 h-5 w-px shrink-0 self-center"
            />
            <span
              role="group"
              aria-label={t("documents.filter.conditionGroup")}
              className="contents"
            >
              {conditionChips.map((chip) => {
                const active = chip.episodeId === activeEpisodeId;
                return (
                  <button
                    key={chip.episodeId}
                    type="button"
                    aria-pressed={active}
                    onClick={() => onToggleEpisode(chip.episodeId)}
                    className={cn(CHIP_CLASSES, active && CHIP_ACTIVE_CLASSES)}
                  >
                    <span className="max-w-40 truncate">{chip.name}</span>
                  </button>
                );
              })}
            </span>
          </>
        ) : null}

        {years.length > 0 ? (
          <>
            <span
              aria-hidden
              className="bg-border mx-1 h-5 w-px shrink-0 self-center"
            />
            <span
              role="group"
              aria-label={t("documents.filter.yearGroup")}
              className="contents"
            >
              {years.map((year) => {
                const active = year === activeYear;
                return (
                  <button
                    key={year}
                    type="button"
                    aria-pressed={active}
                    onClick={() => onToggleYear(year)}
                    className={cn(
                      CHIP_CLASSES,
                      "tabular-nums",
                      active && CHIP_ACTIVE_CLASSES,
                    )}
                  >
                    {year}
                  </button>
                );
              })}
            </span>
          </>
        ) : null}
      </div>
    </div>
  );
}
