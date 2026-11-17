// F-471 and visual-language.md section 13: no rendered text is smaller than
// 12 px, and every text colour reaches 4.5:1 on the surface it sits on, with
// translucent fills composited over their real parents. Text behind the Work
// drawer's scrim is inert and deliberately concealed, so it is not measured.
import { expect, test, type Page } from "@playwright/test";
import { contextFor, openFixture, OTTO_DISK, settle, SIZES, THEMES } from "./fixture.ts";

type Finding = { text: string; size: number; ratio: number; color: string; background: string };

/** Runs in the page: every visible text node's size and contrast. */
function audit(): Finding[] {
  type Rgba = [number, number, number, number];
  const probe = document.createElement("canvas").getContext("2d")!;
  const parse = (value: string): Rgba => {
    const srgb = /^color\(srgb ([\d.e-]+) ([\d.e-]+) ([\d.e-]+)(?: \/ ([\d.e-]+))?\)$/.exec(value);
    if (srgb) {
      return [
        Number(srgb[1]) * 255,
        Number(srgb[2]) * 255,
        Number(srgb[3]) * 255,
        srgb[4] === undefined ? 1 : Number(srgb[4]),
      ];
    }
    const rgb = /^rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)$/.exec(value);
    if (rgb) {
      return [
        Number(rgb[1]),
        Number(rgb[2]),
        Number(rgb[3]),
        rgb[4] === undefined ? 1 : Number(rgb[4]),
      ];
    }
    // Anything else (oklab and friends): let the canvas resolve it.
    probe.clearRect(0, 0, 1, 1);
    probe.fillStyle = value;
    probe.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = probe.getImageData(0, 0, 1, 1).data;
    return [r!, g!, b!, a! / 255];
  };
  const over = (top: Rgba, bottom: Rgba): Rgba => {
    const a = top[3] + bottom[3] * (1 - top[3]);
    if (a === 0) return [0, 0, 0, 0];
    const mix = (i: number) => (top[i]! * top[3] + bottom[i]! * bottom[3] * (1 - top[3])) / a;
    return [mix(0), mix(1), mix(2), a];
  };
  const luminance = ([r, g, b]: Rgba) => {
    const c = (v: number) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(b);
  };
  const background = (element: Element): Rgba => {
    const layers: Rgba[] = [];
    for (let node: Element | null = element; node; node = node.parentElement) {
      const fill = parse(getComputedStyle(node).backgroundColor);
      if (fill[3] > 0) layers.push(fill);
      if (fill[3] >= 1) break;
    }
    let result: Rgba = [255, 255, 255, 1];
    for (const layer of layers.reverse()) result = over(layer, result);
    return result;
  };

  const findings: Finding[] = [];
  const measure = (text: string, style: CSSStyleDeclaration, element: Element) => {
    const bg = background(element);
    const fg = over(parse(style.color), bg);
    const [hi, lo] = [luminance(fg), luminance(bg)].sort((x, y) => y - x) as [number, number];
    findings.push({
      text: text.slice(0, 60),
      size: Number.parseFloat(style.fontSize),
      ratio: Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100,
      color: style.color,
      background: `rgb(${bg.slice(0, 3).map(Math.round).join(", ")})`,
    });
  };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent?.trim();
    const element = node.parentElement;
    if (!text || !element) continue;
    if (element.closest("[inert], .visually-hidden, [hidden]")) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    const rect = range.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    const style = getComputedStyle(element);
    if (style.visibility === "hidden") continue;
    measure(text, style, element);
  }
  // A field's value and its placeholder are drawn text too, but not text nodes.
  for (const field of document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
    "input, textarea",
  )) {
    if (field.closest("[inert], [hidden]") || field.type === "hidden") continue;
    const rect = field.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    if (field.value) measure(`[value] ${field.value}`, getComputedStyle(field), field);
    else if (field.placeholder) {
      measure(
        `[placeholder] ${field.placeholder}`,
        getComputedStyle(field, "::placeholder"),
        field,
      );
    }
  }
  return findings;
}

type Scene = { name: string; query: string; prepare?: (page: Page) => Promise<void> };

const openEverything = async (page: Page) => {
  await page.getByTestId("transcript-turn").first().waitFor();
  await page.evaluate(() => {
    for (const details of document.querySelectorAll("details")) details.open = true;
  });
};

const SCENES: Scene[] = [
  { name: "connect", query: "scene=connect" },
  { name: "connect error", query: "scene=connect-error" },
  { name: "pairing", query: "scene=pairing" },
  {
    name: "conversation with all work open",
    query: `scene=main&${OTTO_DISK}`,
    prepare: openEverything,
  },
  {
    name: "fourteen tasks shown",
    query: `scene=main&${OTTO_DISK}`,
    prepare: async (page) => {
      if (!(await page.getByRole("button", { name: "Show all 14" }).isVisible())) {
        await page.getByRole("button", { name: "Back to bots" }).click();
      }
      await page.getByRole("button", { name: "Show all 14" }).click();
    },
  },
  { name: "work docked", query: `scene=main&${OTTO_DISK}&panel=open` },
  { name: "reconnecting", query: `scene=reconnecting&${OTTO_DISK}` },
  {
    name: "task failed to sync",
    query: `scene=sync-failed&${OTTO_DISK}`,
    prepare: (page) => expect(page.getByTestId("status-strip")).toContainText("Couldn't sync"),
  },
  { name: "refresh failed", query: `scene=refresh-failed&${OTTO_DISK}` },
  { name: "load failed", query: "scene=load-failed&bot=otto&task=agent:otto:dns-blocklist" },
  { name: "loading", query: `scene=loading&${OTTO_DISK}` },
  { name: "empty gateway", query: "scene=empty" },
  { name: "bot with no tasks", query: "scene=zero-tasks&bot=marlow" },
  {
    name: "gateway menu",
    query: `scene=main&${OTTO_DISK}`,
    prepare: async (page) => {
      const back = page.getByRole("button", { name: "Back to bots" });
      if (await back.isVisible()) await back.click();
      const trigger = page.getByRole("button", { name: /Open the gateway menu\.$/ });
      await trigger.filter({ visible: true }).first().click();
      await expect(page.getByRole("menu", { name: "Gateway" })).toBeVisible();
    },
  },
];

const WIDE = SIZES.find((size) => size.name === "1440")!;
const PHONE = SIZES.find((size) => size.phone)!;

for (const size of [WIDE, PHONE]) {
  for (const theme of THEMES) {
    test.describe(`legibility ${size.name} ${theme}`, () => {
      test.use(contextFor(size, theme));
      for (const scene of SCENES) {
        test(scene.name, async ({ page }) => {
          await openFixture(page, scene.query, theme);
          await settle(page);
          await scene.prepare?.(page);
          await settle(page);
          const findings = await page.evaluate(audit);
          expect(findings.length, "some text was measured").toBeGreaterThan(0);
          expect(
            findings.filter((f) => f.size < 12),
            "text below 12px",
          ).toEqual([]);
          expect(
            findings.filter((f) => f.ratio < 4.5),
            "text below 4.5:1",
          ).toEqual([]);
        });
      }
    });
  }
}

test("the audit reads field values and placeholders, and catches a small, faint one", async ({
  page,
}) => {
  await openFixture(page, "scene=connect", "light");
  const fields = (await page.evaluate(audit)).filter((f) => f.text.startsWith("["));
  expect(fields.map((f) => f.text)).toEqual([
    "[value] ws://127.0.0.1:19001",
    "[placeholder] Token, for the first pairing only",
  ]);
  expect(fields.every((f) => f.size >= 12 && f.ratio >= 4.5)).toBe(true);

  await page.addStyleTag({
    content: ".input::placeholder { color: #e4e4e4 !important; font-size: 10px !important; }",
  });
  const placeholder = (await page.evaluate(audit)).find((f) => f.text.startsWith("[placeholder]"))!;
  expect(placeholder.size).toBe(10);
  expect(placeholder.ratio).toBeLessThan(4.5);
});

test("the fixture mode makes no request beyond its own files", async ({ page }) => {
  const foreign: string[] = [];
  page.on("request", (request) => {
    const url = request.url();
    if (!url.startsWith("http://127.0.0.1:5341/") && !url.startsWith("data:")) foreign.push(url);
  });
  page.on("websocket", (socket) => foreign.push(socket.url()));
  for (const query of ["scene=connect", "scene=pairing", `scene=synced&${OTTO_DISK}&panel=open`]) {
    await openFixture(page, query, "light");
    await settle(page);
  }
  expect(foreign).toEqual([]);
});
