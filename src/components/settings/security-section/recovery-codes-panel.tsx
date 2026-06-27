"use client";

import { useState } from "react";
import { Check, Copy, Download, ShieldAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useTranslations } from "@/lib/i18n/context";

/**
 * One-time display of a freshly generated recovery-code set.
 *
 * Recovery codes are shown exactly once (the server only stores their hashes),
 * so this panel leads with an explicit "save these now" warning and offers
 * copy + download so the user cannot lose them to a closed tab. The caller
 * owns when the panel disappears (e.g. an explicit "I've saved them" action).
 */
export function RecoveryCodesPanel({ codes }: { codes: string[] }) {
  const { t } = useTranslations();
  const [copied, setCopied] = useState(false);

  const asText = codes.join("\n");

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(asText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard can be blocked (insecure context / permissions); the codes
      // stay visible and downloadable, so this is a non-fatal best-effort.
    }
  }

  function handleDownload() {
    const blob = new Blob([`${asText}\n`], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "healthlog-recovery-codes.txt";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="border-border bg-muted/30 mt-4 rounded-lg border p-4">
      <div className="text-destructive flex items-start gap-2">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
        <p className="text-sm font-medium">
          {t("settings.security.recovery.saveNow")}
        </p>
      </div>
      <p className="text-muted-foreground mt-1 text-xs">
        {t("settings.security.recovery.saveNowHint")}
      </p>
      <ul
        className="mt-3 grid grid-cols-2 gap-2 font-mono text-sm"
        data-testid="recovery-codes"
      >
        {codes.map((code) => (
          <li
            key={code}
            className="border-border bg-background rounded border px-2 py-1.5 text-center tracking-wider"
          >
            {code}
          </li>
        ))}
      </ul>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="min-h-9"
          onClick={handleCopy}
        >
          {copied ? (
            <Check className="h-3.5 w-3.5" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
          {copied ? t("common.copied") : t("common.copy")}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="min-h-9"
          onClick={handleDownload}
        >
          <Download className="h-3.5 w-3.5" />
          {t("settings.security.recovery.download")}
        </Button>
      </div>
    </div>
  );
}
