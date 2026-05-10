import { describe, expect, test } from "vitest";

import deMessages from "../../../messages/de.json";
import enMessages from "../../../messages/en.json";

/**
 * v1.4.19 A8 / F-03 — `achievements.list.overIntake1.title === "Idiot"` and
 * `achievements.list.skippedIntake1.title === "Lazy Boy"` were shipping in
 * both EN and DE bundles. For a personal health app that translates to a
 * literal insult any time the user double-doses (e.g. forgot they already
 * took it) or skips a dose. This guard pins the fix and prevents copy-paste
 * regressions when adding new badges.
 */

const BANNED = ["idiot", "lazy boy", "lazyboy", "loser", "stupid", "dummy"];

interface MessagesShape {
  achievements?: {
    badges?: Record<string, { title?: string; description?: string }>;
  };
}

function readBadgeTitles(
  messages: MessagesShape,
): { key: string; title: string }[] {
  const badges = messages.achievements?.badges ?? {};
  return Object.entries(badges).map(([key, entry]) => ({
    key,
    title: entry.title ?? "",
  }));
}

describe("achievement titles", () => {
  test.each([
    ["en", enMessages as unknown as MessagesShape],
    ["de", deMessages as unknown as MessagesShape],
  ] as const)("%s bundle contains no insulting titles", (_locale, bundle) => {
    const offending = readBadgeTitles(bundle).filter((entry) =>
      BANNED.some((b) => entry.title.toLowerCase().includes(b)),
    );
    expect(offending).toEqual([]);
  });

  test.each([
    ["en", enMessages as unknown as MessagesShape],
    ["de", deMessages as unknown as MessagesShape],
  ] as const)(
    "%s overIntake1/skippedIntake1 are translated, not the literal English shipped before",
    (_locale, bundle) => {
      const badges = bundle.achievements?.badges ?? {};
      expect(badges.overIntake1?.title).toBeDefined();
      expect(badges.skippedIntake1?.title).toBeDefined();
      expect(badges.overIntake1?.title).not.toBe("Idiot");
      expect(badges.skippedIntake1?.title).not.toBe("Lazy Boy");
    },
  );
});
