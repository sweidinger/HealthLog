"use client";

/**
 * The vault timeline: a virtualized, month-sectioned card grid windowed
 * with `@tanstack/react-virtual` over the shell's scroll container
 * (`#main-content` — single scroll owner per the design standards; the
 * timeline never brings its own scrollport). The flat item list (month
 * labels + chunked card rows) comes from `buildTimelineItems`, so the
 * mounted DOM stays bounded (< ~400 nodes) regardless of corpus size.
 *
 * Columns are measured, not breakpoint-classed: a ResizeObserver on the
 * grid container drives the per-row chunking (4 / 3 / 2 / 1), which keeps
 * the virtualizer's row model and the painted grid in lockstep.
 *
 * In-flight / failed uploads render as a small non-virtualized grid above
 * the timeline — they are few (client concurrency 3) and must appear
 * < 100 ms after file selection, before any query settles.
 */
import { Loader2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

import { useTranslations } from "@/lib/i18n/context";
import type { InboundDocumentDto } from "@/lib/validations/inbound-documents";
import { DocumentCard, UploadStateCard } from "./document-card";
import type { UploadQueueItem } from "./use-document-upload";
import { buildTimelineItems, formatMonthLabel } from "./vault-utils";

const SCROLL_CONTAINER_ID = "main-content";

/** Measured-width → column count (desktop 4/3, tablet 2, phone 1). */
function columnsForWidth(width: number): number {
  if (width >= 1200) return 4;
  if (width >= 900) return 3;
  if (width >= 600) return 2;
  return 1;
}

export function DocumentTimeline({
  documents,
  uploadItems,
  onDismissUpload,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
  selectedIds,
  onToggleSelected,
  onOpen,
  highlightId,
  onPrefetch,
}: {
  documents: InboundDocumentDto[];
  uploadItems: UploadQueueItem[];
  onDismissUpload: (localId: string) => void;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onLoadMore: () => void;
  selectedIds: ReadonlySet<string>;
  onToggleSelected: (id: string, range?: boolean) => void;
  onOpen: (id: string) => void;
  highlightId: string | null;
  onPrefetch?: (id: string) => void;
}) {
  const { t, locale } = useTranslations();
  const listRef = useRef<HTMLDivElement | null>(null);
  const [columns, setColumns] = useState(1);
  const [scrollMargin, setScrollMargin] = useState(0);

  // Measured columns — the ResizeObserver drives the row chunking.
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const update = () => setColumns(columnsForWidth(el.clientWidth));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const items = useMemo(
    () => buildTimelineItems(documents, columns),
    [documents, columns],
  );

  // The timeline does not start at the scrollport's top edge (page header,
  // filter bar, upload row sit above it) — feed the offset to the
  // virtualizer so window positions line up. Re-measured when the content
  // above changes height (upload cards appearing/leaving) and on resize.
  useEffect(() => {
    const scrollEl = document.getElementById(SCROLL_CONTAINER_ID);
    const listEl = listRef.current;
    if (!scrollEl || !listEl) return;
    const measure = () => {
      const margin =
        listEl.getBoundingClientRect().top -
        scrollEl.getBoundingClientRect().top +
        scrollEl.scrollTop;
      setScrollMargin(margin);
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [uploadItems.length, columns]);

  // The React Compiler cannot memoize across TanStack Virtual's instance
  // API (library-level opt-out, not a fixable call-site problem) — the
  // windowing still works, the compiler just skips this component.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => document.getElementById(SCROLL_CONTAINER_ID),
    estimateSize: (index) => (items[index].type === "month" ? 40 : 140),
    getItemKey: (index) => items[index].key,
    overscan: 6,
    scrollMargin,
  });

  const virtualItems = virtualizer.getVirtualItems();

  // Keyset infinite feed: pull the next page when the window nears the end.
  const lastIndex = virtualItems[virtualItems.length - 1]?.index ?? -1;
  useEffect(() => {
    if (
      hasNextPage &&
      !isFetchingNextPage &&
      lastIndex >= items.length - columns * 3 - 1
    ) {
      onLoadMore();
    }
  }, [
    lastIndex,
    items.length,
    columns,
    hasNextPage,
    isFetchingNextPage,
    onLoadMore,
  ]);

  return (
    <div data-slot="document-timeline" className="space-y-4">
      {uploadItems.length > 0 ? (
        <div
          data-slot="document-upload-queue"
          aria-live="polite"
          className="grid gap-4"
          style={{
            gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
          }}
        >
          {uploadItems.map((item) => (
            <UploadStateCard
              key={item.localId}
              item={item}
              onDismiss={onDismissUpload}
            />
          ))}
        </div>
      ) : null}

      <div ref={listRef}>
        <div
          className="relative"
          style={{ height: virtualizer.getTotalSize() }}
        >
          {virtualItems.map((virtualItem) => {
            const item = items[virtualItem.index];
            return (
              <div
                key={virtualItem.key}
                ref={virtualizer.measureElement}
                data-index={virtualItem.index}
                className="absolute inset-x-0 top-0"
                style={{
                  transform: `translateY(${
                    virtualItem.start - scrollMargin
                  }px)`,
                }}
              >
                {item.type === "month" ? (
                  <h2 className="text-muted-foreground pt-2 pb-3 text-xs font-medium tracking-wide uppercase">
                    {formatMonthLabel(item.key, locale)}
                  </h2>
                ) : (
                  <div
                    className="grid gap-4 pb-4"
                    style={{
                      gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
                    }}
                  >
                    {item.documents.map((doc) => (
                      <DocumentCard
                        key={doc.id}
                        document={doc}
                        selected={selectedIds.has(doc.id)}
                        onToggleSelected={onToggleSelected}
                        onOpen={onOpen}
                        highlighted={highlightId === doc.id}
                        onPrefetch={onPrefetch}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {isFetchingNextPage ? (
        <div
          className="text-muted-foreground flex items-center justify-center gap-2 py-4 text-sm"
          role="status"
        >
          <Loader2
            className="size-4 animate-spin motion-reduce:animate-none"
            aria-hidden
          />
          {t("documents.timeline.loadingMore")}
        </div>
      ) : null}
    </div>
  );
}
