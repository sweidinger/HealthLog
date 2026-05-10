# v1.4.16 Stage B6 — Settings naming-audit

Status: audit landed 2026-05-10
Author: Maintainer

> Brief direction (kickoff 2026-05-09 late evening):
> "Mir wäre einfach auch noch mal wichtig dass du über alle Einstellungen
> alle Namings gehst und einmal guckst, dass alles stringent ist, dass
> alles sinnig ist, dass alles logisch aufgebaut ist."
>
> Plus the `feedback_settings_no_split.md` rule — no top/bottom
> split anti-pattern (B2 will fix the explicit AI-section instance).

This audit is the single pass over **every** `/settings/<slug>` route + its
section component + its i18n keys. It documents what is wrong today and what
the v1.4.16 stage-B6 refactor commits do about it. AI section (`/settings/ai`)
and Export section (`/settings/export`) are intentionally **out of scope**:
B2 owns AI provider UX, B7 just shipped Export.

---

## 1. Inventory

| Slug                    | Route                     | Section component                                                                            | Sidebar icon        | i18n title key                          | i18n description key                          |
| ----------------------- | ------------------------- | -------------------------------------------------------------------------------------------- | ------------------- | --------------------------------------- | --------------------------------------------- |
| `account`               | `/settings/account`       | `account-section.tsx` (`<AccountSection>`)                                                   | `User`              | `settings.sections.account.title`       | `settings.sections.account.description`       |
| `integrations`          | `/settings/integrations`  | `integrations-section.tsx` (`<IntegrationsSection>`)                                         | `Link2`             | `settings.sections.integrations.title`  | `settings.sections.integrations.description`  |
| `notifications`         | `/settings/notifications` | `notifications-section.tsx` (`<NotificationsSection>`)                                       | `Bell`              | `settings.sections.notifications.title` | `settings.sections.notifications.description` |
| `dashboard`             | `/settings/dashboard`     | `dashboard-section.tsx` (`<DashboardSection>`) ⇢ `dashboard-layout-section.tsx`              | `LayoutDashboard`   | `settings.sections.dashboard.title`     | `settings.sections.dashboard.description`     |
| `thresholds`            | `/settings/thresholds`    | `thresholds-settings-section.tsx` (`<ThresholdsSettingsSection>`) ⇢ `thresholds-section.tsx` | `SlidersHorizontal` | `settings.sections.thresholds.title`    | `settings.sections.thresholds.description`    |
| `ai` (out of scope)     | `/settings/ai`            | `ai-section.tsx` (`<AiSection>`)                                                             | `Sparkles`          | `settings.sections.ai.title`            | `settings.sections.ai.description`            |
| `api`                   | `/settings/api`           | `api-section.tsx` (`<ApiSection>`)                                                           | `KeyRound`          | `settings.sections.api.title`           | `settings.sections.api.description`           |
| `export` (out of scope) | `/settings/export`        | `export-section.tsx` (`<ExportSection>`)                                                     | `Download`          | `settings.sections.export.title`        | `settings.sections.export.description`        |
| `advanced`              | `/settings/advanced`      | `advanced-section.tsx` (`<AdvancedSection>`)                                                 | `Settings2`         | `settings.sections.advanced.title`      | `settings.sections.advanced.description`      |
| `about`                 | `/settings/about`         | `about-section.tsx` (`<AboutSection>`)                                                       | `Info`              | `settings.sections.about.title`         | `settings.sections.about.description`         |

The slug list lives at `src/components/settings/section-slugs.ts` (server-safe
constant) and is mirrored by the icon/title list at the top of
`src/components/settings/settings-shell.tsx`.

### Top-level i18n namespace shape (current)

The `settings.*` namespace inside `messages/{en,de}.json` mixes three styles:

1. **`settings.sections.<slug>.{title,description}`** — the modern, audited
   shape introduced with the v1.4.x split. Owned by `<SettingsShell>` for
   nav labels and by each section component for its `<h1>` + subtitle. **This
   is the one we standardise on.**
2. **`settings.<slug>.<key>`** — exists for `settings.about.*` and
   `settings.ai.*` but not the others. Mostly correct.
3. **`settings.<flatKey>`** — every other key is flat: `settings.profile`,
   `settings.passkeyName`, `settings.withings`, `settings.moodLogTitle`,
   `settings.dangerZone`, `settings.exportJson`, `settings.doctorReport`,
   etc. This is the legacy shape and the source of most of the
   inconsistency.

---

## 2. Inconsistencies & Anti-patterns

### 2.1 Section-component naming drift

| Component file                    | Default export              | Comment                                                                                                                                                                                                                                                                          |
| --------------------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `account-section.tsx`             | `AccountSection`            | OK — slug + `-section.tsx` + `<SlugSection>`                                                                                                                                                                                                                                     |
| `integrations-section.tsx`        | `IntegrationsSection`       | OK                                                                                                                                                                                                                                                                               |
| `notifications-section.tsx`       | `NotificationsSection`      | OK                                                                                                                                                                                                                                                                               |
| `dashboard-section.tsx`           | `DashboardSection`          | OK — but ALSO has `dashboard-layout-section.tsx` (`<DashboardLayoutSection>`) as the inner card.                                                                                                                                                                                 |
| `thresholds-settings-section.tsx` | `ThresholdsSettingsSection` | **Drift** — the slug is `thresholds`, the file is `thresholds-settings-section.tsx`, AND the inner card lives at `thresholds-section.tsx` (`<ThresholdsSection>`). The "settings" infix is redundant (everything in `src/components/settings/` is already a settings component). |
| `ai-section.tsx`                  | `AiSection`                 | OK (out of scope)                                                                                                                                                                                                                                                                |
| `api-section.tsx`                 | `ApiSection`                | OK                                                                                                                                                                                                                                                                               |
| `export-section.tsx`              | `ExportSection`             | OK (out of scope)                                                                                                                                                                                                                                                                |
| `advanced-section.tsx`            | `AdvancedSection`           | OK                                                                                                                                                                                                                                                                               |
| `about-section.tsx`               | `AboutSection`              | OK                                                                                                                                                                                                                                                                               |

**Decision (refactor commit 2):** the route-level wrapper is named after the
slug (`<SlugSection>`), the inner card keeps its own descriptive name
(`<DashboardLayoutSection>`, `<ThresholdsEditorSection>` post-refactor).
File layout normalises to:

- `src/components/settings/<slug>-section.tsx` — wrapper with `<h1>` + subtitle
- `src/components/settings/<slug>-<concern>-section.tsx` — internal card

That means renaming `thresholds-settings-section.tsx` → `thresholds-section.tsx`
**at the route boundary** and renaming the existing inner card from
`thresholds-section.tsx` → `thresholds-editor-section.tsx` so the names stop
clashing.

### 2.2 i18n key naming drift

The historic flat namespace (`settings.profile`, `settings.passkeyName`, …)
predates the section split. Result: the same concept is reachable under two
different keys.

| Concept                | Modern key                                           | Legacy key still in code                                 |
| ---------------------- | ---------------------------------------------------- | -------------------------------------------------------- |
| Account page title     | `settings.sections.account.title`                    | `settings.profile` _(card heading inside the page)_      |
| AI page title          | `settings.sections.ai.title` (= `settings.ai.title`) | `settings.kiInsights` (card heading) — duplicate         |
| Withings card title    | (none — only flat key)                               | `settings.withings`                                      |
| Token actions          | (none)                                               | `settings.tokenRevoke`, `settings.tokenRevoked`, …       |
| Doctor report          | `settings.sections.export.cards.doctorReport.title`  | `settings.doctorReport` (legacy)                         |
| Audit log              | (none)                                               | `settings.auditLog`, `settings.auditAction`, …           |
| Danger zone            | (none)                                               | `settings.dangerZone`, `settings.dangerZoneTitle`, …     |
| moodLog card title     | (none)                                               | `settings.moodLogTitle`                                  |
| Notifications channels | (none)                                               | `settings.telegram`, `settings.ntfy`, `settings.webPush` |

**Decision (refactor commit 2):**

- Keep `settings.sections.<slug>.{title,description}` as the canonical
  source for `<h1>` + subtitle. No change needed.
- Introduce `settings.sections.<slug>.cards.<cardName>.title` /
  `.description` / `.action` for major card headings within a section
  (mirrors the export shape `settings.sections.export.cards.*` that B7
  already rolled out).
- Leave the existing flat keys as **deprecation aliases** for now. Add a
  comment in JSON documenting that they are legacy. Don't churn every
  call-site in this audit stage — that's a separate hygiene PR.

### 2.3 Anti-pattern: section title vs sidebar label vs document `<title>`

| Slug          | Sidebar label (DE)      | Page `<h1>` (DE)                                           | Browser `<title>`       | Match?                                                                   |
| ------------- | ----------------------- | ---------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------ |
| account       | "Konto"                 | "Konto"                                                    | (Next.js inherits root) | yes                                                                      |
| integrations  | "Integrationen"         | "Integrationen"                                            | "                       | yes                                                                      |
| notifications | "Benachrichtigungen"    | "Benachrichtigungen"                                       | "                       | yes                                                                      |
| dashboard     | "Dashboard"             | "Dashboard"                                                | "                       | yes                                                                      |
| thresholds    | "Persönliche Zielwerte" | "Persönliche Zielwerte"                                    | "                       | yes                                                                      |
| ai            | "KI-Auswertungen"       | "KI-Insights" (legacy `settings.ai.title` = "KI-Insights") | "                       | **mismatch** — sidebar says "Auswertungen", page heading says "Insights" |
| api           | "API & Tokens"          | "API & Tokens"                                             | "                       | yes                                                                      |
| export        | "Export"                | "Export"                                                   | "                       | yes                                                                      |
| advanced      | "Erweitert"             | "Erweitert"                                                | "                       | yes                                                                      |
| about         | "Über"                  | "Über"                                                     | "                       | yes                                                                      |

The AI mismatch is **out of B6 scope** — B2 owns the AI section. Flagged
for B2.

EN side: equivalent mismatch — sidebar "AI Insights", page `<h1>` "AI
Insights" via `settings.sections.ai.title` (which happens to equal
`settings.ai.title`). That one's consistent in EN; only DE diverges.

### 2.4 Top/bottom split anti-pattern

Per the project's `feedback_settings_no_split.md` rule, there must be no instance where
a single concept is selected at the top of a section and configured at the
bottom. Audit:

| Section       | Top-bottom split?          | Notes                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Account       | No                         | One profile card, one passkey card, one password card, one tour card. Sequential, not split.                                                                                                                                                                                                                                                                                                                             |
| Integrations  | No                         | Withings + moodLog cards, each self-contained.                                                                                                                                                                                                                                                                                                                                                                           |
| Notifications | **Borderline**             | `<NotificationStatusCard>` lists per-channel status at the top; the per-channel config cards (`<TelegramCard>`, `<NtfyCard>`, `<WebPushCard>`) follow below. The status card has `Re-enable` + `Send test` actions per channel that arguably duplicate functionality in the config cards. **Not a top/bottom-split-of-one-concept** — the status card is a read-only summary, the config cards are mutators. Keeping it. |
| Dashboard     | No                         | One layout card.                                                                                                                                                                                                                                                                                                                                                                                                         |
| Thresholds    | No                         | One editor card with per-metric rows.                                                                                                                                                                                                                                                                                                                                                                                    |
| AI            | **YES (out of scope, B2)** | Provider dropdown at the top selects between OpenAI/Anthropic/Local; key/credential inputs for each provider live further down. This is the case the maintainer flagged explicitly.                                                                                                                                                                                                                                      |
| API           | No                         | Endpoints reference card + tokens card.                                                                                                                                                                                                                                                                                                                                                                                  |
| Export        | No                         | 5 cards, each self-contained.                                                                                                                                                                                                                                                                                                                                                                                            |
| Advanced      | No                         | Single danger-zone card (post-B7 cleanup).                                                                                                                                                                                                                                                                                                                                                                               |
| About         | No                         | Identity + sources + updates cards.                                                                                                                                                                                                                                                                                                                                                                                      |

**Decision:** AI flagged for B2 (already in roadmap). All other sections
are clean. Notifications kept as-is — the read-only-status-then-mutator
pattern is a deliberate choice, not a split anti-pattern.

### 2.5 Duplicate functionality between sections

| Concept                                     | Owner section                | Duplicated where?                                                                                                                                           | Action                                                                                                                                                                                        |
| ------------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Doctor-report PDF                           | Export (canonical)           | Used to live in Advanced as `<ExportCard>`. **Already removed in B7.**                                                                                      | None.                                                                                                                                                                                         |
| CSV/JSON export buttons                     | Export (canonical)           | Used to live in Advanced. **Already removed in B7.**                                                                                                        | None.                                                                                                                                                                                         |
| Language selector                           | Account ⇢ profile card       | NONE.                                                                                                                                                       | OK.                                                                                                                                                                                           |
| Channel test send                           | Notifications ⇢ status card  | Each individual channel card (`<TelegramCard>`, etc.) ALSO has a test-send button.                                                                          | Document — not removing; the status card surfaces it for failed channels (after auto-disable), the config cards have it as a "did I get the credentials right" smoke test. Different intents. |
| Withings credentials                        | Integrations ⇢ Withings card | NONE.                                                                                                                                                       | OK.                                                                                                                                                                                           |
| User-level settings vs admin-level settings | mostly disjoint              | `settings.adminAreaTitle` / `settings.openAdminConsole` exist as keys but are **not currently rendered anywhere** in any settings section component. Stale. | Mark `settings.adminAreaTitle` etc. as deprecated in JSON.                                                                                                                                    |

### 2.6 Settings vs Admin: scope rule

Settings are **per-user** (toggles that affect one account). Admin is
**system-wide** (toggles that affect every user, default policy, host
metrics, audit log read-access). Two cases overlap by design:

- **Notifications**: per-channel global on/off lives in `/admin` (admin
  decides if Telegram is allowed at all on the instance), per-user
  channel credentials live in `/settings/notifications` (the user sets
  their own bot token). The settings UI already reads
  `/api/settings/global-services` and hides cards when an admin has
  disabled the channel system-wide. **Correct division.**
- **AI providers**: same shape — admin sets a default key, user can
  override with their own. Out of B6 scope, but the division is correct.

No duplicate user-facing toggles found between `/admin` and `/settings`.
Keys like `settings.adminAreaTitle` / `settings.openAdminConsole` are
**dead code** — they were intended for a "shortcut to admin console" tile
in the user settings page that never shipped. **Marking deprecated.**

### 2.7 "Missing settings" — features without a UI

The following toggles or behaviours exist in the data layer but have no
end-user-visible setting today:

| Feature                              | Where it lives                                     | Should it have a setting?                          |
| ------------------------------------ | -------------------------------------------------- | -------------------------------------------------- |
| Onboarding-tour replay               | already shipped in `<AccountSection>` (v1.4.15 B5) | already done                                       |
| Achievements opt-out                 | server-side `<UserAchievement>` table              | low priority — defer                               |
| AI raw-data toggle (`rawData`)       | already in `<AiSection>` (out of scope)            | already done                                       |
| Personal medical-references override | server-side `users.medicalReferences`              | defer (B5a referenced this — not yet user-tunable) |
| Per-metric reminder schedule         | `Medication.schedule`                              | covered by medication editor, not settings         |
| Locale fallback ("auto-detect off")  | `i18n/config.ts`                                   | low priority — defer                               |

Nothing is shipped-without-UI that should be exposed in B6. The "deferred"
items belong in v1.5 product roadmap, not this audit.

### 2.8 DE/EN translation quality + consistency

Spot-checked:

- `settings.sections.account.description` EN: "Profile, sign-in methods, and account deletion." — but the section also covers password change + onboarding tour. **Description undersells the scope.** Recommend rewrite.
- `settings.sections.ai.description` EN/DE: "Provider, model, key." / "Provider, Modell, API-Key." — too terse, doesn't say what the section does. Recommend rewrite. (Out of scope, B2.)
- `settings.sections.api.description` EN: "Bearer tokens for headless clients." / DE: "Bearer-Tokens für Drittanbieter-Clients." — `Drittanbieter` is overloaded (third-party SaaS, not headless tooling). Recommend "Bearer-Tokens für eigene Skripte und Apps."
- `settings.sections.advanced.description` EN: "Import, danger zone." — but post-B7 there's no Import surface here, only the danger zone. **Stale.** Recommend "Account-wide danger zone — wipe all health data."
- `settings.sections.notifications.description` EN: "Telegram, ntfy, Web Push." — fine; lists the channels. DE same shape.
- `settings.sections.thresholds.description` EN: "Override target ranges for every metric." — clear.
- `settings.sections.dashboard.description` EN: "Tile layout and order." — clear.
- `settings.sections.integrations.description` EN: "Withings, moodLog, and other connected services." — fine.

**Action (refactor commit 2):** rewrite the three muddy descriptions
(`account`, `api`, `advanced`).

---

## 3. Logical grouping review

User feedback noted: "are settings grouped sensibly?". Current order
in the sidebar:

1. Account — personal identity + sign-in
2. Integrations — third-party data sources
3. Notifications — per-channel delivery
4. Dashboard — UI layout
5. Thresholds — target ranges (used by charts + insights)
6. AI — analysis provider
7. API — bearer tokens for headless clients
8. Export — data out
9. Advanced — danger zone
10. About — version + links

This order roughly reads as: **identity → data flow in → output
configuration → automation → data flow out → housekeeping → meta**.
Defensible. No re-order required.

One concept worth highlighting: **Thresholds + Dashboard are both UI
configuration**, but Thresholds also drives _insight_ + _AI_ outputs.
Putting Thresholds between Dashboard and AI keeps it close to both
concerns. Leaving as-is.

---

## 4. Refactor plan (the three commits that follow this audit)

Commit 1 (this commit) — `docs(audit): v1.4.16 settings naming + consolidation audit`

Commit 2 — `refactor(settings): consistent naming + i18n key namespace`

- Rename `thresholds-settings-section.tsx` → `thresholds-section.tsx`
  (route-level wrapper).
- Rename existing inner card from `thresholds-section.tsx` →
  `thresholds-editor-section.tsx`.
- Update `src/app/settings/[section]/page.tsx` import.
- Rewrite `settings.sections.account.description`,
  `settings.sections.api.description`,
  `settings.sections.advanced.description` in EN + DE per the audit.
- Mark `settings.adminAreaTitle`, `settings.adminAreaDescription`,
  `settings.openAdminConsole` as deprecated (JSON comment, no
  call-site uses them).
- Add `settings.sections.<slug>.cards.*` aliases for the major card
  headings (account profile/passkeys/password/tour;
  notifications status/telegram/ntfy/webPush; integrations
  withings/moodLog; api endpoints/tokens; advanced dangerZone).
  Don't break the existing flat keys — sections still consume them
  until a follow-up hygiene PR.

Commit 3 — `refactor(settings): remove duplicate toggles, route to canonical owner`

- Document the settings-vs-admin scope rule in the repo's project doc.
- No actual duplicate found that needs removing today; commit body
  documents the audit conclusion ("no duplicate user-facing toggles
  identified; settings keep per-user toggles, admin keeps system-wide
  toggles; legacy `settings.adminAreaTitle` keys are stale and marked
  deprecated").

Commit 4 — `test(settings): coverage for renamed/consolidated sections`

- Update `src/components/settings/__tests__/sections.test.tsx` to
  import the renamed thresholds component and assert the new file
  layout.
- Add an SSR smoke test that loops every slug in
  `SETTINGS_SECTION_SLUGS` (excluding `ai` + `export` because their
  components have heavy in-page state) and asserts:
  - The page renders without throwing
  - The `<h1>` resolves the localised title (no raw key leak)
  - The subtitle resolves
- Add an i18n parity test asserting every `settings.sections.<slug>`
  key has both `.title` and `.description` in both locales.

---

## 5. Out-of-scope items flagged for follow-up

- **B2** — `<AiSection>` provider top/bottom split + DE sidebar/heading
  mismatch ("KI-Auswertungen" vs "KI-Insights").
- **Hygiene PR (post-v1.4.16)** — migrate every flat `settings.<key>`
  consumer to the new `settings.sections.<slug>.cards.*` shape, then
  delete the legacy flat keys.
- **v1.5 roadmap** — surface achievements opt-out, personal
  medical-references override, locale-detection toggle.

---

## 6. Constraints honoured

- No user-facing setting removed.
- No new dependency added.
- All new i18n keys land in EN + DE.
- Pre-existing tests stay green.
- No `--no-verify`, no `--no-gpg-sign`.
