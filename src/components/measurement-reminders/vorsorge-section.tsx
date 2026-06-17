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
import { CalendarClock, CheckCircle2, Plus, Settings2 } from "lucide-react";

import { useFormatters, useTranslations } from "@/lib/i18n/context";
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
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { MeasurementForm } from "@/components/measurements/measurement-form";
import { MedicationCardHeader } from "@/components/medications/MedicationCardHeader";
import { MedicationNextLastSlot } from "@/components/medications/card-parts/medication-next-last-slot";
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

  // `null` = sheet closed; "new" = create; a reminder = edit pre-filled.
  const [editing, setEditing] = useState<MeasurementReminder | "new" | null>(
    null,
  );
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  // The customize ("wrench") sheet — re-homes the per-reminder enable
  // toggles that no longer live on the card itself.
  const [manageOpen, setManageOpen] = useState(false);
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

  // The shared primary add-entry affordance — identical in both variants.
  const addButton = (
    <Button
      type="button"
      className="min-h-11 shrink-0 sm:min-h-9"
      onClick={openCreate}
    >
      <Plus className="h-4 w-4" />
      {t("measurementReminders.addButton")}
    </Button>
  );

  // v1.18.2 — wrench/customize affordance, mirroring the labs page: a
  // ghost icon button beside Add opening the manage sheet.
  const wrenchButton = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="min-h-11 min-w-11 sm:min-h-9 sm:min-w-9"
          aria-label={t("common.moreOptions")}
        >
          <MoreVertical className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuItem onClick={() => setManageOpen(true)}>
          <Settings2 className="mr-2 h-4 w-4" />
          {t("measurementReminders.manage.menuItem")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <section aria-labelledby="vorsorge-section-title" className="space-y-4">
      {variant === "page" ? (
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1
              id="vorsorge-section-title"
              className="text-2xl font-bold tracking-tight"
            >
              {t("measurementReminders.sectionTitle")}
            </h1>
            <p className="text-muted-foreground text-xs sm:text-sm">
              {t("measurementReminders.sectionDescription")}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {addButton}
            {wrenchButton}
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

      {/* v1.18.2 — customize sheet: re-homes the per-reminder enable/disable
          toggles (moved off the card so it carries a single med-style kebab). */}
      <ResponsiveSheet
        open={manageOpen}
        onOpenChange={setManageOpen}
        title={t("measurementReminders.manage.title")}
        description={t("measurementReminders.manage.description")}
      >
        {(reminders?.length ?? 0) === 0 ? (
          <p className="text-muted-foreground text-sm">
            {t("measurementReminders.manage.empty")}
          </p>
        ) : (
          <ul className="space-y-2">
            {reminders?.map((reminder) => (
              <li
                key={reminder.id}
                className="flex items-center justify-between gap-3 rounded-md border p-3"
              >
                <span className="min-w-0 truncate text-sm">
                  {resolveReminderLabel(reminder, t)}
                </span>
                <Switch
                  checked={reminder.enabled}
                  onCheckedChange={(next) =>
                    update.mutate({ id: reminder.id, body: { enabled: next } })
                  }
                  disabled={update.isPending}
                  aria-label={t("measurementReminders.enabledToggleAria")}
                />
              </li>
            ))}
          </ul>
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
              {t("measurementReminders.addButton")}
            </Button>
          }
        />
      )}

      {!isLoading && (reminders?.length ?? 0) > 0 && (
        <ul className="grid list-none gap-4 p-0 sm:grid-cols-2">
          {reminders?.map((reminder) => (
            <li key={reminder.id} className="contents">
              <VorsorgeCard
                reminder={reminder}
                now={now}
                onPrimaryAction={() => onPrimaryAction(reminder)}
                onRemove={() => remove.mutate(reminder.id)}
                onEdit={() => openEdit(reminder)}
                busy={
                  satisfy.isPending || remove.isPending || update.isPending
                }
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function VorsorgeCard({
  reminder,
  now,
  onPrimaryAction,
  onRemove,
  onEdit,
  busy,
}: {
  reminder: MeasurementReminder;
  now: number;
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

  // Category-style header badge: the measurement label, or "self-planned"
  // for a free-text exam — mirroring the medication card's class badge.
  const categoryLabel = isLinked
    ? t(`measurementReminders.types.${reminder.measurementType}`)
    : t("measurementReminders.selfPlanned");

  const stateBadges =
    isCoach || !reminder.enabled ? (
      <>
        {isCoach && (
          <Badge variant="outline">
            {t("measurementReminders.originCoach")}
          </Badge>
        )}
        {!reminder.enabled && (
          <Badge variant="outline">
            {t("measurementReminders.disabledBadge")}
          </Badge>
        )}
      </>
    ) : null;

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

  // Next/last block in the med-card grammar. The "next" value carries the
  // discreet neutral due badge + cadence; the "last" value is the last
  // satisfied date.
  const nextValue = (
    <span className="inline-flex flex-wrap items-center justify-end gap-x-2 gap-y-1">
      <Badge variant="secondary">
        {t(`measurementReminders.${due.key}`, { days: due.days })}
      </Badge>
      {cadence && <span className="text-muted-foreground">{cadence}</span>}
    </span>
  );
  const lastValue = reminder.lastSatisfiedAt
    ? fmt.date(new Date(reminder.lastSatisfiedAt))
    : null;

  return (
    <>
    {/* NEUTRAL card — no status-driven colour. Due state reads only through
        the discreet badge below. Shares the medication card shell + tokens. */}
    <Card className="h-full gap-3 md:gap-3">
      <MedicationCardHeader
        name={resolveReminderLabel(reminder, t)}
        dose=""
        categoryLabel={categoryLabel}
        stateBadges={stateBadges}
        actions={headerActions}
      />
      <CardContent className="flex h-full flex-col space-y-3.5">
        <MedicationNextLastSlot next={nextValue} last={lastValue} />

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

        {/* Bottom-pinned single primary action — branches on the link state:
            a self-planned exam marks done; a measurement-linked reminder
            opens the value-entry form. */}
        <div className="mt-auto pt-0">
          <Button
            type="button"
            className="min-h-11 w-full"
            onClick={onPrimaryAction}
            disabled={busy}
          >
            {isLinked ? (
              <>
                <Plus className="h-4 w-4" />
                {t("measurementReminders.captureValue")}
              </>
            ) : (
              <>
                <CheckCircle2 className="h-4 w-4" />
                {t("measurementReminders.markDone")}
              </>
            )}
          </Button>
        </div>
      </CardContent>
    </Card>

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
    </>
  );
}
