# HealthLog — roadmap

Current line: **v1.9.0** (shipping — Insights time-ranges, deeper mood, medication
drug-coding into FHIR, advanced-settings rebuild, connection-pool stability).
Trunk: `main`, always releasable. Release model in CLAUDE.md.

Next milestone: **v1.10.0 — derived / synthesized wellness metrics + provenance + docs**.

---

## v1.10.0 — derived metrics, provenance, docs, discoverability

The headline is derived wellness metrics that are honest on the data HealthLog
actually has — daily snapshots, not continuous streams. The governing constraint:
HRV is a single nightly SDNN value, there is no continuous HR, no EDA, no raw ECG/PPG,
and the nightly drain tombstones per-sample rows to a daily mean. So anything built on
intraday physiology is out of scope; day-scale deviation-from-personal-baseline
statistics are the sweet spot. Full synthesis in
`.planning/v1.10-derived-metrics-PROPOSAL.md`, implementation plan in
`.planning/v1.9.1-derived-metrics-IMPLEMENTATION-PLAN.md` (targeted at v1.10.0, not
1.9.1), research reports under `.planning/v1.10-research/`.

### Ordering (data-availability first)

A derived metric appears only when its required inputs exist; composites degrade
gracefully and never present a headline number secretly computed from one of N signals.
Precedent: the Personal Health Score null-redistributes missing pillars.
(`.planning/v1.10-research/DESIGN-PRINCIPLE-data-availability.md`.)

1. **Per-metric Vitals dashboard** (flagship) — each available signal shows its own
   personal-baseline card; absent signals don't render, so it scales 1→30 metrics with
   no data assumptions. Pure rolling stats over inputs we 100% have, plus a multi-signal
   early-strain flag. Build this first.
2. **Pre-computed easy wins** — age/sex-adjusted reference ranges (cross-cutting
   enabler: `dateOfBirth` / `gender` are stored but unused for norms), Fitness Age /
   cardio band from VO2max, Vascular Age framing from PWV. Render only when the device
   value exists.
3. **Composites** — Sleep Score and a Readiness / Wellness index (extending the Personal
   Health Score), each with a minimum-inputs threshold, reweighting around missing
   inputs, a visible coverage / confidence indicator, and a "track BP/HRV to sharpen
   this" nudge.
4. **Broader correlation discovery** — expand the fixed-hypothesis correlation engine
   into an FDR-controlled behaviour↔outcome discovery engine, surfacing only pairs with
   enough paired n (the existing n≥20 gate pattern).

Out of scope by construction (require sensing we deliberately don't retain): Body
Battery, all-day / real-time Stress, Strain / Training Load, a faithful Recovery score,
AFib / ECG derivation, breathing-disturbance / AHI, Oura Resilience, minute-by-minute
time-in-zone. State this plainly so we never over-promise; surface a device-computed
value as a passthrough where one exists, never re-derive it.

### Provenance / transparency (acceptance criterion, not an afterthought)

Every derived metric openly states what it's based on and links the basis:
- exact inputs + method / formula (plain-language + the math),
- why this method (rationale),
- a citation / link to the underlying authority (IEEE / RFC / WHO / LOINC /
  peer-reviewed studies / Wikipedia — whichever is right),
- confidence / limitations stated honestly (SDNN≠RMSSD, snapshot-not-continuous,
  consumer-sensor validity caveats),
- rendered through the existing collapsible provenance / explainer pattern — no
  black-box number.

Needs a shared provenance / citation data model so each derived metric carries its
sources, surfaced via the explainer component everywhere it appears.
(`.planning/v1.10-research/REQUIREMENT-docs-and-provenance.md`.)

### Documentation audit + continuation

- Audit the docs site (`healthlog-docs`), in-repo `docs/`, README, and the OpenAPI
  contract for accuracy vs the shipped state — much drifted across the v1.8.x → v1.9.0
  arc.
- Continue / extend docs to cover the new derived metrics with the same provenance:
  meaning, computation, linked standard, required data, graceful-degradation behaviour.
- This `ROADMAP.md` / `STATE.md` refresh folds into the audit.

### Discoverability / growth

A discoverability / growth workstream stands alongside the milestone (scope to be
shaped during planning).

---

## Standing deferred items

Carried forward; pick up as they become relevant or fold into a milestone.

- **BYOK AI fallback** — resilience gap: no provider fallback is configured, so a single
  provider outage stalls assessment generation.
- **`MedicationAdministration` per-export cap tuning** — the per-dose administration
  emission added in v1.9.0 needs a sensible cap for high-volume histories.
- **SNOMED route / site upgrade** — route-of-administration + injection-site could carry
  SNOMED codes rather than the current local enum.
- **German bfarm ATC URI behind a locale toggle** — the export codes ATC against the WHO
  system; a German deployment may prefer the bfarm URI.

---

## Shipped (coarse — CHANGELOG.md is the record)

- **v1.9.0** (2026-06-02) — Insights time-ranges + period-over-period deltas, deeper
  mood insights, medication ATC + RxNorm into the FHIR export (+ MedicationAdministration
  per dose, Coverage-from-bare-KVNR, Composition narrative), advanced-settings rebuild,
  inline targets (`/targets` retired), connection-pool sizing fix, decoupled insight
  warm. Migration `0103`.
- **v1.8.7.1** (2026-06-02) — assessment on every HealthKit metric page, one-tap
  pre-generation.
- **v1.8.x** (2026-05-31 → 06-02) — Insights big release (reliable assessments, graded
  compression, embedded targets, explainers, English slugs), compliance + intake-slot
  medical fixes, injection-site tracking, FHIR codesystem + Coverage, instant
  assessments, GLP-1 blood-level chart.
- **v1.7.x** (2026-05-31) — health-record PDF + FHIR R4 export, PRN + cyclic schedules,
  unified dashboard snapshot + nightly insight pre-gen, offline sync delta feed, full
  HealthKit chart coverage, Coach data clustering.
- **v1.6.0** (2026-05-30) — medication editor overhaul + route of administration,
  one-time injection, today-tile read-flip, profile-photo upload.
- **v1.5.x** (2026-05-24 → 29) — native iOS client public beta + Apple Health sync,
  medication scheduling (RRULE / rolling / one-shot), step consolidation, `safeFetch`
  egress hardening, avatar storage, `SESSION_COOKIE_SECURE` through compose.
- **v1.4.24 → v1.4.50** (2026-05-11 → 24) — rollup tiers + perf, APNs + `push_attempts`,
  reminder suppression, self-healing stale-shell, localisation, MoodLog reverse-sync.
- **v1.4.23** (2026-05-11) — pre-iOS backend foundation + hygiene (Apple Health enum +
  batch ingest + APNs scaffolding + OpenAPI generator). Earlier history archived.
</content>
