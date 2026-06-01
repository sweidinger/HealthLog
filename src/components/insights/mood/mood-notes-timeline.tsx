"use client";

import { formatDateTime } from "@/lib/format";
import { useTranslations } from "@/lib/i18n/context";
import { MOOD_LABEL_KEYS } from "@/lib/mood/labels";

/**
 * v1.8.5 (C1) — notes timeline.
 *
 * Chronological feed of recent mood entries that carry a free-text note,
 * each with its score, mood label, note text, and tag chips. Renders the
 * note as a plain React text child (no markdown library — the project
 * forbids one for XSS reasons).
 */

export interface MoodNoteEntry {
  date: string;
  loggedAt: string;
  score: number;
  mood: string | null;
  note: string;
  tags: string[];
  structuredTagLabelKeys: string[];
}

export function MoodNotesTimeline({ notes }: { notes: MoodNoteEntry[] }) {
  const { t } = useTranslations();

  return (
    <ul className="space-y-3" data-slot="mood-notes-timeline">
      {notes.map((entry) => {
        const moodLabel =
          entry.mood && MOOD_LABEL_KEYS[entry.mood]
            ? t(MOOD_LABEL_KEYS[entry.mood])
            : entry.mood;
        return (
          <li
            key={`${entry.loggedAt}-${entry.date}`}
            className="border-border/60 border-l-2 pl-3"
          >
            <div className="text-muted-foreground flex items-center gap-2 text-xs">
              <span className="text-foreground font-semibold tabular-nums">
                {entry.score}
              </span>
              {moodLabel && <span>({moodLabel})</span>}
              <span>·</span>
              <span>{formatDateTime(entry.loggedAt)}</span>
            </div>
            <p className="text-foreground/90 mt-0.5 text-sm whitespace-pre-wrap">
              {entry.note}
            </p>
            {(entry.structuredTagLabelKeys.length > 0 ||
              entry.tags.length > 0) && (
              <div className="mt-1 flex flex-wrap gap-1">
                {entry.structuredTagLabelKeys.map((labelKey) => (
                  <span
                    key={labelKey}
                    className="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-[10px]"
                  >
                    {t(labelKey)}
                  </span>
                ))}
                {entry.tags.map((tag) => (
                  <span
                    key={tag}
                    className="border-border/70 text-muted-foreground rounded-full border px-2 py-0.5 text-[10px]"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
