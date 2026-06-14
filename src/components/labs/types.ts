import type { ReferenceRangeStatus } from "@/lib/validations/labs";

/** A lab-result row as the list / create endpoints serialise it. */
export interface LabResultDto {
  id: string;
  panel: string | null;
  analyte: string;
  value: number;
  unit: string;
  referenceLow: number | null;
  referenceHigh: number | null;
  takenAt: string;
  source: string;
  hasNote: boolean;
  rangeStatus: ReferenceRangeStatus;
  createdAt: string;
  updatedAt: string;
}

export interface LabResultListResponse {
  results: LabResultDto[];
  meta: { total: number; limit: number; offset: number };
}
