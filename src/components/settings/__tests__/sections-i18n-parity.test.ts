/**
 * v1.4.16 phase B6 — settings i18n parity.
 *
 * Every slug declared in `SETTINGS_SECTION_SLUGS` MUST have a
 * `settings.sections.<slug>.title` AND a `settings.sections.<slug>.description`
 * resolved in both English and German. The audit doc
 * (`docs/audit/v1416-settings-audit.md`) calls this out as the canonical
 * shape — the sidebar, the page `<h1>`, and the page subtitle all read
 * from these two keys, so a missing key paints a raw key in production.
 */

import { describe, expect, it } from "vitest";
import en from "../../../../messages/en.json" with { type: "json" };
import de from "../../../../messages/de.json" with { type: "json" };
import { SETTINGS_SECTION_SLUGS } from "../section-slugs";

type Bag = Record<string, unknown>;

function lookup(bag: Bag, path: string[]): string | null {
  let cursor: unknown = bag;
  for (const segment of path) {
    if (typeof cursor !== "object" || cursor === null) return null;
    cursor = (cursor as Bag)[segment];
  }
  return typeof cursor === "string" ? cursor : null;
}

describe("settings sections — i18n parity (B6)", () => {
  for (const slug of SETTINGS_SECTION_SLUGS) {
    it(`every locale resolves settings.sections.${slug}.title`, () => {
      const enValue = lookup(en as Bag, ["settings", "sections", slug, "title"]);
      const deValue = lookup(de as Bag, ["settings", "sections", slug, "title"]);
      expect(enValue, `EN missing title for ${slug}`).toBeTypeOf("string");
      expect(enValue?.length ?? 0).toBeGreaterThan(0);
      expect(deValue, `DE missing title for ${slug}`).toBeTypeOf("string");
      expect(deValue?.length ?? 0).toBeGreaterThan(0);
    });

    it(`every locale resolves settings.sections.${slug}.description`, () => {
      const enValue = lookup(en as Bag, [
        "settings",
        "sections",
        slug,
        "description",
      ]);
      const deValue = lookup(de as Bag, [
        "settings",
        "sections",
        slug,
        "description",
      ]);
      expect(enValue, `EN missing description for ${slug}`).toBeTypeOf("string");
      expect(enValue?.length ?? 0).toBeGreaterThan(0);
      expect(deValue, `DE missing description for ${slug}`).toBeTypeOf("string");
      expect(deValue?.length ?? 0).toBeGreaterThan(0);
    });
  }

  it("EN and DE description for every slug are different (catches accidental copy-paste)", () => {
    for (const slug of SETTINGS_SECTION_SLUGS) {
      const enValue = lookup(en as Bag, [
        "settings",
        "sections",
        slug,
        "description",
      ]);
      const deValue = lookup(de as Bag, [
        "settings",
        "sections",
        slug,
        "description",
      ]);
      // It's legitimate for some titles to coincide between locales when
      // the proper noun is the same (e.g. "Dashboard", "API & Tokens").
      // Descriptions, however, MUST be translated — a copy-paste of the
      // EN value into the DE bag is a bug.
      expect(
        deValue,
        `DE description for ${slug} is identical to EN — needs translation`,
      ).not.toBe(enValue);
    }
  });
});
