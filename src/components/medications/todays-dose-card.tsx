"use client";

/**
 * v1.5.5 D-3 §9.2 — Today's-dose card.
 *
 * Two buttons: `[Genommen]` posts a confirmed-taken intake;
 * `[Übersprungen]` posts a skipped one. The wire shape is the one the
 * intake POST already understands:
 *
 *   `{ scheduledFor: <today-iso>, takenAt: <now-iso>, skipped: boolean }`
 *
 * (The C-E2-1 fix dropped the "Verschoben / DEFERRED" third branch that
 * an earlier draft proposed but the schema never carried.)
 *
 * Optimistic update: the moment the request fires, the card flips into
 * read-only `Heute genommen um HH:MM` (or its skipped twin). On error
 * the read-only state rolls back and an inline destructive note
 * surfaces. The polite live region (the parent's `<Toaster>`) carries
 * the toast announcement; this card additionally persists state
 * visibly in the same paint as the toast (E-4 C-1).
 *
 * Paused state: when the medication is inactive both buttons render
 * `aria-disabled` + visually muted with a single helper line.
 *
 * Cache: invalidates the bundle via `medicationDependentKeys` so every
 * downstream tile (inline compliance chart, dashboard rollup tile)
 * picks the new event up in one tick.
 */

import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, Loader2, SkipForward } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useTranslations, useFormatters } from "@/lib/i18n/context";
import { invalidateKeys, medicationDependentKeys } from "@/lib/query-keys";

export interface TodaysDoseCardProps {
  medicationId: string;
  active: boolean;
  oneShot: boolean;
  /**
   * Server-side "due today" decision. The detail page derives it from
   * the medication's cadence + the cached intake list and passes it
   * in so the card stays presentation-only.
   */
  scheduledForToday: boolean;
  /**
   * If the user already logged today's intake, the time the row
   * captured. The card uses it to render the read-only state
   * immediately on mount (rather than waiting for the optimistic
   * branch to populate it).
   */
  alreadyTakenAt?: string | null;
  alreadySkipped?: boolean;
}

type Optimistic =
  | { kind: "idle" }
  | { kind: "submitting"; skipped: boolean }
  | { kind: "done"; at: string; skipped: boolean }
  | { kind: "error"; message: string };

export function TodaysDoseCard({
  medicationId,
  active,
  oneShot,
  scheduledForToday,
  alreadyTakenAt,
  alreadySkipped,
}: TodaysDoseCardProps) {
  const { t } = useTranslations();
  const formatters = useFormatters();
  const queryClient = useQueryClient();

  const initialState: Optimistic = alreadyTakenAt
    ? { kind: "done", at: alreadyTakenAt, skipped: false }
    : alreadySkipped
      ? { kind: "done", at: new Date().toISOString(), skipped: true }
      : { kind: "idle" };

  const [state, setState] = useState<Optimistic>(initialState);

  const liveLabel = useMemo(() => {
    if (state.kind === "done") {
      const timeLabel = formatters.dateTime(state.at);
      if (state.skipped) {
        return t("medications.detail.today.recordedSkipped", {
          time: timeLabel,
        });
      }
      return oneShot
        ? t("medications.detail.today.recordedOneShot", { time: timeLabel })
        : t("medications.detail.today.recordedTaken", { time: timeLabel });
    }
    return null;
  }, [formatters, oneShot, state, t]);

  async function submit(skipped: boolean) {
    if (state.kind === "submitting") return;
    setState({ kind: "submitting", skipped });
    const now = new Date();
    const body = {
      scheduledFor: now.toISOString(),
      takenAt: skipped ? null : now.toISOString(),
      skipped,
    };
    try {
      const res = await fetch(`/api/medications/${medicationId}/intake`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) {
        const message = json.error ?? t("medications.detail.today.error");
        setState({ kind: "error", message });
        return;
      }
      setState({ kind: "done", at: now.toISOString(), skipped });
      await invalidateKeys(queryClient, medicationDependentKeys);
      toast.success(
        skipped
          ? t("medications.detail.today.toastSkipped")
          : t("medications.detail.today.toastTaken"),
      );
    } catch {
      setState({
        kind: "error",
        message: t("medications.detail.today.error"),
      });
    }
  }

  // Paused / inactive state: both buttons sit muted with one helper.
  if (!active) {
    return (
      <Card
        className="p-5 sm:p-6 space-y-4"
        data-slot="todays-dose-card"
        data-state="paused"
      >
        <p
          className="text-muted-foreground text-sm"
          data-slot="todays-dose-paused"
        >
          {t("medications.detail.today.pausedHint")}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            aria-disabled="true"
            tabIndex={-1}
            className="min-h-11 sm:min-h-9 opacity-60"
          >
            <Check aria-hidden="true" className="mr-2 h-4 w-4" />
            {t("medications.detail.today.taken")}
          </Button>
          <Button
            variant="outline"
            aria-disabled="true"
            tabIndex={-1}
            className="min-h-11 sm:min-h-9 opacity-60"
          >
            <SkipForward aria-hidden="true" className="mr-2 h-4 w-4" />
            {t("medications.detail.today.skipped")}
          </Button>
        </div>
      </Card>
    );
  }

  // Read-only post-log state — switches in the same paint as the toast
  // so the user sees the dose persisted without a refresh round-trip.
  if (state.kind === "done") {
    return (
      <Card
        className="p-5 sm:p-6 space-y-2"
        data-slot="todays-dose-card"
        data-state="done"
        role="status"
        aria-live="polite"
      >
        <p className="text-foreground text-sm font-medium">{liveLabel}</p>
      </Card>
    );
  }

  // Empty: nothing scheduled for today (recurring path only).
  if (!scheduledForToday && !oneShot) {
    return (
      <Card
        className="p-5 sm:p-6"
        data-slot="todays-dose-card"
        data-state="empty"
      >
        <p className="text-muted-foreground text-sm">
          {t("medications.detail.today.noneScheduled")}
        </p>
      </Card>
    );
  }

  const submitting = state.kind === "submitting";

  return (
    <Card
      className="p-5 sm:p-6 space-y-4"
      data-slot="todays-dose-card"
      data-state="idle"
    >
      <div
        className="flex flex-wrap gap-2"
        role="group"
        aria-label={t("medications.detail.today.groupLabel")}
      >
        <Button
          onClick={() => void submit(false)}
          disabled={submitting}
          aria-busy={submitting && !state.skipped ? true : undefined}
          className="min-h-11 sm:min-h-9"
          data-slot="todays-dose-taken"
        >
          {submitting && !state.skipped ? (
            <Loader2
              aria-hidden="true"
              className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none"
            />
          ) : (
            <Check aria-hidden="true" className="mr-2 h-4 w-4" />
          )}
          {t("medications.detail.today.taken")}
        </Button>
        <Button
          variant="outline"
          onClick={() => void submit(true)}
          disabled={submitting}
          aria-busy={submitting && state.skipped ? true : undefined}
          className="min-h-11 sm:min-h-9"
          data-slot="todays-dose-skipped"
        >
          {submitting && state.skipped ? (
            <Loader2
              aria-hidden="true"
              className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none"
            />
          ) : (
            <SkipForward aria-hidden="true" className="mr-2 h-4 w-4" />
          )}
          {t("medications.detail.today.skipped")}
        </Button>
      </div>
      {state.kind === "error" && (
        <p
          className="text-destructive text-sm"
          role="alert"
          data-slot="todays-dose-error"
        >
          {state.message}
        </p>
      )}
    </Card>
  );
}
