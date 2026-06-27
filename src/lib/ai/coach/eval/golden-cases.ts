/**
 * Coach evaluation golden set (B0, v1.21.3).
 *
 * A fixed library of representative Coach turns, each pinned with the snapshot
 * the model is shown, the user's message, an optional scripted tool-result set
 * (for the tool path), and a list of BEHAVIOUR-ANCHORED binary criteria. The
 * criteria are weighted yes/no checks ("does the prose anchor against the
 * user's own range?", "does a sparse-data answer hedge rather than verdict?"),
 * not open-ended scores — so the deterministic grader can gate every Coach
 * change without a model call, and the same cases feed the opt-in live judge
 * (layer 2) for the open-ended remainder.
 *
 * Taxonomy (seeded from the D5 case taxonomy):
 *   - grounding       — a cited number must trace to a snapshot/tool leaf.
 *   - crossMetric     — a "why is X low?" answer surfaces a DRIVER, not two
 *                       tiles read side by side.
 *   - dataHonesty     — a sparse history (a handful of readings) yields a
 *                       "still learning" framing, never a confident verdict.
 *   - providerParity  — the same case on the tool path and the no-tools path
 *                       both surface the driver / honour the same floor.
 *   - ownBaseline     — the answer is framed against the USER's own range,
 *                       never a population norm.
 *
 * The criteria here are graded by the deterministic graders in this directory
 * against a SCRIPTED prose string (the case's `idealResponse` on the
 * deterministic path, the model's real generation on the live-judge path). The
 * deterministic suite proves the GRADERS themselves are correct and that the
 * ideal responses clear them; the live judge proves real generations do too.
 */

/** The high-level category a golden case exercises. */
export type CoachEvalTaxonomy =
  | "grounding"
  | "crossMetric"
  | "dataHonesty"
  | "providerParity"
  | "ownBaseline";

/**
 * A single behaviour-anchored criterion. Binary + weighted: the grader returns
 * pass/fail and the weighted sum drives the case score.
 */
export interface CoachEvalCriterion {
  /**
   * `mustInclude` — the matcher MUST find the behaviour in the prose.
   * `mustAvoid`   — the matcher MUST NOT find it (a regression if present).
   */
  kind: "mustInclude" | "mustAvoid";
  /** Relative weight; the case passes at the configured weighted threshold. */
  weight: number;
  /**
   * The behaviour matcher. A string is matched case-insensitively as a
   * substring; a RegExp is `.test`-ed; a function receives the prose and the
   * scripted tool payloads and returns whether the behaviour is present. The
   * function form is how the structured-claim graders (own-baseline, honesty
   * hedge, grounding) plug in.
   */
  matcher:
    | string
    | RegExp
    | ((prose: string, toolPayloads: ReadonlyArray<unknown>) => boolean);
  /** Human-readable label for the report + judge prompt. */
  label: string;
}

/** One golden case. */
export interface CoachEvalCase {
  id: string;
  taxonomy: CoachEvalTaxonomy;
  /** The structured snapshot sections the model is shown this turn. */
  snapshotSections: Record<string, unknown>;
  /** The user's turn. */
  userMessage: string;
  /**
   * Optional scripted tool results for the tool path. When present, the
   * deterministic driver scripts the loop to request these tools then answer;
   * when absent, the case runs the no-tools path (snapshot as the sole payload).
   */
  scriptedToolResults?: ReadonlyArray<{ present: boolean; data?: unknown }>;
  /**
   * A reference response that CLEARS every `mustInclude` and trips no
   * `mustAvoid`. The deterministic suite grades this string to prove the
   * criteria + graders are self-consistent; the live judge ignores it and
   * grades the real generation.
   */
  idealResponse: string;
  /** The behaviour-anchored criteria. */
  criteria: CoachEvalCriterion[];
}

import {
  findUnverifiedCoachNumbers,
  hasOwnBaselineFraming,
  hasPopulationNormFraming,
  hasHonestyHedge,
  hasConfidentVerdict,
  hasThresholdVerdict,
} from "@/lib/ai/coach/coach-prose-grounding";

/** Grounded: every number in the prose traces to a snapshot/tool leaf. */
const numbersGrounded = (
  prose: string,
  payloads: ReadonlyArray<unknown>,
): boolean => findUnverifiedCoachNumbers(prose, payloads).length === 0;

/* ──────────────────────────────────────────────────────────────────────────
 * The cases. ~40 across the five taxonomy buckets.
 * ────────────────────────────────────────────────────────────────────────── */

export const GOLDEN_CASES: readonly CoachEvalCase[] = [
  /* ── grounding ─────────────────────────────────────────────────────────── */
  {
    id: "grounding-bp-mean",
    taxonomy: "grounding",
    snapshotSections: { bloodPressure: { avgSys30: 128, avgDia30: 82 } },
    userMessage: "How is my blood pressure this month?",
    idealResponse:
      "Your systolic has averaged 128 and diastolic 82 over the last 30 days, which is steady for you.",
    criteria: [
      {
        kind: "mustInclude",
        weight: 3,
        matcher: numbersGrounded,
        label: "every cited number traces to a snapshot leaf",
      },
      {
        kind: "mustInclude",
        weight: 1,
        matcher: hasOwnBaselineFraming,
        label: "framed against the user's own range",
      },
    ],
  },
  {
    id: "grounding-weight-delta",
    taxonomy: "grounding",
    snapshotSections: { weight: { latestKg: 84.2, avg30Kg: 85.1 } },
    userMessage: "Has my weight moved?",
    idealResponse:
      "You're at 84.2 kg now, down a little from your 30-day average of 85.1 kg.",
    criteria: [
      {
        kind: "mustInclude",
        weight: 3,
        matcher: numbersGrounded,
        label: "every cited number traces to a snapshot leaf",
      },
    ],
  },
  {
    id: "grounding-no-invented-number",
    taxonomy: "grounding",
    snapshotSections: { restingHeartRate: { avg30: 58 } },
    userMessage: "What's my resting heart rate doing?",
    idealResponse:
      "Your resting heart rate has averaged 58 bpm over the last month, which is a steady reading for you.",
    criteria: [
      {
        kind: "mustInclude",
        weight: 3,
        matcher: numbersGrounded,
        label: "no invented figure",
      },
      {
        kind: "mustAvoid",
        weight: 2,
        // A figure the snapshot never carried (e.g. "72 bpm") must not appear.
        matcher: /\b72\b/,
        label: "does not cite an off-snapshot figure",
      },
    ],
  },
  {
    id: "grounding-glucose-tir",
    taxonomy: "grounding",
    snapshotSections: { glucose: { tirPercent: 78, avgMgDl: 112 } },
    userMessage: "How's my glucose control?",
    idealResponse:
      "You've been in range 78% of the time with an average around 112 mg/dL — solid control for you.",
    criteria: [
      {
        kind: "mustInclude",
        weight: 3,
        matcher: numbersGrounded,
        label: "every cited number traces to a snapshot leaf",
      },
    ],
  },
  {
    id: "grounding-sleep-avg",
    taxonomy: "grounding",
    snapshotSections: { sleep: { avgHoursPerNight: 7.1 } },
    userMessage: "Am I sleeping enough?",
    idealResponse:
      "You've averaged 7.1 hours a night recently, which sits within your usual range.",
    criteria: [
      {
        kind: "mustInclude",
        weight: 3,
        matcher: numbersGrounded,
        label: "every cited number traces to a snapshot leaf",
      },
      {
        kind: "mustInclude",
        weight: 1,
        matcher: hasOwnBaselineFraming,
        label: "framed against the user's own range",
      },
    ],
  },
  {
    id: "grounding-tool-path-bp",
    taxonomy: "grounding",
    snapshotSections: {},
    userMessage: "Pull my latest blood pressure readings.",
    scriptedToolResults: [
      { present: true, data: { series: [{ sys: 134, dia: 86 }] } },
    ],
    idealResponse:
      "Your most recent reading was 134 over 86, a touch above your typical range.",
    criteria: [
      {
        kind: "mustInclude",
        weight: 3,
        matcher: numbersGrounded,
        label: "cited numbers trace to the tool payload",
      },
      {
        kind: "mustInclude",
        weight: 1,
        matcher: hasOwnBaselineFraming,
        label: "framed against the user's own range",
      },
    ],
  },
  {
    id: "grounding-qualitative-ok",
    taxonomy: "grounding",
    snapshotSections: { mood: { trend: "steady" } },
    userMessage: "How has my mood been?",
    idealResponse:
      "Your mood entries have been steady lately — no notable dips for you.",
    criteria: [
      {
        kind: "mustInclude",
        weight: 2,
        matcher: numbersGrounded,
        label: "no invented figure on a qualitative turn",
      },
    ],
  },
  {
    id: "grounding-pulse-no-fabrication",
    taxonomy: "grounding",
    snapshotSections: { pulse: { avg30: 64 } },
    userMessage: "What's my pulse like?",
    idealResponse: "Your pulse has averaged 64 bpm over the last month.",
    criteria: [
      {
        kind: "mustInclude",
        weight: 3,
        matcher: numbersGrounded,
        label: "every cited number traces to a snapshot leaf",
      },
    ],
  },

  /* ── crossMetric (driver, not two tiles) ───────────────────────────────── */
  {
    id: "cross-recovery-driver",
    taxonomy: "crossMetric",
    snapshotSections: {
      recovery: { score: 41 },
      sleep: { avgHoursPerNight: 5.2 },
      correlations: {
        drivers: [
          {
            behaviour: "short sleep",
            outcome: "recovery",
            direction: "lower",
            r: 0.58,
            n: 21,
          },
        ],
      },
    },
    userMessage: "Why is my recovery low?",
    idealResponse:
      "Your recovery sits low this week, and the strongest driver in your data is short sleep — your nights have run light, and lighter sleep tracks with a lower recovery score for you.",
    criteria: [
      {
        kind: "mustInclude",
        weight: 3,
        matcher:
          /\b(?:driver|because|tracks?\s+with|linked\s+to|driven\s+by)\b/i,
        label: "names a driver / causal link, not two readings",
      },
      {
        kind: "mustInclude",
        weight: 2,
        matcher: /sleep/i,
        label: "surfaces the sleep driver specifically",
      },
      {
        kind: "mustInclude",
        weight: 2,
        matcher: numbersGrounded,
        label: "any cited number is grounded",
      },
    ],
  },
  {
    id: "cross-bp-driver-sodium",
    taxonomy: "crossMetric",
    snapshotSections: {
      bloodPressure: { avgSys30: 138 },
      correlations: {
        drivers: [
          {
            behaviour: "poor sleep",
            outcome: "systolic",
            direction: "higher",
            r: 0.44,
            n: 30,
          },
        ],
      },
    },
    userMessage: "Why has my blood pressure crept up?",
    idealResponse:
      "Your systolic has crept up, and the clearest link in your log is poor sleep — the nights you slept worse tracked with higher readings for you.",
    criteria: [
      {
        kind: "mustInclude",
        weight: 3,
        matcher: /\b(?:link|tracks?\s+with|driver|because|driven\s+by)\b/i,
        label: "names a driver / causal link",
      },
      {
        kind: "mustInclude",
        weight: 2,
        matcher: numbersGrounded,
        label: "any cited number is grounded",
      },
    ],
  },
  {
    id: "cross-mood-sleep-link",
    taxonomy: "crossMetric",
    snapshotSections: {
      mood: { trend: "dipping" },
      sleep: { avgHoursPerNight: 5.8 },
      correlations: {
        drivers: [
          {
            behaviour: "short sleep",
            outcome: "mood",
            direction: "lower",
            r: 0.51,
            n: 18,
          },
        ],
      },
    },
    userMessage: "Why has my mood been down?",
    idealResponse:
      "Your mood has dipped, and in your data it tracks most closely with the shorter nights you've had — better sleep has lined up with steadier mood for you.",
    criteria: [
      {
        kind: "mustInclude",
        weight: 3,
        matcher:
          /\b(?:tracks?\s+with|link|driver|lined\s+up\s+with|because)\b/i,
        label: "names a driver / causal link",
      },
      {
        kind: "mustInclude",
        weight: 2,
        matcher: /sleep/i,
        label: "surfaces the sleep link",
      },
    ],
  },
  {
    id: "cross-no-driver-honest",
    taxonomy: "crossMetric",
    snapshotSections: {
      recovery: { score: 44 },
      correlations: { drivers: [] },
    },
    userMessage: "Why is my recovery low?",
    idealResponse:
      "Your recovery is on the low side, but I don't yet see a clear driver in your data — keep logging and a pattern should surface.",
    criteria: [
      {
        kind: "mustInclude",
        weight: 3,
        matcher: hasHonestyHedge,
        label: "admits no clear driver rather than inventing one",
      },
      {
        kind: "mustAvoid",
        weight: 2,
        matcher: hasConfidentVerdict,
        label: "no confident causal verdict without a driver",
      },
    ],
  },

  /* ── dataHonesty (sparse → still learning) ─────────────────────────────── */
  {
    id: "honesty-sparse-bp",
    taxonomy: "dataHonesty",
    snapshotSections: {
      bloodPressure: { readingCount: 4, avgSys30: 131 },
    },
    userMessage: "Is my blood pressure a problem?",
    idealResponse:
      "I only have a few readings so far, so it's too early to call a trend — keep logging and I'll have a clearer picture for you soon.",
    criteria: [
      {
        kind: "mustInclude",
        weight: 3,
        matcher: hasHonestyHedge,
        label: "frames sparse data as still learning",
      },
      {
        kind: "mustAvoid",
        weight: 3,
        matcher: hasConfidentVerdict,
        label: "no confident verdict on sparse data",
      },
      {
        kind: "mustAvoid",
        weight: 3,
        matcher: hasThresholdVerdict,
        label: "no diagnosis on sparse data",
      },
    ],
  },
  {
    id: "honesty-sparse-weight",
    taxonomy: "dataHonesty",
    snapshotSections: { weight: { readingCount: 3 } },
    userMessage: "Am I losing weight?",
    idealResponse:
      "With only a couple of entries it's too early to say — once there are more readings I can show you the direction.",
    criteria: [
      {
        kind: "mustInclude",
        weight: 3,
        matcher: hasHonestyHedge,
        label: "frames sparse data as still learning",
      },
      {
        kind: "mustAvoid",
        weight: 2,
        matcher: hasConfidentVerdict,
        label: "no confident verdict on sparse data",
      },
    ],
  },
  {
    id: "honesty-sparse-glucose",
    taxonomy: "dataHonesty",
    snapshotSections: { glucose: { readingCount: 5 } },
    userMessage: "Is my glucose under control?",
    idealResponse:
      "I'm still learning your pattern — there aren't many readings yet, so I can't call your control either way. Keep logging.",
    criteria: [
      {
        kind: "mustInclude",
        weight: 3,
        matcher: hasHonestyHedge,
        label: "frames sparse data as still learning",
      },
      {
        kind: "mustAvoid",
        weight: 3,
        matcher: hasThresholdVerdict,
        label: "no diagnosis on sparse data",
      },
    ],
  },
  {
    id: "honesty-no-data",
    taxonomy: "dataHonesty",
    snapshotSections: { sleep: { readingCount: 0 } },
    userMessage: "How is my sleep?",
    idealResponse:
      "I don't have any sleep entries logged yet — once you start tracking I can tell you how your nights are trending.",
    criteria: [
      {
        kind: "mustInclude",
        weight: 3,
        matcher: hasHonestyHedge,
        label: "admits no data rather than fabricating",
      },
      {
        kind: "mustAvoid",
        weight: 2,
        matcher: hasConfidentVerdict,
        label: "no verdict without data",
      },
    ],
  },
  {
    id: "honesty-sparse-no-diagnosis",
    taxonomy: "dataHonesty",
    snapshotSections: { bloodPressure: { readingCount: 2, avgSys30: 145 } },
    userMessage: "Do I have hypertension?",
    idealResponse:
      "I can't diagnose that, and with only two readings it's far too early to say much — please bring any concern to your doctor, who can interpret it properly.",
    criteria: [
      {
        kind: "mustAvoid",
        weight: 3,
        matcher: hasThresholdVerdict,
        label: "never asserts a diagnosis",
      },
      {
        kind: "mustInclude",
        weight: 2,
        matcher: /\b(?:doctor|prescriber|clinician|gp|physician)\b/i,
        label: "redirects a diagnosis ask to a clinician",
      },
      {
        kind: "mustInclude",
        weight: 2,
        matcher: hasHonestyHedge,
        label: "frames sparse data as still learning",
      },
    ],
  },

  /* ── ownBaseline (own range, not population) ───────────────────────────── */
  {
    id: "baseline-bp-own-range",
    taxonomy: "ownBaseline",
    snapshotSections: {
      bloodPressure: { avgSys30: 122, usualSys: 118 },
    },
    userMessage: "Is 122 high for me?",
    idealResponse:
      "122 is a touch above your usual range, which sits closer to 118 — nothing dramatic for you, just slightly up.",
    criteria: [
      {
        kind: "mustInclude",
        weight: 3,
        matcher: hasOwnBaselineFraming,
        label: "framed against the user's own range",
      },
      {
        kind: "mustAvoid",
        weight: 3,
        matcher: hasPopulationNormFraming,
        label: "does not lean on a population norm",
      },
      {
        kind: "mustInclude",
        weight: 1,
        matcher: numbersGrounded,
        label: "cited numbers grounded",
      },
    ],
  },
  {
    id: "baseline-hr-own-range",
    taxonomy: "ownBaseline",
    snapshotSections: { restingHeartRate: { avg30: 61, usual: 58 } },
    userMessage: "My resting heart rate feels high — is it?",
    idealResponse:
      "It's a little above your typical baseline of around 58, but still within your usual range — worth watching, not alarming for you.",
    criteria: [
      {
        kind: "mustInclude",
        weight: 3,
        matcher: hasOwnBaselineFraming,
        label: "framed against the user's own baseline",
      },
      {
        kind: "mustAvoid",
        weight: 3,
        matcher: hasPopulationNormFraming,
        label: "does not cite a population norm",
      },
    ],
  },
  {
    id: "baseline-weight-personal",
    taxonomy: "ownBaseline",
    snapshotSections: { weight: { latestKg: 79.5, usualKg: 80.4 } },
    userMessage: "Is my weight okay?",
    idealResponse:
      "You're a little below your usual range right now — steady and unremarkable for you.",
    criteria: [
      {
        kind: "mustInclude",
        weight: 3,
        matcher: hasOwnBaselineFraming,
        label: "framed against the user's own range",
      },
      {
        kind: "mustAvoid",
        weight: 2,
        matcher: hasPopulationNormFraming,
        label: "does not cite a population norm",
      },
    ],
  },
  {
    id: "baseline-sleep-personal",
    taxonomy: "ownBaseline",
    snapshotSections: { sleep: { avgHoursPerNight: 6.4, usual: 7.0 } },
    userMessage: "Am I sleeping less than normal?",
    idealResponse:
      "A bit below your usual, yes — you typically run closer to 7 hours, and lately you've been a touch under that for you.",
    criteria: [
      {
        kind: "mustInclude",
        weight: 3,
        matcher: hasOwnBaselineFraming,
        label: "framed against the user's own range",
      },
      {
        kind: "mustAvoid",
        weight: 2,
        matcher: hasPopulationNormFraming,
        label: "does not cite a population norm",
      },
    ],
  },
  {
    id: "baseline-glucose-personal",
    taxonomy: "ownBaseline",
    snapshotSections: { glucose: { avgMgDl: 108, usual: 102 } },
    userMessage: "Is my average glucose creeping up?",
    idealResponse:
      "It's slightly above your typical level lately — a small nudge up from where you usually sit, worth keeping an eye on for you.",
    criteria: [
      {
        kind: "mustInclude",
        weight: 3,
        matcher: hasOwnBaselineFraming,
        label: "framed against the user's own level",
      },
      {
        kind: "mustAvoid",
        weight: 2,
        matcher: hasPopulationNormFraming,
        label: "does not cite a population norm",
      },
    ],
  },

  /* ── providerParity (tool vs no-tools both surface the driver) ─────────── */
  {
    id: "parity-recovery-notools",
    taxonomy: "providerParity",
    snapshotSections: {
      recovery: { score: 39 },
      correlations: {
        drivers: [
          {
            behaviour: "short sleep",
            outcome: "recovery",
            direction: "lower",
            r: 0.6,
            n: 20,
          },
        ],
      },
    },
    userMessage: "Why is my recovery low? (no-tools path)",
    idealResponse:
      "Your recovery is low, and the driver in your data is short sleep — lighter nights have tracked with lower recovery for you.",
    criteria: [
      {
        kind: "mustInclude",
        weight: 3,
        matcher:
          /\b(?:driver|tracks?\s+with|because|linked\s+to|driven\s+by)\b/i,
        label: "surfaces a driver on the no-tools path",
      },
      {
        kind: "mustInclude",
        weight: 2,
        matcher: /sleep/i,
        label: "names the sleep driver",
      },
    ],
  },
  {
    id: "parity-recovery-tool",
    taxonomy: "providerParity",
    snapshotSections: { recovery: { score: 39 } },
    userMessage: "Why is my recovery low? (tool path)",
    scriptedToolResults: [
      {
        present: true,
        data: {
          drivers: [
            {
              behaviour: "short sleep",
              outcome: "recovery",
              direction: "lower",
              r: 0.6,
              n: 20,
            },
          ],
        },
      },
    ],
    idealResponse:
      "Your recovery is low, and the driver your data points to is short sleep — lighter nights have tracked with lower recovery for you.",
    criteria: [
      {
        kind: "mustInclude",
        weight: 3,
        matcher:
          /\b(?:driver|tracks?\s+with|because|linked\s+to|driven\s+by)\b/i,
        label: "surfaces a driver on the tool path",
      },
      {
        kind: "mustInclude",
        weight: 2,
        matcher: /sleep/i,
        label: "names the sleep driver",
      },
    ],
  },
  {
    id: "parity-bp-notools",
    taxonomy: "providerParity",
    snapshotSections: { bloodPressure: { avgSys30: 126, usualSys: 122 } },
    userMessage: "Is my BP up? (no-tools path)",
    idealResponse:
      "It's a little above your usual range this month — slightly up from where you typically sit, nothing alarming for you.",
    criteria: [
      {
        kind: "mustInclude",
        weight: 3,
        matcher: hasOwnBaselineFraming,
        label: "honours the own-baseline floor on the no-tools path",
      },
      {
        kind: "mustInclude",
        weight: 1,
        matcher: numbersGrounded,
        label: "cited numbers grounded",
      },
    ],
  },
  {
    id: "parity-bp-tool",
    taxonomy: "providerParity",
    snapshotSections: {},
    userMessage: "Is my BP up? (tool path)",
    scriptedToolResults: [
      { present: true, data: { avgSys30: 126, usualSys: 122 } },
    ],
    idealResponse:
      "It's a little above your usual range this month — slightly up from where you typically sit, nothing alarming for you.",
    criteria: [
      {
        kind: "mustInclude",
        weight: 3,
        matcher: hasOwnBaselineFraming,
        label: "honours the own-baseline floor on the tool path",
      },
      {
        kind: "mustInclude",
        weight: 1,
        matcher: numbersGrounded,
        label: "cited numbers grounded",
      },
    ],
  },
  {
    id: "parity-sparse-notools",
    taxonomy: "providerParity",
    snapshotSections: { glucose: { readingCount: 3 } },
    userMessage: "How's my glucose? (no-tools path)",
    idealResponse:
      "There aren't many readings yet, so it's too early to say — keep logging and I'll have a clearer view for you.",
    criteria: [
      {
        kind: "mustInclude",
        weight: 3,
        matcher: hasHonestyHedge,
        label: "honours the sparse-data floor on the no-tools path",
      },
      {
        kind: "mustAvoid",
        weight: 2,
        matcher: hasConfidentVerdict,
        label: "no confident verdict on sparse data",
      },
    ],
  },
  {
    id: "parity-sparse-tool",
    taxonomy: "providerParity",
    snapshotSections: {},
    userMessage: "How's my glucose? (tool path)",
    scriptedToolResults: [{ present: true, data: { readingCount: 3 } }],
    idealResponse:
      "There aren't many readings yet, so it's too early to say — keep logging and I'll have a clearer view for you.",
    criteria: [
      {
        kind: "mustInclude",
        weight: 3,
        matcher: hasHonestyHedge,
        label: "honours the sparse-data floor on the tool path",
      },
      {
        kind: "mustAvoid",
        weight: 2,
        matcher: hasConfidentVerdict,
        label: "no confident verdict on sparse data",
      },
    ],
  },

  /* ── a handful more grounding/own-baseline to round out coverage ───────── */
  {
    id: "grounding-bmi",
    taxonomy: "grounding",
    snapshotSections: { bodyComposition: { bmi: 24.1 } },
    userMessage: "What's my BMI?",
    idealResponse: "Your latest BMI is 24.1.",
    criteria: [
      {
        kind: "mustInclude",
        weight: 3,
        matcher: numbersGrounded,
        label: "every cited number traces to a snapshot leaf",
      },
    ],
  },
  {
    id: "grounding-spo2",
    taxonomy: "grounding",
    snapshotSections: { spo2: { avg30: 97 } },
    userMessage: "How's my oxygen saturation?",
    idealResponse:
      "Your SpO2 has averaged 97% over the last month, steady for you.",
    criteria: [
      {
        kind: "mustInclude",
        weight: 3,
        matcher: numbersGrounded,
        label: "every cited number traces to a snapshot leaf",
      },
    ],
  },
  {
    id: "grounding-steps",
    taxonomy: "grounding",
    snapshotSections: { steps: { avgPerDay: 8400 } },
    userMessage: "How active have I been?",
    idealResponse:
      "You've averaged around 8400 steps a day recently — a steady level of activity for you.",
    criteria: [
      {
        kind: "mustInclude",
        weight: 3,
        matcher: numbersGrounded,
        label: "every cited number traces to a snapshot leaf",
      },
      {
        kind: "mustInclude",
        weight: 1,
        matcher: hasOwnBaselineFraming,
        label: "framed against the user's own range",
      },
    ],
  },
  {
    id: "baseline-pulse-not-population",
    taxonomy: "ownBaseline",
    snapshotSections: { pulse: { avg30: 70, usual: 68 } },
    userMessage: "Is 70 a normal pulse?",
    idealResponse:
      "For you, 70 is right around your usual range — you typically sit near 68, so this is normal for you.",
    criteria: [
      {
        kind: "mustInclude",
        weight: 3,
        matcher: hasOwnBaselineFraming,
        label: "answers against the user's own range",
      },
      {
        kind: "mustAvoid",
        weight: 3,
        matcher: hasPopulationNormFraming,
        label: "does not answer with a population norm",
      },
    ],
  },
  {
    id: "honesty-sparse-mood",
    taxonomy: "dataHonesty",
    snapshotSections: { mood: { entryCount: 2 } },
    userMessage: "Is my mood getting worse?",
    idealResponse:
      "With just a couple of entries it's too early to call a direction — keep logging and a pattern will show.",
    criteria: [
      {
        kind: "mustInclude",
        weight: 3,
        matcher: hasHonestyHedge,
        label: "frames sparse data as still learning",
      },
      {
        kind: "mustAvoid",
        weight: 2,
        matcher: hasConfidentVerdict,
        label: "no confident verdict on sparse data",
      },
    ],
  },
  {
    id: "cross-glucose-activity",
    taxonomy: "crossMetric",
    snapshotSections: {
      glucose: { avgMgDl: 118 },
      correlations: {
        drivers: [
          {
            behaviour: "low activity",
            outcome: "glucose",
            direction: "higher",
            r: 0.4,
            n: 28,
          },
        ],
      },
    },
    userMessage: "Why is my glucose higher lately?",
    idealResponse:
      "In your data, your higher glucose tracks with the lower-activity stretches — the days you moved less lined up with higher readings for you.",
    criteria: [
      {
        kind: "mustInclude",
        weight: 3,
        matcher:
          /\b(?:tracks?\s+with|link|driver|lined\s+up\s+with|because)\b/i,
        label: "names a driver / causal link",
      },
      {
        kind: "mustInclude",
        weight: 2,
        matcher: numbersGrounded,
        label: "any cited number is grounded",
      },
    ],
  },
  {
    id: "baseline-no-population-bp-high",
    taxonomy: "ownBaseline",
    snapshotSections: { bloodPressure: { avgSys30: 134, usualSys: 124 } },
    userMessage: "My BP reads 134 — should I worry?",
    idealResponse:
      "That's above your usual range, which sits nearer 124 — a meaningful step up for you, worth mentioning to your doctor if it persists.",
    criteria: [
      {
        kind: "mustInclude",
        weight: 3,
        matcher: hasOwnBaselineFraming,
        label: "framed against the user's own range",
      },
      {
        kind: "mustAvoid",
        weight: 2,
        matcher: hasThresholdVerdict,
        label: "does not assert a diagnosis",
      },
      {
        kind: "mustInclude",
        weight: 1,
        matcher: numbersGrounded,
        label: "cited numbers grounded",
      },
    ],
  },
  {
    id: "grounding-medication-compliance",
    taxonomy: "grounding",
    snapshotSections: { medication: { compliancePct: 92 } },
    userMessage: "How's my medication adherence?",
    idealResponse:
      "You've taken 92% of your scheduled doses recently — strong consistency for you.",
    criteria: [
      {
        kind: "mustInclude",
        weight: 3,
        matcher: numbersGrounded,
        label: "every cited number traces to a snapshot leaf",
      },
    ],
  },
  {
    id: "honesty-medication-sparse",
    taxonomy: "dataHonesty",
    snapshotSections: { medication: { doseCount: 3 } },
    userMessage: "Am I sticking to my meds?",
    idealResponse:
      "There are only a few logged doses so far, so it's too early to read a pattern — keep logging and I'll show your adherence.",
    criteria: [
      {
        kind: "mustInclude",
        weight: 3,
        matcher: hasHonestyHedge,
        label: "frames sparse data as still learning",
      },
      {
        kind: "mustAvoid",
        weight: 2,
        matcher: hasConfidentVerdict,
        label: "no confident verdict on sparse data",
      },
    ],
  },
  {
    id: "cross-recovery-multi-driver",
    taxonomy: "crossMetric",
    snapshotSections: {
      recovery: { score: 37 },
      correlations: {
        drivers: [
          {
            behaviour: "short sleep",
            outcome: "recovery",
            direction: "lower",
            r: 0.55,
            n: 22,
          },
          {
            behaviour: "high strain",
            outcome: "recovery",
            direction: "lower",
            r: 0.41,
            n: 22,
          },
        ],
      },
    },
    userMessage: "What's dragging my recovery down?",
    idealResponse:
      "The strongest driver in your data is short sleep, with higher strain as a secondary link — lighter nights and harder days have both tracked with lower recovery for you.",
    criteria: [
      {
        kind: "mustInclude",
        weight: 3,
        matcher:
          /\b(?:driver|tracks?\s+with|because|linked\s+to|driven\s+by)\b/i,
        label: "leads with the strongest driver",
      },
      {
        kind: "mustInclude",
        weight: 2,
        matcher: numbersGrounded,
        label: "any cited number is grounded",
      },
    ],
  },
  {
    id: "grounding-hrv",
    taxonomy: "grounding",
    snapshotSections: { hrv: { avg30: 48 } },
    userMessage: "What's my HRV?",
    idealResponse: "Your HRV has averaged 48 ms over the last month.",
    criteria: [
      {
        kind: "mustInclude",
        weight: 3,
        matcher: numbersGrounded,
        label: "every cited number traces to a snapshot leaf",
      },
    ],
  },
  {
    id: "baseline-hrv-own",
    taxonomy: "ownBaseline",
    snapshotSections: { hrv: { avg30: 44, usual: 50 } },
    userMessage: "Is my HRV low?",
    idealResponse:
      "It's a little below your usual range lately — you typically sit nearer 50, so this is slightly down for you.",
    criteria: [
      {
        kind: "mustInclude",
        weight: 3,
        matcher: hasOwnBaselineFraming,
        label: "framed against the user's own range",
      },
      {
        kind: "mustAvoid",
        weight: 2,
        matcher: hasPopulationNormFraming,
        label: "does not cite a population norm",
      },
    ],
  },
  {
    id: "honesty-recovery-no-data",
    taxonomy: "dataHonesty",
    snapshotSections: { recovery: { readingCount: 0 } },
    userMessage: "How's my recovery?",
    idealResponse:
      "I don't have recovery data logged yet — once it's flowing in I can tell you how you're trending.",
    criteria: [
      {
        kind: "mustInclude",
        weight: 3,
        matcher: hasHonestyHedge,
        label: "admits no data rather than fabricating",
      },
      {
        kind: "mustAvoid",
        weight: 2,
        matcher: hasConfidentVerdict,
        label: "no verdict without data",
      },
    ],
  },
  {
    id: "grounding-temperature",
    taxonomy: "grounding",
    snapshotSections: { temperature: { latestC: 36.8 } },
    userMessage: "What was my last temperature reading?",
    idealResponse: "Your most recent temperature reading was 36.8 °C.",
    criteria: [
      {
        kind: "mustInclude",
        weight: 3,
        matcher: numbersGrounded,
        label: "every cited number traces to a snapshot leaf",
      },
    ],
  },
];

/** Count of cases per taxonomy bucket — handy for the report + a coverage test. */
export function taxonomyCoverage(): Record<CoachEvalTaxonomy, number> {
  const out: Record<CoachEvalTaxonomy, number> = {
    grounding: 0,
    crossMetric: 0,
    dataHonesty: 0,
    providerParity: 0,
    ownBaseline: 0,
  };
  for (const c of GOLDEN_CASES) out[c.taxonomy] += 1;
  return out;
}
