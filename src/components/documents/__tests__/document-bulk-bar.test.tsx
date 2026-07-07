import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * The floating bulk bar, pinned via single-pass static renders: a labelled
 * toolbar carrying the selected count and the four bulk verbs. The
 * link-condition menu only renders when the account actually has episodes
 * to link — no dead affordance on an episode-free account.
 */
import { I18nProvider } from "@/lib/i18n/context";
import { DocumentBulkBar } from "../document-bulk-bar";

function render(episodes: { id: string; label: string }[]) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <DocumentBulkBar
        selectedCount={3}
        episodes={episodes}
        busy={false}
        onSetKind={() => {}}
        onLinkEpisode={() => {}}
        onDelete={() => {}}
        onClear={() => {}}
      />
    </I18nProvider>,
  );
}

describe("<DocumentBulkBar>", () => {
  it("renders a labelled toolbar with count and the bulk verbs", () => {
    const html = render([{ id: "ep1", label: "Knee" }]);
    expect(html).toContain('data-slot="document-bulk-bar"');
    expect(html).toContain('role="toolbar"');
    expect(html).toContain("3 selected");
    expect(html).toContain("Change type");
    expect(html).toContain("Link condition");
    expect(html).toContain("Delete");
    expect(html).toContain("Clear selection");
  });

  it("omits the link-condition verb when the account has no episodes", () => {
    const html = render([]);
    expect(html).not.toContain("Link condition");
    expect(html).toContain("Change type");
  });
});
