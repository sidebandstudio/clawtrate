// C6: secondary text must reach 4.5:1 on every surface it is drawn on, in both themes.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(import.meta.dirname, "../src/styles/tokens.css"), "utf8");

/** The custom properties declared in the first block whose selector contains `selector`. */
function block(selector: string): Record<string, string> {
  const start = css.indexOf(selector);
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  const tokens: Record<string, string> = {};
  for (const match of css.slice(open + 1, close).matchAll(/--([\w-]+):\s*([^;]+);/g)) {
    tokens[match[1]!] = match[2]!.trim();
  }
  return tokens;
}

type Rgb = [number, number, number];

function parse(color: string, over: Rgb): Rgb {
  const hex = /^#([0-9a-f]{6})$/i.exec(color);
  if (hex) {
    const n = Number.parseInt(hex[1]!, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const rgba = /^rgba\(([\d.]+),\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)\)$/.exec(color);
  if (!rgba) throw new Error(`cannot parse ${color}`);
  const [r, g, b, a] = rgba.slice(1).map(Number) as [number, number, number, number];
  return [r * a + over[0] * (1 - a), g * a + over[1] * (1 - a), b * a + over[2] * (1 - a)];
}

function luminance([r, g, b]: Rgb): number {
  const channel = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const SURFACES = [
  "bg",
  "bg-rail",
  "bg-list",
  "bg-pane",
  "bg-raised",
  "bg-inset",
  "bg-code",
  "bg-selected",
  "bg-hover",
  "bg-bubble",
];

const themes = {
  light: block(':root[data-theme="light"]'),
  dark: block(':root[data-theme="dark"]'),
};

describe("text contrast (C6)", () => {
  for (const [name, tokens] of Object.entries(themes)) {
    for (const text of ["text-faint", "text-muted"]) {
      it(`${name} --${text} reaches 4.5:1 on every surface`, () => {
        // Translucent fills are checked over the darkest and lightest opaque surfaces.
        const bases = ["bg-rail", "bg-raised", "bg-pane"].map((s) => parse(tokens[s]!, [0, 0, 0]));
        const worst = Math.min(
          ...SURFACES.flatMap((surface) =>
            bases.map((base) =>
              contrast(parse(tokens[text]!, base), parse(tokens[surface]!, base)),
            ),
          ),
        );
        expect(worst).toBeGreaterThanOrEqual(4.5);
      });
    }
  }

  for (const [name, tokens] of Object.entries(themes)) {
    it(`${name} secondary text reaches 4.5:1 on the selected task inside an open bot`, () => {
      // The open bot's block is 55% of the hover fill over the rail; the current
      // task's fill sits on that (visual-language.md, section 13).
      const rail = parse(tokens["bg-rail"]!, [0, 0, 0]);
      const hover = /^rgba\((.+),\s*([\d.]+)\)$/.exec(tokens["bg-hover"]!)!;
      const group = parse(`rgba(${hover[1]}, ${Number(hover[2]) * 0.55})`, rail);
      const selected = parse(tokens["bg-selected"]!, group);
      for (const text of ["text", "text-muted", "text-faint"]) {
        expect(contrast(parse(tokens[text]!, selected), selected), text).toBeGreaterThanOrEqual(
          4.5,
        );
      }
    });
  }

  it("keeps the smallest text size at 12px", () => {
    expect(block(":root {")["text-xs"]).toBe("12px");
  });
});
