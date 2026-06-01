"use client";

import { useState } from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { InjectionSitePicker } from "@/components/medications/injection-site-picker";
import {
  effectiveAllowedSites,
  type InjectionSiteKey,
} from "@/lib/medications/injection-sites";
import { useTranslations } from "@/lib/i18n/context";

/**
 * v1.8.5 — post-dose injection-site capture.
 *
 * Shown after a taken dose for a medication with
 * `deliveryForm === "INJECTION"` and `trackInjectionSites === true`. The
 * capture is OPTIONAL and always skippable — closing or "skip" records
 * no site, the dose stays logged regardless. The picker is constrained
 * to the medication's effective allowed set (per-medication allowed sites
 * minus the user's global exclusion), and the rotation suggestion runs
 * within that set.
 */
interface LogInjectionSiteDialogProps {
  open: boolean;
  medicationName: string;
  /** Per-medication allowed / preferred sites ([] = no restriction). */
  allowedInjectionSites: ReadonlyArray<InjectionSiteKey>;
  /** User-level global exclusion deny-list. */
  globalExcludedInjectionSites: ReadonlyArray<InjectionSiteKey>;
  /** Recent rotation history (most recent first) for the dashed-ring hint. */
  history: ReadonlyArray<InjectionSiteKey>;
  /** Submit the chosen site (the parent PATCHes it onto the intake). */
  onConfirm: (site: InjectionSiteKey) => void;
  /** Dismiss without recording a site (the dose stays taken). */
  onSkip: () => void;
}

export function LogInjectionSiteDialog({
  open,
  medicationName,
  allowedInjectionSites,
  globalExcludedInjectionSites,
  history,
  onConfirm,
  onSkip,
}: LogInjectionSiteDialogProps) {
  const { t } = useTranslations();
  const [selected, setSelected] = useState<InjectionSiteKey | null>(null);

  const allowed = effectiveAllowedSites(
    allowedInjectionSites,
    globalExcludedInjectionSites,
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onSkip();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("medications.logInjectionSiteTitle")}</DialogTitle>
          <DialogDescription>
            {t("medications.logInjectionSiteDescription", {
              name: medicationName,
            })}
          </DialogDescription>
        </DialogHeader>

        {allowed.length === 0 ? (
          <p className="text-muted-foreground py-4 text-center text-sm">
            {t("medications.logInjectionSiteNoneAvailable")}
          </p>
        ) : (
          <InjectionSitePicker
            value={selected}
            history={history}
            allowed={allowed}
            onChange={setSelected}
          />
        )}

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" onClick={onSkip}>
            {t("medications.logInjectionSiteSkip")}
          </Button>
          <Button
            disabled={selected === null}
            onClick={() => {
              if (selected !== null) onConfirm(selected);
            }}
          >
            {t("medications.logInjectionSiteConfirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
