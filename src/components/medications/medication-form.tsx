"use client";

// i18n keys added:
//   medications.scheduling.cadence.section          — "Cadence" section header
//   medications.scheduling.timesOfDay.section       — "Times of day" section header
//   medications.scheduling.courseWindow.section     — "Course window" section header
//   medications.scheduling.oneShot.section          — "Single dose" toggle label
//   medications.scheduling.legacyWindow.section     — "Reminder window (legacy)" header
//   medications.scheduling.legacyWindow.help        — explainer for the legacy fallback
//   The picker primitives consume `medications.scheduling.cadence.*`,
//   `medications.scheduling.timesOfDay.*`, and
//   `medications.scheduling.courseWindow.*` via template-string keys
//   (see CadencePicker.tsx, TimesOfDayChips.tsx, CourseWindowRow.tsx).

import { useId, useState } from "react";
import { createPortal } from "react-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Bell,
  BellOff,
  Clock,
  Eraser,
  Loader2,
  MoreHorizontal,
  MoreVertical,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Terminal,
  Trash2,
  Upload,
} from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "@/lib/i18n/context";
import { invalidateKeys, medicationDependentKeys } from "@/lib/query-keys";
import { PhaseConfigDialog } from "@/components/medications/phase-config-dialog";
import { CadencePicker } from "@/components/medications/scheduling/CadencePicker";
import {
  TimesOfDayChips,
  addTime,
} from "@/components/medications/scheduling/TimesOfDayChips";
import { CourseWindowRow } from "@/components/medications/scheduling/CourseWindowRow";
import {
  type CadenceSubControls,
  type CadenceValue,
  DEFAULT_SUB_CONTROLS,
} from "@/components/medications/scheduling/types";
import {
  inferCadenceFromLegacy,
  legacyPairFromCadence,
} from "@/components/medications/scheduling/legacy-bridge";

// DOSE_UNITS built dynamically via t() in the component

type TranslateFn = (
  key: string,
  params?: Record<string, string | number>,
) => string;

function getDayLabelsShort(t: TranslateFn): string[] {
  return [
    t("medications.daysSun"),
    t("medications.daysMon"),
    t("medications.daysTue"),
    t("medications.daysWed"),
    t("medications.daysThu"),
    t("medications.daysFri"),
    t("medications.daysSat"),
  ];
}

/**
 * Internal form-level schedule shape. Carries the v1.5 picker state
 * (cadence + sub-controls + timesOfDay) alongside the legacy mirror
 * fields the route still persists during the v1.5.x dual-write
 * window. `legacyOnLoad` flips true when the snapshot loaded from
 * the API had no v1.5 fields populated — that's the cue to surface
 * the legacy windowStart/windowEnd inputs as a defensive fallback.
 */
interface Schedule {
  /** Picker output — the schedule's canonical cadence value. */
  cadence: CadenceValue;
  /** Sub-controls remembered for the picker so radio toggles don't
   *  drop the user's previous selection. */
  cadenceSub: CadenceSubControls;
  /** Times of day the dose is taken (HH:mm, sorted, capped at 8). */
  timesOfDay: string[];
  /** Per-schedule label override (e.g. "Morning"). */
  label: string;
  /** Per-schedule dose override (e.g. "5 mg"). */
  dose: string;
  /** Legacy reminder window start (HH:mm). Dual-written for v1.5.x. */
  windowStart: string;
  /** Legacy reminder window end (HH:mm). Dual-written for v1.5.x. */
  windowEnd: string;
  /** True when the schedule loaded with no v1.5 fields → surface the
   *  legacy windowStart/windowEnd inputs as a fallback during the
   *  migration window. */
  legacyOnLoad: boolean;
}

interface InitialSchedule {
  windowStart: string;
  windowEnd: string;
  label: string;
  dose: string;
  daysOfWeek?: number[];
  intervalWeeks?: number;
  /** v1.5 — first-class times-of-day. */
  timesOfDay?: string[];
  /** v1.5 — RFC 5545 RRULE string for calendar-anchored cadences. */
  rrule?: string | null;
  /** v1.5 — flexible-rolling interval in days. */
  rollingIntervalDays?: number | null;
  /** v1.5 — reminder grace window in minutes. */
  reminderGraceMinutes?: number | null;
}

interface MedicationFormProps {
  onSuccess?: () => void;
  onCancel?: () => void;
  /**
   * v1.4.27 R4 RC2 — when the form is mounted inside a
   * `<ResponsiveSheet>` the caller passes the sheet's footer slot
   * element here. The kebab + Cancel + Save row portals into that slot
   * so the bottom-sheet branch can sticky-pin it; the Save button keeps
   * its `<form>` association via the HTML `form` attribute.
   */
  footerSlot?: HTMLElement | null;
  editActions?: {
    onImportIntakes: () => void;
    onApiAccess: () => void;
  };
  initial?: {
    id: string;
    name: string;
    dose: string;
    category: string;
    /** v1.4.25 W4d — Prisma treatment class. Defaults to GENERIC. */
    treatmentClass?: string;
    /** v1.4.25 W4d — only relevant for inventory-tracked meds. */
    dosesPerUnit?: number | null;
    active: boolean;
    notificationsEnabled?: boolean;
    /** v1.5 — medication-level course start date. */
    startsOn?: Date | null;
    /** v1.5 — medication-level course end date. */
    endsOn?: Date | null;
    /** v1.5 — single-administration medication. */
    oneShot?: boolean;
    schedules: Array<InitialSchedule>;
  };
}

const DEFAULT_CADENCE: CadenceValue = {
  kind: "daily",
  rrule: "FREQ=DAILY",
  rollingIntervalDays: null,
  oneShot: false,
};

const DEFAULT_SCHEDULE: Schedule = {
  cadence: { ...DEFAULT_CADENCE },
  cadenceSub: { ...DEFAULT_SUB_CONTROLS },
  timesOfDay: ["08:00"],
  label: "",
  dose: "",
  windowStart: "08:00",
  windowEnd: "09:00",
  legacyOnLoad: false,
};

/** Try to split "400mg" into ["400", "mg"] */
function parseDose(dose: string): { amount: string; unit: string } {
  const match = /^(\d+(?:[.,]\d+)?)\s*(.*)$/.exec(dose.trim());
  if (match) return { amount: match[1], unit: match[2] };
  return { amount: "", unit: dose };
}

function parseTimeToMinutes(value: string): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function minutesToHHmm(total: number): string {
  const normalised = ((total % (24 * 60)) + 24 * 60) % (24 * 60);
  const h = String(Math.floor(normalised / 60)).padStart(2, "0");
  const m = String(normalised % 60).padStart(2, "0");
  return `${h}:${m}`;
}

/**
 * Derive a `(windowStart, windowEnd)` mirror from the picker chips so
 * the route's legacy plumb still has values to persist during the
 * v1.5.x dual-write window. Default 60-minute grace window matches
 * the legacy default the historical form started new schedules with.
 */
function deriveLegacyWindow(
  timesOfDay: string[],
  fallbackStart: string,
  fallbackEnd: string,
): { windowStart: string; windowEnd: string } {
  if (timesOfDay.length === 0) {
    return { windowStart: fallbackStart, windowEnd: fallbackEnd };
  }
  const first = timesOfDay[0];
  const startMin = parseTimeToMinutes(first);
  if (startMin === null) {
    return { windowStart: fallbackStart, windowEnd: fallbackEnd };
  }
  return {
    windowStart: first,
    windowEnd: minutesToHHmm(startMin + 60),
  };
}

function sortSchedulesByFirstTime(list: Schedule[]): Schedule[] {
  return [...list]
    .map((schedule, index) => ({ schedule, index }))
    .sort((a, b) => {
      const aFirst = a.schedule.timesOfDay[0] ?? a.schedule.windowStart;
      const bFirst = b.schedule.timesOfDay[0] ?? b.schedule.windowStart;
      const aMin = parseTimeToMinutes(aFirst);
      const bMin = parseTimeToMinutes(bFirst);
      if (aMin === null && bMin === null) return a.index - b.index;
      if (aMin === null) return 1;
      if (bMin === null) return -1;
      if (aMin !== bMin) return aMin - bMin;
      return a.index - b.index;
    })
    .map((item) => item.schedule);
}

function hydrateScheduleFromInitial(s: InitialSchedule): Schedule {
  const legacy = {
    daysOfWeek: s.daysOfWeek ?? [],
    intervalWeeks: s.intervalWeeks ?? 1,
  };
  const inferred = inferCadenceFromLegacy(legacy);
  // The schedule is "legacy on load" when it has no v1.5 fields
  // populated — timesOfDay empty AND no rrule AND no rollingIntervalDays.
  // The migration backfills `timesOfDay = [windowStart]` for every
  // pre-v1.5 row, so an explicit empty array means a row that hasn't
  // been touched by the migration yet (defensive fallback).
  const hasV15Fields =
    (s.timesOfDay && s.timesOfDay.length > 0) ||
    !!s.rrule ||
    typeof s.rollingIntervalDays === "number";

  const timesOfDay =
    s.timesOfDay && s.timesOfDay.length > 0
      ? [...s.timesOfDay]
      : [s.windowStart];

  return {
    cadence: inferred.value,
    cadenceSub: inferred.subControls,
    timesOfDay,
    label: s.label ?? "",
    dose: s.dose ?? "",
    windowStart: s.windowStart,
    windowEnd: s.windowEnd,
    legacyOnLoad: !hasV15Fields,
  };
}

export function MedicationForm({
  onSuccess,
  onCancel,
  footerSlot,
  editActions,
  initial,
}: MedicationFormProps) {
  const queryClient = useQueryClient();
  const { t } = useTranslations();

  // v1.4.27 R4 RC2 — stable form id so the portalled Save button keeps
  // its `<form>` association via the HTML `form` attribute even when
  // DOM-mounted in the `<ResponsiveSheet>` footer slot.
  const formId = useId();

  const doseUnits = [
    "mg",
    "g",
    "ml",
    t("medications.unitDrops"),
    t("medications.unitTablets"),
    t("medications.unitCapsules"),
    t("medications.unitPieces"),
    "IE",
    "µg",
  ];

  const [name, setName] = useState(initial?.name ?? "");

  const initialDose = parseDose(initial?.dose ?? "");
  const [doseAmount, setDoseAmount] = useState(initialDose.amount);
  const [doseUnit, setDoseUnit] = useState(initialDose.unit);

  const [category, setCategory] = useState(initial?.category ?? "OTHER");
  // v1.4.25 W4d — treatment class. GLP1 unlocks the weekly-cadence
  // preset below and the GLP-1 medication-card variant on the medications
  // page. The default GENERIC keeps every existing medication rendering
  // exactly as before.
  const [treatmentClass, setTreatmentClass] = useState(
    initial?.treatmentClass ?? "GENERIC",
  );
  const [dosesPerUnit, setDosesPerUnit] = useState<string>(
    initial?.dosesPerUnit ? String(initial.dosesPerUnit) : "",
  );
  const [active, setActive] = useState(initial?.active ?? true);
  const [notificationsEnabled, setNotificationsEnabled] = useState(
    initial?.notificationsEnabled ?? true,
  );

  // v1.5 — medication-level course window + one-shot flag.
  const [startsOn, setStartsOn] = useState<Date | null>(
    initial?.startsOn ?? null,
  );
  const [endsOn, setEndsOn] = useState<Date | null>(initial?.endsOn ?? null);
  const [oneShot, setOneShot] = useState<boolean>(initial?.oneShot ?? false);

  const [schedules, setSchedules] = useState<Schedule[]>(
    sortSchedulesByFirstTime(
      initial?.schedules?.length
        ? initial.schedules.map(hydrateScheduleFromInitial)
        : [{ ...DEFAULT_SCHEDULE }],
    ),
  );
  const [loading, setLoading] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [purging, setPurging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [purgeDialogOpen, setPurgeDialogOpen] = useState(false);
  const [phaseConfigOpen, setPhaseConfigOpen] = useState(false);

  // v1.4.27 MB3 — link the form-level error banner to every required
  // input via `aria-describedby` so screen readers announce the
  // validation failure on save.
  const errorId = useId();
  const errorDescriptor = error ? errorId : undefined;

  const isEdit = !!initial;
  const dose = doseAmount
    ? `${doseAmount}${doseUnit ? ` ${doseUnit}` : ""}`
    : doseUnit;

  function patchSchedule(index: number, patch: Partial<Schedule>) {
    setSchedules((prev) =>
      prev.map((s, i) => (i === index ? { ...s, ...patch } : s)),
    );
  }

  function patchScheduleAndResort(index: number, patch: Partial<Schedule>) {
    setSchedules((prev) =>
      sortSchedulesByFirstTime(
        prev.map((s, i) => (i === index ? { ...s, ...patch } : s)),
      ),
    );
  }

  function addSchedule() {
    if (oneShot) return;
    setSchedules((prev) =>
      sortSchedulesByFirstTime([...prev, { ...DEFAULT_SCHEDULE }]),
    );
  }

  function removeSchedule(index: number) {
    if (schedules.length <= 1) return;
    setSchedules((prev) => prev.filter((_, i) => i !== index));
  }

  function resetCreateForm() {
    if (isEdit) return;
    setName("");
    setDoseAmount("");
    setDoseUnit("");
    setCategory("OTHER");
    setTreatmentClass("GENERIC");
    setDosesPerUnit("");
    setActive(true);
    setNotificationsEnabled(true);
    setStartsOn(null);
    setEndsOn(null);
    setOneShot(false);
    setSchedules([{ ...DEFAULT_SCHEDULE }]);
    setError(null);
  }

  /**
   * v1.4.25 W4d — "Once weekly on …" preset, restated against the
   * v1.5 picker. One tap on a weekday writes the picker into the
   * `weekdays` kind with the chosen day and revealss the cadence row
   * via the picker's own conditional sub-controls. The preference
   * still persists across sessions so the next GLP-1 medication
   * starts on the same weekday.
   */
  function applyWeeklyPreset(weekdayIndex0Sun: number) {
    try {
      localStorage.setItem(
        "medication-form:last-weekly-weekday",
        String(weekdayIndex0Sun),
      );
    } catch {
      /* private mode — silent */
    }
    // Convert 0-6 (Sun-anchored) to the BYDAY token order the picker
    // expects. Day 0 (Sun) maps to "SU"; day 1 (Mon) maps to "MO";
    // and so on through day 6 (Sat) → "SA".
    const tokenMap: Record<
      number,
      (typeof DEFAULT_SUB_CONTROLS)["weekdays"][number]
    > = {
      0: "SU",
      1: "MO",
      2: "TU",
      3: "WE",
      4: "TH",
      5: "FR",
      6: "SA",
    };
    const token = tokenMap[weekdayIndex0Sun];
    if (!token) return;
    setSchedules((prev) =>
      prev.map((s, i) =>
        i === 0
          ? {
              ...s,
              cadence: {
                kind: "weekdays",
                rrule: `FREQ=WEEKLY;BYDAY=${token}`,
                rollingIntervalDays: null,
                oneShot: false,
              },
              cadenceSub: { ...s.cadenceSub, weekdays: [token] },
            }
          : s,
      ),
    );
  }

  function readLastWeeklyWeekday(): number {
    try {
      const raw = localStorage.getItem("medication-form:last-weekly-weekday");
      const n = raw === null ? NaN : Number(raw);
      return Number.isInteger(n) && n >= 0 && n <= 6 ? n : 3; // Wednesday default
    } catch {
      return 3;
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const url = isEdit ? `/api/medications/${initial.id}` : "/api/medications";
    const method = isEdit ? "PUT" : "POST";

    try {
      const courseStartsOnIso =
        startsOn !== null ? toIsoDateOnly(startsOn) : null;
      const courseEndsOnIso = endsOn !== null ? toIsoDateOnly(endsOn) : null;

      const serialisedSchedules = sortSchedulesByFirstTime(schedules).map(
        (s) => {
          // Dual-write — derive the legacy mirror from the picker so
          // the route's `serializeScheduleRecurrence` and the v1.5.x
          // reader-fallback still see a consistent pair.
          const legacyPair = legacyPairFromCadence(s.cadence, s.cadenceSub);
          const window = deriveLegacyWindow(
            s.timesOfDay,
            s.windowStart,
            s.windowEnd,
          );
          return {
            windowStart: window.windowStart,
            windowEnd: window.windowEnd,
            label: s.label || undefined,
            dose: s.dose || undefined,
            daysOfWeek:
              legacyPair.daysOfWeek.length > 0
                ? legacyPair.daysOfWeek
                : undefined,
            intervalWeeks: legacyPair.intervalWeeks,
            timesOfDay:
              s.timesOfDay.length > 0 ? s.timesOfDay : undefined,
            // v1.5 — pass-through the picker output. Daily / rolling /
            // oneShot all map to the right route branches below; the
            // PUT layer also normalises endsOn / mints a default rrule.
            ...(s.cadence.rrule !== null && { rrule: s.cadence.rrule }),
            ...(s.cadence.rollingIntervalDays !== null && {
              rollingIntervalDays: s.cadence.rollingIntervalDays,
            }),
          };
        },
      );

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          dose,
          category,
          treatmentClass,
          ...(dosesPerUnit
            ? { dosesPerUnit: Number(dosesPerUnit) }
            : isEdit
              ? { dosesPerUnit: null }
              : {}),
          ...(isEdit
            ? {
                active,
                ...(notificationsEnabled !==
                  (initial?.notificationsEnabled ?? true) && {
                  notificationsEnabled,
                }),
              }
            : {}),
          // v1.5 — medication-level course window + one-shot flag.
          // Only emit fields that diverged from the defaults so a
          // legacy medication that the user opened and saved without
          // touching the course window doesn't get a NULL stamped on
          // its existing startsOn.
          ...(startsOn !== null && { startsOn: courseStartsOnIso }),
          ...(endsOn !== null && { endsOn: courseEndsOnIso }),
          ...(oneShot && { oneShot: true }),
          schedules: serialisedSchedules,
        }),
      });

      const json = await res.json();
      if (!res.ok) {
        setError(json.error);
        setLoading(false);
        return;
      }

      await invalidateKeys(queryClient, medicationDependentKeys);
      toast.success(t("common.saved"));
      onSuccess?.();
    } catch {
      setError(t("medications.saveError"));
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete() {
    if (!initial) return;
    setError(null);
    setDeleting(true);
    try {
      const res = await fetch(`/api/medications/${initial.id}`, {
        method: "DELETE",
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        setError(json?.error ?? t("medications.deleteError"));
        return;
      }

      await invalidateKeys(queryClient, medicationDependentKeys);
      onSuccess?.();
    } catch {
      setError(t("medications.deleteError"));
    } finally {
      setDeleting(false);
    }
  }

  async function handlePurge() {
    if (!initial) return;
    setError(null);
    setPurging(true);
    try {
      const res = await fetch(`/api/medications/${initial.id}/intake/purge`, {
        method: "DELETE",
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        setError(json?.error ?? t("medications.purgeError"));
        return;
      }

      await invalidateKeys(queryClient, medicationDependentKeys);
      setPurgeDialogOpen(false);
    } catch {
      setError(t("medications.purgeError"));
    } finally {
      setPurging(false);
    }
  }

  return (
    <form id={formId} onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="med-name">{t("medications.name")}</Label>
        <Input
          id="med-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("medications.namePlaceholder")}
          required
          maxLength={100}
          enterKeyHint="next"
          autoCapitalize="words"
          autoComplete="off"
          aria-required="true"
          aria-invalid={!!error || undefined}
          aria-describedby={errorDescriptor}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="med-category">{t("medications.formType")}</Label>
        <Select value={category} onValueChange={setCategory}>
          <SelectTrigger id="med-category" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="BLOOD_PRESSURE">
              {t("medications.categoryBloodPressure")}
            </SelectItem>
            <SelectItem value="VITAMIN">
              {t("medications.categoryVitamin")}
            </SelectItem>
            <SelectItem value="SUPPLEMENT">
              {t("medications.categorySupplement")}
            </SelectItem>
            <SelectItem value="PAIN_RELIEF">
              {t("medications.categoryPainRelief")}
            </SelectItem>
            <SelectItem value="ALLERGY">
              {t("medications.categoryAllergy")}
            </SelectItem>
            <SelectItem value="DIGESTIVE">
              {t("medications.categoryDigestive")}
            </SelectItem>
            <SelectItem value="THYROID">
              {t("medications.categoryThyroid")}
            </SelectItem>
            <SelectItem value="HORMONE">
              {t("medications.categoryHormone")}
            </SelectItem>
            <SelectItem value="SKIN">
              {t("medications.categorySkin")}
            </SelectItem>
            <SelectItem value="SLEEP_AID">
              {t("medications.categorySleepAid")}
            </SelectItem>
            <SelectItem value="OTHER">
              {t("medications.categoryOther")}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* v1.4.25 W4d — treatment-class selector. Surfaces the GLP-1
          option without crowding the existing clinical-category
          dropdown (those are orthogonal taxonomies). GENERIC keeps the
          form rendering exactly as v1.4.24; GLP1 opens the
          weekly-cadence preset + pen-inventory inputs below. */}
      <div className="space-y-1.5">
        <Label htmlFor="med-treatment-class">
          {t("medications.formTreatmentClass")}
        </Label>
        <Select value={treatmentClass} onValueChange={setTreatmentClass}>
          <SelectTrigger id="med-treatment-class" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="GENERIC">
              {t("medications.treatmentClassGeneric")}
            </SelectItem>
            <SelectItem value="GLP1">
              {t("medications.treatmentClassGlp1")}
            </SelectItem>
          </SelectContent>
        </Select>
        <p className="text-muted-foreground text-xs leading-4">
          {t("medications.formTreatmentClassHelp")}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="med-dose-amount">{t("medications.formDose")}</Label>
          <Input
            id="med-dose-amount"
            type="text"
            inputMode="decimal"
            value={doseAmount}
            onChange={(e) => setDoseAmount(e.target.value)}
            placeholder={t("medications.dosePlaceholder")}
            required
            maxLength={20}
            enterKeyHint="next"
            autoComplete="off"
            aria-required="true"
            aria-invalid={!!error || undefined}
            aria-describedby={errorDescriptor}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="med-dose-unit">{t("medications.formUnit")}</Label>
          <Input
            id="med-dose-unit"
            list="dose-units"
            value={doseUnit}
            onChange={(e) => setDoseUnit(e.target.value)}
            placeholder="mg"
            maxLength={30}
            className="w-full"
            enterKeyHint="next"
            autoComplete="off"
          />
        </div>
      </div>
      <datalist id="dose-units">
        {doseUnits.map((u) => (
          <option key={u} value={u} />
        ))}
      </datalist>

      {treatmentClass === "GLP1" && (
        <>
          {/* v1.4.25 W4d — once-weekly preset. Now writes through the
              v1.5 cadence picker (kind = "weekdays" + single BYDAY
              token) so the row stays consistent with whatever the
              user has picked in the dedicated picker below. */}
          <div className="border-border/70 bg-card/60 space-y-2.5 rounded-xl border p-3.5">
            <div className="space-y-1">
              <Label className="text-sm leading-none">
                {t("medications.glp1WeeklyPresetTitle")}
              </Label>
              <p className="text-muted-foreground text-xs leading-4">
                {t("medications.glp1WeeklyPresetHelp")}
              </p>
            </div>
            <div className="flex w-full gap-1">
              {getDayLabelsShort(t).map((label, dayIndex) => {
                const firstSchedule = schedules[0];
                const tokenForDay = (
                  ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const
                )[dayIndex];
                const isSelected =
                  firstSchedule?.cadence.kind === "weekdays" &&
                  firstSchedule.cadenceSub.weekdays.length === 1 &&
                  firstSchedule.cadenceSub.weekdays[0] === tokenForDay;
                return (
                  <button
                    key={dayIndex}
                    type="button"
                    onClick={() => applyWeeklyPreset(dayIndex)}
                    className={`h-9 flex-1 rounded-md border text-xs font-medium transition-colors ${
                      isSelected
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border/70 bg-muted text-foreground/75 hover:bg-accent hover:text-foreground"
                    }`}
                    aria-pressed={isSelected}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
            {!schedules.some(
              (s) =>
                s.cadence.kind === "weekdays" &&
                s.cadenceSub.weekdays.length === 1,
            ) && (
              <button
                type="button"
                onClick={() => applyWeeklyPreset(readLastWeeklyWeekday())}
                className="text-primary text-xs underline-offset-2 hover:underline"
              >
                {t("medications.glp1WeeklyPresetSuggest")}
              </button>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="med-doses-per-unit">
              {t("medications.glp1DosesPerUnit")}
            </Label>
            <Input
              id="med-doses-per-unit"
              type="number"
              inputMode="numeric"
              enterKeyHint="next"
              min={1}
              max={100}
              value={dosesPerUnit}
              onChange={(e) => setDosesPerUnit(e.target.value)}
              placeholder={t("medications.glp1DosesPerUnitPlaceholder")}
              aria-invalid={!!error || undefined}
              aria-describedby={errorDescriptor}
            />
            <p className="text-muted-foreground text-xs leading-4">
              {t("medications.glp1DosesPerUnitHelp")}
            </p>
          </div>
        </>
      )}

      {/* v1.5 — medication-level course window. Mirrors the wizard's
          step 6. The one-shot toggle below locks endsOn to startsOn
          and the cadence picker disappears entirely; the single dose
          time stays editable through the TimesOfDayChips singleton. */}
      <fieldset className="border-border/70 space-y-3 rounded-xl border p-3.5">
        <legend className="px-1 text-sm font-medium">
          {t(`medications.scheduling.courseWindow.section`)}
        </legend>
        <CourseWindowRow
          startsOn={startsOn}
          endsOn={endsOn}
          lockEndsToStart={oneShot}
          onChange={({ startsOn: nextStarts, endsOn: nextEnds }) => {
            setStartsOn(nextStarts);
            setEndsOn(nextEnds);
          }}
        />
        <div className="flex min-h-11 items-center gap-2">
          <Switch
            id="med-one-shot"
            checked={oneShot}
            onCheckedChange={(checked) => {
              setOneShot(checked);
              if (checked) {
                // One-shot ⇒ collapse to a single schedule with one
                // timesOfDay entry and no cadence; the picker stays
                // hidden under `!oneShot` below.
                setSchedules((prev) => {
                  const head = prev[0] ?? { ...DEFAULT_SCHEDULE };
                  const singleTime =
                    head.timesOfDay[0] ?? head.windowStart ?? "08:00";
                  return [
                    {
                      ...head,
                      timesOfDay: [singleTime],
                      cadence: {
                        kind: "oneShot",
                        rrule: null,
                        rollingIntervalDays: null,
                        oneShot: true,
                      },
                    },
                  ];
                });
                // endsOn locks to startsOn through CourseWindowRow's
                // `lockEndsToStart` prop; mirror it locally too so the
                // submit pulls the right value.
                setEndsOn(startsOn);
              }
            }}
            aria-label={t(`medications.scheduling.oneShot.section`)}
          />
          <Label htmlFor="med-one-shot" className="text-sm">
            {t(`medications.scheduling.oneShot.section`)}
          </Label>
        </div>
      </fieldset>

      <div className="space-y-2">
        <div className="flex h-8 items-center justify-between">
          <Label className="text-sm leading-none">
            {t("medications.formSchedule")}
          </Label>
          {!oneShot && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="min-h-11"
              onClick={addSchedule}
            >
              <Plus className="mr-1 h-3.5 w-3.5" />
              {t("medications.newSchedule")}
            </Button>
          )}
        </div>

        {schedules.map((s, i) => (
          <div
            key={i}
            className="bg-card border-border/70 space-y-3 rounded-xl border p-3.5"
          >
            <div className="flex items-center justify-between">
              <p className="flex-1 pr-2 pl-1 text-xs leading-5 break-words">
                <span className="font-medium">
                  {s.label.trim() ||
                    `${t("medications.formSchedule")} ${i + 1}`}
                </span>
              </p>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-11 w-11"
                    aria-label={t("common.moreOptions")}
                  >
                    <MoreVertical className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {schedules.length > 1 && (
                    <DropdownMenuItem
                      variant="destructive"
                      onClick={() => removeSchedule(i)}
                    >
                      <Trash2 className="mr-2 h-4 w-4" />
                      {t("medications.removeSchedule")}
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label className="text-xs font-normal">
                  {t("medications.scheduleLabel")}
                </Label>
                <Input
                  value={s.label}
                  className="h-11 text-base md:text-xs"
                  onChange={(e) =>
                    patchSchedule(i, { label: e.target.value })
                  }
                  placeholder={t("medications.labelPlaceholder")}
                  maxLength={50}
                  enterKeyHint="next"
                  autoCapitalize="sentences"
                  autoComplete="off"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-normal">
                  {t("medications.dose")}
                </Label>
                <Input
                  value={s.dose}
                  className="h-11 text-base md:text-xs"
                  onChange={(e) =>
                    patchSchedule(i, { dose: e.target.value })
                  }
                  placeholder={dose || t("medications.defaultDose")}
                  maxLength={50}
                  enterKeyHint="done"
                  autoComplete="off"
                />
              </div>
            </div>

            {/* v1.5 — Cadence picker. Hidden when oneShot is on; the
                course-window row above already carries the single
                dose date in that case. */}
            {!oneShot && (
              <div className="space-y-2">
                <Label className="text-sm">
                  {t(`medications.scheduling.cadence.section`)}
                </Label>
                <CadencePicker
                  value={s.cadence}
                  subControls={s.cadenceSub}
                  onChange={(nextValue, nextSub) =>
                    patchSchedule(i, {
                      cadence: nextValue,
                      cadenceSub: nextSub,
                    })
                  }
                />
              </div>
            )}

            {/* v1.5 — Times-of-day chips. Single time picker when
                oneShot is on; multi-chip otherwise. */}
            <div className="space-y-2">
              <Label className="text-sm">
                {t(`medications.scheduling.timesOfDay.section`)}
              </Label>
              <TimesOfDayChips
                value={s.timesOfDay}
                maxChips={oneShot ? 1 : 8}
                onChange={(next) => {
                  // Keep the legacy window mirror in sync so the
                  // route's dual-write still has values to persist.
                  const win = deriveLegacyWindow(
                    next,
                    s.windowStart,
                    s.windowEnd,
                  );
                  patchScheduleAndResort(i, {
                    timesOfDay: next,
                    windowStart: win.windowStart,
                    windowEnd: win.windowEnd,
                  });
                }}
              />
            </div>

            {/* Legacy reminder-window fallback — surfaced only for
                schedules loaded with no v1.5 fields populated. The
                migration backfills `timesOfDay = [windowStart]` so
                this section disappears for every row that has gone
                through the v1.5 migration. */}
            {s.legacyOnLoad && (
              <div className="border-border/60 mt-1 space-y-2 border-t pt-3">
                <Label className="text-xs font-normal">
                  {t(`medications.scheduling.legacyWindow.section`)}
                </Label>
                <p className="text-muted-foreground text-xs leading-4">
                  {t(`medications.scheduling.legacyWindow.help`)}
                </p>
                <div className="grid items-end gap-2 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label className="text-xs font-normal">
                      {t("medications.scheduleFrom")}
                    </Label>
                    <Input
                      type="time"
                      enterKeyHint="next"
                      placeholder="08:00"
                      value={s.windowStart}
                      className="h-11 text-base md:text-xs"
                      onChange={(e) => {
                        const nextStart = e.target.value;
                        // Keep timesOfDay in sync — the legacy field
                        // is the source-of-truth while the schedule
                        // is still in legacyOnLoad mode.
                        patchScheduleAndResort(i, {
                          windowStart: nextStart,
                          timesOfDay: addTime(
                            s.timesOfDay.length > 0 ? s.timesOfDay : [],
                            nextStart,
                            8,
                          ),
                        });
                      }}
                      maxLength={5}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-xs font-normal">
                      {t("medications.scheduleTo")}
                    </Label>
                    <Input
                      type="time"
                      enterKeyHint="next"
                      placeholder="09:00"
                      value={s.windowEnd}
                      className="h-11 text-base md:text-xs"
                      onChange={(e) =>
                        patchSchedule(i, { windowEnd: e.target.value })
                      }
                      maxLength={5}
                    />
                  </div>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      {error && (
        <div
          id={errorId}
          role="alert"
          aria-live="assertive"
          className="bg-destructive/10 text-destructive rounded-lg p-3 text-sm"
        >
          {error}
        </div>
      )}

      {(() => {
        const footerNode = (
          <div className="flex w-full items-center justify-between gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="h-11 w-11"
                  disabled={loading || deleting}
                  aria-label={t("common.moreOptions")}
                >
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {isEdit ? (
                  <>
                    {editActions && (
                      <>
                        <DropdownMenuItem onClick={editActions.onImportIntakes}>
                          <Upload className="mr-2 h-4 w-4" />
                          {t("medications.importIntakesAction")}
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={editActions.onApiAccess}>
                          <Terminal className="mr-2 h-4 w-4" />
                          {t("medications.apiEndpointAction")}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => setPhaseConfigOpen(true)}
                        >
                          <Clock className="mr-2 h-4 w-4" />
                          {t("medications.phaseConfig")}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                      </>
                    )}
                    <DropdownMenuItem
                      onClick={() => setActive((prev) => !prev)}
                    >
                      {active ? (
                        <Pause className="mr-2 h-4 w-4" />
                      ) : (
                        <Play className="mr-2 h-4 w-4" />
                      )}
                      {active
                        ? t("medications.pause")
                        : t("medications.activate")}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() =>
                        setNotificationsEnabled((prev) => !prev)
                      }
                    >
                      {notificationsEnabled ? (
                        <BellOff className="mr-2 h-4 w-4" />
                      ) : (
                        <Bell className="mr-2 h-4 w-4" />
                      )}
                      {notificationsEnabled
                        ? t("medications.disableNotifications")
                        : t("medications.enableNotifications")}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      variant="destructive"
                      onClick={() => setPurgeDialogOpen(true)}
                    >
                      <Eraser className="mr-2 h-4 w-4" />
                      {t("medications.purgeRecords")}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      variant="destructive"
                      onClick={() => setDeleteDialogOpen(true)}
                    >
                      <Trash2 className="mr-2 h-4 w-4" />
                      {t("common.delete")}
                    </DropdownMenuItem>
                  </>
                ) : (
                  <DropdownMenuItem onClick={resetCreateForm}>
                    <RotateCcw className="mr-2 h-4 w-4" />
                    {t("medications.formReset")}
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>

            <div className="flex items-center gap-2">
              {onCancel && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={onCancel}
                  disabled={loading || deleting}
                >
                  {t("common.cancel")}
                </Button>
              )}
              <Button
                type="submit"
                form={formId}
                disabled={loading || deleting}
              >
                {loading && (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" />
                )}
                {isEdit
                  ? t("common.save")
                  : t("medications.createMedication")}
              </Button>
            </div>
          </div>
        );
        return footerSlot ? createPortal(footerNode, footerSlot) : footerNode;
      })()}

      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("medications.deleteConfirm")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("medications.deleteConfirmDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={handleDelete}
            >
              {t("common.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={purgeDialogOpen} onOpenChange={setPurgeDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("medications.purgeConfirmTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("medications.purgeConfirmDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={purging}>
              {t("common.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={handlePurge}
              disabled={purging}
            >
              {purging ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" />
              ) : null}
              {t("medications.purgeRecords")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {isEdit && initial?.id && (
        <PhaseConfigDialog
          medicationId={initial.id}
          open={phaseConfigOpen}
          onOpenChange={setPhaseConfigOpen}
        />
      )}
    </form>
  );
}

/**
 * Format a Date as YYYY-MM-DD using its UTC components — matches the
 * encoding the route layer parses via `z.iso.date()` and avoids the
 * cross-timezone drift that `toISOString().slice(0, 10)` introduces
 * for users east of UTC.
 */
function toIsoDateOnly(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
