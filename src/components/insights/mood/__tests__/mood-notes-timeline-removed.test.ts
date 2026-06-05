import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const COMPONENT_DIR = join(__dirname, "..");
const MOOD_LIST = join(
  __dirname,
  "../../../mood/mood-list.tsx",
);

/**
 * v1.8.6 — the notes timeline display is removed from the mood insights
 * surface (note capture on the form stays). These structural guards keep
 * the surface from regressing back to a notes feed and keep long notes
 * truncated in the entries table.
 */
describe("mood notes timeline removal", () => {
  it("deletes the notes-timeline component file", () => {
    expect(existsSync(join(COMPONENT_DIR, "mood-notes-timeline.tsx"))).toBe(
      false,
    );
  });

  it("no longer renders the notes timeline from the insights sections", () => {
    const src = readFileSync(
      join(COMPONENT_DIR, "mood-insights-sections.tsx"),
      "utf8",
    );
    expect(src).not.toContain("MoodNotesTimeline");
    expect(src).not.toContain("notesTimeline");
    expect(src).not.toContain("notesTimelineTitle");
  });

  it("mounts the narrative feed in the insights sections", () => {
    const src = readFileSync(
      join(COMPONENT_DIR, "mood-insights-sections.tsx"),
      "utf8",
    );
    // v1.12.7 — the narrative one-liners now ride the merged "What stands out"
    // card (`MoodWhatStandsOut`), which renders `MoodNarrativeFeed` internally.
    // The structural guard tracks the mount point on the sections surface.
    expect(src).toContain("MoodWhatStandsOut");
    expect(src).toContain("MoodInTargetTile");
  });

  it("renders the narrative feed inside the merged what-stands-out card", () => {
    const src = readFileSync(
      join(COMPONENT_DIR, "mood-what-stands-out.tsx"),
      "utf8",
    );
    expect(src).toContain("MoodNarrativeFeed");
    expect(src).toContain("MoodDiscoveredRelations");
  });
});

describe("mood entries table — long-note truncation", () => {
  const src = readFileSync(MOOD_LIST, "utf8");

  it("caps the note column width to prevent horizontal scroll", () => {
    expect(src).toContain("max-w-[18rem]");
  });

  it("clamps the note and exposes the full text via a tooltip", () => {
    expect(src).toContain("line-clamp-2");
    expect(src).toContain("TooltipContent");
  });
});
