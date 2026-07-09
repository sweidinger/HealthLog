// Hero spacing screenshot harness (WQHD) — uncommitted, repo root for module resolution.
import { chromium } from "@playwright/test";
import {
  buildMockSnapshot,
  LONG_HEADLINE_BRIEFING,
  MOCK_SCORE_RINGS,
} from "./e2e/utils/mock-dashboard-snapshot.ts";

const OUT =
  process.env.OUT_DIR ??
  "/private/tmp/claude-501/-Users-marc-Projects-HealthLog/78b12842-5404-4de0-9a00-4fdac6a4a7ed/scratchpad/hero";
const TAG = process.env.TAG ?? "before";

import { existsSync } from "node:fs";
const STATE = `${OUT}/state.json`;
const browser = await chromium.launch();
const ctxOpts = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 1,
};
let ctx;
if (existsSync(STATE)) {
  ctx = await browser.newContext({ ...ctxOpts, storageState: STATE });
} else {
  ctx = await browser.newContext(ctxOpts);
  const login = await ctx.request.post("http://localhost:3000/api/auth/login", {
    data: { email: "e2e@healthlog.test", password: "ZJ4hN8x!Pq3vMr2C" },
  });
  if (login.status() !== 200)
    throw new Error(`login failed: ${login.status()} ${await login.text()}`);
  await ctx.storageState({ path: STATE });
}
const page = await ctx.newPage();

const snapshot = buildMockSnapshot({
  heroVisible: true,
  briefing: LONG_HEADLINE_BRIEFING,
  scoreRings: MOCK_SCORE_RINGS,
});
snapshot.user.username = "Marc";
snapshot.healthScore = { score: 78, band: "green", components: [] };

await page.route(/\/api\/dashboard\/snapshot(\?|$)/, (route) =>
  route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ data: snapshot, error: null }),
  }),
);

page.on("response", (r) => {
  if (r.url().includes("dashboard/snapshot"))
    console.log("SNAPSHOT RESPONSE:", r.status(), r.url());
});
await page.goto("http://localhost:3000/");
await page
  .waitForSelector('[data-verdict-variant], [data-slot="dashboard-hero"]', {
    timeout: 20000,
  })
  .catch(() => {});
await page.waitForTimeout(1500);
console.log(
  "BODY SLOTS:",
  await page.evaluate(() =>
    Array.from(document.querySelectorAll("[data-slot]"))
      .slice(0, 12)
      .map((e) => e.getAttribute("data-slot")),
  ),
);
console.log("URL:", page.url());

const hero = page.locator('[data-slot="dashboard-hero"]').first();
const heroBox = await hero.boundingBox().catch(() => null);
await page.screenshot({ path: `${OUT}/${TAG}-full-390.png` });
if (heroBox) {
  await page.screenshot({
    path: `${OUT}/${TAG}-hero-390.png`,
    clip: {
      x: Math.max(0, heroBox.x - 8),
      y: Math.max(0, heroBox.y - 8),
      width: Math.min(390, heroBox.width + 16),
      height: heroBox.height + 16,
    },
  });
}

// Geometry: paddings of the hero card + ring row gaps + greeting offset
const geo = await page.evaluate(() => {
  const hero = document.querySelector('[data-slot="dashboard-hero"]');
  if (!hero) return { error: "no hero" };
  const hb = hero.getBoundingClientRect();
  const cs = getComputedStyle(hero);
  const first = hero.firstElementChild?.getBoundingClientRect();
  const kids = Array.from(hero.querySelectorAll("*"));
  // ring row: element containing multiple svg rings
  const rings = kids
    .filter((el) => el.querySelectorAll?.("svg circle").length >= 2)
    .pop();
  const ringBox = rings?.getBoundingClientRect();
  const ringKids = rings
    ? Array.from(rings.children).map((c) => c.getBoundingClientRect())
    : [];
  const gaps = [];
  for (let i = 1; i < ringKids.length; i++)
    gaps.push(
      Math.round(ringKids[i].x - (ringKids[i - 1].x + ringKids[i - 1].width)),
    );
  const greeting = kids.find(
    (el) =>
      /Willkommen|willkommen|Hallo/.test(el.textContent || "") &&
      el.children.length === 0,
  );
  const gB = greeting?.getBoundingClientRect();
  // lowest content bottom inside hero
  let maxBottom = 0;
  kids.forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.height > 0 && r.bottom > maxBottom && r.bottom <= hb.bottom + 1)
      maxBottom = r.bottom;
  });
  let minTop = Infinity;
  kids.forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.height > 0 && r.top < minTop && r.top >= hb.top - 1) minTop = r.top;
  });
  return {
    heroPadding: {
      t: cs.paddingTop,
      r: cs.paddingRight,
      b: cs.paddingBottom,
      l: cs.paddingLeft,
    },
    contentInsets: {
      top: Math.round(minTop - hb.top),
      bottom: Math.round(hb.bottom - maxBottom),
    },
    ringGaps: gaps,
    ringRow: ringBox
      ? {
          top: Math.round(ringBox.top - hb.top),
          right: Math.round(hb.right - ringBox.right),
        }
      : null,
    greetingTopInHero: gB ? Math.round(gB.top - hb.top) : null,
    heroSize: { w: Math.round(hb.width), h: Math.round(hb.height) },
  };
});
console.log(JSON.stringify(geo, null, 1));

await browser.close();
