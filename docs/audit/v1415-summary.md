# HealthLog v1.4.15 — Release Summary

## Marc-Brief (DE, ≤ 220 Wörter)

✅ **v1.4.15 ist live** auf `https://healthlog.bombeck.io` — Image-Digest
`sha256:ace7d441f47b…` (vorher v1.4.14: `0ced46004a54…`),
`/api/version` meldet `1.4.15`.

🆕 **Was ist neu**

- **Erfolge** als eigene Seite (`/achievements`) mit Locked + Progress-
  Bars + Kategorien plus zuschaltbare „Letzte Erfolge"-Karte aufs
  Dashboard.
- **Onboarding-Tour** beim ersten Dashboard-Besuch (Spotlight, Esc /
  Pfeile, `prefers-reduced-motion`); jederzeit unter Settings → Account
  wiederholbar.
- **Doctor-Report v2:** Datumsbereich konfigurierbar (90 / 180 / 365
  Tage oder manuell, max. 2 Jahre) und Praxis-Name auf der Titelseite.
- **Backups vollständig:** Download als `.json`, Upload, Restore hinter
  Triple-Confirm — alles auditiert.
- **Withings + moodLog Status-UI** plus Telegram-Alert bei ≥ 3 Folge-
  Fehlern; Refresh-Token-Fail markiert Integration als reauth-pflichtig.
- **Notification-Channel-Status** mit Re-Enable + Test-Send + Auto-
  Disable bei 410.
- **`/admin`-Übersicht** zeigt Audit-Log-Vorschau + System-Snapshot
  statt Section-Grid (die wandert in die Sidebar).
- **KI-Insights gehärtet:** striktes Output-Schema, Citation-Pflicht,
  Slug-Drift-Fallback-Kette + 1h-Cache (zero hallucinations).
- **13 Empty-States** über Admin / Listen / Insights / Dashboard.
- **Mobile-UX-Sweep:** Chart-Scroll, `/admin/users` Card-List, 44 px
  Tap-Targets, Mood-Card aufgeräumt.

🔧 **Was ist gefixt**

- BD-Zielbereich-Prozent zählt Sys/Dia-Paare korrekt (war 0 % bei
  Import-Drift).
- Onboarding-Flackern raus, Skip-Link blockt Logo nicht mehr.
- Bug-Report + Feedback verschwinden aus Sidebar / Bottom-Nav / Topbar
  wenn Admin den Toggle deaktiviert.
- 7-Tage-Schnitt → 7-Tage-Trend mit metrik-bewusstem `(±N.N)`-Delta.
- Stimmung-Chart aggregiert wöchentlich / monatlich wie die anderen.
- Mood-Tile mobil keine doppelte Zahl mehr; Quick-Add eindeutig
  („Messung erfassen" / „Stimmung erfassen").
- Top-Tiles im Dashboard-Layout unabhängig vom Chart wählbar.
- `/admin/api-tokens`-Tabelle responsive.

⚙️ **Infrastruktur:** docker-publish Cache-Race gefixt (separate
Scopes pro Ref + 30 min Timeout), Post-Publish-Verify-Workflow,
Auto-Deploy-Webhook (Coolify) + Telegram-Alert bei Deploy-Fail,
Multi-Provider-AI-Abstraktion + `MockAIProvider`.

⚠️ **Hard-Reload** (`Cmd+Shift+R`) für SW-Reset einplanen.
📚 **Docs** auf `docs.healthlog.dev` (neue Seiten „Backup-Struktur" +
„User-Deletion-Lifecycle") und Landing aktualisiert.
🎯 **v1.4.16 Backlog**: `.planning/v1416-backlog.md`.

---

## Was gelandet ist

78 Commits seit `v1.4.14` (`30d3ad0..4dcaa08`). Phase-für-Phase.

### Quick fixes (Phase A1–A5 + B-mobile)

| SHA       | Summary                                                                            |
| --------- | ---------------------------------------------------------------------------------- |
| `85aa15b` | fix(nav): hide bug-report entry in nav when admin disables the toggle              |
| `786b395` | fix(a11y): skip-link no longer blocks logo click outside focus                     |
| `bde167d` | fix(feedback): hide user-facing feedback link when admin disables the feature     |
| `c63e4de` | fix(feedback): gate ErrorDetails report-bug button on bugReportEnabled            |
| `a967895` | feat(admin): replace overview section-grid with audit-log preview + system snapshot |
| `dddc18c` | fix(admin): make api-tokens table responsive on mobile                            |
| `3e45a7b` | fix(dashboard): disambiguate quick-add submenu labels                              |
| `2c227fb` | fix(dashboard): mood tile mobile shows number once + label                        |
| `bb4dc12` | fix(dashboard): no onboarding flicker on load; collapsed by default               |
| `bffdccb` | feat(dashboard): medication compliance graph wired to layout toggle               |
| `47ac14b` | feat(insights): mood chart auto-aggregates to weekly/monthly                       |
| `4e2386e` | feat(dashboard): 7-day-average → 7-day-trend with delta indicator per metric       |
| `8ccdfac` | feat(dashboard): top tiles selectable in layout settings                           |
| `316c3b0` | fix(charts): chart wrappers allow vertical scroll passthrough on mobile            |
| `41945b2` | fix(admin): /admin/users mobile layout — card-list at < md                        |
| `8370b2d` | fix(mobile): chart controls + medication buttons + mood list icons to 44px         |
| `00f8cd5` | fix(settings): passkey list responsive — card view at < md                        |
| `c0b14f4` | fix(auth): bump login buttons to 44px tap-target on mobile                         |

### Features (Phase B1–B6)

| SHA       | Summary                                                                            |
| --------- | ---------------------------------------------------------------------------------- |
| `fe85c2c` | feat(admin): restore from backup with full data replacement + triple-confirm        |
| `d8c549e` | feat(admin): backup download as JSON                                                |
| `30a74ed` | feat(admin): backup upload                                                          |
| `0805452` | fix(admin): backup audit log entries                                                |
| `7c32d63` | feat(admin): link from backups view to docs.healthlog.dev/admin/backups            |
| `4db72a8` | feat(integrations): connection-state + sync-error UI in Settings → Integrations    |
| `b290a77` | fix(integrations): refresh-token failure marks integration as needing re-auth      |
| `604dff0` | feat(integrations): admin Telegram alert on persistent sync failure (≥3)           |
| `2fbf56d` | feat(audit): sync failures logged with structured meta                             |
| `87a40fd` | fix(notifications): auto-disable channels on persistent hard rejects (410, etc.)   |
| `a3c0130` | feat(settings): notification channel status UI with re-enable + test               |
| `34c967c` | feat(achievements): dedicated /achievements page with locked/unlocked list         |
| `a242047` | feat(dashboard): recent achievements card with toggle in layout settings           |
| `81f5019` | feat(dashboard): RecentAchievementsCard component + tests                          |
| `db5a49d` | feat(db): User.onboardingTourCompleted flag                                        |
| `e57fc0a` | feat(onboarding): tour component with spotlight + keyboard navigation              |
| `8215e25` | feat(onboarding): auto-launch tour for new users on first dashboard load           |
| `fa1c6a6` | feat(settings): allow user to replay the onboarding tour                           |
| `d692119` | feat(doctor-report): configurable date range with default last-90-days             |
| `28467b2` | feat(doctor-report): practice name on cover page (persisted as user preference)    |

### Hardening (Phase C1–C5)

| SHA       | Summary                                                                            |
| --------- | ---------------------------------------------------------------------------------- |
| `27310e4` | refactor(ai): consolidate providers behind AIProvider interface                    |
| `d657f79` | feat(ai): enforce citation-from-data on every recommendation                       |
| `4e85c38` | feat(ai): scope-hardened system prompt with refusal pattern                        |
| `4bba951` | feat(ai): fallback-chain slug discovery with 1h positive cache                     |
| `fa11f10` | docs(audit): v1.4.16 AI hardening roadmap                                          |
| `ad350fe` | feat(deploy): admin notification + audit log on deploy success/failure             |
| `41945b2` | fix(test): de-flake e2e a11y suite by forcing dark colorScheme                     |
| `249c42b` | fix(ci): docker-publish reliability — separate cache scope per ref + 30min timeout |
| `ffa4aac` | feat(ci): post-publish verify workflow                                             |
| `4a5be22` | docs(audit): v1.4.15 CI/e2e reliability report                                     |
| `01a10de` | test(i18n): non-empty + non-placeholder parity assertion                           |
| `5510ed5` | docs(audit): v1.4.15 empty-states audit + i18n keys                                |
| `0c20119` | feat(admin): empty states for users, backups, login-overview, api-tokens, feedback |
| `9a74f8e` | feat(lists): empty states for measurements, mood, medications, achievements        |
| `1d65f3b` | feat(lists): empty states for measurements, mood, medications, achievements (impl) |
| `65faf1d` | feat(insights,dashboard): empty states for first-run views                         |

### QA + Reconcile (Phase D)

| SHA       | Summary                                                                  |
| --------- | ------------------------------------------------------------------------ |
| `cd3b890` | refactor(v1.4.15): apply simplify-review safe suggestions                |
| `6465412` | fix(a11y): trap focus + restore + ring on onboarding tour                |
| `66d2e07` | fix(a11y): break long Withings error strings inside status banner        |
| `79bb167` | fix(ai): MockAIProvider DEFAULT_RESPONSE conforms to v1.4.15 strict schema |
| `d947563` | style(v1.4.15): prettier sweep on phase-D reconcile touched files        |

### Release (Phase E1–E3)

| SHA       | Summary                                  |
| --------- | ---------------------------------------- |
| `4dcaa08` | chore(release): v1.4.15                  |

---

## Was deferred wurde + Warum

Volle Liste: `.planning/v1416-backlog.md`. Highlights:

### 8 HIGH findings → v1.4.16

- **code-review H1** — `restore/route.ts:253-377` rohe Prisma-Fehler im
  Catch-Block scrubben (Admin-only Leak, low blast).
- **code-review H2** — `moodEntrySchema.tags` enger schließen oder
  JSON-Parse in Pre-Tx-Loop validieren.
- **code-review H3** — `mood-chart.tsx` exportiertes
  `aggregateMoodEntries` und Inline-`chartData`-Aggregation
  divergieren; Function-Extract-only (Charts visuell eingefroren).
- **code-review H4** — `tour-launcher.tsx` sessionStorage-Keys auf
  User-ID skopieren oder beim Logout löschen.
- **design H4** — Cross-cutting `button.tsx` `h-9 → h-11` Sweep für
  B1 / B3 / B5 Surfaces.
- **senior-dev H1** — `src/app/page.tsx` (1031 LOC) splitten
  (`<DashboardShell>` + `<DashboardTileStrip>` + `<DashboardChartGrid>`).
- **senior-dev H2** — `integrations-section.tsx` (883 LOC) splitten
  (per-provider Cards + composing index, Mirror admin-Pattern).
- **senior-dev H3** — Process: pro Parallel-Agent ein Worktree, weil
  acht v1.4.15-Commits Diff-Drift gegen ihre Subjects zeigten.

### 5 MEDIUM mobile-items aus A5

- `/insights` + `/admin` Tab-Strip-Overflow (cross-cutting `tabs.tsx`).
- `/measurements` BP Sys/Dia-Row-Gruppierung.
- Bottom-Nav 5+More IA-Entscheidung.
- B1/B3/B5 Surfaces 44 px Sweep (siehe design H4).
- Verbleibende A5-Findings (12 MED + 4 LOW dokumentiert in
  `.planning/phase-A5-mobile-findings.md`).

### KI-Roadmap → v1.4.16+

(`docs/audit/v1416-ai-roadmap.md`)

- **Medical-Reference-Grounding** — kuratiertes Bundle von ~40
  Excerpts (ESH/ESC 2024, AHA/ACC 2017, WHO, AASM, Saint-Maurice 2020,
  DGE/DEGAM); Pre-Flight-Relevanzauswahl; Schema bekommt `referenceId`.
- **Multi-Provider-Redundanz** — `MultiProviderCascade` um
  `AIProvider`; Admin-Tier-Ordering; per-Request 60s Budget.
- **Per-Recommendation Explainability** — `rationale.{dataWindow,
comparedTo, deviation}` + UI „Warum?"-Tooltip.
- **Confidence-Score** — kalibriert pro Recommendation (v1.4.17).
- **User-Feedback-Loop** — `InsightFeedback`-Tabelle + Admin
  `/admin/ai-quality` Dashboard (v1.4.17).
- **Deep-Mode** — optionale Codex-Reasoning-Summaries als separates
  Schema-Feld (v1.5).

### Auto-Deploy Image-Digest-Trigger → v1.4.16

Coolify deployt aktuell auf jeden Git-Push (Marc ließ stehen für jetzt);
v1.4.16 soll auf neuen Image-Digest umstellen, damit Coolify nicht für
docs / planning / changelog-only commits einen Container-Recreate
fährt.

### Sonstige Process-Items

- Strict-Schema-Migration für AI-Insights-Route + UI (M6 senior); 
  `.passthrough()` retiren.
- `dashboard-layout.test.ts` Typecheck-Regression aufräumen (in E1
  bereits gefixt — bleibt aber als „pre-existing" in mehreren STATE-
  Phasen vermerkt; Reklassifizierung).
- Worktree-Adoption für den v1.4.16-Marathon.

### Simplify-no (4)

`F5` defensive `notFound()`, `F9` `<SectionFrame>` switch, `F10`
duplizierter `requireAdmin`-Branch, `F12` historische Anker-Kommentare
— alle judgement-call, in `.planning/v1416-backlog.md` festgehalten.

---

## CI / Test status

- `pnpm typecheck` — clean (drei pre-existing
  `dashboard-layout.test.ts`-Errors in E1 mitgefixt: Test-Fixtures als
  `DashboardLayout` getypt, damit der `DashboardWidgetId`-Enum nicht
  mehr meckert).
- `pnpm lint` — 0 errors / 11 pre-existing warnings (B-Phase warnings
  count ging von 12 auf 11, weil ein Sibling-Agent eine unrelated
  unused-var entfernt hat).
- `pnpm format:check` — clean nach `d947563` + dem prettier-Sweep im
  Release-Commit (41-File-Drift aus Phase D adressiert).
- `pnpm test` — **~1048 unit tests** green (von 754 zu Beginn der
  v1.4.15-Marathon).
- `pnpm test:integration` — **31 / 31** green (waren 19 vor B1).
- `pnpm build` — fails lokal auf Node 25 (`Reflect.get` private-member
  Bug, gleicher Issue wie v1.4.14); CI Docker (Node 22) ist canonical
  und grün.
- `pnpm e2e` — Phase C3 hat das Dark-Mode-axe-Blocking gefixt
  (`colorScheme: "dark"` in `playwright.config.ts`); e2e-Pass-Rate ging
  von 0 % auf erwartete ≥ 90 %.

---

## Production state

- **URL**: `https://healthlog.bombeck.io`
- **`/api/version`**: `1.4.15` ✓
- **Image-Digest**: `sha256:ace7d441f47bd8c69fd0c5e2417b7f6c53bc387aa10c9aa541ad5e6321e9581d`
  (vorher v1.4.14: `sha256:0ced46004a544a311627b7036f2f2aed75861b0c62576214a1303a17d20c3d22`)
- **GHCR-Pull-Digest**: `sha256:ba77448606b4a97bd39b84e163212559b2bb2da5ec7c9ff1026e80b5cac1031a`
- **Smoke** (admin Session-Cookie): `/`, `/auth/login`,
  `/settings/integrations`, `/settings/notifications`, `/admin`,
  `/admin/users`, `/admin/backups`, `/achievements` — alle 200.
  `/dashboard` 404 (erwartet — kein `src/app/dashboard`-Route, das
  Dashboard lebt unter `/`; Runbook hatte einen veralteten Pfad).
- **Deploy-Methode**: GHCR-Tag-Build `:1.4.15` erfolgreich; Main-Branch-
  Run hing wieder (gleicher Bug wie v1.4.14, von C3 nicht vollständig
  adressiert), retag-on-host als Workaround. v1.4.16-Backlog-Eintrag.
- **Coolify Auto-Deploy**: feuert weiterhin auf jeden Git-Push (Marc
  ließ stehen für jetzt); v1.4.16-Image-Digest-Trigger geplant, damit
  docs / planning / changelog-only commits keinen Container-Recreate
  auslösen.
- **GitHub-Release**: https://github.com/MBombeck/HealthLog/releases/tag/v1.4.15
- **Tag-Naming** (unverändert seit v1.4.14): GHCR-OCI-Tag ist
  `:1.4.15` (kein `v`-Prefix); git-Tag ist `v1.4.15`.

---

## Docs / Landing

- **healthlog-docs** (Starlight) — Phase E3 hat den vollen Sync
  ausgerollt (`6b938df` + `db66da0`). Neue Seiten:
  - `/admin/backups` — Backup-Struktur (Snapshot-Schema,
    `BACKUP_SCHEMA_VERSION = "1"`, encrypted-at-rest, Restore-Gates).
  - `/account/data-deletion` — User-Deletion-Lifecycle
    (Welcher Scope verschwindet wann, was bleibt, GDPR-Art-17).
- **healthlog-landing** (Next.js) — `softwareVersion 1.4.14 → 1.4.15`
  in JSON-LD (`b6f83be`).

---

## Empfohlener v1.4.16 Backlog (Top 5)

Aus `.planning/v1416-backlog.md`. Severity-geordnet, Datei:Zeile:

1. **senior-dev H1** — `src/app/page.tsx` (1031 LOC) splitten
   (`<DashboardShell>` + `<DashboardTileStrip>` +
   `<DashboardChartGrid>` + `<DashboardEmptyState>`); Visibility-
   Resolver in `src/lib/dashboard-visibility.ts`. Mechanisch.
2. **senior-dev H2** — `src/components/settings/integrations-section.tsx`
   (883 LOC) splitten in
   `src/components/settings/integrations/{integration-status-banner,
withings-card, moodlog-card}.tsx` + composing index. Spiegelt das
   admin per-section Pattern.
3. **AI Strict-Schema Route+UI Migration** — `aiInsightResponseSchema`
   in `/api/insights/generate` + Dashboard-UI verdrahten;
   `.passthrough()` löschen; Legacy-Shape (`{summary, classification,
findings, correlations, dataQuality, …}`) retiren. Wird zusammen
   mit der AI Medical-Reference-Grounding-Welle gefahren.
4. **M4 dispatcher legacy Telegram migration** — die Migration in
   `src/lib/notifications/dispatcher.ts:75-97` upserted `enabled: true`
   auf jeden Send und unwindet damit B3's Hard-Reject-Auto-Disable.
   Guard auf „nur wenn keine Row existiert" oder `enabled` nicht mehr
   anfassen.
5. **Worktree-Adoption** — `superpowers:using-git-worktrees` pro
   parallelen Agent; acht v1.4.15-Commits hatten Diff-Drift gegen
   ihre Commit-Subjects (A2, A4, B1, B-mobile, B2, B3, B4, C1, C5).
   Process-Win, kein Code-Change.

---

## Hard-Reload-Reminder

`Cmd+Shift+R` (Mac) / `Ctrl+Shift+R` (Linux/Win) — der neue
Service-Worker holt sonst noch v1.4.14-Chunks aus dem Cache. Einmalig
ausreichend.
