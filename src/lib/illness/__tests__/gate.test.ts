/**
 * v1.18.1 — illness route gate.
 *
 * `requireIllnessEnabled` delegates to the module gate but re-stamps the
 * illness-specific errorCode. Asserts the enabled pass, the disabled 403
 * envelope shape, and that `isIllnessEnabled` mirrors `isModuleEnabled`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const moduleGate = vi.hoisted(() => ({
  isModuleEnabled: vi.fn(),
  requireModuleEnabled: vi.fn(),
}));

vi.mock("@/lib/modules/gate", () => moduleGate);

import {
  ILLNESS_DISABLED_ERROR_CODE,
  isIllnessEnabled,
  requireIllnessEnabled,
} from "@/lib/illness/gate";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("isIllnessEnabled", () => {
  it("delegates to isModuleEnabled('illness')", async () => {
    moduleGate.isModuleEnabled.mockResolvedValue(true);
    await expect(isIllnessEnabled("u1")).resolves.toBe(true);
    expect(moduleGate.isModuleEnabled).toHaveBeenCalledWith("u1", "illness");
  });
});

describe("requireIllnessEnabled", () => {
  it("passes when the module gate passes", async () => {
    moduleGate.requireModuleEnabled.mockResolvedValue({ enabled: true });
    const gate = await requireIllnessEnabled("u1");
    expect(gate.enabled).toBe(true);
  });

  it("returns a 403 with the illness errorCode when disabled", async () => {
    moduleGate.requireModuleEnabled.mockResolvedValue({
      enabled: false,
      response: new Response(null, { status: 403 }),
    });
    const gate = await requireIllnessEnabled("u1");
    expect(gate.enabled).toBe(false);
    if (gate.enabled) throw new Error("expected disabled");
    expect(gate.response.status).toBe(403);
    const body = await gate.response.json();
    expect(body.meta.errorCode).toBe(ILLNESS_DISABLED_ERROR_CODE);
    expect(body.meta.module).toBe("illness");
  });
});
