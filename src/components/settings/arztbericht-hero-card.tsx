"use client";

/**
 * Settings → Export Arztbericht (doctor-report) card.
 *
 * The doctor-report PDF is the artefact a user carries into a doctor's
 * appointment. v1.4.37 W7a promoted it to the page hero; v1.12 demotes
 * it back to a small secondary card at the bottom of the export page —
 * the health-record export now owns the page hero. The card is fully
 * functional: the CTA routes through the existing `<DoctorReportDialog>`
 * + `/api/doctor-report` flow exactly as before. Only the framing and
 * visual weight changed.
 *
 * Layout (compact card, no hero gradient):
 *
 *   ┌─ card ────────────────────────────────────────────┐
 *   │  [icon] H2 title          eyebrow                 │
 *   │  one-line value statement                         │
 *   │  [Configure & generate]  PDF · printable          │
 *   └───────────────────────────────────────────────────┘
 *
 * a11y:
 *   - The CTA button clears the 44 px touch floor (`min-h-11`).
 *   - `focus-visible:ring` ships via the default `<Button>` variant.
 *   - The CTA is `aria-describedby={valueStatementId}` so a screen
 *     reader announces the value statement alongside the action.
 *   - The card's `<h2>` slots beneath the page-level `<h1>`.
 */

import { useEffect, useId, useState } from "react";
import { Loader2, Stethoscope } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DoctorReportDialog,
  type DoctorReportSubmitPayload,
} from "@/components/doctor-report/doctor-report-dialog";
import { useTranslations } from "@/lib/i18n/context";

export function ArztberichtHeroCard() {
  const { t, locale } = useTranslations();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [defaultPracticeName, setDefaultPracticeName] = useState<string | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const valueStatementId = useId();

  // Pre-fill the practice name from the user profile so the dialog opens
  // ready-to-submit. Best-effort: if the request fails, the dialog still
  // works without a pre-fill — mirrors the legacy `<DoctorReportCard>`.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/me", { credentials: "include" })
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        if (cancelled || !json) return;
        const name = json?.data?.lastReportPracticeName;
        if (typeof name === "string") setDefaultPracticeName(name);
      })
      .catch(() => {
        // ignore — pre-fill is a UX nicety
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSubmit(payload: DoctorReportSubmitPayload) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/doctor-report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          startDate: payload.startDate,
          endDate: payload.endDate,
          practiceName: payload.practiceName,
          sections: payload.sections,
        }),
      });
      if (!res.ok) {
        setError(`${res.status}`);
        return;
      }
      const json = await res.json();
      const { generateDoctorReportPDF } =
        await import("@/lib/doctor-report-pdf");
      const doc = generateDoctorReportPDF(json.data, { t, locale });
      const fileSlug = locale === "de" ? "gesundheitsbericht" : "health-report";
      doc.save(`${fileSlug}-${new Date().toISOString().slice(0, 10)}.pdf`);
      if (payload.practiceName) setDefaultPracticeName(payload.practiceName);
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      data-testid="export-hero-doctor-report"
      aria-labelledby="export-hero-doctor-report-title"
      className="bg-card border-border rounded-xl border p-5 sm:p-6"
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Stethoscope
                className="text-muted-foreground h-5 w-5 shrink-0"
                aria-hidden="true"
              />
              <h2
                id="export-hero-doctor-report-title"
                className="text-base font-semibold tracking-tight"
              >
                {t("settings.sections.export.cards.doctorReport.title")}
              </h2>
            </div>
            <span className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
              {t("settings.sections.export.hero.eyebrow")}
            </span>
          </div>
          <p
            id={valueStatementId}
            data-testid="export-hero-doctor-report-value"
            className="text-muted-foreground max-w-2xl text-xs leading-relaxed"
          >
            {t("settings.sections.export.hero.valueStatement")}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button
            data-testid="export-hero-doctor-report-action"
            variant="outline"
            size="sm"
            // `min-h-11` (44 px) is the WCAG 2.5.5 touch-target floor;
            // we keep it on mobile and fall back to the compact
            // `sm:min-h-9` on pointer devices so a future className
            // override can't re-lift the mobile minimum below the
            // touch-target contract.
            className="min-h-11 sm:min-h-9"
            onClick={() => setOpen(true)}
            disabled={busy}
            aria-describedby={valueStatementId}
          >
            {busy && (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
            )}
            {t("settings.sections.export.hero.cta")}
          </Button>
          <span className="text-muted-foreground text-xs">
            {t("settings.sections.export.hero.formatHint")}
          </span>
        </div>

        {error && (
          <p role="alert" className="text-destructive text-xs">
            {error}
          </p>
        )}
      </div>

      <DoctorReportDialog
        open={open}
        onOpenChange={setOpen}
        defaultPracticeName={defaultPracticeName}
        onSubmit={handleSubmit}
      />
    </section>
  );
}
