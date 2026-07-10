/**
 * scripts/repair-google-health-sleep.ts — operator repair for the historic
 * Google Health sleep OVER-COUNT.
 *
 * THE DEFECT (fixed in code from v1.28.18): the per-segment sleep externalId was
 * keyed on a VOLATILE anchor (the session's `interval.endTime` plus a positional
 * segment index). When Google re-scored a night after the fact — which the sync
 * deliberately re-fetches on a 24 h overlap — the shifted anchor/index minted
 * FRESH externalIds, so the upsert created a SECOND parallel set of stage rows
 * for the same night instead of overwriting. The night-total then summed both
 * copies (a real 7h35 night could read as 10h+).
 *
 * THE CODE FIX anchors the externalId on Google's stable resource `name` plus
 * the segment's own start, and — via `replaceStaleGoogleHealthSleep` —
 * soft-deletes any stale row left in a re-fetched night's window before the
 * fresh set upserts. That makes every FUTURE sync idempotent and self-healing
 * for any night inside the incremental overlap.
 *
 * THIS SCRIPT heals HISTORY: nights older than the incremental window keep their
 * duplicate rows until re-fetched. It runs a FULL Google Health re-sync per
 * connected user, which re-imports every sleep session and lets the
 * replace-by-window cleanup collapse each night to a single canonical set (and
 * re-folds the rollup tier). It reuses the production sync path verbatim — no
 * bespoke SQL — so it can only do what an ordinary re-sync does.
 *
 * SAFETY: dry-run by default (lists the connections that WOULD be re-synced and
 * exits). Pass `--run` to execute. Runs users sequentially to avoid a burst
 * against Google's API. A per-user failure is reported and skipped, never fatal.
 *
 * RUN (never `pnpm tsx` — the standalone image strips tsx):
 *   pnpm dlx tsx scripts/repair-google-health-sleep.ts          # dry run
 *   pnpm dlx tsx scripts/repair-google-health-sleep.ts --run    # execute
 */
import { prisma } from "@/lib/db";
import { syncUserGoogleHealth } from "@/lib/google-health/sync";

async function main(): Promise<void> {
  const execute = process.argv.includes("--run");

  const connections = await prisma.googleHealthConnection.findMany({
    select: { userId: true },
  });

  if (connections.length === 0) {
    console.log("No Google Health connections found — nothing to repair.");
    return;
  }

  console.log(
    `${connections.length} Google Health connection(s) found.` +
      (execute
        ? " Running a full re-sync per user (sequential)…"
        : " Dry run — pass --run to execute. Would re-sync:"),
  );

  if (!execute) {
    for (const { userId } of connections) console.log(`  • ${userId}`);
    console.log(
      "\nA full re-sync re-imports all Google Health data for each user and " +
        "collapses each re-scored night to one canonical set. Re-run with --run.",
    );
    return;
  }

  let ok = 0;
  let failed = 0;
  for (const { userId } of connections) {
    try {
      const imported = await syncUserGoogleHealth(userId, { fullSync: true });
      ok += 1;
      console.log(`  ✓ ${userId} — re-synced (${imported} rows imported)`);
    } catch (err) {
      failed += 1;
      console.error(
        `  ✗ ${userId} — re-sync failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  console.log(`\nDone. ${ok} re-synced, ${failed} failed.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
