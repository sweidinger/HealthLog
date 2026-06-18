"use client";

/**
 * v1.18.6 (W8 / MOD-03) — the Vorsorge module's own settings page body.
 *
 * Reached from the wrench beside the page's "hinzufügen" button. Lets the
 * user reorder reminders + pick the card-vs-list page view, and re-homes the
 * per-reminder enable/disable toggles that used to live in the page's
 * "Anpassen" sheet. Order + view persist client-side via
 * `useModuleListPrefs("vorsorge")`; the toggles persist through the existing
 * reminder PATCH route.
 */
import { Card, CardContent } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { useTranslations } from "@/lib/i18n/context";
import { ModuleViewToggle } from "@/components/module-list/module-view-toggle";
import {
  ModuleOrderEditor,
  type ReorderItem,
} from "@/components/module-list/module-order-editor";
import { applyOrder, useModuleListPrefs } from "@/lib/module-list-prefs";
import {
  useMeasurementReminders,
  useMeasurementReminderMutations,
  type MeasurementReminder,
} from "@/hooks/use-measurement-reminders";

function resolveLabel(
  reminder: MeasurementReminder,
  t: (key: string) => string,
): string {
  if (reminder.origin === "COACH") {
    const translated = t(reminder.label);
    return translated === reminder.label ? reminder.label : translated;
  }
  return reminder.label;
}

export function VorsorgeSettings() {
  const { t } = useTranslations();
  const { data: reminders, isLoading } = useMeasurementReminders(true);
  const { update } = useMeasurementReminderMutations();
  const { prefs, setView, setOrder } = useModuleListPrefs("vorsorge");

  const ordered = applyOrder(reminders ?? [], prefs.order, (r) => r.id);
  const reorderItems: ReorderItem[] = ordered.map((r) => ({
    id: r.id,
    name: resolveLabel(r, t),
    secondary: r.measurementType
      ? t(`measurementReminders.types.${r.measurementType}`)
      : t("measurementReminders.selfPlanned"),
  }));

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold">{t("moduleList.viewHeading")}</h2>
          <ModuleViewToggle view={prefs.view} onChange={setView} />
        </div>
        <p className="text-muted-foreground text-sm">
          {t("moduleList.viewDescription")}
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">
          {t("moduleList.reorder.heading")}
        </h2>
        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : (
          <ModuleOrderEditor items={reorderItems} onChange={setOrder} />
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">
          {t("measurementReminders.manage.title")}
        </h2>
        <p className="text-muted-foreground text-sm">
          {t("measurementReminders.manage.description")}
        </p>
        {isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : (reminders?.length ?? 0) === 0 ? (
          <p className="text-muted-foreground text-sm">
            {t("measurementReminders.manage.empty")}
          </p>
        ) : (
          <Card>
            <CardContent className="divide-border divide-y p-0">
              {ordered.map((reminder) => (
                <div
                  key={reminder.id}
                  className="flex items-center justify-between gap-3 px-4 py-3"
                >
                  <span className="min-w-0 truncate text-sm">
                    {resolveLabel(reminder, t)}
                  </span>
                  <Switch
                    checked={reminder.enabled}
                    onCheckedChange={(next) =>
                      update.mutate({
                        id: reminder.id,
                        body: { enabled: next },
                      })
                    }
                    disabled={update.isPending}
                    aria-label={t("measurementReminders.enabledToggleAria")}
                  />
                </div>
              ))}
            </CardContent>
          </Card>
        )}
      </section>
    </div>
  );
}
