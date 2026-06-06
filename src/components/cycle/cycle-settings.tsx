"use client";

import { useState } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { NativeSelect } from "@/components/ui/native-select";
import { Separator } from "@/components/ui/separator";
import { useTranslations } from "@/lib/i18n/context";
import type { CycleGoal, CycleProfileDTO } from "./types";
import { useUpdateCyclePrefs } from "./use-cycle";

/**
 * v1.15.0 — the single-page cycle settings form.
 *
 * One dynamic form, no top/bottom split (the project's settings-UX rule):
 * the inclusive goal selector drives all copy — fertile-window language only
 * appears for TRYING_TO_CONCEIVE; GENERAL_HEALTH / PERIMENOPAUSE / OFF hide
 * conception framing. Priors, raw-chart mode, sensitive-category encryption,
 * discreet notifications, and the data export/delete affordances all live on
 * the one page. PATCHes `/api/auth/me/cycle-prefs`.
 *
 * The form seeds its local state from `profile` once on mount; the parent
 * passes `key={profile.updatedAt}` so a profile refetch remounts the form
 * with the fresh values rather than syncing through an effect.
 */

const GOALS: CycleGoal[] = [
  "GENERAL_HEALTH",
  "AVOID_PREGNANCY",
  "TRYING_TO_CONCEIVE",
  "PERIMENOPAUSE",
  "OFF",
];

function numOrEmpty(v: number | null): string {
  return v == null ? "" : String(v);
}

export function CycleSettings({ profile }: { profile: CycleProfileDTO }) {
  const { t } = useTranslations();
  const update = useUpdateCyclePrefs();

  const [goal, setGoal] = useState<CycleGoal>(profile.goal);
  const [rawChartMode, setRawChartMode] = useState(profile.rawChartMode);
  const [predictionEnabled, setPredictionEnabled] = useState(
    profile.predictionEnabled,
  );
  const [encryption, setEncryption] = useState(
    profile.sensitiveCategoryEncryption,
  );
  const [discreet, setDiscreet] = useState(profile.discreetNotifications);
  const [cycleLen, setCycleLen] = useState(
    numOrEmpty(profile.typicalCycleLength),
  );
  const [periodLen, setPeriodLen] = useState(
    numOrEmpty(profile.typicalPeriodLength),
  );
  const [lutealLen, setLutealLen] = useState(
    numOrEmpty(profile.lutealPhaseLength),
  );

  function parsePrior(v: string): number | null {
    const n = Number(v);
    return v.trim() === "" || !Number.isFinite(n) ? null : Math.round(n);
  }

  async function handleSave() {
    await update.mutateAsync({
      goal,
      rawChartMode,
      predictionEnabled,
      sensitiveCategoryEncryption: encryption,
      discreetNotifications: discreet,
      typicalCycleLength: parsePrior(cycleLen),
      typicalPeriodLength: parsePrior(periodLen),
      lutealPhaseLength: parsePrior(lutealLen),
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("cycle.settings.title")}</CardTitle>
        <CardDescription>{t("cycle.goal.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Inclusive goal selector — drives the rest of the copy. */}
        <div className="space-y-2">
          <Label htmlFor="cycle-goal">{t("cycle.goal.label")}</Label>
          <NativeSelect
            id="cycle-goal"
            value={goal}
            onChange={(e) => setGoal(e.target.value as CycleGoal)}
          >
            {GOALS.map((g) => (
              <option key={g} value={g}>
                {t(`cycle.goal.${g}`)}
              </option>
            ))}
          </NativeSelect>
        </div>

        <Separator />

        {/* Predictions — when the goal hides conception framing, the
            description never names a fertile window. */}
        <ToggleRow
          id="cycle-prediction"
          label={t("cycle.settings.prediction")}
          description={t("cycle.settings.predictionDescription")}
          checked={predictionEnabled}
          onChange={setPredictionEnabled}
        />
        <ToggleRow
          id="cycle-rawchart"
          label={t("cycle.settings.rawChartMode")}
          description={t("cycle.settings.rawChartModeDescription")}
          checked={rawChartMode}
          onChange={setRawChartMode}
        />

        <Separator />

        {/* Priors */}
        <div className="space-y-3">
          <p className="text-sm font-medium">
            {t("cycle.settings.priorsDescription")}
          </p>
          <div className="grid gap-4 sm:grid-cols-3">
            <PriorField
              id="cycle-typical-length"
              label={t("cycle.settings.typicalCycleLength")}
              value={cycleLen}
              onChange={setCycleLen}
              min={15}
              max={60}
            />
            <PriorField
              id="cycle-period-length"
              label={t("cycle.settings.typicalPeriodLength")}
              value={periodLen}
              onChange={setPeriodLen}
              min={1}
              max={15}
            />
            <PriorField
              id="cycle-luteal-length"
              label={t("cycle.settings.lutealPhaseLength")}
              value={lutealLen}
              onChange={setLutealLen}
              min={8}
              max={20}
            />
          </div>
        </div>

        <Separator />

        {/* Privacy toggles */}
        <ToggleRow
          id="cycle-encryption"
          label={t("cycle.settings.encryption")}
          description={t("cycle.settings.encryptionDescription")}
          checked={encryption}
          onChange={setEncryption}
        />
        <ToggleRow
          id="cycle-discreet"
          label={t("cycle.settings.discreet")}
          description={t("cycle.settings.discreetDescription")}
          checked={discreet}
          onChange={setDiscreet}
        />

        <Separator />

        {/* Data export / delete */}
        <div className="space-y-2">
          <p className="text-sm font-medium">{t("cycle.settings.dataTitle")}</p>
          <p className="text-muted-foreground text-sm">
            {t("cycle.settings.dataDescription")}
          </p>
          <div className="flex flex-wrap gap-2 pt-1">
            <Button variant="outline" size="sm" asChild>
              <a href="/api/export/health-record" download>
                {t("cycle.settings.export")}
              </a>
            </Button>
            <Button variant="outline" size="sm" asChild>
              <Link href="/settings/account">
                {t("cycle.settings.deleteData")}
              </Link>
            </Button>
          </div>
        </div>

        <div className="flex items-center justify-end gap-3 pt-2">
          {update.isSuccess ? (
            <span className="text-muted-foreground text-sm" role="status">
              {t("cycle.settings.saved")}
            </span>
          ) : null}
          {update.isError ? (
            <span className="text-destructive text-sm" role="alert">
              {t("cycle.settings.saveError")}
            </span>
          ) : null}
          <Button onClick={handleSave} disabled={update.isPending}>
            {update.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" />
            ) : null}
            {t("cycle.settings.save")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function ToggleRow({
  id,
  label,
  description,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="space-y-0.5">
        <Label htmlFor={id} className="text-sm">
          {label}
        </Label>
        <p className="text-muted-foreground text-xs">{description}</p>
      </div>
      <Switch
        id={id}
        checked={checked}
        onCheckedChange={onChange}
        className="mt-0.5 shrink-0"
      />
    </div>
  );
}

function PriorField({
  id,
  label,
  value,
  onChange,
  min,
  max,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  min: number;
  max: number;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      <input
        id={id}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="border-input bg-background focus-visible:ring-ring/50 w-full rounded-md border px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2"
      />
    </div>
  );
}
