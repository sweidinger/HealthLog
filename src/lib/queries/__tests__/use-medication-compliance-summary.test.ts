/**
 * v1.16.8 — batched per-card compliance read, error contract.
 *
 * The hook's queryFn used to swallow every failure to `null`. TanStack
 * caches that `null` as a SUCCESS, so a failed / aborted batch read
 * neither retried nor refetched and every medication card sat on the
 * loading skeleton until a full invalidation. The contract now: the
 * queryFn lets the rejection propagate (default retry/backoff applies),
 * `isError` + `refetch` surface to the cards so the compliance slot can
 * swap to the quiet retry fallback, and the per-card `select` keeps the
 * one-request / many-cards collapse intact.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const useQueryMock = vi.fn<(opts: Record<string, unknown>) => unknown>();

vi.mock("@tanstack/react-query", () => ({
  useQuery: (opts: Record<string, unknown>) => useQueryMock(opts),
}));

const apiGetMock = vi.fn();

vi.mock("@/lib/api/api-fetch", () => ({
  apiGet: (...a: unknown[]) => apiGetMock(...a),
}));

import { useMedicationComplianceSummary } from "../use-medication-compliance-summary";
import { queryKeys } from "@/lib/query-keys";

interface CapturedOptions {
  queryKey: unknown;
  queryFn: () => Promise<unknown>;
  select: (rows: Array<{ medicationId: string }>) => unknown;
  retry?: unknown;
}

function lastOpts(): CapturedOptions {
  expect(useQueryMock).toHaveBeenCalledTimes(1);
  return useQueryMock.mock.calls[0][0] as unknown as CapturedOptions;
}

beforeEach(() => {
  vi.clearAllMocks();
  useQueryMock.mockReturnValue({
    data: undefined,
    isError: false,
    refetch: vi.fn(),
  });
});

describe("useMedicationComplianceSummary", () => {
  it("registers under the centralised factory key", () => {
    useMedicationComplianceSummary("med-1");
    expect(lastOpts().queryKey).toEqual(
      queryKeys.medicationComplianceSummary(),
    );
  });

  it("lets a failed batch read REJECT instead of resolving to null", async () => {
    useMedicationComplianceSummary("med-1");
    const failure = new Error("Request failed (500)");
    apiGetMock.mockRejectedValue(failure);

    // No catch in the queryFn: TanStack sees the rejection, applies its
    // default retry, and lands the query in error state — the previous
    // swallowed-`null` version cached a fake success forever.
    await expect(lastOpts().queryFn()).rejects.toBe(failure);
  });

  it("does not disable the default retry behaviour", () => {
    useMedicationComplianceSummary("med-1");
    expect(lastOpts().retry).toBeUndefined();
  });

  it("selects the card's own row from the shared batch (null when absent)", () => {
    useMedicationComplianceSummary("med-1");
    const opts = lastOpts();
    const rows = [
      { medicationId: "med-0" },
      { medicationId: "med-1" },
      { medicationId: "med-2" },
    ];
    expect(opts.select(rows)).toEqual({ medicationId: "med-1" });
    expect(opts.select([{ medicationId: "med-9" }])).toBeNull();
  });

  it("surfaces isError and refetch to the card", () => {
    const refetch = vi.fn();
    useQueryMock.mockReturnValue({ data: undefined, isError: true, refetch });
    const result = useMedicationComplianceSummary("med-1");
    expect(result.isError).toBe(true);
    result.refetch();
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});
