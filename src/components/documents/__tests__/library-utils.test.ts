import { describe, it, expect } from "vitest";

import { ApiError } from "@/lib/api/api-fetch";
import type { InboundDocumentDto } from "@/lib/validations/inbound-documents";
import {
  buildDocumentListSearch,
  classifyUploadError,
  documentDateKey,
  formatDateGroupLabel,
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
  it("matches the extract 409 partly-confirmed signal", () => {
    const err = new ApiError("already confirmed", 409, {
      errorCode: "documents.inbound.alreadyPartlyConfirmed",
    });
    expect(isAlreadyConfirmedError(err)).toBe(true);
  });

  it("matches the extract 422 fully-confirmed signal", () => {
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

describe("classifyUploadError", () => {
  it("maps each upload error code to its kind", () => {
    const code = (c: string) =>
      classifyUploadError(new ApiError("x", 400, { errorCode: c }));
    expect(code("documents.inbound.fileTooLarge")).toBe("tooLarge");
    expect(code("documents.inbound.fileType")).toBe("fileType");
    expect(code("documents.inbound.rateLimited")).toBe("rateLimited");
    expect(code("documents.inbound.invalidMetadata")).toBe("invalidMetadata");
  });

  it("falls back to the HTTP status when the body carries no error code", () => {
    expect(classifyUploadError(new ApiError("too big", 413))).toBe("tooLarge");
    expect(classifyUploadError(new ApiError("wrong type", 415))).toBe(
      "fileType",
    );
    expect(classifyUploadError(new ApiError("slow down", 429))).toBe(
      "rateLimited",
    );
  });

  it("returns generic for unknown errors and non-API errors", () => {
    expect(classifyUploadError(new ApiError("boom", 500))).toBe("generic");
    expect(classifyUploadError(new Error("network"))).toBe("generic");
    expect(classifyUploadError(null)).toBe("generic");
  });
});

describe("formatDateGroupLabel", () => {
  it("delegates the calendar day to the supplied app formatter", () => {
    const seen: string[] = [];
    const formatDate = (value: string) => {
      seen.push(value);
      return "FORMATTED";
    };
    expect(formatDateGroupLabel("2026-06-20", formatDate)).toBe("FORMATTED");
    // Handed over as a noon-UTC instant so the day never shifts under the tz.
    expect(seen).toEqual(["2026-06-20T12:00:00.000Z"]);
  });

  it("returns a malformed key unchanged without calling the formatter", () => {
    const formatDate = () => {
      throw new Error("should not be called");
    };
    expect(formatDateGroupLabel("not-a-date", formatDate)).toBe("not-a-date");
  });
});
