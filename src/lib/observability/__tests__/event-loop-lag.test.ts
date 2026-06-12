import { afterEach, describe, expect, it, vi } from "vitest";

import {
  EVENT_LOOP_LAG_GLOBAL,
  eventLoopLagSnapshot,
  startEventLoopLagMonitor,
} from "../event-loop-lag";

/**
 * The monitor's job is self-documentation of process stalls: a tick
 * that fires late because the loop was blocked must (a) publish the lag
 * on the global slot every wide event reads, and (b) emit the dedicated
 * stall callback when the lag crosses the threshold. The loop is
 * blocked for real (busy-wait) — fake timers would defeat the thing
 * being measured.
 */

const STARTED = Symbol.for("healthlog.eventLoopLag.started");

type Slots = {
  [EVENT_LOOP_LAG_GLOBAL]?: unknown;
  [STARTED]?: boolean;
};

function resetMonitorGlobals() {
  const slots = globalThis as unknown as Slots;
  delete slots[EVENT_LOOP_LAG_GLOBAL];
  delete slots[STARTED];
}

function blockLoopFor(ms: number) {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    // busy-wait — a deliberate, real event-loop stall
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterEach(() => {
  resetMonitorGlobals();
});

describe("event-loop lag monitor", () => {
  it("publishes the lag and reports a stall crossing the threshold", async () => {
    resetMonitorGlobals();
    const stalls: Array<{ lag_ms: number }> = [];
    startEventLoopLagMonitor({
      tickIntervalMs: 25,
      stallThresholdMs: 80,
      emitStall: (s) => stalls.push(s),
    });

    // Let a first tick establish the chain, then block the loop long
    // enough that the next tick fires far past its schedule.
    await sleep(40);
    blockLoopFor(200);
    await sleep(60);

    const snapshot = eventLoopLagSnapshot();
    expect(snapshot).not.toBeNull();
    expect(snapshot!.loop_max_ms).toBeGreaterThanOrEqual(80);
    expect(stalls.length).toBeGreaterThanOrEqual(1);
    expect(stalls[0].lag_ms).toBeGreaterThanOrEqual(80);
  });

  it("stays quiet below the threshold", async () => {
    resetMonitorGlobals();
    const stalls: unknown[] = [];
    startEventLoopLagMonitor({
      tickIntervalMs: 25,
      stallThresholdMs: 5_000,
      emitStall: (s) => stalls.push(s),
    });

    await sleep(80);

    expect(eventLoopLagSnapshot()).not.toBeNull();
    expect(stalls).toHaveLength(0);
  });

  it("is idempotent — a second start never stacks a second timer chain", () => {
    resetMonitorGlobals();
    const setTimeoutSpy = vi.spyOn(global, "setTimeout");
    startEventLoopLagMonitor({ emitStall: () => {} });
    startEventLoopLagMonitor({ emitStall: () => {} });
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
    setTimeoutSpy.mockRestore();
  });
});
