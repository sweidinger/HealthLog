#!/usr/bin/env node
/**
 * v1.4.19 A2 — pre-fix mobile chart audit against PROD.
 *
 * Captures header layout + x-axis tick density for all chart cards
 * across 4 mobile viewports. Output: per-viewport screenshots +
 * machine-readable findings file.
 */
import { chromium } from "@playwright/test";
import { writeFileSync, mkdirSync } from "node:fs";

const SESSION = "cmox4d6fj000101p8w9ykhcnm";
const ORIGIN = "https://healthlog.bombeck.io";
const OUTDIR = "/tmp/v1419-a2-prod";
mkdirSync(OUTDIR, { recursive: true });

const VIEWPORTS = [
  { name: "pixel5", width: 393, height: 851, deviceScale: 2.75 },
  { name: "iphone12", width: 390, height: 844, deviceScale: 3 },
  { name: "iphone-se", width: 375, height: 667, deviceScale: 2 },
  { name: "fold-compact", width: 280, height: 653, deviceScale: 3 },
];

const PAGES = [
  { path: "/", label: "dashboard" },
  { path: "/insights", label: "insights" },
];

const browser = await chromium.launch();
const findings = {};

for (const vp of VIEWPORTS) {
  findings[vp.name] = {};
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    userAgent:
      "Mozilla/5.0 (Linux; Android 11; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0 Mobile Safari/537.36",
    deviceScaleFactor: vp.deviceScale,
    hasTouch: true,
    isMobile: true,
    colorScheme: "dark",
    storageState: {
      cookies: [
        {
          name: "healthlog_session",
          value: SESSION,
          domain: "healthlog.bombeck.io",
          path: "/",
          httpOnly: true,
          secure: true,
          sameSite: "Lax",
          expires: -1,
        },
      ],
      origins: [],
    },
  });

  for (const pg of PAGES) {
    const page = await ctx.newPage();
    page.on("console", () => {});
    page.on("pageerror", () => {});
    try {
      await page.goto(`${ORIGIN}${pg.path}`, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
      // Wait for at least one chart card or main content
      await page
        .waitForSelector("main, [data-slot=medication-compliance-chart], svg", {
          timeout: 15000,
        })
        .catch(() => {});
      await page.waitForTimeout(2500);

      // Scroll to make sure all charts render
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(500);

      const screenshotPath = `${OUTDIR}/${pg.label}-${vp.name}.png`;
      await page.screenshot({ path: screenshotPath, fullPage: true });

      // Find all chart cards
      const data = await page.evaluate(() => {
        const cards = Array.from(
          document.querySelectorAll(
            "div[data-slot=medication-compliance-chart], [data-slot=chart-mini], div.bg-card",
          ),
        ).filter((el) => el.querySelector("svg") !== null);

        const out = [];
        for (const card of cards) {
          const rect = card.getBoundingClientRect();
          if (rect.height < 100) continue;

          // Find header row + check overflow
          const titleEl = card.querySelector("h3, [data-slot=card-title]");
          const title = titleEl?.textContent?.trim() ?? "(unknown)";
          const titleRect = titleEl?.getBoundingClientRect();

          // Range tabs — use data-slot when present; fall back to
          // text-content sniffing for charts that haven't been
          // tagged yet.
          const taggedTabs = Array.from(
            card.querySelectorAll("[data-slot=chart-range-tab]"),
          );
          const sniffedTabs = Array.from(
            card.querySelectorAll("button"),
          ).filter((b) =>
            /^(7|30|90)\s*(T|Pkt|pts)$|^Alle$|^All$|^(7|30|90)D$/i.test(
              (b.textContent ?? "").trim(),
            ),
          );
          const rangeTabs = taggedTabs.length > 0 ? taggedTabs : sniffedTabs;
          const tabRects = rangeTabs.map((b) => {
            const r = b.getBoundingClientRect();
            return {
              text: b.textContent?.trim(),
              top: r.top,
              right: r.right,
              width: r.width,
            };
          });
          const tabTops = new Set(tabRects.map((t) => Math.round(t.top)));

          // Header bar height
          const headerEl = card.querySelector(".mb-4, .pb-2");
          const headerRect = headerEl?.getBoundingClientRect();

          // Check overflow
          const overflowsHorizontally = card.scrollWidth > card.clientWidth + 1;

          // X-axis ticks
          const xTicks = Array.from(
            card.querySelectorAll(
              ".recharts-xAxis .recharts-cartesian-axis-tick-value",
            ),
          ).map((t) => t.textContent?.trim());

          out.push({
            title,
            cardRect: {
              top: rect.top,
              height: rect.height,
              width: rect.width,
            },
            titleTop: titleRect?.top,
            tabs: tabRects,
            tabUniqueRows: tabTops.size,
            overflowsHorizontally,
            cardScrollWidth: card.scrollWidth,
            cardClientWidth: card.clientWidth,
            headerHeight: headerRect?.height,
            xTickCount: xTicks.length,
            xTicks,
          });
        }
        return out;
      });

      findings[vp.name][pg.label] = {
        screenshot: screenshotPath,
        cards: data,
      };
    } catch (err) {
      findings[vp.name][pg.label] = { error: String(err) };
    }
    await page.close();
  }
  await ctx.close();
}

await browser.close();

writeFileSync(`${OUTDIR}/findings.json`, JSON.stringify(findings, null, 2));
console.log("---PROD-AUDIT-COMPLETE---");
console.log(JSON.stringify(findings, null, 2));
