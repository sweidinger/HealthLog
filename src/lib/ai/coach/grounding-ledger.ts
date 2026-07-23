/**
 * v1.32.9 (Coach Guard II / G2) — the typed Grounding Ledger.
 *
 * Guard I graded a prose number against a per-TURN bag of magnitudes built
 * from this turn's tool payloads only. That misses every number the model was
 * legitimately shown from another provenance: a figure it fetched a turn ago, a
 * goal it holds in coach memory, the dose on the user's medication schedule, a
 * reference band from the grounding block, a number in a guided block. Guard I
 * stripped all of those as "unverified" because the bag never learned them.
 *
 * The ledger is the fix. It is a per-CONVERSATION, TYPED registry of every
 * numeric fact the model was actually shown, assembled where the prompt is
 * assembled — the briefing's "walk the payload, never hand-list" invariant,
 * enforced here by a structural completeness test (D9) rather than by review.
 *
 * The registration sources (the D9 list — every one of these must contribute,
 * and the test fails if a known source is dropped):
 *
 *   - `tool:this-turn`        — the present tool-result payloads this turn.
 *   - `transcript:tool-trace` — the persisted tool figures of PRIOR turns
 *                               (server-computed magnitudes the model fetched
 *                               earlier — NOT prose). This is how a figure
 *                               recalled a turn later reconciles.
 *   - `transcript:user`       — numbers in PRIOR user messages (echoing the
 *                               user is not a hallucination).
 *   - `memory`                — coach-memory goals / facts / plans / reminders.
 *   - `schedule`              — the user's active medication doses.
 *   - `reference-grounding`   — the population reference-band block.
 *   - `guided`                — a guided block rendered into the user prompt.
 *   - `snapshot`              — the full snapshot sections (no-tools path).
 *   - `inventory`             — the DATA INVENTORY sample counts.
 *   - `workout-evidence`      — the pinned selected-workout block.
 *
 * D3 (the anti-laundering rule): ASSISTANT PROSE is NEVER a registration
 * source. A figure that slips a rung is persisted only in the assistant prose,
 * which the ledger never reads — so it cannot self-launder into an authoritative
 * value on the next turn. Only persisted tool-trace figures and user-authored
 * numbers cross the turn boundary.
 *
 * Rebuilt per turn from already-persisted material — no schema migration.
 */
import {
  registerPayloadEntries,
  registerScalarEntries,
  registerTextEntries,
  type LedgerEntry,
  type LedgerSource,
} from "./coach-prose-grounding";

/**
 * The full set of registration sources. The structural completeness test (D9)
 * asserts `buildGroundingLedger` can emit every one of these — so wiring a new
 * prompt block without registering it fails the test rather than silently
 * shipping ungraded figures.
 */
export const LEDGER_SOURCES: readonly LedgerSource[] = [
  "tool:this-turn",
  "transcript:tool-trace",
  "transcript:user",
  "memory",
  "schedule",
  "reference-grounding",
  "guided",
  "snapshot",
  "inventory",
  "workout-evidence",
];

export interface GroundingLedgerInput {
  /** The `data` payloads of THIS turn's present tool results. */
  toolPayloads?: ReadonlyArray<unknown>;
  /** The DATA INVENTORY entries (sample counts) shown this turn. */
  inventoryEntries?: unknown;
  /** The pinned selected-workout evidence block, when one rode the prompt. */
  workoutEvidence?: unknown;
  /**
   * The full snapshot sections — the no-tools path's authoritative set, only
   * when the full snapshot was actually delivered this turn.
   */
  snapshotSections?: unknown;
  /**
   * Bare magnitudes the model fetched on PRIOR turns (persisted tool-trace
   * figures — never prose). Registered exact / ±2%.
   */
  priorToolFigures?: ReadonlyArray<number>;
  /** Prior USER message bodies (numbers the user themselves stated). */
  priorUserMessages?: ReadonlyArray<string>;
  /** Coach-memory free-text lines (goals, facts, plans, reminders). */
  memoryTexts?: ReadonlyArray<string>;
  /** The user's active medication doses (numeric magnitudes). */
  scheduleDoses?: ReadonlyArray<number>;
  /** The reference-grounding block text (population bands). */
  referenceGrounding?: string | null;
  /** A guided block rendered into the user prompt. */
  guidedBlock?: string | null;
}

/**
 * Build the typed ledger for a turn from every source the model was shown.
 * Order does not matter — reconciliation scans the whole ledger — so the
 * builder simply concatenates each source's registered entries.
 */
export function buildGroundingLedger(
  input: GroundingLedgerInput,
): LedgerEntry[] {
  const ledger: LedgerEntry[] = [];

  for (const payload of input.toolPayloads ?? []) {
    ledger.push(...registerPayloadEntries(payload, "tool:this-turn"));
  }
  if (input.inventoryEntries !== undefined && input.inventoryEntries !== null) {
    ledger.push(...registerPayloadEntries(input.inventoryEntries, "inventory"));
  }
  if (input.workoutEvidence !== undefined && input.workoutEvidence !== null) {
    ledger.push(
      ...registerPayloadEntries(input.workoutEvidence, "workout-evidence"),
    );
  }
  if (input.snapshotSections !== undefined && input.snapshotSections !== null) {
    ledger.push(...registerPayloadEntries(input.snapshotSections, "snapshot"));
  }
  if (input.priorToolFigures && input.priorToolFigures.length > 0) {
    ledger.push(
      ...registerScalarEntries(input.priorToolFigures, "transcript:tool-trace"),
    );
  }
  for (const msg of input.priorUserMessages ?? []) {
    ledger.push(...registerTextEntries(msg, "transcript:user"));
  }
  for (const line of input.memoryTexts ?? []) {
    ledger.push(...registerTextEntries(line, "memory"));
  }
  if (input.scheduleDoses && input.scheduleDoses.length > 0) {
    ledger.push(
      ...registerScalarEntries(input.scheduleDoses, "schedule", "dose"),
    );
  }
  ledger.push(
    ...registerTextEntries(input.referenceGrounding, "reference-grounding"),
  );
  ledger.push(...registerTextEntries(input.guidedBlock, "guided"));

  return ledger;
}

/** The sources whose figures this turn persists so a LATER turn can recall them. */
const PERSISTABLE_SOURCES: ReadonlySet<LedgerSource> = new Set<LedgerSource>([
  "tool:this-turn",
  "inventory",
  "workout-evidence",
  "snapshot",
]);

/** Defensive cap so a dense timeline payload cannot bloat the persisted row. */
const MAX_PERSISTED_FIGURES = 64;

/**
 * The bare magnitudes THIS turn's tool trace produced, for persistence onto the
 * assistant message's provenance. A later turn registers them as
 * `transcript:tool-trace` so a figure the model fetched earlier reconciles when
 * it is recalled — without ever reading the assistant's PROSE (D3). No labels,
 * no keys: less identifying than the `keyValues` block already persisted, and
 * never the model's own narration.
 */
export function figuresForPersistence(
  ledger: ReadonlyArray<LedgerEntry>,
): number[] {
  const seen = new Set<number>();
  for (const entry of ledger) {
    if (!PERSISTABLE_SOURCES.has(entry.source)) continue;
    if (!Number.isFinite(entry.value)) continue;
    seen.add(entry.value);
    if (seen.size >= MAX_PERSISTED_FIGURES) break;
  }
  return [...seen];
}
