/**
 * v1.11.5 — QoL-Lows coverage for the mood form + list fixes.
 *
 * Project convention is SSR-only component tests (`renderToStaticMarkup`,
 * no `@testing-library/react`) plus source-string structural assertions
 * for the interactive plumbing that an SSR mount can't exercise. The
 * three fixes pinned here:
 *
 *   1. `<MoodList>` — the delete mutation surfaces a toast on failure
 *      (it previously had no `onError`, so a rejected DELETE was silent).
 *   2. `<MoodForm>` — Reset confirms first when the form holds typed
 *      input, and resets immediately when pristine.
 *   3. `<MoodForm>` — the note field shows a live character counter so
 *      the `maxLength` cap no longer truncates without feedback.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import { MoodForm } from "../mood-form";

function renderForm(footerSlot: HTMLElement | null = null): string {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: 0 } },
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale="en">
        <MoodForm footerSlot={footerSlot} />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

const formSrc = readFileSync(
  resolve(__dirname, "../mood-form.tsx"),
  "utf8",
);
const listSrc = readFileSync(
  resolve(__dirname, "../mood-list.tsx"),
  "utf8",
);

describe("MoodForm — note character counter (v1.11.5)", () => {
  it("renders the counter at 0/500 for a pristine form", () => {
    const html = renderForm();
    expect(html).toContain('data-testid="mood-note-counter"');
    expect(html).toContain("0/500");
  });

  it("ties the textarea cap to the shared NOTE_MAX_LENGTH constant", () => {
    expect(formSrc).toContain("const NOTE_MAX_LENGTH = 500");
    expect(formSrc).toContain("maxLength={NOTE_MAX_LENGTH}");
    // The counter reads off `note.length` against the same constant.
    expect(formSrc).toContain('t("mood.noteCharCount"');
    expect(formSrc).toMatch(/note\.length >= NOTE_MAX_LENGTH/);
  });
});

describe("MoodForm — Reset confirm when dirty (v1.11.5)", () => {
  it("detects dirty from the content fields, not the auto-filled timestamp", () => {
    // `isDirty` must exclude `moodLoggedAt` (always populated) so a
    // freshly opened form does not falsely warn on Reset.
    expect(formSrc).toMatch(/const isDirty =\s*\n?\s*mood !== ""/);
    expect(formSrc).toContain('tagsInput.trim() !== ""');
    expect(formSrc).toContain("tagKeys.length > 0");
    expect(formSrc).toContain('note.trim() !== ""');
    // The `isDirty` expression itself must not read `moodLoggedAt`.
    const isDirtyExpr = formSrc.slice(
      formSrc.indexOf("const isDirty ="),
      formSrc.indexOf('note.trim() !== ""') + 'note.trim() !== ""'.length,
    );
    expect(isDirtyExpr).not.toContain("moodLoggedAt");
  });

  it("routes Reset through requestReset, which gates the confirm dialog on dirty", () => {
    // The dropdown item calls `requestReset`, not `resetForm` directly.
    expect(formSrc).toContain("onClick={requestReset}");
    expect(formSrc).toMatch(
      /function requestReset\(\) \{[\s\S]*if \(isDirty\) \{[\s\S]*setResetConfirmOpen\(true\)/,
    );
    // A pristine form resets immediately (nothing to lose).
    expect(formSrc).toMatch(/if \(isDirty\) \{[\s\S]*\} else \{[\s\S]*resetForm\(\)/);
  });

  it("mounts the confirm AlertDialog wired to resetForm on the destructive action", () => {
    expect(formSrc).toContain('t("mood.formResetConfirmTitle")');
    expect(formSrc).toContain('t("mood.formResetConfirmBody")');
    expect(formSrc).toContain('t("mood.formResetConfirmAction")');
    expect(formSrc).toMatch(/<AlertDialogAction[\s\S]*onClick={resetForm}/);
  });
});

describe("MoodList — delete failure toast (v1.11.5)", () => {
  it("surfaces a toast on a rejected delete instead of failing silently", () => {
    expect(listSrc).toContain('import { toast } from "sonner"');
    expect(listSrc).toMatch(
      /deleteMutation = useMutation\(\{[\s\S]*onError: \(\) => \{[\s\S]*toast\.error\(t\("mood\.deleteError"\)\)/,
    );
  });
});
