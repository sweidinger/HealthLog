# HealthLog v1.4.14 — Release Summary

## Release brief (DE, ≤ 200 Wörter)

✅ **v1.4.14 ist live** auf `https://healthlog.bombeck.io` — Image-Digest
`sha256:0ced46004a54…` (vorher v1.4.12: `791c2cd2…`), `/api/version`
meldet `1.4.14`.

🆕 **Was ist neu**

- **Codex/ChatGPT-Modell-Slug korrigiert** auf `gpt-5.3-codex` — KI-
  Insights laufen jetzt direkt mit deinem ChatGPT-Login durch, kein
  API-Key nötig. Operator-Override per `CODEX_MODEL`-Env-Var möglich.
- **Admin-Bereich auf Unterseiten aufgeteilt** (`/admin/users`,
  `/admin/backups`, `/admin/system-status`, `/admin/integrations`, …) —
  bessere Übersicht, schnelleres Laden, Status-Cards verlinken direkt.
- **Neue Backups-Sektion** mit Tabelle aller bisherigen Sicherungen und
  „Backup jetzt erstellen“-Knopf.
- **Neue User-Verwaltung** mit Rollen-Filter und „Force-Logout"-Aktion
  (eigene Session ist gesperrt).
- **„Gespeicherten KI-Schlüssel entfernen"** als eigener Knopf in
  Settings → KI.
- **Trend-Pfeile sind jetzt metrik-bewusst** — Blutdruck ↑ orange,
  Stimmung ↑ grün, Puls ↑ neutral.

🔧 **Was ist gefixt**

- Notification-Channels + Push-Subscriptions werden jetzt vom „Alle
  Daten löschen“ tatsächlich entfernt.
- DST-Wechsel verschiebt keine Tageswerte mehr in Cross-Metric-Joins
  (war zwei Tage/Jahr falsch).
- KI-Provider-Fehler werden korrekt klassifiziert (422/503/429 statt
  pauschal 500).
- Logging-Redactor verschluckt keine harmlosen Wörter wie `task-force`
  oder `risk-management` mehr.

⚡ **Performance**

- `/insights` initiales JS −108 KiB (Recharts deferred geladen).
- Dashboard-Checklist Netzwerk −950 ms für Bestandsnutzer.

⚠️ **Hard-Reload** (`Cmd+Shift+R`) für den einmaligen Service-Worker-
Reset einplanen.

📚 **Docs** auf `docs.healthlog.dev` und Landing aktualisiert.
🎯 **v1.4.15 Backlog**: `.planning/v1415-backlog.md`.

---

## Was gelandet ist

53 Commits seit `v1.4.13` (`5df74f7..e5fae9b`). Severity-geordnet.

### Release

| SHA       | Summary                                                         |
| --------- | --------------------------------------------------------------- |
| `e5fae9b` | chore(release): v1.4.14                                         |
| `f0d53fb` | chore(release): rebrand artifacts as v1.4.14 (patch, not minor) |

### Codex-OAuth verification (Stage 1)

| SHA       | Summary                                                                  |
| --------- | ------------------------------------------------------------------------ |
| `5df74f7` | fix(ai): default Codex model to `gpt-5.3-codex` for ChatGPT-account auth |

### v1.4.6 deferred bugfix backlog (Stage 2)

| SHA       | Summary                                                                                      |
| --------- | -------------------------------------------------------------------------------------------- |
| `512a6a6` | fix(admin): wipe-all-data clears notification channels, push subs, telegram deletions (T2.1) |
| `cb6a59a` | fix(insights): correct DST handling in cross-metric daily bucket pairing (T2.2)              |
| `5403821` | fix(insights): map AI provider errors to 422/503 instead of 500 (T2.3)                       |
| `d6696cf` | fix(logging): redactSecrets regex requires non-alphanumeric prefix (T2.5)                    |

### Admin Panel refactor (Stage 4b — folds T2.6 + T2.7)

| SHA       | Summary                                                                             |
| --------- | ----------------------------------------------------------------------------------- |
| `d8b71b3` | feat(admin): scaffold per-section dynamic routes (admin-shell + [section]/page.tsx) |
| `12b280b` | refactor(admin): move sections to dynamic-route pattern + reduce overview           |
| `69c5225` | feat(admin): backups view + manual backup trigger (T2.6 deferred)                   |
| `5957e18` | feat(admin): users management with filters + force-logout action (T2.7 deferred)    |
| `a34cd8c` | refactor(i18n): namespace admin keys under `admin.section.<slug>.*`                 |
| `73965cd` | feat(admin): expandable sidebar nav for admin sections                              |
| `961e2a9` | fix(admin): status-card CTAs use real routes (not `#anchor`)                        |
| `7a47532` | feat(admin): redirect legacy section-anchor paths to dynamic routes                 |
| `1a7e3d6` | test(admin): tighten status-card-grid + add per-section render smoke                |

### UX polish (Stage 5)

| SHA       | Summary                                                                  |
| --------- | ------------------------------------------------------------------------ |
| `987ce0d` | fix(a11y): clear axe-core violations on `/admin` and key sub-routes      |
| `38f12df` | feat(ui): trend arrow color reflects metric-specific direction sentiment |
| `788c8ad` | feat(settings): allow removing saved AI provider key                     |
| `569300e` | style(ui): use semantic tokens for mood and feedback indicators          |
| `e3a6899` | fix(ui): disambiguate dashboard quick-add menu items                     |
| `65cfb27` | fix(a11y): label `/admin` overview quick-jump as a navigation landmark   |

### Multi-pass QA reconcile (Stage 6)

| SHA       | Summary                                                                            |
| --------- | ---------------------------------------------------------------------------------- |
| `88c8db1` | refactor: apply simplify-review safe-to-apply suggestions (11 of 11)               |
| `b3f282a` | fix(security): block force-logout from targeting the admin's own session           |
| `8e17f22` | fix(admin): rate-limit `/api/admin/backups/run` to 3/min per admin                 |
| `f0cfd26` | fix(security): redact standalone `hlk_` / `hlr_` native API tokens in logs         |
| `bd24f13` | fix(a11y): drop duplicate h2 inside single-section `/admin/<slug>` routes          |
| `499cfad` | fix(a11y): bump `/admin/users` + `/admin/login-overview` tap targets to WCAG 2.5.5 |
| `ef96e87` | fix(admin): default api-tokens + login-overview routes to expanded                 |

### End-to-end test coverage (Stage 3)

| SHA       | Summary                                                               |
| --------- | --------------------------------------------------------------------- |
| `535465c` | test(e2e): seeded test user + auth storageState fixture               |
| `3999ea7` | test(e2e): authenticated dashboard + add-measurement flow             |
| `2b6f959` | test(e2e): mocked Codex device-flow + insights regenerate specs       |
| `a106547` | test(e2e): doctor-report PDF + mobile-viewport smoke                  |
| `ca3c599` | test(e2e): extend axe-core to authenticated surfaces; fix login regex |
| `7af1f59` | fix(a11y): close violations the new e2e axe-core sweep surfaced       |

### Performance (Stage 4)

| SHA       | Summary                                                                 |
| --------- | ----------------------------------------------------------------------- |
| `bb2b1de` | perf(insights): defer Recharts ScatterChart imports via `next/dynamic`  |
| `519e36e` | perf(dashboard): skip checklist API fetches once onboarding is complete |
| `1a85da0` | fix(insights): preserve chart visual parity in deferred bundle          |
| `41fa203` | docs(audit): v1.4.14 performance audit report                           |

### CI / housekeeping

| SHA       | Summary                                                           |
| --------- | ----------------------------------------------------------------- |
| `3cacdf2` | fix(tests): share next/headers cookieJar across integration suite |
| `c847b80` | chore(format): trend-card test file prettier sweep                |
| `badd380` | style(admin): apply prettier to stage-6 reconcile changes         |
| `6b88e56` | chore(format): prettier sweep over stage-2 touched files          |

---

## Was deferred wurde + Warum

### v1.4.14 release-cycle "Apply automatically? no" simplify findings (8)

Aus `phase-6-simplify-findings.md`:

- **F5** Defensive `notFound()` hinter `dynamicParams = false` —
  Entscheidung pending zwischen (a) Kommentar trimmen vs. (b) Guard
  droppen + casten.
- **F9** `<SectionFrame>` in `renderer.tsx` switch — die Repetition ist
  echt, aber das Tabellen-Refactor wäre schlechter (asymmetrische
  `currentUserId`-Prop). Recommend: keep as-is.
- **F10** `if (!user || user.role !== "ADMIN") return null` doppelt —
  zwei Sites, unter dem 4-uses-Threshold. Recommend: keep.
- **F12** Historische Anker-Kommentare (`v1.4.6 T2.6`, `P15`,
  `v1.4.7.1`, …) — judgement-call sweep; ein Teil enthält echtes
  WHY-Wissen, ein Teil ist Archäologie.
- **F13** ~270 LOC duplication in den drei Status-Generatoren
  (mood/weight/blood-pressure) — `_status-helpers.ts`-Extraktion ist
  medium-risk, braucht fokussierten Pass + Tests.
- **F14** `formatBytes(fmt: ReturnType<typeof useFormatters>)` —
  cosmetic.
- **F18** `getApiErrorMessage` doppelter Fallback-Branch — cosmetic.
- **F19** `eslint-disable-next-line react-hooks/exhaustive-deps` auf
  Device-Code-Polling — verifizieren, ob `t`/`queryClient`-deps eine
  Re-poll-Loop auslösen.

### v1.4.6 P4+ Items (nicht aufgenommen)

`useAdminSettings` / `useSystemStatus` Test-Coverage für die
`isError`-UI aus P19 ist weiter manuell-only — nicht in v1.4.14
gepflegt, kein Regressionsrisiko. Trägt sich in den v1.4.15-Backlog.

### 4 HIGH findings → v1.4.15

Aus `phase-6-reconcile-report.md`:

- **H4d/H5d design — StatusCardGrid i18n** (Englisch-only
  Severity-Labels, Card-Titel/-CTAs, `fmtRelative`/`fmtUptime`,
  StatusBadge-aria-label). ~15 Keys × 2 Locales + Test-Rewrite — zu
  breit für sicheren Overnight-Apply.
- **H2 code-review — Admin-Page server-side `requireAdmin()`**. Heute
  ist die Rolle nur client-seitig geprüft; das Shell flackert kurz.
  Braucht eine server-rendered `requireAdmin()`-HOC, präzisiert für
  den HealthLog-Auth-Stack.
- **H-1 security — "Wipe all data"-Scope-Drift**. v1.4.14 hat
  Notification-Channels, Push-Subs und Telegram-Scheduled-Deletions
  ergänzt. Was weiter überlebt: `MoodEntry`, `RefreshToken`,
  `DataBackup`, `Device`, `UserAchievement`, `IdempotencyKey`, plus
  einige verschlüsselte Spalten. Entscheidung pending: (a) Scope
  nochmal weiten oder (b) Operation umbenennen ("Reset health data").

---

## CI / Test status

- `pnpm typecheck` — clean
- `pnpm lint` — 0 errors / 12 pre-existing warnings (none introduced)
- `pnpm format:check` — clean nach `c847b80` (trend-card test file
  sweep)
- `pnpm test` — **97 files / 754 tests** green
- `pnpm test:integration` — 5 files / 11 tests green; mock-leak flake
  zwischen `admin-data-wipe.test.ts` und `idempotency-replay.test.ts`
  via `tests/integration/mock-next-headers.ts` shared cookieJar
  behoben (10/10 consecutive runs grün)
- `pnpm build` — fails lokal auf Node 25 (`Reflect.get` private-member
  bug); CI Docker (Node 22) ist canonical
- `pnpm e2e` — gleicher Node-25-Bug betrifft auch `next dev`; CI runs
  green auf Node 22 (Phase-3 Report: 41/41 specs green)

---

## Production state

- **URL**: `https://healthlog.bombeck.io`
- **`/api/version`**: `1.4.14` ✓
- **Image digest**: `sha256:0ced46004a544a311627b7036f2f2aed75861b0c62576214a1303a17d20c3d22`
  (vorher v1.4.12: `sha256:791c2cd2a8eae5ec0a6fd666074c9f646c17414e3521d526267131c2a3b7edab`)
- **Smoke** (curl mit Session-Cookie): `/`, `/auth/login`,
  `/settings/integrations`, `/admin` — alle 200
- **Deploy-Methode**: `:1.4.14` von GHCR auf den Host gepullt, dort als
  `:latest` retagged (kein Compose-Edit), dann `docker compose up -d
app` in `/data/coolify/applications/pg8wggwogo8c4gc4ks0kk4ss/`. Der
  parallele `main`-Branch-GHCR-Run war auf demselben SHA hängengeblieben
  (>45 min), wurde gecancelt — harmlos, weil der Tag-Build `:latest`
  bereits gepusht hatte. Retag-on-host war defensiv aber sicher.
- **GitHub Release**: https://github.com/MBombeck/HealthLog/releases/tag/v1.4.14
- **Tag-Naming**: GHCR-OCI-Tag ist `:1.4.14` (kein `v`-Prefix);
  git-Tag ist `v1.4.14`. Hard-Rule's `:v1.4.14`-Slug needs a docs fix.

---

## Codex-OAuth Status (das v1.4.7–v1.4.13 Saga-Ende)

- **Resolution**: ChatGPT-Account-Auth verlangt das Modell-Slug
  `gpt-5.3-codex`. Das ist canonical, gepflegt aus
  `openai/codex` → `codex-rs/models-manager/models.json`. Sowohl
  `gpt-5-codex` als auch das v1.4.13-Fallback `gpt-5` werden vom
  Codex-Backend mit ChatGPT-Subscription explizit abgelehnt
  (`The 'gpt-5' model is not supported when using Codex with a ChatGPT
account.`).
- **Spec extension**: `docs/codex-protocol-spec.md` §7a dokumentiert
  jetzt die ChatGPT-Account-Auth-Allow-List + die Lehre, dass die Slugs
  in `model_migration.rs` Migration-_Prompts_ sind, keine Wire-Slugs.
- **Operator-Override**: `CODEX_MODEL`-Env-Var auf apps-01 lässt
  alternative Slugs ohne Rebuild testen — als Sicherheitsnetz für
  andere Plan-Tarife oder zukünftige OpenAI-Slug-Wechsel sinnvoll.
- **Live-Probe verifiziert**: `/api/ai/test` und
  `/api/insights/generate` laufen beide gegen das ChatGPT-Plus-Abo
  des Live-Tenants durch. `/tmp/v15-codex-working.png` zeigt das
  grüne "ChatGPT connected"-Badge in `/settings/ai`.

---

## Docs / Landing

- **healthlog-docs** (Starlight) — 7 Files aktualisiert: AI-Insights
  (Codex device-code-Pfad neu), Admin-Settings (Backups + Users
  Sektionen), Environment-Variables (`CODEX_MODEL`), Updates (Backups-
  View), Introduction (One-Click Codex-Flow), Troubleshooting
  (Codex-Failure-Modes), Dashboard-Customization (Perf-Note).
  Commit `06bc616`. Coolify auto-redeploys docs.healthlog.dev.
- **healthlog-landing** (Next.js) — `softwareVersion 1.4.6 → 1.4.14`
  in JSON-LD; AI-Providers-Copy auf "one-click device-code Codex
  flow, no API plan needed" angepasst. Commit `92c6588`.

---

## GitHub releases

`v1.4.7` … `v1.4.13` waren bereits real-time während des
Codex-OAuth-Iterationstags veröffentlicht; nur `v1.4.13` war pending
und wurde nachgezogen. `v1.4.14` selbst ist jetzt als Latest geflagged.

---

## Empfohlener v1.4.15 Backlog

Aus `.planning/v1415-backlog.md` (severity-geordnet, Datei:Zeile, ein
Satz Recommendation pro Item). Top-Hits:

### HIGH

- **H4d+H5d** — `StatusCardGrid` i18n: Severity-Labels, Card-Titel,
  CTAs, `fmtRelative`, `fmtUptime`, StatusBadge-aria-label nach
  `admin.statusGrid.*` migrieren (EN+DE Parität, ~15 Keys × 2 Locales).
- **H2** — `requireAdmin()` server-side auf `/admin/[section]/page.tsx`
  und `/admin/page.tsx` ziehen, damit Non-Admins 403 sehen, bevor das
  Shell paint-flickert.
- **H-1** — "Wipe all data" Entscheidung: (a) Scope auf `MoodEntry`,
  `RefreshToken`, `DataBackup`, `Device`, `UserAchievement`,
  `IdempotencyKey` + verschlüsselte Codex/AI/moodLog-Spalten weiten,
  oder (b) Operation umbenennen ("Reset health data") und "preserved"-
  Liste explizit zeigen. Recommend (a) für GDPR-Art-17-Alignment.

### MEDIUM (Highlights)

- **M-2 security** `/api/admin/users/[id]/force-logout` ohne Rate-Limit
  und ohne Last-Admin-Guard.
- **M-3 security** Wide-Event-`meta`-Strings nicht durch
  `redactSecrets()` gezogen — `addMeta()` braucht den Filter.
- **M-5 security** Wipe-Rate-Limit BEFORE auth — unauth'd Traffic
  mutiert `rate_limits`. Reorder: `requireAdmin()` zuerst, dann key by
  `user.id`.
- **M1 code-review** `/insights` TrendCard-Tile-Strip noch ohne
  `directionSentiment` verdrahtet (war v1.4.14 nur Dashboard).
- **M2 code-review** Legacy-Admin-Anchor-301s leaken Slug-Existenz an
  unauth'd Hits — Redirect-Block muss NACH dem Session-Check.
- **M3 code-review** `BackupsSection` 2-Sek-Timeout für Refetch ist ein
  Guess — auf 5–8s mit Double-Invalidate, oder Job-State pollen.

### LOW

- **L-1 security** `/api/auth/codex/callback` als PUBLIC_PATH gelistet,
  aber kein Route-File existiert — Eintrag aus `proxy.ts` löschen.
- **L-2 security** Codex `codex_device`-Cookie ohne Per-User-Binding
  — `userId` in den encrypted Blob einbetten, Mismatch rejecten.
- **L7 design** `/insights` Sticky-`<nav>` ohne `aria-label`.
- **L8 design** Mobile-Strip-Pattern für `<FeedbackInboxSection>`-Tabs
  und `<AdminShell>`-Mobile-Section-Strip (snap-x snap-mandatory).

### Recharts-Replacement (eingefroren auf v1.4.15+)

108 KiB pro Chart-Page sparbar, aber Effort L (alle Charts in
`src/components/charts/` müssen neu, plus neue Dependency). v1.4.14
no-new-deps Hard-Rule blockiert; v1.4.15+ wenn die Range frei wird.

---

## Hard-Reload-Reminder

`Cmd+Shift+R` (Mac) / `Ctrl+Shift+R` (Linux/Win) — der neue
Service-Worker holt sonst noch v1.4.13-Chunks aus dem Cache. Einmalig
ausreichend.
