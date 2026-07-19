import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Destructive settings controls ask first.
 *
 * Signing every other device out, and revoking a trusted device, used to fire
 * on a single tap. Neither is undoable — the other devices simply have to log
 * in again, and a revoked trusted device asks for a second factor next time —
 * while every other destructive surface in the app confirms. On a shared
 * screen a mis-tap is a support call.
 *
 * This reads the sources rather than rendering, because what it pins is
 * structural: that these particular controls route through `ConfirmButton`
 * and never call a revoke mutation straight from an `onClick`. A render test
 * would prove the dialog exists in one arrangement; this proves no control on
 * these cards can go back to firing directly.
 */

const CARDS = [
  {
    file: "security-sessions-card.tsx",
    slots: ["revoke-session", "sign-out-everywhere"],
  },
  {
    file: "trusted-devices-card.tsx",
    slots: ["revoke-trusted-device", "revoke-all-trusted-devices"],
  },
];

function source(file: string) {
  return readFileSync(
    join(process.cwd(), "src", "components", "settings", file),
    "utf8",
  );
}

describe("destructive session controls confirm before firing", () => {
  for (const card of CARDS) {
    describe(card.file, () => {
      const src = source(card.file);

      it("routes every destructive control through ConfirmButton", () => {
        expect(src).toContain("ConfirmButton");
        for (const slot of card.slots) {
          expect(src).toContain(`slot="${slot}"`);
        }
      });

      it("never fires a revoke straight from an onClick", () => {
        // `onConfirm={() => revoke…}` is the confirmed path and is fine;
        // `onClick={() => revoke…}` is the unguarded one this forbids.
        const unguarded = src.match(/onClick=\{\(\) =>\s*revoke/g) ?? [];
        expect(unguarded).toEqual([]);
      });

      it("gives each control its own confirmation body", () => {
        // A shared generic body would let one control's dialog describe
        // another's consequence — the reason the copy is per-control.
        const bodies = src.match(/body=\{t\("([^"]+)"/g) ?? [];
        expect(bodies.length).toBe(card.slots.length);
        expect(new Set(bodies).size).toBe(card.slots.length);
      });
    });
  }
});
