/**
 * The data-arrival event spine — wire types.
 *
 * Every ingest path in the product can emit a `DataArrival` when NEW data
 * lands. One worker consumes them and drives the reaction surfaces. The spine
 * sits directly in front of every write seam, so its types are deliberately
 * closed and small: a free-form kind would let a future ingest path enqueue an
 * unbounded event class that no reader understands, and a fat payload would
 * tempt a seam into reading rows it does not already hold.
 *
 * Mirrors the discipline of `@/lib/daily/priority-item`: wire-serialisable
 * primitives only (the payload crosses a pg-boss JSON column), no Date objects,
 * no Prisma types.
 */

/**
 * The closed set of arrival kinds. GROWS BY PR ONLY — adding a member is a
 * deliberate act that must also name the surface consuming it and, if it can
 * cause a provider call, its per-user daily bound.
 */
export const ARRIVAL_KINDS = [
  /** Last night's sleep completed, from any of the seven transports. */
  "sleep_night",
  /** A finished workout row was inserted (not re-synced). */
  "workout",
  /** The first weight reading of the local day. */
  "weight",
  /** A fresh blood-pressure reading. */
  "blood_pressure",
  /** A new lab panel landed (manual, OCR confirm, or auto-stage review). */
  "labs_panel",
] as const;

export type ArrivalKind = (typeof ARRIVAL_KINDS)[number];

/**
 * Salience tier of an emitted event. Only `"salient"` is ever enqueued today;
 * the union is kept open for a future `"digest_only"` tier that would ride the
 * nightly pass instead of the queue. `"backfill"` and `"noop"` classifications
 * never become events at all — they are annotated at the seam and dropped.
 */
export type ArrivalSalience = "salient";

/**
 * The queued payload. Everything here is known at the write seam without an
 * extra read: the seam already holds the rows it just wrote.
 */
export interface DataArrival {
  userId: string;
  kind: ArrivalKind;
  /** Deterministic, computed at the emit seam. Non-salient is never enqueued. */
  salience: ArrivalSalience;
  /** User-profile-tz day key of the NEWEST sample (YYYY-MM-DD). */
  localDate: string;
  /** ISO timestamp of the newest sample in the batch. */
  occurredAt: string;
  /** Kind-scoped referent: the workout id for `workout`, the panel date for labs. */
  refId?: string;
  /** Rows actually INSERTED (not upsert-updated) by the write that emitted. */
  count: number;
  /** Transport token ("withings", "apple", "manual", …) for annotations only. */
  source: string;
}

/** Type guard for a kind read back off the wire. */
export function isArrivalKind(value: unknown): value is ArrivalKind {
  return (
    typeof value === "string" &&
    (ARRIVAL_KINDS as readonly string[]).includes(value)
  );
}
