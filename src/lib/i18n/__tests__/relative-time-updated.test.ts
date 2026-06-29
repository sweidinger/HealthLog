/**
 * v1.22 (W6) — `formatUpdatedLabel`: time only for today, no time for
 * yesterday, locale date for older (honouring the passed formatter).
 */
import { describe, expect, it } from "vitest";

import { formatUpdatedLabel } from "@/lib/i18n/relative-time";
import { makeFormatters } from "@/lib/format-locale";

const t = (key: string, params?: Record<string, string | number>): string => {
  if (key === "insights.updatedTodayAt")
    return `Updated today, ${params?.time}`;
  if (key === "insights.updatedYesterday") return "Updated yesterday";
  if (key === "insights.updatedOn") return `Updated on ${params?.date}`;
  return key;
};
const fmtDate = (d: Date) =>
  `${String(d.getUTCDate()).padStart(2, "0")}.${String(d.getUTCMonth() + 1).padStart(2, "0")}.`;
const fmtTime = (d: Date) =>
  `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;

describe("formatUpdatedLabel", () => {
  it("shows the time for today", () => {
    const now = new Date();
    const out = formatUpdatedLabel(
      now.toISOString(),
      t,
      fmtDate,
      fmtTime,
      "UTC",
    );
    expect(out.startsWith("Updated today, ")).toBe(true);
  });

  it("omits the time for yesterday", () => {
    const y = new Date();
    y.setUTCDate(y.getUTCDate() - 1);
    const out = formatUpdatedLabel(y.toISOString(), t, fmtDate, fmtTime, "UTC");
    expect(out).toBe("Updated yesterday");
  });

  it("uses the date-only formatter for older timestamps", () => {
    const out = formatUpdatedLabel(
      "2020-01-15T08:00:00.000Z",
      t,
      fmtDate,
      fmtTime,
      "UTC",
    );
    expect(out).toBe("Updated on 15.01.");
  });

  it("returns empty for an invalid timestamp", () => {
    expect(formatUpdatedLabel("not-a-date", t, fmtDate, fmtTime, "UTC")).toBe(
      "",
    );
  });

  // v1.25.3 — the briefing freshness label (and the per-metric / narrative
  // cards) feed `formatUpdatedLabel` the preference-aware `fmt.time`. With H24
  // selected the "today" caption must never carry AM/PM, even for an en user
  // whose locale default is 12-hour.
  it("renders today's time without AM/PM when fed an H24 formatter", () => {
    const fmt = makeFormatters("en", "UTC", "H24");
    const now = new Date();
    const out = formatUpdatedLabel(
      now.toISOString(),
      t,
      fmt.dateShort,
      fmt.time,
      "UTC",
    );
    expect(out.startsWith("Updated today, ")).toBe(true);
    expect(out).not.toMatch(/[AP]M/i);
  });

  it("renders today's time with AM/PM when fed an H12 formatter", () => {
    const fmt = makeFormatters("en", "UTC", "H12");
    // A fixed afternoon instant so the assertion is deterministic regardless
    // of when the suite runs; bucketed as "today" via the UTC day boundary.
    const today = new Date();
    today.setUTCHours(14, 30, 0, 0);
    const out = formatUpdatedLabel(
      today.toISOString(),
      t,
      fmt.dateShort,
      fmt.time,
      "UTC",
    );
    expect(out).toMatch(/PM/);
  });
});
