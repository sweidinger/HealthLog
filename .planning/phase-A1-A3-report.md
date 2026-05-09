# Phase A1 + A3 — Sidebar admin no-expand + api-tokens mobile no-overflow

Status: complete
Date: 2026-05-09T23:26+02:00
Agent: Wave-A bucket-1 (A1 + A3)

## A1 — Sidebar admin entry mirrors Settings exactly

Marc reported that v1.4.15 A1's "context-aware" expansion still felt
wrong: the global sidebar auto-expanded admin sub-items on `/admin/*`
and the gravatar dropdown felt linked to sidebar state. Settings has
none of that — it's just a single link, with `<SettingsShell>`
rendering the per-section nav inside the page itself. `<AdminShell>`
already does the same thing.

Fix: dropped the entire `{onAdminPage && <ul>...</ul>}` block from
`src/components/layout/sidebar-nav.tsx`. The Admin entry is now a
single `<Link>` mirroring the Settings entry verbatim. Also removed
the now-unused `ADMIN_SECTIONS` import.

Tests:

- `sidebar-nav.test.tsx` — every admin-route case asserts ONLY the
  single `/admin` link is present, never sub-route links.
- New e2e `e2e/sidebar-admin-no-expand.spec.ts` (desktop-only project)
  covers (a) /admin/* shows one link no sub-list, (b) clicking Admin
  from /dashboard navigates without flashing sub-items, (c) opening
  the gravatar user-menu does not expand sidebar admin sub-items.

Commit: `77fe256 fix(nav): admin sub-items don't expand from gravatar
dropdown or admin-link click`.

## A3 — /admin/api-tokens table no horizontal overflow on Pixel 5

v1.4.15 A2 hid columns + tightened card padding, but Marc still saw a
scrollbar on prod at `/admin/api-tokens` on Pixel-5 (393 CSS px).
Hiding columns kept an `overflow-x-auto` wrapper, and long permission
lists / token names could still push the scroll inside the card.

Fix: mirror `<UserManagementSection>`. Desktop `<table>` is now gated
behind `hidden md:block`; a real mobile card-list renders at <md
(`<ul md:hidden data-testid="admin-tokens-mobile-list">`). Mobile
cards: stacked layout, `truncate break-all` on names, flex-wrap badges,
no nowrap on date paragraphs.

Tests:

- `api-token-overview-responsive.test.tsx` rewritten to assert: hidden
  md:block desktop wrapper; mobile <ul> with stable testid; no
  overflow-x-auto inside the mobile card-list; meta paragraphs wrap.
- New e2e `e2e/admin-api-tokens-mobile.spec.ts` mocks worst-case
  payload (long username, multiple permissions, long token name) and
  asserts `documentElement.scrollWidth <= window.innerWidth + 1` at
  Pixel-5 viewport.

Commit: `277a5aa fix(admin): api-tokens table no horizontal overflow
on Pixel-5 viewport`.

## Verification

- `pnpm test`: 1056/1057 pass; the 1 failure
  (`bp-in-target.test.ts > regression: Marc's production data`) is
  inside Wave-A bucket-2's (A2) ongoing work and is out of scope.
- `pnpm typecheck`: clean.
- `pnpm lint`: 12 pre-existing warnings, 0 errors.

## Push race notes

The first commit `77fe256` accidentally swept in two parallel-agent
research artefacts (`.planning/phase-research-report.md`,
`.planning/v1416-research-ai-recommendations.md`) — likely a hook or
tooling layer above git autostaging untracked .planning files at
commit time. The contents are legitimate marathon research output and
needed committing eventually; left as-is rather than amending. The
second commit `277a5aa` carried only the three intended files.

Both commits were pushed to `origin/main` and confirmed at HEAD.
