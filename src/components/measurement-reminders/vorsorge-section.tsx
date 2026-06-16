"use client";

/**
 * v1.17.1 — Vorsorge (preventive-care / measurement) reminder surface.
 *
 * Answers "wann muss ich was wo machen": a list of upcoming reminders
 * sorted by server-computed next-due, each card showing the label, the
 * cadence, the location, and a relative next-due badge. Per the project
 * rule the card stays NEUTRAL regardless of due state — no alarming
 * red/green tint; status reads through a discreet badge only.
 *
 * The server is authoritative for `nextDueAt`; this component renders it
 * relative to "now" but never recomputes the cadence.
 *
 * v1.18.1 — the create/edit form moved into a ResponsiveSheet with a
 * pinned Cancel/Save footer (matching Labs / Illness / Medications), an
 * Edit affordance wires the existing PATCH support, an enable/disable
 * toggle drives the `enabled` flag, and a COACH-origin reminder renders a
 * neutral provenance badge + an "until <date>" course-window line while
 * translating its i18n-key label.
 */
import { useState } from "react";
import { CalendarClock, CheckCircle2, Pencil, Plus } from "lucide-react";

import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { DeleteButton } from "@/components/data-list";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
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

interface FormState {
  label: string;
  kind: "type" | "freeText";
  measurementType: string;
  intervalDays: number;
  notifyHour: number;
  location: string;
}

const EMPTY_FORM: FormState = {
  label: "",
  kind: "type",
  measurementType: "BLOOD_PRESSURE_SYS",
  intervalDays: 7,
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
   * (`<h1>` + subtitle + primary add button) so the standalone `/vorsorge`
   * surface matches its peers (labs, mood, medications, cycle). The
   * add-entry affordance is identical in both — a primary button with a
   * `Plus` glyph that opens the create sheet.
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

  // Wall-clock anchor for the relative-due labels, captured once at mount
  // via a lazy state initializer so the impure Date.now() stays out of
  // render (the repo's purity + set-state-in-effect rules both reject the
  // alternatives). The relative labels are coarse (day granularity), so a
  // mount-time snapshot is plenty fresh.
  const [now] = useState(() => Date.now());

  const sheetOpen = editing !== null;
  const isEdit = editing !== null && editing !== "new";

  function openCreate() {
    setForm(EMPTY_FORM);
    setEditing("new");
  }

  function openEdit(reminder: MeasurementReminder) {
    setForm({
      label: resolveReminderLabel(reminder, t),
      kind: reminder.measurementType ? "type" : "freeText",
      measurementType: reminder.measurementType ?? "BLOOD_PRESSURE_SYS",
      intervalDays: reminder.intervalDays ?? 7,
      notifyHour: reminder.notifyHour,
      location: reminder.location ?? "",
    });
    setEditing(reminder);
  }

  function closeSheet() {
    setEditing(null);
    setForm(EMPTY_FORM);
  }

  function submit() {
    const trimmed = form.label.trim();
    if (!trimmed) return;
    const body = {
      label: trimmed,
      measurementType: form.kind === "type" ? form.measurementType : null,
      intervalDays: form.intervalDays,
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

  const saving = create.isPending || update.isPending;

  // The shared primary add-entry affordance — identical in both variants so
  // the control reads the same on the standalone page and the settings card.
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
          {addButton}
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
            grouped, scalar option lists (24 hours, a 15-type grouped metric
            list) where the OS-native picker is faster on touch and avoids a
            tall scrolling Radix popover inside the bottom-sheet. The form
            fields below stay NativeSelect by design, not drift. */}
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
                value={String(form.intervalDays)}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    intervalDays: Number(e.target.value),
                  }))
                }
              >
                {INTERVAL_PRESETS.map((days) => (
                  <option key={days} value={days}>
                    {t("measurementReminders.cadence.everyNDays", { days })}
                  </option>
                ))}
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

      {isLoading && (
        <div className="space-y-3" data-slot="vorsorge-loading">
          {Array.from({ length: 3 }, (_, i) => (
            <Card key={i} aria-hidden="true">
              <CardContent className="flex items-start justify-between gap-3">
                <div className="min-w-0 space-y-2">
                  <Skeleton className="h-4 w-40" />
                  <Skeleton className="h-3 w-28" />
                </div>
                <Skeleton className="h-8 w-24 shrink-0" />
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

      <ul className="space-y-3">
        {reminders?.map((reminder) => (
          <VorsorgeCard
            key={reminder.id}
            reminder={reminder}
            now={now}
            onSatisfy={() => satisfy.mutate(reminder.id)}
            onRemove={() => remove.mutate(reminder.id)}
            onEdit={() => openEdit(reminder)}
            onToggleEnabled={(next) =>
              update.mutate({ id: reminder.id, body: { enabled: next } })
            }
            busy={satisfy.isPending || remove.isPending || update.isPending}
          />
        ))}
      </ul>
    </section>
  );
}

function VorsorgeCard({
  reminder,
  now,
  onSatisfy,
  onRemove,
  onEdit,
  onToggleEnabled,
  busy,
}: {
  reminder: MeasurementReminder;
  now: number;
  onSatisfy: () => void;
  onRemove: () => void;
  onEdit: () => void;
  onToggleEnabled: (next: boolean) => void;
  busy: boolean;
}) {
  const { t } = useTranslations();
  const fmt = useFormatters();
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

  return (
    <li>
      {/* NEUTRAL card — no status-driven colour. The due state reads only
          through the discreet badge below. */}
      <Card>
        <CardHeader>
          <CardTitle className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
            <span className="truncate font-medium">
              {resolveReminderLabel(reminder, t)}
            </span>
            {isCoach && (
              // Neutral provenance badge — no status colour per the rule.
              <Badge variant="outline">
                {t("measurementReminders.originCoach")}
              </Badge>
            )}
            {!reminder.enabled && (
              <Badge variant="outline">
                {t("measurementReminders.disabledBadge")}
              </Badge>
            )}
          </CardTitle>
          <CardAction className="flex items-center gap-1">
            <Switch
              checked={reminder.enabled}
              onCheckedChange={onToggleEnabled}
              disabled={busy}
              aria-label={t("measurementReminders.enabledToggleAria")}
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={onSatisfy}
              disabled={busy}
              aria-label={t("measurementReminders.markDone")}
            >
              <CheckCircle2 className="mr-1 h-4 w-4" />
              {t("measurementReminders.markDone")}
            </Button>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              onClick={onEdit}
              disabled={busy}
              className="size-9"
              aria-label={t("measurementReminders.edit")}
            >
              <Pencil className="h-4 w-4" />
            </Button>
            <DeleteButton
              onConfirm={onRemove}
              title={t("measurementReminders.deleteConfirmTitle")}
              description={t("measurementReminders.deleteConfirmDescription")}
              confirmLabel={t("measurementReminders.delete")}
              className="size-9"
              iconClassName="h-4 w-4"
            />
          </CardAction>
        </CardHeader>
        <CardContent className="space-y-1">
          <p className="text-muted-foreground text-sm">
            <Badge variant="secondary" className="mr-2">
              {t(`measurementReminders.${due.key}`, { days: due.days })}
            </Badge>
            {cadence}
          </p>
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
        </CardContent>
      </Card>
    </li>
  );
}
