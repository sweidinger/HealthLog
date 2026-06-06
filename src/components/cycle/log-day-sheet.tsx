"use client";

import { useState } from "react";
import {
  Activity,
  BatteryLow,
  Brain,
  CircleDot,
  Cookie,
  Drama,
  Droplet,
  Droplets,
  Flame,
  Frown,
  Heart,
  HeartPulse,
  Loader2,
  MoonStar,
  PersonStanding,
  Pill,
  Plus,
  Snowflake,
  Soup,
  Stethoscope,
  Tag,
  Thermometer,
  Trash2,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { useTranslations } from "@/lib/i18n/context";
import { CUSTOM_SYMPTOM_ICON_ALLOWLIST } from "@/lib/cycle/custom-symptoms";
import { CYCLE_SYMPTOM_CATALOG } from "./symptom-catalog";
import { FLOW_HUE } from "./phase-tokens";
import {
  useCreateCustomSymptom,
  useCustomSymptoms,
  useCycleDayLog,
  useDeleteCustomSymptom,
  useDeleteDayLog,
  useEndPeriod,
  useLogDay,
  usePatchDayLog,
  useStartPeriod,
  type CustomSymptomDTO,
  type CycleDayLogPatch,
} from "./use-cycle";
import type {
  CervicalMucus,
  ContraceptiveKind,
  CycleDayLogInput,
  CycleSymptomSelection,
  FlowLevel,
  HomeTestResult,
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
const TEST_RESULTS: HomeTestResult[] = [
  "POSITIVE",
  "NEGATIVE",
  "INDETERMINATE",
];
const CONTRACEPTIVE_KINDS: ContraceptiveKind[] = [
  "ORAL",
  "IUD",
  "IMPLANT",
  "INJECTION",
  "INTRAVAGINAL_RING",
  "PATCH",
  "EMERGENCY",
  "NONE",
];
const SEVERITY_LEVELS = [1, 2, 3, 4] as const;

/**
 * Resolve a custom symptom's stored Lucide icon NAME to its component. Scoped
 * to the `CUSTOM_SYMPTOM_ICON_ALLOWLIST` (server-validated on create) so the
 * import set stays tight; an unknown / null name falls back to `Tag`.
 */
const CUSTOM_ICON_BY_NAME: Record<string, LucideIcon> = {
  Tag,
  Activity,
  Heart,
  HeartPulse,
  Brain,
  Zap,
  Flame,
  Snowflake,
  Droplet,
  CircleDot,
  BatteryLow,
  MoonStar,
  PersonStanding,
  Drama,
  Frown,
  Cookie,
  Soup,
  Pill,
  Thermometer,
  Stethoscope,
};

function customIcon(name: string | null): LucideIcon {
  return (name && CUSTOM_ICON_BY_NAME[name]) || Tag;
}

/** The sheet's editable form state, lifted out so the two save-payload builders
 * are pure + unit-testable (the clear-on-edit semantics are the QA W-2 fix). */
export interface DayLogFormState {
  flow: FlowLevel | null;
  intermenstrual: boolean;
  /** Raw text from the BBT input; "" / non-finite resolves to null. */
  bbt: string;
  opk: OvulationTest | null;
  mucus: CervicalMucus | null;
  intercourse: boolean;
  protectedSex: boolean;
  pregnancyTest: HomeTestResult | null;
  progesteroneTest: HomeTestResult | null;
  contraceptive: ContraceptiveKind | null;
  note: string;
  symptoms: Map<string, number | null>;
}

function resolveBbt(bbt: string): number | null {
  const n = bbt.trim() === "" ? null : Number(bbt);
  return n != null && Number.isFinite(n) ? n : null;
}

function symptomList(
  symptoms: Map<string, number | null>,
): CycleSymptomSelection[] {
  return Array.from(symptoms.entries()).map(([key, severity]) => ({
    key,
    severity,
  }));
}

/**
 * The PATCH payload for an EDIT: every enum carries an explicit `null` when
 * deselected so the server clears it (the POST merge can only add/keep — QA
 * W-2). Pure + exported for the unit test.
 */
export function buildDayLogPatch(s: DayLogFormState): CycleDayLogPatch {
  return {
    flow: s.flow ?? null,
    intermenstrualBleeding: s.intermenstrual,
    basalBodyTempC: resolveBbt(s.bbt),
    ovulationTest: s.opk ?? null,
    cervicalMucus: s.mucus ?? null,
    sexualActivity: s.intercourse,
    protectedSex: s.intercourse ? s.protectedSex : null,
    pregnancyTest: s.pregnancyTest ?? null,
    progesteroneTest: s.progesteroneTest ?? null,
    contraceptive: s.contraceptive ?? null,
    symptoms: symptomList(s.symptoms),
    note: s.note.trim() ? s.note.trim() : null,
  };
}

/** The POST payload for a NEW row: omit empty enums (a fresh row has nothing to
 * clear); `note` posts an explicit "" so an emptied note never persists. */
export function buildDayLogInput(
  s: DayLogFormState,
  date: string,
): CycleDayLogInput {
  const bbtVal = resolveBbt(s.bbt);
  return {
    date,
    loggedAt: new Date().toISOString(),
    source: "MANUAL",
    ...(s.flow ? { flow: s.flow } : {}),
    intermenstrualBleeding: s.intermenstrual,
    ...(bbtVal != null ? { basalBodyTempC: bbtVal } : {}),
    ...(s.opk ? { ovulationTest: s.opk } : {}),
    ...(s.mucus ? { cervicalMucus: s.mucus } : {}),
    sexualActivity: s.intercourse,
    protectedSex: s.intercourse ? s.protectedSex : null,
    ...(s.pregnancyTest ? { pregnancyTest: s.pregnancyTest } : {}),
    ...(s.progesteroneTest ? { progesteroneTest: s.progesteroneTest } : {}),
    ...(s.contraceptive ? { contraceptive: s.contraceptive } : {}),
    symptoms: symptomList(s.symptoms),
    ...(s.note.trim() ? { note: s.note.trim() } : { note: "" }),
  };
}

export interface LogDaySheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The date being logged (YYYY-MM-DD). */
  date: string;
  /** Today (YYYY-MM-DD). */
  today: string;
  /**
   * Whether a period is currently open (today is in the MENSTRUAL phase) — gates
   * the one-tap "end period" affordance so it never shows when no period is in
   * progress (QA M2).
   */
  activePeriod?: boolean;
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
        "focus-visible:ring-ring/50 rounded-full border px-3 py-1.5 text-sm transition-colors focus-visible:ring-2 focus-visible:outline-none",
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
  activePeriod = false,
}: LogDaySheetProps) {
  const { t } = useTranslations();
  const logDay = useLogDay();
  const patchDay = usePatchDayLog();
  const startPeriod = useStartPeriod();
  const endPeriod = useEndPeriod();
  const deleteDay = useDeleteDayLog();
  // Pre-fill from the persisted day-log so a re-log never nulls untouched
  // (or HealthKit-sourced) fields — the v1.15 web data-loss fix.
  const dayLog = useCycleDayLog(open ? date : null);
  // The caller's custom symptoms, merged into the seeded chip grid.
  const customSymptoms = useCustomSymptoms();

  const [flow, setFlow] = useState<FlowLevel | null>(null);
  const [intermenstrual, setIntermenstrual] = useState(false);
  const [symptoms, setSymptoms] = useState<Map<string, number | null>>(
    new Map(),
  );
  const [bbt, setBbt] = useState<string>("");
  const [opk, setOpk] = useState<OvulationTest | null>(null);
  const [mucus, setMucus] = useState<CervicalMucus | null>(null);
  const [intercourse, setIntercourse] = useState(false);
  const [protectedSex, setProtectedSex] = useState(false);
  const [pregnancyTest, setPregnancyTest] = useState<HomeTestResult | null>(
    null,
  );
  const [progesteroneTest, setProgesteroneTest] =
    useState<HomeTestResult | null>(null);
  const [contraceptive, setContraceptive] = useState<ContraceptiveKind | null>(
    null,
  );
  const [note, setNote] = useState("");
  const [rowId, setRowId] = useState<string | null>(null);

  // Hydrate the form from the fetched DTO once per (open, date, fetched-row)
  // tuple. Tracked as an "adjust state when a prop changes" during render
  // (React's recommended alternative to a setState-in-effect) keyed on the
  // open+date+row-identity, so a re-open or a late-arriving fetch repaints the
  // controls exactly once. `dto === null` (nothing logged) resets to blank.
  const dto = open ? (dayLog.data ?? null) : undefined;
  const formKey = open
    ? `${date}:${dayLog.isSuccess ? "loaded" : "loading"}`
    : null;
  const [lastFormKey, setLastFormKey] = useState<string | null>(null);
  if (open && formKey !== lastFormKey && !dayLog.isLoading) {
    setLastFormKey(formKey);
    setRowId(dto?.id ?? null);
    setFlow((dto?.flow ?? null) as FlowLevel | null);
    setIntermenstrual(dto?.intermenstrualBleeding ?? false);
    setSymptoms(new Map((dto?.symptoms ?? []).map((s) => [s.key, s.severity])));
    setBbt(dto?.basalBodyTempC != null ? String(dto.basalBodyTempC) : "");
    setOpk((dto?.ovulationTest ?? null) as OvulationTest | null);
    setMucus((dto?.cervicalMucus ?? null) as CervicalMucus | null);
    setIntercourse(dto?.sexualActivity ?? false);
    setProtectedSex(dto?.protectedSex ?? false);
    setPregnancyTest(dto?.pregnancyTest ?? null);
    setProgesteroneTest(dto?.progesteroneTest ?? null);
    setContraceptive(dto?.contraceptive ?? null);
    setNote(dto?.note ?? "");
  } else if (!open && lastFormKey !== null) {
    setLastFormKey(null);
  }

  function toggleSymptom(key: string) {
    setSymptoms((prev) => {
      const next = new Map(prev);
      if (next.has(key)) next.delete(key);
      else next.set(key, null);
      return next;
    });
  }

  function setSymptomSeverity(key: string, severity: number) {
    setSymptoms((prev) => {
      const next = new Map(prev);
      // Tapping the active level clears it back to a plain presence link.
      next.set(key, next.get(key) === severity ? null : severity);
      return next;
    });
  }

  async function handleSave() {
    const state: DayLogFormState = {
      flow,
      intermenstrual,
      bbt,
      opk,
      mucus,
      intercourse,
      protectedSex,
      pregnancyTest,
      progesteroneTest,
      contraceptive,
      note,
      symptoms,
    };
    if (rowId) {
      // Editing an existing row → PATCH with explicit nulls so a deselected
      // chip actually CLEARS (the POST merge can only add/keep — QA W-2).
      await patchDay.mutateAsync({ id: rowId, patch: buildDayLogPatch(state) });
      onOpenChange(false);
      return;
    }
    await logDay.mutateAsync(buildDayLogInput(state, date));
    onOpenChange(false);
  }

  // Period boundaries operate on the SELECTED date, so a forgotten day-1 can be
  // corrected from the calendar retroactively (QA M3) — not today-only.
  async function handleStartPeriod() {
    await startPeriod.mutateAsync(date);
    onOpenChange(false);
  }

  async function handleEndPeriod() {
    await endPeriod.mutateAsync(date);
    onOpenChange(false);
  }

  async function handleDelete() {
    if (!rowId) return;
    await deleteDay.mutateAsync(rowId);
    onOpenChange(false);
  }

  const busy =
    logDay.isPending ||
    patchDay.isPending ||
    startPeriod.isPending ||
    endPeriod.isPending ||
    deleteDay.isPending;
  const saving = logDay.isPending || patchDay.isPending;

  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={onOpenChange}
      title={t("cycle.sheet.title")}
      description={t("cycle.sheet.description")}
      footer={
        <>
          {rowId ? (
            <Button
              variant="outline"
              onClick={handleDelete}
              disabled={busy}
              className="text-destructive hover:text-destructive mr-auto"
              aria-label={t("cycle.sheet.delete")}
            >
              {deleteDay.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" />
              ) : (
                <Trash2 className="mr-2 h-4 w-4" />
              )}
              {t("cycle.sheet.delete")}
            </Button>
          ) : null}
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            {t("cycle.sheet.cancel")}
          </Button>
          <Button onClick={handleSave} disabled={busy}>
            {saving ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" />
            ) : null}
            {saving ? t("cycle.sheet.saving") : t("cycle.sheet.save")}
          </Button>
        </>
      }
    >
      {/* One-tap period boundaries — available on any selected date so a
          forgotten day-1 can be corrected retroactively (M3). "End period"
          shows only while a period is actually open (M2). */}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          className="flex-1 justify-start gap-2"
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
        {activePeriod ? (
          <Button
            variant="outline"
            className="flex-1 justify-start gap-2"
            onClick={handleEndPeriod}
            disabled={busy}
          >
            {endPeriod.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
            ) : null}
            {t("cycle.endedPeriod")}
          </Button>
        ) : null}
      </div>

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
        <div className="mt-2 flex items-center justify-between">
          <Label htmlFor="cycle-intermenstrual" className="text-sm font-normal">
            {t("cycle.sheet.intermenstrualBleeding")}
          </Label>
          <Switch
            id="cycle-intermenstrual"
            checked={intermenstrual}
            onCheckedChange={setIntermenstrual}
          />
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
                  <SymptomChip
                    key={s.key}
                    symptomKey={s.key}
                    icon={s.icon}
                    label={t(s.labelKey)}
                    active={symptoms.has(s.key)}
                    severity={symptoms.get(s.key) ?? null}
                    onToggle={toggleSymptom}
                    onSeverity={setSymptomSeverity}
                  />
                ))}
              </div>
            </div>
          ))}

          {/* Custom symptoms — the user's own, under a `custom` category,
              plus the dashed ghost-chip that mints a new one. */}
          <div className="space-y-1.5">
            <div className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium">
              <Tag className="h-3.5 w-3.5" aria-hidden="true" />
              {t("cycle.symptomCategory.custom")}
            </div>
            <div className="flex flex-wrap gap-2">
              {(customSymptoms.data?.symptoms ?? []).map((s) => (
                <SymptomChip
                  key={s.key}
                  symptomKey={s.key}
                  icon={customIcon(s.icon)}
                  label={s.label ?? t("cycle.symptom.custom.fallbackLabel")}
                  active={symptoms.has(s.key)}
                  severity={symptoms.get(s.key) ?? null}
                  custom={s}
                  onToggle={toggleSymptom}
                  onSeverity={setSymptomSeverity}
                  onClear={(key) => {
                    setSymptoms((prev) => {
                      const next = new Map(prev);
                      next.delete(key);
                      return next;
                    });
                  }}
                />
              ))}
              <AddSymptomChip />
            </div>
          </div>
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
          className="border-input bg-background focus-visible:ring-ring/50 w-32 rounded-md border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:outline-none"
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

      {/* Pregnancy test */}
      <Field label={t("cycle.sheet.pregnancyTest")}>
        <div className="flex flex-wrap gap-2">
          {TEST_RESULTS.map((v) => (
            <Chip
              key={v}
              active={pregnancyTest === v}
              onClick={() => setPregnancyTest((cur) => (cur === v ? null : v))}
            >
              {t(`cycle.testResult.${v}`)}
            </Chip>
          ))}
        </div>
      </Field>

      {/* Progesterone test */}
      <Field label={t("cycle.sheet.progesteroneTest")}>
        <div className="flex flex-wrap gap-2">
          {TEST_RESULTS.map((v) => (
            <Chip
              key={v}
              active={progesteroneTest === v}
              onClick={() =>
                setProgesteroneTest((cur) => (cur === v ? null : v))
              }
            >
              {t(`cycle.testResult.${v}`)}
            </Chip>
          ))}
        </div>
      </Field>

      {/* Contraceptive */}
      <Field label={t("cycle.sheet.contraceptive")}>
        <div className="flex flex-wrap gap-2">
          {CONTRACEPTIVE_KINDS.map((v) => (
            <Chip
              key={v}
              active={contraceptive === v}
              onClick={() => setContraceptive((cur) => (cur === v ? null : v))}
            >
              {t(`cycle.contraceptive.${v}`)}
            </Chip>
          ))}
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

      {logDay.isError || patchDay.isError ? (
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

/**
 * One symptom chip + its inline 1-4 severity selector (shared by the seeded
 * catalogue chips and the custom chips so both render identically). A custom
 * chip additionally carries a tiny remove (×) affordance that soft-hides the
 * symptom from the catalogue.
 */
function SymptomChip({
  symptomKey,
  icon: Icon,
  label,
  active,
  severity,
  custom,
  onToggle,
  onSeverity,
  onClear,
}: {
  symptomKey: string;
  icon: LucideIcon;
  label: string;
  active: boolean;
  severity: number | null;
  custom?: CustomSymptomDTO;
  onToggle: (key: string) => void;
  onSeverity: (key: string, severity: number) => void;
  onClear?: (key: string) => void;
}) {
  const { t } = useTranslations();
  const deleteCustom = useDeleteCustomSymptom();

  async function handleRemove() {
    if (!custom) return;
    onClear?.(custom.key);
    await deleteCustom.mutateAsync(custom.key);
  }

  return (
    <div className="flex items-center gap-1">
      <span className="relative inline-flex items-center">
        <Chip active={active} onClick={() => onToggle(symptomKey)}>
          <span className="flex items-center gap-1.5">
            <Icon className="h-3.5 w-3.5" aria-hidden="true" />
            {label}
          </span>
        </Chip>
        {custom ? (
          <button
            type="button"
            onClick={handleRemove}
            disabled={deleteCustom.isPending}
            aria-label={t("cycle.symptom.custom.remove", { label })}
            className="border-border bg-background text-muted-foreground hover:text-destructive hover:border-destructive focus-visible:ring-ring/50 -ml-1.5 grid size-4 shrink-0 place-items-center rounded-full border transition-colors focus-visible:ring-2 focus-visible:outline-none"
          >
            <X className="size-2.5" aria-hidden="true" />
          </button>
        ) : null}
      </span>
      {active ? (
        <div
          className="flex gap-0.5"
          role="group"
          aria-label={t("cycle.sheet.severity")}
        >
          {SEVERITY_LEVELS.map((lvl) => (
            <button
              key={lvl}
              type="button"
              aria-pressed={severity === lvl}
              aria-label={t("cycle.sheet.severityLevel", { level: lvl })}
              onClick={() => onSeverity(symptomKey, lvl)}
              className={cn(
                "focus-visible:ring-ring/50 size-6 rounded-full border text-xs tabular-nums transition-colors focus-visible:ring-2 focus-visible:outline-none",
                severity === lvl
                  ? "border-primary bg-primary/15 text-primary font-semibold"
                  : "border-border text-muted-foreground hover:bg-accent",
              )}
            >
              {lvl}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The dashed ghost-chip in the symptom grid that opens a compact label + icon
 * popover to mint a new custom symptom. Matches the chip grid (same rounded-
 * full pill, same size) so it reads as part of the grid, not a foreign button.
 */
function AddSymptomChip() {
  const { t } = useTranslations();
  const create = useCreateCustomSymptom();
  const [openForm, setOpenForm] = useState(false);
  const [label, setLabel] = useState("");
  const [icon, setIcon] = useState<string>("Tag");

  function reset() {
    setLabel("");
    setIcon("Tag");
  }

  async function handleCreate() {
    const trimmed = label.trim();
    if (!trimmed) return;
    await create.mutateAsync({ label: trimmed, icon });
    reset();
    setOpenForm(false);
  }

  const limitReached = create.isError;

  return (
    <Popover
      open={openForm}
      onOpenChange={(o) => {
        setOpenForm(o);
        if (!o) reset();
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          className="border-border text-muted-foreground hover:border-primary hover:text-primary focus-visible:ring-ring/50 inline-flex items-center gap-1.5 rounded-full border border-dashed px-3 py-1.5 text-sm transition-colors focus-visible:ring-2 focus-visible:outline-none"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          {t("cycle.symptom.custom.add")}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="custom-symptom-label" className="text-xs font-medium">
            {t("cycle.symptom.custom.label")}
          </Label>
          <Input
            id="custom-symptom-label"
            value={label}
            maxLength={40}
            autoFocus
            placeholder={t("cycle.symptom.custom.labelPlaceholder")}
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void handleCreate();
              }
            }}
          />
        </div>
        <div className="space-y-1.5">
          <p className="text-xs font-medium">
            {t("cycle.symptom.custom.icon")}
          </p>
          <div
            className="flex flex-wrap gap-1.5"
            role="radiogroup"
            aria-label={t("cycle.symptom.custom.icon")}
          >
            {CUSTOM_SYMPTOM_ICON_ALLOWLIST.map((name) => {
              const IconC = customIcon(name);
              const selected = icon === name;
              return (
                <button
                  key={name}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  aria-label={name}
                  onClick={() => setIcon(name)}
                  className={cn(
                    "focus-visible:ring-ring/50 grid size-7 place-items-center rounded-md border transition-colors focus-visible:ring-2 focus-visible:outline-none",
                    selected
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border text-muted-foreground hover:bg-accent",
                  )}
                >
                  <IconC className="size-4" aria-hidden="true" />
                </button>
              );
            })}
          </div>
        </div>
        {limitReached ? (
          <p className="text-destructive text-xs" role="alert">
            {t("cycle.symptom.custom.limitReached")}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              reset();
              setOpenForm(false);
            }}
          >
            {t("cycle.sheet.cancel")}
          </Button>
          <Button
            size="sm"
            onClick={handleCreate}
            disabled={!label.trim() || create.isPending}
          >
            {create.isPending ? (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
            ) : null}
            {t("cycle.symptom.custom.add")}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
