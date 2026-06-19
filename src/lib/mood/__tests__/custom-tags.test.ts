import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/crypto", () => ({
  encrypt: (s: string) => `enc:${s}`,
  decrypt: (s: string) => {
    if (!s.startsWith("enc:")) throw new Error("bad ciphertext");
    return s.slice(4);
  },
}));

import {
  isCustomTagKey,
  mintCustomTagKey,
  isCustomCategoryKey,
  mintCustomCategoryKey,
  encryptCustomLabel,
  decryptCustomLabel,
  createCustomTagSchema,
  updateCustomTagSchema,
  createCustomGroupSchema,
  updateCustomGroupSchema,
  hideCatalogueTagSchema,
  CUSTOM_TAG_KEY_PREFIX,
  CUSTOM_CATEGORY_KEY_PREFIX,
  CUSTOM_TAG_ICON_ALLOWLIST,
} from "@/lib/mood/custom-tags";
import { MOOD_TAG_ICON_CATALOG } from "@/lib/mood/icon-catalog";
import { resolveTagKeysToIds } from "@/lib/mood/tag-links";

describe("custom-tag helpers", () => {
  it("mints prefixed, unique keys and recognises them", () => {
    const a = mintCustomTagKey();
    const b = mintCustomTagKey();
    expect(a.startsWith(CUSTOM_TAG_KEY_PREFIX)).toBe(true);
    expect(a).not.toBe(b);
    expect(isCustomTagKey(a)).toBe(true);
    expect(isCustomTagKey("happy")).toBe(false);
  });

  it("round-trips a label and tolerates a corrupt ciphertext", () => {
    const enc = encryptCustomLabel("Migräne");
    expect(decryptCustomLabel(enc)).toBe("Migräne");
    expect(decryptCustomLabel(null)).toBeNull();
    expect(decryptCustomLabel("garbage")).toBeNull();
  });
});

describe("custom-tag schemas", () => {
  it("accepts a valid create and rejects a bad icon / empty / over-long label", () => {
    expect(
      createCustomTagSchema.safeParse({ label: "Date night", icon: "Heart" })
        .success,
    ).toBe(true);
    expect(createCustomTagSchema.safeParse({ label: "  ok  " }).success).toBe(
      true,
    );
    expect(
      createCustomTagSchema.safeParse({ label: "x", icon: "NotAnIcon" })
        .success,
    ).toBe(false);
    expect(createCustomTagSchema.safeParse({ label: "" }).success).toBe(false);
    expect(
      createCustomTagSchema.safeParse({ label: "a".repeat(41) }).success,
    ).toBe(false);
  });

  it("requires at least one field on update and validates hidden flag", () => {
    expect(updateCustomTagSchema.safeParse({}).success).toBe(false);
    expect(updateCustomTagSchema.safeParse({ isActive: false }).success).toBe(
      true,
    );
    expect(hideCatalogueTagSchema.safeParse({ hidden: true }).success).toBe(
      true,
    );
    expect(hideCatalogueTagSchema.safeParse({ hidden: "yes" }).success).toBe(
      false,
    );
  });

  it("accepts a categoryKey on create + update (v1.17.0) within bounds", () => {
    expect(
      createCustomTagSchema.safeParse({ label: "x", categoryKey: "feelings" })
        .success,
    ).toBe(true);
    expect(
      createCustomTagSchema.safeParse({
        label: "x",
        categoryKey: `customcat:${"a".repeat(36)}`,
      }).success,
    ).toBe(true);
    expect(
      createCustomTagSchema.safeParse({
        label: "x",
        categoryKey: "k".repeat(81),
      }).success,
    ).toBe(false);
    // A lone categoryKey satisfies the at-least-one-field update refine.
    expect(
      updateCustomTagSchema.safeParse({ categoryKey: "custom" }).success,
    ).toBe(true);
  });
});

describe("custom-group helpers + schemas (v1.17.0)", () => {
  it("mints prefixed, unique group keys and recognises them", () => {
    const a = mintCustomCategoryKey();
    const b = mintCustomCategoryKey();
    expect(a.startsWith(CUSTOM_CATEGORY_KEY_PREFIX)).toBe(true);
    expect(a).not.toBe(b);
    expect(isCustomCategoryKey(a)).toBe(true);
    expect(isCustomCategoryKey("feelings")).toBe(false);
    // A custom TAG key is not a custom GROUP key and vice versa.
    expect(isCustomCategoryKey(mintCustomTagKey())).toBe(false);
    expect(isCustomTagKey(a)).toBe(false);
  });

  it("validates group create / update bodies like the tag schemas", () => {
    expect(
      createCustomGroupSchema.safeParse({ label: "Hobbies 2" }).success,
    ).toBe(true);
    expect(
      createCustomGroupSchema.safeParse({ label: "x", icon: "Stethoscope" })
        .success,
    ).toBe(true);
    expect(
      createCustomGroupSchema.safeParse({ label: "x", icon: "NotAnIcon" })
        .success,
    ).toBe(false);
    expect(createCustomGroupSchema.safeParse({ label: "" }).success).toBe(
      false,
    );
    expect(
      createCustomGroupSchema.safeParse({ label: "a".repeat(41) }).success,
    ).toBe(false);
    expect(updateCustomGroupSchema.safeParse({}).success).toBe(false);
    expect(updateCustomGroupSchema.safeParse({ isActive: false }).success).toBe(
      true,
    );
  });
});

describe("icon catalog → allowlist seam (v1.17.0)", () => {
  it("derives the allowlist from the catalog and keeps the pre-v1.17 names", () => {
    expect(CUSTOM_TAG_ICON_ALLOWLIST).toEqual(
      MOOD_TAG_ICON_CATALOG.map((e) => e.name),
    );
    // The v1.13 22-name allowlist must survive — icons already stored on
    // rows keep validating.
    const legacy = [
      "Tag",
      "Heart",
      "Smile",
      "Frown",
      "Dumbbell",
      "Moon",
      "Sun",
      "Wine",
      "Coffee",
      "House",
      "Briefcase",
      "Book",
      "Music",
      "Plane",
      "Car",
      "Users",
      "Pill",
      "Activity",
      "Brain",
      "Cloud",
      "Star",
      "Zap",
    ];
    for (const name of legacy) {
      expect(CUSTOM_TAG_ICON_ALLOWLIST).toContain(name);
    }
    // No duplicate names in the catalog (the picker keys on them).
    expect(new Set(CUSTOM_TAG_ICON_ALLOWLIST).size).toBe(
      CUSTOM_TAG_ICON_ALLOWLIST.length,
    );
  });
});

describe("resolveTagKeysToIds — custom-tag ownership scoping (v1.13.0)", () => {
  function fakeDb(rows: Array<{ id: string }>) {
    return { moodTag: { findMany: vi.fn().mockResolvedValue(rows) } };
  }

  it("scopes custom keys to the caller (catalogue OR own custom) when an owner is given", async () => {
    const db = fakeDb([{ id: "id1" }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await resolveTagKeysToIds(["happy", "custom:mine"], db as any, "user-1");
    const where = db.moodTag.findMany.mock.calls[0][0].where;
    expect(where.OR).toEqual([{ userId: null }, { userId: "user-1" }]);
    expect(where.isActive).toBe(true);
  });

  it("falls back to catalogue-only (never matching any custom) without an owner", async () => {
    const db = fakeDb([]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await resolveTagKeysToIds(["happy"], db as any);
    const where = db.moodTag.findMany.mock.calls[0][0].where;
    expect(where.userId).toBeNull();
    expect(where.OR).toBeUndefined();
  });
});
