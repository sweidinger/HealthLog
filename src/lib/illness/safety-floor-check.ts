/**
 * Safety-floor write-hook orchestrator (v1.18.6).
 *
 * Runs AFTER a measurement write lands. Resolves the recent same-kind readings
 * the confirm gate needs, runs the absolute-floor engine (`safety-floors.ts`),
 * and dispatches an urgent escalation (`safety-floor-notify.ts`) when — and
 * only when — a fresh reading breaches a clinical floor AND a prior reading
 * inside the confirm window held the same floor.
 *
 * Module-gated: glucose checks only run when the `glucose` module is enabled;
 * BP is a CORE domain (always on) but the BP check is still cheap and only
 * fires on an extreme reading. Owner-scoped, fire-and-forget, never throws —
 * a notification failure must never fail the user's measurement write.
 *
 * The caller (the measurement POST route) passes the just-written rows plus
 * the transient `symptomsPresent` flag; this helper does the bounded reads.
 */
import { prisma } from "@/lib/db";
import { getEvent } from "@/lib/logging/context";
import { isModuleEnabled } from "@/lib/modules/gate";
import {
  evaluateBloodPressure,
  evaluateGlucose,
  CONFIRM_WINDOW_MS,
  type BpSample,
  type GlucoseSample,
} from "@/lib/illness/safety-floors";
import { notifySafetyFloor } from "@/lib/illness/safety-floor-notify";

/** A row the write hook just persisted (the subset the check needs). */
export interface WrittenReading {
  type: string;
  value: number;
  measuredAt: Date;
  glucoseContext?: string | null;
}

/**
 * Evaluate the just-written readings against the absolute safety floors and
 * dispatch any confirmed escalation. Best-effort.
 *
 * `symptomsPresent` is the transient per-write flag — true lifts a confirmed
 * breach to the symptom-coupled emergency copy. Defaults to false.
 */
export async function runSafetyFloorCheck(input: {
  userId: string;
  written: WrittenReading[];
  symptomsPresent?: boolean;
}): Promise<void> {
  const { userId, written } = input;
  const symptomCoupled = input.symptomsPresent === true;

  try {
    await Promise.all([
      checkBloodPressure(userId, written, symptomCoupled),
      checkGlucose(userId, written, symptomCoupled),
    ]);
  } catch (err) {
    getEvent()?.addWarning(
      `safety-floor check failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/* ── blood pressure ───────────────────────────────────────────────────── */

async function checkBloodPressure(
  userId: string,
  written: WrittenReading[],
  symptomCoupled: boolean,
): Promise<void> {
  // BP is stored as two rows (SYS + DIA). We only evaluate when BOTH arms of
  // the candidate reading are present in this write (the normal combined-form
  // and iOS batch path) so we never reason about half a reading.
  const sys = written.find((r) => r.type === "BLOOD_PRESSURE_SYS");
  const dia = written.find((r) => r.type === "BLOOD_PRESSURE_DIA");
  if (!sys || !dia) return;

  const candidate: BpSample = {
    measuredAt: sys.measuredAt,
    systolic: sys.value,
    diastolic: dia.value,
  };

  // Pull the recent SYS + DIA rows inside the confirm window and pair them by
  // timestamp so the engine sees prior whole readings, not loose arms. The
  // candidate's own rows are excluded by the strict `lt: measuredAt` bound.
  const windowStart = new Date(
    candidate.measuredAt.getTime() - CONFIRM_WINDOW_MS,
  );
  const rows = await prisma.measurement.findMany({
    where: {
      userId,
      type: { in: ["BLOOD_PRESSURE_SYS", "BLOOD_PRESSURE_DIA"] },
      deletedAt: null,
      measuredAt: { gte: windowStart, lt: candidate.measuredAt },
    },
    orderBy: { measuredAt: "desc" },
    take: 50,
    select: { type: true, value: true, measuredAt: true },
  });

  const recent = pairBp(rows);
  const decision = evaluateBloodPressure({ candidate, recent, symptomCoupled });
  await notifySafetyFloor({ userId, decision });
}

/**
 * Pair loose SYS/DIA rows into whole BP samples by exact timestamp. A combined
 * BP form writes both arms at the same instant, so an exact-instant join is
 * the right grain here (the confirm gate only needs prior WHOLE readings).
 */
function pairBp(
  rows: ReadonlyArray<{ type: string; value: number; measuredAt: Date }>,
): BpSample[] {
  const sysByTs = new Map<number, number>();
  const diaByTs = new Map<number, number>();
  for (const r of rows) {
    const ts = r.measuredAt.getTime();
    if (r.type === "BLOOD_PRESSURE_SYS") sysByTs.set(ts, r.value);
    else if (r.type === "BLOOD_PRESSURE_DIA") diaByTs.set(ts, r.value);
  }
  const out: BpSample[] = [];
  for (const [ts, systolic] of sysByTs) {
    const diastolic = diaByTs.get(ts);
    if (diastolic === undefined) continue;
    out.push({ measuredAt: new Date(ts), systolic, diastolic });
  }
  return out;
}

/* ── glucose ──────────────────────────────────────────────────────────── */

async function checkGlucose(
  userId: string,
  written: WrittenReading[],
  symptomCoupled: boolean,
): Promise<void> {
  const glucose = written.find((r) => r.type === "BLOOD_GLUCOSE");
  if (!glucose) return;

  // Module gate: only run when the glucose module is enabled for this account.
  if (!(await isModuleEnabled(userId, "glucose"))) return;

  const candidate: GlucoseSample = {
    measuredAt: glucose.measuredAt,
    mgdl: glucose.value,
  };

  const windowStart = new Date(
    candidate.measuredAt.getTime() - CONFIRM_WINDOW_MS,
  );
  const rows = await prisma.measurement.findMany({
    where: {
      userId,
      type: "BLOOD_GLUCOSE",
      deletedAt: null,
      measuredAt: { gte: windowStart, lt: candidate.measuredAt },
    },
    orderBy: { measuredAt: "desc" },
    take: 50,
    select: { value: true, measuredAt: true },
  });

  const recent: GlucoseSample[] = rows.map((r) => ({
    measuredAt: r.measuredAt,
    mgdl: r.value,
  }));
  const decision = evaluateGlucose({ candidate, recent, symptomCoupled });
  await notifySafetyFloor({ userId, decision });
}
