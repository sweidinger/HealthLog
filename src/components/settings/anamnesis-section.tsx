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
 * v1.25.1 — the section also surfaces the pre-existing / chronic conditions the
 * Coach watches (the self-context entered under Profile → "About me") as a
 * read-only shared view, so conditions + allergies + family history read as one
 * coherent medical history. The conditions card is coach-gated (the data only
 * feeds the Coach) and links back to its single editing home in personal
 * context.
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
import { ConditionsOverview } from "@/components/records/conditions-overview";
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
            <ConditionsOverview />
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
