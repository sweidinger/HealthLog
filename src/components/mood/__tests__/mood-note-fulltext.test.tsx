import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * v1.16.8 — full-text mood notes on the management list. The note used to be
 * readable in full only through the edit sheet (desktop hover tooltip aside,
 * unreachable on touch). Each row now carries a toggle that expands the
 * clamped two-line preview into the complete text, line breaks preserved,
 * rendered as plain React text children (no markup interpretation).
 *
 * Project convention: SSR-only component tests (`renderToStaticMarkup`) plus
 * source-string structural assertions for the interactive branch.
 */

const LONG_NOTE =
  "Erster Absatz der Notiz mit etwas längerem Text, der über die Vorschau hinausgeht.\n" +
  "Zweiter Absatz mit weiteren Details, die nur in der Vollansicht lesbar sind.";

const baseEntries = [
  {
    id: "e-1",
    date: "2026-05-09",
    mood: "GUT",
    score: 4,
    tags: ["work"],
    tagKeys: [],
    note: LONG_NOTE,
    source: "MANUAL",
    moodLoggedAt: "2026-05-09T20:00:00.000Z",
  },
  {
    id: "e-2",
    date: "2026-05-08",
    mood: "OKAY",
    score: 3,
    tags: [],
    tagKeys: [],
    note: null,
    source: "MANUAL",
    moodLoggedAt: "2026-05-08T20:00:00.000Z",
  },
];

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/mood",
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: { entries: baseEntries, meta: { total: 2 } },
    isLoading: false,
  }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useMutation: () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
    isError: false,
    error: null,
  }),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { id: "u1", username: "testuser", role: "USER" },
    isAuthenticated: true,
    isLoading: false,
  }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { MoodList } from "../mood-list";

function render(locale: "en" | "de" = "de") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>
      <MoodList />
    </I18nProvider>,
  );
}

describe("MoodList — full-text note affordance", () => {
  it("renders the note as a collapsed toggle with the COMPLETE text in the DOM", () => {
    const html = render("de");
    // One toggle per surface (desktop table + mobile card) for the noted row;
    // the note-less row renders none.
    const toggles = html.match(/data-testid="mood-note-toggle"/g);
    expect(toggles?.length).toBe(2);
    // Collapsed by default: clamped preview + expand affordance label.
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("line-clamp-2");
    expect(html).toContain("Notiz vollständig anzeigen");
    // The complete text is in the row (the clamp is visual), both paragraphs.
    expect(html).toContain("Erster Absatz der Notiz");
    expect(html).toContain("Zweiter Absatz mit weiteren Details");
  });

  it("localises the affordance label", () => {
    const html = render("en");
    expect(html).toContain("Show full note");
  });

  it("expanded branch preserves line breaks and renders plain text children", () => {
    const src = readFileSync(
      join(process.cwd(), "src/components/mood/mood-list.tsx"),
      "utf8",
    );
    // The expanded branch must keep the author's line breaks…
    expect(src).toContain("whitespace-pre-wrap");
    // …flip the collapse label…
    expect(src).toContain('t("mood.noteCollapse")');
    expect(src).toContain('t("mood.noteExpand")');
    // …and never interpret the note as markup.
    expect(src).not.toContain("dangerouslySetInnerHTML");
  });
});
