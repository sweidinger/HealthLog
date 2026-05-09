import { describe, it, expect, afterEach, vi } from "vitest";

import { prefersReducedMotion } from "../reduced-motion";

describe("prefersReducedMotion()", () => {
  const originalWindow = globalThis.window;

  afterEach(() => {
    if (originalWindow === undefined) {
      // @ts-expect-error — restore SSR-default state.
      delete globalThis.window;
    } else {
      globalThis.window = originalWindow;
    }
  });

  it("returns false on the server (no window)", () => {
    // @ts-expect-error — explicit SSR-environment shape.
    delete globalThis.window;
    expect(prefersReducedMotion()).toBe(false);
  });

  it("returns the matchMedia matches flag in the browser", () => {
    const matchMedia = vi.fn(() => ({
      matches: true,
      media: "(prefers-reduced-motion: reduce)",
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    // @ts-expect-error — synthesise window for the test.
    globalThis.window = { matchMedia };
    expect(prefersReducedMotion()).toBe(true);
    expect(matchMedia).toHaveBeenCalledWith("(prefers-reduced-motion: reduce)");
  });

  it("returns false when matchMedia throws", () => {
    // @ts-expect-error — synthesise window.
    globalThis.window = {
      matchMedia: () => {
        throw new Error("legacy browser");
      },
    };
    expect(prefersReducedMotion()).toBe(false);
  });

  it("returns false when matchMedia is missing on the window", () => {
    // @ts-expect-error — synthesise window without matchMedia.
    globalThis.window = {};
    expect(prefersReducedMotion()).toBe(false);
  });
});
