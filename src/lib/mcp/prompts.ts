/**
 * Phase 4 — MCP prompts (user-controlled templated workflows).
 *
 * Prompts are the slash-command surface a host exposes to the user. Unlike
 * tools (model-controlled), a prompt is picked by the user and returns a set of
 * messages pre-loaded with REAL, server-retrieved data plus the safety framing
 * injected once, centrally (catalogue §5 #2, ADR-004).
 *
 * `doctor_visit_summary` is the showcase capability: it assembles a grounded,
 * structured visit-prep summary from the SAME doctor-report data path
 * (`collectDoctorReportData`) that backs the PDF the user already trusts — so
 * the numbers match the export byte-for-byte. It carries the identical grounding
 * discipline as the Coach:
 *   - only values the server computed (no fabricated readings);
 *   - reference / clinical bands are server-side, never invented by the model;
 *   - DATA + CONTEXT only — never a diagnosis, verdict, or treatment change.
 *
 * Token budget (R-DEL-2): the prompt SUMMARISES (latest + aggregate per metric,
 * latest reading per analyte) — it never dumps the full per-reading history.
 */
import { z } from "zod/v4";

import { annotate } from "@/lib/logging/context";
import {
  collectDoctorReportData,
  type DoctorReportData,
} from "@/lib/doctor-report-data";
import { getMetricStatusMeta } from "@/lib/insights/metric-status-registry";
import { coachScopeWindowSchema } from "@/lib/ai/coach/types";
import type { CoachScopeWindow } from "@/lib/ai/coach/types";
import type { McpAuthContext } from "./auth";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Trailing-day count per window, capped at the doctor-report 365-day ceiling. */
const WINDOW_DAYS: Record<CoachScopeWindow, number> = {
  last7days: 7,
  last30days: 30,
  last90days: 90,
  lastYear: 365,
  allTime: 365,
};

/** A returned prompt message — mirrors the SDK `GetPromptResult` shape. */
export interface McpPromptMessage {
  role: "user" | "assistant";
  content: { type: "text"; text: string };
}

export interface McpPromptResult {
  description?: string;
  messages: McpPromptMessage[];
}

/** A registry entry — transport-agnostic, mirroring `McpToolDefinition`. */
export interface McpPromptDefinition {
  name: string;
  title: string;
  description: string;
  /** zod/v4 raw shape handed to the SDK's `registerPrompt` for arg validation. */
  argsShape: z.ZodRawShape;
  run: (
    ctx: McpAuthContext,
    args: Record<string, unknown>,
  ) => Promise<McpPromptResult>;
}

/**
 * Fallback units for the headline specialised metric types the generic
 * `metric-status-registry` intentionally omits (it carries the synced/additive
 * metrics only). The doctor-report stats map is keyed by `MeasurementType`.
 */
const FALLBACK_UNITS: Record<string, string> = {
  WEIGHT: "kg",
  BLOOD_PRESSURE_SYS: "mmHg",
  BLOOD_PRESSURE_DIA: "mmHg",
  PULSE: "bpm",
  BODY_MASS_INDEX: "kg/m²",
  SLEEP_DURATION: "min",
};

function unitAndBandFor(type: string): {
  unit: string;
  referenceBand: { low: number; high: number } | null;
} {
  const meta = getMetricStatusMeta(type);
  if (meta) {
    return {
      unit: meta.unit,
      referenceBand: meta.normalRange
        ? { low: meta.normalRange.low, high: meta.normalRange.high }
        : null,
    };
  }
  return { unit: FALLBACK_UNITS[type] ?? "", referenceBand: null };
}

const round = (n: number): number => Math.round(n * 100) / 100;

/**
 * Reduce the full doctor-report payload to a compact, clinician-oriented
 * summary. Latest + aggregate per metric, latest reading per analyte — never
 * the full per-reading history (R-DEL-2). Every numeric value is one the server
 * computed; every band is server-side. No verdict, no diagnosis.
 */
function summariseForVisit(data: DoctorReportData): Record<string, unknown> {
  const vitals = Object.entries(data.stats).map(([type, s]) => {
    const { unit, referenceBand } = unitAndBandFor(type);
    return {
      metric: type,
      unit,
      referenceBand,
      latest: round(s.latest),
      avg: round(s.avg),
      min: round(s.min),
      max: round(s.max),
      readings: s.count,
    };
  });

  const compliance = Object.entries(data.compliance).map(([name, c]) => ({
    medication: name,
    takenDoses: c.taken,
    expectedDoses: c.total,
    missedDoses: c.missed,
    adherencePct:
      c.total > 0 ? Math.min(100, Math.round((c.taken / c.total) * 100)) : null,
  }));

  const medications = data.medications
    .slice(0, 40)
    .map((m) => ({ name: m.name, dose: m.dose }));

  const labs = (data.labResults ?? []).slice(0, 50).map((l) => ({
    analyte: l.analyte,
    panel: l.panel,
    value: l.value,
    valueText: l.valueText,
    unit: l.unit,
    referenceLow: l.referenceLow,
    referenceHigh: l.referenceHigh,
    takenAt: l.takenAt,
    readings: l.count,
  }));

  const wellness = (data.wellnessScores ?? []).map((w) => ({
    score: w.type,
    latest: round(w.latest),
    avg: round(w.avg),
    note: "descriptive composite, not a clinical assessment",
  }));

  const illness = (data.illnessEpisodes ?? []).map((e) => ({
    label: e.label,
    type: e.type,
    lifecycle: e.lifecycle,
    onsetAt: e.onsetAt,
    resolvedAt: e.resolvedAt,
  }));

  return {
    period: {
      days: data.period.days,
      start: data.period.start,
      end: data.period.end,
    },
    patient: {
      dateOfBirth: data.patient.dateOfBirth,
      sex: data.patient.gender,
      heightCm: data.patient.heightCm,
    },
    bmi: data.bmi,
    vitals,
    medications,
    compliance,
    // Mood is privacy-gated upstream; include only the aggregate when present.
    ...(data.mood
      ? {
          mood: {
            avg: round(data.mood.avg),
            min: data.mood.min,
            max: data.mood.max,
            entries: data.mood.count,
          },
        }
      : {}),
    // Glucose clinical panel only when the user logs glucose (stillLearning
    // flags a too-thin period — surfaced honestly, never asserted).
    ...(data.glucoseClinical && !data.glucoseClinical.stillLearning
      ? { glucosePanel: data.glucoseClinical }
      : {}),
    ...(labs.length > 0 ? { labs } : {}),
    ...(wellness.length > 0 ? { wellnessScores: wellness } : {}),
    ...(illness.length > 0 ? { illnessEpisodes: illness } : {}),
  };
}

/**
 * The framing block prepended to the assembled data. Injected once, centrally:
 * the assistant is told to organise + present, never to diagnose or invent.
 */
const VISIT_FRAMING = [
  "You are preparing a concise, factual summary to help the user get ready for a doctor's visit.",
  "Use ONLY the structured data below — every value, unit, and reference band is computed server-side from the user's own records.",
  "Do NOT invent, estimate, or infer any reading that is not present. Do NOT provide a diagnosis, clinical verdict, risk score, or treatment/medication change — those are the clinician's role.",
  "Organise the data into clear sections (vitals, medications & adherence, labs, notable changes). Where a value sits outside its reference band, state the value and band factually; do not interpret it.",
  "If a section is empty, say it was not recorded in this period rather than guessing.",
].join(" ");

export const MCP_PROMPTS: McpPromptDefinition[] = [
  {
    name: "doctor_visit_summary",
    title: "Doctor visit summary",
    description:
      "Assemble a structured, grounded visit-prep summary from the user's own records over a window — vitals (with units + reference bands), medications & adherence, labs (with reference ranges), and notable context. Reuses the doctor-report data path so the numbers match the exported PDF. Data + context only: no diagnosis, no verdict.",
    argsShape: { window: coachScopeWindowSchema.optional() },
    async run(ctx, args) {
      const window = (
        typeof args.window === "string" ? args.window : "last90days"
      ) as CoachScopeWindow;
      const days = WINDOW_DAYS[window] ?? 90;
      const end = new Date();
      const start = new Date(end.getTime() - days * MS_PER_DAY);

      const data = await collectDoctorReportData(ctx.userId, {
        start,
        end,
        days,
      });
      const summary = summariseForVisit(data);

      annotate({
        action: { name: "mcp.prompt.invoked" },
        meta: {
          prompt: "doctor_visit_summary",
          days,
          vitals: Array.isArray(summary.vitals) ? summary.vitals.length : 0,
        },
      });

      return {
        description: `Visit-prep summary over the last ${days} days, grounded in your own records.`,
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `${VISIT_FRAMING}\n\nDATA (server-authoritative, JSON):\n${JSON.stringify(
                summary,
              )}`,
            },
          },
        ],
      };
    },
  },
];

/** Stable list of the registered prompt names. */
export const MCP_PROMPT_NAMES: readonly string[] = MCP_PROMPTS.map(
  (p) => p.name,
);
