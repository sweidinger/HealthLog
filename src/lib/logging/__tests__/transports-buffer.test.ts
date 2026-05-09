import { describe, expect, it, beforeEach, vi, afterEach } from "vitest";
import {
  clearLogBuffer,
  readLogBuffer,
  getLogBufferSize,
} from "../in-memory-buffer";
import { emitEvent } from "../transports";
import { resetLoggingConfig } from "../config";
import type { WideEvent } from "../types";

function makeEvent(overrides: Partial<WideEvent> = {}): WideEvent {
  return {
    timestamp: new Date().toISOString(),
    duration_ms: 42,
    request_id: "req-buf-test",
    trace_id: "trace-buf-test",
    level: "info",
    kind: "http",
    service: "healthlog",
    environment: "test",
    ...overrides,
  };
}

describe("emitEvent → in-memory buffer wiring", () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    clearLogBuffer();
    resetLoggingConfig();
    // Suppress the JSON line so the test runner stays readable.
    stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
  });

  it("pushes the emitted event into the in-memory buffer", () => {
    expect(getLogBufferSize()).toBe(0);
    emitEvent(makeEvent({ trace_id: "trace-A" }));
    emitEvent(makeEvent({ trace_id: "trace-B" }));
    expect(getLogBufferSize()).toBe(2);
    const events = readLogBuffer({});
    // Newest-first: trace-B was pushed second.
    expect(events[0].trace_id).toBe("trace-B");
    expect(events[1].trace_id).toBe("trace-A");
  });

  it("still writes to stdout (transport contract preserved)", () => {
    emitEvent(makeEvent());
    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    const arg = stdoutSpy.mock.calls[0][0];
    expect(typeof arg).toBe("string");
    expect(arg as string).toContain("trace-buf-test");
  });
});
