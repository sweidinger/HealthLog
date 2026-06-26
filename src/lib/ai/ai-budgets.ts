/**
 * Per-surface AI generation budgets — the single source of truth for the
 * `temperature` and `maxTokens` each AI surface sends to the provider.
 *
 * Before this module the values were scattered as `?? 0.3` / `?? 1000`
 * magic numbers across the status provider, the Coach route, the
 * comprehensive generator and the period-narrative generator. Centralising
 * them keeps the cost ceiling auditable in one place and ties every number
 * to the output contract it serves (commented per entry below).
 *
 * `seed` (where present) is a deterministic constant pinned for the
 * reference/reproducible surfaces (per the v1.18.7 AI audit MEDIUM-4):
 * the status cards and the period narrative are reference assessments, so a
 * fixed seed makes a prompt change diff-able against a stable baseline. The
 * daily-briefing paragraph is deliberately NOT seeded (it re-rolls for
 * phrasing variety — see comprehensive-generate.ts).
 */

export interface AiBudget {
  /** Sampling temperature. Low for reference surfaces, slightly higher for chat. */
  temperature: number;
  /**
   * Output-token ceiling. Sized to the surface's documented output contract.
   * Optional for surfaces whose caller pins its own token const (self-context).
   */
  maxTokens?: number;
}

/**
 * Deterministic seed pinned for the reproducible reference surfaces. A stable
 * constant (not a per-request value) so two runs of the same prompt+snapshot
 * on a seed-aware provider produce byte-identical text — the QA-attribution
 * baseline the audit's MEDIUM-4 calls for.
 */
export const REFERENCE_AI_SEED = 1_618_033 as const;

/**
 * Surface budgets. Each entry's comment states the output contract that
 * fixes its `maxTokens`.
 */
export const AI_BUDGETS = {
  /**
   * Comprehensive insight + dailyBriefing — the largest structured payload
   * (summary + recommendations + dailyBriefing 80-200 words + signals +
   * keyFindings + trendAnnotations + storyboardAnnotations). 1500 tokens.
   */
  comprehensive: { temperature: 0.3, maxTokens: 1500 },

  /**
   * Per-metric status assessment cards — output is a single
   * `{ "summary": "..." }` of 2-4 sentences / 30-60 words
   * (base-system.ts `length` section). ~80 tokens of content + JSON
   * envelope; 250 is a comfortable ceiling (was an over-generous 1000).
   */
  status: { temperature: 0.3, maxTokens: 250 },

  /**
   * Batched per-metric status assessment (v1.18.7 HIGH-1) — ONE call that
   * returns a `{ perMetric: { bp, weight, pulse, bmi, mood, compliance,
   * general } }` envelope, each value a single 30-60-word assessment in the
   * same contract as a standalone status card. The seven warm calls a fully
   * instrumented account fired per cycle collapse into this one. Sized for
   * up to seven ~80-token summaries plus the JSON envelope: 1400 tokens.
   * Temperature matches the per-card 0.45 (cadence entropy while the FACTS
   * stay pinned by the snapshot + the forbidden-phrase guards).
   */
  statusBatch: { temperature: 0.45, maxTokens: 1400 },

  /**
   * Period narrative (week/month) — 2-4 short plain-text sentences
   * (period-narrative-generate.ts SYSTEM_PROMPT). 400 tokens.
   */
  narrative: { temperature: 0.3, maxTokens: 400 },

  /**
   * Coach SSE chat — a 60-180 word prose reply plus an optional evidence
   * sentinel block (system-prompt.ts rule 1). 600 tokens. Slightly higher
   * temperature than the reference surfaces for conversational variety.
   */
  coach: { temperature: 0.4, maxTokens: 600 },

  /**
   * Coach rolling-conversation summary worker — a compact summary of the
   * elided older turns. 200 tokens.
   */
  summary: { temperature: 0.3, maxTokens: 200 },

  /**
   * Coach durable-fact extraction worker — a short structured fact list.
   * 300 tokens. Lowest temperature: extraction must be faithful, not
   * creative.
   */
  facts: { temperature: 0.2, maxTokens: 300 },

  /**
   * Coach self-context question generation — a small set of clarifying
   * questions. Temperature only; the caller pins its own token const.
   */
  selfContext: { temperature: 0.4 },

  /**
   * v1.18.9 — Lab-OCR structured extraction. ONE vision call transcribes a
   * photo / PDF of a paper lab report into a JSON array of analyte rows
   * (analyte + value/valueText + unit + reference range + date + per-field
   * confidence). A full panel is a dozen-plus rows of compact JSON; 4000
   * tokens covers a dense report plus the envelope. Temperature 0 — the task
   * is faithful transcription, not generation, so the lowest setting minimises
   * invented values. Vision input tokens are expensive, so the route also
   * gates with a tight 6/hour rate bucket + reserveBudget + upload-size cap.
   */
  ocrExtract: { temperature: 0, maxTokens: 4000 },

  /**
   * v1.20.1 — Lab-OCR text-mode structuring. The browser OCR's the image
   * (tesseract.js) and POSTs only the extracted TEXT, so the provider does a
   * plain text→JSON structuring pass — no expensive vision input tokens. The
   * output contract is identical (the same dozen-plus analyte rows), but the
   * spend ceiling is far lower than the vision path's 4000, so the day-budget
   * reservation should reflect that rather than over-charging a text call at
   * the vision rate. 1500 tokens comfortably covers a dense report's JSON
   * envelope. Temperature 0 — faithful structuring, not generation.
   */
  ocrExtractText: { temperature: 0, maxTokens: 1500 },
} as const satisfies Record<string, AiBudget>;
