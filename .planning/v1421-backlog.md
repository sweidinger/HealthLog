# v1.4.21 backlog

Carry-over from v1.4.20 marathon foundation phases. Pick from this list
when v1.4.21 starts.

## Closed in v1.4.22

The Wave-4 cleanup pass closed the following items. See
`.planning/phase-W4-report.md` for full SHAs + reasoning.

- **C1** Zielwerte sparkline + Δ-vs-last-month — landed in commit 1
- **C2** api-tokens 5th-attempt scrollbar fix — landed in commit 2
- **C3** Coolify `?force=true` + howto for the UI checkbox — landed in
  commit 3
- **C4** AuthShell post-hydration redirect → moved to proxy.ts — landed
  in commit 4
- **C5** node-26-alpine — PR #162 closed (no Dockerfile bump; Next.js
  16 still pins node 22 LTS and node:26-alpine ships without corepack)
- **F-32** triple help blocks on /settings/dashboard — landed in
  commit 5
- **F-33** mood subtitle ampersand → "und" / "and" — landed in commit 5
- **F-34** measurements subtitle ampersand → "und" / "and" — landed in
  commit 5
- **F-35** Send-test button label inconsistency — unified on the
  shorter "Send test" / "Test senden" — landed in commit 5
- **F-44** `LOKI_ENDPOINT` env-var leakage in user-facing copy — landed
  in commit 5
- **F-45** admin/users column header "Users" → "Name" (new
  `admin.userName` key) — landed in commit 5
- **F-47** /notifications event-column header collision with the page
  title — new `notifications.eventColumn` key — landed in commit 5
- **F-50** DE error-toast tone — "Bitte erneut versuchen" → "Bitte
  versuche es erneut" across six keys — landed in commit 5
- **F-58** admin/reminders icon swap (Clock → Bell to match the
  admin-shell nav) — landed in commit 5
- **F-62** DE dashboard `greetingSalutation` ("Hi" → "Hallo, {name}")
  — landed in commit 5
- **D-CR-M-03** formatTokenName regex broadened to non-Z ISO offsets
  — landed in commit 5
- **D-DSGN-M-04** moodLog "Copy" button uses `common.copy` instead of
  stripping `!` off `common.copied` — landed in commit 5
- **FX 1** 191 `Marc` source-comment references swept (test fixtures
  kept) — landed in commit 6
- **FX 2** DE+EN bilingual CHANGELOG entries (v1.4.14 + v1.4.15)
  normalised to English-only — landed in commit 6
- **FX 3** `CLAUDE.md` renamed to `CONTRIBUTING-AI.md`; `AGENTS.md`
  retained for multi-agent compatibility — landed in commit 6

The remaining MED + LOW items below either deferred to v1.4.23 (most
of the heavy reviewer findings) or stay open as a hygiene PR.

## Phase D — v1.4.20 reconcile carry-over

Items raised by the six-reviewer Phase-D pass that were either too
large for an inline reconcile or otherwise judgment-call-deferred.
HIGH and CRITICAL items all landed inline (fix counts in
`.planning/phase-D-v1420-reconcile-report.md`).

### Code review (MED + LOW carry-over)

- **Streaming auto-scroll deps brittleness** (Code-MED-01). MessageThread
  effect lists `[messages.length, streaming?.content]`; a "" → "" flip
  on a fresh stream won't fire. Add `streaming?.inProgress` or a turn
  counter to the dep list.
- **`bandFromInterval` "high" label on near-zero r** (Code-MED-02).
  A tight CI of `[-0.05, 0.10]` reads as "high confidence" alongside
  near-zero r. Demote to moderate when CI straddles zero, or rename
  the chip to "tight CI" / "wide CI".
- **Pearson p-value normal approximation** (Code-MED-03). At df=12 the
  normal approx can put true p≈0.04 at p≈0.025. Either pull in a tiny
  incomplete-beta implementation (~30 LOC) or raise the surfacing gate
  to df ≥ 20.
- **`weightTrendAlignment` ±2 kg target band** (Code-MED-04). Reuse
  `buildWeightRangeFromHeight()` so the score awards 100 across the
  user's actual band, not an arbitrary ±2 kg.
- **`bpInTargetPct` held constant for "vs last week" delta** (Code-MED-05).
  Recompute the prior-snapshot BP rate or relabel the delta line so the
  user knows BP is held constant in the comparison.
- **WeeklyReportView print spinner gate** (Code-MED-06). The 300 ms
  print timer resets on every advisor.isLoading flip. Pin the timer
  via a ref so a second-render isLoading change doesn't restart it.
- **`<TrendsRow>` confidence prop dead** (Code-MED-07). Either wire
  `analytics.correlations` confidence into the page invocation or drop
  the prop until B3.x lands the wiring.
- **`provenanceFromJson` unsafe `windows` filter cast** (Code-MED-08).
  Validate against the `WINDOW_KEYS` allow-list shared with
  `source-chips.tsx` so a poisoned legacy row can't surface as
  `t(undefined)`.
- **Storyboard category fallback paints purple** (Code-MED-09). Run
  `advisor.payload.insights.storyboardAnnotations` through
  `storyboardAnnotationsSchema.safeParse` — same shape as
  `dailyBriefing` and `trendAnnotations` already use.
- **`<HeroStrip>` greeting-key + relativetime per-render `Date()`**
  (Code-LOW-01). Memoise via `useMemo` so a chatty parent doesn't
  re-allocate on every TanStack tick.
- **Nested `<Sheet>` portals on mobile rail trays** (Code-LOW-03).
  Promote the trays to siblings of the outer drawer to avoid the
  dom-focus-trap fight on iOS Safari.
- **bpInTargetRate-constant test gap** (Code-LOW-05). Add a test that
  holds BP constant across both snapshots and verifies the delta
  reflects only the moving pillars.
- **`streamRefusal` bypasses budget meter** (Code-LOW-06). Bump
  `messageCount` (with `tokens: 0`) for refusals so the surface meter
  is honest, or rate-limit the refusal path separately.

### Security review (MED + LOW carry-over)

- **Refusal path persists messages without budget accounting**
  (Sec-M-2). Either call `checkRateLimit()` at the top of the POST
  handler before refusal scanning, or bump `messageCount` inside
  `streamRefusal()`. Same broader gap covered by Senior-MED-3.
- **Refusal patterns miss common injection synonyms** (Sec-M-3).
  Extend `INJECTION_PATTERNS` with `(forget|abandon|drop|skip|toss|
  bypass|circumvent)` paired with `(instructions?|rules?|prompt|
  guidelines?|directives?|system\s+message)`, plus a "what
  (were|are)\s+your.*(instructions|prompt|rules)" probe. Add a
  zero-width-stripping normalisation pass before regex.
- **`assistantMessage` persisted before `recordSpend()`** (Sec-M-4).
  Wrap the `appendMessage(assistant)` + `recordSpend()` pair in a
  Prisma `$transaction` so the spend ledger stays atomically
  consistent with the persisted reply.
- **`coachChatRequestSchema.conversationId` accepts any string up to
  64 chars** (Sec-L-1). Tighten to `.regex(/^c[a-z0-9]{24}$/)` or a
  generic `[A-Za-z0-9_-]{8,64}` regex.
- **Refusal-injection rail pollution** (Sec-L-3). Either skip the
  `updatedAt` bump for refusal appends or hide refusal-only
  conversations in the rail UI.
- **Smoke-test `request.clone()` against Next.js 16** (Sec-U-1).
  Add a Vitest case posting a new-conversation body and asserting the
  persisted user message matches the input. (Largely moot now that
  the chat route no longer wraps in withIdempotency, but still useful
  paranoia.)
- **Race window on `enforceBudget` between read + write** (Sec-U-2).
  Acceptable in practice (cap is per-day, not per-second). Annotate
  the race window in the route header so the next maintainer knows.

### Design review (MED + LOW carry-over)

- **Hero strip greeting clock is wall-clock, not Berlin** (Design-M1).
  Pass the current Berlin hour through `Intl.DateTimeFormat("en-CA",
  { timeZone: "Europe/Berlin", hour: "numeric" })` so a traveller
  sees the Berlin bucket the rest of the UI uses.
- **Health Score panel mobile order inversion** (Design-M3). On `<lg`
  promote the Health Score panel between the meta row and the weekly
  banner, or render a compact "score chip" inline with the meta row.
- **Coach drawer focus trap when both rail trays open** (Design-M5).
  Set the rail-tray Portal container to the parent SheetContent's ref,
  or use a `<Drawer>`-style stacked-modals primitive (`vaul` is
  already in deps).
- **Tone-bar visual clip at rounded corner** (Design-M6). Inset by
  `left-1` / `top-2 bottom-2`, or add `overflow-hidden` to the parent
  card, so the bar's straight left edge doesn't poke into the card's
  rounded corner.
- **Source chip "n=N" reads as engineering output** (Design-M8). Use
  `{count} samples` / `{count} Werte`, or drop the count on mobile
  and surface it in a tooltip.
- **Hero "personal-baseline" copy** (Design-L1). Either drop the
  generic line or surface the actual sample size ("From 187 readings
  over 90 days").
- **Health Score sub-bars paint at composite band** (Design-L2). Each
  sub-bar should derive its own band per component for visual
  fidelity.
- **Storyboard 24-char truncation has no ellipsis** (Design-L5). Add
  `…` suffix when `annotation.truncatedLabel` is shorter than the
  source label.
- **Coach composer keyboard-hint locale drift** (Design-L6).
  Reconsider the German `Umschalt+Enter` translation — the rest of
  the app uses `Shift+Enter` literal even in German.

### Senior-dev review (HIGH + MED + LOW carry-over)

- **Duplicated maths layer (Pearson + linear regression)** (Sr-HIGH-2).
  Consolidate into `src/lib/analytics/correlation.ts` (singular) +
  `src/lib/analytics/regression.ts`. Add p-value + CI as optional
  outputs on the existing `pearsonCorrelation()`. Migrate
  `correlateBpCompliance` / `correlateMoodPulse` /
  `correlateWeightWeekday` to import from analytics. The
  hypothesis-specific runners stay in `lib/insights/`.
- **`<CoachDrawer key={prefill}>` weaponises React keys for state
  reset** (Sr-HIGH-4). Make `prefill` a fully-controlled prop on
  `<CoachDrawer>`. Drop the `key=` re-mount. The drawer reads
  prefill into the textarea's `value=` and notifies up via
  `onPrefillConsumed` after submit.
- **Coach tables not in `cascade-delete.test.ts`** (Sr-MED-1). Add
  three `expect(...count(...)).toBe(0)` lines for `coachConversation`,
  `coachMessage`, `coachUsage`. Five-line patch.
- **`weeklyReport` + `storyboardAnnotations` lifted without
  `safeParse`** (Sr-MED-2). Lift through `weeklyReportSchema.safeParse`
  and `storyboardAnnotationsSchema.safeParse` in
  `useInsightsAdvisorQuery`, the same way `dailyBriefing` and
  `trendAnnotations` already do.
- **No rate-limit on `/api/insights/chat`** (Sr-MED-3). Wrap
  `handleChatRequest` in `enforceRateLimit({ key: \`coach.chat:\${userId}\`,
  max: 30, windowMs: 60_000 })`.
- **Fake streaming via `tokeniseForStreaming`** (Sr-MED-4). Wire the
  provider runner to a true streaming variant with an `onToken`
  callback. Unlocks "stop generating" as a real feature later.
- **`medication_schedules.days_of_week` schema drift** (Sr-MED-5).
  Either land the column with a backfill default or drop the field
  from `schema.prisma`. v1.4.20 worked around it twice.
- **`apiHandler`-vs-`withIdempotency` stacking** (Sr-MED-6). Largely
  moot now that the chat route doesn't wrap in idempotency, but still
  worth offering `withIdempotency(handler, { skipWhen?: (req) =>
  boolean })` for the next caller that wants to opt out conditionally.
- **`coach_usage` redundant index** (Sr-LOW-1). Drop the `@@index`
  line — the `@@unique` already builds an index.
- **`metricSourceJson` stored as `String`** (Sr-LOW-2). Migrate to
  `Jsonb`. Cheap to fix while no consumers exist.
- **Coach off-topic detector locale-mixed** (Sr-LOW-3). Tighten the
  allow + deny lists with a `defaultAllow=false` bias. v1.5 work.
- **`weeklyReport.weekISO` regex doesn't validate week 53/00**
  (Sr-LOW-4). Tighten to `^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$`. The
  route page is already strict.

### Simplify review (apply-maybe carry-over)

- **`<CoachDrawer>` slot props (`historyRail` / `sourcesRail` /
  `composer`) are dead** (S-06). The only production caller never
  passes these slots; `<CoachDrawerBody>` already exposes equivalent
  test seams. Remove the props.
- **`<CoachInput>` `inputId` prop never overridden** (S-07). Drop the
  prop and inline the default id.
- **`cloneForCheck` variable dead in chat POST handler** (S-08).
  Largely moot now (the route no longer peeks at the body before
  dispatching), but worth a quick re-read.
- **`health-score-card.tsx` delta-arrow chooser** (S-09). Compress
  three sibling `&&` blocks into a `deltaIcon` lookup. Borderline —
  judgement call for the file's owner.


## F5 — Best-practice repo audit (deferred MED + LOW)

- **README badges** (LOW). Add a small badge row: build status (GitHub
  Actions), license (AGPL-3.0), latest GHCR tag, container size,
  package-version. Today the README is content-rich but visually
  unanchored. Pure cosmetic.
- **FUNDING.yml** (optional). Skipped because no GitHub Sponsors / Ko-fi /
  OpenCollective profile is configured. Add when the maintainer enables
  one.
- **Repo-root tidy** (LOW). The root currently carries `coverage/`,
  `playwright-report/`, `test-results/` directories which are listed in
  `.gitignore` but render as empty entries during `ls -la`. No action
  needed unless a future audit re-flags.
- **`.gitignore` audit** (LOW). Inherits Next.js + standard Node patterns.
  Spot-check did not surface gaps.
- **Discussions enablement** (LOW). The new `.github/ISSUE_TEMPLATE/config.yml`
  links to `https://github.com/MBombeck/HealthLog/discussions`; verify
  that Discussions is actually enabled on the repository before v1.4.21
  ships, or remove the link.

## FX (cleanup) carry-over

- **Source-comment sweep** (LOW). `src/` has 191 `Marc` references in
  maintainer-internal source comments. Visible to anyone who clones the
  repo. Lower priority than user-rendered surfaces; schedule for a
  hygiene PR.
- **DE+EN bilingual CHANGELOG entries** (MED). v1.4.15-era entries pair
  a German sentence with its English translation by historical design.
  English-only normalisation is a larger rewrite — defer.
- **`CLAUDE.md` + `AGENTS.md` filenames** (MED). Visible at repo root.
  These document AI-agent conventions; renaming is a structural change
  with downstream link impact. Defer until a hygiene PR.

## v1.4.19 backlog passthrough (from `v1420-backlog.md`)

The v1.4.19 quality-of-life audit deferred 31 MED + 16 LOW + 4 HIGH +
4 reconcile-HIGH items into `.planning/v1420-backlog.md`. v1.4.20 picks
selectively (the redesign owns its own scope); the rest moves here on
v1.4.21 kickoff. See that file for the full list.

## Docs site audit (v1.4.19 cross-reference, deferred MED + LOW)

Audit walked all 38 pages under `healthlog-docs/src/content/docs/**`
against the live app (v1.4.19, image digest `sha256:b48f93874cdb…`),
the CHANGELOG, `.env.example`, `Dockerfile`, `docker-compose.yml`, and
`.github/workflows/docker-publish.yml`. CRITICAL + HIGH already landed
on `healthlog-docs/main` (commits `19eb8de`, `3d3ea21`). Items below
are MED + LOW and were deliberately left for a hygiene pass.

### MED — stale or imprecise but not load-bearing

- **Stale version pins in installation / docker / admin examples.**
  `getting-started/installation.mdx` and `self-hosting/docker.mdx` show
  `:1.2.0` as the pin example; `api/admin.mdx` returns `"version":
  "1.2.1"` in its sample response. Bump all three to a current `1.4.x`
  reference on the next docs sweep.
- **`architecture/database.mdx` model count + measurement-type list.**
  Page claims **22 models**; current schema has **26**. Measurement
  table also stops at the v1.2 catalogue (WEIGHT / BP_SYS / BP_DIA /
  PULSE / BODY_FAT / SLEEP_DURATION / ACTIVITY_STEPS) — needs the v1.3
  additions (BLOOD_GLUCOSE, OXYGEN_SATURATION, TOTAL_BODY_WATER,
  BONE_MASS) so the API page and the architecture page agree.
- **`architecture/background-jobs.mdx` schedule timezone.** Lists
  `Sunday 03:00 UTC` and `02:00–02:30 UTC` for the data-backup and
  insights queues. Actual schedule is **Europe/Berlin** (CLAUDE.md +
  `admin/backups.mdx` already document it correctly). Same drift in
  `features/export-import.mdx` (`Schedule: Sunday 03:00 UTC` block on
  line 96) — keep both in sync.
- **`architecture/background-jobs.mdx` job catalogue is incomplete.**
  Missing `host-metric-sampler` (v1.4.16, host CPU/mem/IO every minute)
  and `feedback-aggregator` (v1.4.16, daily 04:00 Europe/Berlin AI
  feedback rollup). Add rows for both.
- **API token hashing wording.** `architecture/overview.mdx` and
  `security/overview.mdx` describe the token store as "SHA-256 + HMAC"
  / "stored as SHA-256 + HMAC hashes". The actual algorithm is **keyed
  HMAC-SHA-256** (`API_TOKEN_HMAC_KEY` in `.env.example`,
  `src/lib/auth/hmac.ts`). The other API/integrations/external-ingest
  pages already use the correct phrasing — bring these two into line.
- **`api/insights.mdx` provider claim.** Now generic ("user's
  configured provider chain") after the v1.4.19 docs fix; the per-
  provider request/response examples could still be tightened to show
  Anthropic / Codex shapes alongside the OpenAI one. Cosmetic.
- **`api/mood.mdx` "primary UI language is German" note.** Wording
  carried over from the v1.2 era. Already corrected in
  `features/mood-tracking.mdx`; mirror the same locale-neutral
  phrasing in the API page.
- **Architecture overview i18n line** (`overview.mdx` line 105). Lists
  "Supported languages: German and English" without flagging that
  English is the codebase default. Tighten to match CLAUDE.md.
- **`features/export-import.mdx` Sunday-03:00-UTC block.** See above —
  same Berlin/UTC drift; the surrounding paragraph already hints at
  pg-boss without naming the timezone explicitly.

### LOW — wording and polish

- **`api/overview.mdx` example response includes `email` field.** The
  `/api/auth/me` route returns `gravatarUrl` and the user shape; the
  example could be refreshed to include the gravatar URL pattern that
  the `/auth/me` handler now ships.
- **`getting-started/installation.mdx` "Pin a specific version".**
  After the version-bump pass (see MED above), tighten the surrounding
  paragraph to mention SLSA + SBOM verification commands once instead
  of twice.
- **`security/overview.mdx` rate-limit table polish.** Now shows
  `10 req/h (configurable …)` for AI insights — apply the same
  configurability hint to the data-ingest row and the bug-report row
  for consistency, if either is configurable.
- **`api/insights.mdx` provider example responses.** Add a short
  Anthropic and Codex sample alongside the existing OpenAI shape so
  client implementers know what to expect. Pure DX polish.
- **Cross-link hygiene.** A handful of pages still link to
  `/settings/admin` or `/settings/administration` style anchors that
  were rewritten — search the tree for any remaining instances after
  the next set of edits.

Total deferred from this audit: **9 MED + 5 LOW**. CRITICAL + HIGH
fixed inline at `healthlog-docs` commits `19eb8de` and `3d3ea21`.
