/**
 * Keyset-paged measurement reader shared by the two backup writers.
 *
 * Both writers — the weekly on-host `DataBackup` snapshot
 * (`reminder/backup-handlers.ts`) and the nightly off-host DR dump
 * (`offhost-backup.ts`) — used to load a user's ENTIRE measurement set
 * as full ORM rows into one array and then run a single
 * `JSON.stringify` over the whole payload. On a heavy multi-year tenant
 * that holds every measurement row plus the giant serialized string in
 * memory at the same instant, which is the dominant heap spike of either
 * job and scales linearly with history depth.
 *
 * This reader walks the set in id-ascending keyset pages: at most one
 * page of rows is resident at a time, and each page is projected to its
 * compact backup shape before the next page is fetched. Transient peak
 * heap is bounded by the page size, not by the size of the user's
 * history. The accumulated output is the compact projection the payload
 * needs anyway — not the wide ORM rows.
 *
 * Keyset (cursor on `id`) rather than `skip`/`take` offset paging so the
 * scan stays O(rows) instead of O(rows^2) as the offset grows, and so a
 * concurrent insert can't shift rows across a page boundary.
 */
import { readNote } from "@/lib/crypto/note-cipher";

/**
 * Page size for the backup keyset scan. Large enough that the per-page
 * round-trip overhead stays negligible, small enough that a single page
 * of rows is a bounded slice of any tenant's history.
 */
export const MEASUREMENT_BACKUP_PAGE_SIZE = 2000;

/**
 * Walk a keyset-paged result set, projecting each row to its compact
 * backup shape as it arrives. `fetchPage` returns the next page of rows
 * after `afterId` (exclusive, id-ascending), bounded to `take` rows;
 * returning fewer than `take` rows signals the final page. The generic
 * stays free of any Prisma dependency so the paging contract is unit
 * testable without a database.
 */
export async function collectPagedMeasurements<
  Row extends { id: string },
  Out,
>(args: {
  fetchPage: (afterId: string | null, take: number) => Promise<Row[]>;
  project: (row: Row) => Out;
  pageSize?: number;
}): Promise<Out[]> {
  const { fetchPage, project } = args;
  const pageSize = args.pageSize ?? MEASUREMENT_BACKUP_PAGE_SIZE;
  const out: Out[] = [];
  let afterId: string | null = null;
  for (;;) {
    const page = await fetchPage(afterId, pageSize);
    if (page.length === 0) break;
    for (const row of page) out.push(project(row));
    if (page.length < pageSize) break;
    afterId = page[page.length - 1].id;
  }
  return out;
}

/**
 * Narrow row shape the weekly snapshot reads — exactly the columns the
 * admin restore path recreates a measurement from
 * (`api/admin/backups/[id]/restore`): `type`, `value`, `unit`, `source`,
 * `measuredAt`, plus the note pair so the decrypted note rides into the
 * (whole-blob-encrypted) payload. `id` rides along only as the keyset
 * cursor.
 */
export interface WeeklyMeasurementRow {
  id: string;
  type: string;
  value: number;
  unit: string;
  source: string;
  measuredAt: Date;
  notes: string | null;
  notesEncrypted: Uint8Array | null;
}

/** Compact measurement shape the weekly `DataBackup` JSON carries. */
export interface WeeklyBackupMeasurement {
  type: string;
  value: number;
  unit: string;
  measuredAt: string;
  source: string;
  notes: string | null;
}

/**
 * Project a narrow measurement row into the weekly backup shape. The
 * note is decrypted here so the restore re-encrypts on re-insert — the
 * same contract the previous inline writer used. Shared with the writer
 * so the round-trip test exercises the real projection.
 */
export function toWeeklyBackupMeasurement(
  row: WeeklyMeasurementRow,
): WeeklyBackupMeasurement {
  return {
    type: row.type,
    value: row.value,
    unit: row.unit,
    measuredAt: row.measuredAt.toISOString(),
    source: row.source,
    notes: readNote(row.notesEncrypted, row.notes),
  };
}

/**
 * Order the collected weekly measurements newest-first to match the
 * pre-paging `orderBy: { measuredAt: "desc" }` output. The keyset scan
 * reads id-ascending for a stable cursor; this restores the historical
 * array order. Operates on the compact projections, so it does not
 * reintroduce the wide-row heap spike. ISO-8601 strings sort
 * lexicographically in chronological order, so a string compare is the
 * chronological compare.
 */
export function sortWeeklyMeasurementsDesc(
  measurements: WeeklyBackupMeasurement[],
): WeeklyBackupMeasurement[] {
  return measurements.sort((a, b) =>
    a.measuredAt < b.measuredAt ? 1 : a.measuredAt > b.measuredAt ? -1 : 0,
  );
}
