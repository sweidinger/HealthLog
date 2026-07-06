/**
 * Pins the fail-soft contract of `handleCollectionFetchError`: a hard failure
 * (anything but the per-class 403 soft-skip) records the classified sync
 * failure and RETURNS — it must not rethrow, because every call site sits in a
 * per-collection catch and a rethrow would abort the sibling collections
 * (live: steps 400ing suppressed distance / floors / active-energy entirely).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { recordSyncFailureMock } = vi.hoisted(() => ({
  recordSyncFailureMock: vi.fn(async () => {}),
}));

vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/crypto", () => ({ encrypt: vi.fn(), decrypt: vi.fn() }));
vi.mock("@/lib/integrations/status", () => ({
  isReauthRequired: vi.fn(async () => false),
  recordSyncFailure: recordSyncFailureMock,
  recordSyncSuccess: vi.fn(async () => {}),
}));
vi.mock("@/lib/rollups/measurement-rollups", () => ({
  collapseToTypeDayKeys: vi.fn(() => []),
  recomputeBucketsForMeasurement: vi.fn(async () => {}),
  recomputeUserRollups: vi.fn(async () => {}),
}));
vi.mock("@/lib/insights/comprehensive-generate", () => ({
  invalidateStatusInsightsForTypes: vi.fn(async () => {}),
}));
vi.mock("../credentials", () => ({
  getUserGoogleHealthCredentials: vi.fn(async () => null),
}));
vi.mock("../client", () => ({ refreshAccessToken: vi.fn() }));

import { handleCollectionFetchError } from "../sync";
import { GoogleHealthApiError } from "../response-classifier";

beforeEach(() => {
  recordSyncFailureMock.mockClear();
});

describe("handleCollectionFetchError — fail-soft grouping", () => {
  it("soft-skips a per-class 403 without recording a failure", async () => {
    const err = new GoogleHealthApiError({
      verb: "fetchSteps",
      classification: "reauth_required",
      httpStatus: 403,
      reason: "HTTP 403",
    });
    await expect(
      handleCollectionFetchError("fetchSteps", "user-1", err),
    ).resolves.toBe(0);
    expect(recordSyncFailureMock).not.toHaveBeenCalled();
  });

  it("records a 400 as a persistent failure and returns instead of rethrowing", async () => {
    const err = new GoogleHealthApiError({
      verb: "fetchSteps",
      classification: "persistent",
      httpStatus: 400,
      reason: "HTTP 400",
      upstreamError: "INVALID_ARGUMENT: Invalid argument in request.",
    });
    await expect(
      handleCollectionFetchError("fetchSteps", "user-1", err),
    ).resolves.toBe(0);
    expect(recordSyncFailureMock).toHaveBeenCalledTimes(1);
    expect(recordSyncFailureMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        integration: "google-health",
        kind: "persistent",
        errorCode: "400",
      }),
    );
  });

  it("records a transient failure (5xx) and returns as well", async () => {
    const err = new GoogleHealthApiError({
      verb: "fetchDistance",
      classification: "transient",
      httpStatus: 503,
      reason: "HTTP 503",
    });
    await expect(
      handleCollectionFetchError("fetchDistance", "user-1", err),
    ).resolves.toBe(0);
    expect(recordSyncFailureMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "transient" }),
    );
  });
});
