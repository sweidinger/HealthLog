"use client";

/**
 * v1.18.1 — the "new episode" capture sheet. A calm, minimal form: a
 * label, the broad condition type, the lifecycle, an onset date, and an
 * optional encrypted note. Retrospective-only — no prediction UI, no
 * diagnosis prompt. Neutral palette throughout.
 */
import { useState } from "react";

import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useTranslations } from "@/lib/i18n/context";

import { useCreateEpisode } from "./use-illness";
import type { IllnessLifecycle, IllnessType } from "./types";

const TYPES: IllnessType[] = [
  "INFECTION",
  "ALLERGY",
  "INJURY",
  "MENTAL_HEALTH",
  "AUTOIMMUNE",
  "CHRONIC",
  "OTHER",
];

const LIFECYCLES: IllnessLifecycle[] = [
  "ACUTE",
  "CHRONIC_ONGOING",
  "RECURRING",
];

interface NewEpisodeSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  today: string;
}

export function NewEpisodeSheet({
  open,
  onOpenChange,
  today,
}: NewEpisodeSheetProps) {
  const { t } = useTranslations();
  const create = useCreateEpisode();

  const [label, setLabel] = useState("");
  const [type, setType] = useState<IllnessType>("INFECTION");
  const [lifecycle, setLifecycle] = useState<IllnessLifecycle>("ACUTE");
  const [onset, setOnset] = useState(today);
  const [note, setNote] = useState("");

  // Reset the form each time the sheet opens — adjusted during render keyed
  // on the open transition (React's recommended alternative to a
  // setState-in-effect).
  const [wasOpen, setWasOpen] = useState(false);
  if (open && !wasOpen) {
    setWasOpen(true);
    setLabel("");
    setType("INFECTION");
    setLifecycle("ACUTE");
    setOnset(today);
    setNote("");
  } else if (!open && wasOpen) {
    setWasOpen(false);
  }

  async function handleSave() {
    if (label.trim() === "") return;
    try {
      await create.mutateAsync({
        label: label.trim(),
        type,
        lifecycle,
        // Anchor the date string to local noon so the UTC instant lands on
        // the intended calendar day regardless of the viewer's offset.
        onsetAt: new Date(`${onset}T12:00:00`).toISOString(),
        note: note.trim() === "" ? null : note,
      });
      onOpenChange(false);
    } catch {
      // Keep the sheet open; the error strip reports it.
    }
  }

  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={onOpenChange}
      title={t("illness.new.title")}
      description={t("illness.new.description")}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button
            onClick={handleSave}
            disabled={create.isPending || label.trim() === ""}
          >
            {t("common.save")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="illness-label">{t("illness.new.label")}</Label>
          <Input
            id="illness-label"
            value={label}
            maxLength={120}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={t("illness.new.labelPlaceholder")}
          />
        </div>

        <div className="space-y-1.5">
          <Label>{t("illness.new.type")}</Label>
          <Select value={type} onValueChange={(v) => setType(v as IllnessType)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TYPES.map((value) => (
                <SelectItem key={value} value={value}>
                  {t(`illness.type.${value}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label>{t("illness.new.lifecycle")}</Label>
          <Select
            value={lifecycle}
            onValueChange={(v) => setLifecycle(v as IllnessLifecycle)}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LIFECYCLES.map((value) => (
                <SelectItem key={value} value={value}>
                  {t(`illness.lifecycle.${value}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="illness-onset">{t("illness.new.onset")}</Label>
          <Input
            id="illness-onset"
            type="date"
            value={onset}
            max={today}
            onChange={(e) => setOnset(e.target.value)}
            className="max-w-44"
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="illness-note">{t("illness.new.note")}</Label>
          <Textarea
            id="illness-note"
            value={note}
            maxLength={2000}
            onChange={(e) => setNote(e.target.value)}
            placeholder={t("illness.new.notePlaceholder")}
            rows={3}
          />
        </div>

        {create.isError ? (
          <p className="text-destructive text-sm" role="alert">
            {t("illness.new.saveError")}
          </p>
        ) : null}
      </div>
    </ResponsiveSheet>
  );
}
