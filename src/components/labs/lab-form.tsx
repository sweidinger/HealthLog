"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { DateTimeInput } from "@/components/ui/date-input";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, apiPost } from "@/lib/api/api-fetch";
import { useTranslations } from "@/lib/i18n/context";

import type { LabResultDto } from "./types";

const NOTE_MAX_LENGTH = 2000;

function defaultTakenAtValue() {
  const now = new Date();
  const offset = now.getTimezoneOffset();
  const local = new Date(now.getTime() - offset * 60 * 1000);
  return local.toISOString().slice(0, 16);
}

/** Parse a free-text decimal that may use a comma separator. */
function parseDecimal(raw: string): number | null {
  const trimmed = raw.trim().replace(",", ".");
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

interface LabFormProps {
  onSuccess?: (created: LabResultDto) => void;
  onCancel?: () => void;
}

/**
 * v1.17.1 — manual lab-result entry.
 *
 * Progressive disclosure: the four essentials (analyte, value, unit, date)
 * are always visible; the optional reference range, panel grouping, and
 * note sit below under a clearly-labelled "optional" heading so a quick
 * single-value entry stays a four-field affair.
 */
export function LabForm({ onSuccess, onCancel }: LabFormProps) {
  const { t } = useTranslations();

  const [analyte, setAnalyte] = useState("");
  const [value, setValue] = useState("");
  const [unit, setUnit] = useState("");
  const [takenAt, setTakenAt] = useState(defaultTakenAtValue);
  const [panel, setPanel] = useState("");
  const [refLow, setRefLow] = useState("");
  const [refHigh, setRefHigh] = useState("");
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const numericValue = parseDecimal(value);
    if (!analyte.trim() || numericValue === null || !unit.trim()) {
      setError(t("labs.form.requiredError"));
      return;
    }

    const low = parseDecimal(refLow);
    const high = parseDecimal(refHigh);
    if (low !== null && high !== null && low > high) {
      setError(t("labs.form.rangeOrderError"));
      return;
    }

    setSubmitting(true);
    try {
      const created = await apiPost<LabResultDto>("/api/labs", {
        analyte: analyte.trim(),
        value: numericValue,
        unit: unit.trim(),
        takenAt: new Date(takenAt).toISOString(),
        ...(panel.trim() ? { panel: panel.trim() } : {}),
        ...(low !== null ? { referenceLow: low } : {}),
        ...(high !== null ? { referenceHigh: high } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      toast.success(t("labs.form.savedToast"));
      onSuccess?.(created);
    } catch (err) {
      const message =
        err instanceof ApiError ? err.message : t("labs.form.saveError");
      setError(message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="lab-analyte">{t("labs.form.analyte")}</Label>
          <Input
            id="lab-analyte"
            value={analyte}
            onChange={(e) => setAnalyte(e.target.value)}
            placeholder={t("labs.form.analytePlaceholder")}
            maxLength={120}
            autoFocus
            required
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="lab-value">{t("labs.form.value")}</Label>
          <Input
            id="lab-value"
            inputMode="decimal"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="0.0"
            required
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="lab-unit">{t("labs.form.unit")}</Label>
          <Input
            id="lab-unit"
            value={unit}
            onChange={(e) => setUnit(e.target.value)}
            placeholder={t("labs.form.unitPlaceholder")}
            maxLength={40}
            required
          />
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="lab-takenAt">{t("labs.form.takenAt")}</Label>
          <DateTimeInput
            id="lab-takenAt"
            value={takenAt}
            onChange={(e) => setTakenAt(e.target.value)}
            max={defaultTakenAtValue()}
            required
          />
        </div>
      </div>

      <fieldset className="space-y-4 rounded-lg border border-dashed p-4">
        <legend className="text-muted-foreground px-1 text-xs font-medium">
          {t("labs.form.optionalGroup")}
        </legend>
        <div className="space-y-1.5">
          <Label htmlFor="lab-panel">{t("labs.form.panel")}</Label>
          <Input
            id="lab-panel"
            value={panel}
            onChange={(e) => setPanel(e.target.value)}
            placeholder={t("labs.form.panelPlaceholder")}
            maxLength={120}
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="lab-refLow">{t("labs.form.referenceLow")}</Label>
            <Input
              id="lab-refLow"
              inputMode="decimal"
              value={refLow}
              onChange={(e) => setRefLow(e.target.value)}
              placeholder={t("labs.form.referenceLowPlaceholder")}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="lab-refHigh">{t("labs.form.referenceHigh")}</Label>
            <Input
              id="lab-refHigh"
              inputMode="decimal"
              value={refHigh}
              onChange={(e) => setRefHigh(e.target.value)}
              placeholder={t("labs.form.referenceHighPlaceholder")}
            />
          </div>
        </div>
        <p className="text-muted-foreground text-xs">
          {t("labs.form.referenceHint")}
        </p>
        <div className="space-y-1.5">
          <Label htmlFor="lab-note">{t("labs.form.note")}</Label>
          <Textarea
            id="lab-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={t("labs.form.notePlaceholder")}
            maxLength={NOTE_MAX_LENGTH}
            rows={2}
          />
        </div>
      </fieldset>

      {error ? (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      ) : null}

      <div className="flex justify-end gap-2">
        {onCancel ? (
          <Button
            type="button"
            variant="ghost"
            onClick={onCancel}
            disabled={submitting}
          >
            {t("common.cancel")}
          </Button>
        ) : null}
        <Button type="submit" disabled={submitting}>
          {submitting ? (
            <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
          ) : null}
          {t("labs.form.save")}
        </Button>
      </div>
    </form>
  );
}
