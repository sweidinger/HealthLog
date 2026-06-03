/**
 * v1.11.0 (Epic C, C5) — public clinician-view page gating.
 *
 * Asserts the page answers a flat `notFound()` (404) whenever the resolver
 * yields null — the single blunt response for unknown / revoked / expired /
 * malformed tokens — and renders the scoped view on a successful resolve.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

class NotFoundError extends Error {
  digest = "NEXT_HTTP_ERROR_FALLBACK;404";
}

vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new NotFoundError("NEXT_NOT_FOUND");
  }),
}));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({ get: () => undefined })),
}));
vi.mock("@/lib/clinician-share/resolve-share-token", () => ({
  resolveShareToken: vi.fn(),
}));
vi.mock("@/lib/clinician-share/share-view-data", () => ({
  loadShareViewData: vi.fn(),
}));
vi.mock("@/components/clinician/clinician-view", () => ({
  ClinicianView: () => null,
}));

import ClinicianSharePage from "../page";
import { resolveShareToken } from "@/lib/clinician-share/resolve-share-token";
import { loadShareViewData } from "@/lib/clinician-share/share-view-data";
import { notFound } from "next/navigation";

const resolve = resolveShareToken as ReturnType<typeof vi.fn>;
const loadData = loadShareViewData as ReturnType<typeof vi.fn>;

function pageProps(token: string) {
  return { params: Promise.resolve({ token }) };
}

describe("clinician share page", () => {
  beforeEach(() => vi.clearAllMocks());

  it("404s when the token resolves to null (revoked / expired / unknown)", async () => {
    resolve.mockResolvedValue(null);
    await expect(
      ClinicianSharePage(pageProps(`hls_${"a".repeat(48)}`)),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(notFound).toHaveBeenCalledTimes(1);
    // No data load is attempted on a failed resolve.
    expect(loadData).not.toHaveBeenCalled();
  });

  it("loads the scoped view on a successful resolve", async () => {
    resolve.mockResolvedValue({
      shareLinkId: "link-1",
      ownerUserId: "owner-1",
      label: "Clinic",
      rangeStart: new Date(),
      rangeEnd: null,
      sectionsJson: {},
      resourceTypes: [],
      allowFhirApi: false,
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    loadData.mockResolvedValue({ report: {}, sections: {} });
    await ClinicianSharePage(pageProps(`hls_${"b".repeat(48)}`));
    expect(notFound).not.toHaveBeenCalled();
    expect(loadData).toHaveBeenCalledTimes(1);
  });
});
