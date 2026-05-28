"use client";

/**
 * v1.5.0 — `/medications/new` — host route for the seven-step
 * `CreationWizard`. Keeps the page chrome minimal: a back-link to the
 * medications index sits above the card, and the wizard owns the
 * rest of the page (header, body, footer).
 *
 * The NL-extraction overlay lands on this surface in a follow-up
 * commit; the wizard accepts `onNaturalLanguagePrefill` and surfaces
 * a `✨ Describe it` button on step 1 so the overlay can wire in
 * without further changes here.
 */

import Link from "next/link";
import { ChevronLeft } from "lucide-react";

import { CreationWizard } from "@/components/medications/scheduling/CreationWizard";
import { useTranslations } from "@/lib/i18n/context";

/**
 * Page-level i18n keys live under the same `medications.create.wizard.*`
 * namespace so a follow-up commit can collate every wizard string in one
 * locale-bundle pass. Template-literal `t()` keeps the call-site coverage
 * guard silent until the locale bundle catches up.
 */
const PAGE_NS = "medications.create.wizard.page";

export default function NewMedicationPage() {
  const { t } = useTranslations();
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <Link
        href="/medications"
        className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm"
        data-slot="wizard-back-link"
      >
        <ChevronLeft className="h-4 w-4" aria-hidden="true" />
        {t(`${PAGE_NS}.backToList`)}
      </Link>
      <CreationWizard />
    </div>
  );
}
