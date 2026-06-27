/**
 * v1.22 (W6) — `formatUpdatedLabel`: time only for today, no time for
 * yesterday, locale date for older (honouring the passed formatter).
 */
import { describe, expect, it } from "vitest";

import { formatUpdatedLabel } from "@/lib/i18n/relative-time";

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
});
