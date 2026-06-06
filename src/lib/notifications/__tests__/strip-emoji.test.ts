import { describe, it, expect } from "vitest";

import {
  stripDecorativeEmoji,
  shouldStripEmoji,
  plainPushText,
} from "@/lib/notifications/strip-emoji";

describe("stripDecorativeEmoji", () => {
  it("removes the colour-coded reminder phase markers and tidies whitespace", () => {
    expect(stripDecorativeEmoji("🟢 Reminder: Ramipril")).toBe(
      "Reminder: Ramipril",
    );
    expect(stripDecorativeEmoji("🔴 Missed: Metformin")).toBe(
      "Missed: Metformin",
    );
  });

  it("strips clock / skip / check emoji and regional indicators", () => {
    expect(stripDecorativeEmoji("🕐 1h ⏭ Skip ✅")).toBe("1h Skip");
  });

  it("leaves plain text untouched", () => {
    expect(stripDecorativeEmoji("Due soon: Vitamin D (1 tablet)")).toBe(
      "Due soon: Vitamin D (1 tablet)",
    );
  });

  it("spares ™ © ® so brand names survive", () => {
    expect(stripDecorativeEmoji("Tylenol® reminder")).toBe("Tylenol® reminder");
  });
});

describe("shouldStripEmoji / plainPushText", () => {
  it("strips for routine reminder events", () => {
    expect(shouldStripEmoji("MEDICATION_REMINDER")).toBe(true);
    expect(shouldStripEmoji("MOOD_REMINDER")).toBe(true);
    expect(plainPushText("🟢 Take Ramipril", "MEDICATION_REMINDER")).toBe(
      "Take Ramipril",
    );
  });

  it("keeps emoji for system / failure alerts", () => {
    expect(shouldStripEmoji("SYSTEM_ALERT")).toBe(false);
    expect(plainPushText("⚠️ Sync failed", "SYSTEM_ALERT")).toBe(
      "⚠️ Sync failed",
    );
  });
});
