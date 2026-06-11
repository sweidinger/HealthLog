"use client";

import { useEffect, useState } from "react";
import { UmamiScript } from "@/components/monitoring/umami-script";
import { GlitchtipReporter } from "@/components/monitoring/glitchtip-reporter";
import { apiGet } from "@/lib/api/api-fetch";

interface MonitoringSettings {
  umamiEnabled: boolean;
  umamiWebsiteId: string | null;
  glitchtipEnabled: boolean;
}

export function MonitoringBootstrap() {
  const [settings, setSettings] = useState<MonitoringSettings | null>(null);

  useEffect(() => {
    let active = true;

    apiGet<MonitoringSettings | undefined>("/api/monitoring/settings", {
      cache: "no-store",
    })
      .then((data) => {
        if (!active || !data) return;
        setSettings(data);
      })
      .catch(() => {
        if (!active) return;
        setSettings({
          umamiEnabled: false,
          umamiWebsiteId: null,
          glitchtipEnabled: false,
        });
      });

    return () => {
      active = false;
    };
  }, []);

  if (!settings) return null;

  return (
    <>
      <UmamiScript
        enabled={settings.umamiEnabled}
        websiteId={settings.umamiWebsiteId}
      />
      <GlitchtipReporter enabled={settings.glitchtipEnabled} />
    </>
  );
}
