"use client";

import { useState } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { useTranslations } from "@/lib/i18n/context";
import { invalidateKeys, medicationDependentKeys } from "@/lib/query-keys";

type Translator = (
  key: string,
  params?: Record<string, string | number>,
) => string;

interface MedicationIntakeIdentity {
  id: string;
  name: string;
}

/**
 * v1.12.2 — the take / skip + Undo intake orchestration shared by the
 * generic {@link MedicationCard} and the {@link Glp1MedicationCard}.
 *
 * Both cards used to inline their own `recordIntake`, and the two copies
 * drifted: the generic card gained the v1.11.3 failure-toast (C1) and the
 * Undo action (C2) while the GLP-1 card silently swallowed a failed POST
 * and offered no Undo — same "Taken" button, two behaviours. Lifting the
 * logic here makes the two cards behave identically by construction.
 *
 * The hook owns: the in-flight loading key, the intake POST, the failure
 * toast, the success toast carrying an Undo action, the soft-delete undo
 * route, and the dependent-key invalidation. Each card keeps its own
 * post-success hook (`onRecorded`) for card-specific follow-ups — today
 * the optional injection-site prompt.
 */
interface UseMedicationIntakeParams {
  medication: MedicationIntakeIdentity;
  /**
   * Card-specific follow-up after a successful record. Receives the
   * created event's id (when the POST body carried one) and whether the
   * dose was skipped. Used by the cards to open the injection-site prompt
   * on a taken dose. The intake itself is already recorded + invalidated
   * by the time this fires.
   */
  onRecorded?: (eventId: string | undefined, skipped: boolean) => void;
}

interface UseMedicationIntakeResult {
  /** "take" | "skip" while the matching request is in flight, else null. */
  intakeLoading: string | null;
  /**
   * Record a take (skipped=false) or skip (skipped=true). The optional
   * `scheduledFor` is the slot instant of the dose the card is displaying;
   * when supplied the server marks THAT slot instead of snapping "now" to
   * the nearest one (v1.12.3). Omit it (or pass null) for an unscheduled /
   * PRN dose to keep the legacy now-snap path.
   */
  recordIntake: (skipped: boolean, scheduledFor?: Date | null) => Promise<void>;
  /** Reverse a just-recorded intake via the soft-delete route. */
  undoIntake: (eventId: string) => Promise<void>;
}

/**
 * Pure orchestration for a single intake record, with every dependency
 * injected so it is unit-testable without a React render (the repo has no
 * `renderHook`; the convention is SSR markup + direct invocation). The
 * hook below is a thin wrapper that binds the real `fetch` / `toast` /
 * translator / query client.
 */
export async function runRecordIntake(deps: {
  medication: MedicationIntakeIdentity;
  skipped: boolean;
  /**
   * v1.12.3 — slot instant of the dose the card is showing. Threaded onto
   * the POST so the server marks the displayed dose deterministically
   * instead of snapping "now" to the nearest slot (a morning tap on a
   * 07:00 / 19:00 med no longer mis-records the 07:00 dose). `null` /
   * undefined keeps the legacy now-snap (unscheduled / PRN doses).
   */
  scheduledFor?: Date | null;
  t: Translator;
  queryClient: QueryClient;
  setIntakeLoading: (value: string | null) => void;
  undoIntake: (eventId: string) => void | Promise<void>;
  onRecorded?: (eventId: string | undefined, skipped: boolean) => void;
}): Promise<void> {
  const {
    medication,
    skipped,
    scheduledFor,
    t,
    queryClient,
    setIntakeLoading,
    undoIntake,
    onRecorded,
  } = deps;

  setIntakeLoading(skipped ? "skip" : "take");
  try {
    const res = await fetch(`/api/medications/${medication.id}/intake`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // The route's Zod schema accepts an ISO `scheduledFor`; the server
      // snaps it to the canonical slot. Only send it when the card
      // identified the displayed dose's slot — otherwise omit so the
      // PRN / unscheduled now-snap path is preserved.
      body: JSON.stringify(
        scheduledFor
          ? { skipped, scheduledFor: scheduledFor.toISOString() }
          : { skipped },
      ),
    });
    // v1.11.3 C1 — a failed POST used to clear the spinner silently, so the
    // user believed the dose was logged when it was not. Surface the failure
    // and never show the success confirmation in that case. (The GLP-1 card
    // missed this port until v1.12.2 lifted the logic here.)
    if (!res.ok) {
      toast.error(t("medications.intakeToastFailed", { name: medication.name }));
      return;
    }
    // The POST returns the created event (`apiSuccess(event, 201)`); its id
    // drives both the Undo affordance and the card's post-success hook
    // (the optional injection-site prompt).
    let eventId: string | undefined;
    try {
      const json = await res.json();
      eventId = json?.data?.id as string | undefined;
    } catch {
      /* dose recorded; the body is best-effort for the id */
    }
    // v1.11.3 C2 — the success toast carries an Undo action so a misclicked
    // take / skip no longer needs a history dive to correct.
    toast.success(
      t(
        skipped
          ? "medications.intakeToastSkipped"
          : "medications.intakeToastTaken",
        { name: medication.name },
      ),
      eventId
        ? {
            action: {
              label: t("medications.intakeUndo"),
              onClick: () => void undoIntake(eventId),
            },
          }
        : undefined,
    );
    await invalidateKeys(queryClient, medicationDependentKeys);
    onRecorded?.(eventId, skipped);
  } catch {
    toast.error(t("medications.intakeToastFailed", { name: medication.name }));
  } finally {
    setIntakeLoading(null);
  }
}

/**
 * Pure soft-delete undo for a just-recorded intake, dependencies injected
 * for the same testability reason as {@link runRecordIntake}.
 */
export async function runUndoIntake(deps: {
  medication: MedicationIntakeIdentity;
  eventId: string;
  t: Translator;
  queryClient: QueryClient;
}): Promise<void> {
  const { medication, eventId, t, queryClient } = deps;
  try {
    const res = await fetch(
      `/api/medications/${medication.id}/intake/${eventId}`,
      { method: "DELETE" },
    );
    if (!res.ok) {
      toast.error(t("medications.intakeUndoFailed"));
      return;
    }
    await invalidateKeys(queryClient, medicationDependentKeys);
    toast.success(t("medications.intakeUndone"));
  } catch {
    toast.error(t("medications.intakeUndoFailed"));
  }
}

export function useMedicationIntake({
  medication,
  onRecorded,
}: UseMedicationIntakeParams): UseMedicationIntakeResult {
  const queryClient = useQueryClient();
  const { t } = useTranslations();
  const [intakeLoading, setIntakeLoading] = useState<string | null>(null);

  const undoIntake = (eventId: string) =>
    runUndoIntake({ medication, eventId, t, queryClient });

  const recordIntake = (skipped: boolean, scheduledFor?: Date | null) =>
    runRecordIntake({
      medication,
      skipped,
      scheduledFor,
      t,
      queryClient,
      setIntakeLoading,
      undoIntake,
      onRecorded,
    });

  return { intakeLoading, recordIntake, undoIntake };
}
