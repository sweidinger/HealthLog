/**
 * v1.17.0 — layout-blob schema bounds, preserve-when-absent merge, group
 * stripping, and the read-time placement resolution (unknown-key drops,
 * duplicate claims, home-category fallback ordering).
 */
import { describe, expect, it } from "vitest";

import {
  moodTagLayoutSchema,
  parseStoredMoodTagLayout,
  mergeMoodTagLayout,
  stripGroupFromLayout,
  resolveGroupOrder,
  resolveMoodTagPlacement,
  MOOD_TAG_LAYOUT_MAX_GROUPS,
  MOOD_TAG_LAYOUT_MAX_PLACEMENTS,
} from "@/lib/mood/tag-layout";

describe("moodTagLayoutSchema bounds", () => {
  it("accepts the empty blob and partial blobs", () => {
    expect(moodTagLayoutSchema.safeParse({}).success).toBe(true);
    expect(
      moodTagLayoutSchema.safeParse({ groupOrder: ["feelings"] }).success,
    ).toBe(true);
    expect(
      moodTagLayoutSchema.safeParse({ placements: { feelings: ["happy"] } })
        .success,
    ).toBe(true);
  });

  it("bounds groupOrder length, placement totals, and key length", () => {
    expect(
      moodTagLayoutSchema.safeParse({
        groupOrder: Array.from(
          { length: MOOD_TAG_LAYOUT_MAX_GROUPS + 1 },
          (_, i) => `g${i}`,
        ),
      }).success,
    ).toBe(false);
    expect(
      moodTagLayoutSchema.safeParse({
        placements: { g1: Array.from({ length: MOOD_TAG_LAYOUT_MAX_PLACEMENTS + 1 }, (_, i) => `t${i}`) },
      }).success,
    ).toBe(false);
    expect(
      moodTagLayoutSchema.safeParse({ groupOrder: ["k".repeat(81)] }).success,
    ).toBe(false);
    expect(
      moodTagLayoutSchema.safeParse({ placements: { g: [""] } }).success,
    ).toBe(false);
  });
});

describe("parseStoredMoodTagLayout", () => {
  it("degrades a malformed / legacy blob to the empty layout", () => {
    expect(parseStoredMoodTagLayout(null)).toEqual({});
    expect(parseStoredMoodTagLayout(undefined)).toEqual({});
    expect(parseStoredMoodTagLayout("garbage")).toEqual({});
    expect(parseStoredMoodTagLayout({ groupOrder: "not-an-array" })).toEqual({});
    expect(parseStoredMoodTagLayout({ groupOrder: ["a"] })).toEqual({
      groupOrder: ["a"],
    });
  });
});

describe("mergeMoodTagLayout — preserve-when-absent", () => {
  const stored = { groupOrder: ["a"], placements: { a: ["t1"] } };

  it("keeps stored placements on a groupOrder-only PUT and vice versa", () => {
    expect(mergeMoodTagLayout(stored, { groupOrder: ["b"] })).toEqual({
      groupOrder: ["b"],
      placements: { a: ["t1"] },
    });
    expect(mergeMoodTagLayout(stored, { placements: {} })).toEqual({
      groupOrder: ["a"],
      placements: {},
    });
    expect(mergeMoodTagLayout({}, { groupOrder: ["x"] })).toEqual({
      groupOrder: ["x"],
    });
  });
});

describe("stripGroupFromLayout", () => {
  it("drops the group from order + its placement bucket, keeps the rest", () => {
    const layout = {
      groupOrder: ["a", "customcat:x", "b"],
      placements: { "customcat:x": ["t1"], b: ["t2"] },
    };
    expect(stripGroupFromLayout(layout, "customcat:x")).toEqual({
      groupOrder: ["a", "b"],
      placements: { b: ["t2"] },
    });
    // Absent fields stay absent (a strip never materialises a blob).
    expect(stripGroupFromLayout({}, "customcat:x")).toEqual({});
  });
});

describe("resolveGroupOrder", () => {
  it("layout order first (unknown dropped, dupes collapsed), missing appended in seeded order", () => {
    expect(
      resolveGroupOrder(
        ["feelings", "sleep", "custom"],
        ["custom", "ghost", "custom", "feelings"],
      ),
    ).toEqual(["custom", "feelings", "sleep"]);
    expect(resolveGroupOrder(["a", "b"], undefined)).toEqual(["a", "b"]);
  });
});

describe("resolveMoodTagPlacement", () => {
  const categoryKeys = ["feelings", "custom", "customcat:g1"];
  const tags = [
    { key: "happy", homeCategoryKey: "feelings" },
    { key: "sad", homeCategoryKey: "feelings" },
    { key: "custom:a", homeCategoryKey: "custom" },
    { key: "custom:b", homeCategoryKey: "custom" },
  ];

  it("renders placed tags at their slot and un-placed ones after, in sortOrder", () => {
    const { orderedCategoryKeys, tagKeysByCategory } = resolveMoodTagPlacement({
      categoryKeysInSeededOrder: categoryKeys,
      tags,
      layout: {
        groupOrder: ["customcat:g1", "feelings"],
        placements: { "customcat:g1": ["sad", "custom:b"] },
      },
    });
    expect(orderedCategoryKeys).toEqual(["customcat:g1", "feelings", "custom"]);
    expect(tagKeysByCategory.get("customcat:g1")).toEqual(["sad", "custom:b"]);
    expect(tagKeysByCategory.get("feelings")).toEqual(["happy"]);
    expect(tagKeysByCategory.get("custom")).toEqual(["custom:a"]);
  });

  it("drops placements referencing unknown tags or deleted groups", () => {
    const { tagKeysByCategory } = resolveMoodTagPlacement({
      categoryKeysInSeededOrder: categoryKeys,
      tags,
      layout: {
        placements: {
          "customcat:g1": ["ghost-tag", "happy"],
          "customcat:deleted": ["sad"],
        },
      },
    });
    expect(tagKeysByCategory.get("customcat:g1")).toEqual(["happy"]);
    // `sad` was placed into an unknown group → falls back to its home.
    expect(tagKeysByCategory.get("feelings")).toEqual(["sad"]);
  });

  it("resolves a duplicate claim to the first group in display order", () => {
    const { tagKeysByCategory } = resolveMoodTagPlacement({
      categoryKeysInSeededOrder: categoryKeys,
      tags,
      layout: {
        placements: {
          feelings: ["custom:a"],
          "customcat:g1": ["custom:a"],
        },
      },
    });
    expect(tagKeysByCategory.get("feelings")).toEqual([
      "custom:a",
      "happy",
      "sad",
    ]);
    expect(tagKeysByCategory.get("customcat:g1")).toEqual([]);
  });

  it("returns the seeded tree untouched for the empty layout", () => {
    const { orderedCategoryKeys, tagKeysByCategory } = resolveMoodTagPlacement({
      categoryKeysInSeededOrder: categoryKeys,
      tags,
      layout: {},
    });
    expect(orderedCategoryKeys).toEqual(categoryKeys);
    expect(tagKeysByCategory.get("feelings")).toEqual(["happy", "sad"]);
    expect(tagKeysByCategory.get("custom")).toEqual(["custom:a", "custom:b"]);
  });
});
