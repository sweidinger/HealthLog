/**
 * Outbound safety screen over a whole comprehensive-insight payload.
 *
 * Lives apart from the generator on purpose: it is a pure function of the
 * payload shape, both the background generator and the user-initiated POST
 * route run it before their persist, and neither should have to import the
 * other to get at it.
 *
 * What it closes. The number-grounding gate covers `dailyBriefing.paragraph`,
 * `signalsOfDay[]` and `keyFindings[]`, and it grades NUMBERS only — so a
 * digit-free "your 10-year cardiovascular risk is elevated, consider stepping
 * your dose up" passed it untouched, and `recommendations[]` / `summary` were
 * not graded at all. This screens every prose field the user can read against
 * the insights safety contracts.
 */
import type { Locale } from "@/lib/i18n/config";
import { readBriefingBlock } from "@/lib/ai/briefing-grounding";
import {
  screenModelOutput,
  INSIGHTS_CONTRACTS,
  type OutboundReason,
} from "@/lib/ai/safety/outbound-screen";

/** Every free-text field of a comprehensive payload the user can read. */
export function collectInsightProse(parsed: unknown): string[] {
  const out: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === "string" && v.trim().length > 0) out.push(v);
  };
  if (!parsed || typeof parsed !== "object") return out;
  const root = parsed as Record<string, unknown>;

  push(root.summary);
  for (const rec of Array.isArray(root.recommendations)
    ? root.recommendations
    : []) {
    if (rec && typeof rec === "object") {
      push((rec as Record<string, unknown>).text);
    }
  }

  const briefing = readBriefingBlock(parsed);
  if (briefing) {
    push(briefing.paragraph);
    for (const s of briefing.signalsOfDay ?? []) {
      push(s?.headline);
      push(s?.nudge);
      push(s?.delta);
    }
    for (const f of briefing.keyFindings ?? []) {
      push(f?.headline);
      push(f?.detail);
      push(f?.delta);
    }
  }
  return out;
}

/**
 * Screen every prose field of a payload. Returns the first tripped contract,
 * or null when the whole payload is clean.
 */
export function screenInsightPayloadProse(
  parsed: unknown,
  locale: Locale,
): OutboundReason | null {
  for (const text of collectInsightProse(parsed)) {
    const decision = screenModelOutput(text, locale, INSIGHTS_CONTRACTS);
    if (decision.block && decision.reason) return decision.reason;
  }
  return null;
}
