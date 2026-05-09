"use client";

import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";

import { Input } from "@/components/ui/input";
import { useTranslations } from "@/lib/i18n/context";

/**
 * Password input with a built-in show/hide toggle. Extracted from the legacy
 * settings monolith so every section that needs a masked secret (Withings,
 * moodLog, ntfy, Telegram, AI provider keys, account password) can share the
 * same UX without duplicating the visibility-toggle plumbing.
 */
export function PasswordInput(props: React.ComponentProps<typeof Input>) {
  const [visible, setVisible] = useState(false);
  const { t } = useTranslations();
  return (
    <div className="relative">
      <Input {...props} type={visible ? "text" : "password"} />
      <button
        type="button"
        tabIndex={-1}
        // WCAG 2.1.2 button-name — the icon-only toggle has no visible text
        // and screen readers fall back to the icon's filename otherwise.
        aria-label={
          visible ? t("common.hidePassword") : t("common.showPassword")
        }
        onClick={() => setVisible((v) => !v)}
        className="text-muted-foreground hover:text-foreground absolute top-1/2 right-3 -translate-y-1/2"
      >
        {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
    </div>
  );
}
