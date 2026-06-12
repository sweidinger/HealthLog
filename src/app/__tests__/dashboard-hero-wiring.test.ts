import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Dashboard hero — page + header wiring pins.
 *
 * The hero band mounts between the page header and the tile strip:
 *
 *   - it gates on the layout's `heroVisible` flag (anything but the
 *     literal `false` renders — the resolver's clamp) AND on snapshot
 *     mode (the verdict needs the snapshot payload);
 *   - while `primaryLoading` is true (same `!mounted ||` pin the tile
 *     silhouettes use) a footprint-identical skeleton holds the band,
 *     so the hero and the tiles swap to content in the SAME render
 *     pass;
 *   - the greeting paragraph left the header for the hero. The header
 *     renders no name-bearing text at all any more, so the SSR pass
 *     stays name-free by construction (the hero itself only mounts
 *     once the snapshot resolved — post-hydration).
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
      /const\s+heroVisible\s*=\s*snapshotEnabled\s*&&\s*layout\.heroVisible\s*!==\s*false;/,
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

  it("the header dropped the greeting paragraph and its reservation", () => {
    expect(header).not.toContain("welcomeText");
    expect(header).not.toContain("min-h-5");
  });

  it("the header keeps the title + customize + add actions", () => {
    expect(header).toContain('t("dashboard.title")');
    expect(header).toContain("dashboard-customize-shortcut");
    expect(header).toContain("dashboard-quick-add");
  });
});
