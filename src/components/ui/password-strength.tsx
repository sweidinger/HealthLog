"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { translateZxcvbn } from "@/lib/zxcvbn-de";

interface PasswordStrengthProps {
  password: string;
  minLength?: number;
}

const SCORE_CONFIG = [
  { label: "Sehr schwach", color: "bg-red-500", textColor: "text-red-500" },
  { label: "Schwach", color: "bg-orange-500", textColor: "text-orange-500" },
  {
    label: "Akzeptabel",
    color: "bg-yellow-500",
    textColor: "text-yellow-500",
  },
  { label: "Stark", color: "bg-green-500", textColor: "text-green-500" },
  {
    label: "Sehr stark",
    color: "bg-emerald-600",
    textColor: "text-emerald-600",
  },
];

export function PasswordStrength({
  password,
  minLength = 12,
}: PasswordStrengthProps) {
  const [result, setResult] = useState<{
    score: number;
    feedback: { warning: string; suggestions: string[] };
  } | null>(null);
  const zxcvbnRef = useRef<typeof import("zxcvbn-typescript").default | null>(
    null,
  );

  useEffect(() => {
    if (!password) {
      setResult(null);
      return;
    }
    let cancelled = false;
    (async () => {
      if (!zxcvbnRef.current) {
        const mod = await import("zxcvbn-typescript");
        zxcvbnRef.current = mod.default;
      }
      if (!cancelled) {
        setResult(zxcvbnRef.current(password));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [password]);

  if (!password) return null;

  const score = result?.score ?? 0;
  const config = SCORE_CONFIG[score];
  const tooShort = password.length < minLength;

  // Collect feedback
  const feedback: string[] = [];
  if (tooShort) {
    feedback.push(`Mindestens ${minLength} Zeichen erforderlich.`);
  }
  if (result?.feedback.warning) {
    feedback.push(translateZxcvbn(result.feedback.warning));
  }
  if (result?.feedback.suggestions) {
    feedback.push(...result.feedback.suggestions.map(translateZxcvbn));
  }

  return (
    <div className="space-y-1.5">
      {/* Bar segments */}
      <div className="flex gap-1">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className={cn(
              "h-1.5 flex-1 rounded-full transition-colors",
              i <= score && !tooShort ? config.color : "bg-muted",
            )}
          />
        ))}
      </div>

      {/* Label */}
      <div className="flex items-center justify-between">
        <span className={cn("text-xs font-medium", config.textColor)}>
          {tooShort ? "Zu kurz" : config.label}
        </span>
        <span className="text-muted-foreground text-xs">
          {password.length}/{minLength}+ Zeichen
        </span>
      </div>

      {/* Feedback */}
      {feedback.length > 0 && (
        <ul className="text-muted-foreground space-y-0.5 text-xs">
          {feedback.map((f, i) => (
            <li key={i}>• {f}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
