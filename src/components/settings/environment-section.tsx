"use client";

/**
 * `<EnvironmentSection>` — Settings → Environment (v1.25, W-ENV).
 *
 * The one surface for the opt-in environmental-context module: pick a coarse
 * home location (city search → rounded lat/lon, never a GPS track), declare
 * travel overrides that win over home for their date range, and trigger a
 * backfill of past days. The nightly job keeps recent days current; the
 * correlation engine then surfaces e.g. "daylight ↔ mood" on its own.
 *
 * State source for the enabled flag is `useAuth().user.modules.environment`
 * (the resolved /auth/me map). When the module is off the section nudges the
 * user to the Modules hub rather than rendering dead controls. All reads unwrap
 * `(await res.json()).data` via the api-fetch helpers; every key routes through
 * the centralized factory.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CloudSun, MapPin, Plane, Trash2 } from "lucide-react";

import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/hooks/use-auth";
import { useTranslations } from "@/lib/i18n/context";
import { apiDelete, apiGet, apiPost, apiPut } from "@/lib/api/api-fetch";
import { queryKeys } from "@/lib/query-keys";

interface GeocodeResult {
  lat: number;
  lon: number;
  label: string;
  timezone: string;
}

interface TravelDTO {
  id: string;
  startDate: string;
  endDate: string;
  lat: number;
  lon: number;
  label: string;
}

interface EnvironmentOverview {
  home: {
    lat: number;
    lon: number;
    label: string | null;
    timezone: string;
  } | null;
  travel: TravelDTO[];
  context: {
    days: number;
    latestDate: string | null;
    latestFetchedAt: string | null;
  };
  attribution: string;
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

export function EnvironmentSection() {
  const { t } = useTranslations();
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const enabled = user?.modules?.environment === true;

  const overview = useQuery({
    queryKey: queryKeys.environment(),
    enabled,
    queryFn: () => apiGet<EnvironmentOverview>("/api/environment"),
  });

  const invalidate = () =>
    void queryClient.invalidateQueries({ queryKey: queryKeys.environment() });

  // ── geocoding search (shared by home + travel pickers) ──────────────────
  const [homeQuery, setHomeQuery] = useState("");
  const [homeResults, setHomeResults] = useState<GeocodeResult[]>([]);
  const [travelQuery, setTravelQuery] = useState("");
  const [travelResults, setTravelResults] = useState<GeocodeResult[]>([]);
  const [travelLoc, setTravelLoc] = useState<GeocodeResult | null>(null);
  const [travelStart, setTravelStart] = useState(todayKey());
  const [travelEnd, setTravelEnd] = useState(todayKey());
  const [backfillStart, setBackfillStart] = useState("");
  const [backfillEnd, setBackfillEnd] = useState(todayKey());

  const geocode = (query: string) =>
    apiGet<{ results: GeocodeResult[] }>(
      `/api/environment/geocode?q=${encodeURIComponent(query)}`,
    );

  const searchHome = useMutation({
    mutationKey: queryKeys.environmentGeocode("home"),
    mutationFn: () => geocode(homeQuery),
    onSuccess: (data) => setHomeResults(data.results),
    onError: () => toast.error(t("settings.sections.environment.searchError")),
  });

  const searchTravel = useMutation({
    mutationKey: queryKeys.environmentGeocode("travel"),
    mutationFn: () => geocode(travelQuery),
    onSuccess: (data) => setTravelResults(data.results),
    onError: () => toast.error(t("settings.sections.environment.searchError")),
  });

  const setHome = useMutation({
    mutationKey: queryKeys.environment(),
    mutationFn: (loc: GeocodeResult) =>
      apiPut("/api/environment/home", {
        lat: loc.lat,
        lon: loc.lon,
        label: loc.label,
        timezone: loc.timezone,
      }),
    onSuccess: () => {
      setHomeResults([]);
      setHomeQuery("");
      invalidate();
      toast.success(t("settings.sections.environment.homeSaved"));
    },
    onError: () => toast.error(t("settings.sections.environment.saveError")),
  });

  const addTravel = useMutation({
    mutationKey: queryKeys.environment(),
    mutationFn: () =>
      apiPost("/api/environment/travel", {
        startDate: travelStart,
        endDate: travelEnd,
        lat: travelLoc!.lat,
        lon: travelLoc!.lon,
        label: travelLoc!.label,
      }),
    onSuccess: () => {
      setTravelLoc(null);
      setTravelResults([]);
      setTravelQuery("");
      invalidate();
      toast.success(t("settings.sections.environment.travelAdded"));
    },
    onError: () => toast.error(t("settings.sections.environment.saveError")),
  });

  const removeTravel = useMutation({
    mutationKey: queryKeys.environment(),
    mutationFn: (id: string) => apiDelete(`/api/environment/travel/${id}`),
    onSuccess: () => {
      invalidate();
      toast.success(t("settings.sections.environment.travelRemoved"));
    },
    onError: () => toast.error(t("settings.sections.environment.saveError")),
  });

  const backfill = useMutation({
    mutationKey: queryKeys.environment(),
    mutationFn: () =>
      apiPost("/api/environment/backfill", {
        startDate: backfillStart,
        endDate: backfillEnd,
      }),
    onSuccess: () => {
      invalidate();
      toast.success(t("settings.sections.environment.backfillQueued"));
    },
    onError: () =>
      toast.error(t("settings.sections.environment.backfillError")),
  });

  if (!enabled) {
    return (
      <SettingsCard>
        <SettingsCardHeader
          icon={CloudSun}
          title={t("settings.sections.environment.title")}
          className="mb-2"
        />
        <p className="text-muted-foreground pl-7 text-sm leading-relaxed">
          {t("settings.sections.environment.disabledHint")}
        </p>
      </SettingsCard>
    );
  }

  const data = overview.data;
  const home = data?.home ?? null;

  return (
    <div className="space-y-6">
      {/* Home location */}
      <SettingsCard>
        <SettingsCardHeader
          icon={MapPin}
          title={t("settings.sections.environment.home.title")}
          className="mb-2"
        />
        <p className="text-muted-foreground mb-3 pl-7 text-sm leading-relaxed">
          {t("settings.sections.environment.home.description")}
        </p>
        <div className="space-y-3 pl-7">
          {home ? (
            <p className="text-sm" data-slot="environment-home-current">
              {t("settings.sections.environment.home.current", {
                label: home.label ?? `${home.lat}, ${home.lon}`,
              })}
            </p>
          ) : (
            <p className="text-muted-foreground text-sm">
              {t("settings.sections.environment.home.none")}
            </p>
          )}
          <div className="flex gap-2">
            <Input
              value={homeQuery}
              onChange={(e) => setHomeQuery(e.target.value)}
              placeholder={t("settings.sections.environment.searchPlaceholder")}
              aria-label={t("settings.sections.environment.searchPlaceholder")}
            />
            <Button
              type="button"
              variant="secondary"
              disabled={homeQuery.trim().length === 0 || searchHome.isPending}
              onClick={() => searchHome.mutate()}
            >
              {t("settings.sections.environment.search")}
            </Button>
          </div>
          {homeResults.length > 0 && (
            <ul className="divide-border divide-y rounded-md border">
              {homeResults.map((r) => (
                <li
                  key={`${r.lat},${r.lon},${r.label}`}
                  className="flex items-center justify-between gap-2 p-2"
                >
                  <span className="text-sm">{r.label}</span>
                  <Button
                    type="button"
                    size="sm"
                    disabled={setHome.isPending}
                    onClick={() => setHome.mutate(r)}
                  >
                    {t("settings.sections.environment.use")}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </SettingsCard>

      {/* Travel overrides */}
      <SettingsCard>
        <SettingsCardHeader
          icon={Plane}
          title={t("settings.sections.environment.travel.title")}
          className="mb-2"
        />
        <p className="text-muted-foreground mb-3 pl-7 text-sm leading-relaxed">
          {t("settings.sections.environment.travel.description")}
        </p>
        <div className="space-y-3 pl-7">
          {data && data.travel.length > 0 ? (
            <ul className="divide-border divide-y rounded-md border">
              {data.travel.map((tr) => (
                <li
                  key={tr.id}
                  className="flex items-center justify-between gap-2 p-2"
                >
                  <span className="text-sm">
                    {tr.label} · {tr.startDate} – {tr.endDate}
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    aria-label={t(
                      "settings.sections.environment.travel.remove",
                    )}
                    disabled={removeTravel.isPending}
                    onClick={() => removeTravel.mutate(tr.id)}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground text-sm">
              {t("settings.sections.environment.travel.none")}
            </p>
          )}

          <div className="flex gap-2">
            <Input
              value={travelQuery}
              onChange={(e) => setTravelQuery(e.target.value)}
              placeholder={t("settings.sections.environment.searchPlaceholder")}
              aria-label={t("settings.sections.environment.searchPlaceholder")}
            />
            <Button
              type="button"
              variant="secondary"
              disabled={
                travelQuery.trim().length === 0 || searchTravel.isPending
              }
              onClick={() => searchTravel.mutate()}
            >
              {t("settings.sections.environment.search")}
            </Button>
          </div>
          {travelResults.length > 0 && (
            <ul className="divide-border divide-y rounded-md border">
              {travelResults.map((r) => (
                <li
                  key={`${r.lat},${r.lon},${r.label}`}
                  className="flex items-center justify-between gap-2 p-2"
                >
                  <span className="text-sm">{r.label}</span>
                  <Button
                    type="button"
                    size="sm"
                    variant={
                      travelLoc?.label === r.label ? "default" : "secondary"
                    }
                    onClick={() => setTravelLoc(r)}
                  >
                    {t("settings.sections.environment.select")}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {travelLoc && (
            <div className="flex flex-wrap items-end gap-2">
              <div className="space-y-1">
                <Label htmlFor="env-travel-start">
                  {t("settings.sections.environment.startDate")}
                </Label>
                <Input
                  id="env-travel-start"
                  type="date"
                  value={travelStart}
                  onChange={(e) => setTravelStart(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="env-travel-end">
                  {t("settings.sections.environment.endDate")}
                </Label>
                <Input
                  id="env-travel-end"
                  type="date"
                  value={travelEnd}
                  onChange={(e) => setTravelEnd(e.target.value)}
                />
              </div>
              <Button
                type="button"
                disabled={travelStart > travelEnd || addTravel.isPending}
                onClick={() => addTravel.mutate()}
              >
                {t("settings.sections.environment.travel.add", {
                  label: travelLoc.label,
                })}
              </Button>
            </div>
          )}
        </div>
      </SettingsCard>

      {/* Backfill */}
      <SettingsCard>
        <SettingsCardHeader
          icon={CloudSun}
          title={t("settings.sections.environment.backfill.title")}
          className="mb-2"
        />
        <p className="text-muted-foreground mb-3 pl-7 text-sm leading-relaxed">
          {t("settings.sections.environment.backfill.description")}
        </p>
        <div className="flex flex-wrap items-end gap-2 pl-7">
          <div className="space-y-1">
            <Label htmlFor="env-backfill-start">
              {t("settings.sections.environment.startDate")}
            </Label>
            <Input
              id="env-backfill-start"
              type="date"
              value={backfillStart}
              onChange={(e) => setBackfillStart(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="env-backfill-end">
              {t("settings.sections.environment.endDate")}
            </Label>
            <Input
              id="env-backfill-end"
              type="date"
              value={backfillEnd}
              onChange={(e) => setBackfillEnd(e.target.value)}
            />
          </div>
          <Button
            type="button"
            disabled={
              !home ||
              backfillStart.length === 0 ||
              backfillStart > backfillEnd ||
              backfill.isPending
            }
            onClick={() => backfill.mutate()}
          >
            {t("settings.sections.environment.backfill.run")}
          </Button>
        </div>
        {data && (
          <p className="text-muted-foreground mt-3 pl-7 text-xs">
            {t("settings.sections.environment.storedDays", {
              count: data.context.days,
            })}
          </p>
        )}
      </SettingsCard>

      {/* Attribution (CC BY 4.0, required) */}
      <p className="text-muted-foreground pl-1 text-xs">
        {data?.attribution ?? "Weather data by Open-Meteo.com"}
      </p>
    </div>
  );
}
