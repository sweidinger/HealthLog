# Medication intake repair

`scripts/repair-intake-anomalies.ts` repairs two known historic defects in
the medication intake ledger (`medication_intake_events`):

1. **Duplicate dose-slot rows.** More than one live row on the same exact
   `(user, medication, scheduled_for)` tuple — cross-source duplicates the
   pre-v1.15.19 write path could mint (e.g. a pending REMINDER row plus a
   taken API row for the same slot). The duplicate inflates the per-day
   scheduled count and paints a phantom entry in the history view.
2. **Implausible `taken_at`.** Live rows whose `taken_at` lands more than
   7 days before `scheduled_for` or more than 1 day in the future —
   typically the residue of a mis-attributed edit before the v1.15.19
   `taken_at` validation landed.

## When to use it

- After upgrading to v1.15.19+, when a user reports a compliance rate above
  100 %, duplicate entries in the medication history, or a dose shown as
  taken days away from its slot.
- The compliance rollup counts DISTINCT slots since v1.15.19, so the
  percentages self-correct on recompute even without running this script.
  Running it additionally clears the phantom rows from the history view.
- The `intake-slot-dedup` worker already collapses canonical-slot
  duplicates at boot and on a daily cron; this script is the manual,
  immediately-observable fallback and the only path that surfaces the
  implausible-`taken_at` rows.

## Run a dry-run first

Always. The default mode only reports and never mutates:

```bash
# inside the app container (or any checkout with DATABASE_URL set)
pnpm dlx tsx scripts/repair-intake-anomalies.ts

# scoped to one account
pnpm dlx tsx scripts/repair-intake-anomalies.ts --user <userId>
```

Use `pnpm dlx tsx`, not bare `pnpm tsx` — the production standalone image
strips `tsx`. `DATABASE_URL` must point at the target database.

The dry-run prints every duplicate group (which row would be kept, which
would be tombstoned) and a table of implausible rows (id, medication,
`scheduledFor`, `takenAt`, source, timestamps).

## Applying the fix

```bash
pnpm dlx tsx scripts/repair-intake-anomalies.ts --fix
```

`--fix` does three things:

- **Duplicate groups** are collapsed to one winner per slot. Precedence:
  an actioned row (taken or skipped) beats a pending one; between two
  taken rows the earlier `taken_at` wins; ties break deterministically on
  `created_at`, then `id`. Losers are soft-deleted (`deleted_at` set,
  `sync_version` incremented) — the same tombstone shape the delete route
  writes, so connected clients drop the rows on their next delta-sync.
  Nothing is ever hard-deleted.
- **Implausible `taken_at` rows are NOT touched.** The recorded intent is
  unknowable, so the operator (or the user) corrects or deletes them in
  the medication history tab. To soft-delete them wholesale instead, opt
  in explicitly:

  ```bash
  pnpm dlx tsx scripts/repair-intake-anomalies.ts --fix --tombstone-implausible
  ```

  `--tombstone-implausible` is refused without `--fix`.
- **Affected compliance rollups are recomputed** for every touched
  `(user, medication, day)` through the shared rollup helper, so the
  scheduled/taken counts and the rate self-correct immediately.

The script is idempotent: a second `--fix` run finds zero duplicate groups
and changes nothing. Exit code is 0 on success (including a clean
zero-findings run), non-zero on bad arguments or a fatal error.
