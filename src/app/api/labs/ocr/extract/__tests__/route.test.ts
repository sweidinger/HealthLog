/**
 * v1.20.1 — POST /api/labs/ocr/extract, TEXT mode.
 *
 * Focus: the text-mode structuring pass reserves the proportionate text budget
 * ceiling (`AI_BUDGETS.ocrExtractText`), not the far larger vision ceiling, and
 * on a clean extraction failure it refunds the reservation in full rather than
 * charging it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/api-handler", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/api-handler")>(
      "@/lib/api-handler",
    );
  return {
    ...actual,
    apiHandler: <T extends (...args: unknown[]) => Promise<Response>>(
      h: T,
    ): T => h,
    requireAuth: vi.fn(),
  };
});

vi.mock("@/lib/db", () => ({
  prisma: { user: { findUnique: vi.fn() } },
}));
vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));
vi.mock("@/lib/labs/ocr-capability", () => ({
  resolveTextProvider: vi.fn(),
  resolveVisionProvider: vi.fn(),
}));
vi.mock("@/lib/ai/consent-guard", () => ({
  assertConsentForChain: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
  rateLimitHeaders: vi.fn(() => ({})),
}));
vi.mock("@/lib/ai/coach/budget", () => ({
  buildDateKey: vi.fn(() => "2026-06-26"),
  reserveBudget: vi.fn(),
  reconcileSpend: vi.fn().mockResolvedValue(undefined),
  resolveDailyCap: vi.fn(() => 200_000),
}));
vi.mock("@/lib/labs/ocr-extract", async () => {
  const actual = await vi.importActual<typeof import("@/lib/labs/ocr-extract")>(
    "@/lib/labs/ocr-extract",
  );
  return { ...actual, runOcrExtraction: vi.fn() };
});

import { POST } from "../route";
import { AI_BUDGETS } from "@/lib/ai/ai-budgets";
import { requireAuth } from "@/lib/api-handler";
import { prisma } from "@/lib/db";
import { resolveTextProvider } from "@/lib/labs/ocr-capability";
import { reserveBudget, reconcileSpend } from "@/lib/ai/coach/budget";
import { OcrExtractError, runOcrExtraction } from "@/lib/labs/ocr-extract";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "tester", role: "USER" as const },
};

function textReq(text = "Glucose 95 mg/dL"): Request {
  return new Request("http://localhost/api/labs/ocr/extract", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "text", text }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAuth).mockResolvedValue(SESSION_OK as never);
  vi.mocked(prisma.user.findUnique).mockResolvedValue({
    labsLocalOcrEnabled: true,
  } as never);
  vi.mocked(resolveTextProvider).mockResolvedValue({
    chain: [{ providerType: "openai", instance: {} as never }],
    pick: {
      entry: { providerType: "openai", instance: {} as never },
      providerType: "openai",
    },
  } as never);
  vi.mocked(reserveBudget).mockResolvedValue({
    allowed: true,
    reserved: AI_BUDGETS.ocrExtractText.maxTokens ?? 0,
    totalAfter: AI_BUDGETS.ocrExtractText.maxTokens ?? 0,
  } as never);
});

describe("POST /api/labs/ocr/extract — text mode budget", () => {
  it("reserves the cheaper text ceiling, not the vision ceiling", async () => {
    vi.mocked(runOcrExtraction).mockResolvedValue({ rows: [] } as never);

    const res = await POST(textReq());
    expect(res.status).toBe(200);

    // The reservation must use the text ceiling — proven distinct from the
    // vision ceiling so a future merge can't silently re-point it.
    expect(AI_BUDGETS.ocrExtractText.maxTokens).toBeLessThan(
      AI_BUDGETS.ocrExtract.maxTokens ?? Infinity,
    );
    expect(reserveBudget).toHaveBeenCalledWith(
      "user-1",
      AI_BUDGETS.ocrExtractText.maxTokens,
      "2026-06-26",
      // F1 — the provider-aware daily cap (mocked) is threaded as the 4th arg.
      200_000,
    );
  });

  it("refunds the reservation in full on a clean extract failure", async () => {
    vi.mocked(runOcrExtraction).mockRejectedValue(
      new OcrExtractError("unreadable"),
    );

    const res = await POST(textReq());
    expect(res.status).toBe(422);

    // actual spend reconciles to 0 — the failed structuring pass is refunded,
    // not charged at the reserved estimate.
    expect(reconcileSpend).toHaveBeenCalledWith(
      "user-1",
      AI_BUDGETS.ocrExtractText.maxTokens,
      0,
      "2026-06-26",
    );
  });
});
