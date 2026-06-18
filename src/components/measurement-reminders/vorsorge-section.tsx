"use client";

/**
 * v1.17.1 — Vorsorge (preventive-care / measurement) reminder surface.
 *
 * Answers "wann muss ich was wo machen": a grid of upcoming reminders
 * sorted by server-computed next-due, each rendered as its OWN card that
 * mirrors the medication card grammar (neutral surface, header + kebab,
 * a next/last block, and a single bottom-pinned action). Per the project
 * rule the card stays NEUTRAL regardless of due state — no alarming
 * red/green tint; status reads through a discreet badge only.
 *
 * The server is authoritative for `nextDueAt`; this component renders it
 * relative to "now" but never recomputes the cadence.
 *
 * v1.18.2 — rebuilt to mirror the MEDICATION module:
 *   - each reminder is its own med-styled card (`VorsorgeCard`) reusing
 *     `MedicationCardHeader` / `MedicationNextLastSlot` and the
 *     `MedicationIntakeActions` bottom-pinned action treatment;
 *   - the mark-done action branches on `measurementType`: a free-text /
 *     self-planned exam keeps the silent satisfy ("Erledigt"); a
 *     measurement-linked reminder opens the real `MeasurementForm`
 *     ("Wert erfassen") so completing a BP reminder lands an actual
 *     reading, then satisfies the reminder in the same user action;
 *   - the create/edit form gains a first-due date (`anchorDate`) and a
 *     custom cadence (free "every N days" + an RFC-5545 RRULE option);
 *   - a wrench/customize affordance sits beside the page-variant Add,
 *     hosting the per-reminder enable/disable toggles (moved off the
 *     card so the card carries a single med-style kebab).
 */
import { useState } from "react";
import Link from "next/link";
import {
  Activity,
  CalendarClock,
  CheckCircle2,
  Plus,
  Wrench,
} from "lucide-react";

import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";
import { applyOrder, useModuleListPrefs } from "@/lib/module-list-prefs";
import { ModuleTourTrigger } from "@/components/onboarding/module-tour-trigger";
import { SettingsCardHeader } from "@/components/settings/_card-header";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MoreVertical, Pencil, Trash2 } from "lucide-react";
import { NativeSelect } from "@/components/ui/native-select";
import { Progress } from "@/components/ui/progress";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { MeasurementForm } from "@/components/measurements/measurement-form";
import { MedicationCardHeader } from "@/components/medications/MedicationCardHeader";
import {
  useMeasurementReminders,
  useMeasurementReminderMutations,
  type MeasurementReminder,
} from "@/hooks/use-measurement-reminders";

// v1.18.1 (V3) — the active-measurement set, grouped so the dropdown
// doesn't read as a flat 15-item list. Mirrors the Zod allow-list in
// `validations/measurement-reminders.ts`; the labels resolve through
// `measurementReminders.types.*`, the group headers through
// `measurementReminders.typeGroups.*`.
const TYPE_GROUPS = [
  {
    group: "vitals",
    types: [
      "WEIGHT",
      "BLOOD_PRESSURE_SYS",
      "PULSE",
      "BLOOD_GLUCOSE",
      "OXYGEN_SATURATION",
      "BODY_TEMPERATURE",
    ],
  },
  {
    group: "bodyComposition",
    types: [
      "BODY_FAT",
      "FAT_MASS",
      "FAT_FREE_MASS",
      "MUSCLE_MASS",
      "LEAN_BODY_MASS",
      "BONE_MASS",
      "TOTAL_BODY_WATER",
      "VISCERAL_FAT",
      "BODY_MASS_INDEX",
    ],
  },
] as const;

const INTERVAL_PRESETS = [7, 14, 30, 90, 180, 365] as const;
// v1.18.2 — the sentinel the cadence picker writes when the user wants a
// free interval or an RFC-5545 RRULE instead of a fixed preset.
const CADENCE_CUSTOM = "custom";
const CADENCE_RRULE = "rrule";
const DAY_MS = 24 * 60 * 60 * 1000;

function relativeDueKey(
  nextDueAt: string | null,
  now: number,
): { key: string; days: number } {
  if (!nextDueAt) return { key: "nextDue.none", days: 0 };
  const due = new Date(nextDueAt).getTime();
  // Compare calendar-day deltas so "today" / "in 1 day" read cleanly.
  const deltaDays = Math.round((due - now) / DAY_MS);
  if (deltaDays < 0) return { key: "overdueByDays", days: Math.abs(deltaDays) };
  if (deltaDays === 0) return { key: "nextDue.today", days: 0 };
  if (deltaDays === 1) return { key: "nextDue.tomorrow", days: 1 };
  return { key: "nextDue.inDays", days: deltaDays };
}

/**
 * v1.18.1 — a COACH-minted reminder stores an i18n KEY in `label` (the
 * cadence preset's `labelKey`), not free prose. Resolve it through `t()`;
 * a user-created (VORSORGE) reminder carries free text and renders verbatim.
 */
function resolveReminderLabel(
  reminder: MeasurementReminder,
  t: (key: string) => string,
): string {
  if (reminder.origin === "COACH") {
    const translated = t(reminder.label);
    // `t()` echoes the key back on a miss; fall back to the raw value so a
    // future catalog addition never surfaces a bare key.
    return translated === reminder.label ? reminder.label : translated;
  }
  return reminder.label;
}

/** ISO instant → the `<input type="date">` value (YYYY-MM-DD), local. */
function toDateInputValue(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const offset = d.getTimezoneOffset();
  return new Date(d.getTime() - offset * 60 * 1000).toISOString().slice(0, 10);
}

/** `<input type="date">` value → an ISO instant at local midnight, or null. */
function fromDateInputValue(value: string): string | null {
  if (!value) return null;
  const d = new Date(`${value}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

interface FormState {
  label: string;
  kind: "type" | "freeText";
  measurementType: string;
  /** A preset number-as-string, or the CADENCE_CUSTOM / CADENCE_RRULE sentinel. */
  cadenceChoice: string;
  /** Free "every N days" value, used when cadenceChoice === CADENCE_CUSTOM. */
  customIntervalDays: number;
  /** Raw RRULE, used when cadenceChoice === CADENCE_RRULE. */
  rrule: string;
  /** First-due date (YYYY-MM-DD), optional. Maps to `anchorDate`. */
  anchorDate: string;
  notifyHour: number;
  location: string;
}

const EMPTY_FORM: FormState = {
  label: "",
  kind: "type",
  measurementType: "BLOOD_PRESSURE_SYS",
  cadenceChoice: "7",
  customIntervalDays: 30,
  rrule: "FREQ=YEARLY",
  anchorDate: "",
  notifyHour: 9,
  location: "",
};

export function VorsorgeSection({
  enabled = true,
  variant = "settings",
}: {
  enabled?: boolean;
  /**
   * `"settings"` renders the compact `SettingsCardHeader` for the embedded
   * settings card; `"page"` renders the canonical feature-page header
   * (`<h1>` + subtitle + primary add button + wrench) so the standalone
   * `/vorsorge` surface matches its peers (labs, mood, medications, cycle).
   */
  variant?: "settings" | "page";
}) {
  const { t } = useTranslations();
  const { data: reminders, isLoading } = useMeasurementReminders(enabled);
  const { create, update, remove, satisfy } =
    useMeasurementReminderMutations();
  // v1.18.6 (MOD-03) — page view (cards/list) + manual order persist
  // client-side; the settings page writes them, the page reads them.
  const { prefs } = useModuleListPrefs("vorsorge");

  // `null` = sheet closed; "new" = create; a reminder = edit pre-filled.
  const [editing, setEditing] = useState<MeasurementReminder | "new" | null>(
    null,
  );
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  // The value-capture sheet: holds the reminder whose measurement we are
  // entering. Non-null ⇒ the MeasurementForm sheet is open for that row.
  const [capturing, setCapturing] = useState<MeasurementReminder | null>(null);
  const [captureFooterEl, setCaptureFooterEl] =
    useState<HTMLDivElement | null>(null);

  // Wall-clock anchor for the relative-due labels, captured once at mount
  // via a lazy state initializer so the impure Date.now() stays out of
  // render. The relative labels are coarse (day granularity), so a
  // mount-time snapshot is plenty fresh.
  const [now] = useState(() => Date.now());

  const sheetOpen = editing !== null;
  const isEdit = editing !== null && editing !== "new";

  function openCreate() {
    setForm(EMPTY_FORM);
    setEditing("new");
  }

  function openEdit(reminder: MeasurementReminder) {
    // Resolve the stored cadence back onto the picker: a preset value if it
    // matches one, otherwise the custom-interval or RRULE branch.
    const interval = reminder.intervalDays;
    const cadenceChoice = reminder.rrule
      ? CADENCE_RRULE
      : interval != null &&
          (INTERVAL_PRESETS as readonly number[]).includes(interval)
        ? String(interval)
        : interval != null
          ? CADENCE_CUSTOM
          : "7";
    setForm({
      label: resolveReminderLabel(reminder, t),
      kind: reminder.measurementType ? "type" : "freeText",
      measurementType: reminder.measurementType ?? "BLOOD_PRESSURE_SYS",
      cadenceChoice,
      customIntervalDays:
        cadenceChoice === CADENCE_CUSTOM && interval != null ? interval : 30,
      rrule: reminder.rrule ?? "FREQ=YEARLY",
      anchorDate: toDateInputValue(reminder.anchorDate),
      notifyHour: reminder.notifyHour,
      location: reminder.location ?? "",
    });
    setEditing(reminder);
  }

  function closeSheet() {
    setEditing(null);
    setForm(EMPTY_FORM);
  }

  // Resolve the picker state to the mutually-exclusive cadence pair the
  // schema expects (exactly one of intervalDays / rrule).
  function resolveCadence(): {
    intervalDays: number | null;
    rrule: string | null;
  } {
    if (form.cadenceChoice === CADENCE_RRULE) {
      const trimmed = form.rrule.trim();
      return { intervalDays: null, rrule: trimmed || null };
    }
    if (form.cadenceChoice === CADENCE_CUSTOM) {
      return { intervalDays: form.customIntervalDays, rrule: null };
    }
    return { intervalDays: Number(form.cadenceChoice), rrule: null };
  }

  function submit() {
    const trimmed = form.label.trim();
    if (!trimmed) return;
    const { intervalDays, rrule } = resolveCadence();
    const body = {
      label: trimmed,
      measurementType: form.kind === "type" ? form.measurementType : null,
      intervalDays,
      rrule,
      anchorDate: fromDateInputValue(form.anchorDate),
      notifyHour: form.notifyHour,
      location: form.location.trim() || null,
    };
    if (isEdit) {
      update.mutate(
        { id: (editing as MeasurementReminder).id, body },
        { onSuccess: closeSheet },
      );
    } else {
      create.mutate(body, { onSuccess: closeSheet });
    }
  }

  // The mark-done action. A free-text / self-planned exam satisfies
  // silently; a measurement-linked reminder opens the real value-entry
  // form so the user logs an actual reading.
  function onPrimaryAction(reminder: MeasurementReminder) {
    if (reminder.measurementType) {
      setCapturing(reminder);
    } else {
      satisfy.mutate(reminder.id);
    }
  }

  // On a successful measurement write, satisfy the reminder in the same
  // user action (forward-only guard makes the later cron a no-op) and
  // close the sheet.
  function onCaptureSuccess() {
    const reminder = capturing;
    setCapturing(null);
    if (reminder) satisfy.mutate(reminder.id);
  }

  const saving = create.isPending || update.isPending;
  const cadenceCustom = form.cadenceChoice === CADENCE_CUSTOM;
  const cadenceRrule = form.cadenceChoice === CADENCE_RRULE;

  // v1.18.6 (MOD-02) — the primary add affordance reads "hinzufügen" like
  // every other module's add button.
  const addButton = (
    <Button
      type="button"
      className="min-h-11 shrink-0 sm:min-h-9"
      onClick={openCreate}
    >
      <Plus className="h-4 w-4" />
      {t("common.add")}
    </Button>
  );

  // v1.18.6 (MOD-01) — the wrench links to the Vorsorge settings page (view,
  // reorder, per-reminder enable toggles), left of the Add button — the
  // canonical medication-page pattern. The old kebab "Anpassen" sheet is
  // gone (MOD-07); its toggles moved to the settings page.
  const wrenchButton = (
    <Button
      asChild
      variant="ghost"
      size="icon"
      className="min-h-11 min-w-11 sm:min-h-9 sm:min-w-9"
    >
      <Link
        href="/settings/vorsorge"
        aria-label={t("measurementReminders.customize")}
        title={t("measurementReminders.customize")}
      >
        <Wrench className="h-4 w-4" aria-hidden="true" />
      </Link>
    </Button>
  );

  return (
    <section aria-labelledby="vorsorge-section-title" className="space-y-4">
      {variant === "page" ? (
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1
              id="vorsorge-section-title"
              data-tour-id="vorsorge-hero"
              className="text-2xl font-bold tracking-tight"
            >
              {t("measurementReminders.sectionTitle")}
            </h1>
            <p className="text-muted-foreground text-xs sm:text-sm">
              {t("measurementReminders.sectionDescription")}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <ModuleTourTrigger stopId="vorsorge" />
            {wrenchButton}
            {addButton}
          </div>
        </div>
      ) : (
        <SettingsCardHeader
          icon={CalendarClock}
          titleId="vorsorge-section-title"
          title={t("measurementReminders.sectionTitle")}
          description={t("measurementReminders.sectionDescription")}
          status={addButton}
        />
      )}

      <ResponsiveSheet
        open={sheetOpen}
        onOpenChange={(open) => {
          if (!open) closeSheet();
        }}
        title={t(
          isEdit
            ? "measurementReminders.form.editTitle"
            : "measurementReminders.form.createTitle",
        )}
        description={t("measurementReminders.sectionDescription")}
        footer={
          <>
            <Button type="button" variant="outline" onClick={closeSheet}>
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              onClick={submit}
              disabled={!form.label.trim() || saving}
            >
              {t("measurementReminders.form.save")}
            </Button>
          </>
        }
      >
        {/* v1.18.1 — the cadence/type/hour pickers use NativeSelect (not the
            Radix Select labs/illness use) deliberately: these are long,
            grouped, scalar option lists where the OS-native picker is faster
            on touch and avoids a tall scrolling Radix popover inside the
            bottom-sheet. The form fields stay NativeSelect by design. */}
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="vorsorge-label">
              {t("measurementReminders.form.label")}
            </Label>
            <Input
              id="vorsorge-label"
              value={form.label}
              maxLength={120}
              placeholder={t("measurementReminders.form.labelPlaceholder")}
              onChange={(e) =>
                setForm((f) => ({ ...f, label: e.target.value }))
              }
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="vorsorge-kind">
              {t("measurementReminders.form.kind")}
            </Label>
            <NativeSelect
              id="vorsorge-kind"
              value={form.kind}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  kind: e.target.value as "type" | "freeText",
                }))
              }
            >
              <option value="type">
                {t("measurementReminders.form.kindType")}
              </option>
              <option value="freeText">
                {t("measurementReminders.form.kindFreeText")}
              </option>
            </NativeSelect>
          </div>

          {form.kind === "type" && (
            <div className="space-y-2">
              <Label htmlFor="vorsorge-type">
                {t("measurementReminders.form.measurementType")}
              </Label>
              <NativeSelect
                id="vorsorge-type"
                value={form.measurementType}
                onChange={(e) =>
                  setForm((f) => ({ ...f, measurementType: e.target.value }))
                }
              >
                {TYPE_GROUPS.map(({ group, types }) => (
                  <optgroup
                    key={group}
                    label={t(`measurementReminders.typeGroups.${group}`)}
                  >
                    {types.map((type) => (
                      <option key={type} value={type}>
                        {t(`measurementReminders.types.${type}`)}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </NativeSelect>
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="vorsorge-interval">
                {t("measurementReminders.form.cadence")}
              </Label>
              <NativeSelect
                id="vorsorge-interval"
                value={form.cadenceChoice}
                onChange={(e) =>
                  setForm((f) => ({ ...f, cadenceChoice: e.target.value }))
                }
              >
                {INTERVAL_PRESETS.map((days) => (
                  <option key={days} value={String(days)}>
                    {t("measurementReminders.cadence.everyNDays", { days })}
                  </option>
                ))}
                <option value={CADENCE_CUSTOM}>
                  {t("measurementReminders.cadence.customInterval")}
                </option>
                <option value={CADENCE_RRULE}>
                  {t("measurementReminders.cadence.rruleOption")}
                </option>
              </NativeSelect>
            </div>
            <div className="space-y-2">
              <Label htmlFor="vorsorge-hour">
                {t("measurementReminders.form.notifyHour")}
              </Label>
              <NativeSelect
                id="vorsorge-hour"
                value={String(form.notifyHour)}
                onChange={(e) =>
                  setForm((f) => ({ ...f, notifyHour: Number(e.target.value) }))
                }
              >
                {Array.from({ length: 24 }, (_, h) => (
                  <option key={h} value={h}>
                    {`${h.toString().padStart(2, "0")}:00`}
                  </option>
                ))}
              </NativeSelect>
            </div>
          </div>

          {cadenceCustom && (
            <div className="space-y-2">
              <Label htmlFor="vorsorge-custom-interval">
                {t("measurementReminders.form.customInterval")}
              </Label>
              <Input
                id="vorsorge-custom-interval"
                type="number"
                min={1}
                max={3650}
                value={form.customIntervalDays}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    customIntervalDays: Number(e.target.value),
                  }))
                }
              />
            </div>
          )}

          {cadenceRrule && (
            <div className="space-y-2">
              <Label htmlFor="vorsorge-rrule">
                {t("measurementReminders.form.rrule")}
              </Label>
              <Input
                id="vorsorge-rrule"
                value={form.rrule}
                maxLength={512}
                placeholder="FREQ=YEARLY"
                onChange={(e) =>
                  setForm((f) => ({ ...f, rrule: e.target.value }))
                }
              />
              <p className="text-muted-foreground text-xs">
                {t("measurementReminders.form.rruleHint")}
              </p>
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="vorsorge-anchor">
              {t("measurementReminders.form.firstDue")}
            </Label>
            <Input
              id="vorsorge-anchor"
              type="date"
              value={form.anchorDate}
              onChange={(e) =>
                setForm((f) => ({ ...f, anchorDate: e.target.value }))
              }
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="vorsorge-location">
              {t("measurementReminders.form.location")}
            </Label>
            <Input
              id="vorsorge-location"
              value={form.location}
              maxLength={200}
              placeholder={t("measurementReminders.form.locationPlaceholder")}
              onChange={(e) =>
                setForm((f) => ({ ...f, location: e.target.value }))
              }
            />
          </div>
        </div>
      </ResponsiveSheet>

      {/* v1.18.2 — value-capture sheet: a measurement-linked reminder opens
          the real MeasurementForm pre-filled with its type, so completing a
          BP reminder logs an actual reading. On success the reminder is
          satisfied in the same action. */}
      <ResponsiveSheet
        open={capturing !== null}
        onOpenChange={(open) => {
          if (!open) setCapturing(null);
        }}
        title={t("measurementReminders.capture.title")}
        description={t("measurementReminders.capture.description")}
        footer={<div ref={setCaptureFooterEl} className="flex w-full" />}
      >
        {capturing && (
          <MeasurementForm
            defaultType={capturing.measurementType ?? undefined}
            onSuccess={onCaptureSuccess}
            onCancel={() => setCapturing(null)}
            footerSlot={captureFooterEl}
          />
        )}
      </ResponsiveSheet>

      {isLoading && (
        <div
          className="grid gap-4 sm:grid-cols-2"
          data-slot="vorsorge-loading"
        >
          {Array.from({ length: 4 }, (_, i) => (
            <Card key={i} aria-hidden="true" className="h-full gap-3">
              <CardContent className="space-y-3">
                <Skeleton className="h-5 w-40" />
                <Skeleton className="h-4 w-28" />
                <Skeleton className="h-11 w-full" />
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {!isLoading && (reminders?.length ?? 0) === 0 && (
        <EmptyState
          icon={<Plus className="size-6" />}
          title={t("measurementReminders.empty.title")}
          description={t("measurementReminders.empty.description")}
          action={
            <Button type="button" onClick={openCreate}>
              {t("common.add")}
            </Button>
          }
        />
      )}

      {!isLoading && (reminders?.length ?? 0) > 0 && (
        <ul
          className={
            prefs.view === "list"
              ? "list-none space-y-2 p-0"
              : "grid list-none gap-4 p-0 sm:grid-cols-2"
          }
        >
          {applyOrder(reminders ?? [], prefs.order, (r) => r.id).map(
            (reminder) => (
              <li key={reminder.id} className="contents">
                <VorsorgeCard
                  reminder={reminder}
                  now={now}
                  view={prefs.view}
                  onPrimaryAction={() => onPrimaryAction(reminder)}
                  onRemove={() => remove.mutate(reminder.id)}
                  onEdit={() => openEdit(reminder)}
                  busy={
                    satisfy.isPending || remove.isPending || update.isPending
                  }
                />
              </li>
            ),
          )}
        </ul>
      )}
    </section>
  );
}

/**
 * v1.18.6 (MOD-06) — progress through the current interval toward the next
 * due date, as a 0–100 percentage. Honest "are we on track" gamification
 * that reuses the medication card's `Progress` building block without
 * fabricating a streak the reminder data cannot support: 100 % (or beyond)
 * means due/overdue now, lower means time still remains in the window.
 * Returns null when there is no interval to measure against (RRULE / unset).
 */
function intervalProgress(
  reminder: MeasurementReminder,
  now: number,
): number | null {
  if (reminder.intervalDays == null || reminder.nextDueAt == null) return null;
  const dueMs = new Date(reminder.nextDueAt).getTime();
  if (Number.isNaN(dueMs)) return null;
  const windowMs = reminder.intervalDays * DAY_MS;
  const startMs = dueMs - windowMs;
  const elapsed = now - startMs;
  return Math.max(0, Math.min(100, Math.round((elapsed / windowMs) * 100)));
}

function VorsorgeCard({
  reminder,
  now,
  view,
  onPrimaryAction,
  onRemove,
  onEdit,
  busy,
}: {
  reminder: MeasurementReminder;
  now: number;
  view: "cards" | "list";
  onPrimaryAction: () => void;
  onRemove: () => void;
  onEdit: () => void;
  busy: boolean;
}) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const due = relativeDueKey(reminder.nextDueAt, now);
  const cadence =
    reminder.intervalDays != null
      ? t("measurementReminders.cadence.everyNDays", {
          days: reminder.intervalDays,
        })
      : reminder.rrule
        ? t("measurementReminders.cadence.custom")
        : "";
  const isCoach = reminder.origin === "COACH";
  const isLinked = reminder.measurementType != null;
  // Due now / overdue ⇒ the action button takes the green "do it now" tone.
  // The CARD stays neutral (no tint) per the project rule — only the action
  // button goes green; the surface follows the medication-card grammar.
  const isDue =
    due.key === "nextDue.today" || due.key === "overdueByDays";
  const progress = intervalProgress(reminder, now);

  // Category-style header badge: the measurement label, or "self-planned"
  // for a free-text exam — mirroring the medication card's class badge.
  const categoryLabel = isLinked
    ? t(`measurementReminders.types.${reminder.measurementType}`)
    : t("measurementReminders.selfPlanned");

  // v1.18.6 (MOD-06) — the cadence renders as a chip beside the item name
  // (the med-card cadence-chip convention), alongside the provenance /
  // disabled state badges.
  const stateBadges = (
    <>
      {cadence && <Badge variant="secondary">{cadence}</Badge>}
      {isCoach && (
        <Badge variant="outline">{t("measurementReminders.originCoach")}</Badge>
      )}
      {!reminder.enabled && (
        <Badge variant="outline">
          {t("measurementReminders.disabledBadge")}
        </Badge>
      )}
    </>
  );

  // Single med-style kebab: Edit + Delete. The Delete item is the shared
  // confirm-on-delete control rendered as a full-width menu row.
  const headerActions = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="min-h-11 min-w-11"
          aria-label={t("common.moreOptions")}
        >
          <MoreVertical className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuItem onClick={onEdit} disabled={busy}>
          <Pencil className="mr-2 h-4 w-4" />
          {t("measurementReminders.edit")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          disabled={busy}
          onSelect={() => setConfirmDelete(true)}
        >
          <Trash2 className="mr-2 h-4 w-4" />
          {t("measurementReminders.delete")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  // v1.18.6 (MOD-06) — the green "Jetzt messen" / mark-done action. Green only
  // on the action button (never the card surface). When not due it stays the
  // calm default tone so the green reads as "now is the time". `bg-success`
  // pairs with the theme-aware `text-success-foreground` (dark glyph in dark,
  // white in light) so the label clears WCAG AA in both themes.
  const primaryButton = (
    <Button
      type="button"
      className={cn(
        "min-h-11 w-full",
        isDue && "bg-success text-success-foreground hover:bg-success/90",
      )}
      onClick={onPrimaryAction}
      disabled={busy}
    >
      {isLinked ? (
        <>
          <Activity className="h-4 w-4" />
          {t("measurementReminders.measureNow")}
        </>
      ) : (
        <>
          <CheckCircle2 className="h-4 w-4" />
          {t("measurementReminders.markDone")}
        </>
      )}
    </Button>
  );

  const deleteDialog = (
    <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t("measurementReminders.deleteConfirmTitle")}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t("measurementReminders.deleteConfirmDescription")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onRemove}>
            {t("measurementReminders.delete")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  // v1.18.6 (MOD-03) — compact list row variant.
  if (view === "list") {
    return (
      <>
        <Card>
          <CardContent className="flex items-center justify-between gap-3 px-4 py-2.5">
            <div className="min-w-0 space-y-0.5">
              <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
                <span className="truncate font-medium">
                  {resolveReminderLabel(reminder, t)}
                </span>
                {cadence && <Badge variant="secondary">{cadence}</Badge>}
              </div>
              <div className="flex flex-wrap items-center gap-x-2 text-xs">
                <Badge variant="outline">
                  {t(`measurementReminders.${due.key}`, { days: due.days })}
                </Badge>
                <span className="text-muted-foreground">{categoryLabel}</span>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Button
                type="button"
                size="sm"
                className={cn(
                  "min-h-9",
                  isDue && "bg-success text-success-foreground hover:bg-success/90",
                )}
                onClick={onPrimaryAction}
                disabled={busy}
              >
                {isLinked
                  ? t("measurementReminders.measureNow")
                  : t("measurementReminders.markDone")}
              </Button>
              {headerActions}
            </div>
          </CardContent>
        </Card>
        {deleteDialog}
      </>
    );
  }

  // Next/last block in the med-card grammar, but with MEASUREMENT wording
  // (MOD-06: never "Einnahme" / intake — a measurement is not an intake). The
  // "next" value carries the discreet neutral due badge; the "last" value is
  // the last satisfied date.
  const lastValue = reminder.lastSatisfiedAt
    ? fmt.date(new Date(reminder.lastSatisfiedAt))
    : null;
  const nextLastSlot = (
    <div className="min-h-[2.75rem] space-y-1.5 text-sm">
      <div className="text-muted-foreground flex items-baseline justify-between gap-3">
        <span className="min-w-0 flex-shrink truncate font-medium">
          {t("measurementReminders.nextDueLabel")}
        </span>
        <span className="text-right">
          <Badge variant="secondary">
            {t(`measurementReminders.${due.key}`, { days: due.days })}
          </Badge>
        </span>
      </div>
      {lastValue && (
        <div className="text-muted-foreground flex items-baseline justify-between gap-3">
          <span className="min-w-0 flex-shrink truncate font-medium">
            {t("measurementReminders.lastDoneLabel")}
          </span>
          <span className="text-foreground text-right">{lastValue}</span>
        </div>
      )}
    </div>
  );

  return (
    <>
      {/* NEUTRAL card — no status-driven colour. Due state reads only through
          the discreet badge + the green action button below (MOD-06). Shares
          the medication card shell + tokens. */}
      <Card className="h-full gap-3 md:gap-3">
        <MedicationCardHeader
          name={resolveReminderLabel(reminder, t)}
          dose=""
          categoryLabel={categoryLabel}
          stateBadges={stateBadges}
          actions={headerActions}
        />
        <CardContent className="flex h-full flex-col space-y-3.5">
          {nextLastSlot}

          {/* v1.18.6 (MOD-06) — light gamification: progress through the
              current interval toward next-due, reusing the medication card's
              Progress building block. Honest "on track / due" signal without
              a fabricated streak; hidden for RRULE / unscheduled reminders. */}
          {progress != null && (
            <div className="space-y-1">
              <div className="text-muted-foreground flex items-center justify-between text-xs">
                <span>{t("measurementReminders.adherence.label")}</span>
                <span className="tabular-nums">
                  {isDue
                    ? t("measurementReminders.adherence.due")
                    : t("measurementReminders.adherence.onTrack")}
                </span>
              </div>
              <Progress
                value={progress}
                aria-label={t("measurementReminders.adherence.label")}
              />
            </div>
          )}

          {reminder.endsOn && (
            <p className="text-muted-foreground text-sm">
              {t("measurementReminders.until", {
                date: fmt.date(new Date(reminder.endsOn)),
              })}
            </p>
          )}
          {reminder.location && (
            <p className="text-muted-foreground text-sm">
              {t("measurementReminders.location.prefix", {
                location: reminder.location,
              })}
            </p>
          )}

          {/* Bottom-pinned single primary action — green when due (MOD-06). */}
          <div className="mt-auto pt-0">{primaryButton}</div>
        </CardContent>
      </Card>

      {deleteDialog}
    </>
  );
}
