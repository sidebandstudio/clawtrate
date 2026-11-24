import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CARDS, SITE_CARD_URL } from "../src/make-cards.ts";
import { MANIFEST_PATH } from "../src/make-icons.ts";

const ROOT = join(MANIFEST_PATH, "../../..");
const PAGES = ["site/index.html", "site/download/mac/index.html"];

/** A PNG's size, from its header. */
function pngSize(file: Buffer): { width: number; height: number } {
  expect(file.subarray(1, 4).toString("latin1")).toBe("PNG");
  return { width: file.readUInt32BE(16), height: file.readUInt32BE(20) };
}

function meta(page: string, key: string): string | undefined {
  const tag = [...page.matchAll(/<meta\s[^>]*>/g)]
    .map((match) => match[0].replace(/\s+/g, " "))
    .find((tag) => tag.includes(`property="${key}"`) || tag.includes(`name="${key}"`));
  return tag?.match(/content="([^"]*)"/)?.[1];
}

describe("link preview cards (run `pnpm brand:cards` to draw them)", () => {
  it("are PNGs of their sizes, the repository's within GitHub's 1 MB", () => {
    for (const card of CARDS) {
      const file = readFileSync(join(ROOT, card.path));
      expect(pngSize(file), card.path).toEqual({ width: card.width, height: card.height });
      expect(file.length, card.path).toBeLessThan(1_000_000);
    }
  });

  it("are what each page of the website names as its preview", () => {
    const card = CARDS.find((card) => card.path === "site/social.png")!;
    expect(SITE_CARD_URL).toBe(`https://clawtrate.dev/${card.path.slice("site/".length)}`);
    for (const path of PAGES) {
      const page = readFileSync(join(ROOT, path), "utf8");
      expect(meta(page, "og:image"), path).toBe(SITE_CARD_URL);
      expect(meta(page, "og:image:width"), path).toBe(String(card.width));
      expect(meta(page, "og:image:height"), path).toBe(String(card.height));
      expect(meta(page, "og:image:alt"), path).toBeTruthy();
      expect(meta(page, "og:title"), path).toBeTruthy();
      expect(meta(page, "twitter:card"), path).toBe("summary_large_image");
    }
  });
});
