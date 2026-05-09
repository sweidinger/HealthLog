import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// `<ErrorDetails>` is a client component used by every Next.js
// `error.tsx` boundary. It surfaces a "Report bug" link whose
// visibility must mirror the admin's `bugReportEnabled` toggle —
// otherwise the user lands on a `/bugreport` page that immediately
// renders a "Bug reports are disabled" notice.

const mockSettingsRef = { value: { bugReportEnabled: true } };
vi.mock("@/components/app-settings-provider", () => ({
  useAppSettings: () => mockSettingsRef.value,
}));

import { I18nProvider } from "@/lib/i18n/context";
import { ErrorDetails } from "../error-details";

function render({
  bugReportEnabled = true,
}: { bugReportEnabled?: boolean } = {}) {
  mockSettingsRef.value = { bugReportEnabled };
  const error = Object.assign(new Error("test failure"), {
    digest: "abc123",
  });
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <ErrorDetails error={error} />
    </I18nProvider>,
  );
}

describe("<ErrorDetails> bug-report toggle", () => {
  it("shows the Report bug button when the admin flag is enabled", () => {
    const html = render({ bugReportEnabled: true });
    expect(html).toContain('href="/bugreport"');
  });

  it("hides the Report bug button when the admin flag is disabled", () => {
    const html = render({ bugReportEnabled: false });
    expect(html).not.toContain('href="/bugreport"');
  });
});
