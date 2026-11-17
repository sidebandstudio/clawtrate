// The browser the checks drive: Chromium from the repository's own Playwright.
// Run `pnpm install` and `pnpm exec playwright install chromium` once.
import { createRequire } from "node:module";

const require = createRequire(new URL("../../../../../package.json", import.meta.url));
export const { chromium } = require("@playwright/test");

/** The prototype's pages, opened from disk. No server and no network. */
export const pageUrl = (name) => new URL(`../../${name}`, import.meta.url).href;
