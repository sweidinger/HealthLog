"use client";

/* ────────────────────────────────────────────────────────────────
 * Admin OpenAI form — read-only "the operator has set this up".
 * ──────────────────────────────────────────────────────────────── */

import { useTranslations } from "@/lib/i18n/context";

export function AdminOpenAIProviderForm({
  hasAdminKey,
}: {
  hasAdminKey: boolean | undefined;
}) {
  const { t } = useTranslations();
  return (
    <div data-testid="ai-provider-config-admin-openai" className="space-y-2">
      <p className="text-sm font-medium">
        {t("settings.ai.adminOpenai.title")}
      </p>
      <p className="text-muted-foreground text-xs">
        {hasAdminKey
          ? t("settings.ai.adminOpenai.body")
          : t("settings.ai.adminOpenai.notConfigured")}
      </p>
    </div>
  );
}
