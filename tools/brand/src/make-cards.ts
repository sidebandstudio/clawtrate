// Draws the link previews: the picture a chat app or social site shows for a
// link to clawtrate.dev, and the repository's social preview on GitHub. The
// card is tools/brand/card.html, with the logo and the website's parade of
// Claws in their resting poses, rendered in Playwright's Chromium.
//
//   node tools/brand/src/make-cards.ts      (or: pnpm brand:cards)
//
// Run it again after changing the logo, the card or the parade. GitHub does not
// read its picture from the repository: upload assets/brand/social-github.png in
// the repository's Settings, under Social preview.

import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const CARD = join(ROOT, "tools/brand/card.html");
const SITE = join(ROOT, "site/index.html");

/** Each card and its size: Open Graph's 1200 × 630, and GitHub's 1280 × 640. */
export const CARDS = [
  { path: "site/social.png", width: 1200, height: 630 },
  { path: "assets/brand/social-github.png", width: 1280, height: 640 },
] as const;

/** Where the website serves its card, as each page names it. */
export const SITE_CARD_URL = "https://clawtrate.dev/social.png";

async function main(): Promise<void> {
  // Loaded here, so a test can read CARDS without starting Playwright.
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch();
  try {
    // The site without its scripts shows each Claw at rest.
    const site = await browser.newPage({ javaScriptEnabled: false });
    await site.goto(pathToFileURL(SITE).href);
    const defs = await site.locator(".claw-defs").evaluate((node) => node.outerHTML);
    const cast = await site.locator(".cast").evaluate((node) => node.innerHTML);
    await site.close();

    for (const card of CARDS) {
      const page = await browser.newPage({
        viewport: { width: card.width, height: card.height },
        reducedMotion: "reduce",
      });
      await page.goto(pathToFileURL(CARD).href);
      await page.locator("body").evaluate((body, html) => {
        body.insertAdjacentHTML("afterbegin", html);
      }, defs);
      await page.locator(".cast").evaluate((node, html) => {
        node.innerHTML = html;
      }, cast);
      await page.waitForFunction("document.fonts.status === 'loaded'");
      await page.screenshot({ path: join(ROOT, card.path), type: "png" });
      await page.close();
      console.log(`wrote ${card.path} (${card.width} × ${card.height})`);
    }
  } finally {
    await browser.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
