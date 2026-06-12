/**
 * v1.16.10 — toggle / reorder persistence wiring for the medications
 * list presentation. Pins the PUT payload shape (field-scoped, version
 * 1), the optimistic cache flip + rollback-on-failure for the view
 * toggle, and the cache update on a saved order — without a React
 * render, via the dependency-injected `run*` orchestration functions
 * (the `use-medication-intake` testing convention).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";

vi.mock("@/lib/api/api-fetch", () => ({
  apiGet: vi.fn(),
  apiPut: vi.fn(),
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { apiPut } from "@/lib/api/api-fetch";
import { toast } from "sonner";
import {
  runSetMedicationListView,
  runSaveMedicationListOrder,
} from "@/lib/queries/use-medication-list-layout";
import { queryKeys } from "@/lib/query-keys";
import type { MedicationListLayout } from "@/lib/medication-list-layout";

const t = (key: string) => key;

function makeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("runSetMedicationListView", () => {
  it("PUTs the field-scoped body and lands the server echo in the cache", async () => {
    const queryClient = makeClient();
    queryClient.setQueryData<MedicationListLayout>(
      queryKeys.medicationListLayout(),
      { version: 1, view: "cards", order: ["med-a"] },
    );
    const saved: MedicationListLayout = {
      version: 1,
      view: "table",
      order: ["med-a"],
    };
    vi.mocked(apiPut).mockResolvedValue(saved as never);

    await runSetMedicationListView({ view: "table", queryClient, t });

    // Field-scoped: only `view` rides the body — the server preserves
    // the stored order (preserve-when-absent), so the client must not
    // resend (and thereby race) it.
    expect(apiPut).toHaveBeenCalledWith("/api/medications/layout", {
      version: 1,
      view: "table",
    });
    expect(
      queryClient.getQueryData(queryKeys.medicationListLayout()),
    ).toEqual(saved);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("flips the cache optimistically before the PUT resolves", async () => {
    const queryClient = makeClient();
    queryClient.setQueryData<MedicationListLayout>(
      queryKeys.medicationListLayout(),
      { version: 1, view: "cards", order: [] },
    );
    let observedDuringFlight: MedicationListLayout | undefined;
    vi.mocked(apiPut).mockImplementation((async () => {
      observedDuringFlight = queryClient.getQueryData(
        queryKeys.medicationListLayout(),
      );
      return { version: 1, view: "table", order: [] };
    }) as never);

    await runSetMedicationListView({ view: "table", queryClient, t });

    expect(observedDuringFlight?.view).toBe("table");
  });

  it("rolls the cache back and surfaces a toast when the PUT fails", async () => {
    const queryClient = makeClient();
    const previous: MedicationListLayout = {
      version: 1,
      view: "cards",
      order: ["med-a"],
    };
    queryClient.setQueryData(queryKeys.medicationListLayout(), previous);
    vi.mocked(apiPut).mockRejectedValue(new Error("boom"));

    await runSetMedicationListView({ view: "table", queryClient, t });

    expect(
      queryClient.getQueryData(queryKeys.medicationListLayout()),
    ).toEqual(previous);
    expect(toast.error).toHaveBeenCalledWith("medications.viewSaveFailed");
  });
});

describe("runSaveMedicationListOrder", () => {
  it("PUTs the order-only body, caches the echo, and reports success", async () => {
    const queryClient = makeClient();
    const saved: MedicationListLayout = {
      version: 1,
      view: "table",
      order: ["med-b", "med-a"],
    };
    vi.mocked(apiPut).mockResolvedValue(saved as never);

    const ok = await runSaveMedicationListOrder({
      order: ["med-b", "med-a"],
      queryClient,
      t,
    });

    expect(ok).toBe(true);
    expect(apiPut).toHaveBeenCalledWith("/api/medications/layout", {
      version: 1,
      order: ["med-b", "med-a"],
    });
    expect(
      queryClient.getQueryData(queryKeys.medicationListLayout()),
    ).toEqual(saved);
    expect(toast.success).toHaveBeenCalledWith("medications.reorderSaved");
  });

  it("returns false and surfaces a toast when the PUT fails", async () => {
    const queryClient = makeClient();
    vi.mocked(apiPut).mockRejectedValue(new Error("boom"));

    const ok = await runSaveMedicationListOrder({
      order: ["med-a"],
      queryClient,
      t,
    });

    expect(ok).toBe(false);
    expect(toast.error).toHaveBeenCalledWith(
      "medications.reorderSaveFailed",
    );
  });
});
