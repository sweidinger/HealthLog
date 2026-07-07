import { describe, expect, it } from "vitest";

import type { InboundDocumentDto } from "@/lib/validations/inbound-documents";
import {
  buildTimelineItems,
  buildVaultListApiSearch,
  classifyUploadFailure,
  countActiveFilters,
  documentDateKey,
  formatBytes,
  formatMonthLabel,
  parseUploadResponse,
  parseVaultSearchParams,
  vaultFiltersToSearch,
} from "../vault-utils";

function doc(overrides: Partial<InboundDocumentDto> = {}): InboundDocumentDto {
  return {
    id: "doc-1",
    kind: "DOCTOR_REPORT",
    title: null,
    filename: "letter.pdf",
    mimeType: "application/pdf",
    byteSize: 1024,
    status: "STORED",
    providerType: null,
    reportDate: null,
    documentDate: "2026-03-10",
    errorReason: null,
    factCount: 0,
    pendingCount: 0,
    conditionLinks: [],
    servingClass: "inline",
    createdAt: "2026-03-11T08:00:00.000Z",
    updatedAt: "2026-03-11T08:00:00.000Z",
    ...overrides,
  };
}

describe("URL facet round-trip", () => {
  it("parses q / kind / episode / year and serialises back identically", () => {
    const search = "q=MRT&kind=IMAGING%2CLAB_RESULT&episode=ep1&year=2025";
    const filters = parseVaultSearchParams(new URLSearchParams(search));
    expect(filters).toEqual({
      q: "MRT",
      kinds: ["IMAGING", "LAB_RESULT"],
      episodeId: "ep1",
      year: 2025,
    });
    expect(vaultFiltersToSearch(filters)).toBe(
      "q=MRT&kind=IMAGING%2CLAB_RESULT&episode=ep1&year=2025",
    );
  });

  it("accepts repeated kind params and drops unknown kinds", () => {
    const sp = new URLSearchParams();
    sp.append("kind", "IMAGING");
    sp.append("kind", "NOT_A_KIND");
    sp.append("kind", "IMAGING"); // duplicate collapses
    const filters = parseVaultSearchParams(sp);
    expect(filters.kinds).toEqual(["IMAGING"]);
  });

  it("normalises kind order so the cache key is stable", () => {
    const a = parseVaultSearchParams(
      new URLSearchParams("kind=LAB_RESULT,IMAGING"),
    );
    const b = parseVaultSearchParams(
      new URLSearchParams("kind=IMAGING,LAB_RESULT"),
    );
    expect(a).toEqual(b);
  });

  it("ignores a malformed year and returns the empty default view", () => {
    expect(parseVaultSearchParams(new URLSearchParams("year=20x5"))).toEqual(
      {},
    );
    expect(vaultFiltersToSearch({})).toBe("");
  });

  it("counts active facets per chip (search counts once)", () => {
    expect(countActiveFilters({})).toBe(0);
    expect(
      countActiveFilters({
        q: "a",
        kinds: ["IMAGING", "LAB_RESULT"],
        episodeId: "e",
        year: 2026,
      }),
    ).toBe(5);
  });
});

describe("API list search", () => {
  it("pins timeline sort, maps episode → episodeId, threads the cursor", () => {
    const search = buildVaultListApiSearch(
      { kinds: ["IMAGING"], episodeId: "ep1", year: 2025 },
      "cursor-9",
      50,
    );
    const sp = new URLSearchParams(search);
    expect(sp.get("kind")).toBe("IMAGING");
    expect(sp.get("episodeId")).toBe("ep1");
    expect(sp.get("year")).toBe("2025");
    expect(sp.get("sort")).toBe("documentDate");
    expect(sp.get("order")).toBe("desc");
    expect(sp.get("cursor")).toBe("cursor-9");
    expect(sp.get("limit")).toBe("50");
  });
});

describe("timeline items", () => {
  it("buckets by month and chunks rows to the column count", () => {
    const docs = [
      doc({ id: "a", documentDate: "2026-03-20" }),
      doc({ id: "b", documentDate: "2026-03-15" }),
      doc({ id: "c", documentDate: "2026-03-10" }),
      doc({ id: "d", documentDate: "2026-02-28" }),
    ];
    const items = buildTimelineItems(docs, 2);
    expect(items.map((i) => i.type)).toEqual([
      "month",
      "row",
      "row",
      "month",
      "row",
    ]);
    expect(items[0]).toEqual({ type: "month", key: "2026-03" });
    expect(items[1]).toMatchObject({ documents: [docs[0], docs[1]] });
    expect(items[2]).toMatchObject({ documents: [docs[2]] });
    expect(items[4]).toMatchObject({ documents: [docs[3]] });
  });

  it("files an undated document under its upload day", () => {
    const d = doc({ documentDate: null, createdAt: "2026-01-05T10:00:00Z" });
    expect(documentDateKey(d)).toBe("2026-01-05");
    const items = buildTimelineItems([d], 3);
    expect(items[0]).toEqual({ type: "month", key: "2026-01" });
  });

  it("keeps the DOM bounded: item count scales with rows, not documents", () => {
    const docs = Array.from({ length: 1000 }, (_, i) =>
      doc({ id: `d${i}`, documentDate: "2026-03-01" }),
    );
    const items = buildTimelineItems(docs, 4);
    // 1 month header + 250 rows — the virtualizer then windows over these.
    expect(items).toHaveLength(251);
  });

  it("formats a month key in the viewer's locale", () => {
    expect(formatMonthLabel("2026-03", "de")).toBe("März 2026");
    expect(formatMonthLabel("not-a-month", "de")).toBe("not-a-month");
  });
});

describe("byte formatting", () => {
  it("scales units and keeps one decimal below 10", () => {
    expect(formatBytes(0, "en")).toBe("0 B");
    expect(formatBytes(512, "en")).toBe("512 B");
    expect(formatBytes(26_214_400, "en")).toBe("25 MB");
    expect(formatBytes(1_288_490_189, "en")).toBe("1.2 GB");
  });
});

describe("upload response contract (§3.2)", () => {
  it("HTTP 200 + meta.duplicate returns the EXISTING row as a duplicate", () => {
    const body = JSON.stringify({
      data: doc({ id: "existing-row" }),
      error: null,
      meta: { duplicate: true },
    });
    const result = parseUploadResponse(200, body);
    expect(result).toMatchObject({
      ok: true,
      duplicate: true,
      document: { id: "existing-row" },
    });
  });

  it("a plain 201 success is not a duplicate", () => {
    const body = JSON.stringify({ data: doc({ id: "fresh" }), error: null });
    expect(parseUploadResponse(201, body)).toMatchObject({
      ok: true,
      duplicate: false,
      document: { id: "fresh" },
    });
  });

  it("maps every meta.reason to its translated-copy class", () => {
    expect(
      parseUploadResponse(
        413,
        JSON.stringify({
          data: null,
          error: "too large",
          meta: { reason: "fileTooLarge", maxFileBytes: 26_214_400 },
        }),
      ),
    ).toEqual({
      ok: false,
      reason: "fileTooLarge",
      maxFileBytes: 26_214_400,
      quotaBytes: undefined,
      usedBytes: undefined,
      existingId: undefined,
    });

    expect(
      parseUploadResponse(
        413,
        JSON.stringify({
          data: null,
          error: "quota",
          meta: {
            reason: "quotaExceeded",
            quotaBytes: 1_073_741_824,
            usedBytes: 1_000_000_000,
          },
        }),
      ),
    ).toMatchObject({
      ok: false,
      reason: "quotaExceeded",
      quotaBytes: 1_073_741_824,
      usedBytes: 1_000_000_000,
    });

    expect(
      classifyUploadFailure(415, { reason: "unsupportedType" }),
    ).toMatchObject({ reason: "unsupportedType" });
    expect(classifyUploadFailure(409, { reason: "purged" })).toMatchObject({
      reason: "purged",
    });
    expect(
      classifyUploadFailure(409, {
        reason: "duplicateExists",
        existingId: "row-1",
      }),
    ).toMatchObject({ reason: "duplicateExists", existingId: "row-1" });
  });

  it("falls back to the HTTP status when a proxy strips the body", () => {
    expect(parseUploadResponse(413, "")).toMatchObject({
      reason: "fileTooLarge",
    });
    expect(parseUploadResponse(415, "<html>")).toMatchObject({
      reason: "unsupportedType",
    });
    expect(parseUploadResponse(429, "")).toMatchObject({
      reason: "rateLimited",
    });
    expect(parseUploadResponse(500, "")).toMatchObject({ reason: "generic" });
  });
});
