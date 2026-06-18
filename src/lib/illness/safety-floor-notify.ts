/**
 * Absolute safety-floor escalation push (v1.18.6).
 *
 * Bridges a {@link SafetyFloorDecision} (from `safety-floors.ts`, already
 * confirm-gated) to the notification dispatcher at the URGENT level, reusing
 * the same urgent SYSTEM_ALERT + 24h-dedup mechanics as the illness red-flag
 * push (`red-flag-notify.ts`).
 *
 * Copy framing (firm, safety-reviewed):
 *   - NEVER diagnoses (no "hypertensive emergency", no "DKA").
 *   - ASYMPTOMATIC breach → "re-check and contact your doctor" copy.
 *   - SYMPTOM-COUPLED breach → emergency copy ("call emergency services").
 *   - The body always echoes the (already re-confirmed) reading value.
 *
 * Dedup: at most one push per (user, reason) per rolling 24h window, anchored
 * on a synthetic `pushAttempt` row keyed by reason — so a user re-checking a
 * stubbornly-high reading repeatedly doesn't get spammed. Owner-scoped, never
 * throws (a notification failure must not break the measurement write).
 */
import { prisma } from "@/lib/db";
import { getEvent } from "@/lib/logging/context";
import { dispatchLocalisedNotification } from "@/lib/notifications/dispatch-localised";
import type {
  SafetyFloorDecision,
  SafetyFloorReason,
} from "@/lib/illness/safety-floors";

/** One escalation per (user, reason) per this window. */
const DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Stable ledger reason prefix so the dedupe lookup is exact-matchable. */
const LEDGER_REASON_PREFIX = "safety_floor:";

/**
 * The i18n title/body keys for a decision. Two body variants per reason: the
 * asymptomatic "contact your doctor" copy and the symptom-coupled emergency
 * copy. Every key below resolves in all six locale bundles (i18n integrity
 * guarantee enforced by the locale-integrity test).
 */
function copyKeysFor(decision: SafetyFloorDecision): {
  titleKey: string;
  messageKey: string;
} {
  const variant = decision.symptomCoupled ? "Emergency" : "Doctor";
  const reasonKey: Record<SafetyFloorReason, string> = {
    bp_hypertensive: "bpHigh",
    bp_hypotensive: "bpLow",
    glucose_hypo: "glucoseLow",
    glucose_hypo_severe: "glucoseLowSevere",
    glucose_hyper: "glucoseHigh",
  };
  return {
    titleKey: `safety.floor.${reasonKey[decision.reason]}Title`,
    messageKey: `safety.floor.${reasonKey[decision.reason]}${variant}`,
  };
}

/** Body params — the re-confirmed reading value(s) echoed into the copy. */
function paramsFor(
  decision: SafetyFloorDecision,
): Record<string, string | number> {
  if (decision.kind === "BLOOD_PRESSURE") {
    return {
      systolic: decision.value,
      diastolic: decision.diastolic ?? 0,
    };
  }
  return { value: decision.value };
}

/**
 * Emit an urgent escalation push for a confirmed safety-floor breach, at most
 * once per (user, reason) per `DEDUPE_WINDOW_MS`. No-op when `decision` is
 * null. Never throws.
 */
export async function notifySafetyFloor(input: {
  userId: string;
  decision: SafetyFloorDecision | null;
}): Promise<void> {
  const { userId, decision } = input;
  if (!decision) return;

  try {
    const reason = `${LEDGER_REASON_PREFIX}${decision.reason}`;
    const since = new Date(Date.now() - DEDUPE_WINDOW_MS);
    const prior = await prisma.pushAttempt.findFirst({
      where: { userId, reason, createdAt: { gte: since } },
      select: { id: true },
    });
    if (prior) return;

    // Stamp the ledger BEFORE dispatching so a concurrent confirm can't
    // double-fire. The senders write their own per-channel rows; this
    // synthetic row is purely the dedupe anchor.
    await prisma.pushAttempt.create({
      data: {
        userId,
        channel: "WEB_PUSH",
        eventType: "SYSTEM_ALERT",
        result: "skipped",
        reason,
      },
    });

    const { titleKey, messageKey } = copyKeysFor(decision);
    await dispatchLocalisedNotification({
      userId,
      titleKey,
      messageKey,
      params: paramsFor(decision),
      eventType: "SYSTEM_ALERT",
      urgent: true,
    });

    getEvent()?.addMeta("safety_floor_notified", decision.reason);
  } catch (err) {
    getEvent()?.addWarning(
      `safety-floor notify failed (${decision.reason}): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
