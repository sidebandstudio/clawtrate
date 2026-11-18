import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ICON_PATHS } from "../src/components/icon-paths.ts";
import { COLOR_TOKENS, DARK, LIGHT, SIZE_TOKENS } from "../src/theme/tokens.ts";

const UI = join(import.meta.dirname, "../../../packages/ui/src");
const css = readFileSync(join(UI, "styles/tokens.css"), "utf8");

/** The declarations of one rule of tokens.css, by its selector. */
function block(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  const body = css.slice(start, css.indexOf("}", start));
  return Object.fromEntries(
    [...body.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2]!.trim()]),
  );
}

describe("the iOS app's design tokens", () => {
  it("are the values of packages/ui/src/styles/tokens.css, light and dark", () => {
    const light = block(':root,\n:root[data-theme="light"]');
    const dark = block(':root[data-theme="dark"]');
    for (const token of COLOR_TOKENS) {
      expect(LIGHT[token], `light --${token}`).toBe(light[token]);
      expect(DARK[token], `dark --${token}`).toBe(dark[token]);
    }
    const sizes = block(":root");
    for (const [token, value] of Object.entries(SIZE_TOKENS))
      expect(`${value}px`, `--${token}`).toBe(sizes[token]);
  });

  it("draw the desktop's own icons", () => {
    const icons = readFileSync(join(UI, "icons.tsx"), "utf8");
    for (const [name, d] of Object.entries(ICON_PATHS)) expect(icons, name).toContain(`d="${d}"`);
  });
});
