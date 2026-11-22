// The theme is set in the page's head, before the stylesheet and the bundle, so a
// person who chose Light, or Match the system on a light system, never sees a dark
// first frame. Both entries carry the same script, and their policy allows it.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const ENTRIES = ["src/renderer/index.html", "src/fixture/index.html"];
const read = (entry: string) => readFileSync(join(import.meta.dirname, "..", entry), "utf8");

/** The inline script right after the color-scheme meta tag, as the browser hashes it. */
function earlyScript(html: string): string {
  const match =
    /<meta name="color-scheme" content="dark" \/>\s*(?:<!--[^]*?-->\s*)?<script>([^]*?)<\/script>/.exec(
      html,
    );
  if (!match) throw new Error("no script follows the color-scheme meta tag");
  return match[1]!;
}

/** Run the script against a stand-in page and say what it set. */
function run(
  script: string,
  page: { search?: string; stored?: string | null; systemLight?: boolean; storageThrows?: boolean },
) {
  const root = { dataset: {} as Record<string, string> };
  const meta = { content: "dark" };
  runInNewContext(script, {
    URLSearchParams,
    location: { search: page.search ?? "" },
    localStorage: {
      getItem: (key: string) => {
        if (page.storageThrows) throw new Error("blocked");
        return key === "clawtrate.theme" ? (page.stored ?? null) : null;
      },
    },
    matchMedia: (query: string) => ({
      matches: query === "(prefers-color-scheme: light)" && page.systemLight === true,
    }),
    document: {
      documentElement: root,
      querySelector: (selector: string) => (selector === 'meta[name="color-scheme"]' ? meta : null),
    },
  });
  return { theme: root.dataset.theme, scheme: meta.content };
}

describe.each(ENTRIES)("%s", (entry) => {
  const html = read(entry);
  const script = earlyScript(html);

  it("allows its early script by hash and no other inline script", () => {
    const hash = createHash("sha256").update(script).digest("base64");
    const policy = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html)![1]!;
    const scriptSrc = policy
      .split(";")
      .map((d) => d.trim())
      .find((d) => d.startsWith("script-src "));
    expect(scriptSrc).toBe(`script-src 'self' 'sha256-${hash}'`);
    expect(html.match(/<script>/g)).toHaveLength(1);
  });

  it("is the same script in both entries", () => {
    expect(script).toBe(earlyScript(read(ENTRIES[0]!)));
  });

  it("applies the stored choice, and dark when there is none", () => {
    expect(run(script, { stored: "light" })).toEqual({ theme: "light", scheme: "light" });
    expect(run(script, { stored: "dark", systemLight: true })).toEqual({
      theme: "dark",
      scheme: "dark",
    });
    expect(run(script, { systemLight: true })).toEqual({ theme: "dark", scheme: "dark" });
    expect(run(script, { stored: "sepia", systemLight: true })).toEqual({
      theme: "dark",
      scheme: "dark",
    });
    expect(run(script, { stored: "light", storageThrows: true })).toEqual({
      theme: "dark",
      scheme: "dark",
    });
  });

  it("follows the system for Match the system", () => {
    expect(run(script, { stored: "system", systemLight: true })).toEqual({
      theme: "system",
      scheme: "light",
    });
    expect(run(script, { stored: "system" })).toEqual({ theme: "system", scheme: "dark" });
  });

  it("lets the address override the stored choice", () => {
    expect(run(script, { search: "?theme=light", stored: "dark" })).toEqual({
      theme: "light",
      scheme: "light",
    });
    expect(run(script, { search: "?scene=main&theme=dark", stored: "light" })).toEqual({
      theme: "dark",
      scheme: "dark",
    });
  });
});
