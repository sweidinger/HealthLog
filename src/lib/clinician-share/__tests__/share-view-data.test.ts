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
// The real prefs parser is used so the "no section enabled ⇒ documents-only"
// signal is exercised end to end (a stubbed parser would let the test lie
// about which sectionsJson resolves to an empty report scope).
vi.mock("@/lib/db", () => ({
  prisma: {
    clinicianShareLinkDocument: { findMany: vi.fn() },
  },
}));

import { loadShareViewData } from "../share-view-data";
import { collectDoctorReportData } from "@/lib/doctor-report-data";
import { EMPTY_DOCTOR_REPORT_PREFS } from "@/lib/validations/doctor-report-prefs";
import { prisma } from "@/lib/db";
import type { ShareContext } from "../resolve-share-token";

const collect = collectDoctorReportData as ReturnType<typeof vi.fn>;
const findDocs = prisma.clinicianShareLinkDocument.findMany as ReturnType<
  typeof vi.fn
>;

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
    findDocs.mockResolvedValue([]);
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

  it("lists the frozen document set as metadata only (never bytes)", async () => {
    findDocs.mockResolvedValue([
      {
        document: {
          id: "doc-a",
          title: "Blood panel",
          kind: "LAB_REPORT",
          documentDate: new Date("2026-01-15T00:00:00Z"),
          byteSize: 12345,
          mimeType: "application/pdf",
        },
      },
      {
        document: {
          id: "doc-b",
          title: null,
          kind: "OTHER",
          documentDate: null,
          byteSize: 6789,
          mimeType: "application/msword",
        },
      },
    ]);

    const { documents } = await loadShareViewData(ctx());

    // Scoped to THIS link + owner + live rows; the blob column is never named.
    const arg = findDocs.mock.calls[0]![0] as {
      where: Record<string, unknown>;
      select: { document: { select: Record<string, boolean> } };
    };
    expect(arg.where).toEqual({
      shareLinkId: "link-1",
      document: { userId: "owner-1", deletedAt: null },
    });
    expect(arg.select.document.select).not.toHaveProperty("contentEncrypted");

    expect(documents).toEqual([
      {
        id: "doc-a",
        title: "Blood panel",
        kind: "LAB_REPORT",
        documentDate: "2026-01-15",
        byteSize: 12345,
        mimeType: "application/pdf",
        servingClass: "inline",
      },
      {
        id: "doc-b",
        title: null,
        kind: "OTHER",
        documentDate: null,
        byteSize: 6789,
        mimeType: "application/msword",
        servingClass: "attachment",
      },
    ]);
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

/**
 * The load-bearing privacy guarantee: a documents-only share (every report
 * section OFF) serves ZERO health metrics. The doctor-report aggregator is
 * never called, so no vital / lab / medication / wellness figure ever leaves
 * the database — the recipient sees only the attached document(s). "Share this
 * document" means the document, not the whole record.
 */
describe("loadShareViewData — documents-only share exposes no health data", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    collect.mockResolvedValue({ patient: { displayName: "Shared record" } });
    findDocs.mockResolvedValue([]);
  });

  it("never aggregates a report and returns report=null when no section is enabled", async () => {
    findDocs.mockResolvedValue([
      {
        document: {
          id: "doc-a",
          title: "Blood panel",
          kind: "LAB_REPORT",
          documentDate: new Date("2026-01-15T00:00:00Z"),
          byteSize: 12345,
          mimeType: "application/pdf",
        },
      },
    ]);

    const { report, documentOnly, documents } = await loadShareViewData(
      ctx({ sectionsJson: EMPTY_DOCTOR_REPORT_PREFS }),
    );

    // The one guarantee: the aggregator is NEVER invoked — no health data is
    // read from the DB, let alone served.
    expect(collect).not.toHaveBeenCalled();
    expect(report).toBeNull();
    expect(documentOnly).toBe(true);

    // The attached document is still surfaced (metadata only, never bytes).
    expect(documents).toEqual([
      {
        id: "doc-a",
        title: "Blood panel",
        kind: "LAB_REPORT",
        documentDate: "2026-01-15",
        byteSize: 12345,
        mimeType: "application/pdf",
        servingClass: "inline",
      },
    ]);
  });

  it("still aggregates for a record share (defaults resolve to an enabled scope)", async () => {
    // `{}` / null sections resolve to the documented defaults (a full record
    // share), so the aggregator DOES run — the empty-scope short-circuit must
    // not swallow a normal record share.
    const { report, documentOnly } = await loadShareViewData(
      ctx({ sectionsJson: {} }),
    );
    expect(collect).toHaveBeenCalledTimes(1);
    expect(documentOnly).toBe(false);
    expect(report).not.toBeNull();
  });
});
