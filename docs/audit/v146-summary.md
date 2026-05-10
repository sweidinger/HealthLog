# HealthLog v1.4.6 — Release Summary

## Release brief (DE, ≤ 200 Wörter)

✅ **v1.4.6 ist live** auf `https://healthlog.bombeck.io` — Container neu,
Image-Digest `sha256:dcfa70be96a9…` (vorher v1.4.5: `0fc06b0b69d9…`).

🆕 **Was neu ist**

- **Charts aggregieren bei Langzeit-Range** automatisch zu
  Wochen- (91-730 Tage) bzw. Monatsdurchschnitt (>730 Tage). Chip im
  Chart-Header zeigt den aktiven Bucket.
- **KI sieht jetzt 3 Jahre Historie** pro Karte: 360 Tageswerte +
  24 Monatswerte, mit Token-Budget-Wächter (Fallback 180 Tage bei
  laute Konten).

🔧 **Was repariert wurde**

- **Tile-Strip füllt jetzt aus** (T1) und Hierarchie ist sichtbar
  (T2: `--muted-foreground` jetzt wirklich gedämpft, AA-Kontrast).
- **KI-Empfehlung parst `metric:`-Tokens** (T3) — keine rohen Tokens
  mehr im Hero-Block.
- **AI-Provider-Leak geschlossen** (T4): Wechsel LOCAL → OPENAI
  schickt den Cloud-Key nicht mehr an die alte LAN-URL.
- **`/api/insights/generate` 502 → 422** (T5) — Cloudflare-HTML-Trap weg.
- **Admin-Buttons springen zum richtigen Anker** (T6) statt nach oben.
- **Bug-Report-Toggle wirkt jetzt** (T7) am API-Gate UND in der UI.
- **Audit-Log überlebt den Daten-Wipe** (T8).
- 20 Tier-2-Polish-Items (Typografie, Farben, i18n, Strukturfehler).

⚠️ **Hard-Reload** mit `Cmd+Shift+R` damit der neue Service-Worker greift.

📚 **Docs aktualisiert** — `docs.healthlog.dev` jetzt auf v1.4.6, neue
Seiten zu Native-API, Skalierung, Dashboard-Customization.

🎯 **v1.5-Backlog** unten in diesem Dokument.

---

## What landed

27 commits since `e8f4820` (v1.4.5 head).

### Tier 1 — release blockers (`docs/audit/v146-findings.md`)

| ID    | Commit    | Summary                                                            |
| ----- | --------- | ------------------------------------------------------------------ |
| T1+T2 | `8aae7d6` | tile fill + muted-foreground hierarchy                             |
| T3    | `a75fbc6` | primary recommendation parses chart tokens                         |
| T4    | `eba898f` | aiBaseUrl provider-leak guard + tests                              |
| T5    | `c8ee28d` | insights/generate parse error 502 → 422                            |
| T6    | `4aeb8c9` | admin status-card hrefs + tightened test                           |
| T7    | `31959e4` | bug-report toggle now blocks /api/feedback + UI                    |
| T8    | `c3ca861` | data-wipe preserves AuditLog + scope copy                          |
| T9    | `1adda80` | per-card insight window 360 daily + 24 monthly across 7 generators |

### New feature

| Commit    | Summary                                                               |
| --------- | --------------------------------------------------------------------- |
| `6a64df0` | chart bucketing for ranges > 1y (weekly / monthly aggregation + chip) |

### Tier 2 — polish

| Commit    | Summary                                                                           |
| --------- | --------------------------------------------------------------------------------- |
| `fda8dd8` | trend-card P1-P5 (tabular nums, KPI typography, padding parity, always-show avgs) |
| `dc6db82` | P6 + P10 (visible muted subtitle, medications card padding)                       |
| `5c884b3` | P7-P9 (mobile nav buffer, trend-hint title, font-mono drop)                       |
| `e903d9a` | P11 — redactSecrets sk-/sk-ant-                                                   |
| `c7b6005` | P12 — idempotency body-content guard                                              |
| `4a159d2` | P13 — rate-limit moved below cache return                                         |
| `dcc697c` | P14 — codex-client structured errors                                              |
| `89b5b80` | P15+P16 — drop unreleased presets, i18n the AI section                            |
| `505f318` | P17 — feedback badges → dracula tokens                                            |
| `86a4b52` | P18 — danger-zone colour follows mutation state                                   |
| `2654337` | P19 — useSystemStatus / useAdminSettings isError UI                               |
| `dc4507a` | P20 — status-overview Promise.allSettled                                          |

### CI / housekeeping

| Commit    | Summary                                                       |
| --------- | ------------------------------------------------------------- |
| `bcd1de4` | drop e2e pnpm-version override (was failing every run)        |
| `46e686f` | switch e2e mobile project to chromium + repair spec flakiness |
| `02b9955` | repo-wide prettier sweep before tag                           |
| `ecca54d` | `.planning` bootstrap                                         |

### Multi-pass QA follow-ups

| Commit    | Summary                                                                                                                    |
| --------- | -------------------------------------------------------------------------------------------------------------------------- |
| `6757518` | qa pass — orange→dracula tokens, status-card cta copy honest, idempotency `sk-` regex tightening with false-positive tests |

### Release

| Commit    | Summary                                                  |
| --------- | -------------------------------------------------------- |
| `a852612` | `chore(release): v1.4.6` (package.json bump + CHANGELOG) |

## What was deferred (v1.5 backlog)

From the multi-pass QA review:

1. **Notification-channel scope of "Wipe all data"** — `NotificationChannel`,
   `PushSubscription`, `TelegramScheduledDeletion`, and `Feedback` rows
   survive the wipe even though `User.telegramBotToken` etc. are nulled.
   Pre-existing scope drift; the encrypted Telegram bot token in
   `NotificationChannel.config` survives. Not introduced by v1.4.6.
   Fix: extend the data-wipe transaction.
2. **Berlin TZ DST math in cross-metric joins** — `bucketSeries`'s
   `dayOffset` reverse mapping (used by BP-pair / weight↔BP /
   medication-adherence joins) computes `now - dayOffset·86_400_000`
   which is wrong on DST boundaries. Affects ~2 days/year of
   miscredited data — low blast-radius, but should be exposed via a
   helper from `bucket-series.ts` to centralise the conversion.
3. **`status-card-grid` test brittleness** — the test maintains a
   hand-curated list of section IDs; the findings doc recommended
   rendering `<AdminPage />` and asserting via DOM. v1.5 follow-up.
4. **`redactSecrets` regex word-boundary** — current `/sk-(?:ant-)?[A-Za-z0-9_-]+/`
   over-matches "task-force", "risk-management" etc. Not a security
   issue (over-redaction is the safe failure mode), purely a log
   readability concern.
5. **`/api/insights/generate` provider-error → 500** — when the admin
   OpenAI key is invalid, the route propagates "OpenAI request failed
   (401)" up to the apiHandler which maps to a generic 500. T5 fixed
   only the parse-error branch. v1.5: catch provider-side errors and
   map to 422/503 with a readable body.
6. **`useAdminSettings` / `useSystemStatus` test coverage** — the new
   `isError` UI added in P19 has no integration test covering the
   error path. Manual verification only.
7. **Backups dedicated admin section** — currently the "Backups"
   status-card jumps to `#section-system-status` because no dedicated
   backups view exists. Re-labelled honestly to "Open system status"
   in v1.4.6; v1.5 should add the actual backups view.

## CI / test status

- `pnpm typecheck` — clean
- `pnpm lint` — 0 errors / 12 warnings (pre-existing `_param`-style
  unused vars; not in scope to refactor)
- `pnpm format:check` — clean (sweep landed in `02b9955`)
- `pnpm test` — 714 passed
- `pnpm test:integration` — 10 passed (testcontainers)
- `pnpm build` — fails locally on Node 25 due to a Turbopack
  AsyncLocalStorage / Reflect.get bug. CI Docker image (Node 22)
  builds cleanly — that is the canonical release path.
- `e2e` workflow — fixed and pushed; the run on the v1.4.6 SHA was
  still pending at deploy time. Per the release spec, e2e green is
  not a hard gate.

## Production state

- URL: `https://healthlog.bombeck.io`
- `/api/version`: `1.4.6` ✓
- Image SHA: `sha256:dcfa70be96a955a554f8c943a1d954fa8a23f49896047f88658b62df72f60ba8`
- Previous (v1.4.5): `sha256:0fc06b0b69d987f6498bd5f9224e316cbcee91cafaf098eb738f43061fcc6ffc`
- Container: `app-pg8wggwogo8c4gc4ks0kk4ss-005603315572`, healthy
- `/api/ai/test` smoke with fake key: returns **422** with readable
  JSON body ✓ (Cloudflare passthrough confirmed).

### Coolify-deploy quirk worth noting

The first `mcp__coolify-apps01__deploy` call with `force: true`
finished in 21 seconds (`fxwl88wohhbl7f730nfv0kk1`) and reported
"Removing old containers / Starting new application", but the running
container still ran the old `0fc06b0b…` image — Coolify's compose-pull
took ~250 ms which is far too short to actually pull a new image, and
the container ID stayed the same. A manual
`docker compose pull && docker compose up -d app` on the host pulled
the new digest cleanly and the container then recreated. End state
matches the desired SHA, but Coolify's force-rebuild semantics on
this app instance look unreliable. Worth a v1.5 follow-up to
reproduce and report upstream.

## Docs / landing

Both repos pushed. See release report for commit list. Highlights:

- `healthlog-docs`: 8 commits bringing site from v1.2 → v1.4.6.
  New pages: `api/native-clients.mdx`, `self-hosting/scaling.mdx`,
  `features/dashboard-customization.mdx`. Existing pages refreshed
  for v1.3-v1.4 features.
- `healthlog-landing`: single commit `ebb03f9` bumping
  `softwareVersion` 1.3.3 → 1.4.6 and expanding the JSON-LD
  `featureList`. Screenshots untouched (deferred to a daylight
  refresh).

## GitHub releases

Backfilled `v1.4.2`, `v1.4.3`, `v1.4.4`, `v1.4.5`, **`v1.4.6`** at
https://github.com/MBombeck/HealthLog/releases — each with the
canonical CHANGELOG block as release notes.

## QA review reports — full text

Stored in commit messages of `6757518` (the QA-pass follow-up
commit). Three review passes ran in parallel against the v1.4.6 diff:

- **Code-review pass** — no CRITICAL, 3 HIGH (DST math,
  idempotency `sk-` substring, monthly bucket label semantics).
  All triaged: `sk-` regex fixed; rest deferred.
- **Security review pass** — no CRITICAL/HIGH. M1 (notification-
  channel data-wipe scope) deferred. T4/T7/T8/P11/P12 cleared.
- **Design review pass** — no CRITICAL, 2 HIGH (orange tokens in
  ai-section.tsx, status-card cta copy honesty). Both fixed.

---

## Hard-Reload reminder

`Cmd+Shift+R` (Mac) / `Ctrl+Shift+R` (Linux/Win) so the new
service-worker fetches fresh `_next/static` chunks. Without it the
client may stay on the v1.4.5 bundle for up to a navigation cycle.
