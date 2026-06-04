import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * v1.12.0 — moodLog is deprecated (superseded by native mood entries +
 * structured tags + rated factors), but kept FUNCTIONAL this release. This
 * test pins the `@deprecated` JSDoc marker on the surface so a future edit
 * that touches these files can't silently drop the deprecation notice
 * before the planned removal.
 */
const ROOT = join(__dirname, "..", "..", "..", "..");

const DEPRECATED_FILES = [
  "src/app/api/integrations/moodlog/webhook/route.ts",
  "src/lib/moodlog/push.ts",
  "src/lib/moodlog/sync.ts",
  "src/lib/validations/moodlog.ts",
];

describe("moodLog deprecation markers", () => {
  for (const rel of DEPRECATED_FILES) {
    it(`marks ${rel} with @deprecated`, () => {
      const src = readFileSync(join(ROOT, rel), "utf8");
      expect(src).toContain("@deprecated");
      // The marker must mention the superseding native path so the note is
      // actionable, not a bare tag.
      expect(src.toLowerCase()).toContain("superseded");
    });
  }
});
