import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Dashboard hero — page + header wiring pins.
 *
 * The hero band mounts between the page header and the tile strip:
 *
 *   - it gates on the layout's `heroVisible` flag (only the literal
 *     `true` renders — the hero is opt-in) AND on snapshot mode (the
 *     verdict needs the snapshot payload);
 *   - while `primaryLoading` is true (same `!mounted ||` pin the tile
 *     silhouettes use) a footprint-identical skeleton holds the band,
 *     so the hero and the tiles swap to content in the SAME render
 *     pass;
 *   - the greeting paragraph lives in the hero when that renders; when
 *     the hero does NOT render (snapshot flag off, or hidden via the
 *     layout toggle) the header takes it back behind `showGreeting`,
 *     fed from the page's hero gate — the greeting never disappears.
 */
const PAGE_PATH = join(process.cwd(), "src/app/page.tsx");
const HEADER_PATH = join(
  process.cwd(),
  "src/components/dashboard/dashboard-header.tsx",
);

describe("dashboard hero — page wiring", () => {
  const src = readFileSync(PAGE_PATH, "utf8");

  it("gates the hero on snapshot mode + the layout's heroVisible flag", () => {
    expect(src).toMatch(
      /const\s+heroVisible\s*=\s*snapshotEnabled\s*&&\s*layout\.heroVisible\s*===\s*true;/,
    );
  });

  it("holds the skeleton while primaryLoading and swaps the hero in the same pass", () => {
    const block = src.match(
      /\{heroVisible\s*&&[\s\S]*?<DashboardHero[\s\S]*?\)\}/,
    );
    expect(block).not.toBeNull();
    expect(block![0]).toMatch(
      /primaryLoading\s*\|\|\s*!heroSnapshot\s*\?\s*\(\s*<DashboardHeroSkeleton\s*\/>/,
    );
    expect(block![0]).toContain("onQuickEntry={setQuickEntryDialog}");
  });

  it("derives primaryLoading once in the component body (shared with the tile gate)", () => {
    const matches = src.match(/const\s+primaryLoading\s*=\s*!mounted/g) ?? [];
    expect(matches).toHaveLength(1);
  });

  it("the hero sits between the header and the strip", () => {
    const headerIdx = src.indexOf("<DashboardHeader");
    const heroIdx = src.indexOf("{heroVisible &&");
    const stripIdx = src.indexOf("dashboard-tile-strip");
    expect(headerIdx).toBeGreaterThan(-1);
    expect(heroIdx).toBeGreaterThan(headerIdx);
    expect(stripIdx).toBeGreaterThan(heroIdx);
  });

  it("the page no longer derives the welcome text (it moved into the hero)", () => {
    expect(src).not.toContain("welcomeText");
    expect(src).not.toContain("welcomeBackWithName");
    expect(src).not.toContain("getHourForTimeZone");
  });
});

describe("dashboard hero — header handoff", () => {
  const header = readFileSync(HEADER_PATH, "utf8");

  it("the header keeps the greeting behind showGreeting (hero-hidden fallback)", () => {
    // The greeting renders here ONLY when the hero band does not — the
    // prop gates the paragraph, and the `min-h-5` line-box reservation
    // keeps the header stable through the post-hydration name swap.
    expect(header).toContain("showGreeting");
    expect(header).toMatch(/\{showGreeting\s*\?/);
    expect(header).toContain("min-h-5");
    expect(header).toContain('data-slot="dashboard-header-greeting"');
  });

  it("the page feeds showGreeting from the inverted hero gate", () => {
    const src = readFileSync(PAGE_PATH, "utf8");
    expect(src).toMatch(/showGreeting=\{!heroVisible\}/);
  });

  it("the header keeps the title + customize + add actions", () => {
    expect(header).toContain('t("dashboard.title")');
    expect(header).toContain("dashboard-customize-shortcut");
    expect(header).toContain("dashboard-quick-add");
  });
});
