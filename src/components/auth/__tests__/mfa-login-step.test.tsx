/**
 * MfaLoginStep rendering — the second step of login shown when the password
 * response carried `meta.mfaRequired`. Pins which controls render for each
 * factor mix (TOTP+recovery, TOTP+webauthn, webauthn-only).
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/lib/i18n/context", () => ({
  useTranslations: () => ({ t: (key: string) => key }),
}));

import { MfaLoginStep } from "../mfa-login-step";

function render(methods: ("totp" | "recovery" | "webauthn")[]) {
  return renderToStaticMarkup(
    <MfaLoginStep
      mfaTicket="ticket-1"
      methods={methods}
      onSuccess={() => {}}
      onCancel={() => {}}
    />,
  );
}

describe("MfaLoginStep", () => {
  it("renders the code entry + recovery toggle for a TOTP account", () => {
    const html = render(["totp", "recovery"]);
    expect(html).toContain("mfa-login-step");
    expect(html).toContain("auth.mfa.codeLabel");
    expect(html).toContain("auth.mfa.verify");
    expect(html).toContain("auth.mfa.useRecoveryCode");
    // No security-key button when the account has no registered key.
    expect(html).not.toContain("auth.mfa.useSecurityKey");
  });

  it("renders the security-key button alongside TOTP when both are available", () => {
    const html = render(["totp", "recovery", "webauthn"]);
    expect(html).toContain("auth.mfa.codeLabel");
    expect(html).toContain("auth.mfa.useSecurityKey");
  });

  it("leads with the security key for a WebAuthn-only account", () => {
    const html = render(["webauthn"]);
    expect(html).toContain("auth.mfa.useSecurityKey");
    // No code form and no recovery toggle without TOTP.
    expect(html).not.toContain("auth.mfa.codeLabel");
    expect(html).not.toContain("auth.mfa.useRecoveryCode");
  });

  it("always offers a way back to the password step", () => {
    expect(render(["totp"])).toContain("auth.mfa.backToLogin");
  });
});
