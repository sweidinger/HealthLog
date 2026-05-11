# v1.4.22 backlog

Items deferred from the W5 reconcile pass. Carried into v1.4.23 +.

## Wave 5 reconcile carry-over

### Code review

- **Code MED-1** (`src/app/api/insights/targets/route.ts:199-216`): `sparklinePoints()` once-per-day bucket now uses Berlin tz (lifted to `src/lib/analytics/berlin-day.ts` in W5 reconcile). DST-boundary edge-case unit test added. `analytics/route.ts` now imports the shared helper. — APPLIED in W5 reconcile, kept here for trace.
- **Code MED-4** (`src/app/insights/page.tsx:1729-1747`): IntersectionObserver picks the highest-intersection entry now. — APPLIED in W5 reconcile (folded into Design-H1 commit), kept here for trace.
- **Code LOW-1** (`src/components/insights/trends-row.tsx:148`): `<MoodChart title={…} />` self-resolves a localised title; the explicit prop tightens coupling. Drop the `title` prop on all three TrendsRow callsites OR add a comment. Cosmetic only.
- **Code LOW-2** (`src/lib/ai/coach/keyvalues.ts:53`): `parseKeyValueLine` regex uses the first `:` as label/value boundary. A future prompt rev that adds a time-of-day pin would break (`"Mon 6 May, 7:30 reading: 142/88"`). Add a parser test for a colon-bearing label as a regression pin OR document the constraint in the prompt explicitly.
- **Code LOW-3** (`src/app/api/insights/chat/route.ts:284-291`): sentinel parse failure logged with `kept` count but not the prompt-version-vs-malformed-cause breakdown. Extend `SentinelParseResult` with `reason: "ok" | "no_close_marker" | "truncated" | "empty_block"`.
- **Code LOW-4** (`src/app/targets/page.tsx:272-273`): `Math.min(...points)` / `Math.max(...points)` spread-call patterns can blow stack at ~10k arguments. Replace with `for` loop or `points.reduce(...)`.
- **Code LOW-5** (`src/lib/query-keys.ts`): `["user", "dashboardWidgets"]` centralised in `queryKeys.dashboardWidgets()` in W5 reconcile, three call sites migrated. — APPLIED.

### Security review

- **Sec MED-1** (`src/lib/auth/session.ts:32`): `hl_onboarding` cookie `SameSite=Lax` → `Strict`. — APPLIED in W5 reconcile.
- **Sec MED-2** (`src/proxy.ts:28-33` + `:152`): `/onboarding` `startsWith` match tightened to exact + subroute. — APPLIED in W5 reconcile.
- **Sec LOW-1** (`/api/auth/me`): GET that mutates state (cookie write) on every call. Idempotent; review left as-is, optional comment about not growing.
- **Sec LOW-2** (Coach few-shots): synthetic numeric values baked into the system prompt. Optional `WARNING` comment so a future contributor doesn't paste real readings.
- **Sec LOW-3** (`src/app/api/insights/chat/route.ts:211-220`): transcript builder flattens role labels into a single user prompt; user-self-injection only. v1.4.23 candidate: switch to structured chat-completion payload.
- **Sec LOW-4** (`src/lib/ai/coach/keyvalues.ts:147-180`): truncated/closeMissing booleans not surfaced to wide-event meta. Extend with `truncated` / `closeMissing` for ops visibility.

### Design review

- **Design M1** (`coach-panel/message-thread.tsx:259-307`): coach evidence disclosure has no `aria-controls` / `aria-expanded` semantics; `<summary>` reports without expanded state in iOS Safari ≤ 17.3. Wrap the summary in a 36-px-min hit zone, add `aria-expanded` mirror via `useState` + `onToggle`.
- **Design M2** (`src/app/targets/page.tsx:264-303`): Sparkline has no min-points threshold guard — 3-4 points spread over 30 days reads "lots of activity". Either require `length >= 7` before painting, or render at `stroke-opacity:0.5` for `length < 10` plus a `{n} of 30 days logged` caption.
- **Design M3** (`src/components/insights/recommendation-card.tsx:328-335`): severity badge uppercase eyebrow re-introduces the v1.4.20 M4 marketing pattern AND surfaces the internal severity enum (`urgent` / `suggestion`) — no i18n. Drop `tracking-wide uppercase`, replace `{norm.severity}` with `{t(\`insights.recommendation.severity.\${norm.severity}\`)}`. Add EN/DE keys.
- **Design M4** (Coach disclaimer reach): pinned the disclaimer at the bottom of the message thread in W5 reconcile (Design-H3 fix). — APPLIED.
- **Design M5** (`src/app/insights/page.tsx:1070-1078`): row-fill rule on the medication-correlation row uses `showMoodSection` heuristic. Either hide the BP-medication card entirely when `bpMedicationScatterData.length < 5` (let mood-vs-BP take 100 %) or restore the fixed 50/50 with per-card empty state.
- **Design M6** (`dashboard-layout-section.tsx:204-241`): comparison-toggle has no live-preview affordance. Add a tiny `<TrendCard>` preview swatch under the picker.
- **Design M7** (`src/app/targets/page.tsx:286-301`): SVG sparkline `aria-hidden` skips the only "things changing" signal for SR users. Add `aria-label` to the `<TrendIcon>` parent OR move the sentiment into the delta caption prose.
- **Design L1** (i18n voice asymmetry on `coach.evidenceLabel`): EN ("What I'm looking at") declarative; DE ("Worauf bezieht sich das?") curious. Decide on a unified voice.
- **Design L2** (`coach-panel/message-thread.tsx:286-304`): React `key={\`\${kv.label}-\${idx}\`}`allows duplicate-label collisions. Use a hash of`\${label}-\${window}-\${value}`.
- **Design L3** (`targets/page.tsx:288`): sparkline `preserveAspectRatio="none"` distorts y vs x. Either keep + accept, or fix Y-range to the target range.
- **Design L4** (`scroll-mt-28` overshoot): tuned to `scroll-mt-16` in W5 reconcile (Design-H1 commit). — APPLIED.
- **Design L5** (api-tokens table date wrap): cells wrap to two lines on 1024 px. Either short-format `formatDate` + tooltip, or push `<col>` width to 14 %.

### Senior-dev review

- **Sr H1** (createSession cookie fan-out): folded into createSession in W5 reconcile. — APPLIED.
- **Sr H2** (chat route SSE construction duplicated 3×): extracted `createSseStream` helper in W5 reconcile. — APPLIED.
- **Sr M1** (analytics route fetches ALL BP measurements ever, twice): bound by horizon (5 years) OR materialise a per-user `bp_target_aggregate` row refreshed on measurement-write.
- **Sr M2** (targets route's 7-pass sparkline computation): collapse to a single Postgres-side `GROUP BY date_trunc('day', measured_at), type`.
- **Sr M3** (targets page mutates server response inside render): wrap the glucose-target conversion in `useMemo([data, t, displayGlucoseUnit])` to keep refs stable.
- **Sr M4** (`provenanceFromJson` hand-rolls keyValues validation): replace 35 lines of manual `typeof` checks with `coachKeyValueSchema.array().safeParse(parsed.keyValues)`. Same `safeParse` lift fixes the windows / metrics enum-membership gap.
- **Sr M5** (sentinel parser conflates 3 distinct malformed conditions): four-state enum (`"ok" | "truncated" | "unclosed" | "empty"`) so ops dashboards can distinguish the cases.
- **Sr L1** (`Sparkline` `preserveAspectRatio="none"`): same as Design L3.
- **Sr L2** (`setOnboardingPendingCookie` `async` but does no async work): could be sync if `cookies()` resolved by caller. v1.5 cleanup.
- **Sr L3** (`InsightsSectionNav` re-creates IntersectionObserver on every mount): single mount per page, so the practical cost is negligible — observer should move with the component on extraction.
- **Sr L4** (`as TargetItem` cast in `targets/route.ts:281`): the BP entry ships sys-only data without typing it. Pre-existing.

### Simplify review

- **S-01..S-05**: applied in W5 reconcile (single commit). — APPLIED.
- **S-M1..S-M5**: maybe-tier — leave for now; revisit when adjacent work re-touches the surfaces.

### Product Lead memo (cross-link)

- **Insights page split** held to v1.5 P5 (Apple Health work edits the same sub-trees).
- **Pearson p-value normal approximation at low df**: 30-LOC incomplete-beta or raise gate to df >= 20. Pull in v1.5 P0 before auto-discovery ships.
- **Coach token-budget UX**: 25 000 tokens/user/day = ~13 turns. iOS surface in v1.5 will multiply this. Replace generic 429 with localised "limit reached, resets at 00:00 UTC".
- **Conversation persistence eviction policy**: auto-archive after 90 days, hard-delete after 365. v1.5 P3 latest.
- **OpenAPI spec drift CI guard**: pull forward to v1.4.23 if possible.
- **CoachDrawer `key={prefill}` weaponising React keys (Sr-HIGH-4)**: heavy refactor; v1.5 P3 latest.
- **Cross-user feedback aggregation cron** (P6 in product-lead memo): wired alongside v1.5 P3 once usage volume materialises.
