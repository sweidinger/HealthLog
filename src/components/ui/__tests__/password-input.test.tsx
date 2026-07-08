import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import { PasswordInput } from "../password-input";

/**
 * PasswordInput bakes the password-manager autofill guard in by default so
 * BYOK API keys / webhook secrets / ntfy tokens (config secrets, not
 * credentials) are never offered up to Bitwarden / 1Password / LastPass.
 * Credential fields that pass a real autocomplete token keep manager
 * integration.
 */
function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">{node}</I18nProvider>,
  );
}

describe("PasswordInput", () => {
  it("suppresses password managers by default for config secrets", () => {
    const html = render(<PasswordInput id="ntfy-token" />);
    expect(html).toMatch(/autocomplete="off"/i);
    expect(html).toContain("data-bwignore");
    expect(html).toContain("data-1p-ignore");
    expect(html).toContain('data-lpignore="true"');
  });

  it("treats an explicit autoComplete=off as a config secret too", () => {
    const html = render(<PasswordInput id="tg-token" autoComplete="off" />);
    expect(html).toContain("data-bwignore");
    expect(html).toContain("data-1p-ignore");
  });

  it("keeps manager integration for credential fields", () => {
    const html = render(
      <PasswordInput id="current-password" autoComplete="current-password" />,
    );
    expect(html).toMatch(/autocomplete="current-password"/i);
    expect(html).not.toContain("data-bwignore");
    expect(html).not.toContain("data-1p-ignore");
    expect(html).not.toContain("data-lpignore");
  });
});
