"use client";

/**
 * Doctor-report export dialog (v1.4.15 phase B6).
 *
 * Wraps the trigger button so the user picks a reporting period and
 * (optionally) a practice / clinic name before the PDF is generated.
 *
 * Defaults:
 *   - end   = today
 *   - start = today − 90 days
 *
 * Validation runs in the client so the dialog can show inline errors
 * without bouncing through the server. The server still re-validates via
 * `normaliseDateRange()` (silent fallback to last-90-days) — the client
 * messages are UX, not security.
 */

import { useMemo, useState } from "react";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { DateInput } from "@/components/ui/date-input";
import { Label } from "@/components/ui/label";
import { useTranslations } from "@/lib/i18n/context";

const ONE_DAY_MS = 86_400_000;
const MAX_RANGE_DAYS = 730;
const PRACTICE_NAME_MAX_LENGTH = 120;

export interface DoctorReportSubmitPayload {
  startDate: string;
  endDate: string;
  practiceName: string | null;
}

interface DoctorReportDialogProps {
  /** Controlled open state. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Last-used practice name from `/api/auth/me`; pre-fills the input. */
  defaultPracticeName?: string | null;
  /**
   * Resolves with the user-confirmed payload. The dialog stays open and
   * shows the spinner while the promise is pending; closes on resolve.
   */
  onSubmit: (payload: DoctorReportSubmitPayload) => Promise<void>;
}

/** YYYY-MM-DD in the user's local timezone. */
function todayIso(): string {
  const now = new Date();
  return formatLocalDate(now);
}

function formatLocalDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function defaultStartIso(): string {
  const d = new Date();
  d.setDate(d.getDate() - 90);
  return formatLocalDate(d);
}

export function DoctorReportDialog({
  open,
  onOpenChange,
  defaultPracticeName,
  onSubmit,
}: DoctorReportDialogProps) {
  const { t } = useTranslations();
  const [startDate, setStartDate] = useState<string>(defaultStartIso);
  const [endDate, setEndDate] = useState<string>(todayIso);
  const [practiceName, setPracticeName] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset on open: re-anchor dates + practice-name to defaults each time
  // the dialog appears so a follow-up export doesn't reuse the previous
  // custom range. Using the React-recommended "track-the-trigger" pattern
  // (store the last observed `open` state and react during render) so the
  // reset happens in the render phase rather than a setState-in-effect —
  // satisfies the strict `react-hooks/set-state-in-effect` rule.
  const [lastOpen, setLastOpen] = useState(false);
  if (open && !lastOpen) {
    setLastOpen(true);
    setStartDate(defaultStartIso());
    setEndDate(todayIso());
    setPracticeName(defaultPracticeName ?? "");
    setError(null);
    setSubmitting(false);
  } else if (!open && lastOpen) {
    setLastOpen(false);
  }

  const validation = useMemo(() => {
    if (!startDate || !endDate) {
      return {
        ok: false as const,
        key: "doctorReport.dialog.errorInvalidDate",
      };
    }
    const start = new Date(startDate);
    const end = new Date(endDate);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      return {
        ok: false as const,
        key: "doctorReport.dialog.errorInvalidDate",
      };
    }
    if (end.getTime() < start.getTime()) {
      return {
        ok: false as const,
        key: "doctorReport.dialog.errorEndBeforeStart",
      };
    }
    const spanDays = Math.ceil((end.getTime() - start.getTime()) / ONE_DAY_MS);
    if (spanDays > MAX_RANGE_DAYS) {
      return {
        ok: false as const,
        key: "doctorReport.dialog.errorRangeTooLong",
      };
    }
    return { ok: true as const };
  }, [startDate, endDate]);

  function applyPreset(days: number) {
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - days);
    setStartDate(formatLocalDate(start));
    setEndDate(formatLocalDate(end));
    setError(null);
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!validation.ok) {
      setError(t(validation.key));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      // Send dates as ISO timestamps anchored to the local day's
      // start/end so an inclusive range `[YYYY-MM-DD, YYYY-MM-DD]`
      // captures everything logged on each boundary day.
      const startIso = new Date(`${startDate}T00:00:00`).toISOString();
      const endIso = new Date(`${endDate}T23:59:59.999`).toISOString();
      const trimmedPractice = practiceName.trim();
      await onSubmit({
        startDate: startIso,
        endDate: endIso,
        practiceName:
          trimmedPractice.length > 0
            ? trimmedPractice.slice(0, PRACTICE_NAME_MAX_LENGTH)
            : null,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("doctorReport.dialog.title")}</DialogTitle>
          <DialogDescription>
            {t("doctorReport.dialog.description")}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="dr-start">
                {t("doctorReport.dialog.startLabel")}
              </Label>
              <DateInput
                id="dr-start"
                value={startDate}
                max={endDate || todayIso()}
                onChange={(e) => {
                  setStartDate(e.target.value);
                  setError(null);
                }}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="dr-end">
                {t("doctorReport.dialog.endLabel")}
              </Label>
              <DateInput
                id="dr-end"
                value={endDate}
                min={startDate}
                max={todayIso()}
                onChange={(e) => {
                  setEndDate(e.target.value);
                  setError(null);
                }}
                required
              />
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => applyPreset(90)}
            >
              {t("doctorReport.dialog.preset90d")}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => applyPreset(180)}
            >
              {t("doctorReport.dialog.preset180d")}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => applyPreset(365)}
            >
              {t("doctorReport.dialog.preset365d")}
            </Button>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="dr-practice">
              {t("doctorReport.dialog.practiceLabel")}
            </Label>
            <Input
              id="dr-practice"
              type="text"
              value={practiceName}
              maxLength={PRACTICE_NAME_MAX_LENGTH}
              placeholder={t("doctorReport.dialog.practicePlaceholder")}
              onChange={(e) => setPracticeName(e.target.value)}
              autoComplete="organization"
            />
          </div>

          {error && (
            <p
              role="alert"
              className="text-destructive text-sm"
              data-testid="doctor-report-dialog-error"
            >
              {error}
            </p>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              {t("doctorReport.dialog.cancel")}
            </Button>
            <Button type="submit" disabled={submitting || !validation.ok}>
              {submitting && (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              )}
              {t("doctorReport.dialog.submit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
