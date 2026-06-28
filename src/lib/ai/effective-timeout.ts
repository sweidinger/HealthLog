/**
 * Resolve the upstream provider timeout (ms) for a non-chat generation surface.
 *
 * The per-user `User.aiResponseTimeoutSeconds` setting (Settings → AI) is the
 * operator's lever for slow self-hosted / local backends whose first request
 * loads the model. Coach already threads it onto its provider call; the
 * generated-narrative surfaces (daily briefing, status cards, period
 * narratives, …) historically hardcoded their per-surface `AI_BUDGETS.*`
 * default and ignored the setting, so raising the timeout had no effect on
 * them. This helper is the one place that converts the stored seconds into the
 * milliseconds a `CompletionParams.timeoutMs` expects, falling back to the
 * surface's budget default when the user has not set a value.
 *
 * Semantics mirror Coach: a positive stored value wins (seconds → ms), and any
 * unset / non-positive value yields the surface default. The setting is bounded
 * to 10–600 s at write-time, so no read-time clamp is needed here.
 */
export function resolveEffectiveTimeoutMs(
  aiResponseTimeoutSeconds: number | null | undefined,
  budgetDefaultMs: number,
): number {
  return aiResponseTimeoutSeconds != null && aiResponseTimeoutSeconds > 0
    ? aiResponseTimeoutSeconds * 1000
    : budgetDefaultMs;
}
