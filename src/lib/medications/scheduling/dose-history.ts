/**
 * v1.15.18 — traceable dose-history reconstruction (spec B).
 *
 * Builds a complete, attributable ledger for a medication's day(s): every
 * expected slot with a status, plus every off-schedule intake tagged ad-hoc.
 * It is the read-model behind the medication history view + the card's
 * last/next dose, and it converges forward over legacy mis-snapped rows
 * because it attributes a TAKEN intake by its real `takenAt`, not the stored
 * `scheduledFor` the old write path may have snapped to a slot.
 *
 * Attribution rules:
 *   - skipped / auto-missed / pending rows (no `takenAt`) bind to the slot
 *     whose anchor equals their `scheduledFor` (±epsilon): these were written
 *     against a slot deliberately, so they annotate that slot;
 *   - a TAKEN intake is attributed by `attributeIntakeToSlot(takenAt, bands)`;
 *     inside a band → that slot (on-time / late), outside every band → ad-hoc;
 *   - each slot is claimed by at most one intake (first/best wins); extra
 *     intakes near a filled slot fall through to ad-hoc.
 *
 * Pure / synchronous / instant-based — the caller mints the bands DST-correctly
 * via `localHmAsUtc` and supplies the per-dose window.
 */
import {
  attributeIntakeToSlot,
  type SlotBand,
} from "@/lib/medications/scheduling/attribution";

/** The minimal intake shape the ledger reads. */
export interface HistoryIntake {
  id?: string;
  /** Stored slot anchor (may be a legacy mis-snapped instant for takes). */
  scheduledFor: Date;
  /** Real intake time, or null for skipped / pending / auto-missed rows. */
  takenAt: Date | null;
  skipped: boolean;
  /** Cron-marked forgotten dose (counts as missed, not skipped). */
  autoMissed?: boolean;
}

export type DoseHistoryStatus =
  | "taken_on_time"
  | "taken_late"
  | "skipped"
  | "missed"
  | "upcoming"
  | "ad_hoc";

export interface DoseHistoryRow {
  /** A scheduled slot, or a standalone off-schedule intake. */
  kind: "slot" | "ad_hoc";
  /** The slot anchor instant, or the ad-hoc take's own time. */
  at: Date;
  /** The slot's "HH:mm" label, or null for an ad-hoc row. */
  timeOfDay: string | null;
  status: DoseHistoryStatus;
  /** The intake attributed to this row, if any. */
  intake: HistoryIntake | null;
}

/** Sub-minute slop for binding an anchored (skip/pending) row to its slot. */
const ANCHOR_EPSILON_MS = 60_000;

/**
 * Reconstruct the dose-history ledger for the slots described by `bands` and
 * the supplied intakes. Returns rows in chronological order.
 */
export function reconstructDoseHistory(
  bands: SlotBand[],
  intakes: HistoryIntake[],
  now: Date,
): DoseHistoryRow[] {
  // Per-band claim: the intake attributed to it + the resolved status.
  const claim = new Map<
    SlotBand,
    { intake: HistoryIntake; status: DoseHistoryStatus }
  >();
  const adHoc: HistoryIntake[] = [];

  // Partition: anchored rows (skip / auto-missed / pending — no takenAt) bind
  // by scheduledFor; taken rows attribute by real takenAt band membership.
  // Process anchored first so a deliberate skip/miss owns its slot before a
  // stray take could.
  const anchored = intakes.filter((i) => i.takenAt === null);
  const taken = intakes.filter((i) => i.takenAt !== null);

  for (const i of anchored) {
    const band = nearestAnchorBand(i.scheduledFor, bands);
    const status: DoseHistoryStatus = i.skipped ? "skipped" : "missed";
    if (band && !claim.has(band)) {
      claim.set(band, { intake: i, status });
    } else {
      // A skip/miss with no matching slot (legacy off-grid) — surface it so
      // nothing silently vanishes; tag it ad-hoc.
      adHoc.push(i);
    }
  }

  for (const i of taken) {
    const matched = attributeIntakeToSlot(i.takenAt as Date, bands);
    if (matched && !claim.has(matched.band)) {
      claim.set(matched.band, {
        intake: i,
        status: matched.status === "on_time" ? "taken_on_time" : "taken_late",
      });
    } else {
      adHoc.push(i);
    }
  }

  const rows: DoseHistoryRow[] = bands.map((band) => {
    const c = claim.get(band);
    if (c) {
      return {
        kind: "slot",
        at: band.at,
        timeOfDay: band.timeOfDay,
        status: c.status,
        intake: c.intake,
      };
    }
    // Unfilled slot: missed only once the miss cutoff (the late tail's end)
    // has passed; until then the dose is still takeable, so it reads upcoming
    // rather than prematurely missed.
    const status: DoseHistoryStatus =
      now.getTime() > band.overdueEnd.getTime() ? "missed" : "upcoming";
    return {
      kind: "slot",
      at: band.at,
      timeOfDay: band.timeOfDay,
      status,
      intake: null,
    };
  });

  for (const i of adHoc) {
    rows.push({
      kind: "ad_hoc",
      at: i.takenAt ?? i.scheduledFor,
      timeOfDay: null,
      status: "ad_hoc",
      intake: i,
    });
  }

  rows.sort((a, b) => a.at.getTime() - b.at.getTime());
  return rows;
}

/** The band whose anchor is within epsilon of `instant`, nearest wins. */
function nearestAnchorBand(instant: Date, bands: SlotBand[]): SlotBand | null {
  const t = instant.getTime();
  let best: SlotBand | null = null;
  let bestDist = Infinity;
  for (const band of bands) {
    const dist = Math.abs(band.at.getTime() - t);
    if (dist <= ANCHOR_EPSILON_MS && dist < bestDist) {
      bestDist = dist;
      best = band;
    }
  }
  return best;
}
