import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import {
  TargetAdjustProvider,
  useTargetAdjust,
} from "../target-adjust-context";

/**
 * Target-adjust context smoke contract.
 *
 * The project's test convention is `renderToStaticMarkup` (no
 * `@testing-library/react` dependency), so we assert the SSR-observable
 * surface — interaction (register / requestAdjust opening the sheet)
 * runs in effects + state and is covered by the component-level
 * behaviour. Here we pin:
 *   1. The hook returns `null` outside the provider, so the header gear
 *      degrades to rendering nothing rather than crashing.
 *   2. The hook exposes the full shape beneath the provider, with
 *      `canAdjust` starting false (no target registered yet).
 *   3. The provider renders its children and mounts no editor sheet at
 *      rest (nothing is open).
 */

function Probe({ output }: { output: string[] }) {
  const adjust = useTargetAdjust();
  if (!adjust) {
    output.push("null");
    return null;
  }
  output.push(
    JSON.stringify({
      hasRegister: typeof adjust.register,
      hasRequestAdjust: typeof adjust.requestAdjust,
      canAdjust: adjust.canAdjust,
    }),
  );
  return <span data-slot="probe-output">{output.join(",")}</span>;
}

describe("TargetAdjustProvider", () => {
  it("returns null when consumed outside the provider", () => {
    const output: string[] = [];
    renderToStaticMarkup(<Probe output={output} />);
    expect(output).toEqual(["null"]);
  });

  it("exposes the full context shape with canAdjust false at rest", () => {
    const output: string[] = [];
    renderToStaticMarkup(
      <TargetAdjustProvider>
        <Probe output={output} />
      </TargetAdjustProvider>,
    );
    expect(output).toHaveLength(1);
    const parsed = JSON.parse(output[0]);
    expect(parsed.hasRegister).toBe("function");
    expect(parsed.hasRequestAdjust).toBe("function");
    expect(parsed.canAdjust).toBe(false);
  });

  it("renders children and mounts no editor sheet at rest", () => {
    const html = renderToStaticMarkup(
      <TargetAdjustProvider>
        <div data-slot="child-mount">child</div>
      </TargetAdjustProvider>,
    );
    expect(html).toContain('data-slot="child-mount"');
    expect(html).not.toContain('data-slot="target-edit-sheet"');
  });
});
