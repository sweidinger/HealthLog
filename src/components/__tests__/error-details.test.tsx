import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// `<ErrorDetails>` is a client component used by every Next.js `error.tsx`
// boundary. It surfaces the error message plus a copy-to-clipboard diagnostic
// payload — and, since v1.23, no longer links out to a bug-report surface.

import { I18nProvider } from "@/lib/i18n/context";
import { ErrorDetails } from "../error-details";

function render() {
  const error = Object.assign(new Error("test failure"), {
    digest: "abc123",
  });
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <ErrorDetails error={error} />
    </I18nProvider>,
  );
}

describe("<ErrorDetails>", () => {
  it("renders the error message", () => {
    const html = render();
    expect(html).toContain("test failure");
  });

  it("does not link out to a bug-report surface", () => {
    const html = render();
    expect(html).not.toContain('href="/bugreport"');
  });
});
