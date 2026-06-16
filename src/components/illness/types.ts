/**
 * Client-side illness DTO mirrors (v1.18.1) — the wire shapes the
 * `/api/illness/*` routes return. Kept in lockstep with
 * `src/lib/illness/dto.ts` (the server-authoritative source).
 */
export type IllnessType =
  | "INFECTION"
  | "ALLERGY"
  | "INJURY"
  | "MENTAL_HEALTH"
  | "AUTOIMMUNE"
  | "CHRONIC"
  | "OTHER";

export type IllnessLifecycle =
  | "ACUTE"
  | "CHRONIC_ONGOING"
  | "RECURRING"
  | "FLARE";

export interface IllnessSymptomSelection {
  key: string;
  severity?: number | null;
}

export interface IllnessEpisodeDTO {
  id: string;
  label: string;
  type: IllnessType;
  lifecycle: IllnessLifecycle;
  onsetAt: string;
  resolvedAt: string | null;
  parentConditionId: string | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface IllnessDayLogDTO {
  id: string;
  episodeId: string;
  date: string;
  functionalImpact: number | null;
  feverC: number | null;
  symptoms: IllnessSymptomSelection[];
  note: string | null;
  updatedAt: string;
}

export interface IllnessEpisodeCreateInput {
  label: string;
  type: IllnessType;
  lifecycle?: IllnessLifecycle;
  onsetAt?: string;
  note?: string | null;
}

export interface IllnessDayLogInput {
  date: string;
  functionalImpact?: number | null;
  feverC?: number | null;
  symptoms?: IllnessSymptomSelection[];
  note?: string | null;
}
