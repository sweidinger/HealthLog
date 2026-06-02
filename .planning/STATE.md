# State log — where we are now

Status: **v1.9.0 shipping** — on branch `release/v1.9.0`, Draft PR #240 → `main`,
about to tag + docker-publish + deploy.
Last update: 2026-06-02

> Single trunk: `main` is always releasable. `develop` is retired (archived as the
> tag `archive/develop-pre-v1.5`; never recreate it). Releases cut on a short-lived
> `release/vX.Y.Z` branch → PR → merge → tag → `docker-publish.yml` → manual deploy →
> verify `/api/version` on every target. See CLAUDE.md for the full model.

---

## v1.9.0 — what it carries

Insights time-ranges + period-over-period deltas, deeper mood insights, medication
drug-coding into the FHIR export, an advanced-settings rebuild, an inline-targets
move, and a stability fix to the connection pool.

### Added

- **Selectable time ranges on the Insights pages** — week / month / quarter / year
  range pills per metric, with a period-over-period delta (the change in the average,
  stated plainly with its direction).
- **Deeper mood insights** — time-of-day pattern (highest / lowest), a stability read,
  and correlation cards against weight and blood pressure. Every correlation is
  paired-n gated (only shown when there are enough paired days to mean anything).
- **Standard drug codes on a medication** — an optional ATC and RxNorm code (entered,
  never guessed; migration `0103` adds the nullable `atc_code` / `rxnorm_code`).
  These flow into the health-record export: the `MedicationStatement` codes the drug
  with the WHO ATC system + RxNorm alongside the plain name, and the export adds a
  `MedicationAdministration` for every dose actually taken or skipped.
- **`scripts/assert-deploy.ts`** — a deploy-verification script that checks a target
  reports the expected version after a release.

### Changed

- **Medication advanced-settings page rebuilt** — import / intake-import / export in
  their own group; the external-API endpoints listed one by one with collapsible
  request examples; tidier layout.
- **Targets edited inline** — the standalone `/targets` page is retired; a metric's
  target range is set from the metric itself.
- **Health-record export emits insurer Coverage from a bare KVNR** (not only with a
  full insurer organisation present) and carries a top-level Composition narrative
  summary.

### Fixed

- **App stays responsive under load** — `DB_CONNECTION_LIMIT` is now sized for real
  concurrency (the 9 default could starve while a background insight warm and a
  foreground request competed, surfacing as the self-recovering "server not
  responding"); tunable for larger self-hosts.
- **Background insight warm decoupled + sync-burst invalidation debounced** — a warm
  no longer blocks a page, and a burst of Apple Health / Withings sync no longer
  triggers a storm of regenerations.
- **Medication card rows hold an equal height** ("last dose" / "next dose" alignment).
- **Glucose entered in mmol/L converts correctly** in the editor.
- **Scrollbar-gutter reserved** — admin + global layout no longer shifts when a
  scrollbar appears.
- **Six legacy `*-status` routes documented** in the OpenAPI contract.

---

## What is live (the release arc since v1.4.23)

Coarse summary; CHANGELOG.md is the accurate per-release record.

- **v1.4.24 → v1.4.50** — perf + rollup tiers (measurement / mood / compliance /
  cumulative-sum rollups, read-swap with live fallback, auto-converging boot
  backfill), APNs delivery + per-channel test endpoint + `push_attempts` ledger,
  server-side reminder suppression (`clientManaged`), self-healing stale-shell after
  deploy, full localisation push, MoodLog reverse-sync.
- **v1.5.x** — native iOS client public beta + Apple Health sync (`POST /api/measurements/batch`,
  per-day cumulative `stats:` overwrite), medication scheduling (RRULE / rolling /
  one-shot lifecycle, creation wizard → modal-dialog compose-mode), per-day-cumulative
  step consolidation, `safeFetch` egress hardening, self-hosted avatar storage,
  `SESSION_COOKIE_SECURE` plumbed through compose.
- **v1.6.0** — medication editor overhaul + route of administration (`deliveryForm`,
  migration `0088` ORAL backfill), one-time injection, today-tile read-flip onto the
  canonical recurrence engine, profile-photo upload.
- **v1.7.x** — health-record export (enriched PDF + HL7 FHIR R4 bundle), PRN + cyclic
  schedules, unified dashboard snapshot + nightly insight pre-generation, offline sync
  delta feed (tombstones), full HealthKit chart coverage + display-unit preference,
  Coach data clustering, multi-time compliance fixes.
- **v1.8.x** — Insights big release (reliable data-driven assessments, graded
  compression, embedded targets, explainers, English slugs + tile-id aliases),
  multi-time compliance, one-intake-row-per-dose-slot medical fix, injection-site
  tracking, FHIR codesystem for HealthKit-only metrics, FHIR `Coverage`, instant
  assessments (stale-while-revalidate), GLP-1 blood-level chart.
- **v1.8.7.1** — a plain-language assessment on every HealthKit metric page (~30
  metrics), one-tap pre-generation of every assessment.

apps01 + demo are LIVE on the latest tag; v1.9.0 deploy is pending the tag.

---

## Deferred set (carry-forward from v1.9.0)

| Item | Where it goes | Note |
|---|---|---|
| Derived / synthesized wellness metrics | **v1.10.0** | per-metric Vitals dashboard first, then composites with coverage/confidence gating. Plans in `.planning/v1.10-derived-metrics-PROPOSAL.md` + `.planning/v1.9.1-derived-metrics-IMPLEMENTATION-PLAN.md` (targeted at v1.10.0) + `.planning/v1.10-research/*`. |
| Docs / provenance audit | **v1.10.0** | docs site + in-repo `docs/` + README + OpenAPI drifted across the v1.8.x → v1.9.0 arc; audit + continue, and surface every derived metric's sources via the explainer pattern. Requirement: `.planning/v1.10-research/REQUIREMENT-docs-and-provenance.md`. |
| Discoverability / growth workstream | **v1.10.0** | standing alongside the derived-metrics milestone. |
| BYOK AI fallback | open | resilience gap — no provider fallback is configured, so a single provider outage stalls assessment generation. |
| `MedicationAdministration` per-export cap tuning | open | the per-dose administration emission needs a sensible cap for high-volume histories. |
| SNOMED route / site upgrade | open | route-of-administration + injection-site could carry SNOMED codes rather than the current local enum. |
| German bfarm ATC URI behind a locale toggle | open | the export codes ATC against the WHO system; a German deployment may prefer the bfarm URI — gate behind a locale toggle. |

---

## Next milestone — v1.10.0

Derived / synthesized wellness metrics, honest on the daily-snapshot data HealthLog
actually stores; full provenance + standards-linking; full docs audit;
discoverability / growth. See `ROADMAP.md`.
</content>
</invoke>
