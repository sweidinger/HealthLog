import type { ReferenceRangeStatus } from "@/lib/validations/labs";

/** A lab-result row as the list / create endpoints serialise it. */
export interface LabResultDto {
  id: string;
  /** v1.18.1 — link to the catalog marker (null for legacy free-text rows). */
  biomarkerId: string | null;
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

/** The single-resource detail DTO — carries the decrypted note. */
export interface LabResultDetailDto extends Omit<LabResultDto, "hasNote"> {
  note: string | null;
}

export interface LabResultListResponse {
  results: LabResultDto[];
  meta: { total: number; limit: number; offset: number };
}

/** A user-scoped Biomarker catalog entry as the API serialises it. */
export interface BiomarkerDto {
  id: string;
  name: string;
  unit: string;
  lowerBound: number | null;
  upperBound: number | null;
  panel: string | null;
  hasContext: boolean;
  context: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BiomarkerListResponse {
  biomarkers: BiomarkerDto[];
}
