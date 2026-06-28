import { describe, it, expect } from "vitest";

import { ApiError } from "@/lib/api/api-fetch";
import type { InboundDocumentDto } from "@/lib/validations/inbound-documents";
import {
  buildDocumentListSearch,
  documentDateKey,
  groupDocumentsByDate,
  isAlreadyConfirmedError,
  isProviderUnsupportedError,
} from "../library-utils";

function doc(
  id: string,
  over: Partial<InboundDocumentDto> = {},
): InboundDocumentDto {
  return {
    id,
    kind: "OTHER",
    title: null,
    filename: `${id}.pdf`,
    mimeType: "application/pdf",
    byteSize: 1000,
    status: "STORED",
    providerType: null,
    reportDate: null,
    documentDate: null,
    errorReason: null,
    factCount: 0,
    pendingCount: 0,
    createdAt: "2026-06-20T08:00:00.000Z",
    updatedAt: "2026-06-20T08:00:00.000Z",
    ...over,
  };
}

describe("buildDocumentListSearch", () => {
  it("emits the active filters, sort, order, and limit", () => {
    const qs = buildDocumentListSearch(
      {
        q: "cardio",
        kind: "LAB_RESULT",
        from: "2026-01-01",
        to: "2026-06-01",
        sort: "title",
        order: "asc",
      },
      null,
      25,
    );
    const sp = new URLSearchParams(qs);
    expect(sp.get("q")).toBe("cardio");
    expect(sp.get("kind")).toBe("LAB_RESULT");
    expect(sp.get("from")).toBe("2026-01-01");
    expect(sp.get("to")).toBe("2026-06-01");
    expect(sp.get("sort")).toBe("title");
    expect(sp.get("order")).toBe("asc");
    expect(sp.get("limit")).toBe("25");
    expect(sp.has("cursor")).toBe(false);
  });

  it("omits empty filters and appends the keyset cursor when present", () => {
    const qs = buildDocumentListSearch(
      { sort: "documentDate", order: "desc" },
      "cursor-123",
    );
    const sp = new URLSearchParams(qs);
    expect(sp.has("q")).toBe(false);
    expect(sp.has("kind")).toBe(false);
    expect(sp.get("sort")).toBe("documentDate");
    expect(sp.get("order")).toBe("desc");
    expect(sp.get("cursor")).toBe("cursor-123");
  });
});

describe("documentDateKey", () => {
  it("prefers the user filing date", () => {
    expect(documentDateKey(doc("a", { documentDate: "2026-03-15" }))).toBe(
      "2026-03-15",
    );
  });

  it("falls back to the upload day from createdAt", () => {
    expect(
      documentDateKey(doc("a", { createdAt: "2026-06-20T08:00:00.000Z" })),
    ).toBe("2026-06-20");
  });
});

describe("groupDocumentsByDate", () => {
  it("buckets consecutive same-date documents, preserving server order", () => {
    const groups = groupDocumentsByDate([
      doc("a", { documentDate: "2026-06-20" }),
      doc("b", { documentDate: "2026-06-20" }),
      doc("c", { documentDate: "2026-06-19" }),
    ]);
    expect(groups.map((g) => g.key)).toEqual(["2026-06-20", "2026-06-19"]);
    expect(groups[0].documents.map((d) => d.id)).toEqual(["a", "b"]);
    expect(groups[1].documents.map((d) => d.id)).toEqual(["c"]);
  });

  it("returns an empty array for no documents", () => {
    expect(groupDocumentsByDate([])).toEqual([]);
  });
});

describe("isProviderUnsupportedError", () => {
  it("matches the extract 422 provider-unsupported signal", () => {
    const err = new ApiError("no provider", 422, {
      errorCode: "documents.inbound.providerUnsupported",
    });
    expect(isProviderUnsupportedError(err)).toBe(true);
  });

  it("rejects other API errors and non-errors", () => {
    expect(
      isProviderUnsupportedError(
        new ApiError("rate", 429, {
          errorCode: "documents.inbound.rateLimited",
        }),
      ),
    ).toBe(false);
    expect(isProviderUnsupportedError(new Error("boom"))).toBe(false);
    expect(isProviderUnsupportedError(null)).toBe(false);
  });
});

describe("isAlreadyConfirmedError", () => {
  it("matches the extract 422 already-confirmed signal", () => {
    const err = new ApiError("already confirmed", 422, {
      errorCode: "documents.inbound.alreadyConfirmed",
    });
    expect(isAlreadyConfirmedError(err)).toBe(true);
  });

  it("rejects other API errors and non-errors", () => {
    expect(
      isAlreadyConfirmedError(
        new ApiError("no provider", 422, {
          errorCode: "documents.inbound.providerUnsupported",
        }),
      ),
    ).toBe(false);
    expect(isAlreadyConfirmedError(new Error("boom"))).toBe(false);
    expect(isAlreadyConfirmedError(null)).toBe(false);
  });
});
