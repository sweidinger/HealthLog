"use client";

/**
 * v1.25 (W-RECORDS) — Settings → Anamnese (medical history).
 *
 * The home for the structured health records: allergies / intolerances and
 * family history. Each is a self-contained CRUD manager rendered in its own
 * card. These are patient-reported reference records — not a time-series
 * signal and not a clinical diagnosis — surfaced alongside the existing
 * tracking-domain settings sections (Labs / Illness / Vorsorge).
 *
 * v1.25.12 — the section is the single home for the pre-existing / chronic
 * conditions the Coach watches, edited inline here so conditions + allergies +
 * family history read (and write) as one coherent medical history. The
 * conditions card is coach-gated (the data only feeds the Coach); it reads and
 * writes the same self-context store (`/api/coach/about-me`) the rest of the app
 * uses — the placement simply moved out of personal context into the medical
 * record where it belongs.
 */

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useTranslations } from "@/lib/i18n/context";
import { useModuleEnabled } from "@/hooks/use-module-enabled";

import { AllergyManager } from "@/components/records/allergy-manager";
import { ConditionsManager } from "@/components/records/conditions-manager";
import { FamilyHistoryManager } from "@/components/records/family-history-manager";

export function AnamnesisSection() {
  const { t } = useTranslations();
  const coachEnabled = useModuleEnabled("coach");
  return (
    <div className="space-y-6">
      {coachEnabled && (
        <Card>
          <CardHeader>
            <CardTitle>{t("records.conditions.cardTitle")}</CardTitle>
            <CardDescription>
              {t("records.conditions.cardDescription")}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ConditionsManager />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{t("records.allergies.cardTitle")}</CardTitle>
          <CardDescription>
            {t("records.allergies.cardDescription")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <AllergyManager />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("records.family.cardTitle")}</CardTitle>
          <CardDescription>
            {t("records.family.cardDescription")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FamilyHistoryManager />
        </CardContent>
      </Card>

      <p className="text-muted-foreground text-xs">{t("records.disclaimer")}</p>
    </div>
  );
}
