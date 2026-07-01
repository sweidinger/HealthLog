/**
 * v1.11.0 — clinician-view presentation (Epic C, C5).
 *
 * A pure server component: it receives an already-resolved, owner-scoped
 * {@link DoctorReportData} plus a server-side translator and renders a
 * read-only clinical summary. NO client hooks, NO session, NO AI/coach, NO
 * markdown — every value renders as escaped React text.
 *
 * Layout: provenance header → clinical vitals/labs → medications + adherence →
 * a FENCED, muted wellness card carrying the load-bearing "descriptive, not a
 * clinical assessment / not a diagnosis" disclaimer.
 */
import { DOCTOR_REPORT_TYPE_LABEL_KEYS } from "@/lib/doctor-report/type-label-keys";
import type { DoctorReportData } from "@/lib/doctor-report-data";
import type { DoctorReportPrefs } from "@/lib/validations/doctor-report-prefs";

type Translate = (
  key: string,
  vars?: Record<string, string | number>,
) => string;

interface ClinicianViewProps {
  t: Translate;
  /** Owner-set label for the share (e.g. a clinic note). */
  label: string;
  /** ISO expiry instant — surfaced so the clinician knows the link lifetime. */
  expiresAt: string;
  report: DoctorReportData;
  sections: DoctorReportPrefs;
}

/** Human-readable display per persisted wellness-score type (i18n key suffix). */
const WELLNESS_KEY: Record<string, string> = {
  RECOVERY_SCORE: "recovery",
  STRESS_SCORE: "stress",
  STRAIN_SCORE: "strain",
};

/**
 * Localised label for a measurement-type enum, reusing the doctor-report type
 * key map so the clinician view reads in the viewer's locale alongside the rest
 * of the page. A type with no key falls back to a humanised enum form
 * (`BLOOD_PRESSURE_SYS` → "Blood pressure sys").
 */
function typeLabel(type: string, t: Translate): string {
  const key = DOCTOR_REPORT_TYPE_LABEL_KEYS[type];
  if (key) return t(key);
  const lower = type.replace(/_/g, " ").toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/** Render a single labelled stat row. */
function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-border/40 flex items-baseline justify-between gap-4 border-b py-2 last:border-0">
      <span className="text-muted-foreground text-sm">{label}</span>
      <span className="text-sm font-medium tabular-nums">{value}</span>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-border bg-card rounded-lg border p-5">
      <h2 className="mb-3 text-base font-semibold">{title}</h2>
      {children}
    </section>
  );
}

export function ClinicianView({
  t,
  label,
  expiresAt,
  report,
  sections,
}: ClinicianViewProps) {
  const fmtDate = (iso: string) => new Date(iso).toLocaleDateString();
  const fmtNum = (n: number) => Math.round(n * 100) / 100;

  // Measurement series with at least one stat, mapped to their stats row.
  const measurementEntries = Object.entries(report.stats).filter(
    ([, s]) => s.count > 0,
  );
  const glucoseEntries = Object.entries(report.glucoseStats).filter(
    ([, s]) => s.count > 0,
  );
  const complianceEntries = sections.compliance
    ? Object.entries(report.compliance).filter(([, c]) => c.total > 0)
    : [];
  const wellness = report.wellnessScores?.filter((s) => s.count > 0) ?? [];

  return (
    <main
      id="main-content"
      className="mx-auto min-h-dvh w-full max-w-3xl px-4 py-8"
    >
      {/* ── Provenance header ───────────────────────────────────────── */}
      <header className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">
          {t("clinicianView.title")}
        </h1>
        {label ? (
          <p className="text-muted-foreground mt-1 text-sm">{label}</p>
        ) : null}
        <p className="text-muted-foreground mt-3 text-sm">
          {t("clinicianView.period", {
            start: fmtDate(report.period.start),
            end: fmtDate(report.period.end),
          })}
        </p>
        <p className="text-muted-foreground mt-1 text-xs">
          {t("clinicianView.expires", { date: fmtDate(expiresAt) })}
        </p>
        <p className="border-border bg-muted/40 text-muted-foreground mt-3 rounded-md border p-3 text-xs">
          {t("clinicianView.provenance")}
        </p>
      </header>

      <div className="space-y-5">
        {/* ── Clinical vitals ─────────────────────────────────────── */}
        {measurementEntries.length > 0 ? (
          <Section title={t("clinicianView.vitals")}>
            {measurementEntries.map(([type, s]) => (
              <StatRow
                key={type}
                label={typeLabel(type, t)}
                value={t("clinicianView.statSummary", {
                  latest: fmtNum(s.latest),
                  avg: fmtNum(s.avg),
                  min: fmtNum(s.min),
                  max: fmtNum(s.max),
                })}
              />
            ))}
            {report.bmi !== null && report.bmi !== undefined && sections.bmi ? (
              <StatRow
                label={t("clinicianView.bmi")}
                value={String(fmtNum(report.bmi))}
              />
            ) : null}
          </Section>
        ) : null}

        {/* ── Labs (glucose) ──────────────────────────────────────── */}
        {glucoseEntries.length > 0 ? (
          <Section title={t("clinicianView.labs")}>
            {glucoseEntries.map(([ctx, s]) => (
              <StatRow
                key={ctx}
                label={t(`clinicianView.glucose.${ctx}`)}
                value={t("clinicianView.statSummary", {
                  latest: fmtNum(s.latest),
                  avg: fmtNum(s.avg),
                  min: fmtNum(s.min),
                  max: fmtNum(s.max),
                })}
              />
            ))}
          </Section>
        ) : null}

        {/* ── Medications + adherence ─────────────────────────────── */}
        {report.medications.length > 0 ? (
          <Section title={t("clinicianView.medications")}>
            {report.medications.map((med) => {
              const comp = report.compliance[med.name];
              const rate =
                sections.compliance && comp && comp.total > 0
                  ? `${Math.round((comp.taken / comp.total) * 100)}%`
                  : null;
              return (
                <StatRow
                  key={med.name}
                  label={med.dose ? `${med.name} — ${med.dose}` : med.name}
                  value={
                    rate
                      ? t("clinicianView.adherence", { rate })
                      : t("clinicianView.noAdherence")
                  }
                />
              );
            })}
            {complianceEntries
              .filter(
                ([name]) => !report.medications.some((m) => m.name === name),
              )
              .map(([name, c]) => (
                <StatRow
                  key={name}
                  label={name}
                  value={t("clinicianView.adherence", {
                    rate: `${Math.round((c.taken / c.total) * 100)}%`,
                  })}
                />
              ))}
          </Section>
        ) : null}

        {/* ── Fenced wellness card (descriptive, NOT clinical) ────── */}
        {wellness.length > 0 ? (
          <section className="border-warning/50 bg-warning/5 rounded-lg border border-dashed p-5">
            <h2 className="text-muted-foreground mb-1 text-base font-semibold">
              {t("clinicianView.wellness.title")}
            </h2>
            <p className="text-muted-foreground mb-3 text-xs">
              {t("clinicianView.wellness.disclaimer")}
            </p>
            <div>
              {wellness.map((s) => (
                <StatRow
                  key={s.type}
                  label={t(
                    `clinicianView.wellness.${WELLNESS_KEY[s.type] ?? "score"}`,
                  )}
                  value={t("clinicianView.statSummary", {
                    latest: fmtNum(s.latest),
                    avg: fmtNum(s.avg),
                    min: fmtNum(s.min),
                    max: fmtNum(s.max),
                  })}
                />
              ))}
            </div>
          </section>
        ) : null}
      </div>

      <footer className="border-border text-muted-foreground mt-8 border-t pt-4 text-center text-xs">
        {t("clinicianView.footer")}
      </footer>
    </main>
  );
}
