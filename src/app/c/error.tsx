"use client";

/**
 * Error boundary for the public clinician share route (`/c/<token>`).
 *
 * The share view carries no app chrome and no session, so a render failure must
 * not fall through to the full-app error screen. This renders a clean, locale-
 * aware, stack-free message and offers a single retry. No record data, no
 * digest, no stack — a probe learns nothing from a failed render.
 */
import { useTranslations } from "@/lib/i18n/context";
import { Button } from "@/components/ui/button";

export default function ClinicianShareError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const { t } = useTranslations();

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4">
      <div className="border-border bg-card space-y-4 rounded-lg border p-6 text-center">
        <h1 className="text-lg font-semibold">
          {t("clinicianView.loadError.title")}
        </h1>
        <p className="text-muted-foreground text-sm">
          {t("clinicianView.loadError.description")}
        </p>
        <Button
          onClick={() => reset()}
          className="min-h-11 w-full sm:min-h-9"
          variant="outline"
        >
          {t("clinicianView.loadError.retry")}
        </Button>
      </div>
    </main>
  );
}
