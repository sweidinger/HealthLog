/**
 * Supply-staleness regression — the medications-list card / table read
 * the dose-derived stock (`stockUnitsRemaining` / `stockDosesRemaining`)
 * straight from the `GET /api/medications` list payload. The add / adjust /
 * delete supply mutations used to invalidate only the per-medication
 * inventory query, leaving the list query (`queryKeys.medications()`)
 * serving the pre-write stock — so the card kept showing the old supply
 * until an unrelated refetch landed.
 *
 * `invalidateSupplyQueries` is the single helper all three mutations call;
 * this pins that it drops BOTH the list key (the card / table source) and
 * the per-medication inventory key. The repo's component-test convention
 * avoids `@testing-library/react` DOM interaction, so the mutation's
 * invalidation contract is asserted through the extracted helper against a
 * minimal QueryClient stand-in.
 */

import { describe, expect, it, vi } from "vitest";

import { invalidateSupplyQueries } from "@/components/medications/sections/inventory-section";
import { queryKeys } from "@/lib/query-keys";

describe("invalidateSupplyQueries — supply staleness regression", () => {
  it("invalidates the medications LIST key AND the per-medication inventory key", async () => {
    const invalidateQueries = vi.fn().mockResolvedValue(undefined);
    const queryClient = { invalidateQueries } as unknown as Parameters<
      typeof invalidateSupplyQueries
    >[0];

    await invalidateSupplyQueries(queryClient, "med-1");

    const invalidatedKeys = invalidateQueries.mock.calls.map((call) =>
      JSON.stringify((call[0] as { queryKey: unknown }).queryKey),
    );

    // The card / table source — the regression was this key being absent.
    expect(invalidatedKeys).toContain(JSON.stringify(queryKeys.medications()));
    // The per-medication supply tab still refetches too.
    expect(invalidatedKeys).toContain(
      JSON.stringify(queryKeys.medicationInventory("med-1")),
    );
  });
});
