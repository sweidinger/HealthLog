/**
 * v1.25.3 — shared types for the opt-in mental-health screener surface.
 *
 * The 387-line monolith split into a folder of focused components; these are
 * the seams they plug into. The wire shapes mirror the assessment route's
 * `shapeRow` / create response (`src/app/api/mental-health/assessments/route.ts`)
 * — totals + bands + flags only, NEVER item content (the item answers stay
 * encrypted at rest and never ride this surface).
 */
import type { InstrumentId } from "@/lib/mental-health/instruments";

export type { InstrumentId };

export type Phase = "choose" | "form" | "result";

export interface AssessmentRow {
  id: string;
  instrument: InstrumentId;
  /** Locale of the validated wording presented — re-derives crisis resources. */
  locale: string;
  totalScore: number;
  severityBand: string;
  item9Flagged: boolean;
  crisisShownAt: string | null;
  takenAt: string;
}

export interface CrisisSet {
  emergencyNumber: string;
  resources: { id: string; contacts: string[] }[];
}

export interface CreateResponse {
  assessment: AssessmentRow;
  actionThreshold: number;
  crisis: CrisisSet | null;
}
