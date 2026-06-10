/**
 * scripts/repair-intake-anomalies.ts — operator repair for the two known
 * historic medication-ledger defects:
 *
 *   1. SLOT DUPLICATES — more than one live `medication_intake_events` row
 *      on the same exact `(user_id, medication_id, scheduled_for)` tuple
 *      (cross-source duplicates the pre-v1.15.19 write path could mint).
 *      Repair: keep one winner per slot (H1 precedence, see `pickWinner`
 *      below) and soft-delete the losers — `deleted_at = now()`,
 *      `sync_version` incremented, `updated_at` bumped — exactly the
 *      tombstone shape the per-event DELETE route and the
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
 * rollups are recomputed with the SAME slot-level DISTINCT aggregation the
 * shared helper runs — see `recomputeComplianceDay` below, a verbatim
 * SQL twin of `recomputeMedicationComplianceForDay` in
 * `src/lib/rollups/medication-compliance-rollups.ts`. The rollup
 * aggregates DISTINCT slots since v1.15.19, so a recompute alone already
 * heals the counts; the tombstones additionally clear the phantom rows
 * from the history view.
 *
 * Default is a DRY-RUN that only reports. Idempotent: a second `--fix`
 * run finds zero groups and changes nothing.
 *
 * SELF-CONTAINED by design (v1.16.0)
 * ----------------------------------
 * The production standalone image ships neither the project
 * `node_modules` tree nor the `@/` path alias, so the previous
 * `dotenv/config` + `@/lib/db` import chain died with "Cannot find
 * module" inside the container. This script therefore depends on
 * exactly ONE package — `pg` — and reads `DATABASE_URL` straight from
 * the environment (no dotenv). Inside the production image `pg` resolves
 * via `NODE_PATH=/opt/pg-boss/node_modules` (Dockerfile installs
 * `pg@8.x` there); in a repo checkout it resolves from the project
 * `node_modules`. The `pnpm dlx` invocation below supplies `tsx` (the
 * standalone image strips it) and pins `pg` for any environment where
 * neither resolution path exists.
 *
 * Usage
 * -----
 *   # dry-run (DATABASE_URL must point at the target database)
 *   pnpm dlx --package pg --package tsx tsx scripts/repair-intake-anomalies.ts
 *
 *   # scoped dry-run
 *   pnpm dlx --package pg --package tsx tsx scripts/repair-intake-anomalies.ts --user <id>
 *
 *   # apply
 *   pnpm dlx --package pg --package tsx tsx scripts/repair-intake-anomalies.ts --fix
 *   pnpm dlx --package pg --package tsx tsx scripts/repair-intake-anomalies.ts --fix --tombstone-implausible
 */
import { Client, types } from "pg";

const TAG = "[repair-intake-anomalies]";

// Prisma stores `DateTime` columns as `timestamp(3)` WITHOUT time zone,
// carrying UTC wall-clock values. node-postgres would parse those as
// LOCAL time by default; this parser pins them back to UTC so every
// Date this script handles is the true instant. (OID 1114 = timestamp
// without time zone.)
types.setTypeParser(1114, (value: string) => new Date(`${value.replace(" ", "T")}Z`));

/**
 * Serialise a Date for a `timestamp without time zone` comparison /
 * equality parameter. The ISO string's `Z` suffix is ignored by the
 * `::timestamp` cast, so the bound value is the UTC wall-clock — the
 * exact representation the column stores. Millisecond-precise, so
 * slot-equality (`scheduled_for = $n::timestamp`) round-trips exactly.
 */
function utcParam(date: Date): string {
  return date.toISOString();
}

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

// ─────────────────────────────────────────────────────────────────────
// Timezone / day-key helpers — self-contained twins of the app helpers
// the previous revision imported. Reference implementations:
//   - `userDayKey` / `DEFAULT_TIMEZONE`: `src/lib/tz/format.ts`
//   - `tzOffsetMinutes` / `startOfDayUtcInTz` / the DST-safe day-after
//     boundary: `src/lib/rollups/medication-compliance-rollups.ts`
// ─────────────────────────────────────────────────────────────────────

const DEFAULT_TIMEZONE = "Europe/Berlin";

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function safeTimezone(tz: string | null | undefined): string {
  if (tz && isValidTimezone(tz)) return tz;
  return DEFAULT_TIMEZONE;
}

/** `YYYY-MM-DD` of the instant in the user's tz (en-CA = ISO order). */
function dayKeyForScheduledFor(
  scheduledFor: Date,
  tz: string | null | undefined,
): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: safeTimezone(tz),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(scheduledFor);
}

/** UTC offset (minutes) of `tz` at the given instant; honours DST. */
function tzOffsetMinutes(date: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? "0";
  let hour = Number(get("hour"));
  if (hour === 24) hour = 0;
  const asIfUtc = Date.UTC(
    Number(get("year")),
    Number(get("month")) - 1,
    Number(get("day")),
    hour,
    Number(get("minute")),
    Number(get("second")),
  );
  return Math.round((asIfUtc - date.getTime()) / 60000);
}

/** UTC instant of local-midnight on `dayKey` in `tz` (2-pass for DST). */
function startOfDayUtcInTz(dayKey: string, tz: string): Date {
  const [yearStr, monthStr, dayStr] = dayKey.split("-");
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  let guess = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
  for (let i = 0; i < 2; i++) {
    const offsetMin = tzOffsetMinutes(guess, tz);
    guess = new Date(
      Date.UTC(year, month - 1, day, 0, 0, 0, 0) - offsetMin * 60_000,
    );
  }
  return guess;
}

/**
 * `[start, windowEnd)` UTC window of the local calendar day — the same
 * DST-safe boundary derivation `recomputeMedicationComplianceForDay`
 * runs (23 / 25-hour days fold correctly because the end anchors on
 * the NEXT day's local midnight, not `start + 24 h`).
 */
function dayWindowUtc(dayKey: string, tz: string): { start: Date; end: Date } {
  const start = startOfDayUtcInTz(dayKey, tz);
  const fallbackEnd = new Date(start.getTime() + 86_400_000);
  const [y, m, d] = dayKey.split("-").map(Number);
  const probeNext = new Date(Date.UTC(y, m - 1, d, 12, 0, 0) + 86_400_000);
  const nextDayKey = dayKeyForScheduledFor(probeNext, tz);
  const dstSafeEnd = startOfDayUtcInTz(nextDayKey, tz);
  return {
    start,
    end: dstSafeEnd.getTime() > start.getTime() ? dstSafeEnd : fallbackEnd,
  };
}

/**
 * Recompute one `(userId, medicationId, dayKey)` compliance-rollup row.
 *
 * VERBATIM SQL TWIN of `recomputeMedicationComplianceForDay` in
 * `src/lib/rollups/medication-compliance-rollups.ts` — keep the two in
 * sync when the rollup contract changes. v1.15.19 semantics: the inner
 * CTE folds rows sharing one `scheduled_for` instant into one DISTINCT
 * slot with taken-beats-skipped priority; the outer aggregate counts
 * slots, not rows, so a duplicated slot can never inflate `scheduled`.
 * The upsert re-aggregates inside the statement (atomic against
 * concurrent app writers); the trailing DELETE clears the row when the
 * day no longer holds any live event.
 */
async function recomputeComplianceDay(
  client: Client,
  userId: string,
  medicationId: string,
  dayKey: string,
  tz: string | null | undefined,
): Promise<void> {
  const { start, end } = dayWindowUtc(dayKey, safeTimezone(tz));
  await client.query(
    `
    WITH slot AS (
      SELECT
        BOOL_OR("taken_at" IS NOT NULL AND NOT "skipped") AS slot_taken,
        BOOL_OR("skipped")                                AS slot_skipped
      FROM "medication_intake_events"
      WHERE "user_id"        = $1
        AND "medication_id"  = $2
        AND "deleted_at"     IS NULL
        AND "scheduled_for" >= $4::timestamp
        AND "scheduled_for" <  $5::timestamp
      GROUP BY "scheduled_for"
    ),
    aggregate AS (
      SELECT
        COUNT(*)::int                                                            AS scheduled,
        COALESCE(SUM(CASE WHEN "slot_taken" THEN 1 ELSE 0 END), 0)::int          AS taken,
        COALESCE(SUM(CASE WHEN NOT "slot_taken" AND "slot_skipped" THEN 1 ELSE 0 END), 0)::int AS skipped
      FROM slot
    )
    INSERT INTO "medication_compliance_rollups"
      ("user_id", "medication_id", "day", "scheduled", "taken", "skipped", "computed_at")
    SELECT $1, $2, $3, aggregate.scheduled, aggregate.taken, aggregate.skipped, NOW()
    FROM aggregate
    WHERE aggregate.scheduled > 0
    ON CONFLICT ("user_id", "medication_id", "day") DO UPDATE
      SET "scheduled"   = EXCLUDED."scheduled",
          "taken"       = EXCLUDED."taken",
          "skipped"     = EXCLUDED."skipped",
          "computed_at" = EXCLUDED."computed_at"
    `,
    [userId, medicationId, dayKey, utcParam(start), utcParam(end)],
  );
  await client.query(
    `
    DELETE FROM "medication_compliance_rollups"
    WHERE "user_id"       = $1
      AND "medication_id" = $2
      AND "day"           = $3
      AND NOT EXISTS (
        SELECT 1
        FROM "medication_intake_events"
        WHERE "user_id"        = $1
          AND "medication_id"  = $2
          AND "deleted_at"     IS NULL
          AND "scheduled_for" >= $4::timestamp
          AND "scheduled_for" <  $5::timestamp
      )
    `,
    [userId, medicationId, dayKey, utcParam(start), utcParam(end)],
  );
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
    console.error(
      `${TAG} DATABASE_URL must be set (no dotenv — export it or prefix ` +
        `the command: DATABASE_URL='postgresql://…' pnpm dlx …)`,
    );
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

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  const summary: Summary = {
    duplicateGroups: 0,
    rowsTombstoned: 0,
    implausibleRows: 0,
    implausibleTombstoned: 0,
    rollupsRecomputed: 0,
  };

  // Optional per-user scope. The fragment is a fixed string with a
  // positional placeholder — never user-input spliced.
  const userFilter = opts.userId ? `AND e."user_id" = $1` : "";
  const userParams = opts.userId ? [opts.userId] : [];

  /** `userId -> timezone` cache for the rollup day-key derivation. */
  const tzCache = new Map<string, string | null>();
  async function userTimezone(userId: string): Promise<string | null> {
    if (!tzCache.has(userId)) {
      const res = await client.query<{ timezone: string | null }>(
        `SELECT "timezone" FROM "users" WHERE "id" = $1`,
        [userId],
      );
      tzCache.set(userId, res.rows[0]?.timezone ?? null);
    }
    return tzCache.get(userId) ?? null;
  }

  // `(userId, medicationId, dayKey)` tuples whose compliance rollup needs
  // a recompute after the tombstones. Deduped so a busy day folds once.
  const daysToRecompute = new Set<string>();

  try {
    // ─────────────────────────────────────────────────────────────────
    // 1. Slot duplicates — exact (user, medication, scheduled_for)
    //    tuples carrying more than one live row.
    // ─────────────────────────────────────────────────────────────────
    const groups = await client.query<{
      user_id: string;
      medication_id: string;
      scheduled_for: Date;
      row_count: number;
    }>(
      `
      SELECT e."user_id", e."medication_id", e."scheduled_for",
             COUNT(*)::int AS row_count
      FROM "medication_intake_events" e
      WHERE e."deleted_at" IS NULL
        ${userFilter}
      GROUP BY e."user_id", e."medication_id", e."scheduled_for"
      HAVING COUNT(*) > 1
      ORDER BY e."user_id", e."medication_id", e."scheduled_for"
      `,
      userParams,
    );

    summary.duplicateGroups = groups.rows.length;
    console.log(
      `\n${TAG} 1) duplicate slot groups found: ${groups.rows.length}`,
    );

    for (const group of groups.rows) {
      const rowsRes = await client.query<{
        id: string;
        taken_at: Date | null;
        skipped: boolean;
        source: string;
        created_at: Date;
      }>(
        `
        SELECT "id", "taken_at", "skipped", "source"::text AS source, "created_at"
        FROM "medication_intake_events"
        WHERE "user_id"       = $1
          AND "medication_id" = $2
          AND "scheduled_for" = $3::timestamp
          AND "deleted_at"    IS NULL
        ORDER BY "created_at" ASC, "id" ASC
        `,
        [group.user_id, group.medication_id, utcParam(group.scheduled_for)],
      );
      const rows: IntakeRow[] = rowsRes.rows.map((r) => ({
        id: r.id,
        takenAt: r.taken_at,
        skipped: r.skipped,
        source: r.source,
        createdAt: r.created_at,
      }));
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
        // monotonic value so iOS drops the row). Prisma's `@updatedAt`
        // is client-side, so raw SQL bumps `updated_at` explicitly —
        // the offline-sync keyset feed orders on it. The
        // `deleted_at IS NULL` guard keeps the write idempotent against
        // a concurrent collapse.
        const res = await client.query(
          `
          UPDATE "medication_intake_events"
          SET "deleted_at"   = NOW(),
              "sync_version" = "sync_version" + 1,
              "updated_at"   = NOW()
          WHERE "id" = ANY($1) AND "deleted_at" IS NULL
          `,
          [losers.map((r) => r.id)],
        );
        summary.rowsTombstoned += res.rowCount ?? 0;

        const tz = await userTimezone(group.user_id);
        const dayKey = dayKeyForScheduledFor(group.scheduled_for, tz);
        daysToRecompute.add(
          `${group.user_id}|${group.medication_id}|${dayKey}`,
        );
      }
    }

    // ─────────────────────────────────────────────────────────────────
    // 2. Implausible taken_at — report only; tombstone needs explicit
    //    operator opt-in.
    // ─────────────────────────────────────────────────────────────────
    const implausibleRes = await client.query<{
      id: string;
      user_id: string;
      medication_id: string;
      medication_name: string;
      scheduled_for: Date;
      taken_at: Date;
      source: string;
      created_at: Date;
      updated_at: Date;
    }>(
      `
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
      `,
      userParams,
    );
    const implausible = implausibleRes.rows;

    summary.implausibleRows = implausible.length;
    console.log(
      `\n${TAG} 2) implausible taken_at rows found: ${implausible.length}`,
    );
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
      const res = await client.query(
        `
        UPDATE "medication_intake_events"
        SET "deleted_at"   = NOW(),
            "sync_version" = "sync_version" + 1,
            "updated_at"   = NOW()
        WHERE "id" = ANY($1) AND "deleted_at" IS NULL
        `,
        [implausible.map((r) => r.id)],
      );
      summary.implausibleTombstoned = res.rowCount ?? 0;
      console.log(
        `${TAG} tombstoned ${res.rowCount ?? 0} implausible row(s) (operator opt-in)`,
      );

      for (const row of implausible) {
        const tz = await userTimezone(row.user_id);
        const dayKey = dayKeyForScheduledFor(row.scheduled_for, tz);
        daysToRecompute.add(`${row.user_id}|${row.medication_id}|${dayKey}`);
      }
    }

    // ─────────────────────────────────────────────────────────────────
    // 3. Recompute the affected compliance rollups so scheduled/taken
    //    counts self-correct. Same DISTINCT-slot SQL the shared helper
    //    runs (see `recomputeComplianceDay` above).
    // ─────────────────────────────────────────────────────────────────
    if (opts.fix && daysToRecompute.size > 0) {
      console.log(
        `\n${TAG} 3) recomputing ${daysToRecompute.size} compliance rollup day(s)`,
      );
      for (const key of daysToRecompute) {
        const [userId, medicationId, dayKey] = key.split("|");
        try {
          await recomputeComplianceDay(
            client,
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
  } finally {
    await client.end();
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

main().catch((err) => {
  console.error(`${TAG} fatal error:`, err);
  process.exit(1);
});
