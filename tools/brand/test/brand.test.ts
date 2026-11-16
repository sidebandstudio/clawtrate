import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LOGO_PATH, MANIFEST_PATH, sha256 } from "../src/make-icons.ts";
import { decodePng, encodePng, resize } from "../src/png.ts";

describe("png codec", () => {
  it("round-trips RGBA pixels", () => {
    const data = new Uint8Array(4 * 4 * 4).map((_, i) => (i * 37) % 256);
    const image = { width: 4, height: 4, data };
    expect(decodePng(encodePng(image))).toEqual(image);
  });

  it("averages areas when downscaling", () => {
    const data = new Uint8Array([255, 0, 0, 255, 0, 0, 255, 255]);
    const out = resize({ width: 2, height: 1, data }, 1, 1);
    expect([...out.data]).toEqual([128, 0, 128, 255]);
  });
});

describe("generated icons", () => {
  it("were generated from the current logo (run `pnpm brand:icons` after replacing it)", () => {
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as {
      sourceSha256: string;
      outputs: string[];
    };
    expect(manifest.sourceSha256).toBe(sha256(LOGO_PATH));
    const root = join(MANIFEST_PATH, "../../..");
    for (const output of manifest.outputs) {
      expect(readFileSync(join(root, output)).length).toBeGreaterThan(0);
    }
  });
});
