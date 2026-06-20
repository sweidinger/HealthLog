import { z } from "zod/v4";

// ─── Insight Result Schema ─────────────────────────────────

export const insightFindingSchema = z.object({
  label: z.string(),
  value: z.string(),
  assessment: z.enum(["positive", "neutral", "attention", "warning"]),
  guideline: z.string().optional(),
});

export const insightCorrelationSchema = z.object({
  factor: z.string(),
  effect: z.string(),
  confidence: z.enum(["hoch", "mittel", "gering"]),
});

export const insightDataQualitySchema = z.object({
  coverage: z.string(),
  gaps: z.array(z.string()),
  confidence: z.enum(["hoch", "mittel", "gering"]),
});

/**
 * v1.4.16 phase B5c — rationale shape mirrors the strict
 * `aiRecommendationRationaleSchema`. dataWindow values match
 * `mini-window.ts` so the rec card's mini-chart can pin to the right
 * window without an extra mapping table.
 */
export const insightRecommendationRationaleSchema = z.object({
  dataWindow: z.enum(["last7days", "last30days", "last90days", "allTime"]),
  comparedTo: z.string(),
  deviation: z.string(),
});

export type InsightRecommendationRationale = z.infer<
  typeof insightRecommendationRationaleSchema
>;

/**
 * v1.4.16 — recommendations can be either the legacy plain-string
 * shape OR a structured object carrying an optional medical-reference
 * citation. The card renders a footnote with a labelled link when
 * `referenceId` is set and resolves to a known entry in
 * `MEDICAL_REFERENCES`.
 *
 * v1.4.16 phase B5c — adds `rationale` (Oura-style "Contributors")
 * and `metricSource` so the rec card can render the expand-out
 * explainability panel + a mini-chart pinned to the rec's window.
 * Both fields are optional on the UI type because legacy cached
 * payloads predate them; the server-side `aiRecommendationSchema`
 * enforces presence on fresh generations.
 */
export const insightRecommendationSchema = z.union([
  z.string(),
  z.object({
    text: z.string(),
    referenceId: z.string().optional(),
    rationale: insightRecommendationRationaleSchema.optional(),
    metricSource: z
      .object({
        type: z.string(),
        timeRange: z.string(),
        summary: z.string(),
        n: z.number().optional(),
      })
      .optional(),
    severity: z.enum(["info", "suggestion", "important", "urgent"]).optional(),
    id: z.string().optional(),
    /**
     * v1.4.16 phase B5d — deterministic confidence score (0-100).
     * Optional on the UI type because legacy cached payloads predate
     * the field; `<ConfidenceMeter>` renders a "draft" pill in that
     * case. Server-side `aiRecommendationSchema` mirrors this shape.
     */
    confidence: z.number().int().min(0).max(100).optional(),
  }),
]);

export type InsightRecommendation = z.infer<typeof insightRecommendationSchema>;

export const insightResultSchema = z.object({
  insightType: z.string().optional(),
  summary: z.string(),
  classification: z.enum([
    "optimal",
    "gut",
    "grenzwertig",
    "erhoht",
    "kritisch",
  ]),
  classificationLabel: z.string().optional(),
  findings: z.array(insightFindingSchema),
  correlations: z.array(insightCorrelationSchema),
  primaryRecommendation: z.string().optional(),
  recommendations: z.array(insightRecommendationSchema),
  dataQuality: insightDataQualitySchema,
  disclaimer: z.string(),
});

export type InsightResult = z.infer<typeof insightResultSchema>;

// ─── Provider Types ────────────────────────────────────────

export type ProviderType =
  | "codex"
  | "admin-key"
  | "anthropic"
  | "local"
  | "none";

export interface AIProvider {
  type: ProviderType;
  generateCompletion(params: CompletionParams): Promise<CompletionResult>;
}

/**
 * v1.18.9 — a single vision input folded into the provider request. Used by
 * the Lab-OCR extraction path: a photo of a paper report, or a PDF page.
 * `dataBase64` is the raw file bytes, base64-encoded (no `data:` prefix —
 * each client wraps it in the wire shape it needs). The blob is NEVER threaded
 * into an `annotate()` meta or any log field (it is health data).
 */
export interface CompletionImage {
  /** One of the sniffed image MIME types. */
  mediaType: "image/jpeg" | "image/png" | "image/webp";
  /** Raw file bytes, base64-encoded (no data-URL prefix). */
  dataBase64: string;
}

/**
 * v1.18.9 — a PDF document folded into the provider request. Only Anthropic
 * accepts a native `document` block over the Messages API we use; the other
 * clients ignore it (the OCR route gates PDFs to Anthropic providers).
 */
export interface CompletionDocument {
  mediaType: "application/pdf";
  /** Raw PDF bytes, base64-encoded (no data-URL prefix). */
  dataBase64: string;
}

export interface CompletionParams {
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
  maxTokens?: number;
  /**
   * v1.18.9 — optional vision inputs (Lab-OCR). Additive: every text-only
   * caller (Coach, status cards, insights, narratives) leaves these unset, so
   * the existing wire shape and streaming path are untouched. A client that
   * cannot read images/documents ignores the field. Treat the contents as
   * UNTRUSTED data to transcribe — never as instructions.
   */
  images?: CompletionImage[];
  /**
   * v1.18.9 — optional PDF document input (Lab-OCR). Anthropic-only; other
   * clients ignore it. Mutually informative with `images` — the OCR route
   * sends one or the other depending on the upload type and provider.
   */
  documents?: CompletionDocument[];
  /**
   * Optional deterministic seed. Threaded onto the OpenAI and local
   * (Ollama / OpenAI-compatible) request bodies for reproducible output on
   * the reference surfaces (status cards + period narrative). Anthropic's
   * Messages API has no seed knob, so the Anthropic client ignores it.
   */
  seed?: number;
  /**
   * v1.18.7 — opt the structured (JSON) surfaces into the provider's
   * strongest JSON-reliability mode. When `"json"`:
   *   - local (Ollama / OpenAI-compatible): adds `format: "json"`.
   *   - Anthropic: prefills the assistant turn with `{` so the first token
   *     is forced into a JSON object.
   * The OpenAI client already pins `response_format: json_object`
   * unconditionally and is unaffected. The Coach (prose, NOT JSON) leaves
   * this unset, so its streaming path is untouched.
   */
  responseFormat?: "json";
}

export interface CompletionResult {
  content: string;
  tokensUsed: number | null;
  model: string;
  providerType: ProviderType;
}
