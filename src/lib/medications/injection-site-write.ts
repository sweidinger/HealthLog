/**
 * v1.8.5 — server-side guard for the injection-site write path.
 *
 * The intake routes (`POST /api/medications/[id]/intake`,
 * `POST /api/medications/intake`, `POST /api/medications/intake/bulk`)
 * accept an optional `injectionSite` and must only ever persist it when:
 *
 *   1. the medication is an INJECTION (`deliveryForm === "INJECTION"`),
 *   2. site-tracking is enabled on the medication
 *      (`trackInjectionSites === true`),
 *   3. the dose is being recorded as TAKEN (never on a skip),
 *   4. the submitted site is a member of the medication's EFFECTIVE
 *      allowed set — the per-medication `allowedInjectionSites` minus the
 *      user's `globalExcludedInjectionSites` deny-list (deny wins).
 *
 * A submitted site that fails (1)–(3) is silently dropped (the dose still
 * records, the column stays NULL). A site that fails (4) — a disallowed
 * value — is a hard validation error the route surfaces as 422, because
 * the client should never offer a site outside the effective set; a
 * request that does is either stale UI or a hand-rolled call.
 */
import {
  effectiveAllowedSites,
  type InjectionSiteKey,
} from "@/lib/medications/injection-sites";

export interface ResolveInjectionSiteInput {
  /** The submitted site, or null/undefined when the client omitted it. */
  submitted: InjectionSiteKey | null | undefined;
  /** True only for a taken (non-skipped) write. */
  taken: boolean;
  /** The medication's delivery form. */
  deliveryForm: string;
  /** The medication's per-medication tracking opt-in. */
  trackInjectionSites: boolean;
  /** The medication's per-medication allowed / preferred sites. */
  allowedInjectionSites: ReadonlyArray<InjectionSiteKey>;
  /** The user's global exclusion deny-list. */
  globalExcludedInjectionSites: ReadonlyArray<InjectionSiteKey>;
}

export type ResolveInjectionSiteResult =
  | { kind: "ok"; site: InjectionSiteKey | null }
  | { kind: "disallowed"; site: InjectionSiteKey };

/**
 * Resolve the site to persist for an intake write, or report that the
 * submitted site is disallowed.
 *
 *   - `{ kind: "ok", site: null }`  → persist NULL (no site recorded);
 *     covers an omitted site, a skip, a non-injection / tracking-off med.
 *   - `{ kind: "ok", site }`        → persist the validated site.
 *   - `{ kind: "disallowed", site }`→ the route returns 422.
 */
export function resolveInjectionSiteForWrite(
  input: ResolveInjectionSiteInput,
): ResolveInjectionSiteResult {
  const { submitted, taken, deliveryForm, trackInjectionSites } = input;

  // No site submitted, or the write is not a taken-injection on a
  // tracking-enabled medication → never persist a site.
  if (
    submitted == null ||
    !taken ||
    deliveryForm !== "INJECTION" ||
    !trackInjectionSites
  ) {
    return { kind: "ok", site: null };
  }

  const allowed = effectiveAllowedSites(
    input.allowedInjectionSites,
    input.globalExcludedInjectionSites,
  );
  if (!allowed.includes(submitted)) {
    return { kind: "disallowed", site: submitted };
  }
  return { kind: "ok", site: submitted };
}
