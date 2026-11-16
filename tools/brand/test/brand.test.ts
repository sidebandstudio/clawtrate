import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LOGO_PATH, logoMetadataChunks, MANIFEST_PATH, sha256 } from "../src/make-icons.ts";
import { decodePng, encodePng, listChunks, resize, stripMetadataChunks } from "../src/png.ts";

/** Insert a chunk after IHDR, the way image tools add metadata. */
function withChunk(png: Buffer, type: string, body: string): Buffer {
  const data = Buffer.from(body, "latin1");
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const chunk = Buffer.concat([head, data, Buffer.alloc(4)]); // CRC is not checked by the stripper
  const ihdrEnd = 8 + 12 + png.readUInt32BE(8);
  return Buffer.concat([png.subarray(0, ihdrEnd), chunk, png.subarray(ihdrEnd)]);
}

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

describe("logo metadata", () => {
  it("publishes no provenance or text chunks (run `pnpm brand:strip` after replacing it)", () => {
    expect(logoMetadataChunks(readFileSync(LOGO_PATH))).toEqual([]);
  });

  it("strips every metadata chunk and keeps the image chunks byte for byte", () => {
    const clean = encodePng({ width: 2, height: 2, data: new Uint8Array(16).fill(200) });
    let dirty = clean;
    for (const type of ["caBX", "tEXt", "iTXt", "zTXt", "eXIf"])
      dirty = withChunk(dirty, type, "generator");
    expect(logoMetadataChunks(dirty)).toEqual(["eXIf", "zTXt", "iTXt", "tEXt", "caBX"]);
    const stripped = stripMetadataChunks(dirty);
    expect(listChunks(stripped)).toEqual(["IHDR", "IDAT", "IEND"]);
    expect(stripped.equals(clean)).toBe(true);
    expect(decodePng(stripped)).toEqual(decodePng(clean));
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
