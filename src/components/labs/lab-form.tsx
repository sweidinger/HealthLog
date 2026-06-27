"use client";

import { useId, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { DateTimeField } from "@/components/ui/date-time-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, apiGet, apiPost } from "@/lib/api/api-fetch";
import { formatReferenceRange } from "@/lib/labs/reference-range";
import { formatLabValue } from "@/lib/labs/format-value";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";

import { BiomarkerForm } from "./biomarker-form";
import type {
  BiomarkerDto,
  BiomarkerListResponse,
  LabResultDto,
} from "./types";

const NOTE_MAX_LENGTH = 2000;
const DEFINE_NEW = "__define_new__";

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
  /** When set, the biomarker is pre-selected and locked (add-from-detail). */
  lockedBiomarkerId?: string;
  onSuccess?: (created: LabResultDto) => void;
  onCancel?: () => void;
  /**
   * When mounted inside a `<ResponsiveSheet>` the caller passes the sheet's
   * footer slot element here. The Cancel / Save action row is portalled into
   * it so the bottom-sheet branch can sticky-pin it above the keyboard; the
   * Save button stays tied to the `<form>` via the HTML `form` attribute so
   * submit-on-Enter and portalled-click both still submit.
   */
  footerSlot?: HTMLElement | null;
}

/**
 * v1.18.1 — structured lab-result entry.
 *
 * The error-prone free-text path is gone: the user PICKS a biomarker from the
 * catalog, then enters only the value against its known unit + reference range
 * (resolved server-side). A "+ define new" row opens the marker-definition
 * sheet inline and returns with it selected. Panel / unit / range are NOT
 * re-entered per reading — they live on the biomarker. Only the per-reading
 * note stays optional here.
 */
export function LabForm({
  lockedBiomarkerId,
  onSuccess,
  onCancel,
  footerSlot,
}: LabFormProps) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const formId = useId();

  const { data: catalog, isLoading: catalogLoading } = useQuery({
    queryKey: queryKeys.biomarkers(),
    queryFn: () => apiGet<BiomarkerListResponse>("/api/biomarkers"),
  });

  const [biomarkerId, setBiomarkerId] = useState<string>(
    lockedBiomarkerId ?? "",
  );
  // v1.18.9 — numeric vs qualitative result mode. Numeric mode enters a number
  // against the marker's unit/range; qualitative mode enters a result text
  // ("negativ" / "positiv" / "grenzwertig" / free text) and hides unit/range.
  const [resultType, setResultType] = useState<"numeric" | "qualitative">(
    "numeric",
  );
  const [value, setValue] = useState("");
  const [valueText, setValueText] = useState("");
  const [takenAt, setTakenAt] = useState(defaultTakenAtValue);
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [defineOpen, setDefineOpen] = useState(false);
  const [defineFooterEl, setDefineFooterEl] = useState<HTMLDivElement | null>(
    null,
  );

  const allMarkers = catalog?.biomarkers ?? [];
  const selected = allMarkers.find((m) => m.id === biomarkerId);
  // v1.22 — hidden markers drop from the picker, but keep the currently
  // selected one visible (e.g. editing a reading whose marker was later
  // hidden) so the Select still resolves its label.
  const markers = allMarkers.filter((m) => !m.hidden || m.id === biomarkerId);

  function handleSelect(next: string) {
    if (next === DEFINE_NEW) {
      setDefineOpen(true);
      return;
    }
    setBiomarkerId(next);
    setError(null);
  }

  function afterDefine(created: BiomarkerDto) {
    setDefineOpen(false);
    queryClient.invalidateQueries({ queryKey: queryKeys.biomarkers() });
    setBiomarkerId(created.id);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!biomarkerId) {
      setError(t("labs.form.pickBiomarkerError"));
      return;
    }

    const isQualitative = resultType === "qualitative";
    let numericValue: number | null = null;
    let qualitativeValue: string | null = null;
    if (isQualitative) {
      const trimmed = valueText.trim();
      if (trimmed === "") {
        setError(t("labs.form.requiredError"));
        return;
      }
      qualitativeValue = trimmed;
    } else {
      numericValue = parseDecimal(value);
      if (numericValue === null) {
        setError(t("labs.form.requiredError"));
        return;
      }
    }

    setSubmitting(true);
    try {
      const created = await apiPost<LabResultDto>("/api/labs", {
        biomarkerId,
        ...(isQualitative
          ? { valueText: qualitativeValue }
          : { value: numericValue }),
        takenAt: new Date(takenAt).toISOString(),
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

  const referenceText = selected
    ? formatReferenceRange(
        selected.lowerBound,
        selected.upperBound,
        formatLabValue,
      )
    : "";

  const footerNode = (
    <>
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
      <Button type="submit" form={formId} disabled={submitting}>
        {submitting ? (
          <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
        ) : null}
        {t("labs.form.save")}
      </Button>
    </>
  );

  return (
    <>
      <form id={formId} onSubmit={handleSubmit} className="space-y-5">
        <div className="space-y-1.5">
          <Label htmlFor="lab-biomarker">{t("labs.form.biomarker")}</Label>
          <Select
            value={biomarkerId || undefined}
            onValueChange={handleSelect}
            disabled={!!lockedBiomarkerId || catalogLoading}
          >
            <SelectTrigger id="lab-biomarker" className="w-full">
              <SelectValue placeholder={t("labs.form.biomarkerPlaceholder")} />
            </SelectTrigger>
            <SelectContent>
              {markers.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.name} · {m.unit}
                </SelectItem>
              ))}
              {!lockedBiomarkerId ? (
                <SelectItem value={DEFINE_NEW}>
                  {t("labs.form.defineNew")}
                </SelectItem>
              ) : null}
            </SelectContent>
          </Select>
          {markers.length === 0 && !catalogLoading ? (
            <p className="text-muted-foreground text-xs">
              {t("labs.form.noBiomarkersHint")}
            </p>
          ) : null}
        </div>

        <div className="space-y-1.5">
          <Label>{t("labs.form.resultType")}</Label>
          <div className="flex gap-1">
            <Button
              type="button"
              size="sm"
              variant={resultType === "numeric" ? "secondary" : "ghost"}
              className="min-h-11 flex-1 sm:min-h-9"
              onClick={() => setResultType("numeric")}
              aria-pressed={resultType === "numeric"}
            >
              {t("labs.form.numeric")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant={resultType === "qualitative" ? "secondary" : "ghost"}
              className="min-h-11 flex-1 sm:min-h-9"
              onClick={() => setResultType("qualitative")}
              aria-pressed={resultType === "qualitative"}
            >
              {t("labs.form.qualitative")}
            </Button>
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            {resultType === "numeric" ? (
              <>
                <Label htmlFor="lab-value">
                  {t("labs.form.value")}
                  {selected ? (
                    <span className="text-muted-foreground font-normal">
                      {" "}
                      ({selected.unit})
                    </span>
                  ) : null}
                </Label>
                <Input
                  id="lab-value"
                  inputMode="decimal"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  placeholder="0.0"
                  required
                />
              </>
            ) : (
              <>
                <Label htmlFor="lab-valueText">
                  {t("labs.form.qualitativeResult")}
                </Label>
                <Input
                  id="lab-valueText"
                  list="lab-qualitative-options"
                  value={valueText}
                  onChange={(e) => setValueText(e.target.value)}
                  placeholder={t("labs.form.qualitativePlaceholder")}
                  maxLength={120}
                  required
                />
                <datalist id="lab-qualitative-options">
                  <option value={t("labs.form.qualNegative")} />
                  <option value={t("labs.form.qualPositive")} />
                  <option value={t("labs.form.qualBorderline")} />
                </datalist>
              </>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="lab-takenAt">{t("labs.form.takenAt")}</Label>
            <DateTimeField
              id="lab-takenAt"
              value={takenAt}
              onChange={setTakenAt}
              max={defaultTakenAtValue()}
              required
            />
          </div>
        </div>

        {resultType === "numeric" && selected && referenceText ? (
          <p className="text-muted-foreground text-xs">
            {t("labs.referenceLabel")} {referenceText} {selected.unit}
          </p>
        ) : null}

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

        {error ? (
          <p className="text-destructive text-sm" role="alert">
            {error}
          </p>
        ) : null}

        {/* When no footer slot is supplied (rare — e.g. a non-sheet host) the
            action row renders inline; inside a sheet it portals into the
            sticky footer. */}
        {footerSlot ? null : (
          <div className="flex justify-end gap-2">{footerNode}</div>
        )}
      </form>

      {footerSlot ? createPortal(footerNode, footerSlot) : null}

      <ResponsiveSheet
        open={defineOpen}
        onOpenChange={setDefineOpen}
        title={t("labs.biomarker.defineTitle")}
        description={t("labs.biomarker.defineDescription")}
        footer={
          <div
            ref={setDefineFooterEl}
            className="flex w-full justify-end gap-2"
          />
        }
      >
        <BiomarkerForm
          footerSlot={defineFooterEl}
          onSuccess={afterDefine}
          onCancel={() => setDefineOpen(false)}
        />
      </ResponsiveSheet>
    </>
  );
}
