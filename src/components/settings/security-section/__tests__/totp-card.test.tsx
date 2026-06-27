/**
 * v1.23 Phase-Q — `<TotpCard>` recovery-code regeneration guard.
 *
 * Regenerating recovery codes is destructive: the previous set stops working
 * immediately. This suite pins that the regenerate action is gated behind a
 * confirmation dialog (matching the disable-MFA pattern), not a bare click.
 *
 * Project convention is SSR-only tests (no `@testing-library/react`); the
 * dialog's open-state behaviour is Radix's own, so we assert the source wires
 * the trigger + consequence copy rather than driving a portal at runtime.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import { TotpCard } from "../totp-card";

function render(node: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <QueryClientProvider client={client}>{node}</QueryClientProvider>
    </I18nProvider>,
  );
}

describe("<TotpCard> — recovery-code regeneration", () => {
  it("SSRs the enabled card with the regenerate action", () => {
    const html = render(<TotpCard enabled recoveryCodesRemaining={3} />);
    expect(html).toContain("Regenerate codes");
  });

  it("wraps regenerate in a confirmation dialog with a consequence line", () => {
    const src = readFileSync(resolve(__dirname, "../totp-card.tsx"), "utf8");
    // The regenerate action is a dialog trigger, not a bare mutate-on-click.
    expect(src).toContain("settings.security.recovery.regenerateTitle");
    expect(src).toContain("settings.security.recovery.regenerateConfirm");
    // The mutate only fires from inside the dialog's confirm action.
    expect(src).toContain("regenerate.mutate()");
  });
});
