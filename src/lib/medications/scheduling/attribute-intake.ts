/**
 * v1.15.18 — band-model intake→slot attribution for the WRITE + EDIT paths.
 *
 * The write-side counterpart to `tallyComplianceFromLedger` (the read-side
 * ledger): both consume the SAME shared band minter so a take is bound to a
 * slot identically wherever it is decided. This retires the wide ±6h
 * nearest-snap in `resolve-slot-instant.ts` (`snapToleranceMs`) that pulled a
 * 13:02 take onto the 19:00 slot and a 15:46 take onto the 07:00 slot.
 *
 * Given a medication's schedules, the user's timezone, a `takenAt`, and the
 * pre-fetched rolling-anchor instants, `attributeTakenToSlot` mints the day's
 * `SlotBand[]` (per schedule, never pooled into one minter call — audit
 * MEDIUM-9) and runs `attributeIntakeToSlot`:
 *
 *   - the take lands in a slot's band  → that slot's canonical anchor instant
 *     (`band.at`), which the caller writes as `scheduledFor` (snap to slot);
 *   - the take lands in no band        → `null`: an ad-hoc / PRN take the
 *     caller inserts standalone with `scheduledFor = takenAt`.
 *
 * PRN / empty / malformed schedules mint no bands (`hasExpectedSlots:false`)
 * and therefore always return `null` — every PRN intake is a standalone row.
 *
 * Pure / synchronous: no DB access. The caller `select`s the schedule columns
 * + threads `lastIntakeAt` / `intakeInstants` in (mirrors
 * `resolve-slot-instant.ts`).
 */
import {
  attributeIntakeToSlot,
  type SlotBand,
} from "@/lib/medications/scheduling/attribution";
import {
  buildBandsForSchedules,
  type BandMinterMedication,
  type DoseWindowConfig,
} from "@/lib/medications/scheduling/band-minter";
import {
  buildCanonicalSchedule,
  buildRecurrenceContext,
  type WorkerMedicationRow,
  type WorkerScheduleRow,
} from "@/lib/medications/scheduling/worker-helpers";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/** The medication projection the attributor reads (matches the write `select`). */
export interface AttributeIntakeMedication extends WorkerMedicationRow {
  schedules: WorkerScheduleRow[];
}

export interface AttributeTakenInput {
  medication: AttributeIntakeMedication;
  userTz: string;
  /** The real intake instant whose slot we resolve. */
  takenAt: Date;
  /**
   * Latest non-tombstoned `takenAt` for the medication — anchors the rolling
   * retrospective grid's next-due. Pass `null` when unknown / not rolling.
   */
  lastIntakeAt?: Date | null;
  /**
   * Non-skipped intake instants for the medication, ascending. REQUIRED for a
   * rolling cadence (the retrospective grid anchors AT each intake); ignored
   * otherwise.
   */
  intakeInstants?: Date[];
  /** Per-dose window override; defaults to `DOSE_WINDOW_DEFAULTS`. */
  windowConfig?: DoseWindowConfig;
  /** Wall-clock reference; defaults to `takenAt`. Injectable for tests. */
  now?: Date;
}

export interface AttributeTakenResult {
  /**
   * The canonical slot anchor the take attributes to, or `null` for an ad-hoc
   * / PRN take (the caller inserts it standalone with `scheduledFor=takenAt`).
   */
  slotInstant: Date | null;
  /** on_time / late when matched, null when ad-hoc. */
  status: "on_time" | "late" | null;
  /** False for PRN / empty / malformed medications (no slot machinery). */
  hasExpectedSlots: boolean;
}

/**
 * Build the day's bands for every schedule of a medication, pooled into one
 * `SlotBand[]`. Bands are minted PER SCHEDULE (no tail clipping across
 * schedules), then pooled — each slot is claimed by ≤1 intake downstream, so
 * the union is safe (mirrors `tallyComplianceFromLedger`).
 */
export function buildMedicationDayBands(input: {
  medication: AttributeIntakeMedication;
  userTz: string;
  /** The instant whose local day's slots are minted (the take's own time). */
  around: Date;
  lastIntakeAt?: Date | null;
  intakeInstants?: Date[];
  windowConfig?: DoseWindowConfig;
  now?: Date;
}): { bands: SlotBand[]; hasExpectedSlots: boolean } {
  const schedules = input.medication.schedules ?? [];
  if (schedules.length === 0) {
    return { bands: [], hasExpectedSlots: false };
  }

  const bandMinterMedication: BandMinterMedication = {
    id: input.medication.id,
    startsOn: input.medication.startsOn,
    endsOn: input.medication.endsOn,
    oneShot: input.medication.oneShot,
    createdAt: input.medication.createdAt,
  };
  const ctx = buildRecurrenceContext({
    medication: input.medication,
    userTz: input.userTz,
    lastIntakeAt: input.lastIntakeAt ?? null,
  });
  const canonicalSchedules = schedules.map(buildCanonicalSchedule);

  // Mint over the take's local day padded a day each side so a slot near the
  // local-midnight boundary (and any DST shift) is still captured — mirrors
  // `resolve-slot-instant.ts`. A weekly/rolling band reaches further; its
  // minter widens the probe internally, so the padded day window is enough to
  // surface the anchor that the take could pair to.
  const from = new Date(input.around.getTime() - ONE_DAY_MS);
  const to = new Date(input.around.getTime() + ONE_DAY_MS);

  const groups = buildBandsForSchedules({
    medication: bandMinterMedication,
    schedules: canonicalSchedules,
    ctx,
    userTz: input.userTz,
    range: { from, to },
    now: input.now ?? input.around,
    windowConfig: input.windowConfig,
    intakeInstants: input.intakeInstants,
  });

  const bands: SlotBand[] = [];
  let hasExpectedSlots = false;
  for (const g of groups) {
    if (g.hasExpectedSlots) {
      hasExpectedSlots = true;
      bands.push(...g.bands);
    }
  }
  return { bands, hasExpectedSlots };
}

/**
 * Attribute a TAKEN intake to its scheduled slot via band membership, or
 * `null` when it falls in no band (ad-hoc / PRN).
 */
export function attributeTakenToSlot(
  input: AttributeTakenInput,
): AttributeTakenResult {
  const { bands, hasExpectedSlots } = buildMedicationDayBands({
    medication: input.medication,
    userTz: input.userTz,
    around: input.takenAt,
    lastIntakeAt: input.lastIntakeAt,
    intakeInstants: input.intakeInstants,
    windowConfig: input.windowConfig,
    now: input.now ?? input.takenAt,
  });

  if (!hasExpectedSlots) {
    return { slotInstant: null, status: null, hasExpectedSlots: false };
  }

  const matched = attributeIntakeToSlot(input.takenAt, bands);
  if (!matched) {
    return { slotInstant: null, status: null, hasExpectedSlots: true };
  }
  return {
    slotInstant: matched.band.at,
    status: matched.status,
    hasExpectedSlots: true,
  };
}

/**
 * Validate that `slotInstant` is a real scheduled slot of `medication` on its
 * own local day — the server-side guard behind the "diesem Slot zuordnen?"
 * late-take nudge. A client may pin an off-window take onto a chosen slot, but
 * only onto a slot the schedule actually mints (never an arbitrary instant).
 * Returns the canonical band anchor (which the caller writes as
 * `scheduledFor`) when the instant matches a band anchor within a minute, else
 * `null`.
 */
export function resolveForcedSlotInstant(input: {
  medication: AttributeIntakeMedication;
  userTz: string;
  /** The slot instant the client asks to pin the take onto. */
  slotInstant: Date;
  lastIntakeAt?: Date | null;
  intakeInstants?: Date[];
  windowConfig?: DoseWindowConfig;
  now?: Date;
}): Date | null {
  const { bands, hasExpectedSlots } = buildMedicationDayBands({
    medication: input.medication,
    userTz: input.userTz,
    around: input.slotInstant,
    lastIntakeAt: input.lastIntakeAt,
    intakeInstants: input.intakeInstants,
    windowConfig: input.windowConfig,
    now: input.now ?? input.slotInstant,
  });
  if (!hasExpectedSlots) return null;

  const target = input.slotInstant.getTime();
  let best: { at: Date; dist: number } | null = null;
  for (const band of bands) {
    const dist = Math.abs(band.at.getTime() - target);
    if (dist <= ANCHOR_MATCH_EPSILON_MS && (best === null || dist < best.dist)) {
      best = { at: band.at, dist };
    }
  }
  return best?.at ?? null;
}

/**
 * Sub-minute slop for matching a client-supplied force-attribute instant to a
 * real band anchor. The client echoes a slot anchor it read from the
 * dose-history / today endpoints; sub-minute iOS-vs-server drift must still
 * resolve, but an arbitrary off-slot instant must not.
 */
const ANCHOR_MATCH_EPSILON_MS = 60_000;
