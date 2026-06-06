"use client";

import { useState } from "react";
import { Droplets, Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { useTranslations } from "@/lib/i18n/context";
import { CYCLE_SYMPTOM_CATALOG } from "./symptom-catalog";
import { FLOW_HUE } from "./phase-tokens";
import { useLogDay, useStartPeriod } from "./use-cycle";
import type {
  CervicalMucus,
  CycleDayLogInput,
  FlowLevel,
  OvulationTest,
} from "./types";

/**
 * v1.15.0 — the fast-entry log-day sheet.
 *
 * One-tap "started my period today" posts the period-boundary shortcut; the
 * detailed form posts a single day-log (flow, symptoms, BBT, OPK, mucus,
 * intercourse + protection, free-text note). The write is optimistic-ish
 * (the mutation invalidates the cycle keys on success so the calendar +
 * wheel repaint); the symptom chips reuse the mood-tag chip styling.
 *
 * a11y: every chip is a real `<button>` with `aria-pressed`; the sheet
 * footer sticky-pins Save/Cancel.
 */

const FLOW_LEVELS: FlowLevel[] = ["SPOTTING", "LIGHT", "MEDIUM", "HEAVY"];
const OPK_VALUES: OvulationTest[] = [
  "NEGATIVE",
  "POSITIVE_LH_SURGE",
  "ESTROGEN_SURGE",
  "INDETERMINATE",
];
const MUCUS_VALUES: CervicalMucus[] = [
  "DRY",
  "STICKY",
  "CREAMY",
  "WATERY",
  "EGG_WHITE",
];

export interface LogDaySheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The date being logged (YYYY-MM-DD). */
  date: string;
  /** Today (YYYY-MM-DD) — gates the one-tap period-start affordance. */
  today: string;
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "focus-visible:ring-ring/50 rounded-full border px-3 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2",
        active
          ? "border-primary bg-primary/10 text-primary"
          : "border-border text-foreground hover:bg-accent",
      )}
    >
      {children}
    </button>
  );
}

export function LogDaySheet({
  open,
  onOpenChange,
  date,
  today,
}: LogDaySheetProps) {
  const { t } = useTranslations();
  const logDay = useLogDay();
  const startPeriod = useStartPeriod();

  const [flow, setFlow] = useState<FlowLevel | null>(null);
  const [symptoms, setSymptoms] = useState<Set<string>>(new Set());
  const [bbt, setBbt] = useState<string>("");
  const [opk, setOpk] = useState<OvulationTest | null>(null);
  const [mucus, setMucus] = useState<CervicalMucus | null>(null);
  const [intercourse, setIntercourse] = useState(false);
  const [protectedSex, setProtectedSex] = useState(false);
  const [note, setNote] = useState("");

  // Reset the form to empty whenever the sheet (re)opens on a day. Tracked as
  // an "adjust state when a prop changes" during render (React's recommended
  // alternative to a setState-in-effect) keyed on the open+date pair, so a
  // re-open on a different calendar day always starts blank.
  const formKey = open ? date : null;
  const [lastFormKey, setLastFormKey] = useState<string | null>(null);
  if (open && formKey !== lastFormKey) {
    setLastFormKey(formKey);
    setFlow(null);
    setSymptoms(new Set());
    setBbt("");
    setOpk(null);
    setMucus(null);
    setIntercourse(false);
    setProtectedSex(false);
    setNote("");
  } else if (!open && lastFormKey !== null) {
    setLastFormKey(null);
  }

  function toggleSymptom(key: string) {
    setSymptoms((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function handleSave() {
    const bbtNum = bbt.trim() === "" ? undefined : Number(bbt);
    const input: CycleDayLogInput = {
      date,
      loggedAt: new Date().toISOString(),
      source: "MANUAL",
      ...(flow ? { flow } : {}),
      ...(bbtNum != null && Number.isFinite(bbtNum)
        ? { basalBodyTempC: bbtNum }
        : {}),
      ...(opk ? { ovulationTest: opk } : {}),
      ...(mucus ? { cervicalMucus: mucus } : {}),
      ...(intercourse
        ? { sexualActivity: true, protectedSex }
        : {}),
      ...(symptoms.size > 0
        ? { symptoms: Array.from(symptoms).map((key) => ({ key })) }
        : {}),
      ...(note.trim() ? { note: note.trim() } : {}),
    };
    await logDay.mutateAsync(input);
    onOpenChange(false);
  }

  async function handleStartPeriod() {
    await startPeriod.mutateAsync(today);
    onOpenChange(false);
  }

  const busy = logDay.isPending || startPeriod.isPending;

  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={onOpenChange}
      title={t("cycle.sheet.title")}
      description={t("cycle.sheet.description")}
      footer={
        <>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            {t("cycle.sheet.cancel")}
          </Button>
          <Button onClick={handleSave} disabled={busy}>
            {logDay.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" />
            ) : null}
            {logDay.isPending ? t("cycle.sheet.saving") : t("cycle.sheet.save")}
          </Button>
        </>
      }
    >
      {/* One-tap period start — only meaningful for today. */}
      {date === today ? (
        <Button
          variant="outline"
          className="w-full justify-start gap-2"
          onClick={handleStartPeriod}
          disabled={busy}
          style={{ borderColor: FLOW_HUE }}
        >
          {startPeriod.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
          ) : (
            <Droplets className="h-4 w-4" style={{ color: FLOW_HUE }} />
          )}
          {t("cycle.startedPeriod")}
        </Button>
      ) : null}

      {/* Flow */}
      <Field label={t("cycle.sheet.flow")}>
        <div className="flex flex-wrap gap-2">
          {FLOW_LEVELS.map((f) => (
            <Chip
              key={f}
              active={flow === f}
              onClick={() => setFlow((cur) => (cur === f ? null : f))}
            >
              {t(`cycle.flow.${f}`)}
            </Chip>
          ))}
        </div>
      </Field>

      {/* Symptoms */}
      <Field label={t("cycle.sheet.symptoms")}>
        <div className="space-y-3">
          {CYCLE_SYMPTOM_CATALOG.map((cat) => (
            <div key={cat.key} className="space-y-1.5">
              <div className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium">
                <cat.icon className="h-3.5 w-3.5" aria-hidden="true" />
                {t(cat.labelKey)}
              </div>
              <div className="flex flex-wrap gap-2">
                {cat.symptoms.map((s) => (
                  <Chip
                    key={s.key}
                    active={symptoms.has(s.key)}
                    onClick={() => toggleSymptom(s.key)}
                  >
                    <span className="flex items-center gap-1.5">
                      <s.icon className="h-3.5 w-3.5" aria-hidden="true" />
                      {t(s.labelKey)}
                    </span>
                  </Chip>
                ))}
              </div>
            </div>
          ))}
        </div>
      </Field>

      {/* BBT */}
      <Field label={t("cycle.sheet.temperature")}>
        <input
          type="number"
          inputMode="decimal"
          step="0.01"
          min={30}
          max={45}
          value={bbt}
          onChange={(e) => setBbt(e.target.value)}
          placeholder={t("cycle.sheet.temperaturePlaceholder")}
          className="border-input bg-background focus-visible:ring-ring/50 w-32 rounded-md border px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2"
          aria-label={t("cycle.sheet.temperature")}
        />
      </Field>

      {/* Ovulation test */}
      <Field label={t("cycle.sheet.ovulationTest")}>
        <div className="flex flex-wrap gap-2">
          {OPK_VALUES.map((v) => (
            <Chip
              key={v}
              active={opk === v}
              onClick={() => setOpk((cur) => (cur === v ? null : v))}
            >
              {t(`cycle.ovulationTest.${v}`)}
            </Chip>
          ))}
        </div>
      </Field>

      {/* Cervical mucus */}
      <Field label={t("cycle.sheet.mucus")}>
        <div className="flex flex-wrap gap-2">
          {MUCUS_VALUES.map((v) => (
            <Chip
              key={v}
              active={mucus === v}
              onClick={() => setMucus((cur) => (cur === v ? null : v))}
            >
              {t(`cycle.mucus.${v}`)}
            </Chip>
          ))}
        </div>
      </Field>

      {/* Intercourse + protection */}
      <Field label={t("cycle.sheet.intercourse")}>
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label htmlFor="cycle-intercourse" className="text-sm font-normal">
              {t("cycle.sheet.intercourse")}
            </Label>
            <Switch
              id="cycle-intercourse"
              checked={intercourse}
              onCheckedChange={setIntercourse}
            />
          </div>
          {intercourse ? (
            <div className="flex items-center justify-between">
              <Label
                htmlFor="cycle-protected"
                className="text-muted-foreground text-sm font-normal"
              >
                {t("cycle.sheet.protected")}
              </Label>
              <Switch
                id="cycle-protected"
                checked={protectedSex}
                onCheckedChange={setProtectedSex}
              />
            </div>
          ) : null}
        </div>
      </Field>

      {/* Note */}
      <Field label={t("cycle.sheet.note")}>
        <Textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={500}
          rows={3}
          placeholder={t("cycle.sheet.notePlaceholder")}
          aria-label={t("cycle.sheet.note")}
        />
      </Field>

      {logDay.isError ? (
        <p className="text-destructive text-sm" role="alert">
          {t("cycle.sheet.saveError")}
        </p>
      ) : null}
    </ResponsiveSheet>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">{label}</p>
      {children}
    </div>
  );
}
