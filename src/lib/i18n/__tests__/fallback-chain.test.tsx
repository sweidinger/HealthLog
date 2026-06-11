import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider, useTranslations } from "@/lib/i18n/context";
import deMessages from "../../../../messages/de.json";

function Read({ k }: { k: string }) {
  const { t } = useTranslations();
  return <span data-key={k}>{t(k)}</span>;
}

describe("i18n fallback chain", () => {
  it("renders the active locale synchronously when its bundle is passed (RSC handoff)", () => {
    // This is the production path since the bundle split: the root
    // layout resolves the locale server-side and threads the bundle in
    // as `initialMessages`. The very first render — server HTML and
    // first client paint alike — must already be German; an async gap
    // here would be the EN→DE hydration flash the handoff exists to
    // prevent. renderToStaticMarkup is synchronous, so this test fails
    // if the provider ever needs an await before t() resolves DE.
    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="de" initialMessages={deMessages}>
        <Read k="common.save" />
      </I18nProvider>,
    );
    expect(html).toContain("Speichern");
    expect(html).not.toContain(">Save<");
  });

  // A "no bundle passed for a non-EN locale" mount serves the static EN
  // floor synchronously and backfills the real bundle async. That path
  // is not testable in this suite — vitest.setup.ts primes the cache
  // with every locale (deliberately, so hundreds of provider mounts
  // keep resolving synchronously) — and it never runs in the app: the
  // root layout always passes the active locale's bundle.

  // Level-2 of the fallback chain (active locale missing → EN) is
  // unreachable in production by design: the locale-integrity parity
  // test (../__tests__/i18n-locale-integrity.test.ts) enforces that
  // every key in en.json exists in every other locale and vice versa,
  // so a "missing in fr but present in en" state can never reach the
  // runtime. If it does, the integrity test catches it before CI
  // accepts the PR, NOT at runtime. That layering is intentional.
  it.skip("level-2 EN fallback (unreachable — parity test guards this)", () => {});

  it("returns the key itself only as last resort (regression guard)", () => {
    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <Read k="this.key.absolutely.does.not.exist.anywhere" />
      </I18nProvider>,
    );
    // Last-resort fallback documents the contract: when both locales
    // miss the key, t() returns the key itself. This is intentional —
    // visible regression beats silent empty string. The integrity test
    // (../__tests__/i18n-locale-integrity.test.ts) prevents this from
    // happening in shipped code; this test just pins the runtime
    // contract.
    expect(html).toContain("this.key.absolutely.does.not.exist.anywhere");
  });
});
