"use client";

/**
 * v1.25 (W-RECORDS) — Settings → Anamnese (medical history).
 *
 * The home for the structured health records: allergies / intolerances and
 * family history. Each is a self-contained CRUD manager rendered in its own
 * card. These are patient-reported reference records — not a time-series
 * signal and not a clinical diagnosis — surfaced alongside the existing
 * tracking-domain settings sections (Labs / Illness / Vorsorge).
 */

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useTranslations } from "@/lib/i18n/context";

import { AllergyManager } from "@/components/records/allergy-manager";
import { FamilyHistoryManager } from "@/components/records/family-history-manager";

export function AnamnesisSection() {
  const { t } = useTranslations();
  return (
    <div className="space-y-6">
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
