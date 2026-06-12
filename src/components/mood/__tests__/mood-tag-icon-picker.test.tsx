/**
 * v1.17 — searchable icon picker over the shared curated catalog.
 * The filter is a pure function (name + English keyword aids,
 * case-insensitive, undrawable names excluded) so the search contract
 * is pinned without DOM events; the SSR render covers the radiogroup
 * grid, the selected-tile accent, and the localised search affordances.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import {
  MOOD_TAG_ICON_CATALOG,
  type MoodTagIconCatalogEntry,
} from "@/lib/mood/icon-catalog";
import { isMoodTagIconName } from "../mood-tag-icons";
import { MoodTagIconPicker, filterIconCatalog } from "../mood-tag-icon-picker";

describe("filterIconCatalog", () => {
  it("returns the full drawable catalog for an empty query", () => {
    const all = filterIconCatalog(MOOD_TAG_ICON_CATALOG, "");
    expect(all.length).toBeGreaterThan(40);
    expect(all.every((entry) => isMoodTagIconName(entry.name))).toBe(true);
  });

  it("matches on the icon name, case-insensitive", () => {
    const hits = filterIconCatalog(MOOD_TAG_ICON_CATALOG, "dumbbell");
    expect(hits.map((entry) => entry.name)).toContain("Dumbbell");
  });

  it("matches on keyword aids", () => {
    const byKeyword = filterIconCatalog(MOOD_TAG_ICON_CATALOG, "happy");
    expect(byKeyword.length).toBeGreaterThan(0);
    expect(
      byKeyword.some((entry) =>
        entry.keywords.some((k) => k.includes("happy")),
      ) ||
        byKeyword.some((entry) => entry.name.toLowerCase().includes("happy")),
    ).toBe(true);
  });

  it("returns nothing for a miss", () => {
    expect(filterIconCatalog(MOOD_TAG_ICON_CATALOG, "zzzznope")).toEqual([]);
  });

  it("excludes catalog names the client bundle cannot draw", () => {
    const withGhost: MoodTagIconCatalogEntry[] = [
      ...MOOD_TAG_ICON_CATALOG,
      { name: "NotARealIcon", keywords: ["ghost"], group: "misc" },
    ];
    const filtered = filterIconCatalog(withGhost, "");
    expect(filtered.some((entry) => entry.name === "NotARealIcon")).toBe(false);
  });

  it("every shipped catalog entry resolves to a real glyph (allowlist ⊆ client map)", () => {
    for (const entry of MOOD_TAG_ICON_CATALOG) {
      expect(
        isMoodTagIconName(entry.name),
        `unmapped icon: ${entry.name}`,
      ).toBe(true);
    }
  });
});

describe("<MoodTagIconPicker> — SSR", () => {
  function render(value: string | null, locale: "en" | "de" = "en"): string {
    return renderToStaticMarkup(
      <I18nProvider initialLocale={locale}>
        <MoodTagIconPicker value={value} onChange={() => {}} />
      </I18nProvider>,
    );
  }

  it("renders the search input + one radio tile per drawable catalog entry", () => {
    const html = render(null);
    expect(html).toContain('type="search"');
    const tiles = html.match(/data-slot="mood-icon-tile"/g);
    expect(tiles?.length ?? 0).toBe(
      filterIconCatalog(MOOD_TAG_ICON_CATALOG, "").length,
    );
  });

  it("marks the current value with the selected accent + aria-checked", () => {
    const html = render("Heart");
    expect(html).toMatch(
      /data-icon="Heart"[^>]*aria-checked="true"|aria-checked="true"[^>]*data-icon="Heart"/,
    );
  });

  it("resolves the German search placeholder", () => {
    const html = render(null, "de");
    expect(html).toContain("Symbole durchsuchen…");
  });

  it("renders localised group sub-headers", () => {
    const html = render(null, "de");
    expect(html).toContain("Gefühle");
    expect(html).toContain("Aktivitäten");
  });
});
