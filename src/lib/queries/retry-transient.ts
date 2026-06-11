import { ApiError } from "@/lib/api/api-fetch";

/**
 * Shared TanStack `retry` predicate for the shell-critical cells
 * (`useAuth`, `useDashboardSnapshot`): ONE retry on transport-level
 * failures (network `TypeError`, abort/timeout `DOMException`) and on
 * 5xx, never on a 4xx. A 401/403 is a real answer — retrying it only
 * delays the redirect / empty-state decision — while a single transient
 * blip used to flip the shell straight to the redirect spinner or flash
 * the full-dashboard empty state under the former `retry: false`.
 */
export function retryOnceOnTransientError(
  failureCount: number,
  error: unknown,
): boolean {
  if (failureCount >= 1) return false;
  if (error instanceof ApiError) return error.status >= 500;
  return true;
}
