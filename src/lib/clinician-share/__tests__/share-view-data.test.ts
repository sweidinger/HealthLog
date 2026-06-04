/**
 * v1.11.0 (Epic C, C8) — clinician-view scoped data load guarantees.
 *
 * The public clinician view aggregates ONLY the data the owner froze into the
 * link, and it must NEVER surface the insurance number (KVNR). KVNR is
 * default-OFF by construction: `loadShareViewData` calls the doctor-report
 * aggregator with the frozen window + section toggles and nothing else — no
 * identifier opt-in, no decrypt path. This test pins that contract so a future
 * change can't silently widen the clinician view to leak the KVNR.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/doctor-report-data", () => ({
  collectDoctorReportData: vi.fn(),
}));
vi.mock("@/lib/validations/doctor-report-prefs", () => ({
  parseDoctorReportPrefs: vi.fn((s: unknown) => s ?? {}),
}));

import { loadShareViewData } from "../share-view-data";
import { collectDoctorReportData } from "@/lib/doctor-report-data";
import type { ShareContext } from "../resolve-share-token";

const collect = collectDoctorReportData as ReturnType<typeof vi.fn>;

function ctx(overrides: Partial<ShareContext> = {}): ShareContext {
  return {
    shareLinkId: "link-1",
    ownerUserId: "owner-1",
    label: "Clinic",
    rangeStart: new Date("2026-01-01T00:00:00Z"),
    rangeEnd: new Date("2026-02-01T00:00:00Z"),
    sectionsJson: { mood: false },
    resourceTypes: [],
    allowFhirApi: false,
    expiresAt: new Date(Date.now() + 86_400_000),
    ...overrides,
  } as ShareContext;
}

describe("loadShareViewData — KVNR default OFF", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    collect.mockResolvedValue({
      patient: { displayName: "Shared record" },
    });
  });

  it("scopes the aggregator to the OWNER from the share context, never the wire", async () => {
    await loadShareViewData(ctx());
    expect(collect).toHaveBeenCalledTimes(1);
    expect(collect.mock.calls[0]![0]).toBe("owner-1");
  });

  it("never requests an identifier / KVNR opt-in from the aggregator", async () => {
    await loadShareViewData(ctx());
    const opts = collect.mock.calls[0]![2] as Record<string, unknown>;
    // The only option ever passed is the frozen section toggles — no
    // includeIdentifiers, no kvnr, no decrypt flag. Default-OFF by absence.
    expect(opts).toBeDefined();
    expect(opts).not.toHaveProperty("includeIdentifiers");
    expect(opts).not.toHaveProperty("kvnr");
    expect(opts).not.toHaveProperty("insuranceNumber");
    expect(Object.keys(opts)).toEqual(["sections"]);
  });

  it("returns a report payload carrying no insurance number", async () => {
    const { report } = await loadShareViewData(ctx());
    const patient = (report as { patient?: Record<string, unknown> }).patient;
    expect(patient).not.toHaveProperty("insuranceNumber");
    expect(patient).not.toHaveProperty("kvnr");
  });

  it("uses the frozen rangeStart and resolves a rolling rangeEnd to now", async () => {
    const now = Date.now();
    await loadShareViewData(ctx({ rangeEnd: null }));
    const range = collect.mock.calls[0]![1] as {
      start: Date;
      end: Date;
      days: number;
    };
    expect(range.start.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    // Rolling end materialises near "now", never before the frozen start.
    expect(range.end.getTime()).toBeGreaterThanOrEqual(now - 5_000);
    expect(range.days).toBeGreaterThan(0);
  });
});
