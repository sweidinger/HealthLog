import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QueryClient } from "@tanstack/react-query";

import { toast } from "sonner";
import {
  runRecordIntake,
  runUndoIntake,
} from "@/components/medications/use-medication-intake";

/**
 * v1.12.2 — the shared intake orchestration consumed by both the generic
 * `<MedicationCard>` and the `<Glp1MedicationCard>`. The two cards used to
 * inline their own `recordIntake`, and the GLP-1 copy never gained the
 * v1.11.3 failure-toast (C1) or the Undo action (C2): a failed POST was
 * swallowed silently and the success toast had no Undo.
 *
 * Because both cards now call the same `runRecordIntake`, these tests
 * proving C1 + C2 fire on the shared path are the proof that the GLP-1 card
 * behaves identically to the generic one — there is no second copy left to
 * diverge.
 *
 * The repo has no `@testing-library/react` / `renderHook`, so the pure
 * `run*` helpers take their dependencies (translator, query client) injected
 * and `fetch` / `toast` are module-mocked.
 */

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const t = (key: string, params?: Record<string, string | number>) =>
  params?.name ? `${key}:${params.name}` : key;

function fakeQueryClient(): QueryClient {
  return {
    invalidateQueries: vi.fn().mockResolvedValue(undefined),
  } as unknown as QueryClient;
}

const medication = { id: "med-1", name: "Mounjaro" };

beforeEach(() => {
  vi.restoreAllMocks();
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("runRecordIntake — shared C1 failure toast + C2 Undo", () => {
  it("surfaces the failure toast and never the success toast on a non-ok POST", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, json: vi.fn() }),
    );
    const setIntakeLoading = vi.fn();
    const queryClient = fakeQueryClient();
    const onRecorded = vi.fn();

    await runRecordIntake({
      medication,
      skipped: false,
      t,
      queryClient,
      setIntakeLoading,
      undoIntake: vi.fn(),
      onRecorded,
    });

    // C1 — the failed POST surfaces the failure toast (with the med name),
    // and the success path never fires.
    expect(toast.error).toHaveBeenCalledWith(
      "medications.intakeToastFailed:Mounjaro",
    );
    expect(toast.success).not.toHaveBeenCalled();
    // No follow-up (no injection-site prompt) on a failed record.
    expect(onRecorded).not.toHaveBeenCalled();
    // The spinner is always cleared.
    expect(setIntakeLoading).toHaveBeenLastCalledWith(null);
  });

  it("surfaces the failure toast when the POST throws (network error)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const setIntakeLoading = vi.fn();

    await runRecordIntake({
      medication,
      skipped: true,
      t,
      queryClient: fakeQueryClient(),
      setIntakeLoading,
      undoIntake: vi.fn(),
    });

    expect(toast.error).toHaveBeenCalledWith(
      "medications.intakeToastFailed:Mounjaro",
    );
    expect(toast.success).not.toHaveBeenCalled();
    expect(setIntakeLoading).toHaveBeenLastCalledWith(null);
  });

  it("shows a success toast carrying an Undo action whose onClick reverses the dose", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({ data: { id: "evt-99" } }),
      }),
    );
    const undoIntake = vi.fn();
    const onRecorded = vi.fn();

    await runRecordIntake({
      medication,
      skipped: false,
      t,
      queryClient: fakeQueryClient(),
      setIntakeLoading: vi.fn(),
      undoIntake,
      onRecorded,
    });

    // C2 — the success toast carries an Undo action.
    expect(toast.success).toHaveBeenCalledTimes(1);
    const [message, opts] = vi.mocked(toast.success).mock.calls[0];
    expect(message).toBe("medications.intakeToastTaken:Mounjaro");
    const action = opts?.action as
      | { label: string; onClick: (e: never) => void }
      | undefined;
    expect(action?.label).toBe("medications.intakeUndo");

    // Firing the action calls undoIntake with the just-created event id.
    action?.onClick({} as never);
    expect(undoIntake).toHaveBeenCalledWith("evt-99");

    // The post-success follow-up receives the event id + skipped flag.
    expect(onRecorded).toHaveBeenCalledWith("evt-99", false);
  });

  it("omits the Undo action when the POST body carries no event id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({ data: {} }),
      }),
    );

    await runRecordIntake({
      medication,
      skipped: false,
      t,
      queryClient: fakeQueryClient(),
      setIntakeLoading: vi.fn(),
      undoIntake: vi.fn(),
    });

    const [, opts] = vi.mocked(toast.success).mock.calls[0];
    expect(opts).toBeUndefined();
  });
});

describe("runUndoIntake — shared soft-delete", () => {
  it("reverts via DELETE and confirms on success", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    const queryClient = fakeQueryClient();

    await runUndoIntake({ medication, eventId: "evt-1", t, queryClient });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/medications/med-1/intake/evt-1",
      { method: "DELETE" },
    );
    expect(toast.success).toHaveBeenCalledWith("medications.intakeUndone");
    expect(queryClient.invalidateQueries).toHaveBeenCalled();
  });

  it("surfaces the undo-failure toast on a non-ok DELETE", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));

    await runUndoIntake({
      medication,
      eventId: "evt-1",
      t,
      queryClient: fakeQueryClient(),
    });

    expect(toast.error).toHaveBeenCalledWith("medications.intakeUndoFailed");
    expect(toast.success).not.toHaveBeenCalled();
  });
});
