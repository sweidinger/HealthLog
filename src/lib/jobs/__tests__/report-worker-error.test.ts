/**
 * v1.15.20 — unit tests for the central worker-error reporter.
 *
 * Pins the contract: stderr + GlitchTip with the api-handler redaction,
 * disabled-settings short-circuit, and the never-throws guarantee.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getGlitchtipSettings = vi.fn();
const sendGlitchtipEvent = vi.fn();

vi.mock("@/lib/monitoring-settings", () => ({
  getGlitchtipSettings: (...a: unknown[]) => getGlitchtipSettings(...a),
}));
vi.mock("@/lib/monitoring/glitchtip", () => ({
  sendGlitchtipEvent: (...a: unknown[]) => sendGlitchtipEvent(...a),
}));

import { reportWorkerError } from "../report-worker-error";

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  getGlitchtipSettings.mockResolvedValue({
    glitchtipEnabled: true,
    glitchtipDsn: "https://key@glitchtip.example/1",
    glitchtipEnvironment: "test",
  });
  sendGlitchtipEvent.mockResolvedValue({ ok: true });
});

describe("reportWorkerError", () => {
  it("forwards queue-tagged, redacted errors to GlitchTip", async () => {
    await reportWorkerError(
      "insight-pregenerate",
      new Error("provider call failed"),
      { mode: "scheduled" },
    );
    expect(sendGlitchtipEvent).toHaveBeenCalledTimes(1);
    const { dsn, input } = sendGlitchtipEvent.mock.calls[0][0];
    expect(dsn).toBe("https://key@glitchtip.example/1");
    expect(input.message).toBe(
      "[insight-pregenerate] provider call failed (mode=scheduled)",
    );
    expect(input.level).toBe("error");
    expect(input.sourceTag).toBe("healthlog-worker");
    expect(input.environment).toBe("test");
  });

  it("redacts secret-shaped material from the message", async () => {
    await reportWorkerError(
      "insight-status-generate",
      new Error("upstream rejected Bearer sk-abcdef1234567890abcdef"),
    );
    const { input } = sendGlitchtipEvent.mock.calls[0][0];
    expect(input.message).not.toContain("sk-abcdef1234567890abcdef");
  });

  it("still writes stderr when GlitchTip is disabled", async () => {
    getGlitchtipSettings.mockResolvedValue({
      glitchtipEnabled: false,
      glitchtipDsn: null,
    });
    await reportWorkerError("drain-cumulative", new Error("boom"));
    expect(sendGlitchtipEvent).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalled();
  });

  it("never throws — a sink failure cannot mask the handler error", async () => {
    sendGlitchtipEvent.mockRejectedValue(new Error("glitchtip down"));
    await expect(
      reportWorkerError("period-narrative-warm", new Error("boom")),
    ).resolves.toBeUndefined();
  });

  it("wraps non-Error inputs", async () => {
    await reportWorkerError("mean-consolidation", "string failure");
    const { input } = sendGlitchtipEvent.mock.calls[0][0];
    expect(input.message).toBe("[mean-consolidation] string failure");
  });
});
