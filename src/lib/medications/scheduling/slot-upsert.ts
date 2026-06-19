/**
 * v1.8.2 — shared slot resolution for the intake write paths.
 *
 * Both `POST /api/medications/[id]/intake` (source WEB) and
 * `POST /api/medications/intake/bulk` (source API) must resolve an
 * incoming dose write to the canonical scheduled-slot instant so the
 * write updates the pending REMINDER row the projector/worker minted
 * rather than inserting a second row that differs only by `source` (and
 * by a sub-minute `scheduledFor` drift). This module loads the
 * medication's schedules + the rolling-anchor `lastIntakeAt` and runs the
 * pure `resolveCanonicalSlotInstant` snap.
 *
 * Returns `null` when the dose does not map to a scheduled slot
 * (PRN / off-slot beyond tolerance / cyclic off-week / no schedules) —
 * the caller's signal to keep the unmodified insert behaviour.
 */
import type { PrismaClient } from "@/generated/prisma/client";

import { prisma as defaultPrisma } from "@/lib/db";
import { isP2002 } from "@/lib/prisma-errors";
import { resolveCanonicalSlotInstant } from "@/lib/medications/scheduling/resolve-slot-instant";
import {
  attributeTakenToSlot,
  resolveForcedSlotInstant,
  type AttributeIntakeMedication,
} from "@/lib/medications/scheduling/attribute-intake";
import type { WorkerScheduleRow } from "@/lib/medications/scheduling/worker-helpers";
import type { InjectionSiteKey } from "@/lib/medications/injection-sites";

type PrismaLike = Pick<PrismaClient, "medication" | "medicationIntakeEvent">;

/** The minimal intake-row shape the slot upsert reads + returns. */
export interface SlotIntakeRow {
  id: string;
  takenAt: Date | null;
  skipped: boolean;
  idempotencyKey: string | null;
  scheduledFor: Date;
  source: string;
  createdAt: Date;
}

export interface ApplyCanonicalSlotWriteInput {
  client: PrismaLike;
  userId: string;
  medicationId: string;
  /** Canonical slot instant the write snaps to (never null here). */
  canonicalSlot: Date;
  /** Resolved takenAt for the write (null = pending or skipped). */
  takenAt: Date | null;
  skipped: boolean;
  /** Explicit user action vs an idempotent / offline projection echo. */
  isExplicitTaken: boolean;
  isExplicitSkip: boolean;
  idempotencyKey: string | null;
  /**
   * Source to stamp on a freshly-created slot row. `REMINDER` is the
   * Telegram-webhook path — its take / skip confirmations converge onto
   * the worker-minted pending row like every other write, and a fresh
   * create keeps the historical reminder provenance.
   */
  createSource: "WEB" | "API" | "REMINDER";
  /**
   * v1.8.5 — resolved + server-validated injection site to persist on a
   * taken write. `null` = no site (the column stays / is set NULL). Only
   * ever non-null on an explicit taken write for a tracking-enabled
   * INJECTION medication; the route resolves + validates it before the
   * upsert, so this is trusted here.
   */
  injectionSite?: InjectionSiteKey | null;
  /**
   * v1.15.20 — slot-binding provenance to stamp on the row. `USER_PIN` on
   * the forced "diesem Slot zuordnen" paths, `AUTO` when a write
   * (re-)attributes by window band. Omitted → leave the column untouched on
   * an update / default AUTO on a create (pending echoes and skips never
   * carry a binding decision).
   */
  attributionSource?: "AUTO" | "USER_PIN";
  /**
   * v1.16.4 — per-intake dose override to persist on a taken write.
   * `null` / omitted = no override (the column stays untouched on an
   * update, NULL on a create). Never clears a previously-recorded
   * override — like `injectionSite`, a pending echo or skip cannot wash
   * a recorded dose away.
   */
  doseTaken?: string | null;
}

export interface ApplyCanonicalSlotWriteResult {
  row: SlotIntakeRow;
  /** "updated" an existing slot row, or "inserted" a new one. */
  outcome: "updated" | "inserted";
  /**
   * True when this write moved the slot from pending (no `takenAt`) to
   * taken — the ONLY transition that should decrement pen inventory.
   * False for a fresh skip, an idempotent re-post of an already-taken
   * slot, or a no-op pending echo.
   */
  consumedTransition: boolean;
  /**
   * True when the incoming write was a pending projection echo onto an
   * already-actioned slot and was treated as a no-op (C2 no-downgrade).
   */
  noDowngradeNoOp: boolean;
}

const SLOT_ROW_SELECT = {
  id: true,
  takenAt: true,
  skipped: true,
  idempotencyKey: true,
  scheduledFor: true,
  source: true,
  createdAt: true,
} as const;

/**
 * Deterministically pick the slot row a write should converge onto when
 * the canonical instant carries more than one live row (pre-existing
 * same-slot duplicates that differ only by `source`).
 *
 * H1 ordering — prefer the row that should become the dose of record:
 *   1. an already-actioned row (takenAt set OR skipped) over a pending one
 *      — we update the REAL dose, never resurrect a phantom pending row;
 *   2. tie-break createdAt ASC, then id ASC (lexicographic) — fully
 *      deterministic across runs and DB orderings.
 *
 * Prisma `findFirst` cannot express the "actioned-first" preference in a
 * single `orderBy`, so the candidate set is fetched in the deterministic
 * `(createdAt asc, id asc)` order and the actioned-preference is applied
 * in memory. The set is tiny (one slot's rows), so the cost is nil.
 */
function pickSlotRow(rows: SlotIntakeRow[]): SlotIntakeRow | null {
  if (rows.length === 0) return null;
  const actioned = rows.filter((r) => r.takenAt !== null || r.skipped);
  // `rows` already arrives in (createdAt asc, id asc) order, so the first
  // element of either partition is the deterministic winner.
  return (actioned.length > 0 ? actioned : rows)[0];
}

async function findSlotRows(
  client: PrismaLike,
  userId: string,
  medicationId: string,
  canonicalSlot: Date,
): Promise<SlotIntakeRow[]> {
  return (await client.medicationIntakeEvent.findMany({
    where: {
      userId,
      medicationId,
      scheduledFor: canonicalSlot,
      deletedAt: null,
    },
    select: SLOT_ROW_SELECT,
    // H1 — deterministic order; actioned-preference applied in
    // `pickSlotRow`.
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  })) as SlotIntakeRow[];
}

/**
 * Apply an intake write to the canonical scheduled slot, converging onto
 * one row per `(userId, medicationId, scheduledFor)` regardless of
 * `source`. Implements the medically-critical reconcile invariants:
 *
 *   - H1 deterministic row selection (actioned > pending; createdAt/id);
 *   - C2 no-downgrade — a pending projection echo onto an already-actioned
 *     slot is a no-op (never clears a recorded `takenAt`); explicit user
 *     taken / skip writes still apply (last-write-wins);
 *   - C1 race-safe create — a concurrent insert that wins the P2002 race
 *     is re-found and updated rather than 500-ing or duplicating;
 *   - M2 inventory gating — `consumedTransition` is true only on an actual
 *     pending→taken move.
 */
export async function applyCanonicalSlotWrite(
  input: ApplyCanonicalSlotWriteInput,
): Promise<ApplyCanonicalSlotWriteResult> {
  const {
    client,
    userId,
    medicationId,
    canonicalSlot,
    takenAt,
    skipped,
    idempotencyKey,
    createSource,
    injectionSite = null,
    attributionSource,
    doseTaken = null,
  } = input;

  const rows = await findSlotRows(client, userId, medicationId, canonicalSlot);
  const existing = pickSlotRow(rows);

  if (existing) {
    return applyToExisting(client, existing, input);
  }

  // No live slot row — create. C1: a concurrent insert (dashboard
  // projector `createMany`, double-tap, the reminder worker) can land a
  // row at the same canonical `(userId, medicationId, scheduledFor,
  // source)` between the find and this create, throwing P2002. Re-find
  // the slot (ignoring source) and update it so the write converges to
  // one row rather than 500-ing or duplicating.
  try {
    const created = (await client.medicationIntakeEvent.create({
      data: {
        userId,
        medicationId,
        scheduledFor: canonicalSlot,
        takenAt,
        skipped,
        source: createSource,
        idempotencyKey,
        // v1.8.5 — site only when the route resolved one (taken
        // injection, tracking on, validated allowed).
        ...(injectionSite !== null && { injectionSite }),
        // v1.15.20 — binding provenance; absent → schema default AUTO.
        ...(attributionSource !== undefined && { attributionSource }),
        // v1.16.4 — dose override only when the write carries one.
        ...(doseTaken !== null && { doseTaken }),
      },
      select: SLOT_ROW_SELECT,
    })) as SlotIntakeRow;
    return {
      row: created,
      outcome: "inserted",
      // A fresh row that records a takenAt is a pending→taken transition
      // (there was no prior row), so inventory should decrement.
      consumedTransition: takenAt !== null,
      noDowngradeNoOp: false,
    };
  } catch (err) {
    if (!isP2002(err)) throw err;
    const raced = await findSlotRows(
      client,
      userId,
      medicationId,
      canonicalSlot,
    );
    const winner = pickSlotRow(raced);
    if (!winner) throw err; // genuinely gone — surface the original error.
    return applyToExisting(client, winner, {
      ...input,
      // The slot now has a row; the create's intended idempotencyKey
      // still applies to the converged row.
    });
  }
}

/**
 * Update an existing slot row, enforcing the C2 no-downgrade guard and
 * computing the M2 inventory-transition flag.
 */
async function applyToExisting(
  client: PrismaLike,
  existing: SlotIntakeRow,
  input: ApplyCanonicalSlotWriteInput,
): Promise<ApplyCanonicalSlotWriteResult> {
  const {
    takenAt,
    skipped,
    isExplicitTaken,
    isExplicitSkip,
    idempotencyKey,
    injectionSite = null,
    attributionSource,
    doseTaken = null,
  } = input;

  const existingActioned = existing.takenAt !== null || existing.skipped;
  const incomingIsPendingEcho = !isExplicitTaken && !isExplicitSkip;

  // C2 — never clear a recorded dose with a pending projection echo. An
  // iOS offline re-sync replays a PENDING projection (no takenAt,
  // skipped=false) for a slot the user already actioned; applying it
  // would overwrite `takenAt` to null and convert a recorded dose into a
  // missed one. A taken dose is an immutable fact. Treat the echo as a
  // no-op and return the existing row unchanged so the sync cursor
  // advances. Explicit taken / skip writes still apply (last-write-wins,
  // matching the status-toggle route).
  if (incomingIsPendingEcho && existingActioned) {
    return {
      row: existing,
      outcome: "updated",
      consumedTransition: false,
      noDowngradeNoOp: true,
    };
  }

  // M2 — only a genuine pending→taken move consumes inventory. Re-posting
  // an already-taken slot must not decrement again.
  const consumedTransition = existing.takenAt === null && takenAt !== null;

  const row = (await client.medicationIntakeEvent.update({
    where: { id: existing.id },
    data: {
      takenAt,
      skipped,
      // A recorded dose is no longer an auto-miss. The hourly auto-miss cron
      // stamps `autoMissed: true` on a never-acted slot; when the user later
      // records the take (late entry, offline sync catching up), the flag
      // must reset or the compliance engine keeps counting the now-taken
      // dose as a miss.
      ...(takenAt !== null && { autoMissed: false }),
      syncVersion: { increment: 1 },
      idempotencyKey: idempotencyKey ?? existing.idempotencyKey ?? null,
      // v1.8.5 — write the site only when this write carries a resolved
      // one (taken injection, tracking on, validated). Never clear a
      // previously-recorded site with a null on an idempotent re-post.
      ...(injectionSite !== null && { injectionSite }),
      // v1.15.20 — binding provenance: set only when this write carries a
      // decision (pin / band re-attribution). A pending echo or skip never
      // overwrites a recorded USER_PIN.
      ...(attributionSource !== undefined && { attributionSource }),
      // v1.16.4 — dose override only when this write carries one; never
      // clear a previously-recorded override with a null re-post.
      ...(doseTaken !== null && { doseTaken }),
    },
    select: SLOT_ROW_SELECT,
  })) as SlotIntakeRow;

  return {
    row,
    outcome: "updated",
    consumedTransition,
    noDowngradeNoOp: false,
  };
}

const SCHEDULE_SELECT = {
  id: true,
  windowStart: true,
  windowEnd: true,
  daysOfWeek: true,
  timesOfDay: true,
  reminderGraceMinutes: true,
  rrule: true,
  rollingIntervalDays: true,
  scheduleType: true,
  cyclicOnWeeks: true,
  cyclicOffWeeks: true,
  // v1.15.18 — the persisted per-dose window the band attribution honours so
  // the write/edit slot binding uses the SAME on-time window as the % + history.
  doseWindows: true,
} as const;

const MEDICATION_SELECT = {
  id: true,
  startsOn: true,
  endsOn: true,
  oneShot: true,
  createdAt: true,
  schedules: { select: SCHEDULE_SELECT },
  // v1.16.3 — archived schedule eras: a write/edit at a historical instant
  // attributes against the era that was live at that takenAt.
  scheduleRevisions: {
    orderBy: { validFrom: "asc" },
    select: {
      id: true,
      validFrom: true,
      validUntil: true,
      payload: true,
      supersededByRevisionId: true,
    },
  },
} as const;

export interface ResolveSlotForWriteInput {
  userId: string;
  medicationId: string;
  userTz: string;
  /**
   * The write's `scheduledFor`, or `takenAt` as the fallback when the
   * client omitted `scheduledFor`.
   */
  incoming: Date;
  /**
   * Whether the client sent an explicit `scheduledFor`. `false` means
   * `incoming` is a defaulted `now` / `takenAt` — the resolver then only
   * snaps inside the tight dose-grace window and otherwise returns `null`
   * (PRN), so a slot-less midday "taken now" cannot back-fill a far slot.
   * Defaults to `true` to keep the legacy snap for callers that omit it.
   */
  instantIsExplicit?: boolean;
  /**
   * Whether this write records a TAKEN dose. When `true`, the snap never
   * targets a future slot (dose-safety: a taken dose can't be attributed to
   * a slot the user hasn't reached). Defaults to `false`.
   */
  isTakenWrite?: boolean;
  /** Reference "now" for the taken future-slot guard; defaults to current time. */
  now?: Date;
  /** Inject a Prisma client/tx in tests; defaults to the app client. */
  client?: PrismaLike;
}

/**
 * Resolve the canonical scheduled-slot instant for an intake write, or
 * `null` when the dose is unscheduled (PRN / off-slot / no schedules).
 *
 * Loads the medication's schedule rows (and, when any schedule is
 * rolling, the latest non-tombstoned `takenAt` to anchor the next-due
 * computation byte-identically to the projector + worker).
 */
export async function resolveSlotInstantForWrite(
  input: ResolveSlotForWriteInput,
): Promise<Date | null> {
  const client = input.client ?? defaultPrisma;

  const medication = await client.medication.findFirst({
    where: { id: input.medicationId, userId: input.userId },
    select: MEDICATION_SELECT,
  });
  if (!medication || medication.schedules.length === 0) return null;

  // Rolling cadence anchors off the last logged intake — fetch it only
  // when a schedule actually needs it (mirrors the projector's gate).
  let lastIntakeAt: Date | null = null;
  if (medication.schedules.some((s) => s.rollingIntervalDays !== null)) {
    const lastIntake = await client.medicationIntakeEvent.findFirst({
      where: {
        userId: input.userId,
        medicationId: input.medicationId,
        deletedAt: null,
        takenAt: { not: null },
      },
      orderBy: { takenAt: "desc" },
      select: { takenAt: true },
    });
    lastIntakeAt = lastIntake?.takenAt ?? null;
  }

  return resolveCanonicalSlotInstant({
    medication: {
      id: medication.id,
      startsOn: medication.startsOn,
      endsOn: medication.endsOn,
      oneShot: medication.oneShot,
      createdAt: medication.createdAt,
      schedules: medication.schedules as WorkerScheduleRow[],
    },
    userTz: input.userTz,
    incoming: input.incoming,
    lastIntakeAt,
    instantIsExplicit: input.instantIsExplicit ?? true,
    isTakenWrite: input.isTakenWrite ?? false,
    now: input.now,
  });
}

/**
 * v1.15.18 — load a medication's schedules + rolling anchors and adapt them to
 * the shared band attributor's projection. Mirrors `resolveSlotInstantForWrite`
 * but returns the full medication so the caller can run band attribution AND
 * the force-attribute guard from one load.
 */
async function loadAttributeMedication(input: {
  userId: string;
  medicationId: string;
  client: PrismaLike;
}): Promise<{
  medication: AttributeIntakeMedication;
  lastIntakeAt: Date | null;
} | null> {
  const medication = await input.client.medication.findFirst({
    where: { id: input.medicationId, userId: input.userId },
    select: MEDICATION_SELECT,
  });
  if (!medication || medication.schedules.length === 0) return null;

  // Rolling cadence anchors off the last logged intake — fetch it only when a
  // schedule actually needs it (mirrors the projector's gate).
  let lastIntakeAt: Date | null = null;
  if (medication.schedules.some((s) => s.rollingIntervalDays !== null)) {
    const lastIntake = await input.client.medicationIntakeEvent.findFirst({
      where: {
        userId: input.userId,
        medicationId: input.medicationId,
        deletedAt: null,
        takenAt: { not: null },
      },
      orderBy: { takenAt: "desc" },
      select: { takenAt: true },
    });
    lastIntakeAt = lastIntake?.takenAt ?? null;
  }

  return {
    medication: {
      id: medication.id,
      startsOn: medication.startsOn,
      endsOn: medication.endsOn,
      oneShot: medication.oneShot,
      createdAt: medication.createdAt,
      schedules: medication.schedules as WorkerScheduleRow[],
      // v1.16.13 — thread the archived eras into the attributor projection.
      // `MEDICATION_SELECT` fetches them, but dropping them here made the
      // write/edit path attribute a historical intake against the LIVE
      // schedule, not the era valid at the dose's `takenAt` — the read side
      // (dose-history, compliance) already era-resolves. Now both match.
      scheduleRevisions: medication.scheduleRevisions,
    },
    lastIntakeAt,
  };
}

export interface ResolveSlotByBandInput {
  userId: string;
  medicationId: string;
  userTz: string;
  /** The real intake instant the slot is resolved from. */
  takenAt: Date;
  /** Reference "now"; defaults to the current time. */
  now?: Date;
  /** Inject a Prisma client/tx in tests; defaults to the app client. */
  client?: PrismaLike;
}

export interface ResolveSlotByBandResult {
  /** Canonical slot anchor the take attributes to, or null (ad-hoc / PRN). */
  slotInstant: Date | null;
  /** on_time / late when matched, null when ad-hoc. */
  status: "on_time" | "late" | null;
  /** False for PRN / empty / malformed medications (no slot machinery). */
  hasExpectedSlots: boolean;
}

/**
 * v1.15.18 — band-model slot resolution for the intake WRITE/EDIT paths,
 * replacing the wide ±6h `snapToleranceMs` nearest-snap. The take is bound to
 * a slot by band membership against the SAME minter the read ledger + the
 * compliance % consume, so the three surfaces can never disagree. `null`
 * means ad-hoc / PRN → the caller inserts a standalone row with
 * `scheduledFor = takenAt`.
 */
export async function resolveSlotForWriteByBand(
  input: ResolveSlotByBandInput,
): Promise<ResolveSlotByBandResult> {
  const client = input.client ?? defaultPrisma;
  const loaded = await loadAttributeMedication({
    userId: input.userId,
    medicationId: input.medicationId,
    client,
  });
  if (!loaded) {
    return { slotInstant: null, status: null, hasExpectedSlots: false };
  }

  return attributeTakenToSlot({
    medication: loaded.medication,
    userTz: input.userTz,
    takenAt: input.takenAt,
    lastIntakeAt: loaded.lastIntakeAt,
    intakeInstants: await rollingIntakeInstantsIfNeeded(
      loaded.medication,
      input.userId,
      input.medicationId,
      input.takenAt,
      client,
    ),
    now: input.now,
  });
}

/**
 * v1.16.0 — pin-conflict probe for the USER_PIN write paths. A pin moves a
 * DIFFERENT take onto a named slot; converging it onto a slot whose live
 * row is already actioned (taken or explicitly skipped) would overwrite
 * that recorded action through the explicit-write last-write-wins rule —
 * a silent loss of a dose record. The read ledger only offers the pin for
 * UNSERVED slots (`nearestSlot.filled` gates the kebab action), so a
 * conflict here means a stale client or a hand-rolled API call: the route
 * refuses it with 422 `medications.intake.force_slot.occupied`.
 *
 * Not a conflict:
 *   - a pending projection row at the slot (that is the normal target the
 *     pin converges onto);
 *   - the row being edited itself (`excludeEventId` on the PUT path);
 *   - an actioned row whose `takenAt` equals the incoming instant — that
 *     is an idempotent re-post of the same pinned dose.
 */
export async function findPinConflict(input: {
  userId: string;
  medicationId: string;
  /** The validated canonical slot anchor the pin targets. */
  canonicalSlot: Date;
  /** The incoming row's takenAt (null for a skip-shaped edit). */
  incomingTakenAt: Date | null;
  /** The event being edited (PUT path) — never conflicts with itself. */
  excludeEventId?: string;
  client?: PrismaLike;
}): Promise<boolean> {
  const client = input.client ?? defaultPrisma;
  const rows = await findSlotRows(
    client,
    input.userId,
    input.medicationId,
    input.canonicalSlot,
  );
  return rows.some((row) => {
    if (input.excludeEventId && row.id === input.excludeEventId) return false;
    const actioned = row.takenAt !== null || row.skipped;
    if (!actioned) return false;
    const sameTake =
      input.incomingTakenAt !== null &&
      row.takenAt !== null &&
      row.takenAt.getTime() === input.incomingTakenAt.getTime();
    return !sameTake;
  });
}

export interface ResolveForcedSlotInput {
  userId: string;
  medicationId: string;
  userTz: string;
  /** The slot instant the client asks to pin an off-window take onto. */
  slotInstant: Date;
  now?: Date;
  client?: PrismaLike;
}

/**
 * v1.15.18 — validate the client's "diesem Slot zuordnen?" pin: the supplied
 * instant must be a REAL scheduled slot of this medication on its day (within
 * a minute of a band anchor). Returns the canonical anchor on a match, or
 * `null` when the instant is not a slot — the route then rejects the pin.
 */
export async function resolveForcedSlotForWrite(
  input: ResolveForcedSlotInput,
): Promise<Date | null> {
  const client = input.client ?? defaultPrisma;
  const loaded = await loadAttributeMedication({
    userId: input.userId,
    medicationId: input.medicationId,
    client,
  });
  if (!loaded) return null;

  return resolveForcedSlotInstant({
    medication: loaded.medication,
    userTz: input.userTz,
    slotInstant: input.slotInstant,
    lastIntakeAt: loaded.lastIntakeAt,
    intakeInstants: await rollingIntakeInstantsIfNeeded(
      loaded.medication,
      input.userId,
      input.medicationId,
      input.slotInstant,
      client,
    ),
    now: input.now,
  });
}

/**
 * Fetch the non-skipped `takenAt` instants (≤ `around`) a rolling cadence
 * anchors its retrospective grid on. Returns `undefined` for non-rolling
 * medications so the band minter skips the (unused) work.
 */
async function rollingIntakeInstantsIfNeeded(
  medication: AttributeIntakeMedication,
  userId: string,
  medicationId: string,
  around: Date,
  client: PrismaLike,
): Promise<Date[] | undefined> {
  if (!medication.schedules.some((s) => s.rollingIntervalDays !== null)) {
    return undefined;
  }
  const rows = await client.medicationIntakeEvent.findMany({
    where: {
      userId,
      medicationId,
      deletedAt: null,
      skipped: false,
      takenAt: { not: null, lte: around },
    },
    orderBy: { takenAt: "asc" },
    select: { takenAt: true },
  });
  return rows.map((r) => r.takenAt).filter((d): d is Date => d !== null);
}
