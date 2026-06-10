/**
 * scripts/repair-intake-anomalies.ts — operator repair for the two known
 * historic medication-ledger defects:
 *
 *   1. SLOT DUPLICATES — more than one live `medication_intake_events` row
 *      on the same exact `(user_id, medication_id, scheduled_for)` tuple
 *      (cross-source duplicates the pre-v1.15.19 write path could mint).
 *      Repair: keep one winner per slot (H1 precedence, see `pickWinner`
 *      below) and soft-delete the losers — `deleted_at = now()`,
 *      `sync_version` incremented, `updated_at` bumped via `@updatedAt` —
 *      exactly the tombstone shape the per-event DELETE route and the
 *      `intake-slot-dedup` worker write, so iOS delta-sync drops them.
 *
 *   2. IMPLAUSIBLE TAKEN_AT — live rows whose `taken_at` lands more than
 *      7 days before `scheduled_for` or more than 1 day in the future.
 *      User intention is unknowable here, so these are REPORTED only
 *      (correct or delete them in the medication history tab). With
 *      `--fix --tombstone-implausible` the operator can explicitly opt
 *      into soft-deleting them.
 *
 * After any mutation the affected `(user, medication, day)` compliance
 * rollups are recomputed through the shared rollup helpers — no SQL is
 * duplicated here. The rollup aggregates DISTINCT slots since v1.15.19,
 * so a recompute alone already heals the counts; the tombstones
 * additionally clear the phantom rows from the history view.
 *
 * Default is a DRY-RUN that only reports. Idempotent: a second `--fix`
 * run finds zero groups and changes nothing.
 *
 * Usage
 * -----
 *   pnpm dlx tsx scripts/repair-intake-anomalies.ts                  # dry-run
 *   pnpm dlx tsx scripts/repair-intake-anomalies.ts --user <id>      # scoped dry-run
 *   pnpm dlx tsx scripts/repair-intake-anomalies.ts --fix
 *   pnpm dlx tsx scripts/repair-intake-anomalies.ts --fix --tombstone-implausible
 *
 * `DATABASE_URL` must point at the target database.
 */
import "dotenv/config";
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import {
  dayKeyForScheduledFor,
  recomputeMedicationComplianceForDay,
} from "@/lib/rollups/medication-compliance-rollups";

const TAG = "[repair-intake-anomalies]";

interface CliOptions {
  fix: boolean;
  tombstoneImplausible: boolean;
  userId: string | null;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    fix: false,
    tombstoneImplausible: false,
    userId: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--fix") {
      opts.fix = true;
    } else if (arg === "--tombstone-implausible") {
      opts.tombstoneImplausible = true;
    } else if (arg === "--user" && argv[i + 1]) {
      opts.userId = argv[i + 1];
      i += 1;
    } else {
      console.error(`${TAG} unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return opts;
}

interface IntakeRow {
  id: string;
  takenAt: Date | null;
  skipped: boolean;
  source: string;
  createdAt: Date;
}

/**
 * Rank a row for the slot-winner pick: taken (2) > skipped (1) >
 * pending (0). `takenAt` set and `skipped` together still counts as
 * taken — the recorded dose dominates.
 */
function rowRank(row: IntakeRow): number {
  if (row.takenAt !== null) return 2;
  if (row.skipped) return 1;
  return 0;
}

/**
 * Pick the winner among the live rows sharing one exact slot.
 *
 * H1 precedence — neither in-tree helper is exported, so the rule is
 * rebuilt here; see `pickSlotRow` in
 * `src/lib/medications/scheduling/slot-upsert.ts` (actioned > pending,
 * deterministic `createdAt asc, id asc` tie-break) and `pickWinner` in
 * `src/lib/medications/intake-slot-dedup.ts` (taken > skipped > pending):
 *
 *   1. actioned beats pending (never resurrect a phantom pending row;
 *      deleting a recorded dose would under-report adherence — the
 *      dangerous direction);
 *   2. between two taken rows the EARLIER `takenAt` wins — the first
 *      recorded intake is the dose of record;
 *   3. final tie-break `createdAt asc`, then `id asc` — fully
 *      deterministic across runs and DB orderings.
 */
function pickWinner(rows: IntakeRow[]): IntakeRow {
  return [...rows].sort((a, b) => {
    const rank = rowRank(b) - rowRank(a);
    if (rank !== 0) return rank;
    if (a.takenAt !== null && b.takenAt !== null) {
      const dt = a.takenAt.getTime() - b.takenAt.getTime();
      if (dt !== 0) return dt;
    }
    const created = a.createdAt.getTime() - b.createdAt.getTime();
    if (created !== 0) return created;
    return a.id < b.id ? -1 : 1;
  })[0];
}

/** `userId -> timezone` cache for the rollup day-key derivation. */
const tzCache = new Map<string, string | null>();

async function userTimezone(userId: string): Promise<string | null> {
  if (!tzCache.has(userId)) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { timezone: true },
    });
    tzCache.set(userId, user?.timezone ?? null);
  }
  return tzCache.get(userId) ?? null;
}

interface Summary {
  duplicateGroups: number;
  rowsTombstoned: number;
  implausibleRows: number;
  implausibleTombstoned: number;
  rollupsRecomputed: number;
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error(`${TAG} DATABASE_URL must be set`);
    process.exit(1);
  }

  const opts = parseArgs(process.argv.slice(2));
  if (opts.tombstoneImplausible && !opts.fix) {
    console.error(
      `${TAG} --tombstone-implausible requires --fix (dry-run never mutates)`,
    );
    process.exit(2);
  }

  console.log(
    `${TAG} mode=${opts.fix ? "FIX" : "DRY-RUN"}` +
      (opts.tombstoneImplausible ? " +tombstone-implausible" : "") +
      (opts.userId ? ` user=${opts.userId}` : " (all users)"),
  );

  const summary: Summary = {
    duplicateGroups: 0,
    rowsTombstoned: 0,
    implausibleRows: 0,
    implausibleTombstoned: 0,
    rollupsRecomputed: 0,
  };

  const userFilter = opts.userId
    ? Prisma.sql`AND e."user_id" = ${opts.userId}`
    : Prisma.empty;

  // `(userId, medicationId, dayKey)` tuples whose compliance rollup needs
  // a recompute after the tombstones. Deduped so a busy day folds once.
  const daysToRecompute = new Set<string>();

  // ───────────────────────────────────────────────────────────────────
  // 1. Slot duplicates — exact (user, medication, scheduled_for) tuples
  //    carrying more than one live row.
  // ───────────────────────────────────────────────────────────────────
  const groups = await prisma.$queryRaw<
    Array<{
      user_id: string;
      medication_id: string;
      scheduled_for: Date;
      row_count: number;
    }>
  >`
    SELECT e."user_id", e."medication_id", e."scheduled_for",
           COUNT(*)::int AS row_count
    FROM "medication_intake_events" e
    WHERE e."deleted_at" IS NULL
      ${userFilter}
    GROUP BY e."user_id", e."medication_id", e."scheduled_for"
    HAVING COUNT(*) > 1
    ORDER BY e."user_id", e."medication_id", e."scheduled_for"
  `;

  summary.duplicateGroups = groups.length;
  console.log(`\n${TAG} 1) duplicate slot groups found: ${groups.length}`);

  for (const group of groups) {
    const rows = (await prisma.medicationIntakeEvent.findMany({
      where: {
        userId: group.user_id,
        medicationId: group.medication_id,
        scheduledFor: group.scheduled_for,
        deletedAt: null,
      },
      select: {
        id: true,
        takenAt: true,
        skipped: true,
        source: true,
        createdAt: true,
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    })) as IntakeRow[];
    if (rows.length < 2) continue; // collapsed since the scan — nothing to do.

    const winner = pickWinner(rows);
    const losers = rows.filter((r) => r.id !== winner.id);

    console.log(
      `  - user=${group.user_id} medication=${group.medication_id} ` +
        `slot=${group.scheduled_for.toISOString()} rows=${rows.length} ` +
        `keep=${winner.id} (${winner.source}, ` +
        `${winner.takenAt ? `taken ${winner.takenAt.toISOString()}` : winner.skipped ? "skipped" : "pending"}) ` +
        `tombstone=[${losers.map((r) => `${r.id} (${r.source})`).join(", ")}]`,
    );

    if (opts.fix) {
      // Same tombstone the per-event DELETE route and the dedup worker
      // write: soft-delete + syncVersion bump (the sync feed echoes a
      // monotonic value so iOS drops the row); `updatedAt` bumps via the
      // schema's `@updatedAt`. The `deletedAt: null` guard keeps the
      // write idempotent against a concurrent collapse.
      const res = await prisma.medicationIntakeEvent.updateMany({
        where: { id: { in: losers.map((r) => r.id) }, deletedAt: null },
        data: { deletedAt: new Date(), syncVersion: { increment: 1 } },
      });
      summary.rowsTombstoned += res.count;

      const tz = await userTimezone(group.user_id);
      const dayKey = dayKeyForScheduledFor(group.scheduled_for, tz);
      daysToRecompute.add(
        `${group.user_id}|${group.medication_id}|${dayKey}`,
      );
    }
  }

  // ───────────────────────────────────────────────────────────────────
  // 2. Implausible taken_at — report only; tombstone needs explicit
  //    operator opt-in.
  // ───────────────────────────────────────────────────────────────────
  const implausible = await prisma.$queryRaw<
    Array<{
      id: string;
      user_id: string;
      medication_id: string;
      medication_name: string;
      scheduled_for: Date;
      taken_at: Date;
      source: string;
      created_at: Date;
      updated_at: Date;
    }>
  >`
    SELECT e."id", e."user_id", e."medication_id",
           m."name" AS medication_name,
           e."scheduled_for", e."taken_at", e."source"::text AS source,
           e."created_at", e."updated_at"
    FROM "medication_intake_events" e
    JOIN "medications" m ON m."id" = e."medication_id"
    WHERE e."deleted_at" IS NULL
      AND e."taken_at" IS NOT NULL
      AND (e."taken_at" < e."scheduled_for" - interval '7 days'
           OR e."taken_at" > now() + interval '1 day')
      ${userFilter}
    ORDER BY e."user_id", e."taken_at"
  `;

  summary.implausibleRows = implausible.length;
  console.log(`\n${TAG} 2) implausible taken_at rows found: ${implausible.length}`);
  if (implausible.length > 0) {
    console.table(
      implausible.map((r) => ({
        id: r.id,
        medication: r.medication_name,
        scheduledFor: r.scheduled_for.toISOString(),
        takenAt: r.taken_at.toISOString(),
        source: r.source,
        createdAt: r.created_at.toISOString(),
        updatedAt: r.updated_at.toISOString(),
      })),
    );
    if (!(opts.fix && opts.tombstoneImplausible)) {
      console.log(
        `${TAG} these rows are NOT changed automatically — the recorded ` +
          `intent is unknowable. Correct or delete them in the medication ` +
          `history tab, or re-run with --fix --tombstone-implausible to ` +
          `soft-delete them.`,
      );
    }
  }

  if (opts.fix && opts.tombstoneImplausible && implausible.length > 0) {
    const res = await prisma.medicationIntakeEvent.updateMany({
      where: {
        id: { in: implausible.map((r) => r.id) },
        deletedAt: null,
      },
      data: { deletedAt: new Date(), syncVersion: { increment: 1 } },
    });
    summary.implausibleTombstoned = res.count;
    console.log(
      `${TAG} tombstoned ${res.count} implausible row(s) (operator opt-in)`,
    );

    for (const row of implausible) {
      const tz = await userTimezone(row.user_id);
      const dayKey = dayKeyForScheduledFor(row.scheduled_for, tz);
      daysToRecompute.add(`${row.user_id}|${row.medication_id}|${dayKey}`);
    }
  }

  // ───────────────────────────────────────────────────────────────────
  // 3. Recompute the affected compliance rollups so scheduled/taken
  //    counts self-correct. Shared helper — no SQL duplicated here.
  // ───────────────────────────────────────────────────────────────────
  if (opts.fix && daysToRecompute.size > 0) {
    console.log(
      `\n${TAG} 3) recomputing ${daysToRecompute.size} compliance rollup day(s)`,
    );
    for (const key of daysToRecompute) {
      const [userId, medicationId, dayKey] = key.split("|");
      try {
        await recomputeMedicationComplianceForDay(
          userId,
          medicationId,
          dayKey,
          await userTimezone(userId),
        );
        summary.rollupsRecomputed += 1;
      } catch (err) {
        console.error(
          `${TAG} rollup recompute failed for ${key}: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  // ───────────────────────────────────────────────────────────────────
  // Summary
  // ───────────────────────────────────────────────────────────────────
  console.log(`\n${TAG} ${opts.fix ? "DONE" : "DRY-RUN — nothing changed"}`);
  console.log(`  duplicate slot groups:        ${summary.duplicateGroups}`);
  console.log(`  duplicate rows tombstoned:    ${summary.rowsTombstoned}`);
  console.log(`  implausible taken_at rows:    ${summary.implausibleRows}`);
  console.log(`  implausible rows tombstoned:  ${summary.implausibleTombstoned}`);
  console.log(`  rollup days recomputed:       ${summary.rollupsRecomputed}`);
}

main()
  .catch((err) => {
    console.error(`${TAG} fatal error:`, err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
