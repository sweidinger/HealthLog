/**
 * v1.18.7 (HIGH-2) — cross-surface shared-contract coverage.
 *
 * The grounding / tone / GLP-1-safety / metric-identifier-ban / forbidden-
 * filler contracts live once in `shared-contracts.ts`. These guards assert
 * that each surface that enforces a contract carries the canonical fragment
 * VERBATIM, in both hand-composed locales (de/en). A future edit that lets a
 * surface drift from the shared wording — the exact failure mode HIGH-2
 * documents — trips here instead of shipping silently.
 */
import { describe, expect, it } from "vitest";

import {
  grounding,
  toneContract,
  safetyGlp1,
  safetyAcute,
  metricIdentifierBan,
  forbiddenFiller,
  outlookContract,
  formattingContract,
  type ContractLocale,
} from "../shared-contracts";
import {
  BP_SYS_CRITICAL,
  BP_DIA_CRITICAL,
  GLUCOSE_HYPO_FLOOR,
  GLUCOSE_HYPO_SEVERE_FLOOR,
  GLUCOSE_HYPER_FLOOR,
  FEVER_RED_FLAG_C,
} from "@/lib/clinical-floors";
import { getBaseSystemPrompt } from "../base-system";
import { getStrictInsightsSystemPrompt } from "../insight-generator";
import { getCoachSystemPrompt } from "@/lib/ai/coach/system-prompt";

// The narrative system prompts are module-private; re-derive the same
// composed shared block the generator appends, and assert each fragment is
// present by checking the generator module's exported builder indirectly.
import { SYSTEM_PROMPTS_FOR_TEST } from "@/lib/insights/narrative/period-narrative-generate";

const LOCALES: ContractLocale[] = ["de", "en"];

/** Which contracts each surface enforces (and must carry verbatim). */
const SURFACES: Record<
  string,
  {
    prompt: (l: ContractLocale) => string;
    contracts: Record<ContractLocale, string>[];
  }
> = {
  "insight-generator (comprehensive)": {
    prompt: (l) => getStrictInsightsSystemPrompt(l),
    contracts: [
      grounding,
      toneContract,
      safetyGlp1,
      safetyAcute,
      metricIdentifierBan,
      forbiddenFiller,
      // v1.21.0 (QoL-B §3) — the briefing composes the forward-looking outlook
      // contract beside the tone contract.
      outlookContract,
      // v1.22 (W6) — the paragraph formatting contract.
      formattingContract,
    ],
  },
  "base-system (status cards)": {
    prompt: (l) => getBaseSystemPrompt(l),
    contracts: [
      grounding,
      toneContract,
      safetyGlp1,
      safetyAcute,
      metricIdentifierBan,
      forbiddenFiller,
      // v1.22 (W6) — the paragraph formatting contract.
      formattingContract,
    ],
  },
  coach: {
    prompt: (l) => getCoachSystemPrompt(l),
    contracts: [
      grounding,
      toneContract,
      safetyGlp1,
      safetyAcute,
      metricIdentifierBan,
      forbiddenFiller,
      // v1.21.0 (QoL-B §3) — the Coach composes the outlook contract too.
      outlookContract,
      // v1.22 (W6) — the paragraph formatting contract.
      formattingContract,
    ],
  },
  // v1.21.0 (coach C1 MEDIUM-1) — the retrospective narrative now composes the
  // shared tone contract too, so it matches the warm house voice of the daily
  // briefing beside it. Its own descriptive-never-causal guards stay intact.
  "period-narrative": {
    prompt: (l) => SYSTEM_PROMPTS_FOR_TEST[l],
    contracts: [
      grounding,
      toneContract,
      safetyGlp1,
      safetyAcute,
      metricIdentifierBan,
      forbiddenFiller,
      // v1.22 (W6) — the paragraph formatting contract.
      formattingContract,
    ],
  },
};

describe("shared-contract cross-surface coverage", () => {
  for (const [surface, { prompt, contracts }] of Object.entries(SURFACES)) {
    for (const locale of LOCALES) {
      const text = prompt(locale);
      for (const contract of contracts) {
        const fragment = contract[locale];
        // Use a short, stable slice of the fragment as the assertion anchor —
        // the full fragment is long but must be present verbatim.
        it(`${surface} carries every enforced contract verbatim (${locale})`, () => {
          expect(text).toContain(fragment);
        });
      }
    }
  }

  it("the GLP-1 dose-safety contract reaches all four surfaces", () => {
    for (const locale of LOCALES) {
      expect(getStrictInsightsSystemPrompt(locale)).toContain(
        safetyGlp1[locale],
      );
      expect(getBaseSystemPrompt(locale)).toContain(safetyGlp1[locale]);
      expect(getCoachSystemPrompt(locale)).toContain(safetyGlp1[locale]);
      expect(SYSTEM_PROMPTS_FOR_TEST[locale]).toContain(safetyGlp1[locale]);
    }
  });

  it("the acute red-flag escalation contract reaches all four surfaces", () => {
    for (const locale of LOCALES) {
      expect(getStrictInsightsSystemPrompt(locale)).toContain(
        safetyAcute[locale],
      );
      expect(getBaseSystemPrompt(locale)).toContain(safetyAcute[locale]);
      expect(getCoachSystemPrompt(locale)).toContain(safetyAcute[locale]);
      expect(SYSTEM_PROMPTS_FOR_TEST[locale]).toContain(safetyAcute[locale]);
    }
  });

  it("the outlook contract reaches the Coach + briefing surfaces", () => {
    for (const locale of LOCALES) {
      expect(getCoachSystemPrompt(locale)).toContain(outlookContract[locale]);
      expect(getStrictInsightsSystemPrompt(locale)).toContain(
        outlookContract[locale],
      );
    }
  });
});

// v1.21.0 (D3-M1 / D3-L1) — the acute-safety clause's threshold numbers are
// composed from `clinical-floors.ts`, so the Coach's stated crisis thresholds
// can never drift from the dashboard hero / notification engine / status
// registry that read the same constants. Assert every floor is present in the
// clause for both hand-composed locales, and that the glucose + sustained-fever
// floors (previously absent) are now echoed.
describe("safetyAcute numbers are bound to clinical-floors", () => {
  it("echoes the BP crisis floors verbatim", () => {
    for (const locale of LOCALES) {
      expect(safetyAcute[locale]).toContain(String(BP_SYS_CRITICAL));
      expect(safetyAcute[locale]).toContain(String(BP_DIA_CRITICAL));
    }
  });

  it("echoes the glucose floors verbatim", () => {
    for (const locale of LOCALES) {
      expect(safetyAcute[locale]).toContain(String(GLUCOSE_HYPO_FLOOR));
      expect(safetyAcute[locale]).toContain(String(GLUCOSE_HYPO_SEVERE_FLOOR));
      expect(safetyAcute[locale]).toContain(String(GLUCOSE_HYPER_FLOOR));
    }
  });

  it("echoes the sustained-fever escalation floor verbatim", () => {
    // EN keeps the dot decimal; DE renders the decimal comma.
    expect(safetyAcute.en).toContain(String(FEVER_RED_FLAG_C));
    expect(safetyAcute.de).toContain(
      String(FEVER_RED_FLAG_C).replace(".", ","),
    );
  });
});
