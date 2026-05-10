# Phase B3 — Admin System-Status host-load chart (v1.4.16)

Marc asked for a 2-hour host-load graph above /admin/system-status — CPU,
memory, disk-IO. Phase ran in Wave-B in parallel with B4/B5a/B7 and the
verification gate.

## Approach

Picked Option B (in-process sampler) over Option A (Coolify Sentinel
scrape). Coolify exposes no clean read endpoint for per-server metrics
without HTML scraping or private RPC; an `os.loadavg()` + `os.totalmem()`

- /proc/diskstats sampler is self-contained, costs one row per minute,
  and works on macOS dev as well as Linux production.

## Deliverables

1. **`HostMetric` model + migration `0032_host_metric`** —
   `prisma/schema.prisma`, indexed by `captured_at`. Disk fields nullable
   so non-Linux hosts don't fail.
2. **Per-minute sampler** — `src/lib/jobs/host-metric-sampler.ts`. Reads
   `os.loadavg()`, `os.totalmem() - os.freemem()`, and (Linux)
   /proc/diskstats. Skips loop/ram/dm-/md/sr/fd/nbd/zram pseudo-devices.
   Wired into `reminder-worker.ts` with `* * * * *` cron. 7-day retention
   enforced inside the worker; env override `HOST_METRIC_RETENTION_DAYS`
   capped at >= 1 day.
3. **`GET /api/admin/host-metrics?since=2h`** — `requireAdmin()`-gated.
   Returns `{ samples, meta }`. Server-side BPS derivation across
   consecutive samples handles counter resets (host reboot) by emitting
   `null` instead of negative deltas. Six `since` presets: 30m / 1h / 2h
   (default) / 6h / 12h / 24h.
4. **`<HostMetricsChart>` component** —
   `src/components/admin/host-metrics-chart.tsx`. Recharts wrapper with
   load (yellow, left axis) + memory % (cyan, right axis) + disk-IO %
   (purple, right axis, hidden when no disk data). `next/dynamic` import
   from the consumer keeps the Recharts bundle off the rest of the admin
   panel. 60s `refetchInterval` matches sampler cadence.
5. **System-status section wiring** — `system-status-section.tsx` now
   wraps the existing card in a `space-y-6` flex with the chart above.
6. **i18n** — 9 EN+DE keys under `admin.hostMetrics.*` (title, load1,
   memUsedPercent, diskBusyPercent, diskReadBps, diskWriteBps,
   last2hours, empty, loadError).

## Tests

- 8 unit tests for the sampler (env retention parsing, disk-stats null
  - throw fallbacks, create + deleteMany call shape).
- 6 integration tests against testcontainer Postgres for the API
  endpoint (auth gating, 2h default window, BPS derivation across a
  counter reset, `?since=30m` preset, empty-DB happy path).
- 5 component tests for the chart helper + loading skeleton render.
- All 13 unit + 6 integration tests green; i18n parity test green.

## Cross-agent collisions

The verification-gate stash/restore loop in this marathon repeatedly
wiped my untracked files (chart component + tests) and hijacked my
`git commit` invocations so commits 4-6 ended up landing under another
agent's commit message (`8d9f864 docs(planning): mark Wave-B B5a …`).
Functionally everything is on origin/main; commit attribution is
muddled. Commits 1-3 (db, jobs, api) landed cleanly under my titles
(`5d1ece1`, `f1bd801`, `2877710`). Commit 3 (`2877710`) is missing the
Co-Authored-By trailer due to a one-line oversight in my heredoc.

Recommendation for v1.4.17: spawn each agent in its own git worktree
(`superpowers:using-git-worktrees`) to eliminate the shared-cwd
staging race entirely. The current marathon's verification gate keeps
collapsing concurrent untracked files into shared stashes, which makes
even simple `git add path/to/file && git commit` racy.

## Files added / modified (final state on origin/main)

- `prisma/schema.prisma`, `prisma/migrations/0032_host_metric/migration.sql`
- `src/lib/jobs/host-metric-sampler.ts` + `__tests__/host-metric-sampler.test.ts`
- `src/lib/jobs/reminder-worker.ts` (sampler queue registration)
- `src/app/api/admin/host-metrics/route.ts`
- `tests/integration/admin-host-metrics.test.ts`
- `src/components/admin/host-metrics-chart.tsx` + `__tests__/host-metrics-chart.test.tsx`
- `src/components/admin/system-status-section.tsx` (wiring)
- `messages/en.json`, `messages/de.json` (admin.hostMetrics.\*)
- `tests/integration/setup.ts` (truncate `host_metrics`)

## Did NOT touch (scope guards)

- `src/lib/ai/`, `src/components/insights/`,
  `src/components/charts/scatter-correlation-chart.tsx` (B5a/B5c-e)
- `src/components/settings/*` (B2/B6/B7)
- audit-log section (B4)
- No new dependencies — Recharts pattern reuse only.
